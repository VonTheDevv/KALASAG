// Public, read-only live data gateway for the KALASAG client.
// External providers are fetched server-side so browser CORS policy and public
// proxy outages cannot make a hazard layer silently look current.

import {
  assessOfficialHazardFreshness,
  OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS,
} from '../_shared/hazard-freshness.js'
import {
  OFFICIAL_DAM_LOCATION_BASELINE,
  OFFICIAL_DAM_LOCATION_BASELINE_CAPTURED_AT,
} from '../_shared/dam-location-baseline.js'

const PH_BOUNDS = { minLat: 4.5, maxLat: 21.5, minLng: 116, maxLng: 127.5 }
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_CSV_BYTES = 16 * 1024 * 1024
const MAX_TILE_BYTES = 1024 * 1024
const TRAFFIC_TILE_FRESH_MS = 45_000
const TRAFFIC_TILE_STALE_MS = 2 * 60_000

type SourceHealth = {
  id: string
  status: 'live' | 'stale' | 'unknown' | 'unavailable'
  checkedAt: string
  detail?: string
}

const headers = {
  'cache-control': 'no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), payment=(), usb=()',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
const inPhilippines = (lat: number, lng: number) => lat >= PH_BOUNDS.minLat && lat <= PH_BOUNDS.maxLat && lng >= PH_BOUNDS.minLng && lng <= PH_BOUNDS.maxLng
const providerFailureDetail = 'Upstream request failed'

class BoundedTtlCache<Value> {
  private readonly entries = new Map<string, { value: Value; expiresAt: number }>()
  private readonly maxEntries: number

  constructor(maxEntries: number) { this.maxEntries = maxEntries }

  get(key: string): Value | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: Value, ttlMs: number) {
    this.entries.delete(key)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs })
  }
}

type TrafficTileCacheEntry = {
  bytes: Uint8Array
  contentType: string
  freshUntil: number
}

const trafficTileCache = new BoundedTtlCache<TrafficTileCacheEntry>(128)
const trafficTileRequests = new Map<string, Promise<TrafficTileCacheEntry>>()

type JsonCachePolicy = {
  freshMs: number
  staleMs: number
}

type JsonCacheEntry = {
  payload: Record<string, unknown>
  storedAt: number
  freshUntil: number
  staleUntil: number
  refreshAfter: number
  lastFailurePayload?: Record<string, unknown>
  sizeBytes: number
}

type ResponseDescriptor = {
  body: string
  headers: [string, string][]
  status: number
  statusText: string
}

const JSON_CACHE_MAX_ENTRIES = 128
const JSON_CACHE_MAX_BYTES = 24 * 1024 * 1024
const JSON_CACHE_MAX_ENTRY_BYTES = 5 * 1024 * 1024
const JSON_REQUEST_MAX_IN_FLIGHT = 128

const jsonCachePolicies: Record<string, JsonCachePolicy> = {
  'dam-release-advisories': { freshMs: 60 * 60_000, staleMs: 48 * 60 * 60_000 },
  dams: { freshMs: 60 * 60_000, staleMs: 48 * 60 * 60_000 },
  earthquakes: { freshMs: 60_000, staleMs: 15 * 60_000 },
  flights: { freshMs: 8_000, staleMs: 60_000 },
  'flood-advisories': { freshMs: 10 * 60_000, staleMs: 6 * 60 * 60_000 },
  floods: { freshMs: 5 * 60_000, staleMs: 30 * 60_000 },
  'gfw-vessel': { freshMs: 60 * 60_000, staleMs: 24 * 60 * 60_000 },
  heat: { freshMs: 5 * 60_000, staleMs: 30 * 60_000 },
  'reverse-geocode': { freshMs: 6 * 60 * 60_000, staleMs: 7 * 24 * 60 * 60_000 },
  'safe-grounds': { freshMs: 30 * 60_000, staleMs: 24 * 60 * 60_000 },
  'storm-surge-advisories': { freshMs: 5 * 60_000, staleMs: 6 * 60 * 60_000 },
  storms: { freshMs: 5 * 60_000, staleMs: 30 * 60_000 },
  traffic: { freshMs: 30_000, staleMs: 2 * 60_000 },
  weather: { freshMs: 5 * 60_000, staleMs: 30 * 60_000 },
}

class BoundedJsonResponseCache {
  private readonly entries = new Map<string, JsonCacheEntry>()
  private totalBytes = 0

  get(key: string): JsonCacheEntry | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.staleUntil <= Date.now()) {
      this.delete(key)
      return undefined
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, payload: Record<string, unknown>, policy: JsonCachePolicy) {
    const serialized = JSON.stringify(payload)
    const sizeBytes = new TextEncoder().encode(serialized).byteLength
    if (sizeBytes > JSON_CACHE_MAX_ENTRY_BYTES || sizeBytes > JSON_CACHE_MAX_BYTES) return

    this.delete(key)
    while (this.entries.size >= JSON_CACHE_MAX_ENTRIES || this.totalBytes + sizeBytes > JSON_CACHE_MAX_BYTES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }

    const storedAt = Date.now()
    this.entries.set(key, {
      payload,
      storedAt,
      freshUntil: storedAt + policy.freshMs,
      staleUntil: storedAt + policy.staleMs,
      refreshAfter: storedAt,
      sizeBytes,
    })
    this.totalBytes += sizeBytes
  }

  deferRefresh(key: string, failurePayload: Record<string, unknown> | undefined, delayMs: number) {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.refreshAfter = Math.max(entry.refreshAfter, Date.now() + delayMs)
    entry.lastFailurePayload = failurePayload
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private delete(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.totalBytes -= entry.sizeBytes
  }
}

const jsonResponseCache = new BoundedJsonResponseCache()
const jsonResponseRequests = new Map<string, Promise<ResponseDescriptor>>()

function normalizedCoordinate(url: URL, name: 'lat' | 'lng', precision = 4) {
  const raw = url.searchParams.get(name) ?? ''
  const value = Number(raw)
  return Number.isFinite(value) ? value.toFixed(precision) : raw.slice(0, 32)
}

function safeGroundRadiusKm(url: URL) {
  const raw = url.searchParams.get('radiusKm')
  const requested = raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Math.max(1, Math.min(20, Number.isFinite(requested) ? requested : 5))
}

function jsonCacheKey(resource: string, url: URL) {
  if (resource === 'gfw-vessel') {
    const mmsi = url.searchParams.get('mmsi') ?? ''
    return /^\d{9}$/.test(mmsi) ? `${resource}:${mmsi}` : undefined
  }
  if (resource === 'weather' || resource === 'safe-grounds' || resource === 'traffic' || resource === 'reverse-geocode') {
    const lat = Number(url.searchParams.get('lat'))
    const lng = Number(url.searchParams.get('lng'))
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) return undefined
    if (resource === 'reverse-geocode') return `${resource}:${normalizedCoordinate(url, 'lat', 4)}:${normalizedCoordinate(url, 'lng', 4)}`
    if (resource === 'weather') return `${resource}:${normalizedCoordinate(url, 'lat')}:${normalizedCoordinate(url, 'lng')}`
    if (resource === 'safe-grounds') return `${resource}:${normalizedCoordinate(url, 'lat', 3)}:${normalizedCoordinate(url, 'lng', 3)}:${safeGroundRadiusKm(url).toFixed(1)}`

    const requestedRadius = Number(url.searchParams.get('radiusKm'))
    const radiusKm = Math.max(1, Math.min(20, Number.isFinite(requestedRadius) ? requestedRadius : 20))
    return `${resource}:${normalizedCoordinate(url, 'lat')}:${normalizedCoordinate(url, 'lng')}:${radiusKm.toFixed(1)}`
  }
  return resource
}

async function describeResponse(response: Response): Promise<ResponseDescriptor> {
  return {
    body: await response.text(),
    headers: [...response.headers.entries()],
    status: response.status,
    statusText: response.statusText,
  }
}

function responseFromDescriptor(descriptor: ResponseDescriptor) {
  return new Response(descriptor.body, {
    headers: descriptor.headers,
    status: descriptor.status,
    statusText: descriptor.statusText,
  })
}

function parseJsonPayload(body: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(body)
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function cacheableJsonPayload(payload: Record<string, unknown> | undefined): payload is Record<string, unknown> {
  return Boolean(payload && 'data' in payload && typeof payload.fetchedAt === 'string' && Array.isArray(payload.sources))
}

function sourceHealth(value: unknown): SourceHealth[] {
  if (!Array.isArray(value)) return []
  return value.filter((source): source is SourceHealth => {
    if (!source || typeof source !== 'object') return false
    const candidate = source as Partial<SourceHealth>
    return typeof candidate.id === 'string'
      && ['live', 'stale', 'unknown', 'unavailable'].includes(String(candidate.status))
      && typeof candidate.checkedAt === 'string'
  })
}

function cacheStateDescriptor(
  payload: Record<string, unknown>,
  state: 'live' | 'cached' | 'stale',
  entry?: JsonCacheEntry,
  failurePayload?: Record<string, unknown>,
) {
  const storedAt = entry?.storedAt ?? Date.now()
  const responsePayload: Record<string, unknown> = {
    ...payload,
    deliveryFreshness: state === 'live' ? 'network' : state,
    stale: state === 'stale',
    cache: {
      state,
      storedAt: new Date(storedAt).toISOString(),
      ...(state === 'stale' ? {
        refreshFailedAt: new Date().toISOString(),
        ...(entry?.refreshAfter ? { nextRefreshAt: new Date(entry.refreshAfter).toISOString() } : {}),
      } : {}),
    },
  }

  if (payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)) {
    const sourceMetadata = payload.metadata as Record<string, unknown>
    responsePayload.metadata = state === 'stale'
      ? {
          ...sourceMetadata,
          freshness: 'stale',
          freshnessReason: 'official-source-refresh-failed',
          evaluatedAt: new Date().toISOString(),
        }
      : sourceMetadata
  }

  if (state === 'stale') {
    const effectiveFailure = failurePayload ?? entry?.lastFailurePayload
    const failedSources = new Map(sourceHealth(effectiveFailure?.sources).map(source => [source.id, source]))
    const fetchedAt = typeof payload.fetchedAt === 'string' ? payload.fetchedAt : new Date(storedAt).toISOString()
    responsePayload.sources = sourceHealth(payload.sources).map(source => {
      const failedSource = failedSources.get(source.id)
      const reason = failedSource?.detail || 'Live refresh failed'
      return {
        ...source,
        status: 'stale' as const,
        checkedAt: failedSource?.checkedAt ?? new Date().toISOString(),
        detail: `${reason}; serving cached data last fetched at ${fetchedAt}`,
      }
    })
  }

  const responseHeaders = new Headers(headers)
  responseHeaders.set('x-kalasag-cache-state', state)
  return {
    body: JSON.stringify(responsePayload),
    headers: [...responseHeaders.entries()],
    status: 200,
    statusText: '',
  } satisfies ResponseDescriptor
}

function transientStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function refreshJsonResource(
  key: string,
  policy: JsonCachePolicy,
  staleEntry: JsonCacheEntry | undefined,
  load: () => Promise<Response>,
): Promise<ResponseDescriptor> {
  let response: Response
  try {
    response = await load()
  } catch {
    response = json({ error: 'Live data is temporarily unavailable' }, 503)
  }

  const descriptor = await describeResponse(response)
  const payload = parseJsonPayload(descriptor.body)
  if (descriptor.status >= 200 && descriptor.status < 300 && cacheableJsonPayload(payload)) {
    jsonResponseCache.set(key, payload, policy)
    return cacheStateDescriptor(payload, 'live', jsonResponseCache.get(key))
  }
  if (staleEntry && transientStatus(descriptor.status)) {
    const retryDelayMs = Math.min(30_000, Math.max(5_000, Math.round(policy.freshMs / 4)))
    jsonResponseCache.deferRefresh(key, payload, retryDelayMs)
    return cacheStateDescriptor(staleEntry.payload, 'stale', staleEntry, payload)
  }
  return descriptor
}

async function cachedJsonResource(resource: string, url: URL, load: () => Promise<Response>) {
  const policy = jsonCachePolicies[resource]
  if (!policy) return load()

  const key = jsonCacheKey(resource, url)
  if (!key) return load()
  const cached = jsonResponseCache.get(key)
  if (cached && cached.freshUntil > Date.now()) {
    return responseFromDescriptor(cacheStateDescriptor(cached.payload, 'cached', cached))
  }
  if (cached && cached.refreshAfter > Date.now()) {
    return responseFromDescriptor(cacheStateDescriptor(cached.payload, 'stale', cached))
  }

  let pending = jsonResponseRequests.get(key)
  if (!pending) {
    if (jsonResponseRequests.size >= JSON_REQUEST_MAX_IN_FLIGHT) {
      if (cached) {
        jsonResponseCache.deferRefresh(key, undefined, 2_000)
        return responseFromDescriptor(cacheStateDescriptor(cached.payload, 'stale', cached))
      }
      const busy = json({ error: 'Live data service is busy' }, 503)
      busy.headers.set('retry-after', '2')
      return busy
    }
    pending = refreshJsonResource(key, policy, cached, load).finally(() => jsonResponseRequests.delete(key))
    jsonResponseRequests.set(key, pending)
  }
  return responseFromDescriptor(await pending)
}

function trafficTileResponse(tile: TrafficTileCacheEntry, state: 'live' | 'cached' | 'stale') {
  return new Response(tile.bytes.slice(), {
    status: 200,
    headers: {
      ...headers,
      'content-type': tile.contentType,
      'content-length': String(tile.bytes.byteLength),
      'cache-control': state === 'stale' ? 'public, max-age=10' : 'public, max-age=45, stale-while-revalidate=120',
      'x-kalasag-cache-state': state,
    },
  })
}

// This guard is intentionally bounded and per Edge Function isolate. It reduces
// accidental/provider abuse, but an edge WAF or gateway limit is still required
// for globally coordinated production rate limiting.
class InstanceRateLimiter {
  private readonly entries = new Map<string, { count: number; resetsAt: number }>()
  private readonly maxEntries: number

  constructor(maxEntries: number) { this.maxEntries = maxEntries }

  consume(key: string, limit: number, windowMs: number) {
    const now = Date.now()
    let entry = this.entries.get(key)
    if (!entry || entry.resetsAt <= now) entry = { count: 0, resetsAt: now + windowMs }
    entry.count += 1
    this.entries.delete(key)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, entry)
    return { allowed: entry.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetsAt - now) / 1000)) }
  }
}

async function readLimitedText(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Upstream response exceeded the size limit')
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('Upstream response exceeded the size limit')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(merged)
}

async function fetchText(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': 'KALASAG-LiveData/1.0' }, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`)
  return readLimitedText(response, MAX_CSV_BYTES)
}

async function fetchJson(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': 'KALASAG-LiveData/1.0' }, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`)
  return JSON.parse(await readLimitedText(response, MAX_JSON_BYTES))
}

async function fetchAuthenticatedJson(url: string, token: string) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}`, 'user-agent': 'KALASAG-LiveData/1.0' }, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`)
  return JSON.parse(await readLimitedText(response, MAX_JSON_BYTES))
}

async function fetchOverpassJson(endpoint: string, query: string, signal: AbortSignal) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'user-agent': 'KALASAG/1.0 (public-safety-monitoring)',
    },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  })
  if (!response.ok) throw new Error(`Overpass returned HTTP ${response.status}`)
  return JSON.parse(await readLimitedText(response, MAX_JSON_BYTES))
}

type OverpassProvider = { id: string; endpoint: string }

async function firstAvailableOverpass(providers: OverpassProvider[], query: string, timeoutMs: number) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await Promise.any(providers.map(async provider => {
      const payload = await fetchOverpassJson(provider.endpoint, query, controller.signal)
      const remark = typeof payload?.remark === 'string' ? payload.remark : ''
      if (!Array.isArray(payload?.elements) || /(?:error|failed|timeout|timed out|out of memory)/i.test(remark)) {
        throw new Error('Overpass returned an incomplete result')
      }
      return { provider, payload }
    }))
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

function safeGroundBbox(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / 110.574
  const lngDelta = radiusKm / (111.320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))
  return `${(lat - latDelta).toFixed(5)},${(lng - lngDelta).toFixed(5)},${(lat + latDelta).toFixed(5)},${(lng + lngDelta).toFixed(5)}`
}

function safeGroundQuery(lat: number, lng: number, radiusKm: number, candidateRadiusKm = Math.min(radiusKm, 5)) {
  const designatedBbox = safeGroundBbox(lat, lng, radiusKm)
  // Keep the full requested radius for designated evacuation facilities.
  // Broad candidate classes start nearby because city-wide scans can overload
  // every free Overpass endpoint; normalized responses are capped at 80 sites.
  const candidateBbox = safeGroundBbox(lat, lng, candidateRadiusKm)
  return `[out:json][timeout:20];(
    nwr["emergency"~"^(assembly_point|evacuation_assembly_point|shelter)$"](${designatedBbox});
    nwr["evacuation_center"]["evacuation_center"!="no"](${designatedBbox});
    nwr["emergency:social_facility"="shelter"](${designatedBbox});
    nwr["social_facility"="shelter"]["social_facility:for"~"displaced",i](${designatedBbox});
    nwr["amenity"~"^(shelter|school|college|university|community_centre|townhall)$"](${candidateBbox});
    nwr["social_facility"="shelter"](${candidateBbox});
    nwr["leisure"~"^(park|playground|pitch|sports_centre|stadium|recreation_ground)$"](${candidateBbox});
    nwr["landuse"~"^(recreation_ground|village_green)$"](${candidateBbox});
    nwr["building"~"^(civic|public)$"](${candidateBbox});
  );out center qt;`
}

