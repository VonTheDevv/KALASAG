import { supabase } from './supabase'

export type NewsCategory =
  | 'fire'
  | 'flood'
  | 'road-incident'
  | 'killing'
  | 'robbery-theft'
  | 'typhoon'
  | 'earthquake'
  | 'security-conflict'

export type NewsVerification = 'news-reported' | 'multiple-outlets-reported'
export type NewsLocationPrecision = 'street' | 'locality' | 'region' | 'offshore'

export type NewsArticle = {
  id: string
  sourceId: string
  sourceName: string
  sourceHomeUrl: string
  articleUrl: string
  title: string
  summary: string | null
  author: string | null
  publishedAt: string
  firstDetectedAt: string
  lastSeenAt: string
  transport: string
  category: NewsCategory
  isHazard: true
  incidentExpiresAt: string | null
  resolvedAt: string | null
  locationName: string | null
  locationQuery: string | null
  locationPrecision: NewsLocationPrecision | null
  locationConfidence: number | null
  lat: number | null
  lng: number | null
  verification: NewsVerification
  corroboratingSources: string[]
  proximityAlertEligible: false
}

export type NewsSourceStatus = {
  id: string
  name: string
  homeUrl: string
  ingestionStatus: 'enabled' | 'disabled_pending_permission'
  healthStatus: 'live' | 'unknown' | 'unavailable' | 'disabled'
  detail: string
  transport: string
  lastCheckedAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  itemCount: number
  pollIntervalSeconds: number
  isStale: boolean
}

export type NewsSnapshot = {
  articles: NewsArticle[]
  sources: NewsSourceStatus[]
  fetchedAt: string
}

const NEWS_SOURCE_HOSTS: Record<string, { home: string[]; article: string[] }> = {
  'gma-news': { home: ['gmanetwork.com'], article: ['gmanetwork.com'] },
  'abs-cbn-news': { home: ['abs-cbn.com'], article: ['abs-cbn.com'] },
  'daily-tribune': { home: ['tribune.net.ph'], article: ['tribune.net.ph'] },
  'inquirer-newsinfo': { home: ['inquirer.net'], article: ['newsinfo.inquirer.net'] },
  'manila-standard': { home: ['manilastandard.net'], article: ['manilastandard.net'] },
}
const NEWS_CATEGORIES = new Set<NewsCategory>([
  'fire',
  'flood',
  'road-incident',
  'killing',
  'robbery-theft',
  'typhoon',
  'earthquake',
  'security-conflict',
])
const NEWS_VERIFICATIONS = new Set<NewsVerification>([
  'news-reported',
  'multiple-outlets-reported',
])
const NEWS_LOCATION_PRECISIONS = new Set<NewsLocationPrecision>(['street', 'locality', 'region', 'offshore'])
const NEWS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
// Realtime delivers changes promptly; this is only the visible-app fallback.
export const NEWS_REFRESH_INTERVAL_MS = 180_000
const NEWS_FETCH_TIMEOUT_MS = 12_000
const NEWS_STALE_MINIMUM_MS = 5 * 60_000

function optionalString(value: unknown, limit: number) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, limit) : null
}

