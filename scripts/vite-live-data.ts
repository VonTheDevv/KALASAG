import type { Plugin } from 'vite'
import {
  loadDamReleaseAdvisories,
  loadDams,
  loadFloodAdvisories,
  loadReverseGeocode,
  loadStormSurgeAdvisories,
} from './official-hazard-data.js'

const bounds = { minLat: 4.5, maxLat: 21.5, minLng: 116, maxLng: 127.5 }
const inPhilippines = (lat: number, lng: number) => lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_ADDRESS_SEARCH_BYTES = 512 * 1024
const MAX_CSV_BYTES = 16 * 1024 * 1024
const MAX_TILE_BYTES = 1024 * 1024
const TRAFFIC_TILE_FRESH_MS = 45_000
const TRAFFIC_TILE_STALE_MS = 2 * 60_000
const supportedResources = new Set([
  'dam-release-advisories', 'dams', 'earthquakes', 'flights', 'flood-advisories',
  'floods', 'gfw-vessel', 'heat', 'reverse-geocode', 'safe-grounds',
  'storm-surge-advisories', 'storms', 'traffic', 'traffic-tile', 'weather',
])
const assetResources = new Set(['traffic-tile'])
const securityHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), payment=(), usb=()',
  'cross-origin-resource-policy': 'same-origin',
}

class RequestError extends Error {}

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
    // Refresh insertion order so eviction approximates LRU while remaining O(1).
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
  body: Buffer
  contentType: string
  freshUntil: number
}

const trafficTileCache = new BoundedTtlCache<TrafficTileCacheEntry>(128)
const trafficTileRequests = new Map<string, Promise<TrafficTileCacheEntry>>()

function trafficTileDescriptor(query: URLSearchParams) {
  const zoom = Number(query.get('z')), x = Number(query.get('x')), y = Number(query.get('y'))
  const tileRange = Number.isInteger(zoom) && zoom >= 0 && zoom <= 22 ? 2 ** zoom : 0
  if (!tileRange || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= tileRange || y >= tileRange) {
    throw new RequestError('Invalid traffic tile coordinates')
  }
  const style = query.get('style') === 'relative0' ? 'relative0' : 'relative0-dark'
  return { zoom, x, y, style, cacheKey: `${style}:${zoom}:${x}:${y}` }
}

async function fetchTrafficTile(descriptor: ReturnType<typeof trafficTileDescriptor>, tomtomKey: string) {
  const upstream = await fetch(`https://api.tomtom.com/traffic/map/4/tile/flow/${descriptor.style}/${descriptor.zoom}/${descriptor.x}/${descriptor.y}.png?key=${encodeURIComponent(tomtomKey)}&tileSize=256`, { signal: AbortSignal.timeout(12_000) })
  if (!upstream.ok) throw new Error(`TomTom traffic tile returned HTTP ${upstream.status}`)
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('image/')) throw new Error('TomTom traffic tile returned an invalid content type')
  const declaredLength = Number(upstream.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TILE_BYTES) throw new Error('Traffic tile exceeded the size limit')
  const body = Buffer.from(await upstream.arrayBuffer())
  if (body.byteLength > MAX_TILE_BYTES) throw new Error('Traffic tile exceeded the size limit')
  const entry = { body, contentType, freshUntil: Date.now() + TRAFFIC_TILE_FRESH_MS }
  trafficTileCache.set(descriptor.cacheKey, entry, TRAFFIC_TILE_STALE_MS)
  return entry
}

function sendTrafficTile(response: import('node:http').ServerResponse, tile: TrafficTileCacheEntry, state: 'live' | 'cached' | 'stale') {
  response.writeHead(200, {
    ...securityHeaders,
    'content-type': tile.contentType,
    'content-length': String(tile.body.byteLength),
    'cache-control': state === 'stale' ? 'public, max-age=10' : 'public, max-age=45, stale-while-revalidate=120',
    'x-kalasag-cache-state': state,
  })
  response.end(tile.body)
}

