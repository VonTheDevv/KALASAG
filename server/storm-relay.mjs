import http from 'node:http'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const HOST = String(process.env.STORM_RELAY_HOST || '127.0.0.1').trim()
const PORT = Math.max(1, Math.min(65_535, Number(process.env.STORM_RELAY_PORT) || 8790))
const FEED_URL = 'https://www.gdacs.org/xml/gdacs.geojson'
const GEOMETRY_URL = 'https://www.gdacs.org/gdacsapi/api/polygons/getgeometry'
const MAX_FEED_BYTES = 16 * 1024 * 1024
const MAX_GEOMETRY_BYTES = 8 * 1024 * 1024
const FRESH_MS = 5 * 60_000
const STALE_MS = 30 * 60_000
const RELAY_PATH = '/api/live-data'
const HEALTH_PATH = '/healthz'

const allowedOrigins = new Set([
  'https://kalasagph.tech',
  'https://localhost',
  'capacitor://localhost',
  ...String(process.env.STORM_RELAY_ALLOWED_ORIGINS || '').split(','),
].map(value => value.trim().replace(/\/$/, '')).filter(Boolean))

const PAR_BOUNDARY = [[25, 120], [25, 135], [5, 135], [5, 115], [15, 115], [21, 120], [25, 120]]

let cachedPayload = null
let cachedAt = 0
let refreshPromise
let lastFailureAt = null
let lastFailureMessage = null
let shuttingDown = false

function pointInPolygon(lat, lng, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [latI, lngI] = polygon[i]
    const [latJ, lngJ] = polygon[j]
    const crosses = ((latI > lat) !== (latJ > lat))
      && lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI || Number.EPSILON) + lngI
    if (crosses) inside = !inside
  }
  return inside
}

function distanceToSegmentKm(lat, lng, start, end) {
  const referenceLat = ((lat + start[0] + end[0]) / 3) * Math.PI / 180
  const scaleX = 111.32 * Math.cos(referenceLat)
  const px = lng * scaleX
  const py = lat * 111.32
  const ax = start[1] * scaleX
  const ay = start[0] * 111.32
  const bx = end[1] * scaleX
  const by = end[0] * 111.32
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const ratio = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared
  const offset = Math.max(0, Math.min(1, ratio))
  return Math.hypot(px - (ax + offset * dx), py - (ay + offset * dy))
}

export function distanceToParKm(lat, lng) {
  if (pointInPolygon(lat, lng, PAR_BOUNDARY)) return 0
  return Math.min(...PAR_BOUNDARY.slice(0, -1).map((point, index) => (
    distanceToSegmentKm(lat, lng, point, PAR_BOUNDARY[index + 1])
  )))
}

export function gdacsCyclones(payload) {
  const deduplicated = new Map()
  for (const feature of Array.isArray(payload?.features) ? payload.features : []) {
    const properties = feature?.properties
    const coordinates = feature?.geometry?.coordinates
    if (properties?.eventtype !== 'TC' || feature?.geometry?.type !== 'Point' || !Array.isArray(coordinates)) continue
    const [lng, lat] = coordinates
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || distanceToParKm(lat, lng) > 10) continue
    const id = String(properties.eventid ?? `${lat}-${lng}`)
    deduplicated.set(id, {
      id,
      name: properties.name || 'Unnamed tropical cyclone',
      lat,
      lng,
      alertlevel: properties.alertlevel || 'Green',
      alertscore: Number(properties.alertscore) || 0,
      severity: Number(properties.severity) || undefined,
      description: properties.description || 'No event description was supplied.',
      windKph: properties.windspeed ? Math.round(Number(properties.windspeed) * 1.852) : undefined,
      source: 'Global Disaster Alert and Coordination System, GDACS',
      updated: properties.fromdate ?? properties.todate,
      ended: properties.todate,
      countries: properties.country || undefined,
      distanceToParKm: Math.round(distanceToParKm(lat, lng) * 10) / 10,
    })
  }
  return [...deduplicated.values()]
}

