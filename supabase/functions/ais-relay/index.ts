// Authenticated, read-only AIS relay for Philippine waters.
//
// The provider credential remains a Supabase secret. Browser clients present
// their Supabase access token in one bounded first WebSocket frame (never a
// URL), and this function verifies it with Supabase Auth before subscribing.

const UPSTREAM_URL = 'wss://stream.aisstream.io/v0/stream'
const PH_AIS_BBOX = [[[4.5, 116.5], [21.5, 127.5]]]
const PH_BOUNDS = { minLat: 4.5, maxLat: 21.5, minLng: 116.5, maxLng: 127.5 }
const MAX_CLIENTS = 64
const MAX_CLIENTS_PER_USER = 2
const MAX_PENDING_CLIENTS = 32
const MAX_PENDING_CLIENTS_PER_KEY = 4
const MAX_CONNECTION_ATTEMPTS_PER_MINUTE = 30
const MAX_TRACKED_ATTEMPT_KEYS = 2_048
const MAX_ACCESS_TOKEN_CHARS = 6 * 1024
const MAX_AUTH_FRAME_CHARS = 7 * 1024
const MAX_UPSTREAM_MESSAGE_CHARS = 256 * 1024
const MAX_CLIENT_BUFFERED_BYTES = 512 * 1024
const AUTH_REQUEST_TIMEOUT_MS = 7_000
const AUTH_FRAME_TIMEOUT_MS = 10_000
const STATIC_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_STATIC_VESSELS = 5_000
const POSITION_MESSAGE_TYPES = new Set([
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'LongRangeAisBroadcastMessage',
])
const SUBSCRIBED_MESSAGE_TYPES = [
  ...POSITION_MESSAGE_TYPES,
  'ShipStaticData',
  'StaticDataReport',
]

type ClientState = {
  socket: WebSocket
  userId: string
}

type AttemptWindow = {
  count: number
  resetsAt: number
}

type JsonRecord = Record<string, unknown>

type StaticVesselData = {
  name: string
  shipType: number | null
  destination: string
  expiresAt: number
}

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void
}

function defaultNamedKey(variable: string) {
  try {
    const keys = JSON.parse(Deno.env.get(variable) ?? '{}') as Record<string, unknown>
    return typeof keys.default === 'string' ? keys.default.trim() : ''
  } catch {
    return ''
  }
}

const providerKey = String(Deno.env.get('AISSTREAM_API_KEY') ?? '').trim()
const supabaseUrl = String(Deno.env.get('SUPABASE_URL') ?? '').trim().replace(/\/$/, '')
const supabaseApiKey = defaultNamedKey('SUPABASE_PUBLISHABLE_KEYS')
  || String(Deno.env.get('SUPABASE_ANON_KEY') ?? '').trim()

const allowedOrigins = new Set([
  'https://localhost',
  'capacitor://localhost',
  ...String(Deno.env.get('AIS_RELAY_ALLOWED_ORIGINS') ?? Deno.env.get('LIVE_DATA_ALLOWED_ORIGINS') ?? '')
    .split(','),
].map(normalizeConfiguredOrigin).filter((origin): origin is string => Boolean(origin)))

const clients = new Set<ClientState>()
const clientsByUser = new Map<string, number>()
const pendingClientsByKey = new Map<string, number>()
const connectionAttempts = new Map<string, AttemptWindow>()
let pendingClients = 0
const staticVessels = new Map<string, StaticVesselData>()
let upstream: WebSocket | null = null
let reconnectTimer: number | null = null
let reconnectAttempt = 0

function normalizeConfiguredOrigin(value: string) {
  const trimmed = value.trim().replace(/\/$/, '')
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (!['https:', 'http:', 'capacitor:'].includes(parsed.protocol) || !parsed.host) return null
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

function originAllowed(request: Request) {
  const origin = normalizeConfiguredOrigin(request.headers.get('origin') ?? '')
  return origin !== null && allowedOrigins.has(origin)
}

function json(body: unknown, status: number, extraHeaders: HeadersInit = {}) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store, max-age=0',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  })
}

function requestKey(request: Request) {
  const candidate = request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-real-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]
    ?? 'unknown'
  return /^[0-9a-f:.]{3,64}$/i.test(candidate.trim()) ? candidate.trim() : 'unknown'
}

