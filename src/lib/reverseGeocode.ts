import { getLiveData, type ReverseGeocodeResult } from './liveData'

const cache = new Map<string, ReverseGeocodeResult>()

function keyFor(latitude: number, longitude: number) {
  // About 11 m at the equator. This avoids exposing needless precision in cache
  // keys while still producing a useful street label.
  return `${latitude.toFixed(4)},${longitude.toFixed(4)}`
}

export async function reverseGeocodeCoordinates(
  latitude: number,
  longitude: number,
): Promise<ReverseGeocodeResult | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null

  const key = keyFor(latitude, longitude)
  const existing = cache.get(key)
  if (existing) return existing

  try {
    const response = await getLiveData<ReverseGeocodeResult>('reverse-geocode', {
      lat: latitude,
      lng: longitude,
    })
    cache.set(key, response.data)
    return response.data
  } catch {
    return null
  }
}
