import { createClient } from 'npm:@supabase/supabase-js@2.110.0'
import {
  NEWS_SOURCES,
  classifyNewsIncident,
  clusterNewsIncidents,
  extractLocationCandidates,
  incidentExpiry,
  marineIncidentLocation,
  parseSyndicationFeed,
  scorePhotonLocation,
  type NewsSource,
  type ParsedNewsArticle,
} from '../_shared/news-normalization.js'

const MAX_FEED_BYTES = 2 * 1024 * 1024
const MAX_GEOCODER_BYTES = 512 * 1024
const MAX_GEOCODES_PER_RUN = 8
const MAX_GEOCODER_CONCURRENCY = 2
const FEED_TIMEOUT_MS = 8_000
const RELAY_TIMEOUT_MS = 12_000
const GEOCODER_TIMEOUT_MS = 4_000
// pg_net allows 55 seconds for the scheduled request. Reserve several seconds
// for database cleanup/response so no upstream work can outlive that request.
const INVOCATION_BUDGET_MS = 50_000
const GEOCODE_RETRY_MS = 6 * 60 * 60 * 1000
const ARTICLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const FUNCTION_HEADERS = {
  'cache-control': 'no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
}

type SourceState = {
  source_id: string
  etag: string | null
  last_modified: string | null
}

type ExistingArticle = {
  id: string
  canonical_url: string
  title: string
  summary: string | null
  author: string | null
  published_at: string
  last_seen_at: string
  transport: string
  category: string | null
  is_hazard: boolean
  incident_expires_at: string | null
  resolved_at: string | null
  location_name: string | null
  location_query: string | null
  location_precision: string | null
  location_confidence: number | null
  latitude: number | null
  longitude: number | null
  location_resolution_status: 'not-required' | 'pending' | 'mapped' | 'unresolved'
  geocoding_attempted_at: string | null
}

type GeocodeBudget = {
  remaining: number
  active: number
  waiters: Array<() => void>
  deadlineAt: number
}

type IngestionResult = {
  sourceId: string
  status: 'live' | 'not-modified' | 'skipped' | 'unavailable'
  itemCount: number
  insertedOrUpdated: number
  errorStage?: string
}

const responseJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: FUNCTION_HEADERS,
})

function constantTimeTextEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length)
  let mismatch = left.length ^ right.length
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return mismatch === 0
}

function safeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Publisher feed is temporarily unavailable'
  if (/timeout|abort/i.test(error.name) || /timeout|abort/i.test(error.message)) return 'Publisher feed timed out'
  const status = error.message.match(/\bHTTP\s+(\d{3})\b/i)?.[1]
  if (status) return `Publisher feed returned HTTP ${status}`
  if (/invalid content type/i.test(error.message)) return 'Publisher feed returned an invalid content type'
  if (/size limit/i.test(error.message)) return 'Publisher feed exceeded the response size limit'
  if (/redirect/i.test(error.message)) return 'Publisher feed redirect was rejected'
  return 'Publisher feed is temporarily unavailable'
}

function hostnameAllowed(hostname: string, allowedHosts: string[]) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return allowedHosts.some(host => normalized === host)
}

function deadlineSignal(deadlineAt: number, callTimeoutMs: number) {
  const remaining = deadlineAt - Date.now()
  if (remaining <= 250) throw new DOMException('Invocation deadline reached', 'TimeoutError')
  return AbortSignal.timeout(Math.max(1, Math.min(callTimeoutMs, remaining)))
}

