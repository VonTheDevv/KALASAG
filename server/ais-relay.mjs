import http from 'node:http'
import process from 'node:process'
import { WebSocket, WebSocketServer } from 'ws'

const AISSTREAM_API_KEY = String(process.env.AISSTREAM_API_KEY || '').trim()
const HOST = String(process.env.AIS_RELAY_HOST || '127.0.0.1').trim()
const PORT = Math.max(1, Math.min(65_535, Number(process.env.AIS_RELAY_PORT) || 8788))
const RELAY_PATH = '/ais'
const HEALTH_PATH = '/healthz'
const MAX_CLIENTS = 1_000
const MAX_CLIENTS_PER_IP = 8
const MAX_CONNECTION_ATTEMPTS_PER_MINUTE = 30
const MAX_PAYLOAD_BYTES = 256 * 1024
const MAX_BUFFERED_BYTES = 512 * 1024
const PH_AIS_BBOX = [[[4.5, 116.5], [21.5, 127.5]]]
const AIS_MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'LongRangeAisBroadcastMessage',
  'ShipStaticData',
  'StaticDataReport',
]

if (!AISSTREAM_API_KEY) {
  console.error('AISSTREAM_API_KEY is required. The relay will not start without a server-side provider key.')
  process.exit(1)
}

const configuredOrigins = new Set([
  'https://localhost',
  'capacitor://localhost',
  ...String(process.env.AIS_RELAY_ALLOWED_ORIGINS || '').split(','),
].map(value => value.trim().replace(/\/$/, '')).filter(Boolean))

const trustProxy = process.env.AIS_RELAY_TRUST_PROXY === '1'
const clients = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false })
const clientIps = new WeakMap()
const alive = new WeakMap()
const attempts = new Map()
let upstream = null
let reconnectTimer
let idleTimer
let reconnectAttempt = 0
let lastUpstreamMessageAt = null
let lastUpstreamError = null
let lastUpstreamClose = null
let shuttingDown = false

function remoteIp(request) {
  const direct = request.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown'
  if (!trustProxy) return direct
  const forwarded = String(request.headers['x-real-ip'] || request.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return /^[0-9a-f:.]{3,64}$/i.test(forwarded) ? forwarded : direct
}

function sameOrigin(request, origin) {
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

function originAllowed(request) {
  const origin = String(request.headers.origin || '').replace(/\/$/, '')
  return Boolean(origin && (configuredOrigins.has(origin) || sameOrigin(request, origin)))
}

function rejectUpgrade(socket, status, message) {
  const labels = { 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 429: 'Too Many Requests', 503: 'Service Unavailable' }
  const body = JSON.stringify({ error: message })
  socket.write(`HTTP/1.1 ${status} ${labels[status] || 'Error'}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Content-Type-Options: nosniff\r\n\r\n${body}`)
  socket.destroy()
}

function allowConnectionAttempt(ip) {
  const now = Date.now()
  let entry = attempts.get(ip)
  if (!entry || entry.resetsAt <= now) entry = { count: 0, resetsAt: now + 60_000 }
  entry.count += 1
  attempts.delete(ip)
  attempts.set(ip, entry)
  while (attempts.size > 4_096) attempts.delete(attempts.keys().next().value)
  return entry.count <= MAX_CONNECTION_ATTEMPTS_PER_MINUTE
}

function clientsForIp(ip) {
  let count = 0
  clients.clients.forEach(client => { if (clientIps.get(client) === ip) count += 1 })
  return count
}

function scheduleReconnect() {
  if (shuttingDown || clients.clients.size === 0 || reconnectTimer) return
  const baseDelay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5))
  const delay = baseDelay + Math.floor(Math.random() * 1_000)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    connectUpstream()
  }, delay)
}

function payloadSize(payload) {
  if (Array.isArray(payload)) return payload.reduce((total, part) => total + part.byteLength, 0)
  return payload.byteLength
}

function broadcast(payload, isBinary) {
  if (payloadSize(payload) > MAX_PAYLOAD_BYTES) return
  lastUpstreamMessageAt = new Date().toISOString()
  clients.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.terminate()
      return
    }
    client.send(payload, { binary: isBinary }, error => { if (error) client.terminate() })
  })
}

