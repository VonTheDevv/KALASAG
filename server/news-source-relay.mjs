import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import process from 'node:process'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { NEWS_SOURCES } from '../supabase/functions/_shared/news-normalization.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8791
const RELAY_PATH = '/internal/news-source'
const HEALTH_PATH = '/healthz'
const MAX_FEED_BYTES = 2 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 10_000
const FRESH_MS = 60_000
const STALE_MS = 15 * 60_000

function nativeHttpsFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      headers: options.headers,
      signal: options.signal,
    }, upstream => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item)
        } else if (value !== undefined) {
          headers.set(name, value)
        }
      }
      const status = Number(upstream.statusCode || 502)
      const body = status === 204 || status === 304 ? null : Readable.toWeb(upstream)
      resolve(new Response(body, {
        status,
        statusText: upstream.statusMessage,
        headers,
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

function secretMatches(expected, supplied) {
  const expectedBuffer = Buffer.from(String(expected ?? ''), 'utf8')
  const suppliedBuffer = Buffer.from(String(supplied ?? ''), 'utf8')
  if (expectedBuffer.length !== suppliedBuffer.length) return false
  return timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function hostnameAllowed(hostname, allowedHosts) {
  const normalized = String(hostname ?? '').toLowerCase().replace(/\.$/, '')
  return allowedHosts.some(host => normalized === host)
}

function validContentType(source, contentType) {
  const normalized = String(contentType ?? '').toLowerCase()
  return source.format === 'wp-json'
    ? /(?:application|text)\/(?:[\w.+-]*\+)?json\b/.test(normalized)
    : /(?:xml|rss|atom)/.test(normalized)
}

async function readLimitedBuffer(response, maxBytes = MAX_FEED_BYTES) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Publisher response exceeded the size limit')
  }
  if (!response.body) throw new Error('Publisher returned an empty response')

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('Publisher response exceeded the size limit')
    }
    chunks.push(Buffer.from(value))
  }
  if (!total) throw new Error('Publisher returned an empty response')
  return Buffer.concat(chunks, total)
}

async function fetchOneFeed(source, feedUrl, previous, fetchImpl) {
  let current = new URL(feedUrl)
  const headers = {
    accept: source.format === 'wp-json'
      ? 'application/json'
      : 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
    'user-agent': 'Mozilla/5.0 (compatible; KALASAG-NewsRelay/1.0; metadata-only public-safety monitoring)',
  }
  if (previous?.upstreamUrl === feedUrl && previous.upstreamEtag) {
    headers['if-none-match'] = previous.upstreamEtag
  }
  if (previous?.upstreamUrl === feedUrl && previous.upstreamLastModified) {
    headers['if-modified-since'] = previous.upstreamLastModified
  }

  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    if (
      current.protocol !== 'https:'
      || current.username
      || current.password
      || (current.port && current.port !== '443')
      || !hostnameAllowed(current.hostname, source.allowedFeedHosts)
    ) {
      throw new Error('Publisher redirect was rejected')
    }
    const response = await fetchImpl(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    if (response.status === 304 && previous?.body) {
      return {
        ...previous,
        checkedAt: Date.now(),
        upstreamEtag: response.headers.get('etag') ?? previous.upstreamEtag,
        upstreamLastModified: response.headers.get('last-modified') ?? previous.upstreamLastModified,
      }
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirectCount === 3) throw new Error('Publisher redirected too many times')
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw new Error(`Publisher returned HTTP ${response.status}`)
    const contentType = response.headers.get('content-type') ?? ''
    if (!validContentType(source, contentType)) throw new Error('Publisher returned an invalid content type')
    const body = await readLimitedBuffer(response)
    return {
      body,
      contentType,
      etag: `"${createHash('sha256').update(body).digest('hex')}"`,
      upstreamUrl: feedUrl,
      upstreamEtag: response.headers.get('etag'),
      upstreamLastModified: response.headers.get('last-modified'),
      checkedAt: Date.now(),
    }
  }
  throw new Error('Publisher could not be reached')
}