async function readLimitedText(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Response exceeded the size limit')
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
      throw new Error('Response exceeded the size limit')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function fetchPublisherFeedUrl(
  source: NewsSource,
  feedUrl: string,
  state: SourceState | null,
  deadlineAt: number,
) {
  let current = new URL(feedUrl)
  const expectsJson = source.format === 'wp-json'
  const requestHeaders: Record<string, string> = {
    accept: expectsJson
      ? 'application/json'
      : 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
    'user-agent': 'Mozilla/5.0 (compatible; KALASAG-NewsMonitor/1.0; metadata-only public-safety monitoring)',
  }
  if (state?.etag) requestHeaders['if-none-match'] = state.etag
  if (state?.last_modified) requestHeaders['if-modified-since'] = state.last_modified

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (
      current.protocol !== 'https:'
      || current.username
      || current.password
      || (current.port && current.port !== '443')
      || !hostnameAllowed(current.hostname, source.allowedFeedHosts)
    ) {
      throw new Error('Publisher feed redirect was rejected')
    }
    const upstream = await fetch(current, {
      headers: requestHeaders,
      redirect: 'manual',
      signal: deadlineSignal(deadlineAt, FEED_TIMEOUT_MS),
    })
    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get('location')
      if (!location || redirects === 3) throw new Error('Publisher feed redirected too many times')
      current = new URL(location, current)
      continue
    }
    if (upstream.status === 304) {
      return {
        notModified: true as const,
        body: '',
        etag: upstream.headers.get('etag') ?? state?.etag ?? null,
        lastModified: upstream.headers.get('last-modified') ?? state?.last_modified ?? null,
        cacheState: 'live' as const,
      }
    }
    if (!upstream.ok) throw new Error(`Publisher feed returned HTTP ${upstream.status}`)
    const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? ''
    if (
      expectsJson
        ? !/(?:application|text)\/(?:[\w.+-]*\+)?json\b/.test(contentType)
        : !/(?:xml|rss|atom)/.test(contentType)
    ) throw new Error('Publisher feed returned an invalid content type')
    return {
      notModified: false as const,
      body: await readLimitedText(upstream, MAX_FEED_BYTES),
      etag: upstream.headers.get('etag'),
      lastModified: upstream.headers.get('last-modified'),
      cacheState: 'live' as const,
    }
  }
  throw new Error('Publisher feed could not be reached')
}

async function fetchPublisherFeedViaRelay(
  source: NewsSource,
  state: SourceState | null,
  deadlineAt: number,
) {
  const relayValue = Deno.env.get('NEWS_RELAY_URL') ?? ''
  const relaySecret = Deno.env.get('NEWS_RELAY_SECRET') ?? ''
  if (!relayValue || !relaySecret) throw new Error('News source relay is not configured')

  let relayUrl: URL
  try {
    relayUrl = new URL(relayValue)
  } catch {
    throw new Error('News source relay URL is invalid')
  }
  if (
    relayUrl.protocol !== 'https:'
    || relayUrl.username
    || relayUrl.password
    || relayUrl.hash
    || relayUrl.search
    || (relayUrl.port && relayUrl.port !== '443')
  ) throw new Error('News source relay URL is invalid')
  relayUrl.searchParams.set('source', source.id)

  const headers: Record<string, string> = {
    accept: source.format === 'wp-json'
      ? 'application/json'
      : 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
    'x-kalasag-news-relay-secret': relaySecret,
  }
  if (state?.etag) headers['if-none-match'] = state.etag
  if (state?.last_modified) headers['if-modified-since'] = state.last_modified

  const response = await fetch(relayUrl, {
    method: 'GET',
    headers,
    redirect: 'manual',
    signal: deadlineSignal(deadlineAt, RELAY_TIMEOUT_MS),
  })
  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    throw new Error('News source relay redirect was rejected')
  }
  const cacheState = response.headers.get('x-kalasag-cache-state') === 'stale'
    ? 'stale' as const
    : 'live' as const
  if (response.status === 304) {
    return {
      notModified: true as const,
      body: '',
      etag: response.headers.get('etag') ?? state?.etag ?? null,
      lastModified: response.headers.get('last-modified') ?? state?.last_modified ?? null,
      cacheState,
    }
  }
  if (!response.ok) throw new Error(`News source relay returned HTTP ${response.status}`)
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (
    source.format === 'wp-json'
      ? !/(?:application|text)\/(?:[\w.+-]*\+)?json\b/.test(contentType)
      : !/(?:xml|rss|atom)/.test(contentType)
  ) throw new Error('News source relay returned an invalid content type')
  return {
    notModified: false as const,
    body: await readLimitedText(response, MAX_FEED_BYTES),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    cacheState,
  }
}