function connectUpstream() {
  if (shuttingDown || clients.clients.size === 0 || upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING) return
  upstream = new WebSocket('wss://stream.aisstream.io/v0/stream', {
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    handshakeTimeout: 12_000,
  })
  upstream.on('open', () => {
    reconnectAttempt = 0
    lastUpstreamError = null
    lastUpstreamClose = null
    upstream?.send(JSON.stringify({
      APIKey: AISSTREAM_API_KEY,
      BoundingBoxes: PH_AIS_BBOX,
      FiltersShipMMSI: [],
      FilterMessageTypes: AIS_MESSAGE_TYPES,
    }))
  })
  upstream.on('message', broadcast)
  upstream.on('close', (code, reason) => {
    lastUpstreamClose = { code, reason: reason.toString().slice(0, 160), at: new Date().toISOString() }
    console.warn(`AIS upstream closed (${code}${lastUpstreamClose.reason ? `: ${lastUpstreamClose.reason}` : ''}).`)
    upstream = null
    scheduleReconnect()
  })
  upstream.on('error', error => {
    lastUpstreamError = { message: String(error?.message || 'Unknown upstream error').slice(0, 160), at: new Date().toISOString() }
    console.warn(`AIS upstream error: ${lastUpstreamError.message}`)
    upstream?.terminate()
  })
}

clients.on('connection', (client, request) => {
  clientIps.set(client, remoteIp(request))
  alive.set(client, true)
  client.on('pong', () => alive.set(client, true))
  client.on('message', () => client.close(1008, 'Read-only feed'))
  client.on('error', () => client.terminate())
  client.on('close', () => {
    if (clients.clients.size > 0 || shuttingDown) return
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (clients.clients.size === 0) upstream?.close(1000, 'No subscribers')
    }, 15_000)
  })
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined }
  connectUpstream()
})

const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  if (request.method === 'GET' && request.url === HEALTH_PATH) {
    response.writeHead(200)
    response.end(JSON.stringify({
      ok: true,
      upstreamConnected: upstream?.readyState === WebSocket.OPEN,
      subscribers: clients.clients.size,
      lastMessageAt: lastUpstreamMessageAt,
      lastUpstreamError,
      lastUpstreamClose,
    }))
    return
  }
  response.writeHead(404)
  response.end(JSON.stringify({ error: 'Not found' }))
})

server.on('upgrade', (request, socket, head) => {
  let path
  try { path = new URL(request.url || '/', 'http://localhost').pathname } catch { return rejectUpgrade(socket, 400, 'Invalid request') }
  if (path !== RELAY_PATH) return rejectUpgrade(socket, 404, 'Not found')
  if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') return rejectUpgrade(socket, 405, 'Method not allowed')
  if (!originAllowed(request)) return rejectUpgrade(socket, 403, 'Request origin is not allowed')
  const ip = remoteIp(request)
  if (!allowConnectionAttempt(ip)) return rejectUpgrade(socket, 429, 'Too many connection attempts')
  if (clients.clients.size >= MAX_CLIENTS || clientsForIp(ip) >= MAX_CLIENTS_PER_IP) return rejectUpgrade(socket, 429, 'Connection limit reached')
  try {
    clients.handleUpgrade(request, socket, head, client => clients.emit('connection', client, request))
  } catch {
    rejectUpgrade(socket, 400, 'WebSocket upgrade failed')
  }
})

const heartbeat = setInterval(() => {
  clients.clients.forEach(client => {
    if (!alive.get(client)) return client.terminate()
    alive.set(client, false)
    client.ping()
  })
}, 30_000)
heartbeat.unref()

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(heartbeat)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (idleTimer) clearTimeout(idleTimer)
  upstream?.close(1001, 'Relay shutting down')
  clients.clients.forEach(client => client.close(1001, 'Relay shutting down'))
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
  console.log(`AIS relay received ${signal}; shutting down.`)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

server.listen(PORT, HOST, () => {
  console.log(`KALASAG AIS relay listening on http://${HOST}:${PORT}${RELAY_PATH}`)
})