class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { count: number; resetsAt: number }>()
  private readonly maxEntries: number

  constructor(maxEntries: number) { this.maxEntries = maxEntries }

  consume(key: string, limit: number, windowMs: number) {
    const now = Date.now()
    let entry = this.entries.get(key)
    if (!entry || entry.resetsAt <= now) {
      if (!entry && this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.entries.delete(oldest)
      }
      entry = { count: 0, resetsAt: now + windowMs }
    }
    entry.count += 1
    this.entries.delete(key)
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

const send = (response: import('node:http').ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, { ...securityHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function json(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': 'KALASAG-DevGateway/1.0' }, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`)
  return JSON.parse(await readLimitedText(response, MAX_JSON_BYTES))
}

async function authenticatedJson(url: string, token: string) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'KALASAG-DevGateway/1.0' },
    signal: AbortSignal.timeout(12_000),
  })
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`)
  return JSON.parse(await readLimitedText(response, MAX_JSON_BYTES))
}

async function overpassJson(endpoint: string, query: string, signal: AbortSignal) {
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
      const payload = await overpassJson(provider.endpoint, query, controller.signal)
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

function safeGroundRadiusKm(query: URLSearchParams) {
  const raw = query.get('radiusKm')
  const requested = raw === null || raw.trim() === '' ? Number.NaN : Number(raw)
  return Math.max(1, Math.min(20, Number.isFinite(requested) ? requested : 5))
}

function safeGroundBbox(lat: number, lng: number, radiusKm: number) {
  const latDelta = radiusKm / 110.574
  const lngDelta = radiusKm / (111.320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))
  return `${(lat - latDelta).toFixed(5)},${(lng - lngDelta).toFixed(5)},${(lat + latDelta).toFixed(5)},${(lng + lngDelta).toFixed(5)}`
}

function safeGroundQuery(lat: number, lng: number, radiusKm: number, candidateRadiusKm = Math.min(radiusKm, 5)) {
  const designatedBbox = safeGroundBbox(lat, lng, radiusKm)
  // Broad school/park/public-facility scans can contain tens of thousands of
  // Metro Manila objects and make every free Overpass provider time out. Scan
  // nearby candidates first while keeping designated evacuation facilities at
  // the full requested radius; normalized responses are capped at 80 sites.
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

async function safeGrounds(query: URLSearchParams) {
  const checkedAt = new Date().toISOString()
  const lat = Number(query.get('lat')), lng = Number(query.get('lng'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) throw new RequestError('Invalid location')
  const radiusKm = safeGroundRadiusKm(query)
  const sources: Array<Record<string, string>> = []
  const deadline = Date.now() + 27_000
  const request = safeGroundQuery(lat, lng, radiusKm)
  const providers: OverpassProvider[] = [
    { id: 'safe-ground-1', endpoint: 'https://maps.mail.ru/osm/tools/overpass/api/interpreter' },
    { id: 'safe-ground-2', endpoint: 'https://overpass-api.de/api/interpreter' },
    { id: 'safe-ground-3', endpoint: 'https://lz4.overpass-api.de/api/interpreter' },
  ]
  try {
    const result = await firstAvailableOverpass(providers, request, Math.min(16_000, deadline - Date.now()))
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
    return { data, sources, fetchedAt: checkedAt, radiusKm }
  } catch {
    sources.length = 0
    providers.forEach(provider => sources.push({ id: provider.id, status: 'unavailable', checkedAt, detail: 'Upstream request failed' }))
  }
  throw new Error('Safe-ground feeds are unavailable')
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

async function gfwVessel(mmsi: string, token?: string) {
  if (!token) throw new Error('GFW_API_TOKEN is not configured')
  if (!/^\d{9}$/.test(mmsi)) throw new RequestError('Invalid MMSI')
  const cached = gfwVesselCache.get(mmsi)
  if (cached) return cached
  const payload = await authenticatedJson(`https://gateway.api.globalfishingwatch.org/v3/vessels/search?query=${mmsi}&datasets%5B0%5D=public-global-vessel-identity%3Alatest`, token)
  const value = normalizeGfwVessel(mmsi, payload)
  gfwVesselCache.set(mmsi, value, 24 * 60 * 60 * 1000)
  return value
}

const parBoundary: [number, number][] = [[25, 120], [25, 135], [5, 135], [5, 115], [15, 115], [21, 120], [25, 120]]