async function fetchPublisherFeed(source: NewsSource, state: SourceState | null, deadlineAt: number) {
  const feedUrls = [source.feedUrl, ...(source.fallbackFeedUrls ?? [])]
  let lastError: unknown = new Error('Publisher feed could not be reached')
  const fetchDirect = async () => {
    let directError: unknown = new Error('Publisher feed could not be reached')
    for (const feedUrl of feedUrls) {
      try {
        return await fetchPublisherFeedUrl(source, feedUrl, state, deadlineAt)
      } catch (error) {
        directError = error
        if (Date.now() >= deadlineAt - 500) break
      }
    }
    throw directError
  }
  const relayConfigured = Boolean(
    (Deno.env.get('NEWS_RELAY_URL') ?? '')
    && (Deno.env.get('NEWS_RELAY_SECRET') ?? ''),
  )
  const attempts = (
    source.fetchStrategy === 'relay-first' && relayConfigured
      ? [() => fetchPublisherFeedViaRelay(source, state, deadlineAt), fetchDirect]
      : relayConfigured
        ? [fetchDirect, () => fetchPublisherFeedViaRelay(source, state, deadlineAt)]
        : [fetchDirect]
  )
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
      if (Date.now() >= deadlineAt - 500) break
    }
  }
  throw lastError
}