function allowConnectionAttempt(key: string) {
  const now = Date.now()
  let window = connectionAttempts.get(key)
  if (!window || window.resetsAt <= now) window = { count: 0, resetsAt: now + 60_000 }
  window.count += 1
  connectionAttempts.delete(key)
  connectionAttempts.set(key, window)
  while (connectionAttempts.size > MAX_TRACKED_ATTEMPT_KEYS) {
    const oldest = connectionAttempts.keys().next().value
    if (oldest === undefined) break
    connectionAttempts.delete(oldest)
  }
  return window.count <= MAX_CONNECTION_ATTEMPTS_PER_MINUTE
}

function accessTokenFromAuthFrame(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > MAX_AUTH_FRAME_CHARS) return null
  let frame: JsonRecord | null
  try {
    frame = asRecord(JSON.parse(value))
  } catch {
    return null
  }
  if (!frame || frame.type !== 'authenticate') return null
  const token = typeof frame.accessToken === 'string' ? frame.accessToken : ''
  if (!token || token.length > MAX_ACCESS_TOKEN_CHARS) return null
  const segments = token.split('.')
  if (segments.length !== 3 || segments.some(segment => !/^[A-Za-z0-9_-]+$/.test(segment))) return null
  return token
}

async function authenticateUser(accessToken: string) {
  if (!supabaseUrl || !supabaseApiKey) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseApiKey,
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = await response.json() as { id?: unknown }
    return typeof payload.id === 'string' && /^[0-9a-f-]{20,64}$/i.test(payload.id) ? payload.id : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().replace(/@+$/, '').trim().slice(0, maxLength) : ''
}

function validMmsi(value: unknown) {
  const mmsi = String(value ?? '')
  return /^\d{9}$/.test(mmsi) ? mmsi : null
}

function validShipType(value: unknown) {
  const shipType = finiteNumber(value)
  return shipType !== null && Number.isInteger(shipType) && shipType >= 0 && shipType <= 99
    ? shipType
    : null
}

function rememberStaticVessel(mmsi: string, patch: Partial<Omit<StaticVesselData, 'expiresAt'>>) {
  const current = getStaticVessel(mmsi)
  const next: StaticVesselData = {
    name: patch.name || current?.name || '',
    shipType: patch.shipType ?? current?.shipType ?? null,
    destination: patch.destination || current?.destination || '',
    expiresAt: Date.now() + STATIC_CACHE_TTL_MS,
  }
  staticVessels.delete(mmsi)
  staticVessels.set(mmsi, next)
  while (staticVessels.size > MAX_STATIC_VESSELS) {
    const oldest = staticVessels.keys().next().value
    if (oldest === undefined) break
    staticVessels.delete(oldest)
  }
  return next
}

function getStaticVessel(mmsi: string) {
  const cached = staticVessels.get(mmsi)
  if (!cached) return null
  if (cached.expiresAt <= Date.now()) {
    staticVessels.delete(mmsi)
    return null
  }
  staticVessels.delete(mmsi)
  staticVessels.set(mmsi, cached)
  return cached
}

function cacheStaticMessage(data: JsonRecord, message: JsonRecord, metadata: JsonRecord) {
  const messageType = String(data.MessageType ?? '')
  if (messageType !== 'ShipStaticData' && messageType !== 'StaticDataReport') return false
  const report = asRecord(message[messageType])
  if (!report) return true
  if (report.Valid === false) return true
  const mmsi = validMmsi(metadata.MMSI ?? report.UserID)
  if (!mmsi) return true

  if (messageType === 'ShipStaticData') {
    rememberStaticVessel(mmsi, {
      name: boundedString(report.Name, 80),
      shipType: validShipType(report.Type),
      destination: boundedString(report.Destination, 120),
    })
    return true
  }

  const reportA = asRecord(report.ReportA)
  const reportB = asRecord(report.ReportB)
  rememberStaticVessel(mmsi, {
    name: boundedString(reportA?.Name, 80),
    shipType: validShipType(reportB?.ShipType),
  })
  return true
}