function pointInPolygon(lat: number, lng: number) {
  let inside = false
  for (let i = 0, j = parBoundary.length - 1; i < parBoundary.length; j = i, i += 1) {
    const [latI, lngI] = parBoundary[i], [latJ, lngJ] = parBoundary[j]
    if (((latI > lat) !== (latJ > lat)) && (lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI || Number.EPSILON) + lngI)) inside = !inside
  }
  return inside
}

function distanceToSegmentKm(lat: number, lng: number, start: [number, number], end: [number, number]) {
  const referenceLat = ((lat + start[0] + end[0]) / 3) * Math.PI / 180
  const scaleX = 111.32 * Math.cos(referenceLat)
  const px = lng * scaleX, py = lat * 111.32, ax = start[1] * scaleX, ay = start[0] * 111.32, bx = end[1] * scaleX, by = end[0] * 111.32
  const dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function distanceToParKm(lat: number, lng: number) {
  if (pointInPolygon(lat, lng)) return 0
  return Math.min(...parBoundary.slice(0, -1).map((point, index) => distanceToSegmentKm(lat, lng, point, parBoundary[index + 1])))
}

function gdacsTrack(geometry: any, forecast: boolean, center: [number, number]) {
  const segments = (geometry.features ?? []).filter((feature: any) => feature.geometry?.type === 'LineString' && feature.properties?.forecast === forecast)
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
    const last = ordered[ordered.length - 1], lastCoordinate: [number, number] = [last.lng, last.lat]
    const matchIndex = remaining.findIndex(segment => samePoint(segment.coordinates[0], lastCoordinate) || samePoint(segment.coordinates[segment.coordinates.length - 1], lastCoordinate))
    if (matchIndex < 0) break
    const segment = remaining.splice(matchIndex, 1)[0]
    const coordinates = samePoint(segment.coordinates[0], lastCoordinate) ? segment.coordinates : [...segment.coordinates].reverse()
    ordered.push(...coordinates.slice(1).map(([lng, lat]: [number, number]) => ({ lat, lng, intensity: segment.intensity })))
  }
  if (!forecast) ordered = ordered.reverse()
  return { track: ordered.map((point: any) => [point.lat, point.lng] as [number, number]), points: ordered }
}

type FlightRoute = { departurePort: string; destinationPort: string; origin: string; destination: string; waypoints: [number, number][] }
const routeCache = new BoundedTtlCache<FlightRoute | null>(1_000)

