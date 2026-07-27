import { supabase } from './supabase'

export type SourceHealth = {
  id: string
  status: 'live' | 'stale' | 'unknown' | 'unavailable'
  checkedAt: string
  detail?: string
}

export type LiveDataResponse<T> = {
  data: T
  sources: SourceHealth[]
  fetchedAt: string
  deliveryFreshness?: 'network' | 'cached' | 'stale'
  stale?: boolean
  metadata?: HazardFeedMetadata
}

export type HazardFeedMetadata = {
  sourceClass: 'official-observation' | 'official-advisory' | 'contextual-event' | 'public-geocoder'
  freshness: 'live' | 'cached' | 'stale' | 'unknown' | 'unavailable'
  freshnessReason?: string
  evaluatedAt?: string | null
  referenceTimestamp?: string | null
  ageMinutes?: number | null
  freshnessThresholdMinutes?: number | null
  observedAt: string | null
  issuedAt: string | null
  validity: { from: string | null; to: string | null }
  datasetVersion: string
  note?: string
}

export type HazardAreaGeometry = {
  type: 'Polygon' | 'MultiPolygon'
  coordinates: number[][][] | number[][][][]
}

export type FloodAdvisory = {
  id: string
  area: string
  status: string
  severity: 'normal' | 'outlook' | 'advisory' | 'warning' | 'critical' | 'unknown'
  bulletinUrl: string | null
  issuedAt: string | null
  validUntil: string | null
  geometry: HazardAreaGeometry | null
}

export type StormSurgeAdvisory = {
  id: string
  title: string
  summary: string
  advisoryUrl: string | null
  issuedAt: string | null
  validUntil: string | null
  geometry: HazardAreaGeometry | null
}

export type DamStatus = {
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

export type DamReleaseAdvisory = {
  id: string
  damName: string
  noticeStatus: 'discharge-observed-at-source-time' | 'current-discharge-observed' | 'no-schedule-published-in-checked-source'
  scheduledAt: string | null
  observedAt: string | null
  gateOpeningCount: number | null
  gateOpeningM: number | null
  outflowCms: number | null
  message: string
}

export type ReverseGeocodeResult = {
  displayName: string
  street: string | null
  locality: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  lat: number
  lng: number
}

export class LiveDataError extends Error {
  sources: SourceHealth[]
  status?: number
  retryAfterMs?: number

  constructor(message: string, sources: SourceHealth[] = [], status?: number, retryAfterMs?: number) {
    super(message)
    this.name = 'LiveDataError'
    this.sources = sources
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

export type LiveDataAsset = {
  blob: Blob
  freshness: 'live' | 'cached' | 'stale'
  checkedAt?: string
}

const LIVE_DATA_TIMEOUT_MS = 15_000
const SAFE_GROUND_TIMEOUT_MS = 30_000
const MAX_JSON_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_ASSET_RESPONSE_BYTES = 3 * 1024 * 1024
const ASSET_FRESH_MS = 45_000
const ASSET_STALE_MS = 2 * 60_000
const MAX_ASSET_CACHE_BYTES = 32 * 1024 * 1024
type AssetCacheEntry = { blob: Blob; freshUntil: number; staleUntil: number; sourceFreshness: 'live' | 'stale'; checkedAt?: string }
const assetCache = new Map<string, AssetCacheEntry>()
const assetRequests = new Map<string, Promise<LiveDataAsset>>()
let assetCacheBytes = 0
const assetRateLimitedUntil = new Map<string, number>()
const LIVE_DATA_RESOURCES = new Set([
  'earthquakes',
  'flights',
  'flood-advisories',
  'floods',
  'dam-release-advisories',
  'dams',
  'gfw-vessel',
  'heat',
  'reverse-geocode',
  'safe-grounds',
  'storm-surge-advisories',
  'storms',
  'traffic',
  'weather',
])
const LIVE_DATA_ASSETS = new Set(['traffic-tile'])
const METADATA_REQUIRED_RESOURCES = new Set([
  'dam-release-advisories',
  'dams',
  'flood-advisories',
  'floods',
  'reverse-geocode',
  'storm-surge-advisories',
])

function assertLiveDataResource(resource: string, asset = false) {
  if ((asset && !LIVE_DATA_ASSETS.has(resource)) || (!asset && !LIVE_DATA_RESOURCES.has(resource))) {
    throw new LiveDataError('Unsupported live data resource')
  }
}

function validOptionalTimestamp(value: unknown) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))
}

function validOptionalMetadataTimestamp(value: unknown) {
  return value === undefined || validOptionalTimestamp(value)
}

