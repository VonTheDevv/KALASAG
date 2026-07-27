import {
  applyHazardDeliveryFreshness,
  assessOfficialHazardFreshness,
  OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS,
  type OfficialHazardFreshness,
} from '../supabase/functions/_shared/hazard-freshness.js'
import {
  OFFICIAL_DAM_LOCATION_BASELINE,
  OFFICIAL_DAM_LOCATION_BASELINE_CAPTURED_AT,
} from '../supabase/functions/_shared/dam-location-baseline.js'

const PAGASA_FLOOD_PAGE = 'https://www.pagasa.dost.gov.ph/flood'
const PAGASA_STORM_SURGE_PAGE = 'https://www.pagasa.dost.gov.ph/tropical-cyclone/forecast-storm-surge'
const PAGASA_DAM_MAP_SERVICE = 'https://portal.georisk.gov.ph/arcgis/rest/services/PAGASA/PAGASA/MapServer'
const PH_BOUNDS = { minLat: 4.5, maxLat: 21.5, minLng: 116, maxLng: 127.5 }
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const MAX_JSON_BYTES = 8 * 1024 * 1024

type SourceHealth = { id: string; status: 'live' | 'stale' | 'unknown' | 'unavailable'; checkedAt: string; detail?: string }
type PageCacheEntry = { html: string; freshUntil: number; staleUntil: number }
const pageCache = new Map<string, PageCacheEntry>()

async function limitedText(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Response exceeded the size limit')
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('Response exceeded the size limit')
  return text
}

async function publicText(url: string) {
  const cached = pageCache.get(url)
  if (cached && cached.freshUntil > Date.now()) return { html: cached.html, freshness: 'cached' as const }
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'KALASAG-DevGateway/1.0' }, signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}`)
    const html = await limitedText(response, MAX_TEXT_BYTES)
    if (!/<html\b/i.test(html) || html.length < 5_000) throw new Error('Official source returned incomplete HTML')
    pageCache.set(url, { html, freshUntil: Date.now() + 10 * 60_000, staleUntil: Date.now() + 24 * 60 * 60_000 })
    return { html, freshness: 'live' as const }
  } catch (error) {
    if (cached && cached.staleUntil > Date.now()) return { html: cached.html, freshness: 'stale' as const }
    throw error
  }
}

async function publicJson(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': 'KALASAG-DevGateway/1.0' }, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}`)
  return JSON.parse(await limitedText(response, MAX_JSON_BYTES))
}

function decodeHtml(value: string) {
  const named: Record<string, string> = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', ndash: '–', mdash: '—', deg: '°' }
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number(code))))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(code, 16))))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match)
}

