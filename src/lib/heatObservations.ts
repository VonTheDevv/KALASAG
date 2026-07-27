import { normalizeHeatConfidence, type HeatConfidence } from './urbanHeat'

export const HEAT_FEED_WINDOW_MS = 24 * 60 * 60 * 1000
export const HEAT_NEARBY_ALERT_MAX_AGE_MS = 6 * 60 * 60 * 1000
const FUTURE_CLOCK_SKEW_MS = 10 * 60 * 1000

export type HeatObservation = {
  id: string
  lat: number
  lng: number
  brightness: number
  confidence: string
  normalizedConfidence: HeatConfidence
  acq_date: string
  acq_time: string
  observedAt: string
  satellite: string
  frp: number
  daynight: string
}

export function parseFirmsObservedAt(acquisitionDate: unknown, acquisitionTime: unknown) {
  const date = String(acquisitionDate ?? '').trim()
  const rawTime = String(acquisitionTime ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,4}$/.test(rawTime)) return null

  const time = rawTime.padStart(4, '0')
  const hours = Number(time.slice(0, 2))
  const minutes = Number(time.slice(2, 4))
  if (!Number.isInteger(hours) || hours < 0 || hours > 23 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null

  const timestamp = Date.parse(`${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:00.000Z`)
  if (!Number.isFinite(timestamp)) return null
  const normalized = new Date(timestamp).toISOString()
  return normalized.slice(0, 10) === date && normalized.slice(11, 16).replace(':', '') === time ? normalized : null
}

export function normalizeHeatObservation(value: unknown): HeatObservation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const lat = Number(record.lat)
  const lng = Number(record.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 4.5 || lat > 21.5 || lng < 116 || lng > 127.5) return null

  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id || id.length > 240) return null
  const acqDate = String(record.acq_date ?? '').trim()
  const acqTime = String(record.acq_time ?? '').trim().padStart(4, '0')
  const explicitObservedAt = typeof record.observedAt === 'string' && Number.isFinite(Date.parse(record.observedAt))
    ? new Date(Date.parse(record.observedAt)).toISOString()
    : null
  const observedAt = explicitObservedAt ?? parseFirmsObservedAt(acqDate, acqTime)
  if (!observedAt) return null

  const confidence = String(record.confidence ?? 'unknown').trim() || 'unknown'
  return {
    id,
    lat,
    lng,
    brightness: Number.isFinite(Number(record.brightness)) ? Number(record.brightness) : 0,
    confidence,
    normalizedConfidence: normalizeHeatConfidence(confidence),
    acq_date: acqDate,
    acq_time: acqTime,
    observedAt,
    satellite: String(record.satellite ?? 'unknown').trim() || 'unknown',
    frp: Number.isFinite(Number(record.frp)) ? Math.max(0, Number(record.frp)) : 0,
    daynight: String(record.daynight ?? 'unknown').trim() || 'unknown',
  }
}

export function heatObservationAgeMs(observation: Pick<HeatObservation, 'observedAt'>, now = Date.now()) {
  const observedAt = Date.parse(observation.observedAt)
  if (!Number.isFinite(observedAt) || observedAt - now > FUTURE_CLOCK_SKEW_MS) return null
  return Math.max(0, now - observedAt)
}

export function isHeatObservationWithinAge(
  observation: Pick<HeatObservation, 'observedAt'>,
  maxAgeMs: number,
  now = Date.now(),
) {
  const ageMs = heatObservationAgeMs(observation, now)
  return ageMs !== null && ageMs <= maxAgeMs
}

export function heatObservationAgeLabel(observation: Pick<HeatObservation, 'observedAt'>, now = Date.now()) {
  const ageMs = heatObservationAgeMs(observation, now)
  if (ageMs === null) return 'observation time unavailable'
  const minutes = Math.floor(ageMs / 60_000)
  if (minutes < 1) return 'less than a minute ago'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'} ago`
}

export function normalizeCurrentHeatObservations(values: unknown, now = Date.now()) {
  if (!Array.isArray(values)) return []
  return values.flatMap(value => {
    const observation = normalizeHeatObservation(value)
    return observation && isHeatObservationWithinAge(observation, HEAT_FEED_WINDOW_MS + 30 * 60 * 1000, now)
      ? [observation]
      : []
  })
}