export async function fetchNewsSourcePayload(source, previous = null, fetchImpl = nativeHttpsFetch) {
  const feedUrls = [source.feedUrl, ...(source.fallbackFeedUrls ?? [])]
  let lastError = new Error('Publisher could not be reached')
  for (const feedUrl of feedUrls) {
    try {
      return await fetchOneFeed(source, feedUrl, previous, fetchImpl)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function commonHeaders(extra = {}) {
  return {
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    ...extra,
  }
}

function sendJson(request, response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, commonHeaders({
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  }))
  response.end(request.method === 'HEAD' ? undefined : body)
}

export function createNewsSourceRelayServer({
  relaySecret,
  fetchImpl = nativeHttpsFetch,
  sources = NEWS_SOURCES,
  freshMs = FRESH_MS,
  staleMs = STALE_MS,
  prewarm = true,
} = {}) {
  if (String(relaySecret ?? '').length < 32) {
    throw new Error('NEWS_RELAY_SECRET must contain at least 32 characters')
  }

  const sourceById = new Map(sources.filter(source => source.enabled).map(source => [source.id, source]))
  const requiredSourceIds = new Set(
    [...sourceById.values()]
      .filter(source => source.fetchStrategy === 'relay-first')
      .map(source => source.id),
  )
  const cache = new Map()
  const refreshes = new Map()
  const failures = new Map()

  async function currentPayload(source) {
    const cached = cache.get(source.id)
    const now = Date.now()
    const sourceFreshMs = Math.max(freshMs, Number(source.pollIntervalSeconds || 0) * 1_000)
    if (cached && now - cached.checkedAt < sourceFreshMs) return { payload: cached, cacheState: 'fresh' }

    const priorFailure = failures.get(source.id)
    if (priorFailure?.nextRetryAt > now) {
      if (cached && now - cached.checkedAt < staleMs) return { payload: cached, cacheState: 'stale' }
      throw new Error('Publisher refresh is in backoff')
    }

    let refresh = refreshes.get(source.id)
    if (!refresh) {
      refresh = fetchNewsSourcePayload(source, cached, fetchImpl)
        .then(payload => {
          cache.set(source.id, payload)
          failures.delete(source.id)
          return payload
        })
        .finally(() => refreshes.delete(source.id))
      refreshes.set(source.id, refresh)
    }

    try {
      return { payload: await refresh, cacheState: 'live' }
    } catch (error) {
      const attempts = Math.min(8, Number(priorFailure?.attempts || 0) + 1)
      const baseDelay = Math.min(5 * 60_000, 5_000 * (2 ** (attempts - 1)))
      const retryDelay = Math.round(baseDelay * (0.9 + Math.random() * 0.2))
      failures.set(source.id, {
        at: new Date().toISOString(),
        message: String(error instanceof Error ? error.message : 'Unknown upstream error').slice(0, 160),
        attempts,
        nextRetryAt: Date.now() + retryDelay,
      })
      if (cached && now - cached.checkedAt < staleMs) return { payload: cached, cacheState: 'stale' }
      throw error
    }
  }

  function readinessSnapshot(now = Date.now()) {
    const readySourceIds = [...sourceById.keys()].filter(sourceId => {
      const cached = cache.get(sourceId)
      return cached && now - cached.checkedAt < staleMs
    })
    const missingRequiredSources = [...requiredSourceIds].filter(
      sourceId => !readySourceIds.includes(sourceId),
    )
    const degradedSources = [...failures.keys()].filter(sourceId => readySourceIds.includes(sourceId))
    return {
      ready: missingRequiredSources.length === 0,
      readySourceIds,
      missingRequiredSources,
      degradedSources,
    }
  }

  if (prewarm && requiredSourceIds.size > 0) {
    queueMicrotask(() => {
      for (const sourceId of requiredSourceIds) {
        const source = sourceById.get(sourceId)
        if (source) void currentPayload(source).catch(() => undefined)
      }
    })
  }

  return http.createServer(async (request, response) => {
    let url
    try {
      url = new URL(request.url || '/', 'http://localhost')
    } catch {
      sendJson(request, response, 400, { error: 'Invalid request' })
      return
    }

    if (request.method === 'GET' && url.pathname === HEALTH_PATH) {
      const readiness = readinessSnapshot()
      sendJson(request, response, readiness.ready ? 200 : 503, {
        ok: readiness.ready,
        configuredSources: sourceById.size,
        requiredSources: requiredSourceIds.size,
        readySources: readiness.readySourceIds.length,
        missingRequiredSources: readiness.missingRequiredSources,
        degradedSources: readiness.degradedSources,
        refreshingSources: refreshes.size,
        failures: [...failures].map(([sourceId, failure]) => ({ sourceId, ...failure })),
      })
      return
    }

    if (!['GET', 'HEAD'].includes(request.method || '') || url.pathname !== RELAY_PATH) {
      sendJson(request, response, 404, { error: 'Not found' })
      return
    }
    if (!secretMatches(relaySecret, request.headers['x-kalasag-news-relay-secret'])) {
      sendJson(request, response, 401, { error: 'Unauthorized' })
      return
    }

    const queryKeys = [...url.searchParams.keys()]
    const sourceValues = url.searchParams.getAll('source')
    if (queryKeys.some(key => key !== 'source') || sourceValues.length !== 1) {
      sendJson(request, response, 400, { error: 'Invalid source request' })
      return
    }
    const source = sourceById.get(String(sourceValues[0] ?? ''))
    if (!source) {
      sendJson(request, response, 404, { error: 'Unknown source' })
      return
    }

    try {
      const { payload, cacheState } = await currentPayload(source)
      const headers = commonHeaders({
        'content-type': payload.contentType,
        etag: payload.etag,
        'last-modified': payload.upstreamLastModified ?? new Date(payload.checkedAt).toUTCString(),
        'x-kalasag-cache-state': cacheState,
        'x-kalasag-source-checked-at': new Date(payload.checkedAt).toISOString(),
      })
      if (request.headers['if-none-match'] === payload.etag) {
        response.writeHead(304, headers)
        response.end()
        return
      }
      response.writeHead(200, {
        ...headers,
        'content-length': String(payload.body.byteLength),
      })
      response.end(request.method === 'HEAD' ? undefined : payload.body)
    } catch {
      sendJson(request, response, 503, { error: 'Publisher feed is temporarily unavailable' }, {
        'retry-after': '60',
      })
    }
  })
}

function start() {
  const relaySecret = String(process.env.NEWS_RELAY_SECRET ?? '')
  const host = String(process.env.NEWS_SOURCE_RELAY_HOST || DEFAULT_HOST).trim()
  const port = Math.max(1, Math.min(65_535, Number(process.env.NEWS_SOURCE_RELAY_PORT) || DEFAULT_PORT))
  const server = createNewsSourceRelayServer({ relaySecret })
  let shuttingDown = false

  function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`News source relay received ${signal}; shutting down.`)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 5_000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  server.listen(port, host, () => {
    console.log(`KALASAG news source relay listening on http://${host}:${port}${RELAY_PATH}`)
  })
}

const executedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (executedDirectly) start()