function plainText(value: string, limit = 500) {
  return decodeHtml(value.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim().slice(0, limit)
}

function slug(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'unknown'
}

function pageVersion(html: string, prefix: string) {
  const timestamp = html.match(/server_timestamp\s*=\s*(\d{9,13})/i)?.[1]
  return `${prefix}:${timestamp ?? slug(plainText(html.match(/<h5\b[^>]*>([\s\S]*?)<\/h5>/i)?.[1] ?? 'unversioned', 80))}`
}

function metadata(
  sourceClass: 'official-observation' | 'official-advisory' | 'public-geocoder',
  datasetVersion: string,
  deliveryFreshness: 'live' | 'cached' | 'stale',
  values: {
    observedAt?: string | null
    issuedAt?: string | null
    validTo?: string | null
    note?: string
    evaluatedAt?: string
    maxAgeMs?: number
  } = {},
) {
  const official = sourceClass === 'official-observation' || sourceClass === 'official-advisory'
  const sourceFreshness: OfficialHazardFreshness | { freshness: 'live'; freshnessReason: string } = official
    ? applyHazardDeliveryFreshness(assessOfficialHazardFreshness({
        observedAt: values.observedAt ?? null,
        issuedAt: values.issuedAt ?? null,
        validTo: values.validTo ?? null,
        maxAgeMs: values.maxAgeMs,
        evaluatedAt: values.evaluatedAt,
      }), deliveryFreshness)
    : { freshness: 'live', freshnessReason: 'request-response-current' }
  return {
    sourceClass,
    ...sourceFreshness,
    observedAt: values.observedAt ?? null,
    issuedAt: values.issuedAt ?? null,
    validity: { from: null, to: values.validTo ?? null },
    datasetVersion,
    ...(values.note ? { note: values.note } : {}),
  }
}

function pageSource(id: string, checkedAt: string, freshness: string): SourceHealth {
  if (freshness === 'live') return { id, status: 'live', checkedAt }
  if (freshness === 'stale') return { id, status: 'stale', checkedAt, detail: 'The official timestamp is old or the source refresh failed' }
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

function officialDocumentUrl(rawValue: string | undefined) {
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

export async function loadFloodAdvisories() {
  const checkedAt = new Date().toISOString()
  const page = await publicText(PAGASA_FLOOD_PAGE)
  const advisories = new Map<string, Record<string, unknown>>()
  for (const row of page.html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1])
    if (cells.length < 2) continue
    const area = plainText(cells[0], 160), status = plainText(cells[1], 120)
    if (!area || !/(?:flood|watch|outlook|advisory|warning|critical)/i.test(status)) continue
    const href = cells[1].match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1]
    const id = `pagasa-flood-${slug(area)}`
    advisories.set(id, { id, area, status, severity: advisorySeverity(status), bulletinUrl: officialDocumentUrl(href), issuedAt: null, validUntil: null, geometry: null })
  }
  const data = [...advisories.values()].slice(0, 80)
  if (data.length < 4) throw new Error('Official flood advisory table could not be parsed')
  const issuedAt = latestIsoTimestamp(data.map(item => item.issuedAt))
  const feedMetadata = metadata('official-advisory', pageVersion(page.html, 'pagasa-flood'), page.freshness, {
    issuedAt,
    evaluatedAt: checkedAt,
    maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.floodAdvisory,
    note: 'Official basin advisory states. Geometry is not supplied by this feed; no flood extent is inferred.',
  })
  return {
    data,
    sources: [pageSource('pagasa-flood-advisories', checkedAt, feedMetadata.freshness)],
    fetchedAt: checkedAt,
    deliveryFreshness: page.freshness === 'live' ? 'network' : page.freshness,
    stale: page.freshness === 'stale',
    metadata: feedMetadata,
  }
}

function pageObservedAt(html: string) {
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

type DamStatus = {
  id: string; name: string; lat: number | null; lng: number | null; observedAt: string | null
  reservoirWaterLevelM: number | null; changeM: number | null; normalHighWaterLevelM: number | null
  deviationFromNormalM: number | null; ruleCurveElevationM: number | null; deviationFromRuleCurveM: number | null
  gateOpeningCount: number | null; gateOpeningM: number | null; inflowCms: number | null; outflowCms: number | null
  locationFreshness: 'official-live' | 'official-cached' | 'unavailable'
}

function parseDams(html: string): DamStatus[] {
  const observedAt = pageObservedAt(html)
  const result: DamStatus[] = []
  const pattern = /<tr\b[^>]*>\s*<td\b[^>]*current-dam[^>]*>([\s\S]*?)<\/td>([\s\S]*?)<\/tr>\s*<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  for (const match of html.matchAll(pattern)) {
    const rawName = plainText(match[1], 100)
    const cells = [...match[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1])
    if (!rawName || cells.length < 12) continue
    const name = rawName.replace(/\s+Dam$/i, '')
    result.push({ id: `pagasa-dam-${slug(name)}`, name, lat: null, lng: null, observedAt, reservoirWaterLevelM: nullableNumber(cells[1]), changeM: nullableNumber(cells[3]), normalHighWaterLevelM: nullableNumber(cells[4]), deviationFromNormalM: nullableNumber(cells[5]), ruleCurveElevationM: nullableNumber(cells[6]), deviationFromRuleCurveM: nullableNumber(cells[7]), gateOpeningCount: nullableNumber(cells[8]), gateOpeningM: nullableNumber(cells[9]), inflowCms: nullableNumber(cells[10]), outflowCms: nullableNumber(cells[11]), locationFreshness: 'unavailable' })
  }
  return result.slice(0, 30)
}

function damKey(value: string) {
  return value.toLowerCase().replace(/\b(?:dam|reservoir)\b/g, '').replace(/[^a-z0-9]/g, '')
}

type OfficialDamLocation = { labels: string; lat: number; lng: number }

function attachDamLocations(
  dams: DamStatus[],
  locations: OfficialDamLocation[],
  locationFreshness: DamStatus['locationFreshness'],
) {
  return dams.map(dam => {
    const key = damKey(dam.name)
    const location = locations.find(candidate => {
      const labels = damKey(candidate.labels)
      return key.length >= 3 && labels.length >= 3 && (labels.includes(key) || key.includes(labels))
    })
    return location ? { ...dam, lat: location.lat, lng: location.lng, locationFreshness } : dam
  })
}

function baselineDamLocations(): OfficialDamLocation[] {
  return OFFICIAL_DAM_LOCATION_BASELINE.map(location => ({
    labels: location.name.toLowerCase(),
    lat: location.lat,
    lng: location.lng,
  }))
}

async function damLocations() {
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => publicJson(`${PAGASA_DAM_MAP_SERVICE}/${index + 1}/query?where=1%3D1&outFields=site%2Clatitude%2Clongitude&returnGeometry=true&outSR=4326&resultRecordCount=100&f=geojson`)))
  return results.flatMap(result => {
    if (result.status !== 'fulfilled') return []
    return (result.value?.features ?? []).flatMap((feature: any) => {
      if (feature?.geometry?.type !== 'Point') return []
      const [lng, lat] = feature.geometry.coordinates ?? []
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < PH_BOUNDS.minLat || lat > PH_BOUNDS.maxLat || lng < PH_BOUNDS.minLng || lng > PH_BOUNDS.maxLng) return []
      return [{ labels: Object.values(feature.properties ?? {}).filter(value => typeof value === 'string').join(' ').toLowerCase(), lat, lng }]
    })
  }).slice(0, 100)
}

