import { getLiveData } from '../lib/liveData'
import { trafficIncidentMetadata } from '../lib/roadIncidents'

export { trafficIncidentMetadata } from '../lib/roadIncidents'
export type { TrafficIncidentMetadata } from '../lib/roadIncidents'

export const TRAFFIC_RADIUS_KM = 20

export interface TrafficIncident {
  id: string
  geometry: [number, number][]
  description: string
  reasons: string[]
  eventCodes: number[]
  delaySeconds: number
  lengthMeters: number
  magnitude: number
  category: number
  roadName: string
  from: string
  to: string
  startTime: string | null
  endTime: string | null
}

type GatewayIncident = {
  geometry?: { coordinates?: unknown }
  properties?: {
    id?: string
    iconCategory?: number
    magnitudeOfDelay?: number
    events?: Array<{ description?: string; code?: number }>
    from?: string
    to?: string
    length?: number
    delay?: number
    startTime?: string
    endTime?: string
  }
}

export function haversineKm(first: [number, number], second: [number, number]) {
  const toRad = (value: number) => value * Math.PI / 180
  const latDistance = toRad(second[0] - first[0]), lngDistance = toRad(second[1] - first[1])
  const a = Math.sin(latDistance / 2) ** 2 + Math.cos(toRad(first[0])) * Math.cos(toRad(second[0])) * Math.sin(lngDistance / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function coordinatePairs(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return []
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) return [[Number(value[1]), Number(value[0])]]
  return value.flatMap(coordinatePairs)
}

export function trafficIncidentColor(incident: TrafficIncident) {
  if (incident.delaySeconds >= 1800 || incident.magnitude >= 3) return '#991b1b'
  if (incident.delaySeconds >= 600 || incident.magnitude >= 2) return '#ef4444'
  return '#f59e0b'
}

export async function fetchTrafficIncidents(lat: number, lng: number, radiusKm = TRAFFIC_RADIUS_KM) {
  const response = await getLiveData<GatewayIncident[]>('traffic', { lat, lng, radiusKm })
  const center: [number, number] = [lat, lng]
  const incidents = response.data.flatMap((incident, index): TrafficIncident[] => {
    const geometry = coordinatePairs(incident.geometry?.coordinates)
    if (!geometry.length || !geometry.some(point => haversineKm(center, point) <= radiusKm)) return []
    const properties = incident.properties ?? {}
    const reasons = [...new Set((properties.events ?? []).map(event => String(event.description ?? '').trim()).filter(Boolean))]
    const eventCodes = [...new Set((properties.events ?? []).map(event => Number(event.code)).filter(Number.isFinite))]
    const from = String(properties.from ?? '').trim()
    const to = String(properties.to ?? '').trim()
    return [{
      id: String(properties.id ?? `traffic-${index}`),
      geometry,
      description: reasons[0] || trafficIncidentMetadata(Number(properties.iconCategory) || 0).label,
      reasons,
      eventCodes,
      delaySeconds: Number(properties.delay) || 0,
      lengthMeters: Number(properties.length) || 0,
      magnitude: Number(properties.magnitudeOfDelay) || 0,
      category: Number(properties.iconCategory) || 0,
      roadName: from && to && from !== to ? `${from} to ${to}` : from || to || 'Road name unavailable',
      from,
      to,
      startTime: Number.isFinite(Date.parse(String(properties.startTime ?? ''))) ? String(properties.startTime) : null,
      endTime: Number.isFinite(Date.parse(String(properties.endTime ?? ''))) ? String(properties.endTime) : null,
    }]
  })
  return { incidents, fetchedAt: response.fetchedAt, sources: response.sources }
}