async function flightRoute(callsign: string): Promise<FlightRoute | null> {
  const normalized = callsign.trim().toUpperCase()
  if (!/^[A-Z]{2,3}\d[A-Z0-9]*$/.test(normalized)) return null
  const cached = routeCache.get(normalized)
  if (cached !== undefined) return cached
  try {
    let value: FlightRoute | null = null
    try {
      const staticRoute: any = await json(`https://vrs-standing-data.adsb.lol/routes/${normalized.slice(0, 2)}/${encodeURIComponent(normalized)}.json`)
      const airports = Array.isArray(staticRoute?._airports) ? staticRoute._airports : []
      if (airports.length >= 2 && airports.every((airport: any) => Number.isFinite(Number(airport.lat)) && Number.isFinite(Number(airport.lon)))) {
        const origin = airports[0], destination = airports[airports.length - 1]
        value = { departurePort: origin.name || origin.location || origin.iata || origin.icao, destinationPort: destination.name || destination.location || destination.iata || destination.icao, origin: origin.iata || origin.icao || '', destination: destination.iata || destination.icao || '', waypoints: airports.map((airport: any) => [Number(airport.lat), Number(airport.lon)] as [number, number]) }
      }
    } catch { /* ADSBDB is the fallback when the static community route is absent. */ }
    if (!value) {
      const payload: any = await json(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(normalized)}`)
      const route = payload?.response?.flightroute
      const airports = [route?.origin, route?.midpoint, route?.destination].filter(Boolean)
      if (!route?.origin || !route?.destination || airports.some((airport: any) => !Number.isFinite(Number(airport.latitude)) || !Number.isFinite(Number(airport.longitude)))) throw new Error('Invalid route response')
      value = { departurePort: route.origin.name || route.origin.municipality || route.origin.iata_code || route.origin.icao_code, destinationPort: route.destination.name || route.destination.municipality || route.destination.iata_code || route.destination.icao_code, origin: route.origin.iata_code || route.origin.icao_code || '', destination: route.destination.iata_code || route.destination.icao_code || '', waypoints: airports.map((airport: any) => [Number(airport.latitude), Number(airport.longitude)] as [number, number]) }
    }
    routeCache.set(normalized, value, 12 * 60 * 60 * 1000)
    return value
  } catch {
    routeCache.set(normalized, null, 20 * 60 * 1000)
    return null
  }
}

async function enrichFlightRoutes(aircraft: any[]) {
  const routes = new Map<string, FlightRoute | null>()
  const callsigns = [...new Set(aircraft.map(item => String(item.flight ?? '').trim().toUpperCase()).filter(Boolean))].slice(0, 80)
  for (let index = 0; index < callsigns.length; index += 8) {
    const batch = callsigns.slice(index, index + 8)
    const resolved = await Promise.all(batch.map(async callsign => [callsign, await flightRoute(callsign)] as const))
    resolved.forEach(([callsign, route]) => routes.set(callsign, route))
  }
  return aircraft.map(item => routes.get(String(item.flight ?? '').trim().toUpperCase()) ? { ...item, route: routes.get(String(item.flight ?? '').trim().toUpperCase()) } : item)
}

function parseCsvRow(row: string) {
  const values: string[] = []
  let value = '', quoted = false
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index]
    if (character === '"') {
      if (quoted && row[index + 1] === '"') { value += '"'; index += 1 } else quoted = !quoted
    } else if (character === ',' && !quoted) {
      values.push(value)
      value = ''
    } else value += character
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
    const timestamp = typeof hotspot.observedAt === 'string' ? Date.parse(hotspot.observedAt) : Number.NaN
    return Number.isFinite(timestamp) ? [timestamp] : []
  })
  const latest = timestamps.length ? Math.max(...timestamps) : null
  const earliest = timestamps.length ? Math.min(...timestamps) : null
  return {
    sourceClass: 'official-observation', freshness: 'unknown', freshnessReason: 'feed-generation-time-not-published',
    evaluatedAt: checkedAt, referenceTimestamp: latest === null ? null : new Date(latest).toISOString(),
    ageMinutes: latest === null ? null : Math.max(0, Math.round((Date.parse(checkedAt) - latest) / 60_000)),
    freshnessThresholdMinutes: null, observedAt: latest === null ? null : new Date(latest).toISOString(), issuedAt: null,
    validity: { from: earliest === null ? null : new Date(earliest).toISOString(), to: latest === null ? null : new Date(latest).toISOString() },
    datasetVersion: 'satellite-active-fire-c2-regional-24h',
    note: 'This 24-hour layer contains satellite thermal observations, not verified structure-fire incidents. Observation times reflect orbital passes; successful delivery does not prove continuous ground coverage.',
  }
}

async function heat() {
  const checkedAt = new Date().toISOString()
  const feeds = [
    ['suomi-npp-viirs-c2', 'SUOMI_VIIRS_C2_SouthEast_Asia_24h.csv', 'S-NPP'],
    ['noaa-20-viirs-c2', 'J1_VIIRS_C2_SouthEast_Asia_24h.csv', 'NOAA-20'],
    ['noaa-21-viirs-c2', 'J2_VIIRS_C2_SouthEast_Asia_24h.csv', 'NOAA-21'],
  ]
  const entries = await Promise.allSettled(feeds.map(async ([collection, file, satellite]) => {
    const response = await fetch(`https://firms.modaps.eosdis.nasa.gov/data/active_fire/${collection}/csv/${file}`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`${satellite} returned HTTP ${response.status}`)
    const lines = (await readLimitedText(response, MAX_CSV_BYTES)).trim().split(/\r?\n/)
    const headers = parseCsvRow(lines.shift() ?? '').map(header => header.trim())
    const index = (name: string) => headers.indexOf(name)
    const latIndex = index('latitude'), lngIndex = index('longitude')
    if (latIndex < 0 || lngIndex < 0) throw new Error(`${satellite} response is missing location columns`)
    const seen = new Set<string>()
    return lines.flatMap(line => {
      const row = parseCsvRow(line)
      const lat = Number(row[latIndex]), lng = Number(row[lngIndex])
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) return []
      const date = String(row[index('acq_date')] || '').trim()
      const time = String(row[index('acq_time')] || '').trim().padStart(4, '0')
      const observedAt = firmsObservedAt(date, time)
      if (!observedAt) return []
      const key = `${satellite}:${lat.toFixed(4)}:${lng.toFixed(4)}:${date}:${time}`
      if (seen.has(key)) return []
      seen.add(key)
      return [{ id: `firms-${key}`, lat, lng, brightness: Number(row[index('bright_ti4')]) || Number(row[index('bright_t31')]) || 0, confidence: row[index('confidence')] || 'unknown', acq_date: date, acq_time: time, observedAt, satellite, frp: Number(row[index('frp')]) || 0, daynight: row[index('daynight')] || 'unknown' }]
    })
  }))
  const sources = entries.map((entry, index) => ({ id: `heat-${feeds[index][2].toLowerCase()}`, status: entry.status === 'fulfilled' ? 'live' : 'unavailable', checkedAt, ...(entry.status === 'rejected' ? { detail: 'Upstream request failed' } : {}) }))
  const data = entries.flatMap(entry => entry.status === 'fulfilled' ? entry.value : [])
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
  if (!data.length && sources.every(source => source.status === 'unavailable')) throw new Error('All heat-detection feeds are unavailable')
  return { data, sources, fetchedAt: checkedAt, metadata: heatFeedMetadata(data, checkedAt) }
}