function validOptionalNonNegativeNumber(value: unknown) {
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function validSourceHealth(value: unknown): value is SourceHealth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Partial<SourceHealth>
  return typeof source.id === 'string'
    && source.id.length > 0
    && source.id.length <= 120
    && ['live', 'stale', 'unknown', 'unavailable'].includes(String(source.status))
    && typeof source.checkedAt === 'string'
    && Number.isFinite(Date.parse(source.checkedAt))
    && (source.detail === undefined || typeof source.detail === 'string')
}

function validHazardMetadata(value: unknown): value is HazardFeedMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const metadata = value as Partial<HazardFeedMetadata>
  const validity = metadata.validity
  return ['official-observation', 'official-advisory', 'contextual-event', 'public-geocoder'].includes(String(metadata.sourceClass))
    && ['live', 'cached', 'stale', 'unknown', 'unavailable'].includes(String(metadata.freshness))
    && validOptionalTimestamp(metadata.observedAt)
    && validOptionalTimestamp(metadata.issuedAt)
    && validOptionalMetadataTimestamp(metadata.evaluatedAt)
    && validOptionalMetadataTimestamp(metadata.referenceTimestamp)
    && validOptionalNonNegativeNumber(metadata.ageMinutes)
    && validOptionalNonNegativeNumber(metadata.freshnessThresholdMinutes)
    && (metadata.freshnessReason === undefined || typeof metadata.freshnessReason === 'string')
    && Boolean(validity && typeof validity === 'object' && validOptionalTimestamp(validity.from) && validOptionalTimestamp(validity.to))
    && typeof metadata.datasetVersion === 'string'
    && metadata.datasetVersion.length > 0
    && metadata.datasetVersion.length <= 200
}

async function readBoundedJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) throw new LiveDataError('Live data service returned an invalid content type')

  const body = await response.blob()
  if (body.size > MAX_JSON_RESPONSE_BYTES) throw new LiveDataError('Live data response exceeded the safe size limit')

  try {
    return JSON.parse(await body.text()) as T
  } catch {
    throw new LiveDataError('Live data service returned invalid JSON')
  }
}

function liveDataUrl(resource: string, params: Record<string, string | number>) {
  const configuredGateway = String(import.meta.env.VITE_LIVE_DATA_URL ?? '').trim()
  const url = import.meta.env.DEV
    ? new URL('/api-live-data', window.location.origin)
    : new URL(configuredGateway || `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/live-data`)
  if (!import.meta.env.DEV && url.protocol !== 'https:') {
    throw new LiveDataError('Live data service is not securely configured')
  }
  url.searchParams.set('resource', resource)
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  return url
}

