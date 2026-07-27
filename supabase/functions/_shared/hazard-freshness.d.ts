export type OfficialHazardFreshness = {
  freshness: 'live' | 'stale' | 'unknown'
  freshnessReason: string
  evaluatedAt: string | null
  referenceTimestamp: string | null
  ageMinutes: number | null
  freshnessThresholdMinutes: number | null
}

export const OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS: Readonly<{
  floodAdvisory: number
  stormSurgeAdvisory: number
  damObservation: number
  damReleaseObservation: number
}>

export function assessOfficialHazardFreshness(options: {
  observedAt?: string | null
  issuedAt?: string | null
  validTo?: string | null
  maxAgeMs: number | undefined
  evaluatedAt?: string
}): OfficialHazardFreshness

export function applyHazardDeliveryFreshness(
  assessment: OfficialHazardFreshness,
  deliveryFreshness: 'live' | 'cached' | 'stale',
): OfficialHazardFreshness