export async function loadDams() {
  const checkedAt = new Date().toISOString()
  const page = await publicText(PAGASA_FLOOD_PAGE)
  let data = parseDams(page.html)
  if (data.length < 5) throw new Error('Official dam table could not be parsed')
  data = attachDamLocations(data, baselineDamLocations(), 'official-cached')
  const observedAt = data.map(item => item.observedAt).find(Boolean) ?? null
  const feedMetadata = metadata('official-observation', pageVersion(page.html, 'pagasa-dams'), page.freshness, {
    observedAt,
    evaluatedAt: checkedAt,
    maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.damObservation,
    note: 'PAGASA publishes this table on its own reporting cadence. Missing values remain missing.',
  })
  const sources: SourceHealth[] = [pageSource('pagasa-dam-observations', checkedAt, feedMetadata.freshness)]
  try {
    const locations = await damLocations()
    if (!locations.length) throw new Error('No official dam locations were returned')
    data = attachDamLocations(data, locations, 'official-live')
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
  return { data, sources, fetchedAt: checkedAt, deliveryFreshness: page.freshness === 'live' ? 'network' : page.freshness, stale: page.freshness === 'stale', metadata: feedMetadata }
}

export async function loadDamReleaseAdvisories() {
  const checkedAt = new Date().toISOString()
  const page = await publicText(PAGASA_FLOOD_PAGE)
  const statuses = parseDams(page.html)
  if (statuses.length < 5) throw new Error('Official dam table could not be parsed')
  const data = statuses.map(dam => {
    const dischargeObserved = (dam.gateOpeningCount ?? 0) > 0 || (dam.gateOpeningM ?? 0) > 0 || (dam.outflowCms ?? 0) > 0
    return { id: `pagasa-release-${slug(dam.name)}`, damName: dam.name, noticeStatus: dischargeObserved ? 'discharge-observed-at-source-time' : 'no-schedule-published-in-checked-source', scheduledAt: null, observedAt: dam.observedAt, gateOpeningCount: dam.gateOpeningCount, gateOpeningM: dam.gateOpeningM, outflowCms: dam.outflowCms, message: dischargeObserved ? 'The official status reports gate or outflow values at the stated observation time. KALASAG does not infer a future release time.' : 'No release schedule was published in the checked official source. This does not guarantee that no separate operational notice exists.' }
  })
  const observedAt = statuses.map(item => item.observedAt).find(Boolean) ?? null
  const feedMetadata = metadata('official-observation', pageVersion(page.html, 'pagasa-dam-releases'), page.freshness, {
    observedAt,
    evaluatedAt: checkedAt,
    maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.damReleaseObservation,
    note: 'This is observed gate/outflow status, not a release forecast. Scheduled times are returned only when explicitly published; no time is estimated from water level.',
  })
  return { data, sources: [pageSource('pagasa-dam-release-status', checkedAt, feedMetadata.freshness)], fetchedAt: checkedAt, deliveryFreshness: page.freshness === 'live' ? 'network' : page.freshness, stale: page.freshness === 'stale', metadata: feedMetadata }
}

export async function loadStormSurgeAdvisories() {
  const checkedAt = new Date().toISOString()
  const page = await publicText(PAGASA_STORM_SURGE_PAGE)
  const header = page.html.search(/<div\b[^>]*tropical-cyclone-weather-bulletin-page/i)
  const section = header >= 0 ? page.html.slice(header, Math.min(page.html.length, header + 40_000)) : ''
  const noActive = /No Storm Surge within the Philippine Area of Responsibility/i.test(section)
  const documents = new Map<string, { title: string; url: string }>()
  if (!noActive) {
    for (const match of section.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = officialDocumentUrl(match[1])
      if (!url || !/(?:storm|surge|\.pdf$|\.png$|\.jpe?g$)/i.test(url)) continue
      const title = plainText(match[2], 160) || decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? 'Storm surge advisory')
      documents.set(url, { title, url })
    }
    for (const match of section.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
      const url = officialDocumentUrl(match[1])
      if (!url || !/(?:storm|surge|\.png$|\.jpe?g$)/i.test(url)) continue
      documents.set(url, { title: decodeURIComponent(new URL(url).pathname.split('/').at(-1) ?? 'Storm surge advisory'), url })
    }
  }
  const data = [...documents.values()].slice(0, 20).map((document, index) => ({ id: `pagasa-storm-surge-${index}-${slug(document.title)}`, title: document.title, summary: 'Official forecast storm-surge product. Open the published product for the complete affected-area statement.', advisoryUrl: document.url, issuedAt: null, validUntil: null, geometry: null }))
  if (!noActive && data.length === 0) throw new Error('Official storm surge page could not be parsed')
  const issuedAt = latestIsoTimestamp(data.map(item => item.issuedAt))
  const feedMetadata = metadata('official-advisory', pageVersion(page.html, 'pagasa-storm-surge'), page.freshness, {
    issuedAt,
    evaluatedAt: checkedAt,
    maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.stormSurgeAdvisory,
    note: noActive
      ? 'The checked official page reports no active storm-surge forecast within PAR, but the page does not publish a machine-readable issue time for that status.'
      : 'The official product does not provide machine-readable geometry; KALASAG does not invent an affected area.',
  })
  return { data, sources: [pageSource('pagasa-storm-surge', checkedAt, feedMetadata.freshness)], fetchedAt: checkedAt, deliveryFreshness: page.freshness === 'live' ? 'network' : page.freshness, stale: page.freshness === 'stale', metadata: feedMetadata }
}

