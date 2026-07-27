const MINUTE_MS = 60_000
const FUTURE_CLOCK_SKEW_MS = 10 * MINUTE_MS

// These limits follow the publication cadence of each official product. They
// are deliberately independent from HTTP/cache freshness: receiving a page
// successfully does not prove that the observation inside it is current.
export const OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS = Object.freeze({
  floodAdvisory: 30 * 60 * MINUTE_MS,
  stormSurgeAdvisory: 12 * 60 * MINUTE_MS,
  damObservation: 30 * 60 * MINUTE_MS,
  damReleaseObservation: 30 * 60 * MINUTE_MS,
})

function parsedTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

/**
 * Derive source freshness only from an official observation/advisory time and
 * its validity window. `evaluatedAt` is explicit so this function is
 * deterministic in tests and produces an auditable contract in responses.
 */
export function assessOfficialHazardFreshness({
  observedAt = null,
  issuedAt = null,
  validTo = null,
  maxAgeMs,
  evaluatedAt = new Date().toISOString(),
}) {
  const evaluatedMs = parsedTime(evaluatedAt)
  const thresholdMs = Number(maxAgeMs)
  const thresholdMinutes = Number.isFinite(thresholdMs) && thresholdMs > 0
    ? Math.round(thresholdMs / MINUTE_MS)
    : null
  const base = {
    evaluatedAt: evaluatedMs === null ? null : new Date(evaluatedMs).toISOString(),
    referenceTimestamp: null,
    ageMinutes: null,
    freshnessThresholdMinutes: thresholdMinutes,
  }

  if (evaluatedMs === null || thresholdMinutes === null) {
    return { ...base, freshness: 'unknown', freshnessReason: 'freshness-policy-invalid' }
  }

  const validToMs = parsedTime(validTo)
  if (validTo !== null && validToMs === null) {
    return { ...base, freshness: 'unknown', freshnessReason: 'official-validity-time-invalid' }
  }
  if (validToMs !== null && evaluatedMs > validToMs) {
    return {
      ...base,
      referenceTimestamp: new Date(validToMs).toISOString(),
      ageMinutes: Math.max(0, Math.round((evaluatedMs - validToMs) / MINUTE_MS)),
      freshness: 'stale',
      freshnessReason: 'official-validity-expired',
    }
  }

  const rawReference = issuedAt ?? observedAt
  const referenceMs = parsedTime(rawReference)
  if (referenceMs === null) {
    return { ...base, freshness: 'unknown', freshnessReason: 'official-timestamp-not-published' }
  }

  const referenceTimestamp = new Date(referenceMs).toISOString()
  if (referenceMs - evaluatedMs > FUTURE_CLOCK_SKEW_MS) {
    return {
      ...base,
      referenceTimestamp,
      freshness: 'unknown',
      freshnessReason: 'official-timestamp-in-future',
    }
  }

  const ageMs = Math.max(0, evaluatedMs - referenceMs)
  const ageMinutes = Math.round(ageMs / MINUTE_MS)
  return ageMs <= thresholdMs
    ? { ...base, referenceTimestamp, ageMinutes, freshness: 'live', freshnessReason: 'official-timestamp-within-cadence' }
    : { ...base, referenceTimestamp, ageMinutes, freshness: 'stale', freshnessReason: 'official-timestamp-too-old' }
}

/** Downgrade source freshness when the gateway is serving an old cached page. */
export function applyHazardDeliveryFreshness(assessment, deliveryFreshness) {
  if (deliveryFreshness !== 'stale') return assessment
  return {
    ...assessment,
    freshness: 'stale',
    freshnessReason: 'official-source-refresh-failed',
  }
}
