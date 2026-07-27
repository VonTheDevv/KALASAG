import { getLiveData } from '../lib/liveData'

export const PH_AIRSPACE_BBOX = {
  minLat: 4.5,
  maxLat: 21.5,
  minLng: 116.5,
  maxLng: 127.5,
}

export interface FlightPosition {
  id: string
  callsign: string
  icao24: string
  aircraftType: 'Commercial' | 'Cargo' | 'Military' | 'Private' | 'Rescue'
  airline: string
  origin: string
  destination: string
  lat: number
  lng: number
  altitude: number
  groundSpeed: number
  heading: number
  verticalRate: number
  onGround: boolean
  source: 'live'
  lastUpdate: number
  departurePort?: string
  destinationPort?: string
  waypoints?: [number, number][]
}

type GatewayAircraft = {
  hex?: string
  lat?: number
  lon?: number
  flight?: string
  alt_baro?: number | 'ground'
  alt_geom?: number | 'ground'
  gs?: number
  track?: number
  baro_rate?: number
  dbFlags?: number
  t?: string
  route?: {
    departurePort?: string
    destinationPort?: string
    origin?: string
    destination?: string
    waypoints?: [number, number][]
  }
}

function classifyAircraft(callsign: string, aircraft: GatewayAircraft): Pick<FlightPosition, 'aircraftType' | 'airline'> {
  const value = callsign.toUpperCase()
  if ((Number(aircraft.dbFlags) & 1) !== 0 || /^(PAF|AFP|RCAF|VMFA|RCH|CNV)/.test(value)) return { aircraftType: 'Military', airline: value.startsWith('PAF') ? 'Philippine Air Force' : 'Military flight' }
  if (/^(PCG|SAR|RSC)/.test(value)) return { aircraftType: 'Rescue', airline: value.startsWith('PCG') ? 'Philippine Coast Guard' : 'Search and rescue' }
  if ((Number(aircraft.dbFlags) & 2) !== 0 || /^(FDX|UPS|GTI|PAC|TGW|BOX|CKK|CSS)/.test(value)) {
    const airline = value.startsWith('FDX') ? 'FedEx' : value.startsWith('UPS') ? 'UPS' : value.startsWith('GTI') ? 'Atlas Air' : 'Cargo flight'
    return { aircraftType: 'Cargo', airline }
  }
  if (/^(PAL|PR )/.test(value)) return { aircraftType: 'Commercial', airline: 'Philippine Airlines' }
  if (/^(CEB|5J )/.test(value)) return { aircraftType: 'Commercial', airline: 'Cebu Pacific' }
  if (/^(APG|Z2 )/.test(value)) return { aircraftType: 'Commercial', airline: 'AirAsia Philippines' }
  if (/^(AXM|AK )/.test(value)) return { aircraftType: 'Commercial', airline: 'AirAsia' }
  if (/^(SIA|SQ )/.test(value)) return { aircraftType: 'Commercial', airline: 'Singapore Airlines' }
  if (/^(CPA|CX )/.test(value)) return { aircraftType: 'Commercial', airline: 'Cathay Pacific' }
  if (/^(ANA|NH )/.test(value)) return { aircraftType: 'Commercial', airline: 'All Nippon Airways' }
  if (/^(MAS|MH )/.test(value)) return { aircraftType: 'Commercial', airline: 'Malaysia Airlines' }
  if (/^(CAL|CI )/.test(value)) return { aircraftType: 'Commercial', airline: 'China Airlines' }
  if (/^(EVA|BR )/.test(value)) return { aircraftType: 'Commercial', airline: 'EVA Air' }
  if (/^(QTR|QR )/.test(value)) return { aircraftType: 'Commercial', airline: 'Qatar Airways' }
  if (/^(UAE|EK )/.test(value)) return { aircraftType: 'Commercial', airline: 'Emirates' }
  if (['C172', 'PA28', 'SR22'].includes(String(aircraft.t ?? '').toUpperCase())) return { aircraftType: 'Private', airline: 'General aviation' }
  return { aircraftType: 'Commercial', airline: 'Not supplied by ADS-B feed' }
}

/** Live ADS-B positions with server-resolved airport routes. Route fields stay
 * empty when a callsign cannot be matched; the client never guesses airports. */
export async function fetchGatewayFlights(): Promise<FlightPosition[] | null> {
  try {
    const response = await getLiveData<GatewayAircraft[]>('flights')
    const now = Date.now()
    return response.data.flatMap((aircraft): FlightPosition[] => {
      const lat = Number(aircraft.lat), lng = Number(aircraft.lon)
      const icao24 = String(aircraft.hex ?? '').trim().toLowerCase()
      if (!icao24 || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < PH_AIRSPACE_BBOX.minLat || lat > PH_AIRSPACE_BBOX.maxLat || lng < PH_AIRSPACE_BBOX.minLng || lng > PH_AIRSPACE_BBOX.maxLng) return []
      const onGround = aircraft.alt_baro === 'ground' || aircraft.alt_geom === 'ground'
      const callsign = String(aircraft.flight ?? '').trim() || `ICAO ${icao24.toUpperCase()}`
      const route = aircraft.route
      const waypoints = route?.waypoints?.filter(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
      return [{
        id: `live-${icao24}`,
        callsign,
        icao24,
        ...classifyAircraft(callsign, aircraft),
        origin: route?.origin ?? '',
        destination: route?.destination ?? '',
        lat,
        lng,
        altitude: onGround ? 0 : Math.round(Number(aircraft.alt_baro ?? aircraft.alt_geom) || 0),
        groundSpeed: Math.round(Number(aircraft.gs) || 0),
        heading: Math.round(Number(aircraft.track) || 0),
        verticalRate: Math.round(Number(aircraft.baro_rate) || 0),
        onGround,
        source: 'live',
        lastUpdate: now,
        departurePort: route?.departurePort,
        destinationPort: route?.destinationPort,
        waypoints: waypoints && waypoints.length >= 2 ? waypoints : undefined,
      }]
    })
  } catch (error) {
    console.warn('[Flights] live gateway unavailable:', error)
    return null
  }
}

function toRad(deg: number) { return deg * Math.PI / 180 }
function toDeg(rad: number) { return rad * 180 / Math.PI }

/** Smooth only the aircraft marker between observed ADS-B positions. This does
 * not create history or alter the airport-to-airport route guide. */
export function interpolateFlightPosition(flight: FlightPosition, deltaMs: number): FlightPosition {
  if (flight.onGround || flight.groundSpeed < 5) return flight
  const distanceKm = (flight.groundSpeed * 1.852 * deltaMs) / 3_600_000
  const angularDistance = distanceKm / 6371
  const heading = toRad(flight.heading)
  const lat1 = toRad(flight.lat)
  const lng1 = toRad(flight.lng)
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(heading))
  const lng2 = lng1 + Math.atan2(Math.sin(heading) * Math.sin(angularDistance) * Math.cos(lat1), Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2))
  return { ...flight, lat: toDeg(lat2), lng: toDeg(lng2), altitude: flight.altitude + Math.round(flight.verticalRate * (deltaMs / 60_000)) }
}