async function geocodeCandidate(candidate: string, deadlineAt: number) {
  const endpoint = new URL('https://photon.komoot.io/api')
  endpoint.searchParams.set('q', `${candidate}, Philippines`)
  endpoint.searchParams.set('countrycode', 'PH')
  endpoint.searchParams.set('bbox', '116,4.5,127.5,21.5')
  endpoint.searchParams.set('lang', 'en')
  endpoint.searchParams.set('limit', '5')
  const response = await fetch(endpoint, {
    headers: {
      accept: 'application/json',
      'user-agent': 'KALASAG-NewsMonitor/1.0 (public-safety geocoding)',
    },
    signal: deadlineSignal(deadlineAt, GEOCODER_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Geocoder returned HTTP ${response.status}`)
  const payload = JSON.parse(await readLimitedText(response, MAX_GEOCODER_BYTES))
  const scored = (Array.isArray(payload?.features) ? payload.features : [])
    .map((feature: unknown) => scorePhotonLocation(candidate, feature))
    .filter(Boolean)
    .sort((left: any, right: any) => right.locationConfidence - left.locationConfidence)
  return scored[0] ?? null
}

async function acquireGeocodePermit(budget: GeocodeBudget) {
  // Count *HTTP attempts*, not queued candidates. This makes the eight-request
  // ceiling exact even when several sources and retry work run concurrently.
  while (budget.active >= MAX_GEOCODER_CONCURRENCY) {
    if (budget.remaining <= 0 || Date.now() >= budget.deadlineAt - 250) return false
    let wake: (() => void) | null = null
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const outcome = await new Promise<'slot' | 'timeout'>(resolve => {
      wake = () => resolve('slot')
      budget.waiters.push(wake)
      timeoutId = setTimeout(() => resolve('timeout'), Math.max(1, budget.deadlineAt - Date.now() - 250))
    })
    if (timeoutId !== null) clearTimeout(timeoutId)
    if (wake) {
      const index = budget.waiters.indexOf(wake)
      if (index >= 0) budget.waiters.splice(index, 1)
    }
    if (outcome === 'timeout') return false
  }
  if (budget.remaining <= 0 || Date.now() >= budget.deadlineAt - 250) return false
  budget.remaining -= 1
  budget.active += 1
  return true
}

function releaseGeocodePermit(budget: GeocodeBudget) {
  budget.active = Math.max(0, budget.active - 1)
  budget.waiters.shift()?.()
}

async function geocodeArticle(article: ParsedNewsArticle, budget: GeocodeBudget) {
  let attempted = false
  const marine = marineIncidentLocation(article.title, article.summary ?? '')
  if (marine.isMaritimeIncident) {
    // Do not query an administrative place (for example, Romblon) for a boat
    // fire. Only publisher-supplied offshore coordinates can create a marker.
    return { result: marine.coordinate, attempted: true }
  }
  const candidates = extractLocationCandidates(article.title, article.summary ?? '')
  if (!candidates.length) return { result: null, attempted: true }
  for (const candidate of candidates) {
    if (!(await acquireGeocodePermit(budget))) break
    attempted = true
    try {
      const result = await geocodeCandidate(candidate, budget.deadlineAt)
      if (result) return { result, attempted }
    } catch {
      // Do not fall through to a lower-priority (for example, where people
      // felt an earthquake rather than its epicenter) candidate after a
      // transport/rate-limit failure. Keep the item list-only for the
      // database-backed retry instead.
      break
    } finally {
      releaseGeocodePermit(budget)
    }
  }
  return { result: null, attempted }
}

async function mapWithConcurrency<Value, Result>(
  values: Value[],
  limit: number,
  worker: (value: Value, index: number) => Promise<Result>,
) {
  const results = new Array<Result>(values.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(values[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

function articleRow(
  article: ParsedNewsArticle,
  existing: ExistingArticle | undefined,
  geocode: any,
  geocodeAttempted: boolean,
) {
  const classification = classifyNewsIncident(article.title, article.summary ?? '')
  const marine = marineIncidentLocation(article.title, article.summary ?? '')
  const existingContentMatches = articleContentMatches(existing, article, classification.category)
  const location = marine.isMaritimeIncident
    ? marine.coordinate
    : classification.isHazard
    && existingContentMatches
    && existing?.latitude !== null
    && existing?.latitude !== undefined
    ? {
        locationName: existing.location_name,
        locationQuery: existing.location_query,
        locationPrecision: existing.location_precision,
        locationConfidence: existing.location_confidence,
        lat: existing.latitude,
        lng: existing.longitude,
      }
    : geocode
  const incidentExpiresAt = classification.category
    ? incidentExpiry(article.publishedAt, classification.category, classification.resolved)
    : null

  return {
    source_id: article.sourceId,
    source_name: article.sourceName,
    source_home_url: article.sourceHomeUrl,
    canonical_url: article.canonicalUrl,
    title: article.title,
    summary: article.summary,
    author: article.author,
    published_at: article.publishedAt,
    last_seen_at: article.detectedAt,
    transport: article.transport,
    category: classification.category,
    is_hazard: classification.isHazard,
    incident_expires_at: incidentExpiresAt,
    // Preserve the original resolved observation. Replacing it with the latest
    // polling time would make an unchanged resolved feed item write every run.
    resolved_at: classification.resolved
      ? (existingContentMatches ? existing?.resolved_at ?? article.detectedAt : article.detectedAt)
      : null,
    location_name: location?.locationName ?? null,
    location_query: location?.locationQuery ?? null,
    location_precision: location?.locationPrecision ?? null,
    location_confidence: location?.locationConfidence ?? null,
    latitude: location?.locationConfidence >= 0.7 ? location.lat : null,
    longitude: location?.locationConfidence >= 0.7 ? location.lng : null,
    location_resolution_status: !classification.isHazard
      ? 'not-required'
      : location?.locationConfidence >= 0.7
        ? 'mapped'
        : geocodeAttempted || existing?.location_resolution_status === 'unresolved'
          ? 'unresolved'
          : 'pending',
    geocoding_attempted_at: geocodeAttempted
      ? article.detectedAt
      : existing?.geocoding_attempted_at ?? null,
    proximity_alert_eligible: false,
    updated_at: article.detectedAt,
  }
}

function articleContentMatches(
  existing: ExistingArticle | undefined,
  article: ParsedNewsArticle,
  category: string | null,
) {
  return Boolean(
    existing
    && existing.title === article.title
    && (existing.summary ?? null) === (article.summary ?? null)
    && (existing.author ?? null) === (article.author ?? null)
    && existing.transport === article.transport
    && existing.category === category
    && sameTimestamp(existing.published_at, article.publishedAt),
  )
}

function sameTimestamp(left: unknown, right: unknown) {
  if (left == null && right == null) return true
  const leftTime = Date.parse(String(left ?? ''))
  const rightTime = Date.parse(String(right ?? ''))
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime
}

function sameNullableNumber(left: unknown, right: unknown) {
  if (left == null && right == null) return true
  const a = Number(left), b = Number(right)
  return Number.isFinite(a) && Number.isFinite(b) && a === b
}

function needsArticleWrite(existing: ExistingArticle | undefined, row: Record<string, any>) {
  if (!existing) return true
  // Do not create a write/Realtime event merely because an unchanged feed was
  // observed again. Article writes are reserved for meaningfully changed
  // publisher metadata, classification, expiry, or resolved location state.
  const textFields = [
    'title',
    'summary',
    'author',
    'transport',
    'category',
    'resolved_at',
    'location_name',
    'location_query',
    'location_precision',
    'location_resolution_status',
    'geocoding_attempted_at',
  ]
  if (textFields.some(field => ((existing as any)[field] ?? null) !== (row[field] ?? null))) return true
  if (
    existing.is_hazard !== row.is_hazard
    || !sameTimestamp(existing.published_at, row.published_at)
    || !sameTimestamp(existing.incident_expires_at, row.incident_expires_at)
    || !sameNullableNumber(existing.location_confidence, row.location_confidence)
    || !sameNullableNumber(existing.latitude, row.latitude)
    || !sameNullableNumber(existing.longitude, row.longitude)
  ) return true
  return false
}

async function updateSourceState(
  supabase: ReturnType<typeof createClient>,
  source: NewsSource,
  values: Record<string, unknown>,
) {
  const { error } = await supabase
    .from('news_sources')
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq('source_id', source.id)
  if (error) throw error
}

async function fetchExistingArticles(
  supabase: ReturnType<typeof createClient>,
  sourceId: string,
  canonicalUrls: string[],
) {
  const rows: ExistingArticle[] = []
  // Canonical URLs can legally approach 2 KB. Keep the PostgREST URL safely
  // bounded instead of placing an entire 100-item feed in one `.in()` filter.
  for (let index = 0; index < canonicalUrls.length; index += 20) {
    const urls = canonicalUrls.slice(index, index + 20)
    const { data, error } = await supabase
      .from('news_articles')
      .select('id, canonical_url, title, summary, author, published_at, last_seen_at, transport, category, is_hazard, incident_expires_at, resolved_at, location_name, location_query, location_precision, location_confidence, latitude, longitude, location_resolution_status, geocoding_attempted_at')
      .eq('source_id', sourceId)
      .in('canonical_url', urls)
    if (error) throw error
    rows.push(...((data ?? []) as ExistingArticle[]))
  }
  return rows
}

async function deleteExcludedCurrentArticles(
  supabase: ReturnType<typeof createClient>,
  sourceId: string,
  canonicalUrls: string[],
) {
  let deleted = 0
  for (let index = 0; index < canonicalUrls.length; index += 20) {
    const urls = canonicalUrls.slice(index, index + 20)
    const { data, error } = await supabase
      .from('news_articles')
      .delete()
      .eq('source_id', sourceId)
      .in('canonical_url', urls)
      .select('id')
    if (error) throw error
    deleted += data?.length ?? 0
  }
  return deleted
}

async function ingestSource(
  supabase: ReturnType<typeof createClient>,
  source: NewsSource,
  geocodeBudget: GeocodeBudget,
): Promise<IngestionResult> {
  let stage = 'claim'
  const checkedAt = new Date().toISOString()
  try {
    const { data: claimed, error: claimError } = await supabase.rpc('claim_news_source_poll', {
      p_source_id: source.id,
    })
    if (claimError) throw claimError
    if (!claimed) return { sourceId: source.id, status: 'skipped', itemCount: 0, insertedOrUpdated: 0 }

    stage = 'source-state'
    const { data: state, error: stateError } = await supabase
      .from('news_sources')
      .select('source_id, etag, last_modified')
      .eq('source_id', source.id)
      .maybeSingle()
    if (stateError) throw stateError

    stage = 'feed-fetch'
    const fetched = await fetchPublisherFeed(source, state as SourceState | null, geocodeBudget.deadlineAt)
    if (fetched.notModified) {
      stage = 'source-update'
      await updateSourceState(supabase, source, {
        health_status: fetched.cacheState === 'stale' ? 'unavailable' : 'live',
        ...(fetched.cacheState === 'stale' ? {} : { last_success_at: checkedAt }),
        last_error: fetched.cacheState === 'stale'
          ? 'Publisher relay is serving a bounded stale cache'
          : null,
        etag: fetched.etag,
        last_modified: fetched.lastModified,
      })
      return {
        sourceId: source.id,
        status: fetched.cacheState === 'stale' ? 'unavailable' : 'not-modified',
        itemCount: 0,
        insertedOrUpdated: 0,
      }
    }

    stage = 'feed-parse'
    const parsedFeed = parseSyndicationFeed(fetched.body, source, checkedAt).slice(0, 100)
    if (!parsedFeed.length) throw new Error('Publisher feed contained no valid current entries')
    const parsed = parsedFeed.filter(article => (
      classifyNewsIncident(article.title, article.summary ?? '').category !== null
    ))
    const excludedUrls = parsedFeed
      .filter(article => !parsed.some(current => current.canonicalUrl === article.canonicalUrl))
      .map(article => article.canonicalUrl)
    if (excludedUrls.length) {
      stage = 'article-prune'
      await deleteExcludedCurrentArticles(supabase, source.id, excludedUrls)
    }
    const currentUrls = parsed.map(article => article.canonicalUrl)
    // Query exactly the feed URLs instead of an arbitrary retained-row window.
    // A busy source can retain more than 500 articles, and a current item must
    // still retain its previously resolved map coordinate.
    stage = 'article-read'
    const existingRows = await fetchExistingArticles(supabase, source.id, currentUrls)
    const existingByUrl = new Map(
      (existingRows ?? []).map((row: ExistingArticle) => [row.canonical_url, row]),
    )

    stage = 'article-normalize'
    const candidateRows = await mapWithConcurrency(parsed, 2, async article => {
      const existing = existingByUrl.get(article.canonicalUrl)
      const classification = classifyNewsIncident(article.title, article.summary ?? '')
      const existingContentMatches = articleContentMatches(existing, article, classification.category)
      let geocode = null
      let geocodeAttempted = false
      const lastGeocodingAttempt = Date.parse(existing?.geocoding_attempted_at ?? '')
      const canRetryGeocoding = !existingContentMatches
        || !Number.isFinite(lastGeocodingAttempt)
        || Date.now() - lastGeocodingAttempt >= 6 * 60 * 60 * 1000
      if (
        classification.isHazard
        && (!existingContentMatches || existing?.latitude == null)
        && canRetryGeocoding
      ) {
        const outcome = await geocodeArticle(article, geocodeBudget)
        geocodeAttempted = outcome.attempted
        geocode = outcome.result
      }
      const row = articleRow(article, existing, geocode, geocodeAttempted)
      return needsArticleWrite(existing, row) ? row : null
    })
    const rows = candidateRows.filter(Boolean)

    if (rows.length) {
      stage = 'article-write'
      const { error: upsertError } = await supabase
        .from('news_articles')
        .upsert(rows, { onConflict: 'canonical_url' })
      if (upsertError) throw upsertError
    }

    stage = 'source-update'
    await updateSourceState(supabase, source, {
      health_status: fetched.cacheState === 'stale' ? 'unavailable' : 'live',
      ...(fetched.cacheState === 'stale' ? {} : { last_success_at: checkedAt }),
      last_error: fetched.cacheState === 'stale'
        ? 'Publisher relay is serving a bounded stale cache'
        : null,
      item_count: parsed.length,
      etag: fetched.etag,
      last_modified: fetched.lastModified,
      transport: source.transport,
    })
    return {
      sourceId: source.id,
      status: fetched.cacheState === 'stale' ? 'unavailable' : 'live',
      itemCount: parsed.length,
      insertedOrUpdated: rows.length,
    }
  } catch (error) {
    await updateSourceState(supabase, source, {
      health_status: 'unavailable',
      last_error: `${safeErrorMessage(error)} [${stage}]`,
    }).catch(() => undefined)
    return {
      sourceId: source.id,
      status: 'unavailable',
      itemCount: 0,
      insertedOrUpdated: 0,
      errorStage: stage,
    }
  }
}

async function isolatedIngestSource(
  supabase: ReturnType<typeof createClient>,
  source: NewsSource,
  geocodeBudget: GeocodeBudget,
): Promise<IngestionResult> {
  try {
    return await ingestSource(supabase, source, geocodeBudget)
  } catch (error) {
    await updateSourceState(supabase, source, {
      health_status: 'unavailable',
      last_error: `${safeErrorMessage(error)} [source-lifecycle]`,
    }).catch(() => undefined)
    return {
      sourceId: source.id,
      status: 'unavailable',
      itemCount: 0,
      insertedOrUpdated: 0,
      errorStage: 'source-lifecycle',
    }
  }
}

async function retryPendingGeocodes(
  supabase: ReturnType<typeof createClient>,
  budget: GeocodeBudget,
) {
  if (budget.remaining <= 0 || Date.now() >= budget.deadlineAt - 2_000) {
    return { reviewed: 0, attempted: 0, mapped: 0 }
  }
  const now = new Date().toISOString()
  const retryBefore = new Date(Date.now() - GEOCODE_RETRY_MS).toISOString()
  const { data, error } = await supabase
    .from('news_articles')
    .select('id, source_id, source_name, source_home_url, canonical_url, title, summary, author, published_at, last_seen_at, transport, category, is_hazard, incident_expires_at, resolved_at, location_name, location_query, location_precision, location_confidence, latitude, longitude, location_resolution_status, geocoding_attempted_at')
    .eq('is_hazard', true)
    .gt('incident_expires_at', now)
    .in('location_resolution_status', ['pending', 'unresolved'])
    .or(`geocoding_attempted_at.is.null,geocoding_attempted_at.lte.${retryBefore}`)
    .order('geocoding_attempted_at', { ascending: true, nullsFirst: true })
    .limit(16)
  if (error) throw error

  let attempted = 0
  let mapped = 0
  await mapWithConcurrency(data ?? [], MAX_GEOCODER_CONCURRENCY, async row => {
    if (budget.remaining <= 0 || Date.now() >= budget.deadlineAt - 2_000) return
    const article: ParsedNewsArticle = {
      sourceId: row.source_id,
      sourceName: row.source_name,
      sourceHomeUrl: row.source_home_url,
      canonicalUrl: row.canonical_url,
      title: row.title,
      summary: row.summary,
      author: row.author,
      publishedAt: row.published_at,
      detectedAt: now,
      transport: row.transport,
    }
    const outcome = await geocodeArticle(article, budget)
    if (!outcome.attempted) return
    attempted += 1
    if (outcome.result?.locationConfidence >= 0.7) mapped += 1
    const { error: updateError } = await supabase
      .from('news_articles')
      .update({
        location_name: outcome.result?.locationName ?? null,
        location_query: outcome.result?.locationQuery ?? null,
        location_precision: outcome.result?.locationPrecision ?? null,
        location_confidence: outcome.result?.locationConfidence ?? null,
        latitude: outcome.result?.locationConfidence >= 0.7 ? outcome.result.lat : null,
        longitude: outcome.result?.locationConfidence >= 0.7 ? outcome.result.lng : null,
        location_resolution_status: outcome.result?.locationConfidence >= 0.7 ? 'mapped' : 'unresolved',
        geocoding_attempted_at: now,
        updated_at: now,
      })
      .eq('id', row.id)
    if (updateError) throw updateError
  })
  return { reviewed: (data ?? []).length, attempted, mapped }
}

async function reconcileCorroboration(supabase: ReturnType<typeof createClient>) {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('news_articles')
    .select('id, source_id, title, summary, category, published_at, location_name, verification_status, corroborating_sources')
    .eq('is_hazard', true)
    .gt('incident_expires_at', now)
    .order('published_at', { ascending: false })
    .limit(300)
  if (error) throw error
  if (!data) return

  const clustered = clusterNewsIncidents(data)
  const changes = data.flatMap(article => {
    const next = clustered.get(String(article.id))
    if (!next) return []
    const currentSources = Array.isArray(article.corroborating_sources)
      ? [...article.corroborating_sources].map(String).sort()
      : []
    if (
      article.verification_status === next.verificationStatus
      && JSON.stringify(currentSources) === JSON.stringify(next.corroboratingSources)
    ) return []
    return [{ id: article.id, ...next }]
  })

  await mapWithConcurrency(changes, 4, async change => {
    const { error: updateError } = await supabase
      .from('news_articles')
      .update({
        verification_status: change.verificationStatus,
        corroborating_sources: change.corroboratingSources,
        updated_at: now,
      })
      .eq('id', change.id)
    if (updateError) throw updateError
  })
}

Deno.serve(async request => {
  if (request.method !== 'POST') {
    const response = responseJson({ error: 'Method not allowed' }, 405)
    response.headers.set('allow', 'POST')
    return response
  }

  const expectedIngestSecret = Deno.env.get('NEWS_INGEST_SECRET') ?? ''
  const suppliedIngestSecret = request.headers.get('x-kalasag-ingest-secret') ?? ''
  if (!expectedIngestSecret) return responseJson({ error: 'News ingestion is not configured' }, 503)
  if (!constantTimeTextEqual(expectedIngestSecret, suppliedIngestSecret)) {
    return responseJson({ error: 'Unauthorized' }, 401)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  if (!supabaseUrl || !serviceRoleKey) return responseJson({ error: 'News ingestion is not configured' }, 503)

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'x-kalasag-worker': 'news-ingest' } },
  })

  const enabledSources = NEWS_SOURCES.filter(source => source.enabled)
  const geocodeBudget: GeocodeBudget = {
    remaining: MAX_GEOCODES_PER_RUN,
    active: 0,
    waiters: [],
    deadlineAt: Date.now() + INVOCATION_BUDGET_MS,
  }
  // A broken publisher must never prevent the remaining publishers or the
  // database-backed pending-geocode queue from progressing.
  const results = await Promise.all(
    enabledSources.map(source => isolatedIngestSource(supabase, source, geocodeBudget)),
  )
  const maintenanceErrors: string[] = []
  let retry = { reviewed: 0, attempted: 0, mapped: 0 }
  if (Date.now() < geocodeBudget.deadlineAt - 2_000) {
    try {
      retry = await retryPendingGeocodes(supabase, geocodeBudget)
    } catch {
      // Keep publisher results available, but expose the maintenance delay to
      // the scheduler/manual caller rather than silently dropping it.
      maintenanceErrors.push('Pending geocode maintenance was delayed')
    }
  }
  if (results.some(result => result.status !== 'skipped')) {
    if (Date.now() < geocodeBudget.deadlineAt - 1_500) {
      try {
        await reconcileCorroboration(supabase)
      } catch {
        maintenanceErrors.push('Corroboration maintenance was delayed')
      }
    }
    if (Date.now() < geocodeBudget.deadlineAt - 750) {
      const { error: retentionError } = await supabase
        .from('news_articles')
        .delete()
        .lt('published_at', new Date(Date.now() - ARTICLE_RETENTION_MS).toISOString())
      if (retentionError) maintenanceErrors.push('News retention cleanup was delayed')
    }
  }

  const liveCount = results.filter(result => result.status === 'live' || result.status === 'not-modified').length
  return responseJson({
    ok: liveCount > 0 || results.every(result => result.status === 'skipped'),
    checkedAt: new Date().toISOString(),
    sources: results,
    pendingGeocodes: retry,
    maintenanceErrors,
  }, liveCount > 0 || results.every(result => result.status === 'skipped') ? 200 : 503)
})