export async function loadReverseGeocode(lat: number, lng: number) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < PH_BOUNDS.minLat || lat > PH_BOUNDS.maxLat || lng < PH_BOUNDS.minLng || lng > PH_BOUNDS.maxLng) throw new Error('Invalid location')
  const checkedAt = new Date().toISOString()
  const endpoint = new URL('https://photon.komoot.io/reverse')
  endpoint.searchParams.set('lat', lat.toFixed(6)); endpoint.searchParams.set('lon', lng.toFixed(6)); endpoint.searchParams.set('lang', 'en')
  const payload = await publicJson(endpoint.toString())
  const feature = Array.isArray(payload?.features) ? payload.features[0] : null
  const properties = feature?.properties ?? {}, coordinates = feature?.geometry?.coordinates ?? [lng, lat]
  const resolvedLng = Number(coordinates[0]), resolvedLat = Number(coordinates[1])
  if (!Number.isFinite(resolvedLat) || !Number.isFinite(resolvedLng)) throw new Error('Reverse geocoder did not return a valid location')
  const street = [properties.housenumber, properties.street].filter(Boolean).join(' ') || null
  const locality = properties.city || properties.town || properties.village || properties.district || properties.county || null
  const parts = [properties.name, street, locality, properties.state, properties.country].filter(Boolean)
  const data = { displayName: [...new Set(parts.map(String))].join(', ') || `${lat.toFixed(5)}, ${lng.toFixed(5)}`, street, locality, region: properties.state || null, postalCode: properties.postcode || null, country: properties.country || null, lat: resolvedLat, lng: resolvedLng }
  return { data, sources: [{ id: 'public-reverse-geocoder', status: 'live', checkedAt }] satisfies SourceHealth[], fetchedAt: checkedAt, metadata: metadata('public-geocoder', `photon:${lat.toFixed(4)}:${lng.toFixed(4)}`, 'live') }
}
