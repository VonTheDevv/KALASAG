export type NewsCategory =
  | 'fire'
  | 'flood'
  | 'road-incident'
  | 'killing'
  | 'robbery-theft'
  | 'typhoon'
  | 'earthquake'
  | 'security-conflict'

export type NewsSource = {
  id: string
  name: string
  homeUrl: string
  feedUrl: string
  fallbackFeedUrls?: string[]
  format: 'rss' | 'news-sitemap' | 'wp-json'
  enabled: boolean
  pollIntervalSeconds: number
  transport: string
  fetchStrategy?: 'direct-first' | 'relay-first'
  allowedFeedHosts: string[]
  allowedArticleHosts: string[]
  allowSummary?: boolean
  allowAuthor?: boolean
  titleSuffixes?: string[]
  publishedTimeZone?: 'Asia/Manila-wall-clock'
  statusDetail: string
}

export type ParsedNewsArticle = {
  sourceId: string
  sourceName: string
  sourceHomeUrl: string
  canonicalUrl: string
  title: string
  summary: string | null
  author: string | null
  publishedAt: string
  detectedAt: string
  transport: string
}

export const NEWS_SOURCES: readonly NewsSource[]
export const NEWS_CATEGORY_VALUES: readonly NewsCategory[]
export function stripFeedMarkup(value: unknown, limit?: number): string
export function normalizeArticleUrl(value: unknown, allowedHosts: string[]): string | null
export function parseSyndicationFeed(payload: unknown, source: NewsSource, detectedAt?: string): ParsedNewsArticle[]
export function classifyNewsIncident(title: unknown, summary?: unknown): {
  category: NewsCategory | null
  isHazard: boolean
  resolved: boolean
}
export function extractLocationCandidates(title: unknown, summary?: unknown): string[]
export function marineIncidentLocation(title: unknown, summary?: unknown): {
  isMaritimeIncident: boolean
  coordinate: {
    lat: number
    lng: number
    locationName: string
    locationQuery: string
    locationPrecision: 'offshore'
    locationConfidence: number
  } | null
}
export function incidentExpiry(publishedAt: unknown, category: NewsCategory, resolved?: boolean): string | null
export function clusterNewsIncidents(articles: Array<Record<string, unknown>>): Map<string, {
  verificationStatus: 'news-reported' | 'multiple-outlets-reported'
  corroboratingSources: string[]
}>
export function inPhilippineBounds(lat: number, lng: number): boolean
export function scorePhotonLocation(candidate: string, feature: unknown): {
  lat: number
  lng: number
  locationName: string
  locationQuery: string
  locationPrecision: 'street' | 'locality' | 'region'
  locationConfidence: number
} | null