function normalizeUpstreamMessage(raw: string) {
  if (!raw || raw.length > MAX_UPSTREAM_MESSAGE_CHARS) return null
  let data: JsonRecord | null
  try {
    data = asRecord(JSON.parse(raw))
  } catch {
    return null
  }
  if (!data) return null
  const message = asRecord(data.Message)
  const metadata = asRecord(data.MetaData ?? data.Metadata)
  if (!message || !metadata) return null
  if (cacheStaticMessage(data, message, metadata)) return null

  const messageType = String(data.MessageType ?? '')
  if (!POSITION_MESSAGE_TYPES.has(messageType)) return null
  const report = asRecord(message[messageType])
  if (!report) return null
  if (report.Valid === false) return null

  const mmsi = validMmsi(metadata.MMSI ?? report.UserID)
  const latitude = finiteNumber(report.Latitude ?? metadata.latitude ?? metadata.Latitude)
  const longitude = finiteNumber(report.Longitude ?? metadata.longitude ?? metadata.Longitude)
  if (!mmsi || latitude === null || longitude === null) return null
  if (latitude < PH_BOUNDS.minLat || latitude > PH_BOUNDS.maxLat) return null
  if (longitude < PH_BOUNDS.minLng || longitude > PH_BOUNDS.maxLng) return null

  const rawSpeed = finiteNumber(report.Sog)
  const speed = rawSpeed !== null && rawSpeed >= 0 && rawSpeed <= 102.2 ? rawSpeed : 0
  const rawHeading = finiteNumber(report.TrueHeading)
  const rawCourse = finiteNumber(report.Cog)
  const heading = rawHeading !== null && rawHeading >= 0 && rawHeading < 360 ? rawHeading : null
  const course = rawCourse !== null && rawCourse >= 0 && rawCourse < 360 ? rawCourse : null
  const inlineName = boundedString(report.Name, 80)
  const inlineShipType = validShipType(report.Type ?? metadata.ShipType)
  const inlineDestination = boundedString(metadata.Destination, 120)
  const staticData = inlineName || inlineShipType !== null || inlineDestination
    ? rememberStaticVessel(mmsi, {
        name: inlineName || boundedString(metadata.ShipName, 80),
        shipType: inlineShipType,
        destination: inlineDestination,
      })
    : getStaticVessel(mmsi)

  // Only relay the fields the map consumes. This bounds downstream data and
  // prevents arbitrary provider fields from reaching the WebView.
  return JSON.stringify({
    MessageType: 'PositionReport',
    Message: {
      PositionReport: {
        Latitude: latitude,
        Longitude: longitude,
        Sog: speed,
        TrueHeading: heading,
        Cog: course,
      },
    },
    MetaData: {
      MMSI: mmsi,
      ShipName: boundedString(metadata.ShipName, 80) || staticData?.name || '',
      ShipType: inlineShipType ?? staticData?.shipType ?? 0,
      country: boundedString(metadata.country, 64),
      Destination: inlineDestination || staticData?.destination || '',
    },
  })
}

function broadcast(payload: string) {
  for (const client of clients) {
    const socket = client.socket
    if (socket.readyState !== WebSocket.OPEN) continue
    if (socket.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      socket.close(1013, 'Client is too slow')
      continue
    }
    try {
      socket.send(payload)
    } catch {
      socket.close(1011, 'Relay send failed')
    }
  }
}

function scheduleReconnect() {
  if (clients.size === 0 || reconnectTimer !== null) return
  const baseDelay = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5))
  const delay = baseDelay + Math.floor(Math.random() * 1_000)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectUpstream()
  }, delay)
}

function connectUpstream() {
  if (!providerKey || clients.size === 0) return
  if (upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING) return

  const socket = new WebSocket(UPSTREAM_URL)
  upstream = socket
  socket.onopen = () => {
    if (upstream !== socket) return socket.close(1000, 'Superseded connection')
    reconnectAttempt = 0
    socket.send(JSON.stringify({
      APIKey: providerKey,
      BoundingBoxes: PH_AIS_BBOX,
      FiltersShipMMSI: [],
      FilterMessageTypes: SUBSCRIBED_MESSAGE_TYPES,
    }))
  }
  socket.onmessage = event => {
    if (upstream !== socket || typeof event.data !== 'string') return
    const normalized = normalizeUpstreamMessage(event.data)
    if (normalized) broadcast(normalized)
  }
  socket.onerror = () => {
    // onclose owns reconnection so the relay never starts duplicate upstreams.
    try { socket.close() } catch { /* already closed */ }
  }
  socket.onclose = () => {
    if (upstream === socket) upstream = null
    scheduleReconnect()
  }
}

function removeClient(client: ClientState) {
  if (!clients.delete(client)) return
  const nextCount = (clientsByUser.get(client.userId) ?? 1) - 1
  if (nextCount > 0) clientsByUser.set(client.userId, nextCount)
  else clientsByUser.delete(client.userId)

  if (clients.size === 0) {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectAttempt = 0
    if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
      upstream.close(1000, 'No subscribers')
    }
  }
}

function reservePendingClient(key: string) {
  pendingClients += 1
  pendingClientsByKey.set(key, (pendingClientsByKey.get(key) ?? 0) + 1)
}

