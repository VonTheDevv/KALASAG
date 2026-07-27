import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Plugin } from 'vite'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

const PH_AIS_BBOX = [[[4.5, 116.5], [21.5, 127.5]]]
const AIS_MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'LongRangeAisBroadcastMessage',
  'ShipStaticData',
  'StaticDataReport',
]
const MAX_CLIENTS = 100
const MAX_CLIENTS_PER_IP = 5
const MAX_PAYLOAD_BYTES = 256 * 1024
const MAX_BUFFERED_BYTES = 512 * 1024

function clientIp(request: IncomingMessage) {
  return request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown'
}

function allowedOrigin(request: IncomingMessage, configuredOrigins: Set<string>) {
  const origin = request.headers.origin
  if (!origin) return false
  if (configuredOrigins.has(origin)) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

function rejectUpgrade(socket: Duplex, status: 400 | 403 | 405 | 429 | 503, message: string) {
  const labels = { 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 429: 'Too Many Requests', 503: 'Service Unavailable' }
  const body = JSON.stringify({ error: message })
  socket.write(`HTTP/1.1 ${status} ${labels[status]}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Content-Type-Options: nosniff\r\n\r\n${body}`)
  socket.destroy()
}

function rawDataSize(payload: RawData) {
  if (Array.isArray(payload)) return payload.reduce((total, part) => total + part.byteLength, 0)
  return payload.byteLength
}

/** Development-only AIS proxy. The browser receives position reports but never
 * the provider key. Production needs the same controls on an always-on backend. */
export function viteAisRelay(apiKey?: string, allowedOrigins = ''): Plugin {
  const configuredOrigins = new Set(allowedOrigins.split(',').map(value => value.trim()).filter(Boolean))
  return {
    name: 'kalasag-ais-development-relay',
    configureServer(server) {
      if (!apiKey) return

      const clients = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false })
      const clientIps = new WeakMap<WebSocket, string>()
      const alive = new WeakMap<WebSocket, boolean>()
      const attempts = new Map<string, { count: number; resetsAt: number }>()
      let upstream: WebSocket | null = null
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let retryAttempt = 0
      let closed = false

      const connectedForIp = (ip: string) => {
        let count = 0
        clients.clients.forEach(client => { if (clientIps.get(client) === ip) count += 1 })
        return count
      }

      const allowConnectionAttempt = (ip: string) => {
        const now = Date.now()
        let entry = attempts.get(ip)
        if (!entry || entry.resetsAt <= now) entry = { count: 0, resetsAt: now + 60_000 }
        entry.count += 1
        attempts.delete(ip)
        attempts.set(ip, entry)
        while (attempts.size > 1_024) {
          const oldest = attempts.keys().next().value
          if (oldest === undefined) break
          attempts.delete(oldest)
        }
        return entry.count <= 20
      }

      const broadcast = (payload: RawData, isBinary: boolean) => {
        if (rawDataSize(payload) > MAX_PAYLOAD_BYTES) return
        clients.clients.forEach(client => {
          if (client.readyState !== WebSocket.OPEN) return
          if (client.bufferedAmount > MAX_BUFFERED_BYTES) {
            client.terminate()
            return
          }
          client.send(payload, { binary: isBinary }, error => { if (error) client.terminate() })
        })
      }

      const scheduleReconnect = () => {
        if (closed || clients.clients.size === 0 || retryTimer) return
        const baseDelay = Math.min(30_000, 1_000 * 2 ** Math.min(retryAttempt, 5))
        const delay = baseDelay + Math.floor(Math.random() * 1_000)
        retryAttempt += 1
        retryTimer = setTimeout(() => { retryTimer = undefined; connect() }, delay)
      }

      const connect = () => {
        if (closed || clients.clients.size === 0 || upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING) return
        upstream = new WebSocket('wss://stream.aisstream.io/v0/stream', { maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false, handshakeTimeout: 12_000 })
        upstream.on('open', () => {
          retryAttempt = 0
          upstream?.send(JSON.stringify({
            APIKey: apiKey,
            BoundingBoxes: PH_AIS_BBOX,
            FiltersShipMMSI: [],
            FilterMessageTypes: AIS_MESSAGE_TYPES,
          }))
        })
        upstream.on('message', broadcast)
        upstream.on('close', () => {
          upstream = null
          scheduleReconnect()
        })
        upstream.on('error', () => upstream?.terminate())
      }

      clients.on('connection', (client, request) => {
        clientIps.set(client, clientIp(request))
        alive.set(client, true)
        client.on('pong', () => alive.set(client, true))
        // This feed is deliberately one-way. Reject client data frames.
        client.on('message', () => client.close(1008, 'Read-only feed'))
        client.on('error', () => client.terminate())
        client.on('close', () => {
          if (clients.clients.size > 0 || closed) return
          if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined }
          idleTimer = setTimeout(() => {
            idleTimer = undefined
            if (clients.clients.size === 0) upstream?.close(1000, 'No subscribers')
          }, 15_000)
        })
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined }
        connect()
      })

      const heartbeat = setInterval(() => {
        clients.clients.forEach(client => {
          if (!alive.get(client)) {
            client.terminate()
            return
          }
          alive.set(client, false)
          client.ping()
        })
      }, 30_000)
      heartbeat.unref()

      server.httpServer?.on('upgrade', (request, socket, head) => {
        let path: string
        try { path = new URL(request.url ?? '/', 'https://localhost').pathname } catch { return rejectUpgrade(socket, 400, 'Invalid request') }
        if (path !== '/api-ais') return
        if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') return rejectUpgrade(socket, 405, 'Method not allowed')
        if (!allowedOrigin(request, configuredOrigins)) return rejectUpgrade(socket, 403, 'Request origin is not allowed')
        const ip = clientIp(request)
        if (!allowConnectionAttempt(ip)) return rejectUpgrade(socket, 429, 'Too many connection attempts')
        if (clients.clients.size >= MAX_CLIENTS || connectedForIp(ip) >= MAX_CLIENTS_PER_IP) return rejectUpgrade(socket, 429, 'Connection limit reached')
        try {
          clients.handleUpgrade(request, socket, head, client => clients.emit('connection', client, request))
        } catch {
          rejectUpgrade(socket, 400, 'WebSocket upgrade failed')
        }
      })

      server.httpServer?.once('close', () => {
        closed = true
        clearInterval(heartbeat)
        if (retryTimer) clearTimeout(retryTimer)
        if (idleTimer) clearTimeout(idleTimer)
        upstream?.close()
        clients.clients.forEach(client => client.close(1001, 'Server shutdown'))
        clients.close()
      })
    },
  }
}