function retryAfterMs(response: Response) {
  const value = response.headers.get('retry-after')
  if (!value) return response.status === 429 ? 30_000 : undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(1_000, seconds * 1_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(1_000, date - Date.now()) : 30_000
}

function touchAssetEntry(key: string, entry: AssetCacheEntry) {
  assetCache.delete(key)
  assetCache.set(key, entry)
}

function cacheAsset(key: string, blob: Blob, sourceFreshness: 'live' | 'stale', checkedAt?: string) {
  const existing = assetCache.get(key)
  if (existing) assetCacheBytes -= existing.blob.size
  const now = Date.now()
  const entry = { blob, freshUntil: now + ASSET_FRESH_MS, staleUntil: now + ASSET_STALE_MS, sourceFreshness, checkedAt }
  assetCache.set(key, entry)
  assetCacheBytes += blob.size
  while (assetCacheBytes > MAX_ASSET_CACHE_BYTES && assetCache.size > 1) {
    const oldestKey = assetCache.keys().next().value
    if (oldestKey === undefined) break
    const oldest = assetCache.get(oldestKey)
    if (oldest) assetCacheBytes -= oldest.blob.size
    assetCache.delete(oldestKey)
  }
  return entry
}

function assetResult(entry: AssetCacheEntry, cached = false): LiveDataAsset {
  return {
    blob: entry.blob,
    freshness: entry.sourceFreshness === 'stale' ? 'stale' : cached ? 'cached' : 'live',
    checkedAt: entry.checkedAt,
  }
}

function assetMessages() {
  return {
    busy: 'Live road flow is refreshing; retrying shortly',
    unavailable: 'Live road-flow service is temporarily unavailable; retrying on the next refresh',
    unreachable: 'Live road-flow service could not be reached; retrying on the next refresh',
    timeout: 'Live road-flow service timed out; retrying on the next refresh',
  }
}

async function liveDataHeaders() {
  if (import.meta.env.DEV) return undefined
  const { data: { session } } = await supabase.auth.getSession()
  return {
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    ...(session?.access_token ? { authorization: `Bearer ${session.access_token}` } : {}),
  }
}

/** Fetch a normalized live feed from the server-side gateway. Never falls back
 * to browser CORS proxies: callers can show an honest unavailable/stale state. */
export async function getLiveData<T>(resource: string, params: Record<string, string | number> = {}): Promise<LiveDataResponse<T>> {
  assertLiveDataResource(resource)
  let response: Response
  try {
    response = await fetch(liveDataUrl(resource, params), {
      headers: await liveDataHeaders(),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(resource === 'safe-grounds' ? SAFE_GROUND_TIMEOUT_MS : LIVE_DATA_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new LiveDataError('Live data service timed out; retrying on the next refresh')
    throw new LiveDataError('Live data service could not be reached; retrying on the next refresh')
  }
  const payload = await readBoundedJson<Partial<LiveDataResponse<T>> & { error?: string; sources?: SourceHealth[] }>(response)
  if (!response.ok) {
    const message = response.status === 429
      ? 'Live data service is busy; retrying shortly'
      : response.status === 401 || response.status === 403 || response.status === 404 || response.status >= 500
        ? 'Live data service is temporarily unavailable; retrying on the next refresh'
        : payload.error || 'Live data request could not be completed'
    throw new LiveDataError(message, payload.sources || [], response.status, retryAfterMs(response))
  }
  if (
    payload.data === undefined
    || typeof payload.fetchedAt !== 'string'
    || !Number.isFinite(Date.parse(payload.fetchedAt))
    || !Array.isArray(payload.sources)
    || !payload.sources.every(validSourceHealth)
  ) throw new LiveDataError('Live data service returned an invalid response')
  if (METADATA_REQUIRED_RESOURCES.has(resource) && !validHazardMetadata(payload.metadata)) throw new LiveDataError('Live data service returned invalid hazard metadata')
  return payload as LiveDataResponse<T>
}

export async function getLiveDataAsset(resource: string, params: Record<string, string | number>): Promise<LiveDataAsset> {
  assertLiveDataResource(resource, true)
  const messages = assetMessages()
  const url = liveDataUrl(resource, params)
  const key = url.toString()
  const now = Date.now()
  const cached = assetCache.get(key)
  if (cached && cached.freshUntil > now) {
    touchAssetEntry(key, cached)
    return assetResult(cached, true)
  }
  if (cached && cached.staleUntil <= now) {
    assetCache.delete(key)
    assetCacheBytes -= cached.blob.size
  }
  const stale = cached && cached.staleUntil > now ? cached : undefined
  if ((assetRateLimitedUntil.get(resource) ?? 0) > now && stale) return { ...assetResult(stale), freshness: 'stale' }

  const existingRequest = assetRequests.get(key)
  if (existingRequest) return existingRequest

  const request = (async (): Promise<LiveDataAsset> => {
    try {
      const response = await fetch(url, {
        headers: await liveDataHeaders(),
        cache: 'default',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(LIVE_DATA_TIMEOUT_MS),
      })
      const retryMs = retryAfterMs(response)
      if (!response.ok) {
        if (response.status === 429) assetRateLimitedUntil.set(resource, Math.max(assetRateLimitedUntil.get(resource) ?? 0, Date.now() + (retryMs ?? 30_000)))
        if (stale && (response.status === 429 || response.status >= 500)) return { ...assetResult(stale), freshness: 'stale' }
        throw new LiveDataError(
          response.status === 429
            ? messages.busy
            : messages.unavailable,
          [],
          response.status,
          retryMs,
        )
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.startsWith('image/')) throw new LiveDataError('Live data asset returned an invalid content type', [], response.status)
      const blob = await response.blob()
      if (blob.size > MAX_ASSET_RESPONSE_BYTES) throw new LiveDataError('Live data asset exceeded the safe size limit', [], response.status)
      const sourceFreshness = response.headers.get('x-kalasag-cache-state') === 'stale' ? 'stale' : 'live'
      const rawCheckedAt = response.headers.get('x-kalasag-source-checked-at') ?? ''
      const checkedAt = Number.isFinite(Date.parse(rawCheckedAt)) ? rawCheckedAt : undefined
      return assetResult(cacheAsset(key, blob, sourceFreshness, checkedAt))
    } catch (error) {
      if (stale && (error instanceof TypeError || error instanceof DOMException || (error instanceof LiveDataError && (error.status === 429 || (error.status ?? 0) >= 500)))) {
        return { ...assetResult(stale), freshness: 'stale' }
      }
      if (error instanceof DOMException && error.name === 'TimeoutError') throw new LiveDataError(messages.timeout)
      if (error instanceof TypeError) throw new LiveDataError(messages.unreachable)
      throw error
    }
  })().finally(() => assetRequests.delete(key))

  assetRequests.set(key, request)
  return request
}