function validTimestamp(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function validSourceUrl(value: unknown, sourceId: string, kind: 'home' | 'article') {
  try {
    const url = new URL(String(value ?? ''))
    if (url.protocol !== 'https:' || url.username || url.password) return null
    const hostname = url.hostname.toLowerCase()
    const allowed = NEWS_SOURCE_HOSTS[sourceId]?.[kind] ?? []
    return allowed.some(host => hostname === host || hostname.endsWith(`.${host}`)) ? url.toString() : null
  } catch {
    return null
  }
}

function normalizeNewsArticle(value: unknown): NewsArticle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = optionalString(row.id, 80)
  const sourceId = optionalString(row.source_id, 64)
  const sourceName = optionalString(row.source_name, 100)
  const title = optionalString(row.title, 280)
  const publishedAt = validTimestamp(row.published_at)
  const firstDetectedAt = validTimestamp(row.first_detected_at)
  const lastSeenAt = validTimestamp(row.last_seen_at)
  if (!id || !sourceId || !sourceName || !title || !publishedAt || !firstDetectedAt || !lastSeenAt) return null
  if (Date.parse(publishedAt) < Date.now() - NEWS_RETENTION_MS - 60_000) return null
  const sourceHomeUrl = validSourceUrl(row.source_home_url, sourceId, 'home')
  const articleUrl = validSourceUrl(row.canonical_url, sourceId, 'article')
  if (!sourceHomeUrl || !articleUrl) return null

  if (typeof row.category !== 'string' || !NEWS_CATEGORIES.has(row.category as NewsCategory)) return null
  const category = row.category as NewsCategory
  if (row.is_hazard !== true) return null
  const isHazard = true as const
  const incidentExpiresAt = validTimestamp(row.incident_expires_at)
  if (isHazard && !incidentExpiresAt) return null

  const locationConfidenceValue = Number(row.location_confidence)
  const locationConfidence = Number.isFinite(locationConfidenceValue)
    && locationConfidenceValue >= 0
    && locationConfidenceValue <= 1
    ? locationConfidenceValue
    : null
  const latitude = Number(row.latitude), longitude = Number(row.longitude)
  const hasCoordinates = Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= 4.5
    && latitude <= 21.5
    && longitude >= 116
    && longitude <= 127.5
    && (locationConfidence ?? 0) >= 0.7
  const locationPrecision = typeof row.location_precision === 'string'
    && NEWS_LOCATION_PRECISIONS.has(row.location_precision as NewsLocationPrecision)
    ? row.location_precision as NewsLocationPrecision
    : null
  const verification = typeof row.verification_status === 'string'
    && NEWS_VERIFICATIONS.has(row.verification_status as NewsVerification)
    ? row.verification_status as NewsVerification
    : 'news-reported'

  return {
    id,
    sourceId,
    sourceName,
    sourceHomeUrl,
    articleUrl,
    title,
    summary: optionalString(row.summary, 600),
    author: optionalString(row.author, 160),
    publishedAt,
    firstDetectedAt,
    lastSeenAt,
    transport: optionalString(row.transport, 80) ?? 'publisher-metadata',
    category,
    isHazard,
    incidentExpiresAt,
    resolvedAt: validTimestamp(row.resolved_at),
    locationName: optionalString(row.location_name, 160),
    locationQuery: optionalString(row.location_query, 160),
    locationPrecision,
    locationConfidence,
    lat: hasCoordinates ? latitude : null,
    lng: hasCoordinates ? longitude : null,
    verification,
    corroboratingSources: Array.isArray(row.corroborating_sources)
      ? [...new Set(row.corroborating_sources.filter(item => typeof item === 'string').map(String))].slice(0, 10)
      : [],
    proximityAlertEligible: false,
  }
}

function normalizeNewsSource(value: unknown, now = Date.now()): NewsSourceStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = optionalString(row.source_id, 64)
  const name = optionalString(row.source_name, 100)
  const detail = optionalString(row.status_detail, 500)
  const ingestionStatus = row.ingestion_status
  const healthStatus = row.health_status
  if (
    !id
    || !name
    || !detail
    || !['enabled', 'disabled_pending_permission'].includes(String(ingestionStatus))
    || !['live', 'unknown', 'unavailable', 'disabled'].includes(String(healthStatus))
  ) return null
  const homeUrl = validSourceUrl(row.source_home_url, id, 'home')
  if (!homeUrl) return null
  const itemCount = Number(row.item_count)
  const pollIntervalSeconds = Number(row.poll_interval_seconds)
  if (!Number.isInteger(pollIntervalSeconds) || pollIntervalSeconds < 45 || pollIntervalSeconds > 86_400) return null
  const lastCheckedAt = validTimestamp(row.last_checked_at)
  const updatedAt = validTimestamp(row.updated_at)
  const staleAfterMs = Math.max(NEWS_STALE_MINIMUM_MS, pollIntervalSeconds * 3 * 1000)
  const healthReferenceAt = lastCheckedAt ?? updatedAt
  const isStale = ingestionStatus === 'enabled'
    && (healthStatus === 'live' || healthStatus === 'unknown')
    && (!healthReferenceAt || now - Date.parse(healthReferenceAt) > staleAfterMs)
  return {
    id,
    name,
    homeUrl,
    ingestionStatus: ingestionStatus as NewsSourceStatus['ingestionStatus'],
    healthStatus: isStale ? 'unavailable' : healthStatus as NewsSourceStatus['healthStatus'],
    detail,
    transport: optionalString(row.transport, 80) ?? 'publisher-metadata',
    lastCheckedAt,
    lastSuccessAt: validTimestamp(row.last_success_at),
    lastError: optionalString(row.last_error, 300),
    itemCount: Number.isInteger(itemCount) && itemCount >= 0 ? itemCount : 0,
    pollIntervalSeconds,
    isStale,
  }
}