function safeGroundDistanceKm(latA: number, lngA: number, latB: number, lngB: number) {
  const radians = (value: number) => value * Math.PI / 180
  const dLat = radians(latB - latA), dLng = radians(lngB - lngA)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function unavailableSafeGround(tags: Record<string, unknown>) {
  const value = (name: string) => String(tags[name] ?? '').trim().toLowerCase()
  if (['private', 'no'].includes(value('access'))) return true
  if (['closed', 'inactive', 'disused', 'abandoned', 'demolished', 'razed'].includes(value('status'))) return true
  if (['closed', 'no'].includes(value('operational_status')) || value('opening_hours') === 'closed') return true
  if (value('construction') || value('building') === 'construction' || value('landuse') === 'construction') return true
  if (['yes', 'true', '1'].includes(value('abandoned')) || ['yes', 'true', '1'].includes(value('disused'))) return true
  return Object.keys(tags).some(key => /^(abandoned|construction|demolished|disused|proposed|razed):/.test(key))
}

function safeGroundKind(tags: Record<string, unknown>) {
  const emergency = String(tags.emergency ?? '').toLowerCase()
  const evacuationCenter = String(tags.evacuation_center ?? '').trim().toLowerCase()
  const emergencySocialFacility = String(tags['emergency:social_facility'] ?? '').trim().toLowerCase()
  const socialFacilityFor = String(tags['social_facility:for'] ?? '').trim().toLowerCase()
  if (emergency === 'assembly_point') return { kind: 'assembly_point', designated: true, label: 'Assembly Point' }
  if (emergency === 'evacuation_assembly_point') return { kind: 'evacuation_assembly_point', designated: true, label: 'Evacuation Assembly Point' }
  if (emergency === 'shelter') return { kind: 'emergency_shelter', designated: true, label: 'Emergency Shelter' }
  if (evacuationCenter && evacuationCenter !== 'no') return { kind: 'evacuation_center', designated: true, label: 'Evacuation Center' }
  if (emergencySocialFacility === 'shelter') return { kind: 'emergency_shelter', designated: true, label: 'Emergency Shelter' }
  if (tags.social_facility === 'shelter' && /displaced/.test(socialFacilityFor)) return { kind: 'evacuation_shelter', designated: true, label: 'Evacuation Shelter' }
  if (tags.amenity === 'shelter' || tags.social_facility === 'shelter') return { kind: 'shelter', designated: false, label: 'Shelter' }
  if (tags.leisure === 'park') return { kind: 'park', designated: false, label: 'Park' }
  if (tags.leisure === 'playground') return { kind: 'playground', designated: false, label: 'Playground' }
  if (tags.leisure === 'pitch') return { kind: 'pitch', designated: false, label: 'Sports Field' }
  if (tags.leisure === 'sports_centre') return { kind: 'sports_centre', designated: false, label: 'Sports Centre' }
  if (tags.leisure === 'stadium') return { kind: 'stadium', designated: false, label: 'Stadium Grounds' }
  if (tags.leisure === 'recreation_ground') return { kind: 'recreation_ground', designated: false, label: 'Public Recreation Ground' }
  if (tags.landuse === 'recreation_ground' || tags.landuse === 'village_green') return { kind: String(tags.landuse), designated: false, label: 'Public Open Ground' }
  if (tags.amenity === 'school') return { kind: 'school', designated: false, label: 'School Grounds' }
  if (tags.amenity === 'college' || tags.amenity === 'university') return { kind: String(tags.amenity), designated: false, label: 'Campus Grounds' }
  if (tags.amenity === 'community_centre') return { kind: 'community_centre', designated: false, label: 'Community Centre' }
  if (tags.amenity === 'townhall') return { kind: 'townhall', designated: false, label: 'Town Hall' }
  return { kind: 'public_facility', designated: false, label: 'Public Facility' }
}

function normalizeSafeGrounds(elements: any[], lat: number, lng: number, radiusKm: number) {
  return elements.flatMap((element: any) => {
    const tags = (element.tags ?? {}) as Record<string, unknown>
    if (unavailableSafeGround(tags)) return []
    const elementLat = Number(element.lat ?? element.center?.lat)
    const elementLng = Number(element.lon ?? element.center?.lon)
    if (!Number.isFinite(elementLat) || !Number.isFinite(elementLng)) return []
    const distanceKm = safeGroundDistanceKm(lat, lng, elementLat, elementLng)
    if (distanceKm > radiusKm) return []
    const { kind, designated, label } = safeGroundKind(tags)
    const street = tags['addr:street']
    const city = tags['addr:city']
    return [{
      id: `osm-${element.type ?? 'element'}-${element.id}`,
      name: String(tags.name || `${label} (Unlabelled)`),
      address: street ? `${street}${city ? `, ${city}` : ''}` : `Mapped site near ${elementLat.toFixed(4)}, ${elementLng.toFixed(4)}`,
      lat: elementLat,
      lng: elementLng,
      status: designated ? 'Mapped designated site - current availability unverified' : 'Mapped candidate - suitability and access unverified',
      kind,
      designated,
      distanceKm: Math.round(distanceKm * 1000) / 1000,
      isOsm: true,
    }]
  }).sort((a, b) => Number(b.designated) - Number(a.designated) || a.distanceKm - b.distanceKm || a.name.localeCompare(b.name)).slice(0, 80)
}

async function safeGrounds(url: URL) {
  const checkedAt = new Date().toISOString()
  const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) return json({ error: 'A valid Philippine location is required' }, 400)
  const radiusKm = safeGroundRadiusKm(url)
  const sources: SourceHealth[] = []
  const deadline = Date.now() + 27_000
  const query = safeGroundQuery(lat, lng, radiusKm)
  const providers: OverpassProvider[] = [
    { id: 'safe-ground-1', endpoint: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter' },
    { id: 'safe-ground-2', endpoint: 'https://overpass-api.de/api/interpreter' },
    { id: 'safe-ground-3', endpoint: 'https://lz4.overpass-api.de/api/interpreter' },
  ]
  try {
    const result = await firstAvailableOverpass(providers, query, Math.min(16_000, deadline - Date.now()))
    sources.push({ id: result.provider.id, status: 'live', checkedAt })
    const payload: any = result.payload
    let data = normalizeSafeGrounds(payload.elements ?? [], lat, lng, radiusKm)
    if (data.length === 0 && radiusKm > 5) {
      const remainingMs = deadline - Date.now()
      if (remainingMs < 2_000) throw new Error('Safe-ground expansion budget exhausted')
      const expanded = await firstAvailableOverpass(
        providers,
        safeGroundQuery(lat, lng, radiusKm, radiusKm),
        remainingMs,
      )
      sources.length = 0
      sources.push({ id: expanded.provider.id, status: 'live', checkedAt })
      data = normalizeSafeGrounds((expanded.payload as any).elements ?? [], lat, lng, radiusKm)
    }
    return json({ data, sources, fetchedAt: checkedAt, radiusKm })
  } catch {
    sources.length = 0
    providers.forEach(provider => sources.push({ id: provider.id, status: 'unavailable', checkedAt, detail: providerFailureDetail }))
  }
  return json({ error: 'Safe-ground feeds are unavailable', sources }, 503)
}

const gfwVesselCache = new BoundedTtlCache<Record<string, unknown>>(500)

function normalizeGfwVessel(mmsi: string, payload: any) {
  const entry = payload?.entries?.[0]
  if (!entry) return { found: false, identity: null }
  const registry = (entry.registryInfo ?? []).find((item: any) => item.latestVesselInfo) ?? entry.registryInfo?.[0]
  const selfReported = [...(entry.selfReportedInfo ?? [])].sort((a: any, b: any) => String(b.transmissionDateTo ?? '').localeCompare(String(a.transmissionDateTo ?? '')))[0]
  const combined = entry.combinedSourcesInfo ?? []
  const unique = (values: unknown[]) => [...new Set(values.map(String).filter(value => value && value !== 'NA'))]
  const vesselTypes = unique(combined.flatMap((item: any) => (item.shiptypes ?? []).map((type: any) => type.name)))
  const gearTypes = unique([...(registry?.geartypes ?? []), ...combined.flatMap((item: any) => (item.geartypes ?? []).map((type: any) => type.name))])
  const lastTransmission = [registry?.transmissionDateTo, ...(entry.selfReportedInfo ?? []).map((item: any) => item.transmissionDateTo)].filter(Boolean).sort().at(-1)
  return { found: true, identity: { mmsi, vesselId: combined[0]?.vesselId ?? selfReported?.id ?? null, shipName: registry?.shipname ?? selfReported?.shipname ?? null, flag: registry?.flag ?? selfReported?.flag ?? null, callSign: registry?.callsign ?? selfReported?.callsign ?? null, imo: registry?.imo && registry.imo !== '0' ? String(registry.imo) : null, vesselTypes, gearTypes, tonnageGt: Number.isFinite(Number(registry?.tonnageGt)) ? Number(registry.tonnageGt) : null, lengthM: Number.isFinite(Number(registry?.lengthM)) ? Number(registry.lengthM) : null, lastTransmission: lastTransmission ?? null } }
}

async function gfwVessel(url: URL) {
  const checkedAt = new Date().toISOString()
  const token = Deno.env.get('GFW_API_TOKEN')
  if (!token) return json({ error: 'Vessel identity enrichment is not configured', sources: [{ id: 'vessel-identity', status: 'unavailable', checkedAt }] }, 503)
  const mmsi = url.searchParams.get('mmsi') ?? ''
  if (!/^\d{9}$/.test(mmsi)) return json({ error: 'A valid 9-digit MMSI is required' }, 400)
  try {
    const cached = gfwVesselCache.get(mmsi)
    let data = cached
    if (!data) {
      const payload = await fetchAuthenticatedJson(`https://gateway.api.globalfishingwatch.org/v3/vessels/search?query=${mmsi}&datasets%5B0%5D=public-global-vessel-identity%3Alatest`, token)
      data = normalizeGfwVessel(mmsi, payload)
      gfwVesselCache.set(mmsi, data, 24 * 60 * 60 * 1000)
    }
    return json({ data, sources: [{ id: 'vessel-identity', status: 'live', checkedAt }], fetchedAt: checkedAt })
  } catch {
    return json({ error: 'Vessel identity enrichment is unavailable', sources: [{ id: 'vessel-identity', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

function parseCsvRow(row: string) {
  // FIRMS regional CSV does not quote fields with commas at present, but this
  // parser keeps quoted descriptions intact if that changes.
  const values: string[] = []
  let value = ''
  let quoted = false
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i]
    if (char === '"') {
      if (quoted && row[i + 1] === '"') { value += '"'; i += 1 } else quoted = !quoted
    } else if (char === ',' && !quoted) { values.push(value); value = '' } else value += char
  }
  values.push(value)
  return values
}

function firmsObservedAt(acquisitionDate: string, acquisitionTime: string) {
  const date = acquisitionDate.trim()
  const time = acquisitionTime.trim().padStart(4, '0')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}$/.test(time)) return null
  const hours = Number(time.slice(0, 2)), minutes = Number(time.slice(2, 4))
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  const timestamp = Date.parse(`${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:00.000Z`)
  if (!Number.isFinite(timestamp)) return null
  const normalized = new Date(timestamp).toISOString()
  return normalized.slice(0, 10) === date && normalized.slice(11, 16).replace(':', '') === time ? normalized : null
}

function heatFeedMetadata(hotspots: Array<Record<string, unknown>>, checkedAt: string) {
  const timestamps = hotspots.flatMap(hotspot => {
    const value = typeof hotspot.observedAt === 'string' ? Date.parse(hotspot.observedAt) : Number.NaN
    return Number.isFinite(value) ? [value] : []
  })
  const latest = timestamps.length ? Math.max(...timestamps) : null
  const earliest = timestamps.length ? Math.min(...timestamps) : null
  return {
    sourceClass: 'official-observation',
    freshness: 'unknown',
    freshnessReason: 'feed-generation-time-not-published',
    evaluatedAt: checkedAt,
    referenceTimestamp: latest === null ? null : new Date(latest).toISOString(),
    ageMinutes: latest === null ? null : Math.max(0, Math.round((Date.parse(checkedAt) - latest) / 60_000)),
    freshnessThresholdMinutes: null,
    observedAt: latest === null ? null : new Date(latest).toISOString(),
    issuedAt: null,
    validity: {
      from: earliest === null ? null : new Date(earliest).toISOString(),
      to: latest === null ? null : new Date(latest).toISOString(),
    },
    datasetVersion: 'satellite-active-fire-c2-regional-24h',
    note: 'This 24-hour layer contains satellite thermal observations, not verified structure-fire incidents. Observation times reflect orbital passes; successful delivery does not prove continuous ground coverage.',
  }
}

async function heat() {
  const feeds = [
    ['suomi-npp-viirs-c2', 'SUOMI_VIIRS_C2_SouthEast_Asia_24h.csv', 'S-NPP'],
    ['noaa-20-viirs-c2', 'J1_VIIRS_C2_SouthEast_Asia_24h.csv', 'NOAA-20'],
    ['noaa-21-viirs-c2', 'J2_VIIRS_C2_SouthEast_Asia_24h.csv', 'NOAA-21'],
  ] as const
  const checkedAt = new Date().toISOString()
  const health: SourceHealth[] = []
  const hotspots: Array<Record<string, unknown>> = []
  const seen = new Set<string>()

  await Promise.all(feeds.map(async ([collection, file, satellite]) => {
    const id = `heat-${satellite.toLowerCase()}`
    try {
      const csv = await fetchText(`https://firms.modaps.eosdis.nasa.gov/data/active_fire/${collection}/csv/${file}`)
      const rows = csv.trim().split(/\r?\n/)
      const columns = parseCsvRow(rows.shift() ?? '').map(column => column.trim())
      const index = (name: string) => columns.indexOf(name)
      const latIndex = index('latitude'), lngIndex = index('longitude')
      if (latIndex < 0 || lngIndex < 0) throw new Error('Missing location columns in FIRMS response')
      for (const row of rows) {
        const cells = parseCsvRow(row)
        const lat = Number(cells[latIndex]), lng = Number(cells[lngIndex])
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) continue
        const date = cells[index('acq_date')]?.trim() ?? ''
        const time = (cells[index('acq_time')]?.trim() ?? '').padStart(4, '0')
        const observedAt = firmsObservedAt(date, time)
        if (!observedAt) continue
        const key = `${satellite}:${lat.toFixed(4)}:${lng.toFixed(4)}:${date}:${time}`
        if (seen.has(key)) continue
        seen.add(key)
        hotspots.push({
          id: `firms-${key}`,
          lat, lng,
          brightness: Number(cells[index('bright_ti4')]) || Number(cells[index('bright_t31')]) || 0,
          confidence: cells[index('confidence')]?.trim() || 'unknown',
          acq_date: date,
          acq_time: time,
          observedAt,
          satellite,
          frp: Number(cells[index('frp')]) || 0,
          daynight: cells[index('daynight')]?.trim() || 'unknown',
        })
      }
      health.push({ id, status: 'live', checkedAt })
    } catch {
      health.push({ id, status: 'unavailable', checkedAt, detail: providerFailureDetail })
    }
  }))
  if (!health.some(source => source.status === 'live')) return json({ error: 'All heat-detection feeds are unavailable', sources: health }, 503)
  health.sort((a, b) => a.id.localeCompare(b.id))
  hotspots.sort((a, b) => String(b.acq_date).localeCompare(String(a.acq_date)) || String(b.acq_time).localeCompare(String(a.acq_time)))
  return json({ data: hotspots, sources: health, fetchedAt: checkedAt, metadata: heatFeedMetadata(hotspots, checkedAt) })
}

async function earthquakes() {
  const checkedAt = new Date().toISOString()
  try {
    const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=' + new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) + '&minmagnitude=4&minlatitude=4.5&maxlatitude=21.5&minlongitude=116&maxlongitude=127.5&orderby=time&limit=200'
    const data = await fetchJson(url)
    return json({ data: data.features ?? [], sources: [{ id: 'earthquake-primary', status: 'live', checkedAt }], fetchedAt: checkedAt })
  } catch {
    return json({ error: 'Earthquake feed is unavailable', sources: [{ id: 'earthquake-primary', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

function gdacsCyclones(data: any) {
  return (data.features ?? []).filter((feature: any) => feature.properties?.eventtype === 'TC' && feature.geometry?.type === 'Point').map((feature: any) => {
    const [lng, lat] = feature.geometry?.coordinates ?? []
    return {
      id: String(feature.properties?.eventid ?? `${lat}-${lng}`),
      name: feature.properties?.name || 'Unnamed tropical cyclone', lat, lng,
      alertlevel: feature.properties?.alertlevel || 'Green',
      alertscore: Number(feature.properties?.alertscore) || 0,
      severity: Number(feature.properties?.severity) || undefined,
      description: feature.properties?.description || 'No event description was supplied.',
      windKph: feature.properties?.windspeed ? Math.round(Number(feature.properties.windspeed) * 1.852) : undefined,
      source: 'Live hazard feed',
      updated: feature.properties?.fromdate ?? feature.properties?.todate,
      ended: feature.properties?.todate,
      countries: feature.properties?.country || undefined,
    }
  }).filter((event: any) => Number.isFinite(event.lat) && Number.isFinite(event.lng) && isInsideOrNearPar(event.lat, event.lng, 10))
}

const PAR_BOUNDARY: [number, number][] = [[25, 120], [25, 135], [5, 135], [5, 115], [15, 115], [21, 120], [25, 120]]

function pointInPolygon(lat: number, lng: number, polygon: [number, number][]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [latI, lngI] = polygon[i], [latJ, lngJ] = polygon[j]
    const crosses = ((latI > lat) !== (latJ > lat)) && (lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI || Number.EPSILON) + lngI)
    if (crosses) inside = !inside
  }
  return inside
}

function distanceToSegmentKm(lat: number, lng: number, start: [number, number], end: [number, number]) {
  const referenceLat = ((lat + start[0] + end[0]) / 3) * Math.PI / 180
  const scaleX = 111.32 * Math.cos(referenceLat)
  const px = lng * scaleX, py = lat * 111.32
  const ax = start[1] * scaleX, ay = start[0] * 111.32
  const bx = end[1] * scaleX, by = end[0] * 111.32
  const dx = bx - ax, dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function distanceToParKm(lat: number, lng: number) {
  if (pointInPolygon(lat, lng, PAR_BOUNDARY)) return 0
  return Math.min(...PAR_BOUNDARY.slice(0, -1).map((point, index) => distanceToSegmentKm(lat, lng, point, PAR_BOUNDARY[index + 1])))
}

function isInsideOrNearPar(lat: number, lng: number, bufferKm: number) {
  return distanceToParKm(lat, lng) <= bufferKm
}

function gdacsTrack(geometry: any, forecast: boolean, center: [number, number]) {
  const segments = (geometry.features ?? [])
    .filter((feature: any) => feature.geometry?.type === 'LineString' && feature.properties?.forecast === forecast)
    .map((feature: any) => ({ intensity: String(feature.properties?.polygonlabel ?? 'Unknown'), coordinates: (feature.geometry.coordinates ?? []).filter(([lng, lat]: [number, number]) => Number.isFinite(lat) && Number.isFinite(lng)) as [number, number][] }))
    .filter((segment: { coordinates: [number, number][] }) => segment.coordinates.length > 1)
  if (!segments.length) return { track: [], points: [] }
  const distanceSquared = (point: [number, number]) => (point[0] - center[0]) ** 2 + (point[1] - center[1]) ** 2
  const samePoint = (first: [number, number], second: [number, number]) => Math.abs(first[0] - second[0]) < 1e-6 && Math.abs(first[1] - second[1]) < 1e-6
  let startIndex = 0, reverseStart = false, nearest = Number.POSITIVE_INFINITY
  segments.forEach((segment: { coordinates: [number, number][] }, index: number) => {
    const firstDistance = distanceSquared(segment.coordinates[0]), lastDistance = distanceSquared(segment.coordinates[segment.coordinates.length - 1])
    if (firstDistance < nearest) { nearest = firstDistance; startIndex = index; reverseStart = false }
    if (lastDistance < nearest) { nearest = lastDistance; startIndex = index; reverseStart = true }
  })
  const remaining = [...segments]
  const first = remaining.splice(startIndex, 1)[0]
  const firstCoordinates = reverseStart ? [...first.coordinates].reverse() : first.coordinates
  let ordered = firstCoordinates.map(([lng, lat]: [number, number]) => ({ lat, lng, intensity: first.intensity }))
  while (remaining.length) {
    const last = ordered[ordered.length - 1]
    const lastCoordinate: [number, number] = [last.lng, last.lat]
    const matchIndex = remaining.findIndex(segment => samePoint(segment.coordinates[0], lastCoordinate) || samePoint(segment.coordinates[segment.coordinates.length - 1], lastCoordinate))
    if (matchIndex < 0) break
    const segment = remaining.splice(matchIndex, 1)[0]
    const coordinates = samePoint(segment.coordinates[0], lastCoordinate) ? segment.coordinates : [...segment.coordinates].reverse()
    ordered.push(...coordinates.slice(1).map(([lng, lat]: [number, number]) => ({ lat, lng, intensity: segment.intensity })))
  }
  if (!forecast) ordered = ordered.reverse()
  return { track: ordered.map(point => [point.lat, point.lng] as [number, number]), points: ordered }
}

const PAGASA_FLOOD_PAGE = 'https://www.pagasa.dost.gov.ph/flood'
const PAGASA_STORM_SURGE_PAGE = 'https://www.pagasa.dost.gov.ph/tropical-cyclone/forecast-storm-surge'
const PAGASA_DAM_MAP_SERVICE = 'https://portal.georisk.gov.ph/arcgis/rest/services/PAGASA/PAGASA/MapServer'
const officialPageCache = new BoundedTtlCache<string>(4)

function decodeHtml(value: string) {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', ndash: '–', mdash: '—', deg: '°',
  }
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number(code))))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(code, 16))))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match)
}