export function gdacsTrack(geometry, forecast, center) {
  const features = Array.isArray(geometry?.features) ? geometry.features : []
  const segments = features
    .filter(feature => feature?.geometry?.type === 'LineString' && feature?.properties?.forecast === forecast)
    .map(feature => ({
      intensity: String(feature.properties?.polygonlabel ?? 'Unknown'),
      coordinates: (Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [])
        .filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])),
    }))
    .filter(segment => segment.coordinates.length > 1)

  if (!segments.length) return { track: [], points: [] }

  const distanceSquared = point => (point[0] - center[0]) ** 2 + (point[1] - center[1]) ** 2
  const samePoint = (first, second) => Math.abs(first[0] - second[0]) < 1e-6 && Math.abs(first[1] - second[1]) < 1e-6
  let startIndex = 0
  let reverseStart = false
  let nearest = Number.POSITIVE_INFINITY

  segments.forEach((segment, index) => {
    const firstDistance = distanceSquared(segment.coordinates[0])
    const lastDistance = distanceSquared(segment.coordinates[segment.coordinates.length - 1])
    if (firstDistance < nearest) {
      nearest = firstDistance
      startIndex = index
      reverseStart = false
    }
    if (lastDistance < nearest) {
      nearest = lastDistance
      startIndex = index
      reverseStart = true
    }
  })

  const remaining = [...segments]
  const first = remaining.splice(startIndex, 1)[0]
  const firstCoordinates = reverseStart ? [...first.coordinates].reverse() : first.coordinates
  let ordered = firstCoordinates.map(([lng, lat]) => ({ lat, lng, intensity: first.intensity }))

  while (remaining.length) {
    const last = ordered[ordered.length - 1]
    const lastCoordinate = [last.lng, last.lat]
    const matchIndex = remaining.findIndex(segment => (
      samePoint(segment.coordinates[0], lastCoordinate)
      || samePoint(segment.coordinates[segment.coordinates.length - 1], lastCoordinate)
    ))
    if (matchIndex < 0) break
    const segment = remaining.splice(matchIndex, 1)[0]
    const coordinates = samePoint(segment.coordinates[0], lastCoordinate)
      ? segment.coordinates
      : [...segment.coordinates].reverse()
    ordered.push(...coordinates.slice(1).map(([lng, lat]) => ({ lat, lng, intensity: segment.intensity })))
  }

  if (!forecast) ordered = ordered.reverse()
  return { track: ordered.map(point => [point.lat, point.lng]), points: ordered }
}

async function readLimitedJson(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('GDACS response exceeded the configured size limit')
  }
  if (!response.body) throw new Error('GDACS returned an empty response')

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('GDACS response exceeded the configured size limit')
    }
    chunks.push(value)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body))
}

