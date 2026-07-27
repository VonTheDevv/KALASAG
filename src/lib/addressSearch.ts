const PHOTON_RESPONSE_LIMIT_BYTES = 512 * 1024
const ADDRESS_QUERY_MIN_LENGTH = 3
const ADDRESS_QUERY_MAX_LENGTH = 120
const ADDRESS_RESULT_LIMIT = 6

export interface AddressSuggestion {
  id: string
  label: string
  streetAddress: string
  city: string
  postalCode: string
  latitude: number
  longitude: number
}

type PhotonFeature = {
  properties?: Record<string, unknown>
  geometry?: {
    coordinates?: unknown[]
  }
}

const cleanText = (value: unknown, maxLength = 160) => typeof value === 'string'
  ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
  : ''

const comparable = (value: string) => value.toLocaleLowerCase('en-PH')

function uniqueParts(values: string[]) {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = comparable(value)
    if (!value || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizePhotonFeature(feature: PhotonFeature, index: number): AddressSuggestion | null {
  const properties = feature.properties ?? {}
  if (cleanText(properties.countrycode, 2).toUpperCase() !== 'PH') return null

  const coordinates = feature.geometry?.coordinates
  const longitude = Number(coordinates?.[0])
  const latitude = Number(coordinates?.[1])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (latitude < 4.5 || latitude > 21.5 || longitude < 116 || longitude > 127.5) return null

  const name = cleanText(properties.name)
  const houseNumber = cleanText(properties.housenumber, 24)
  const street = cleanText(properties.street)
  const roadLine = [houseNumber, street].filter(Boolean).join(' ')
  const streetAddress = uniqueParts([
    name && comparable(name) !== comparable(street) && comparable(name) !== comparable(roadLine) ? name : '',
    roadLine || street,
  ]).join(', ') || name
  if (!streetAddress) return null

  const city = cleanText(properties.city)
    || cleanText(properties.locality)
    || cleanText(properties.district)
    || cleanText(properties.county)
  const postalCode = cleanText(properties.postcode, 12)
  const district = cleanText(properties.district)
  const state = cleanText(properties.state)
  const label = uniqueParts([streetAddress, district, city, state, postalCode]).join(', ')
  const osmType = cleanText(properties.osm_type, 8)
  const osmId = cleanText(String(properties.osm_id ?? ''), 32)

  return {
    id: osmType && osmId ? `photon-${osmType}-${osmId}` : `photon-${latitude}-${longitude}-${index}`,
    label,
    streetAddress,
    city,
    postalCode,
    latitude,
    longitude,
  }
}

export function normalizePhotonSuggestions(payload: unknown): AddressSuggestion[] {
  const features = payload && typeof payload === 'object' && Array.isArray((payload as { features?: unknown[] }).features)
    ? (payload as { features: PhotonFeature[] }).features
    : []
  const seen = new Set<string>()
  const suggestions: AddressSuggestion[] = []

  for (const [index, feature] of features.entries()) {
    const suggestion = normalizePhotonFeature(feature, index)
    if (!suggestion) continue
    const key = `${comparable(suggestion.label)}:${suggestion.latitude.toFixed(5)}:${suggestion.longitude.toFixed(5)}`
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push(suggestion)
    if (suggestions.length >= ADDRESS_RESULT_LIMIT) break
  }
  return suggestions
}

function addressSearchUrl(query: string) {
  const configured = String(import.meta.env.VITE_ADDRESS_SEARCH_URL ?? '').trim()
  const url = import.meta.env.DEV
    ? new URL('/api-address-search', window.location.origin)
    : new URL(configured || 'https://kalasagph.tech/api/address-search')
  if (!import.meta.env.DEV && url.protocol !== 'https:') {
    throw new Error('Address search is not securely configured')
  }
  url.searchParams.set('q', query)
  url.searchParams.set('countrycode', 'PH')
  url.searchParams.set('bbox', '116,4.5,127.5,21.5')
  url.searchParams.set('lang', 'en')
  url.searchParams.set('limit', String(ADDRESS_RESULT_LIMIT))
  return url
}

export async function searchPhilippineAddresses(rawQuery: string, signal: AbortSignal) {
  const query = rawQuery.replace(/\s+/g, ' ').trim().slice(0, ADDRESS_QUERY_MAX_LENGTH)
  if (query.length < ADDRESS_QUERY_MIN_LENGTH) return []

  let response: Response
  try {
    response = await fetch(addressSearchUrl(query), {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error('Address suggestions are temporarily unavailable')
  }
  if (!response.ok) throw new Error('Address suggestions are temporarily unavailable')

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json') && !contentType.includes('application/geo+json')) {
    throw new Error('Address search returned an invalid response')
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > PHOTON_RESPONSE_LIMIT_BYTES) {
    throw new Error('Address search response exceeded the safe size limit')
  }
  const body = await response.blob()
  if (body.size > PHOTON_RESPONSE_LIMIT_BYTES) throw new Error('Address search response exceeded the safe size limit')

  let payload: unknown
  try {
    payload = JSON.parse(await body.text())
  } catch {
    throw new Error('Address search returned invalid JSON')
  }
  return normalizePhotonSuggestions(payload)
}