export async function fetchNewsSnapshot(): Promise<NewsSnapshot> {
  const cutoff = new Date(Date.now() - NEWS_RETENTION_MS).toISOString()
  const now = new Date().toISOString()
  const articleFields = [
    'id', 'source_id', 'source_name', 'source_home_url', 'canonical_url', 'title', 'summary', 'author',
    'published_at', 'first_detected_at', 'last_seen_at', 'transport', 'category', 'is_hazard',
    'incident_expires_at', 'resolved_at', 'location_name', 'location_query', 'location_precision',
    'location_confidence', 'latitude', 'longitude', 'verification_status', 'corroborating_sources',
    'proximity_alert_eligible',
  ].join(',')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), NEWS_FETCH_TIMEOUT_MS)
  try {
    const [articleResult, activeHazardResult, sourceResult] = await Promise.all([
    supabase
      .from('news_articles')
      .select(articleFields)
      .gte('published_at', cutoff)
      .order('published_at', { ascending: false })
      .limit(300)
      .abortSignal(controller.signal),
    // Active mapped incidents may be older than the newest 300 monitored reports.
    // Fetch them separately so the map never loses a still-valid safety marker.
    supabase
      .from('news_articles')
      .select(articleFields)
      .eq('is_hazard', true)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .gt('incident_expires_at', now)
      .order('incident_expires_at', { ascending: true })
      .limit(300)
      .abortSignal(controller.signal),
    supabase
      .from('news_sources')
      .select([
        'source_id',
        'source_name',
        'source_home_url',
        'ingestion_status',
        'health_status',
        'status_detail',
        'transport',
        'last_checked_at',
        'last_success_at',
        'last_error',
        'item_count',
        'poll_interval_seconds',
        'updated_at',
      ].join(','))
      .order('source_name')
      .abortSignal(controller.signal),
    ])
  if (articleResult.error) throw new Error('News articles are temporarily unavailable')
   if (activeHazardResult.error) throw new Error('Active news incidents are temporarily unavailable')
  if (sourceResult.error) throw new Error('News source status is temporarily unavailable')

    const rows = new Map<string, unknown>()
    for (const value of [...(articleResult.data ?? []), ...(activeHazardResult.data ?? [])]) {
      if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).id === 'string') {
        rows.set((value as Record<string, unknown>).id as string, value)
      }
    }

    return {
    articles: [...rows.values()].flatMap(value => {
      const article = normalizeNewsArticle(value)
      return article ? [article] : []
    }).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt)),
    sources: (sourceResult.data ?? []).flatMap(value => {
      const source = normalizeNewsSource(value, Date.now())
      return source ? [source] : []
    }),
    fetchedAt: new Date().toISOString(),
    }
  } catch (cause) {
    if (controller.signal.aborted) throw new Error('News monitoring request timed out')
    throw cause
  } finally {
    window.clearTimeout(timeout)
  }
}

export function activeNewsIncidents(articles: NewsArticle[], now = Date.now()) {
  return articles.filter(article => (
    article.isHazard
    && article.lat !== null
    && article.lng !== null
    && article.locationConfidence !== null
    && article.locationConfidence >= 0.7
    && article.incidentExpiresAt !== null
    && Date.parse(article.incidentExpiresAt) > now
  ))
}

export function newsCategoryLabel(category: NewsCategory) {
  switch (category) {
    case 'fire': return 'Fire'
    case 'flood': return 'Flood'
    case 'road-incident': return 'Vehicle / road accident'
    case 'killing': return 'Killing / murder'
    case 'robbery-theft': return 'Robbery / theft'
    case 'typhoon': return 'Typhoon / storm'
    case 'earthquake': return 'Earthquake'
    case 'security-conflict': return 'Security / armed conflict'
  }
}

export function newsCategoryColor(category: NewsCategory) {
  switch (category) {
    case 'fire': return '#f97316'
    case 'flood': return '#3b82f6'
    case 'road-incident': return '#f59e0b'
    case 'killing': return '#dc2626'
    case 'robbery-theft': return '#9333ea'
    case 'typhoon': return '#ef4444'
    case 'earthquake': return '#eab308'
    case 'security-conflict': return '#b91c1c'
  }
}