async function handler(resource: string, query: URLSearchParams, tomtomKey?: string, gfwToken?: string) {
  const checkedAt = new Date().toISOString()
  if (resource === 'dam-release-advisories') return loadDamReleaseAdvisories()
  if (resource === 'dams') return loadDams()
  if (resource === 'flood-advisories') return loadFloodAdvisories()
  if (resource === 'storm-surge-advisories') return loadStormSurgeAdvisories()
  if (resource === 'reverse-geocode') {
    const lat = Number(query.get('lat')), lng = Number(query.get('lng'))
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) throw new RequestError('Invalid location')
    return loadReverseGeocode(lat, lng)
  }
  if (resource === 'heat') return heat()
  if (resource === 'earthquakes') {
    const start = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const payload: any = await json(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minmagnitude=4&minlatitude=4.5&maxlatitude=21.5&minlongitude=116&maxlongitude=127.5&orderby=time&limit=200`)
    return { data: payload.features ?? [], sources: [{ id: 'earthquake-primary', status: 'live', checkedAt }], fetchedAt: checkedAt }
  }
  if (resource === 'storms') {
    const payload: any = await json('https://www.gdacs.org/xml/gdacs.geojson')
    const storms = (payload.features ?? []).flatMap((feature: any) => {
      const properties = feature.properties ?? {}; const [lng, lat] = feature.geometry?.coordinates ?? []
      if (properties.eventtype !== 'TC' || feature.geometry?.type !== 'Point' || !Number.isFinite(lat) || !Number.isFinite(lng) || distanceToParKm(lat, lng) > 10) return []
      return [{ id: String(properties.eventid ?? `${lat}-${lng}`), name: properties.name || 'Unnamed tropical cyclone', lat, lng, alertlevel: properties.alertlevel || 'Green', alertscore: Number(properties.alertscore) || 0, severity: Number(properties.severity) || undefined, description: properties.description || 'No event description was supplied.', windKph: properties.windspeed ? Math.round(Number(properties.windspeed) * 1.852) : undefined, source: 'Live hazard feed', updated: properties.fromdate ?? properties.todate, ended: properties.todate, countries: properties.country || undefined, distanceToParKm: Math.round(distanceToParKm(lat, lng) * 10) / 10 }]
    })
    const data = await Promise.all(storms.map(async (storm: any) => {
      const geometry: any = await json(`https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventid=${encodeURIComponent(storm.id)}&eventtype=TC`)
      const center: [number, number] = [storm.lng, storm.lat]
      const observed = gdacsTrack(geometry, false, center), forecast = gdacsTrack(geometry, true, center)
      return { ...storm, observedTrack: observed.track, forecastTrack: forecast.track, observedPoints: observed.points, forecastPoints: forecast.points }
    }))
    return { data, sources: [{ id: 'storm-primary', status: 'live', checkedAt }], fetchedAt: checkedAt }
  }
  if (resource === 'floods') {
    const [eonet, gdacs] = await Promise.all([json('https://eonet.gsfc.nasa.gov/api/v3/events?category=floods&status=open&limit=100'), json('https://www.gdacs.org/xml/gdacs.geojson')]) as [any, any]
    const fromEonet = (eonet.events ?? []).flatMap((event: any) => {
      const [lng, lat] = event.geometry?.at(-1)?.coordinates ?? []
      return Number.isFinite(lat) && Number.isFinite(lng) && inPhilippines(lat, lng) ? [{ id: `flood-a-${event.id}`, name: event.title || 'Reported flood event', lat, lng, severity: 'Unknown', alertlevel: 'Green', description: event.description || 'Reported flood event location. This point is not an inundation boundary.', source: 'Contextual event feed', sourceClass: 'contextual-event', observedAt: event.geometry?.at(-1)?.date ?? null }] : []
    })
    const fromGdacs = (gdacs.features ?? []).flatMap((feature: any) => {
      const properties = feature.properties ?? {}; const [lng, lat] = feature.geometry?.coordinates ?? []
      return properties.eventtype === 'FL' && Number.isFinite(lat) && Number.isFinite(lng) && inPhilippines(lat, lng) ? [{ id: `flood-b-${properties.eventid ?? `${lat}-${lng}`}`, name: properties.name || 'Reported flood event', lat, lng, severity: properties.severitydata?.severitytext || 'Unknown', alertlevel: properties.alertlevel || 'Green', description: properties.description || 'Reported flood event location. This point is not an inundation boundary.', source: 'Contextual event feed', sourceClass: 'contextual-event', observedAt: properties.fromdate ?? null }] : []
    })
    const data = [...fromEonet, ...fromGdacs].slice(0, 100)
    const observedTimes = data.flatMap(event => {
      const parsed = typeof event.observedAt === 'string' ? Date.parse(event.observedAt) : Number.NaN
      return Number.isFinite(parsed) ? [parsed] : []
    })
    const observedAt = observedTimes.length ? new Date(Math.max(...observedTimes)).toISOString() : null
    return { data, sources: [{ id: 'flood-primary', status: 'live', checkedAt }, { id: 'flood-secondary', status: 'live', checkedAt }], fetchedAt: checkedAt, metadata: { sourceClass: 'contextual-event', freshness: 'live', observedAt, issuedAt: null, validity: { from: null, to: null }, datasetVersion: `reported-flood-events:${checkedAt.slice(0, 16)}`, note: 'These are reported event points only. They are not flood depths, susceptibility polygons, or current inundation extents.' } }
  }
  if (resource === 'flights') {
    const responses = await Promise.all([[15, 121], [8, 124]].map(([lat, lng]) => json(`https://api.airplanes.live/v2/point/${lat}/${lng}/250`) as Promise<any>))
    const seen = new Map<string, any>(); responses.forEach(data => (data.ac ?? []).forEach((item: any) => item.hex && seen.set(String(item.hex).toLowerCase(), item)))
    return { data: await enrichFlightRoutes([...seen.values()]), sources: [{ id: 'aircraft-primary', status: 'live', checkedAt }, { id: 'aircraft-routes', status: 'live', checkedAt }], fetchedAt: checkedAt }
  }
  if (resource === 'gfw-vessel') {
    return { data: await gfwVessel(query.get('mmsi') ?? '', gfwToken), sources: [{ id: 'vessel-identity', status: 'live', checkedAt }], fetchedAt: checkedAt }
  }
  if (resource === 'safe-grounds') return safeGrounds(query)
  const lat = Number(query.get('lat')), lng = Number(query.get('lng'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inPhilippines(lat, lng)) throw new RequestError('Invalid location')
  if (resource === 'weather') {
    const data = await json(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,surface_pressure,uv_index&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset&timezone=Asia%2FManila&forecast_days=7`)
    return { data, sources: [{ id: 'weather-primary', status: 'live', checkedAt }], fetchedAt: checkedAt }
  }
  if (resource === 'traffic') {
    if (!tomtomKey) throw new Error('Server traffic credential is not configured')
    const radiusKm = Math.max(1, Math.min(20, Number(query.get('radiusKm')) || 20))
    const latDelta = radiusKm / 111.32
    const lngDelta = radiusKm / (111.32 * Math.max(0.2, Math.cos(lat * Math.PI / 180)))
    const data: any = await json(`https://api.tomtom.com/traffic/services/5/incidentDetails?key=${encodeURIComponent(tomtomKey)}&bbox=${lng - lngDelta},${lat - latDelta},${lng + lngDelta},${lat + latDelta}&fields={incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code},startTime,endTime,from,to,length,delay}}}`)
    return { data: data.incidents ?? [], sources: [{ id: 'traffic-primary', status: 'live', checkedAt }], fetchedAt: checkedAt }
  }
  throw new RequestError('Unknown live data resource')
}

const proxiedPaths = ['/api-adsb', '/api-adsb-one', '/api-gdacs', '/api-jtwc']

function clientIp(request: import('node:http').IncomingMessage) {
  return request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? 'unknown'
}

function allowedOrigin(request: import('node:http').IncomingMessage, configuredOrigins: Set<string>) {
  const origin = request.headers.origin
  if (!origin) return true
  if (configuredOrigins.has(origin)) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

function setRequestHeaders(response: import('node:http').ServerResponse, origin?: string) {
  Object.entries(securityHeaders).forEach(([name, value]) => response.setHeader(name, value))
  if (origin) {
    response.setHeader('access-control-allow-origin', origin)
    response.setHeader('access-control-allow-methods', 'GET, OPTIONS')
    response.setHeader('access-control-allow-headers', 'authorization, content-type')
    response.setHeader('access-control-expose-headers', 'retry-after, x-kalasag-cache-state, x-kalasag-source-checked-at')
    response.setHeader('vary', 'Origin')
  }
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

export function viteLiveData(tomtomKey?: string, gfwToken?: string, allowedOrigins = ''): Plugin {
  const configuredOrigins = new Set(allowedOrigins.split(',').map(value => value.trim()).filter(Boolean))
  const limiter = new FixedWindowRateLimiter(2_048)
  return {
    name: 'kalasag-live-data-development-gateway',
    configureServer(server) {
      // These headers are intentionally compatible with Vite HMR. A strict CSP
      // belongs on the production static host, not the development server.
      server.middlewares.use((request, response, next) => {
        setRequestHeaders(response)
        const path = new URL(request.url ?? '/', 'https://localhost').pathname
        if (!proxiedPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return next()
        if (!allowedOrigin(request, configuredOrigins)) return send(response, { error: 'Request origin is not allowed' }, 403)
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.setHeader('allow', 'GET, HEAD')
          return send(response, { error: 'Method not allowed' }, 405)
        }
        const prefix = proxiedPaths.find(candidate => path === candidate || path.startsWith(`${candidate}/`)) ?? 'proxy'
        const policy = prefix === '/api-gdacs' ? { limit: 10, windowMs: 60_000 } : { limit: 60, windowMs: 60_000 }
        const result = limiter.consume(`${clientIp(request)}:${prefix}`, policy.limit, policy.windowMs)
        if (!result.allowed) {
          response.setHeader('retry-after', String(result.retryAfterSeconds))
          return send(response, { error: 'Too many requests' }, 429)
        }
        next()
      })

      server.middlewares.use('/api-live-data', async (request, response) => {
        const origin = request.headers.origin
        setRequestHeaders(response, origin && allowedOrigin(request, configuredOrigins) ? origin : undefined)
        if (!allowedOrigin(request, configuredOrigins)) return send(response, { error: 'Request origin is not allowed' }, 403)
        if (request.method === 'OPTIONS') {
          response.writeHead(204)
          response.end()
          return
        }
        if (request.method !== 'GET') {
          response.setHeader('allow', 'GET, OPTIONS')
          return send(response, { error: 'Method not allowed' }, 405)
        }
        try {
          const url = new URL(request.url ?? '/', 'https://localhost')
          const resource = url.searchParams.get('resource') ?? ''
          const identity = clientIp(request)
          const isAsset = assetResources.has(resource)
          const rateGroup = isAsset ? 'assets' : 'feeds'
          const globalRate = limiter.consume(`${identity}:live:${rateGroup}`, isAsset ? 1_800 : 720, 60_000)
          if (!globalRate.allowed) {
            response.setHeader('retry-after', String(globalRate.retryAfterSeconds))
            return send(response, { error: 'Too many requests' }, 429)
          }
          if (!supportedResources.has(resource)) return send(response, { error: 'Unknown live data resource' }, 400)
          const policy = ratePolicy(resource)
          const rate = limiter.consume(`${identity}:live:${resource}`, policy.limit, policy.windowMs)
          if (!rate.allowed) {
            response.setHeader('retry-after', String(rate.retryAfterSeconds))
            return send(response, { error: 'Too many requests' }, 429)
          }
          if (resource === 'traffic-tile') {
            if (!tomtomKey) throw new Error('TOMTOM_API_KEY is not configured')
            const descriptor = trafficTileDescriptor(url.searchParams)
            const cached = trafficTileCache.get(descriptor.cacheKey)
            if (cached?.freshUntil && cached.freshUntil > Date.now()) {
              sendTrafficTile(response, cached, 'cached')
              return
            }

            let pending = trafficTileRequests.get(descriptor.cacheKey)
            if (!pending) {
              const providerRate = limiter.consume('provider:tomtom:traffic-tiles', 300, 60_000)
              if (!providerRate.allowed) {
                if (cached) {
                  sendTrafficTile(response, cached, 'stale')
                  return
                }
                response.setHeader('retry-after', String(providerRate.retryAfterSeconds))
                return send(response, { error: 'Traffic flow is refreshing' }, 429)
              }
              pending = fetchTrafficTile(descriptor, tomtomKey).finally(() => trafficTileRequests.delete(descriptor.cacheKey))
              trafficTileRequests.set(descriptor.cacheKey, pending)
            }

            try {
              sendTrafficTile(response, await pending, 'live')
            } catch (error) {
              if (cached) {
                sendTrafficTile(response, cached, 'stale')
                return
              }
              throw error
            }
            return
          }
          send(response, await handler(resource, url.searchParams, tomtomKey, gfwToken))
        } catch (error) {
          const status = error instanceof RequestError ? 400 : 503
          send(response, { error: status === 400 ? 'Invalid request' : 'Live data is temporarily unavailable' }, status)
        }
      })

      server.middlewares.use('/api-address-search', async (request, response) => {
        const origin = request.headers.origin
        setRequestHeaders(response, origin && allowedOrigin(request, configuredOrigins) ? origin : undefined)
        if (!allowedOrigin(request, configuredOrigins)) return send(response, { error: 'Request origin is not allowed' }, 403)
        if (request.method === 'OPTIONS') {
          response.writeHead(204)
          response.end()
          return
        }
        if (request.method !== 'GET') {
          response.setHeader('allow', 'GET, OPTIONS')
          return send(response, { error: 'Method not allowed' }, 405)
        }

        const rate = limiter.consume(`${clientIp(request)}:address-search`, 20, 60_000)
        if (!rate.allowed) {
          response.setHeader('retry-after', String(rate.retryAfterSeconds))
          return send(response, { error: 'Too many address searches' }, 429)
        }

        try {
          const requestUrl = new URL(request.url ?? '/', 'https://localhost')
          const query = (requestUrl.searchParams.get('q') ?? '').replace(/\s+/g, ' ').trim()
          if (query.length < 3 || query.length > 120) return send(response, { error: 'Invalid address query' }, 400)

          const upstream = new URL('https://photon.komoot.io/api')
          upstream.searchParams.set('q', query)
          upstream.searchParams.set('countrycode', 'PH')
          upstream.searchParams.set('bbox', '116,4.5,127.5,21.5')
          upstream.searchParams.set('lang', 'en')
          upstream.searchParams.set('limit', '6')
          const upstreamResponse = await fetch(upstream, {
            headers: { accept: 'application/json', 'user-agent': 'KALASAG-DevGateway/1.0' },
            signal: AbortSignal.timeout(8_000),
          })
          if (!upstreamResponse.ok) throw new Error(`Address provider returned HTTP ${upstreamResponse.status}`)
          const payload = JSON.parse(await readLimitedText(upstreamResponse, MAX_ADDRESS_SEARCH_BYTES))
          return send(response, payload)
        } catch {
          return send(response, { error: 'Address suggestions are temporarily unavailable' }, 503)
        }
      })
    },
  }
}
