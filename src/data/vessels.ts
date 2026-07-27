// Philippine maritime monitoring uses live AIS position reports only. The API
// credential is held by the relay; the browser connects only to that relay.

import { getLiveData } from '../lib/liveData'
import { supabase } from '../lib/supabase'
import {
  MARITIME_MONITORING_AVAILABLE,
  MARITIME_MONITORING_NOTICE,
} from '../lib/featureAvailability'

export const PH_AIS_BBOX = {
  minLat: 4.5,
  maxLat: 21.5,
  minLng: 116.5,
  maxLng: 127.5,
}

export interface VesselPosition {
  id: string
  name: string
  mmsi: string
  type: string
  flag: string
  departurePort: string
  destinationPort: string
  speedKnots: number
  heading: number
  lat: number
  lng: number
  status: 'underway' | 'at-port'
  source: 'ais'
  receivedAt: number
  progress: null
  waypoints: [number, number][]
}

export type AISVesselMap = Map<string, VesselPosition>

const MAX_AIS_MESSAGE_CHARS = 256 * 1024
const MAX_TRACKED_VESSELS = 5_000
const MAX_STATIC_VESSELS = 5_000
const VESSEL_STALE_MS = 20 * 60 * 1000
const AUTH_ACK_MAX_CHARS = 256
const AUTH_ACK_TIMEOUT_MS = 12_000
const POSITION_MESSAGE_TYPES = new Set([
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'LongRangeAisBroadcastMessage',
])

function aisRelayUrl() {
  const configured = String(import.meta.env.VITE_AIS_RELAY_URL ?? '').trim()
  if (!configured) {
    if (import.meta.env.DEV) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      return { url: `${protocol}//${window.location.host}/api-ais`, authenticated: false }
    }
    try {
      const url = new URL(String(import.meta.env.VITE_SUPABASE_URL ?? ''))
      if (url.protocol !== 'https:') return null
      url.protocol = 'wss:'
      url.pathname = `${url.pathname.replace(/\/$/, '')}/functions/v1/ais-relay`
      url.search = ''
      url.hash = ''
      return { url: url.toString(), authenticated: true }
    } catch {
      return null
    }
  }

  try {
    const url = new URL(configured)
    if (url.protocol === 'https:') url.protocol = 'wss:'
    if (url.protocol === 'http:') url.protocol = 'ws:'
    if (url.protocol !== 'wss:' && (!import.meta.env.DEV || url.protocol !== 'ws:')) return null
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    const isSupabaseEdgeRelay = /\/functions\/v1\/ais-relay\/?$/.test(url.pathname)
    return { url: url.toString(), authenticated: isSupabaseEdgeRelay }
  } catch {
    return null
  }
}

type JsonRecord = Record<string, unknown>

type StaticVesselData = {
  name: string
  shipType: number | null
  destination: string
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().replace(/@+$/, '').trim().slice(0, maxLength) : ''
}

function validMmsi(value: unknown) {
  const mmsi = String(value ?? '')
  return /^\d{9}$/.test(mmsi) ? mmsi : null
}

function validShipType(value: unknown) {
  const shipType = finiteNumber(value)
  return shipType !== null && Number.isInteger(shipType) && shipType >= 0 && shipType <= 99 ? shipType : null
}

function vesselTypeLabel(shipType: number | null) {
  return shipType !== null && shipType >= 60 && shipType <= 69 ? 'Passenger/Ferry'
    : shipType !== null && shipType >= 80 && shipType <= 89 ? 'Tanker'
      : shipType !== null && shipType >= 70 && shipType <= 79 ? 'Cargo'
        : shipType !== null && shipType >= 30 && shipType <= 39 ? 'Fishing'
          : shipType !== null && shipType >= 50 && shipType <= 59 ? 'Special craft'
            : 'Unspecified'
}

export interface GfwVesselIdentity {
  mmsi: string
  vesselId: string | null
  shipName: string | null
  flag: string | null
  callSign: string | null
  imo: string | null
  vesselTypes: string[]
  gearTypes: string[]
  tonnageGt: number | null
  lengthM: number | null
  lastTransmission: string | null
}