async function fetchJson(url, maxBytes) {
  const response = await fetch(url, {
    headers: { accept: 'application/geo+json, application/json', 'user-agent': 'KALASAG-StormRelay/1.0' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GDACS returned HTTP ${response.status}`)
  return readLimitedJson(response, maxBytes)
}

export async function buildStormPayload(feed, geometryLoader = async () => null, checkedAt = new Date().toISOString()) {
  const cyclones = gdacsCyclones(feed)
  const data = await Promise.all(cyclones.map(async cyclone => {
    try {
      const geometry = await geometryLoader(cyclone.id)
      if (!geometry) return cyclone
      const center = [cyclone.lng, cyclone.lat]
      const observed = gdacsTrack(geometry, false, center)
      const forecast = gdacsTrack(geometry, true, center)
      return {
        ...cyclone,
        observedTrack: observed.track,
        forecastTrack: forecast.track,
        observedPoints: observed.points,
        forecastPoints: forecast.points,
      }
    } catch {
      return cyclone
    }
  }))
  return { data, sources: [{ id: 'storm-primary', status: 'live', checkedAt }], fetchedAt: checkedAt }
}

async function refresh() {
  const checkedAt = new Date().toISOString()
  const feed = await fetchJson(FEED_URL, MAX_FEED_BYTES)
  const payload = await buildStormPayload(feed, async eventId => {
    const endpoint = new URL(GEOMETRY_URL)
    endpoint.searchParams.set('eventid', eventId)
    endpoint.searchParams.set('eventtype', 'TC')
    return fetchJson(endpoint, MAX_GEOMETRY_BYTES)
  }, checkedAt)
  cachedPayload = payload
  cachedAt = Date.now()
  lastFailureAt = null
  lastFailureMessage = null
  return payload
}

async function stormResponse() {
  const now = Date.now()
  if (cachedPayload && now - cachedAt < FRESH_MS) return { payload: cachedPayload, cacheState: 'fresh' }

  if (!refreshPromise) {
    refreshPromise = refresh().finally(() => { refreshPromise = undefined })
  }

  try {
    return { payload: await refreshPromise, cacheState: 'live' }
  } catch (error) {
    lastFailureAt = new Date().toISOString()
    lastFailureMessage = String(error instanceof Error ? error.message : 'Unknown upstream error').slice(0, 160)
    console.warn(`Storm feed refresh failed: ${lastFailureMessage}`)
    if (cachedPayload && now - cachedAt < STALE_MS) return { payload: cachedPayload, cacheState: 'stale' }
    throw error
  }
}

function originAllowed(request) {
  const origin = String(request.headers.origin || '').replace(/\/$/, '')
  return !origin || allowedOrigins.has(origin)
}

function responseHeaders(request, extra = {}) {
  const origin = String(request.headers.origin || '').replace(/\/$/, '')
  return {
    'cache-control': 'no-store, max-age=0',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), payment=(), usb=()',
    ...(origin && allowedOrigins.has(origin) ? {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'authorization, apikey, content-type',
      'access-control-expose-headers': 'retry-after, x-kalasag-cache-state, x-kalasag-source-checked-at',
      vary: 'Origin',
    } : {}),
    ...extra,
  }
}

function sendJson(request, response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, responseHeaders(request, {
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  }))
  response.end(request.method === 'HEAD' ? undefined : body)
}

function createServer() {
  return http.createServer(async (request, response) => {
    let url
    try {
      url = new URL(request.url || '/', 'http://localhost')
    } catch {
      sendJson(request, response, 400, { error: 'Invalid request' })
      return
    }

    if (!originAllowed(request)) {
      sendJson(request, response, 403, { error: 'Request origin is not allowed' })
      return
    }

    const resource = url.searchParams.get('resource')
    if (request.method === 'OPTIONS' && url.pathname === RELAY_PATH && resource === 'storms') {
      response.writeHead(204, responseHeaders(request))
      response.end()
      return
    }

    if (request.method === 'GET' && url.pathname === HEALTH_PATH) {
      sendJson(request, response, 200, {
        ok: true,
        ready: Boolean(cachedPayload),
        cacheAgeSeconds: cachedAt ? Math.round((Date.now() - cachedAt) / 1000) : null,
        cycloneCount: cachedPayload?.data?.length ?? null,
        lastSuccessfulFetchAt: cachedPayload?.fetchedAt ?? null,
        lastFailureAt,
        lastFailureMessage,
      })
      return
    }

    if (!['GET', 'HEAD'].includes(request.method || '')
      || url.pathname !== RELAY_PATH
      || resource !== 'storms') {
      sendJson(request, response, 404, { error: 'Not found' })
      return
    }

    try {
      const result = await stormResponse()
      sendJson(request, response, 200, result.payload, { 'x-kalasag-cache-state': result.cacheState })
    } catch {
      sendJson(request, response, 503, {
        error: 'Tropical-cyclone feed is unavailable',
        sources: [{
          id: 'storm-primary',
          status: 'unavailable',
          checkedAt: new Date().toISOString(),
          detail: 'Upstream request failed',
        }],
      })
    }
  })
}

function start() {
  const server = createServer()

  function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`Live hazard relay received ${signal}; shutting down.`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5_000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  server.listen(PORT, HOST, () => {
    console.log(`KALASAG live hazard relay listening on http://${HOST}:${PORT}${RELAY_PATH}`)
    refreshPromise = refresh().finally(() => { refreshPromise = undefined })
    refreshPromise.catch(error => {
      lastFailureAt = new Date().toISOString()
      lastFailureMessage = String(error instanceof Error ? error.message : 'Unknown upstream error').slice(0, 160)
      console.warn(`Initial storm feed refresh failed: ${lastFailureMessage}`)
    })
  })
}

const executedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (executedDirectly) start()