function releasePendingClient(key: string) {
  pendingClients = Math.max(0, pendingClients - 1)
  const nextCount = (pendingClientsByKey.get(key) ?? 1) - 1
  if (nextCount > 0) pendingClientsByKey.set(key, nextCount)
  else pendingClientsByKey.delete(key)
}

Deno.serve(async request => {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { allow: 'GET' })
  if (!originAllowed(request)) return json({ error: 'Request origin is not allowed' }, 403)
  if (!providerKey || !supabaseUrl || !supabaseApiKey) {
    return json({ error: 'Relay is not configured' }, 503)
  }
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    // A deliberately minimal public health response lets release automation
    // verify deployment and secrets without weakening the authenticated feed.
    return json({ ok: true, websocket: true }, 200)
  }
  const connectionKey = requestKey(request)
  if (!allowConnectionAttempt(connectionKey)) {
    return json({ error: 'Too many connection attempts' }, 429, { 'retry-after': '60' })
  }
  if (clients.size >= MAX_CLIENTS
    || pendingClients >= MAX_PENDING_CLIENTS
    || (pendingClientsByKey.get(connectionKey) ?? 0) >= MAX_PENDING_CLIENTS_PER_KEY) {
    return json({ error: 'Connection limit reached' }, 429, { 'retry-after': '30' })
  }

  let upgraded: { socket: WebSocket; response: Response }
  try {
    // Hosted Edge currently rejects protocol selection during upgrade, so the
    // authenticated handshake is completed in the first encrypted data frame.
    upgraded = Deno.upgradeWebSocket(request)
  } catch {
    return json({ error: 'WebSocket upgrade failed' }, 400)
  }
  const { socket, response } = upgraded
  reservePendingClient(connectionKey)

  let resolveClosed: (() => void) | null = null
  const socketClosed = new Promise<void>(resolve => { resolveClosed = resolve })
  EdgeRuntime.waitUntil(socketClosed)

  const connectionState: { phase: 'awaiting-auth' | 'authenticating' | 'authenticated' | 'closed' } = {
    phase: 'awaiting-auth',
  }
  let authenticatedClient: ClientState | null = null
  let pendingReservation = true
  const authTimer = setTimeout(() => {
    if (connectionState.phase === 'awaiting-auth' || connectionState.phase === 'authenticating') {
      socket.close(1008, 'Authentication timeout')
    }
  }, AUTH_FRAME_TIMEOUT_MS)

  const releasePendingReservation = () => {
    if (!pendingReservation) return
    pendingReservation = false
    releasePendingClient(connectionKey)
  }
  const connectionClosed = () => connectionState.phase === 'closed'

  const authenticateFrame = async (frame: unknown) => {
    connectionState.phase = 'authenticating'
    const accessToken = accessTokenFromAuthFrame(frame)
    if (!accessToken) {
      socket.close(1008, 'Invalid authentication frame')
      return
    }
    const userId = await authenticateUser(accessToken)
    if (connectionClosed()) return
    if (!userId) {
      socket.close(1008, 'Invalid or expired session')
      return
    }
    if (clients.size >= MAX_CLIENTS || (clientsByUser.get(userId) ?? 0) >= MAX_CLIENTS_PER_USER) {
      socket.close(1013, 'Connection limit reached')
      return
    }

    releasePendingReservation()
    authenticatedClient = { socket, userId }
    clients.add(authenticatedClient)
    clientsByUser.set(userId, (clientsByUser.get(userId) ?? 0) + 1)
    connectionState.phase = 'authenticated'
    clearTimeout(authTimer)
    try {
      socket.send(JSON.stringify({ type: 'authenticated' }))
    } catch {
      socket.close(1011, 'Authentication acknowledgement failed')
      return
    }
    connectUpstream()
  }

  socket.onmessage = event => {
    if (connectionState.phase === 'authenticated') {
      socket.close(1008, 'Read-only feed')
      return
    }
    if (connectionState.phase !== 'awaiting-auth') {
      socket.close(1008, 'Only one authentication frame is allowed')
      return
    }
    void authenticateFrame(event.data)
  }
  socket.onerror = () => {
    // The close handler performs all shared-state cleanup.
  }
  socket.onclose = () => {
    connectionState.phase = 'closed'
    clearTimeout(authTimer)
    releasePendingReservation()
    if (authenticatedClient) removeClient(authenticatedClient)
    resolveClosed?.()
    resolveClosed = null
  }

  return response
})
