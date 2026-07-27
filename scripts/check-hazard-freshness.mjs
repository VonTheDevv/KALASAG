import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  applyHazardDeliveryFreshness,
  assessOfficialHazardFreshness,
  OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS,
} from '../supabase/functions/_shared/hazard-freshness.js'

const evaluatedAt = '2026-07-17T08:00:00.000Z'

const currentDam = assessOfficialHazardFreshness({
  observedAt: '2026-07-16T08:00:00.000Z',
  maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.damObservation,
  evaluatedAt,
})
assert.equal(currentDam.freshness, 'live')
assert.equal(currentDam.ageMinutes, 24 * 60)

const staleDam = assessOfficialHazardFreshness({
  observedAt: '2026-07-15T00:00:00.000Z',
  maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.damObservation,
  evaluatedAt,
})
assert.equal(staleDam.freshness, 'stale')
assert.equal(staleDam.freshnessReason, 'official-timestamp-too-old')

const missingIssueTime = assessOfficialHazardFreshness({
  issuedAt: null,
  maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.stormSurgeAdvisory,
  evaluatedAt,
})
assert.equal(missingIssueTime.freshness, 'unknown')
assert.equal(missingIssueTime.freshnessReason, 'official-timestamp-not-published')

const futureTimestamp = assessOfficialHazardFreshness({
  issuedAt: '2026-07-18T08:00:00.000Z',
  maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.floodAdvisory,
  evaluatedAt,
})
assert.equal(futureTimestamp.freshness, 'unknown')

const expired = assessOfficialHazardFreshness({
  issuedAt: '2026-07-17T07:00:00.000Z',
  validTo: '2026-07-17T07:30:00.000Z',
  maxAgeMs: OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS.stormSurgeAdvisory,
  evaluatedAt,
})
assert.equal(expired.freshness, 'stale')
assert.equal(expired.freshnessReason, 'official-validity-expired')

const staleDelivery = applyHazardDeliveryFreshness(currentDam, 'stale')
assert.equal(staleDelivery.freshness, 'stale')
assert.equal(staleDelivery.freshnessReason, 'official-source-refresh-failed')
assert.equal(applyHazardDeliveryFreshness(missingIssueTime, 'cached').freshness, 'unknown')

const root = process.cwd()
for (const file of ['supabase/functions/live-data/index.ts', 'scripts/official-hazard-data.ts']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  assert.match(source, /assessOfficialHazardFreshness/)
  assert.match(source, /OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS\.damObservation/)
  assert.match(source, /OFFICIAL_HAZARD_FRESHNESS_LIMITS_MS\.stormSurgeAdvisory/)
}

const hazardMap = fs.readFileSync(path.join(root, 'src/components/HazardMap.tsx'), 'utf8')
assert.match(hazardMap, /Official data recency warning/)
assert.match(hazardMap, /official recency unknown/)
assert.doesNotMatch(hazardMap, /No Active Storm-Surge Product/)

console.log('Official hazard freshness is derived from source timestamps, stale delivery is downgraded, and missing timestamps remain unknown.')