export interface GfwVesselLookup {
  found: boolean
  identity: GfwVesselIdentity | null
}

export async function fetchGfwVesselIdentity(mmsi: string) {
  if (!MARITIME_MONITORING_AVAILABLE) throw new Error(MARITIME_MONITORING_NOTICE)
  return getLiveData<GfwVesselLookup>('gfw-vessel', { mmsi })
}

export async function connectAISStream(
  onUpdate: (vessels: AISVesselMap) => void,
  onError?: (error: Event) => void,
  onOpen?: () => void,
): Promise<WebSocket | null> {
  if (!MARITIME_MONITORING_AVAILABLE) return null

  const vessels: AISVesselMap = new Map()
  const staticVessels = new Map<string, StaticVesselData>()
  const relay = aisRelayUrl()
  if (!relay) {
    queueMicrotask(() => onError?.(new Event('configuration-error')))
    return null
  }

  let authFrame: string | null = null
  if (relay.authenticated) {
    const { data, error } = await supabase.auth.getSession()
    const accessToken = data.session?.access_token
    if (error || !accessToken) {
      queueMicrotask(() => onError?.(new Event('authentication-error')))
      return null
    }
    authFrame = JSON.stringify({ type: 'authenticate', accessToken })
  }

  let socket: WebSocket
  try {
    socket = new WebSocket(relay.url)
  } catch {
    queueMicrotask(() => onError?.(new Event('connection-error')))
    return null
  }

  const rememberStatic = (mmsi: string, patch: Partial<StaticVesselData>) => {
    const current = staticVessels.get(mmsi)
    const next = {
      name: patch.name || current?.name || '',
      shipType: patch.shipType ?? current?.shipType ?? null,
      destination: patch.destination || current?.destination || '',
    }
    staticVessels.delete(mmsi)
    staticVessels.set(mmsi, next)
    while (staticVessels.size > MAX_STATIC_VESSELS) {
      const oldest = staticVessels.keys().next().value
      if (!oldest) break
      staticVessels.delete(oldest)
    }
    return next
  }

  const applyStaticMessage = (messageType: string, report: JsonRecord, metadata: JsonRecord) => {
    const mmsi = validMmsi(metadata.MMSI ?? report.UserID)
    if (!mmsi) return
    let patch: Partial<StaticVesselData>
    if (messageType === 'ShipStaticData') {
      patch = {
        name: boundedString(report.Name, 80),
        shipType: validShipType(report.Type),
        destination: boundedString(report.Destination, 120),
      }
    } else {
      const reportA = asRecord(report.ReportA)
      const reportB = asRecord(report.ReportB)
      patch = {
        name: boundedString(reportA?.Name, 80),
        shipType: validShipType(reportB?.ShipType),
      }
    }
    const identity = rememberStatic(mmsi, patch)
    const existing = vessels.get(mmsi)
    if (!existing) return
    vessels.set(mmsi, {
      ...existing,
      name: identity.name || existing.name,
      type: identity.shipType === null ? existing.type : vesselTypeLabel(identity.shipType),
      destinationPort: identity.destination || existing.destinationPort,
    })
    onUpdate(new Map(vessels))
  }

  let relayAuthenticated = !relay.authenticated
  let authAckTimer: number | null = null
  socket.onopen = () => {
    if (!relay.authenticated) {
      onOpen?.()
      return
    }
    if (!authFrame) {
      socket.close(1008, 'Authentication unavailable')
      return
    }
    try {
      socket.send(authFrame)
      authFrame = null
      authAckTimer = window.setTimeout(() => socket.close(1008, 'Authentication timeout'), AUTH_ACK_TIMEOUT_MS)
    } catch {
      authFrame = null
      socket.close(1011, 'Authentication failed')
    }
  }

  socket.onmessage = (event) => {
    try {
      if (typeof event.data !== 'string' || event.data.length > MAX_AIS_MESSAGE_CHARS) return
      if (!relayAuthenticated) {
        if (event.data.length > AUTH_ACK_MAX_CHARS) {
          socket.close(1008, 'Invalid authentication acknowledgement')
          return
        }
        const acknowledgement = asRecord(JSON.parse(event.data))
        if (acknowledgement?.type !== 'authenticated') {
          socket.close(1008, 'Invalid authentication acknowledgement')
          return
        }
        relayAuthenticated = true
        if (authAckTimer !== null) window.clearTimeout(authAckTimer)
        authAckTimer = null
        onOpen?.()
        return
      }
      const data = asRecord(JSON.parse(event.data))
      if (!data) return
      const messageType = String(data.MessageType ?? '')
      const message = asRecord(data.Message)
      const metadata = asRecord(data.MetaData ?? data.Metadata)
      if (!message || !metadata) return
      const report = asRecord(message[messageType])
      if (!report) return
      if (report.Valid === false) return
      if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') {
        applyStaticMessage(messageType, report, metadata)
        return
      }
      if (!POSITION_MESSAGE_TYPES.has(messageType)) return

      const mmsi = validMmsi(metadata.MMSI ?? report.UserID)
      const lat = finiteNumber(report.Latitude ?? metadata.latitude ?? metadata.Latitude)
      const lng = finiteNumber(report.Longitude ?? metadata.longitude ?? metadata.Longitude)
      if (!mmsi || lat === null || lng === null) return
      if (lat < PH_AIS_BBOX.minLat || lat > PH_AIS_BBOX.maxLat || lng < PH_AIS_BBOX.minLng || lng > PH_AIS_BBOX.maxLng) return

      const inlineIdentity = rememberStatic(mmsi, {
        name: boundedString(report.Name, 80) || boundedString(metadata.ShipName, 80),
        shipType: validShipType(report.Type ?? metadata.ShipType),
        destination: boundedString(metadata.Destination, 120),
      })

      const speedKnots = finiteNumber(report.Sog)
      const reportedHeading = finiteNumber(report.TrueHeading)
      const course = finiteNumber(report.Cog)
      const heading = reportedHeading !== null && reportedHeading >= 0 && reportedHeading < 360
        ? reportedHeading
        : course !== null && course >= 0 && course < 360 ? course : 0
      vessels.delete(mmsi)
      vessels.set(mmsi, {
        id: `ais-${mmsi}`,
        name: inlineIdentity.name || `MMSI ${mmsi}`,
        mmsi,
        type: vesselTypeLabel(inlineIdentity.shipType),
        flag: boundedString(metadata.country, 64) || 'Unknown',
        departurePort: 'Not broadcast',
        destinationPort: inlineIdentity.destination || 'Not broadcast',
        speedKnots: speedKnots !== null && speedKnots >= 0 && speedKnots <= 102.2 ? speedKnots : 0,
        heading,
        lat,
        lng,
        status: speedKnots !== null && speedKnots > 0.5 ? 'underway' : 'at-port',
        source: 'ais',
        receivedAt: Date.now(),
        progress: null,
        waypoints: [[lat, lng]],
      })
      while (vessels.size > MAX_TRACKED_VESSELS) {
        const oldestMmsi = vessels.keys().next().value
        if (!oldestMmsi) break
        vessels.delete(oldestMmsi)
      }
      onUpdate(new Map(vessels))
    } catch {
      if (!relayAuthenticated) socket.close(1008, 'Invalid authentication acknowledgement')
      // Ignore malformed upstream AIS records and keep the last valid state.
    }
  }

  const staleTimer = window.setInterval(() => {
    const staleBefore = Date.now() - VESSEL_STALE_MS
    let changed = false
    for (const [mmsi, vessel] of vessels) {
      if (vessel.receivedAt >= staleBefore) continue
      vessels.delete(mmsi)
      changed = true
    }
    if (changed) onUpdate(new Map(vessels))
  }, 60_000)

  socket.onerror = (error) => onError?.(error)
  socket.onclose = () => {
    authFrame = null
    if (authAckTimer !== null) window.clearTimeout(authAckTimer)
    window.clearInterval(staleTimer)
    onError?.(new Event('close'))
  }
  return socket
}
