export const SAFE_GROUND_SEARCH_RADII_KM = [5, 10, 20] as const
export const SAFE_GROUND_AUTO_RADIUS_KM = SAFE_GROUND_SEARCH_RADII_KM[0]
export const SAFE_GROUND_RESCAN_DISTANCE_KM = 1

export type SafeGroundCandidate = {
  id: string
  name: string
  address: string
  lat: number
  lng: number
  status: string
  isOsm?: boolean
  kind?: string
  designated?: boolean
  distanceKm?: number
}

export type LocatedSafeGround = SafeGroundCandidate & { distanceKm: number }

const EARTH_RADIUS_KM = 6_371.0088

const toRadians = (degrees: number) => degrees * Math.PI / 180

export function distanceKm(
  origin: readonly [number, number],
  destination: readonly [number, number],
) {
  const [originLat, originLng] = origin
  const [destinationLat, destinationLng] = destination
  const latDelta = toRadians(destinationLat - originLat)
  const lngDelta = toRadians(destinationLng - originLng)
  const originLatRadians = toRadians(originLat)
  const destinationLatRadians = toRadians(destinationLat)
  const a = Math.sin(latDelta / 2) ** 2
    + Math.cos(originLatRadians) * Math.cos(destinationLatRadians) * Math.sin(lngDelta / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
}

export function nearbySafeGrounds(
  origin: readonly [number, number],
  candidates: SafeGroundCandidate[],
  radiusKm: number,
): LocatedSafeGround[] {
  const unique = new Map<string, LocatedSafeGround>()

  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)) continue
    if (/\b(?:closed|inactive|unavailable|not operational)\b/i.test(candidate.status)) continue
    const candidateDistanceKm = distanceKm(origin, [candidate.lat, candidate.lng])
    if (candidateDistanceKm > radiusKm) continue

    const located = { ...candidate, distanceKm: candidateDistanceKm }
    const key = candidate.id || `${candidate.lat.toFixed(5)}:${candidate.lng.toFixed(5)}:${candidate.name}`
    const existing = unique.get(key)
    if (!existing || located.distanceKm < existing.distanceKm) unique.set(key, located)
  }

  return [...unique.values()].sort((left, right) => {
    if (Boolean(left.designated) !== Boolean(right.designated)) return left.designated ? -1 : 1
    return left.distanceKm - right.distanceKm
  })
}

export function nearestSafeGround(
  origin: readonly [number, number],
  candidates: SafeGroundCandidate[],
  radiusKm: number,
): LocatedSafeGround | null {
  return nearbySafeGrounds(origin, candidates, radiusKm)[0] ?? null
}