function plainText(value: string, limit = 500) {
  return decodeHtml(value.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function slug(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'unknown'
}

function pageVersion(html: string, prefix: string) {
  const timestamp = html.match(/server_timestamp\s*=\s*(\d{9,13})/i)?.[1]
  return `${prefix}:${timestamp ?? slug(plainText(html.match(/<h5\b[^>]*>([\s\S]*?)<\/h5>/i)?.[1] ?? 'unversioned', 80))}`
}

function officialMetadata(
  sourceClass: 'official-observation' | 'official-advisory' | 'contextual-event' | 'public-geocoder',
  datasetVersion: string,
  options: {
    observedAt?: string | null
    issuedAt?: string | null
    validFrom?: string | null
    validTo?: string | null
    note?: string
    evaluatedAt?: string
    maxAgeMs?: number
  } = {},
) {
  const official = sourceClass === 'official-observation' || sourceClass === 'official-advisory'
  const freshness = official
    ? assessOfficialHazardFreshness({
        observedAt: options.observedAt ?? null,
        issuedAt: options.issuedAt ?? null,
        validTo: options.validTo ?? null,
        maxAgeMs: options.maxAgeMs,
        evaluatedAt: options.evaluatedAt,
      })
    : { freshness: 'live' as const, freshnessReason: 'request-response-current' }
  return {
    sourceClass,
    ...freshness,
    observedAt: options.observedAt ?? null,
    issuedAt: options.issuedAt ?? null,
    validity: { from: options.validFrom ?? null, to: options.validTo ?? null },
    datasetVersion,
    ...(options.note ? { note: options.note } : {}),
  }
}

function officialSourceHealth(id: string, checkedAt: string, freshness: string): SourceHealth {
  if (freshness === 'live') return { id, status: 'live', checkedAt }
  if (freshness === 'stale') {
    return { id, status: 'stale', checkedAt, detail: 'The official observation or advisory timestamp is older than its expected publication cadence' }
  }
  return { id, status: 'unknown', checkedAt, detail: 'The official source did not publish a usable observation or advisory timestamp' }
}

function latestIsoTimestamp(values: unknown[]) {
  const timestamps = values.flatMap(value => {
    if (typeof value !== 'string') return []
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? [parsed] : []
  })
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null
}

async function officialPage(url: string) {
  const cached = officialPageCache.get(url)
  if (cached) return cached
  const html = await fetchText(url)
  if (!/<html\b/i.test(html) || html.length < 5_000) throw new Error('Official page returned incomplete HTML')
  officialPageCache.set(url, html, 10 * 60_000)
  return html
}

function officialPagasaDocumentUrl(rawValue: string | undefined) {
  if (!rawValue) return null
  try {
    const url = new URL(decodeHtml(rawValue), PAGASA_FLOOD_PAGE)
    if (url.protocol !== 'https:' || !['pagasa.dost.gov.ph', 'www.pagasa.dost.gov.ph', 'pubfiles.pagasa.dost.gov.ph'].includes(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

function advisorySeverity(status: string) {
  const normalized = status.toLowerCase()
  if (normalized.includes('critical')) return 'critical'
  if (normalized.includes('warning')) return 'warning'
  if (normalized.includes('advisory')) return 'advisory'
  if (normalized.includes('outlook')) return 'outlook'
  if (normalized.includes('non-flood') || normalized.includes('normal')) return 'normal'
  return 'unknown'
}

function parseFloodAdvisories(html: string) {
  const advisories = new Map<string, Record<string, unknown>>()
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1])
    if (cells.length < 2) continue
    const area = plainText(cells[0], 160)
    const status = plainText(cells[1], 120)
    if (!area || !/(?:flood|watch|outlook|advisory|warning|critical)/i.test(status)) continue
    const href = cells[1].match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1]
    const id = `pagasa-flood-${slug(area)}`
    advisories.set(id, {
      id,
      area,
      status,
      severity: advisorySeverity(status),
      bulletinUrl: officialPagasaDocumentUrl(href),
      issuedAt: null,
      validUntil: null,
      geometry: null,
    })
  }
  return [...advisories.values()].slice(0, 80)
}

async function floodAdvisories() {
  const checkedAt = new Date().toISOString()
  try {
    const html = await officialPage(PAGASA_FLOOD_PAGE)
    const data = parseFloodAdvisories(html)
    if (data.length < 4) throw new Error('Official flood advisory table could not be parsed')
    const issuedAt = latestIsoTimestamp(data.map(item => item.issuedAt))
    const metadata = officialMetadata('official-advisory', pageVersion(html, 'pagasa-flood'), {
      issuedAt,
      evaluatedAt: checkedAt,
      maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.floodAdvisory,
      note: 'Official basin advisory states. Geometry is not supplied by this feed; no flood extent is inferred.',
    })
    return json({
      data,
      sources: [officialSourceHealth('pagasa-flood-advisories', checkedAt, metadata.freshness)],
      fetchedAt: checkedAt,
      metadata,
    })
  } catch {
    return json({ error: 'Official flood advisories are unavailable', sources: [{ id: 'pagasa-flood-advisories', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

function parsePageObservedAt(html: string) {
  const raw = plainText(html.match(/Dam Water Level Update[\s\S]{0,600}?<h5\b[^>]*>([\s\S]*?)<\/h5>/i)?.[1] ?? '', 80)
  if (!raw) return null
  const parsed = Date.parse(`${raw} GMT+0800`)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function nullableNumber(value: string | undefined) {
  const normalized = plainText(value ?? '', 40).replace(/,/g, '')
  if (!normalized || normalized === '-' || normalized.toLowerCase() === 'n/a') return null
  const result = Number(normalized)
  return Number.isFinite(result) ? result : null
}

type ParsedDamStatus = {
  id: string
  name: string
  lat: number | null
  lng: number | null
  observedAt: string | null
  reservoirWaterLevelM: number | null
  changeM: number | null
  normalHighWaterLevelM: number | null
  deviationFromNormalM: number | null
  ruleCurveElevationM: number | null
  deviationFromRuleCurveM: number | null
  gateOpeningCount: number | null
  gateOpeningM: number | null
  inflowCms: number | null
  outflowCms: number | null
  locationFreshness: 'official-live' | 'official-cached' | 'unavailable'
}

function parseDamStatuses(html: string): ParsedDamStatus[] {
  const observedAt = parsePageObservedAt(html)
  const rows: ParsedDamStatus[] = []
  const pattern = /<tr\b[^>]*>\s*<td\b[^>]*current-dam[^>]*>([\s\S]*?)<\/td>([\s\S]*?)<\/tr>\s*<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  for (const match of html.matchAll(pattern)) {
    const name = plainText(match[1], 100)
    const cells = [...match[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1])
    if (!name || cells.length < 12) continue
    rows.push({
      id: `pagasa-dam-${slug(name)}`,
      name: name.replace(/\s+Dam$/i, ''),
      lat: null,
      lng: null,
      observedAt,
      reservoirWaterLevelM: nullableNumber(cells[1]),
      changeM: nullableNumber(cells[3]),
      normalHighWaterLevelM: nullableNumber(cells[4]),
      deviationFromNormalM: nullableNumber(cells[5]),
      ruleCurveElevationM: nullableNumber(cells[6]),
      deviationFromRuleCurveM: nullableNumber(cells[7]),
      gateOpeningCount: nullableNumber(cells[8]),
      gateOpeningM: nullableNumber(cells[9]),
      inflowCms: nullableNumber(cells[10]),
      outflowCms: nullableNumber(cells[11]),
      locationFreshness: 'unavailable',
    })
  }
  return rows.slice(0, 30)
}

type OfficialDamLocation = { labels: string; lat: number; lng: number }

async function officialDamLocations(): Promise<OfficialDamLocation[]> {
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => fetchJson(
    `${PAGASA_DAM_MAP_SERVICE}/${index + 1}/query?where=1%3D1&outFields=site%2Clatitude%2Clongitude&returnGeometry=true&outSR=4326&resultRecordCount=100&f=geojson`,
  )))
  return results.flatMap(result => {
    if (result.status !== 'fulfilled') return []
    return (result.value?.features ?? []).flatMap((feature: any) => {
      if (feature?.geometry?.type !== 'Point') return []
      const [lng, lat] = feature.geometry.coordinates ?? []
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) return []
      const labels = Object.values(feature.properties ?? {}).filter(value => typeof value === 'string').join(' ').toLowerCase()
      return [{ labels, lat, lng }]
    })
  }).slice(0, 100)
}

function damMatchKey(value: string) {
  return value.toLowerCase().replace(/\b(?:dam|reservoir)\b/g, '').replace(/[^a-z0-9]/g, '')
}

function attachOfficialDamLocations(
  dams: ParsedDamStatus[],
  locations: OfficialDamLocation[],
  locationFreshness: ParsedDamStatus['locationFreshness'],
) {
  return dams.map(dam => {
    const key = damMatchKey(dam.name)
    const location = locations.find(candidate => {
      const labels = damMatchKey(candidate.labels)
      return key.length >= 3 && labels.length >= 3 && (labels.includes(key) || key.includes(labels))
    })
    return location ? { ...dam, lat: location.lat, lng: location.lng, locationFreshness } : dam
  })
}

function officialDamLocationBaseline(): OfficialDamLocation[] {
  return OFFICIAL_DAM_LOCATION_BASELINE.map(location => ({
    labels: location.name.toLowerCase(),
    lat: location.lat,
    lng: location.lng,
  }))
}

async function dams() {
  const checkedAt = new Date().toISOString()
  try {
    const html = await officialPage(PAGASA_FLOOD_PAGE)
    const parsed = parseDamStatuses(html)
    if (parsed.length < 5) throw new Error('Official dam table could not be parsed')
    let data = attachOfficialDamLocations(parsed, officialDamLocationBaseline(), 'official-cached')
    const observedAt = parsed.map(item => item.observedAt).find(Boolean) ?? null
    const metadata = officialMetadata('official-observation', pageVersion(html, 'pagasa-dams'), {
      observedAt,
      evaluatedAt: checkedAt,
      maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.damObservation,
      note: 'PAGASA publishes this table on its own reporting cadence. Missing values remain missing.',
    })
    const sources: SourceHealth[] = [officialSourceHealth('pagasa-dam-observations', checkedAt, metadata.freshness)]
    try {
      const locations = await officialDamLocations()
      if (!locations.length) throw new Error('No official dam locations were returned')
      data = attachOfficialDamLocations(data, locations, 'official-live')
      const liveMatches = data.filter(dam => dam.locationFreshness === 'official-live').length
      if (!liveMatches) throw new Error('Official dam locations did not match the current observation table')
      sources.push({
        id: 'pagasa-dam-locations',
        status: liveMatches >= OFFICIAL_DAM_LOCATION_BASELINE.length ? 'live' : 'stale',
        checkedAt,
        detail: `${liveMatches} of ${data.length} current observations matched official map positions`,
      })
    } catch {
      sources.push({
        id: 'pagasa-dam-locations',
        status: 'stale',
        checkedAt,
        detail: `Using ${OFFICIAL_DAM_LOCATION_BASELINE.length} last-verified official positions captured ${OFFICIAL_DAM_LOCATION_BASELINE_CAPTURED_AT}`,
      })
    }
    return json({
      data,
      sources,
      fetchedAt: checkedAt,
      metadata,
    })
  } catch {
    return json({ error: 'Official dam observations are unavailable', sources: [{ id: 'pagasa-dam-observations', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

async function damReleaseAdvisories() {
  const checkedAt = new Date().toISOString()
  try {
    const html = await officialPage(PAGASA_FLOOD_PAGE)
    const statuses = parseDamStatuses(html)
    if (statuses.length < 5) throw new Error('Official dam table could not be parsed')
    const data = statuses.map(dam => {
      const dischargeObserved = (dam.gateOpeningCount ?? 0) > 0 || (dam.gateOpeningM ?? 0) > 0 || (dam.outflowCms ?? 0) > 0
      return {
        id: `pagasa-release-${slug(dam.name)}`,
        damName: dam.name,
        noticeStatus: dischargeObserved ? 'discharge-observed-at-source-time' : 'no-schedule-published-in-checked-source',
        scheduledAt: null,
        observedAt: dam.observedAt,
        gateOpeningCount: dam.gateOpeningCount,
        gateOpeningM: dam.gateOpeningM,
        outflowCms: dam.outflowCms,
        message: dischargeObserved
          ? 'The official status reports gate or outflow values at the stated observation time. KALASAG does not infer a future release time.'
          : 'No release schedule was published in the checked official source. This does not guarantee that no separate operational notice exists.',
      }
    })
    const observedAt = statuses.map(item => item.observedAt).find(Boolean) ?? null
    const metadata = officialMetadata('official-observation', pageVersion(html, 'pagasa-dam-releases'), {
      observedAt,
      evaluatedAt: checkedAt,
      maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.damReleaseObservation,
      note: 'This is observed gate/outflow status, not a release forecast. Scheduled times are returned only when explicitly published; no time is estimated from water level.',
    })
    return json({
      data,
      sources: [officialSourceHealth('pagasa-dam-release-status', checkedAt, metadata.freshness)],
      fetchedAt: checkedAt,
      metadata,
    })
  } catch {
    return json({ error: 'Official dam release status is unavailable', sources: [{ id: 'pagasa-dam-release-status', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

function parseStormSurgeAdvisories(html: string) {
  const header = html.search(/<div\b[^>]*tropical-cyclone-weather-bulletin-page/i)
  const section = header >= 0 ? html.slice(header, Math.min(html.length, header + 40_000)) : ''
  if (/No Storm Surge within the Philippine Area of Responsibility/i.test(section)) return []

  const documents = new Map<string, { title: string; url: string }>()
  for (const match of section.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = officialPagasaDocumentUrl(match[1])
    if (!url || !/(?:storm|surge|\.pdf$|\.png$|\.jpe?g$)/i.test(url)) continue
    const title = plainText(match[2], 160) || decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? 'Storm surge advisory')
    documents.set(url, { title, url })
  }
  for (const match of section.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
    const url = officialPagasaDocumentUrl(match[1])
    if (!url || !/(?:storm|surge|\.png$|\.jpe?g$)/i.test(url)) continue
    documents.set(url, { title: decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? 'Storm surge advisory'), url })
  }
  return [...documents.values()].slice(0, 20).map((document, index) => ({
    id: `pagasa-storm-surge-${index}-${slug(document.title)}`,
    title: document.title,
    summary: 'Official forecast storm-surge product. Open the published product for the complete affected-area statement.',
    advisoryUrl: document.url,
    issuedAt: null,
    validUntil: null,
    geometry: null,
  }))
}

async function stormSurgeAdvisories() {
  const checkedAt = new Date().toISOString()
  try {
    const html = await officialPage(PAGASA_STORM_SURGE_PAGE)
    const data = parseStormSurgeAdvisories(html)
    const noActive = /No Storm Surge within the Philippine Area of Responsibility/i.test(html)
    if (!noActive && data.length === 0) throw new Error('Official storm surge page could not be parsed')
    const issuedAt = latestIsoTimestamp(data.map(item => item.issuedAt))
    const metadata = officialMetadata('official-advisory', pageVersion(html, 'pagasa-storm-surge'), {
      issuedAt,
      evaluatedAt: checkedAt,
      maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.stormSurgeAdvisory,
      note: noActive
        ? 'The checked official page reports no active storm-surge forecast within PAR, but the page does not publish a machine-readable issue time for that status.'
        : 'The official product does not provide machine-readable geometry; KALASAG does not invent an affected area.',
    })
    return json({
      data,
      sources: [officialSourceHealth('pagasa-storm-surge', checkedAt, metadata.freshness)],
      fetchedAt: checkedAt,
      metadata,
    })
  } catch {
    return json({ error: 'Official storm-surge advisories are unavailable', sources: [{ id: 'pagasa-storm-surge', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

async function reverseGeocode(url: URL) {
  const checkedAt = new Date().toISOString()
  const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) return json({ error: 'A valid Philippine location is required' }, 400)
  try {
    const endpoint = new URL('https://photon.komoot.io/reverse')
    endpoint.searchParams.set('lat', lat.toFixed(6))
    endpoint.searchParams.set('lon', lng.toFixed(6))
    endpoint.searchParams.set('lang', 'en')
    const payload = await fetchJson(endpoint.toString())
    const feature = Array.isArray(payload?.features) ? payload.features[0] : null
    const properties = feature?.properties ?? {}
    const coordinates = feature?.geometry?.coordinates ?? [lng, lat]
    const resolvedLng = Number(coordinates[0]), resolvedLat = Number(coordinates[1])
    if (!Number.isFinite(resolvedLat) || !Number.isFinite(resolvedLng)) throw new Error('Reverse geocoder did not return a valid location')
    const street = [properties.housenumber, properties.street].filter(Boolean).join(' ') || null
    const locality = properties.city || properties.town || properties.village || properties.district || properties.county || null
    const parts = [properties.name, street, locality, properties.state, properties.country].filter(Boolean)
    const data = {
      displayName: [...new Set(parts.map(String))].join(', ') || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      street,
      locality,
      region: properties.state || null,
      postalCode: properties.postcode || null,
      country: properties.country || null,
      lat: resolvedLat,
      lng: resolvedLng,
    }
    return json({ data, sources: [{ id: 'public-reverse-geocoder', status: 'live', checkedAt }], fetchedAt: checkedAt, metadata: officialMetadata('public-geocoder', `photon:${lat.toFixed(4)}:${lng.toFixed(4)}`) })
  } catch {
    return json({ error: 'Reverse geocoding is unavailable', sources: [{ id: 'public-reverse-geocoder', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

async function storms() {
  const checkedAt = new Date().toISOString()
  try {
    const data = await fetchJson('https://www.gdacs.org/xml/gdacs.geojson')
    const cyclones = await Promise.all(gdacsCyclones(data).map(async (cyclone: any) => {
      try {
        const geometry = await fetchJson(`https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventid=${encodeURIComponent(cyclone.id)}&eventtype=TC`)
        const center: [number, number] = [cyclone.lng, cyclone.lat]
        const observed = gdacsTrack(geometry, false, center)
        const forecast = gdacsTrack(geometry, true, center)
        return { ...cyclone, distanceToParKm: Math.round(distanceToParKm(cyclone.lat, cyclone.lng) * 10) / 10, observedTrack: observed.track, forecastTrack: forecast.track, observedPoints: observed.points, forecastPoints: forecast.points }
      } catch {
        return cyclone
      }
    }))
    return json({ data: cyclones, sources: [{ id: 'storm-primary', status: 'live', checkedAt }], fetchedAt: checkedAt })
  } catch {
    return json({ error: 'Tropical-cyclone feed is unavailable', sources: [{ id: 'storm-primary', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

async function floods() {
  const checkedAt = new Date().toISOString()
  const sources: SourceHealth[] = []
  const events: Array<Record<string, unknown>> = []
  try {
    const eonet = await fetchJson('https://eonet.gsfc.nasa.gov/api/v3/events?category=floods&status=open&limit=100')
    for (const event of eonet.events ?? []) {
      const geometry = event.geometry?.[event.geometry.length - 1]
      const [lng, lat] = geometry?.coordinates ?? []
      if (Number.isFinite(lat) && Number.isFinite(lng) && inPhilippines(lat, lng)) events.push({
        id: `flood-a-${event.id}`,
        name: event.title || 'Reported flood event',
        lat,
        lng,
        severity: 'Unknown',
        alertlevel: 'Green',
        description: event.description || 'Reported flood event location. This point is not an inundation boundary.',
        source: 'Contextual event feed',
        sourceClass: 'contextual-event',
        observedAt: geometry?.date ?? null,
      })
    }
    sources.push({ id: 'flood-primary', status: 'live', checkedAt })
  } catch { sources.push({ id: 'flood-primary', status: 'unavailable', checkedAt, detail: providerFailureDetail }) }
  try {
    const gdacs = await fetchJson('https://www.gdacs.org/xml/gdacs.geojson')
    for (const feature of gdacs.features ?? []) {
      if (feature.properties?.eventtype !== 'FL') continue
      const [lng, lat] = feature.geometry?.coordinates ?? []
      if (Number.isFinite(lat) && Number.isFinite(lng) && inPhilippines(lat, lng)) events.push({
        id: `flood-b-${feature.properties?.eventid ?? `${lat}-${lng}`}`,
        name: feature.properties?.name || 'Reported flood event',
        lat,
        lng,
        severity: feature.properties?.severitydata?.severitytext || 'Unknown',
        alertlevel: feature.properties?.alertlevel || 'Green',
        description: feature.properties?.description || 'Reported flood event location. This point is not an inundation boundary.',
        source: 'Contextual event feed',
        sourceClass: 'contextual-event',
        observedAt: feature.properties?.fromdate ?? null,
      })
    }
    sources.push({ id: 'flood-secondary', status: 'live', checkedAt })
  } catch { sources.push({ id: 'flood-secondary', status: 'unavailable', checkedAt, detail: providerFailureDetail }) }
  if (!sources.some(source => source.status === 'live')) return json({ error: 'Flood feeds are unavailable', sources }, 503)
  const observedAt = latestIsoTimestamp(events.map(event => event.observedAt))
  return json({
    data: events.slice(0, 100),
    sources,
    fetchedAt: checkedAt,
    metadata: officialMetadata('contextual-event', `reported-flood-events:${checkedAt.slice(0, 16)}`, {
      observedAt,
      note: 'These are reported event points only. They are not flood depths, susceptibility polygons, or current inundation extents.',
    }),
  })
}

type FlightRoute = {
  departurePort: string
  destinationPort: string
  origin: string
  destination: string
  waypoints: [number, number][]
}

const routeCache = new BoundedTtlCache<FlightRoute | null>(1_000)

async function flightRoute(callsign: string): Promise<FlightRoute | null> {
  const normalized = callsign.trim().toUpperCase()
  if (!/^[A-Z]{2,3}\d[A-Z0-9]*$/.test(normalized)) return null
  const cached = routeCache.get(normalized)
  if (cached !== undefined) return cached
  try {
    let value: FlightRoute | null = null
    try {
      const staticRoute = await fetchJson(`https://vrs-standing-data.adsb.lol/routes/${normalized.slice(0, 2)}/${encodeURIComponent(normalized)}.json`)
      const airports = Array.isArray(staticRoute?._airports) ? staticRoute._airports : []
      if (airports.length >= 2 && airports.every((airport: any) => Number.isFinite(Number(airport.lat)) && Number.isFinite(Number(airport.lon)))) {
        const origin = airports[0], destination = airports[airports.length - 1]
        value = { departurePort: origin.name || origin.location || origin.iata || origin.icao, destinationPort: destination.name || destination.location || destination.iata || destination.icao, origin: origin.iata || origin.icao || '', destination: destination.iata || destination.icao || '', waypoints: airports.map((airport: any) => [Number(airport.lat), Number(airport.lon)] as [number, number]) }
      }
    } catch { /* ADSBDB is the fallback when the static community route is absent. */ }
    if (!value) {
      const payload = await fetchJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(normalized)}`)
      const route = payload?.response?.flightroute
      const airports = [route?.origin, route?.midpoint, route?.destination].filter(Boolean)
      if (!route?.origin || !route?.destination || airports.some((airport: any) => !Number.isFinite(Number(airport.latitude)) || !Number.isFinite(Number(airport.longitude)))) throw new Error('Route response did not include valid airports')
      value = { departurePort: route.origin.name || route.origin.municipality || route.origin.iata_code || route.origin.icao_code, destinationPort: route.destination.name || route.destination.municipality || route.destination.iata_code || route.destination.icao_code, origin: route.origin.iata_code || route.origin.icao_code || '', destination: route.destination.iata_code || route.destination.icao_code || '', waypoints: airports.map((airport: any) => [Number(airport.latitude), Number(airport.longitude)] as [number, number]) }
    }
    routeCache.set(normalized, value, 12 * 60 * 60 * 1000)
    return value
  } catch {
    routeCache.set(normalized, null, 20 * 60 * 1000)
    return null
  }
}

async function enrichFlightRoutes(aircraft: Array<Record<string, unknown>>) {
  const routes = new Map<string, FlightRoute | null>()
  const callsigns = [...new Set(aircraft.map(item => String(item.flight ?? '').trim().toUpperCase()).filter(Boolean))].slice(0, 80)
  for (let index = 0; index < callsigns.length; index += 8) {
    const batch = callsigns.slice(index, index + 8)
    const resolved = await Promise.all(batch.map(async callsign => [callsign, await flightRoute(callsign)] as const))
    resolved.forEach(([callsign, route]) => routes.set(callsign, route))
  }
  return aircraft.map(item => {
    const callsign = String(item.flight ?? '').trim().toUpperCase()
    const route = routes.get(callsign)
    return route ? { ...item, route } : item
  })
}

async function flights() {
  const checkedAt = new Date().toISOString()
  const regions = [
    { id: 'aircraft-region-north', lat: 15, lng: 121 },
    { id: 'aircraft-region-south', lat: 8, lng: 124 },
  ] as const
  const aircraft = new Map<string, unknown>()

  const results = await Promise.allSettled(regions.map(region =>
    fetchJson(`https://api.airplanes.live/v2/point/${region.lat}/${region.lng}/250`)
  ))
  const sources: SourceHealth[] = results.map((result, index) => ({
    id: regions[index].id,
    status: result.status === 'fulfilled' ? 'live' : 'unavailable',
    checkedAt,
    ...(result.status === 'rejected' ? { detail: providerFailureDetail } : {}),
  }))

  results.forEach(result => {
    if (result.status !== 'fulfilled') return
    for (const item of result.value.ac ?? []) {
      if (item.hex) aircraft.set(String(item.hex).toLowerCase(), item)
    }
  })

  if (!sources.some(source => source.status === 'live')) {
    return json({ error: 'Aircraft feed is unavailable', sources }, 503)
  }

  const rawAircraft = [...aircraft.values()] as Array<Record<string, unknown>>
  let data = rawAircraft
  const routeSource: SourceHealth = { id: 'aircraft-routes', status: 'live', checkedAt }
  try {
    data = await enrichFlightRoutes(rawAircraft)
  } catch {
    routeSource.status = 'unavailable'
    routeSource.detail = providerFailureDetail
  }
  return json({ data, sources: [...sources, routeSource], fetchedAt: checkedAt })
}

async function traffic(url: URL) {
  const checkedAt = new Date().toISOString()
  const key = Deno.env.get('TOMTOM_API_KEY')
  if (!key) return json({ error: 'Traffic feed is not configured', sources: [{ id: 'traffic-primary', status: 'unavailable', checkedAt, detail: 'Server credential is not configured' }] }, 503)
  const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) return json({ error: 'A valid Philippine location is required' }, 400)
  const radiusKm = Math.max(1, Math.min(20, Number(url.searchParams.get('radiusKm')) || 20))
  const latDelta = radiusKm / 111.32
  const lngDelta = radiusKm / (111.32 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))
  const minLat = lat - latDelta, maxLat = lat + latDelta, minLng = lng - lngDelta, maxLng = lng + lngDelta
  try {
    const endpoint = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${encodeURIComponent(key)}&bbox=${minLng},${minLat},${maxLng},${maxLat}&fields={incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,delay}}}`
    const data = await fetchJson(endpoint)
    return json({ data: data.incidents ?? [], sources: [{ id: 'traffic-primary', status: 'live', checkedAt }], fetchedAt: checkedAt })
  } catch {
    return json({ error: 'Traffic feed is unavailable', sources: [{ id: 'traffic-primary', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

async function trafficTile(url: URL) {
  const key = Deno.env.get('TOMTOM_API_KEY')
  if (!key) return json({ error: 'Traffic flow tiles are not configured' }, 503)
  const zoom = Number(url.searchParams.get('z')), x = Number(url.searchParams.get('x')), y = Number(url.searchParams.get('y'))
  const tileRange = Number.isInteger(zoom) && zoom >= 0 && zoom <= 22 ? 2 ** zoom : 0
  if (!tileRange || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tileRange || y >= tileRange) return json({ error: 'Invalid traffic tile coordinates' }, 400)
  const style = url.searchParams.get('style') === 'relative0' ? 'relative0' : 'relative0-dark'
  const cacheKey = `${style}:${zoom}:${x}:${y}`
  const cached = trafficTileCache.get(cacheKey)
  if (cached?.freshUntil && cached.freshUntil > Date.now()) return trafficTileResponse(cached, 'cached')

  let pending = trafficTileRequests.get(cacheKey)
  if (!pending) {
    const providerRate = rateLimiter.consume('provider:tomtom:traffic-tiles', 300, 60_000)
    if (!providerRate.allowed) {
      if (cached) return trafficTileResponse(cached, 'stale')
      const response = json({ error: 'Traffic flow is refreshing' }, 429)
      response.headers.set('retry-after', String(providerRate.retryAfterSeconds))
      return response
    }
    pending = (async () => {
      const upstream = await fetch(`https://api.tomtom.com/traffic/map/4/tile/flow/${style}/${zoom}/${x}/${y}.png?key=${encodeURIComponent(key)}&tileSize=256`, { signal: AbortSignal.timeout(12_000) })
      if (!upstream.ok) throw new Error(`TomTom traffic tile returned HTTP ${upstream.status}`)
      const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.startsWith('image/')) throw new Error('TomTom traffic tile returned an invalid content type')
      const declaredLength = Number(upstream.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_TILE_BYTES) throw new Error('Traffic tile exceeded the size limit')
      const bytes = new Uint8Array(await upstream.arrayBuffer())
      if (bytes.byteLength > MAX_TILE_BYTES) throw new Error('Traffic tile exceeded the size limit')
      const tile = { bytes, contentType, freshUntil: Date.now() + TRAFFIC_TILE_FRESH_MS }
      trafficTileCache.set(cacheKey, tile, TRAFFIC_TILE_STALE_MS)
      return tile
    })().finally(() => trafficTileRequests.delete(cacheKey))
    trafficTileRequests.set(cacheKey, pending)
  }
  try {
    return trafficTileResponse(await pending, 'live')
  } catch {
    if (cached) return trafficTileResponse(cached, 'stale')
    return json({ error: 'Traffic flow tile is unavailable' }, 503)
  }
}

async function weather(url: URL) {
  const checkedAt = new Date().toISOString()
  const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) return json({ error: 'A valid Philippine location is required' }, 400)
  try {
    const endpoint = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,surface_pressure,uv_index&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset&timezone=Asia%2FManila&forecast_days=7`
    const data = await fetchJson(endpoint)
    return json({ data, sources: [{ id: 'weather-primary', status: 'live', checkedAt }], fetchedAt: checkedAt })
  } catch {
    return json({ error: 'Weather feed is unavailable', sources: [{ id: 'weather-primary', status: 'unavailable', checkedAt, detail: providerFailureDetail }] }, 503)
  }
}

const allowedOrigins = new Set([
  'https://localhost',
  'capacitor://localhost',
  ...(Deno.env.get('LIVE_DATA_ALLOWED_ORIGINS') ?? '').split(','),
].map(value => value.trim().replace(/\/$/, '')).filter(Boolean))
const rateLimiter = new InstanceRateLimiter(4_096)
const supportedResources = new Set([
  'dam-release-advisories', 'dams', 'earthquakes', 'flights', 'flood-advisories',
  'floods', 'gfw-vessel', 'heat', 'reverse-geocode', 'safe-grounds',
  'storm-surge-advisories', 'storms', 'traffic', 'traffic-tile', 'weather',
])
const assetResources = new Set(['traffic-tile'])

function originAllowed(origin: string | null) {
  return !origin || allowedOrigins.has(origin.replace(/\/$/, ''))
}

function withCors(response: Response, origin: string | null) {
  if (!origin) return response
  const responseHeaders = new Headers(response.headers)
  responseHeaders.set('access-control-allow-origin', origin)
  responseHeaders.set('access-control-allow-methods', 'GET, OPTIONS')
  responseHeaders.set('access-control-allow-headers', 'authorization, x-client-info, apikey, content-type')
  responseHeaders.set('access-control-expose-headers', 'retry-after, x-kalasag-cache-state, x-kalasag-source-checked-at')
  responseHeaders.set('vary', 'Origin')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders })
}

function clientIdentity(request: Request) {
  const candidate = request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-real-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]
    ?? 'unknown'
  const normalized = candidate.trim()
  return /^[0-9a-f:.]{3,64}$/i.test(normalized) ? normalized : 'unknown'
}

function ratePolicy(resource: string) {
  if (resource === 'safe-grounds') return { limit: 6, windowMs: 60_000 }
  if (resource === 'traffic' || resource === 'gfw-vessel') return { limit: 30, windowMs: 60_000 }
  if (resource === 'storms' || resource === 'flights' || resource === 'heat') return { limit: 20, windowMs: 60_000 }
  if (resource === 'reverse-geocode') return { limit: 30, windowMs: 60_000 }
  if (resource === 'dams' || resource === 'dam-release-advisories' || resource === 'flood-advisories' || resource === 'storm-surge-advisories') return { limit: 60, windowMs: 60_000 }
  if (resource === 'traffic-tile') return { limit: 1_200, windowMs: 60_000 }
  return { limit: 120, windowMs: 60_000 }
}

async function loadJsonResource(resource: string, url: URL) {
  switch (resource) {
    case 'dam-release-advisories': return damReleaseAdvisories()
    case 'dams': return dams()
    case 'heat': return heat()
    case 'earthquakes': return earthquakes()
    case 'storms': return storms()
    case 'storm-surge-advisories': return stormSurgeAdvisories()
    case 'flood-advisories': return floodAdvisories()
    case 'floods': return floods()
    case 'flights': return flights()
    case 'gfw-vessel': return gfwVessel(url)
    case 'safe-grounds': return safeGrounds(url)
    case 'reverse-geocode': return reverseGeocode(url)
    case 'traffic': return traffic(url)
    case 'weather': return weather(url)
    default: return json({ error: 'Unknown live data resource' }, 400)
  }
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin')
  if (!originAllowed(origin)) return json({ error: 'Request origin is not allowed' }, 403)
  if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204, headers }), origin)
  if (request.method !== 'GET') {
    const response = json({ error: 'Method not allowed' }, 405)
    response.headers.set('allow', 'GET, OPTIONS')
    return withCors(response, origin)
  }

  const url = new URL(request.url)
  const resource = url.searchParams.get('resource') ?? ''
  const identity = clientIdentity(request)
  const isAsset = assetResources.has(resource)
  const rateGroup = isAsset ? 'assets' : 'feeds'
  const globalRate = rateLimiter.consume(`${identity}:${rateGroup}`, isAsset ? 1_800 : 720, 60_000)
  if (!globalRate.allowed) {
    const response = json({ error: 'Too many requests' }, 429)
    response.headers.set('retry-after', String(globalRate.retryAfterSeconds))
    return withCors(response, origin)
  }
  if (!supportedResources.has(resource)) return withCors(json({ error: 'Unknown live data resource' }, 400), origin)
  const policy = ratePolicy(resource)
  const rate = rateLimiter.consume(`${identity}:${resource}`, policy.limit, policy.windowMs)
  if (!rate.allowed) {
    const response = json({ error: 'Too many requests' }, 429)
    response.headers.set('retry-after', String(rate.retryAfterSeconds))
    return withCors(response, origin)
  }

  let response: Response
  try {
    if (resource === 'traffic-tile') response = await trafficTile(url)
    else response = await cachedJsonResource(resource, url, () => loadJsonResource(resource, url))
  } catch {
    response = json({ error: 'Live data is temporarily unavailable' }, 503)
  }
  return withCors(response, origin)
})
