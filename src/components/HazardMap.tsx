import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { MapContainer, TileLayer, CircleMarker, Marker, Popup, useMap, useMapEvents, Polyline, Circle, Polygon } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { 
  Layers, Flame, Zap, CloudLightning, AlertTriangle, RefreshCw, 
  WifiOff, Activity, Eye, Navigation,
  Anchor, Radio, Plane, Car, Sun, Moon,
  Shield, MapPin, X, Menu, Info, Waves, Newspaper
} from 'lucide-react'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { PH_FAULT_LINES } from '../data/faultLines'
import { connectAISStream, fetchGfwVesselIdentity, type VesselPosition, type AISVesselMap, type GfwVesselLookup } from '../data/vessels'
import { fetchGatewayFlights, interpolateFlightPosition, type FlightPosition } from '../data/flights'
import { useAuth } from '../hooks/useAuth'
import { useNews } from '../hooks/newsContext'
import { useTheme } from '../hooks/useTheme'
import { fetchVolcanoes, fetchUserPreferences, upsertUserPreferences, supabase } from '../lib/supabase'
import {
  getLiveData,
  LiveDataError,
  type DamReleaseAdvisory,
  type DamStatus,
  type FloodAdvisory,
  type HazardFeedMetadata,
  type SourceHealth,
  type StormSurgeAdvisory,
} from '../lib/liveData'
import { CARTO_RASTER_MAX_ZOOM } from '../lib/mapTiles'
import { DEVELOPMENT_TYPHOON_PREVIEW } from '../lib/devTyphoonPreview'
import { createStormCenterIcon, STORM_CENTER_ARM_PATH } from '../lib/stormCenterIcon'
import {
  MARITIME_MONITORING_AVAILABLE,
  MARITIME_MONITORING_NOTICE,
} from '../lib/featureAvailability'
import { classifyHeatDetections, type HeatClassification } from '../lib/urbanHeat'
import {
  heatObservationAgeLabel,
  normalizeCurrentHeatObservations,
  type HeatObservation,
} from '../lib/heatObservations'
import {
  SAFE_GROUND_AUTO_RADIUS_KM,
  SAFE_GROUND_RESCAN_DISTANCE_KM,
  SAFE_GROUND_SEARCH_RADII_KM,
  distanceKm,
  nearestSafeGround,
  type SafeGroundCandidate,
} from '../lib/safeGrounds'
import {
  clearDevicePositionWatch,
  watchDevicePosition,
  type DeviceLocationWatchId,
} from '../lib/deviceGeolocation'
import {
  activeNewsIncidents,
  newsCategoryColor,
  newsCategoryLabel,
  type NewsArticle,
  type NewsCategory,
} from '../lib/news'
import TrafficFlowLayer from './TrafficFlowLayer'
import DamStatusLayer from './hazards/DamStatusLayer'
import HazardAdvisoryAreas from './hazards/HazardAdvisoryAreas'
import HazardBaselineLayer from './hazards/HazardBaselineLayers'
import { hazardBaselineConfiguration } from './hazards/hazardBaselineConfig'
import { Select } from './ui/primitives'

// ── Bounding box & Map Controls ─────────────────────────────────────
const PH_CENTER: [number, number] = [12.5, 122.0]
const PH_ZOOM = 6
const isMappableDam = (dam: DamStatus) => (
  Number.isFinite(dam.lat)
  && Number.isFinite(dam.lng)
  && dam.lat! >= 4.5
  && dam.lat! <= 21.5
  && dam.lng! >= 116
  && dam.lng! <= 127.5
)

function preserveKnownDamLocations(previous: DamStatus[], incoming: DamStatus[]) {
  const previousById = new Map(previous.filter(isMappableDam).map(dam => [dam.id, dam]))
  return incoming.map(dam => {
    if (isMappableDam(dam)) return dam
    const known = previousById.get(dam.id)
    return known
      ? { ...dam, lat: known.lat, lng: known.lng, locationFreshness: known.locationFreshness }
      : dam
  })
}

const HAZARD_REPORT_BOUNDS = { minLat: 4.5, maxLat: 21.5, minLng: 116, maxLng: 127.5 }
const HAZARD_REPORT_TYPES = ['Flood', 'Fire', 'Road Blocked', 'Accident', 'Infrastructure Damage', 'Other'] as const
const HAZARD_REPORT_DESCRIPTION_LIMIT = 500
const HAZARD_REPORT_DISPLAY_LIMIT = 500
const HAZARD_REPORTING_ENABLED = import.meta.env.VITE_HAZARD_REPORTING_ENABLED === 'true'
const AIRCRAFT_LIVE_GRACE_MS = 60_000
const AIRCRAFT_STALE_RETENTION_MS = 5 * 60_000
type HazardReportType = typeof HAZARD_REPORT_TYPES[number]

// Philippine Area of Responsibility (PAR) Boundary Coordinates
const PAR_BOUNDARY: [number, number][] = [
  [25.0, 120.0],
  [25.0, 135.0],
  [5.0, 135.0],
  [5.0, 115.0],
  [15.0, 115.0],
  [21.0, 120.0],
  [25.0, 120.0]
]

// ── Types ──────────────────────────────────────────────────────────
interface EarthquakeFeature {
  id: string
  properties: { mag: number; place: string; time: number; sig: number }
  geometry: { coordinates: [number, number, number] }
}

type FIRMSHotspot = HeatObservation & { classification: HeatClassification }

interface CycloneEvent {
  id: string | number
  name: string
  localName?: string
  lat: number
  lng: number
  alertlevel: string
  alertscore: number
  description: string
  windKph?: number
  source?: string
  observedTrack?: [number, number][]
  forecastTrack?: [number, number][]
  observedPoints?: Array<{ lat: number; lng: number; intensity: string }>
  forecastPoints?: Array<{ lat: number; lng: number; intensity: string }>
  isDevelopmentPreview?: boolean
}

interface VolcanoData {
  id: string
  name: string
  lat: number
  lng: number
  alertLevel: number
  status: string
  details: string
}

interface FloodEvent {
  id: string | number
  name: string
  lat: number
  lng: number
  severity: string
  alertlevel: string
  description: string
  source: string
  affectedArea?: string
  observedAt?: string | null
  sourceClass?: 'contextual-event'
}

type EvacuationCenter = SafeGroundCandidate

interface HazardReport {
  id: string
  type: string
  lat: number
  lng: number
  description: string
  upvotes: number
  created_at: string
}

function normalizeHazardReport(value: unknown): HazardReport | null {
  if (!value || typeof value !== 'object') return null
  const report = value as Record<string, unknown>
  const lat = Number(report.lat), lng = Number(report.lng)
  const description = typeof report.description === 'string' ? report.description.trim() : ''
  if (
    typeof report.id !== 'string' || typeof report.type !== 'string' ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    lat < HAZARD_REPORT_BOUNDS.minLat || lat > HAZARD_REPORT_BOUNDS.maxLat ||
    lng < HAZARD_REPORT_BOUNDS.minLng || lng > HAZARD_REPORT_BOUNDS.maxLng ||
    !description
  ) return null
  return {
    id: report.id,
    type: report.type,
    lat,
    lng,
    description: description.slice(0, HAZARD_REPORT_DESCRIPTION_LIMIT),
    upvotes: Number.isFinite(Number(report.upvotes)) ? Number(report.upvotes) : 0,
    created_at: typeof report.created_at === 'string' ? report.created_at : '',
  }
}

interface FilterState {
  earthquakes: boolean
  fires: boolean
  weather: boolean
  volcanoes: boolean
  faultLines: boolean
  vessels: boolean
  flights: boolean
  traffic: boolean
  floods: boolean
  floodAdvisories: boolean
  floodSusceptibility: boolean
  stormSurge: boolean
  dams: boolean
  evacuation_centers: boolean
  hazard_reports: boolean
  newsReports: boolean
}

const DEFAULT_FILTERS: FilterState = {
  earthquakes: true,
  fires: true,
  weather: true,
  volcanoes: true,
  faultLines: false,
  vessels: MARITIME_MONITORING_AVAILABLE,
  flights: true,
  traffic: false,
  floods: true,
  floodAdvisories: true,
  floodSusceptibility: false,
  stormSurge: false,
  dams: true,
  evacuation_centers: true,
  hazard_reports: true,
  newsReports: true,
}

function normalizeFilters(value: unknown): FilterState {
  const stored = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const normalized = Object.fromEntries(
    Object.entries(DEFAULT_FILTERS).map(([key, fallback]) => [key, typeof stored[key] === 'boolean' ? stored[key] : fallback]),
  ) as unknown as FilterState
  if (!MARITIME_MONITORING_AVAILABLE) normalized.vessels = false
  return normalized
}

const zoomScale = (zoom: number, base = 1.4) => {
  const refZoom = 6
  const factor = base * Math.pow(0.92, zoom - refZoom)
  return Math.max(0.5, Math.min(2.5, factor))
}

function hazardTimestamp(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'time not published'
  return new Date(value).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function hazardFreshnessLabel(metadata: HazardFeedMetadata) {
  if (metadata.freshness === 'live') return 'current by official timestamp'
  if (metadata.freshness === 'stale') return 'stale official timestamp'
  if (metadata.freshness === 'unknown') return 'official recency unknown'
  if (metadata.freshness === 'cached') return 'cached delivery'
  return 'unavailable'
}

function hazardFreshnessSuffix(metadata: HazardFeedMetadata | null) {
  if (metadata?.freshness === 'stale') return ' (stale)'
  if (metadata?.freshness === 'unknown') return ' (time unverified)'
  return ''
}

function officialFreshnessWarning(label: string, metadata: HazardFeedMetadata) {
  if (metadata.freshness === 'unknown') {
    return `${label}: the official source does not publish a usable issue or observation time, so recency cannot be verified.`
  }
  const age = typeof metadata.ageMinutes === 'number'
    ? ` (${Math.round(metadata.ageMinutes / 60)} hours old)`
    : ''
  if (metadata.freshnessReason === 'official-source-refresh-failed') {
    return `${label}: the latest source refresh failed; the last verified data is being shown.`
  }
  return `${label}: the official timestamp is older than the expected publication cadence${age}.`
}

const volcanoIcon = (alertLevel: number, zoom: number) => {
  const color = alertLevel >= 3 ? '#e53e3e' : alertLevel >= 1 ? '#ff8c33' : '#22c55e'
  const glow = alertLevel >= 1 ? `box-shadow: 0 0 10px ${color};` : ''
  const s = Math.round(18 * zoomScale(zoom, 1.35))
  const fs = Math.max(8, Math.round(8 * zoomScale(zoom, 1.1)))
  return L.divIcon({
    className: '',
    html: `<div style="width:${s}px;height:${s}px;background:${color};border:2px solid #ffffff80;border-radius:50%;${glow}display:flex;align-items:center;justify-content:center;font-size:${fs}px;font-weight:800;color:white;">▲</div>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2]
  })
}

const fireHotspotIcon = (frp: number, confidence: string, zoom: number) => {
  const isHigh = confidence === 'high'
  const color = frp > 50 ? '#ff0000' : frp > 15 ? '#ff4500' : frp > 5 ? '#ff7700' : '#ffaa00'
  const baseSize = isHigh ? 14 : 11
  const size = Math.round(baseSize * zoomScale(zoom, 1.3))
  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;border-radius:50% 50% 50% 0;background:${color};transform:rotate(-45deg);box-shadow:0 0 6px 2px ${color}80;border:1px solid rgba(255,255,255,0.5);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
  })
}

const fireHotspotOverviewRadius = (frp: number, confidence: string, zoom: number) => {
  const intensityRadius = frp > 50 ? 11 : frp > 15 ? 10 : frp > 5 ? 9 : 8
  const confidenceBoost = confidence === 'high' ? 1 : 0
  return Math.max(8, Math.min(14, Math.round((intensityRadius + confidenceBoost) * zoomScale(zoom, 1))))
}

const potentialResidentialFireIcon = (zoom: number) => {
  const size = Math.max(24, Math.min(34, Math.round(26 * zoomScale(zoom, 1))))
  const diamondSize = Math.round(size * 0.7)
  const offset = Math.round((size - diamondSize) / 2)
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${size}px;height:${size}px;"><div style="position:absolute;left:${offset}px;top:${offset}px;width:${diamondSize}px;height:${diamondSize}px;display:flex;align-items:center;justify-content:center;transform:rotate(45deg);border:2px solid white;border-radius:3px;background:#dc2626;box-shadow:0 0 0 3px rgba(220,38,38,0.25),0 0 14px rgba(220,38,38,0.85);"><span style="transform:rotate(-45deg);font-size:${Math.round(diamondSize * 0.7)}px;font-weight:900;line-height:1;color:white;">!</span></div></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

const userLocationIcon = (zoom: number) => {
  const s = Math.round(20 * zoomScale(zoom, 1.3))
  const inner = Math.round(s * 0.6)
  const pad = Math.round((s - inner) / 2)
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${s}px;height:${s}px;"><div style="position:absolute;top:0;left:0;width:${s}px;height:${s}px;border-radius:50%;background:rgba(66,133,244,0.2);animation:gps-pulse 2s ease-out infinite;"></div><div style="position:absolute;top:${pad}px;left:${pad}px;width:${inner}px;height:${inner}px;border-radius:50%;background:#4285f4;border:2.5px solid white;box-shadow:0 0 8px rgba(66,133,244,0.7);"></div></div>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  })
}

const vesselIcon = (heading: number, type: string, status: string, zoom: number) => {
  const color = type === 'Military/Patrol' ? '#60a5fa' : type === 'Container' ? '#a78bfa' : type === 'Cargo' ? '#f59e0b' : type === 'Fishing' ? '#34d399' : '#22d3ee'
  const opacity = status === 'at-port' ? 0.5 : 0.95
  const s = Math.round(22 * zoomScale(zoom, 1.25))
  const svgS = Math.round(18 * zoomScale(zoom, 1.25))
  return L.divIcon({
    className: '',
    html: `<div style="width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center;transform:rotate(${heading}deg);opacity:${opacity};"><svg viewBox="0 0 24 24" width="${svgS}" height="${svgS}" fill="${color}" stroke="#000" stroke-width="1"><polygon points="12,2 4,20 12,16 20,20"/></svg></div>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  })
}

const flightIcon = (heading: number, type: string, onGround: boolean, zoom: number) => {
  const color = type === 'Military' ? '#60a5fa' : type === 'Rescue' ? '#f87171' : type === 'Cargo' ? '#f59e0b' : '#a78bfa'
  const opacity = onGround ? 0.45 : 0.95
  const s = Math.round(22 * zoomScale(zoom, 1.25))
  const svgS = Math.round(18 * zoomScale(zoom, 1.25))
  return L.divIcon({
    className: '',
    html: `<div style="width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center;transform:rotate(${heading}deg);opacity:${opacity};"><svg viewBox="0 0 24 24" width="${svgS}" height="${svgS}" fill="${color}" stroke="#000" stroke-width="1"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L14 19v-5.5l8 2.5z"/></svg></div>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  })
}

const evacuationIcon = (zoom: number, isOsm = false) => {
  const s = Math.round(20 * zoomScale(zoom, 1.3))
  const bg = isOsm ? '#3b82f6' : '#4ade80'
  const emoji = isOsm ? '📍' : '🛡️'
  return L.divIcon({
    className: '',
    html: `<div style="width:${s}px;height:${s}px;background:${bg};border:2px solid #ffffff80;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:${Math.round(s*0.5)}px;box-shadow:0 0 10px ${bg};">${emoji}</div>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  })
}

const hazardReportIcon = (_type: string, zoom: number) => {
  const s = Math.round(22 * zoomScale(zoom, 1.3))
  return L.divIcon({
    className: '',
    html: `<div style="width:${s}px;height:${s}px;background:#f87171;border:2px solid #ffffff80;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:${Math.round(s*0.5)}px;box-shadow:0 0 10px #f87171;">⚠️</div>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s],
  })
}

const NEWS_INCIDENT_MARKER_PATHS: Record<NewsCategory, string> = {
  fire: 'M12 2c.7 3.5 5 5.4 5 10.2A5 5 0 0 1 7 12c0-2.8 1.2-5 3.7-7.1-.2 2.1.4 3.7 1.5 4.8C13.6 7.4 13.6 4.7 12 2Z',
  flood: 'M3 7.5c2.2 0 2.2-1.5 4.5-1.5S9.8 7.5 12 7.5 14.2 6 16.5 6 18.8 7.5 21 7.5M3 12c2.2 0 2.2-1.5 4.5-1.5S9.8 12 12 12s2.2-1.5 4.5-1.5S18.8 12 21 12M3 16.5c2.2 0 2.2-1.5 4.5-1.5s2.3 1.5 4.5 1.5 2.2-1.5 4.5-1.5 2.3 1.5 4.5 1.5',
  'road-incident': 'M5 16.5h14l-1.4-5.1a2 2 0 0 0-1.9-1.4H8.3a2 2 0 0 0-1.9 1.4L5 16.5Zm2 0v2M17 16.5v2M6.2 13.5h11.6M8.5 10l1-3h5l1 3',
  killing: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0-3v4m0 12v4M2 12h4m12 0h4',
  'robbery-theft': 'M6 10h12v10H6V10Zm3 0V7a4 4 0 0 1 7.5-2M9 15h6',
  typhoon: 'M12 12c-4.6-1.1-7-4-6.8-7.7M12 12c1.1-4.6 4-7 7.7-6.8M12 12c4.6 1.1 7 4 6.8 7.7M12 12c-1.1 4.6-4 7-7.7 6.8M12 8.8a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z',
  earthquake: 'M2.5 13h4l2-5 3 9 3-12 2.5 8H22',
  'security-conflict': 'M12 2.5 19 5v5.5c0 4.6-2.8 8.6-7 10.5-4.2-1.9-7-5.9-7-10.5V5l7-2.5Z',
}

function NewsIncidentSymbol({ category, size = 24, label }: { category: NewsCategory; size?: number; label?: string }) {
  const color = newsCategoryColor(category)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="shrink-0 overflow-visible"
    >
      <path
        d={NEWS_INCIDENT_MARKER_PATHS[category]}
        stroke={color}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="12"
        y="12.5"
        dominantBaseline="middle"
        textAnchor="middle"
        fill="#ffffff"
        stroke="#0f172a"
        strokeWidth="0.85"
        strokeLinejoin="round"
        style={{ paintOrder: 'stroke', fontFamily: 'system-ui, sans-serif', fontSize: '7.5px', fontWeight: 900 }}
      >
        N
      </text>
    </svg>
  )
}

const newsIncidentIcon = (article: NewsArticle, zoom: number) => {
  const size = Math.max(20, Math.min(34, Math.round(24 * zoomScale(zoom, 1.3))))
  const color = newsCategoryColor(article.category)
  const label = `${newsCategoryLabel(article.category)} news report`
  const path = NEWS_INCIDENT_MARKER_PATHS[article.category]
  return L.divIcon({
    className: '',
    html: `<svg role="img" aria-label="${label}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="display:block;overflow:visible"><path d="${path}" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><text x="12" y="12.5" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" stroke="#0f172a" stroke-width="0.85" stroke-linejoin="round" paint-order="stroke" style="font-family:system-ui,sans-serif;font-size:7.5px;font-weight:900">N</text></svg>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  })
}


function MapBoundsController({ targetBounds, centerTarget, centerZoom }: { targetBounds?: L.LatLngBoundsExpression; centerTarget?: [number, number] | null; centerZoom?: number }) {
  const map = useMap()
  useEffect(() => {
    if (centerTarget) {
      map.flyTo(centerTarget, centerZoom || 6, { animate: true, duration: 1.5 })
    } else if (targetBounds) {
      map.fitBounds(targetBounds, { padding: [20, 20] })
    }
  }, [map, targetBounds, centerTarget, centerZoom])
  return null
}

function ZoomTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMap()
  useEffect(() => {
    onZoomChange(map.getZoom())
    const handler = () => onZoomChange(map.getZoom())
    map.on('zoomend', handler)
    return () => { map.off('zoomend', handler) }
  }, [map, onZoomChange])
  return null
}

function HazardReportLocationPicker({ onSelect }: { onSelect: (position: [number, number]) => void }) {
  useMapEvents({ click: event => onSelect([event.latlng.lat, event.latlng.lng]) })
  return null
}

function magColor(mag: number): string {
  if (mag >= 7.0) return '#e53e3e'
  if (mag >= 6.0) return '#ff6b00'
  if (mag >= 5.0) return '#f6c90e'
  if (mag >= 4.0) return '#14b8a6'
  return '#3b82f6'
}

function unwrapRoute(waypoints: [number, number][]) {
  return waypoints.reduce<[number, number][]>((route, point) => {
    if (!route.length) return [point]
    const previousLng = route[route.length - 1][1]
    let lng = point[1]
    while (lng - previousLng > 180) lng -= 360
    while (lng - previousLng < -180) lng += 360
    route.push([point[0], lng])
    return route
  }, [])
}

function distanceToRouteSegment(point: [number, number], start: [number, number], end: [number, number]) {
  const referenceLat = (point[0] + start[0] + end[0]) / 3 * Math.PI / 180
  const longitudeScale = Math.max(0.2, Math.cos(referenceLat))
  const px = point[1] * longitudeScale, py = point[0]
  const ax = start[1] * longitudeScale, ay = start[0], bx = end[1] * longitudeScale, by = end[0]
  const dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy
  const position = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + position * dx), py - (ay + position * dy))
}

function flightRouteGuideSegments(waypoints: [number, number][], aircraft: [number, number]) {
  const route = unwrapRoute(waypoints)
  if (route.length < 2) return { departureTrail: route, destinationTrail: [] as [number, number][] }
  let insertAfter = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  let adjustedAircraft = aircraft
  for (let index = 0; index < route.length - 1; index += 1) {
    const midpointLongitude = (route[index][1] + route[index + 1][1]) / 2
    const adjustedLongitude = aircraft[1] + Math.round((midpointLongitude - aircraft[1]) / 360) * 360
    const candidate: [number, number] = [aircraft[0], adjustedLongitude]
    const distance = distanceToRouteSegment(candidate, route[index], route[index + 1])
    if (distance < nearestDistance) { nearestDistance = distance; insertAfter = index; adjustedAircraft = candidate }
  }
  const start = route[insertAfter], end = route[insertAfter + 1]
  const atStart = Math.abs(start[0] - adjustedAircraft[0]) < 0.0001 && Math.abs(start[1] - adjustedAircraft[1]) < 0.0001
  const atEnd = Math.abs(end[0] - adjustedAircraft[0]) < 0.0001 && Math.abs(end[1] - adjustedAircraft[1]) < 0.0001

  return {
    departureTrail: atStart ? route.slice(0, insertAfter + 1) : [...route.slice(0, insertAfter + 1), adjustedAircraft],
    destinationTrail: atEnd ? route.slice(insertAfter + 1) : [adjustedAircraft, ...route.slice(insertAfter + 1)],
  }
}

type GfwLookupState = { status: 'loading' | 'ready' | 'error'; lookup?: GfwVesselLookup; message?: string }

function GfwVesselDetails({ state }: { state?: GfwLookupState }) {
  if (!state || state.status === 'loading') return <p className="mt-2 border-t border-[var(--color-border)] pt-2 text-[10px] text-[var(--color-text-muted)]">Checking vessel identity records…</p>
  if (state.status === 'error') return <p className="mt-2 border-t border-[var(--color-border)] pt-2 text-[10px] text-[var(--warning)]">Vessel details unavailable: {state.message}</p>
  const identity = state.lookup?.identity
  if (!state.lookup?.found || !identity) return <p className="mt-2 border-t border-[var(--color-border)] pt-2 text-[10px] text-[var(--color-text-muted)]">No matching vessel identity record.</p>
  return <div className="mt-2 border-t border-[var(--color-border)] pt-2">
    <p className="mb-1 font-bold text-[#38bdf8]">Vessel identity details</p>
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
      {identity.shipName && <><span className="text-[var(--color-text-muted)]">Registered name</span><span className="font-medium">{identity.shipName}</span></>}
      {identity.imo && <><span className="text-[var(--color-text-muted)]">IMO</span><span className="font-medium">{identity.imo}</span></>}
      {identity.callSign && <><span className="text-[var(--color-text-muted)]">Call sign</span><span className="font-medium">{identity.callSign}</span></>}
      {identity.vesselTypes.length > 0 && <><span className="text-[var(--color-text-muted)]">Reported type</span><span className="font-medium">{identity.vesselTypes.join(', ')}</span></>}
      {identity.gearTypes.length > 0 && <><span className="text-[var(--color-text-muted)]">Fishing gear</span><span className="font-medium">{identity.gearTypes.join(', ')}</span></>}
      {identity.tonnageGt !== null && <><span className="text-[var(--color-text-muted)]">Gross tonnage</span><span className="font-medium">{identity.tonnageGt.toLocaleString()} GT</span></>}
      {identity.lengthM !== null && <><span className="text-[var(--color-text-muted)]">Length</span><span className="font-medium">{identity.lengthM} m</span></>}
    </div>
    {identity.lastTransmission && <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">Identity history last transmission: {new Date(identity.lastTransmission).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</p>}
    <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">Identity and registry details only · position above remains a live vessel report</p>
  </div>
}

export default function HazardMap() {
  const isOnline = useOnlineStatus()

  // Return current position from live data; forecast tracks show as static polylines
  const getInterpolatedStormPosition = (cyc: CycloneEvent): [number, number] => {
    return [cyc.lat, cyc.lng]
  }

  const { user } = useAuth()
  const { articles: newsArticles, loading: newsLoading, error: newsError } = useNews()
  const { resolvedTheme } = useTheme()
  const [newsClock, setNewsClock] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNewsClock(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const newsIncidents = useMemo(() => activeNewsIncidents(newsArticles, newsClock), [newsArticles, newsClock])

  const [filters, setFilters] = useState<FilterState>(() => {
    try {
      const cached = localStorage.getItem('kalasag_hazard_settings')
      if (cached) return normalizeFilters(JSON.parse(cached))
    } catch {}
    return DEFAULT_FILTERS
  })

  const [showFilters, setShowFilters] = useState(false)
  const [showMapToolbar, setShowMapToolbar] = useState(true)
  const [showLegend, setShowLegend] = useState(false)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [sourceHealth, setSourceHealth] = useState<Record<string, SourceHealth[]>>({})
  const [feedErrors, setFeedErrors] = useState<Record<string, string>>({})
  const aircraftFeedError = feedErrors.flights ?? null
  const fetchError = Object.entries(feedErrors).find(([feed]) => feed !== 'flights')?.[1] ?? null
  const [liveWarningDismissed, setLiveWarningDismissed] = useState(false)
  const [showMobileStatus, setShowMobileStatus] = useState(false)
  const [stormNoticeDismissed, setStormNoticeDismissed] = useState(false)

  const [earthquakes, setEarthquakes] = useState<EarthquakeFeature[]>([])
  const [firmsHotspots, setFirmsHotspots] = useState<FIRMSHotspot[]>([])
  const [cyclones, setCyclones] = useState<CycloneEvent[]>([])
  const displayedCyclones = useMemo<CycloneEvent[]>(() => {
    const preview = DEVELOPMENT_TYPHOON_PREVIEW
    if (!preview) return cyclones
    return cyclones.some(cyclone => cyclone.id === preview.id)
      ? cyclones
      : [...cyclones, preview]
  }, [cyclones])
  const hasDevelopmentTyphoonPreview = displayedCyclones.some(cyclone => cyclone.isDevelopmentPreview)
  const liveCycloneCount = cyclones.length
  const [volcanoes, setVolcanoes] = useState<VolcanoData[]>([])
  const [floods, setFloods] = useState<FloodEvent[]>([])
  const [floodAdvisories, setFloodAdvisories] = useState<FloodAdvisory[]>([])
  const [floodAdvisoryMetadata, setFloodAdvisoryMetadata] = useState<HazardFeedMetadata | null>(null)
  const [stormSurgeAdvisories, setStormSurgeAdvisories] = useState<StormSurgeAdvisory[]>([])
  const [stormSurgeMetadata, setStormSurgeMetadata] = useState<HazardFeedMetadata | null>(null)
  const [dams, setDams] = useState<DamStatus[]>([])
  const [damMetadata, setDamMetadata] = useState<HazardFeedMetadata | null>(null)
  const [damReleases, setDamReleases] = useState<DamReleaseAdvisory[]>([])
  const [evacuationCenters, setEvacuationCenters] = useState<EvacuationCenter[]>([])
  const [dynamicSafeGrounds, setDynamicSafeGrounds] = useState<EvacuationCenter[]>([])
  const [safeGroundError, setSafeGroundError] = useState<string | null>(null)
  const [safeGroundScanRadiusKm, setSafeGroundScanRadiusKm] = useState<number>(SAFE_GROUND_AUTO_RADIUS_KM)
  const [safeGroundNotice, setSafeGroundNotice] = useState<{ tone: 'success' | 'warning'; message: string } | null>(null)
  const [hazardReports, setHazardReports] = useState<HazardReport[]>([])
  const [isReportingHazard, setIsReportingHazard] = useState(false)
  const [isPickingHazardLocation, setIsPickingHazardLocation] = useState(false)
  const [hazardPinPos, setHazardPinPos] = useState<[number, number] | null>(null)
  const [hazardForm, setHazardForm] = useState<{ type: HazardReportType; description: string }>({ type: 'Flood', description: '' })
  const [safeGroundRoute, setSafeGroundRoute] = useState<[number, number][] | null>(null)

  const reportDialogRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const mapToolbarButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isReportingHazard) return
    const dialog = reportDialogRef.current
    if (!dialog) return
    const toolbarButton = mapToolbarButtonRef.current

    if (!previousFocusRef.current) previousFocusRef.current = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => dialog.focus())
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setIsReportingHazard(false)
        return
      }
      if (event.key !== 'Tab') return

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    dialog.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      dialog.removeEventListener('keydown', handleKeyDown)
      const previousFocus = previousFocusRef.current
      if (previousFocus?.isConnected) previousFocus.focus()
      else toolbarButton?.focus()
      previousFocusRef.current = null
    }
  }, [isReportingHazard])

  // Load volcanoes from Supabase
  useEffect(() => {
    async function loadVolcanoes() {
      const data = await fetchVolcanoes()
      if (data && data.length > 0) {
        const mapped = data.map(v => ({
          id: v.id,
          name: v.name,
          lat: v.lat,
          lng: v.lng,
          alertLevel: v.alert_level,
          status: v.status,
          details: v.details
        }))
        setVolcanoes(mapped)
      }
    }
    loadVolcanoes()
  }, [])

  const fetchEvacuationCenters = useCallback(async () => {
    const { data, error } = await supabase.from('evacuation_centers').select('*')
    if (error || !data) {
      setLiveWarningDismissed(false)
      setFeedErrors(current => ({ ...current, evacuationCenters: 'Evacuation-center data is temporarily unavailable.' }))
      return false
    }
    setEvacuationCenters(data.flatMap(center => {
      const lat = Number(center.lat), lng = Number(center.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return []
      return [{
        ...center,
        lat,
        lng,
        kind: 'Evacuation Center',
        designated: true,
      } as EvacuationCenter]
    }))
    setFeedErrors(current => { const { evacuationCenters: _, ...remaining } = current; return remaining })
    return true
  }, [])

  const [isFetchingOsm, setIsFetchingOsm] = useState(false)
  const lastOsmFetchPos = useRef<[number, number] | null>(null)
  const nextOsmRetryAt = useRef(0)
  const safeGroundRequestRef = useRef<Promise<EvacuationCenter[] | null> | null>(null)

  const fetchOsmSafeGrounds = useCallback((lat: number, lng: number, radiusKm: number = SAFE_GROUND_AUTO_RADIUS_KM, force = false) => {
    if (safeGroundRequestRef.current) return safeGroundRequestRef.current
    if (!force && Date.now() < nextOsmRetryAt.current) return Promise.resolve(null)

    setIsFetchingOsm(true)
    const request = (async () => {
      try {
        const response = await getLiveData<EvacuationCenter[]>('safe-grounds', { lat, lng, radiusKm })
        setDynamicSafeGrounds(response.data)
        setSafeGroundError(null)
        setSafeGroundScanRadiusKm(radiusKm)
        lastOsmFetchPos.current = [lat, lng]
        nextOsmRetryAt.current = 0
        return response.data
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nearby safe-ground scan is temporarily unavailable.'
        console.warn('[OSM] Safe-ground gateway failed:', error)
        setSafeGroundError(message)
        nextOsmRetryAt.current = Date.now() + 30_000
        return null
      }
    })()

    safeGroundRequestRef.current = request
    void request.finally(() => {
      if (safeGroundRequestRef.current === request) {
        safeGroundRequestRef.current = null
        setIsFetchingOsm(false)
      }
    })
    return request
  }, [])

  const fetchHazardReports = useCallback(async () => {
    const { data, error } = await supabase
      .from('public_hazard_reports')
      .select('id, type, lat, lng, description, upvotes, created_at')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .order('created_at', { ascending: false })
      .limit(HAZARD_REPORT_DISPLAY_LIMIT)
    if (error || !data) {
      setLiveWarningDismissed(false)
      setFeedErrors(current => ({ ...current, hazardReports: 'Recent hazard reports are temporarily unavailable.' }))
      return false
    }
    setHazardReports(data.flatMap(report => {
      const normalized = normalizeHazardReport(report)
      return normalized ? [normalized] : []
    }))
    setFeedErrors(current => { const { hazardReports: _, ...remaining } = current; return remaining })
    return true
  }, [])


  // Load user preferences from Supabase
  useEffect(() => {
    async function loadPrefs() {
      if (user) {
        const cloudPrefs = await fetchUserPreferences(user.id)
        if (cloudPrefs) {
          const newFilters = {
            earthquakes: cloudPrefs.earthquakes ?? true,
            fires: cloudPrefs.fires ?? true,
            weather: cloudPrefs.weather ?? true,
            volcanoes: cloudPrefs.volcanoes ?? true,
            faultLines: cloudPrefs.faultLines ?? false,
            vessels: MARITIME_MONITORING_AVAILABLE && (cloudPrefs.vessels ?? true),
            flights: cloudPrefs.flights ?? true,
            traffic: cloudPrefs.traffic ?? false,
            floods: cloudPrefs.floods ?? true,
            floodAdvisories: cloudPrefs.floodAdvisories ?? true,
            floodSusceptibility: cloudPrefs.floodSusceptibility ?? false,
            stormSurge: cloudPrefs.stormSurge ?? false,
            dams: cloudPrefs.dams ?? true,
            evacuation_centers: cloudPrefs.evacuation_centers ?? true,
            hazard_reports: cloudPrefs.hazard_reports ?? true,
            newsReports: cloudPrefs.newsReports ?? true,
          }
          setFilters(newFilters)
          localStorage.setItem('kalasag_hazard_settings', JSON.stringify(newFilters))
        }
      }
    }
    loadPrefs()
  }, [user])

  const [aisVessels, setAisVessels] = useState<VesselPosition[]>([])
  const [aisConnected, setAisConnected] = useState(false)
  const [aisError, setAisError] = useState<string | null>(null)
  const [gfwLookups, setGfwLookups] = useState<Record<string, GfwLookupState>>({})
  const gfwRequests = useRef(new Set<string>())
  const wsRef = useRef<WebSocket | null>(null)

  const [liveFlights, setLiveFlights] = useState<FlightPosition[]>([])
  const aircraftFeedUnavailableRef = useRef(false)

  const [userLocation, setUserLocation] = useState<[number, number] | null>(null)
  const [userAccuracy, setUserAccuracy] = useState<number>(0)
  const [gpsWatchId, setGpsWatchId] = useState<DeviceLocationWatchId | null>(null)
  const gpsWatchIdRef = useRef<DeviceLocationWatchId | null>(null)
  const gpsWatchRequestRef = useRef(0)
  const gpsStartPendingRef = useRef(false)
  const [trafficError, setTrafficError] = useState<string | null>(null)
  const [gpsLocating, setGpsLocating] = useState(false)

  const stopGpsWatch = useCallback(() => {
    gpsWatchRequestRef.current += 1
    gpsStartPendingRef.current = false
    const id = gpsWatchIdRef.current
    gpsWatchIdRef.current = null
    setGpsWatchId(null)
    setGpsLocating(false)
    if (id !== null) void clearDevicePositionWatch(id)
  }, [])

  useEffect(() => () => {
    gpsWatchRequestRef.current += 1
    gpsStartPendingRef.current = false
    const id = gpsWatchIdRef.current
    gpsWatchIdRef.current = null
    if (id !== null) void clearDevicePositionWatch(id)
  }, [])

  useEffect(() => {
    if (!userLocation) return
    const movedKm = lastOsmFetchPos.current
      ? distanceKm(lastOsmFetchPos.current, userLocation)
      : Number.POSITIVE_INFINITY
    if (movedKm >= SAFE_GROUND_RESCAN_DISTANCE_KM) {
      void fetchOsmSafeGrounds(userLocation[0], userLocation[1], SAFE_GROUND_AUTO_RADIUS_KM)
    }
  }, [userLocation, fetchOsmSafeGrounds])

  const [mapCenterTarget, setMapCenterTarget] = useState<[number, number] | null>(null)
  const [mapCenterZoom, setMapCenterZoom] = useState<number | undefined>(undefined)

  const startGpsWatch = useCallback(async (zoom = 15) => {
    if (gpsWatchIdRef.current !== null) {
      if (userLocation) {
        setMapCenterTarget(userLocation)
        setMapCenterZoom(zoom)
      }
      return
    }
    if (gpsStartPendingRef.current) return

    gpsStartPendingRef.current = true
    const requestId = ++gpsWatchRequestRef.current
    setGpsLocating(true)
    try {
      const id = await watchDevicePosition(
        position => {
          if (requestId !== gpsWatchRequestRef.current) return
          const next: [number, number] = [position.coords.latitude, position.coords.longitude]
          setFeedErrors(current => { const { gps: _, ...remaining } = current; return remaining })
          setUserLocation(next)
          setUserAccuracy(position.coords.accuracy)
          setGpsLocating(false)
          setMapCenterTarget(next)
          setMapCenterZoom(zoom)
        },
        error => {
          if (requestId !== gpsWatchRequestRef.current) return
          console.warn('GPS watch error:', error)
          setLiveWarningDismissed(false)
          setFeedErrors(current => ({ ...current, gps: error.message || 'The device location is unavailable. Check location permission and device location services.' }))
          setGpsLocating(false)
        },
        {
          enableHighAccuracy: true,
          maximumAge: 10_000,
          timeout: 20_000,
          minimumUpdateInterval: 5_000,
          interval: 10_000,
          enableLocationFallback: true,
        },
      )

      if (requestId !== gpsWatchRequestRef.current) {
        void clearDevicePositionWatch(id)
        return
      }
      gpsWatchIdRef.current = id
      setGpsWatchId(id)
    } catch (error) {
      if (requestId === gpsWatchRequestRef.current) {
        console.warn('GPS watch could not start:', error)
        setLiveWarningDismissed(false)
        setFeedErrors(current => ({
          ...current,
          gps: error instanceof Error ? error.message : 'Location tracking could not be started. Check location permission and device location services.',
        }))
        setGpsLocating(false)
      }
    } finally {
      if (requestId === gpsWatchRequestRef.current) gpsStartPendingRef.current = false
    }
  }, [userLocation])
  const handleTrafficFlowError = useCallback((message: string) => setTrafficError(message), [])
  const handleTrafficFlowRecovery = useCallback(() => setTrafficError(null), [])

  const [mapZoom, setMapZoom] = useState(PH_ZOOM)
  const handleZoomChange = useCallback((z: number) => setMapZoom(z), [])

  const [mapTheme, setMapTheme] = useState<'dark' | 'light'>(resolvedTheme)

  useEffect(() => {
    setMapTheme(resolvedTheme)
  }, [resolvedTheme])

  const recordSources = useCallback((feed: string, sources: SourceHealth[]) => {
    setSourceHealth(current => ({ ...current, [feed]: sources }))
  }, [])

  const loadGfwIdentity = useCallback(async (mmsi: string) => {
    if (!MARITIME_MONITORING_AVAILABLE) return
    if (!/^\d{9}$/.test(mmsi) || gfwRequests.current.has(mmsi)) return
    gfwRequests.current.add(mmsi)
    setGfwLookups(current => ({ ...current, [mmsi]: { status: 'loading' } }))
    try {
      const response = await fetchGfwVesselIdentity(mmsi)
      recordSources('vesselIdentity', response.sources)
      setGfwLookups(current => ({ ...current, [mmsi]: { status: 'ready', lookup: response.data } }))
    } catch (error) {
      gfwRequests.current.delete(mmsi)
      setGfwLookups(current => ({ ...current, [mmsi]: { status: 'error', message: error instanceof Error ? error.message : 'Unknown data service error' } }))
    }
  }, [recordSources])

  // Time-sensitive hazard feeds use a server-side gateway. A failed source is
  // surfaced as unavailable; this map never substitutes a public CORS proxy.
  const fetchEarthquakes = useCallback(async () => {
    if (!isOnline) return false
    try {
      const response = await getLiveData<EarthquakeFeature[]>('earthquakes')
      setEarthquakes(response.data)
      recordSources('earthquakes', response.sources)
      setFeedErrors(current => { const { earthquakes: _, ...remaining } = current; return remaining })
      return true
    } catch (err) {
      if (err instanceof LiveDataError) recordSources('earthquakes', err.sources)
      setLiveWarningDismissed(false)
      setFeedErrors(current => ({ ...current, earthquakes: err instanceof Error ? err.message : 'Earthquake feed is unavailable' }))
      return false
    }
  }, [isOnline, recordSources])

  const fetchLiveFloodData = useCallback(async () => {
    if (!isOnline) return false
    try {
      const response = await getLiveData<FloodEvent[]>('floods')
      setFloods(response.data)
      recordSources('floods', response.sources)
      setFeedErrors(current => { const { floods: _, ...remaining } = current; return remaining })
      return true
    } catch (err) {
      if (err instanceof LiveDataError) recordSources('floods', err.sources)
      setLiveWarningDismissed(false)
      setFeedErrors(current => ({ ...current, floods: err instanceof Error ? err.message : 'Flood feeds are unavailable' }))
      return false
    }
  }, [isOnline, recordSources])

  const fetchFloodAdvisories = useCallback(async () => {
    if (!isOnline) return false
    try {
      const response = await getLiveData<FloodAdvisory[]>('flood-advisories')
      setFloodAdvisories(response.data)
      setFloodAdvisoryMetadata(response.metadata ?? null)
      recordSources('floodAdvisories', response.sources)
      setFeedErrors(current => { const { floodAdvisories: _, ...remaining } = current; return remaining })
      return true
    } catch (err) {
      if (err instanceof LiveDataError) recordSources('floodAdvisories', err.sources)
      setLiveWarningDismissed(false)
      setFeedErrors(current => ({ ...current, floodAdvisories: err instanceof Error ? err.message : 'Official flood advisories are unavailable' }))
      return false
    }
  }, [isOnline, recordSources])

  const fetchStormSurgeAdvisories = useCallback(async () => {
    if (!isOnline) return false
    try {
      const response = await getLiveData<StormSurgeAdvisory[]>('storm-surge-advisories')
      setStormSurgeAdvisories(response.data)
      setStormSurgeMetadata(response.metadata ?? null)
      recordSources('stormSurgeAdvisories', response.sources)
      setFeedErrors(current => { const { stormSurgeAdvisories: _, ...remaining } = current; return remaining })
      return true
    } catch (err) {
      if (err instanceof LiveDataError) recordSources('stormSurgeAdvisories', err.sources)
      setLiveWarningDismissed(false)
      setFeedErrors(current => ({ ...current, stormSurgeAdvisories: err instanceof Error ? err.message : 'Official storm-surge advisories are unavailable' }))
      return false
    }
  }, [isOnline, recordSources])

  const fetchDamData = useCallback(async () => {
    if (!isOnline) return false
    const [damResult, releaseResult] = await Promise.allSettled([
      getLiveData<DamStatus[]>('dams'),
      getLiveData<DamReleaseAdvisory[]>('dam-release-advisories'),
    ])
    let loaded = false
    if (damResult.status === 'fulfilled') {
      setDams(current => preserveKnownDamLocations(current, damResult.value.data))
      setDamMetadata(damResult.value.metadata ?? null)
      recordSources('dams', damResult.value.sources)
      setFeedErrors(current => { const { dams: _, ...remaining } = current; return remaining })
      loaded = true
    } else {
      const error = damResult.reason
      if (error instanceof LiveDataError) recordSources('dams', error.sources)
      setLiveWarningDismissed(false)
      setFeedErrors(current => ({ ...current, dams: error instanceof Error ? error.message : 'Official dam observations are unavailable' }))
    }
    if (releaseResult.status === 'fulfilled') {
      setDamReleases(releaseResult.value.data)
      recordSources('damReleases', releaseResult.value.sources)
      setFeedErrors(current => { const { damReleases: _, ...remaining } = current; return remaining })
      loaded = true
    } else {
      const error = releaseResult.reason
      if (error instanceof LiveDataError) recordSources('damReleases', error.sources)
      setFeedErrors(current => ({ ...current, damReleases: error instanceof Error ? error.message : 'Official dam release status is unavailable' }))
    }
    return loaded
  }, [isOnline, recordSources])

  const fetchLiveStormData = useCallback(async () => {
    if (!isOnline) return false
    try {
      const response = await getLiveData<CycloneEvent[]>('storms')
      setCyclones(response.data)
      recordSources('storms', response.sources)
      setFeedErrors(current => { const { storms: _, ...remaining } = current; return remaining })
      return true
    } catch (err) {
      if (err instanceof LiveDataError) recordSources('storms', err.sources)
      setLiveWarningDismissed(false)
      setFeedErrors(current => ({ ...current, storms: err instanceof Error ? err.message : 'Tropical-cyclone feed is unavailable' }))
      return false
    }
  }, [isOnline, recordSources])

  const fetchLiveHeatData = useCallback(async () => {
    if (!isOnline) return false
    try {
      const response = await getLiveData<unknown[]>('heat')
      setFirmsHotspots(await classifyHeatDetections(normalizeCurrentHeatObservations(response.data)))
      recordSources('heat', response.sources)
      setFeedErrors(current => { const { heat: _, ...remaining } = current; return remaining })
      return true
    } catch (err) {
      if (err instanceof LiveDataError) recordSources('heat', err.sources)
      setLiveWarningDismissed(false)
      setFeedErrors(current => ({ ...current, heat: err instanceof Error ? err.message : 'Satellite heat feed is unavailable' }))
      return false
    }
  }, [isOnline, recordSources])

  const refreshAllData = useCallback(async () => {
    setLoading(true)
    setMapCenterTarget(null)
    const results = await Promise.allSettled([
      fetchEarthquakes(), fetchLiveStormData(), fetchLiveHeatData(), fetchLiveFloodData(),
      fetchFloodAdvisories(), fetchStormSurgeAdvisories(), fetchDamData(),
      fetchEvacuationCenters(), fetchHazardReports()
    ])
    if (results.some(result => result.status === 'fulfilled' && result.value === true)) setLastUpdated(new Date())
    setLoading(false)
  }, [fetchEarthquakes, fetchLiveStormData, fetchLiveHeatData, fetchLiveFloodData, fetchFloodAdvisories, fetchStormSurgeAdvisories, fetchDamData, fetchEvacuationCenters, fetchHazardReports])

  useEffect(() => {
    refreshAllData()
    const generalInterval = setInterval(() => {
      void fetchEarthquakes()
      void fetchLiveStormData()
      void fetchLiveFloodData()
      void fetchEvacuationCenters()
      void fetchHazardReports()
    }, 10 * 60 * 1000)
    const heatInterval = setInterval(() => { void fetchLiveHeatData() }, 5 * 60 * 1000)
    const refreshHeatWhenActive = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void fetchLiveHeatData()
    }
    document.addEventListener('visibilitychange', refreshHeatWhenActive)
    window.addEventListener('online', refreshHeatWhenActive)
    const advisoryInterval = setInterval(() => {
      void fetchFloodAdvisories()
      void fetchStormSurgeAdvisories()
    }, 5 * 60 * 1000)
    const damInterval = setInterval(() => { void fetchDamData() }, 30 * 60 * 1000)
    
    // Supabase Realtime Subscription for Hazard Reports
    const channel = supabase.channel('hazard_reports_realtime')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'hazard_reports',
        select: ['id', 'type', 'lat', 'lng', 'description', 'upvotes', 'created_at'],
      }, (payload) => {
        const incoming = normalizeHazardReport(payload.new)
        if (!incoming) return
        setHazardReports(current => {
          // Prevent duplicates if we already fetched it
          if (current.some(report => report.id === incoming.id)) return current
          return [incoming, ...current].slice(0, HAZARD_REPORT_DISPLAY_LIMIT)
        })
      })
      .subscribe()

    return () => {
      clearInterval(generalInterval)
      clearInterval(heatInterval)
      clearInterval(advisoryInterval)
      clearInterval(damInterval)
      document.removeEventListener('visibilitychange', refreshHeatWhenActive)
      window.removeEventListener('online', refreshHeatWhenActive)
      supabase.removeChannel(channel)
    }
  }, [refreshAllData, fetchLiveHeatData, fetchEarthquakes, fetchLiveStormData, fetchLiveFloodData, fetchFloodAdvisories, fetchStormSurgeAdvisories, fetchDamData, fetchEvacuationCenters, fetchHazardReports])

  useEffect(() => {
    if (!MARITIME_MONITORING_AVAILABLE) {
      setAisVessels([])
      setAisConnected(false)
      setAisError(null)
      return undefined
    }

    let cancelled = false
    let retryTimer: number | null = null
    let noDataTimer: number | null = null
    let retryAttempt = 0

    const connect = async () => {
      if (cancelled) return
      let failed = false
      noDataTimer = window.setTimeout(() => {
        setAisError(current => current ?? 'No live vessel reports have been received inside Philippine waters from the current live feed.')
      }, 45_000)
      const retry = () => {
        if (cancelled || failed) return
        failed = true
        if (noDataTimer !== null) window.clearTimeout(noDataTimer)
        setAisConnected(false)
        setAisError('Live vessel connection is temporarily unavailable. Retrying automatically.')
        const baseDelay = Math.min(30_000, 1_000 * 2 ** Math.min(retryAttempt, 5))
        const delay = baseDelay + Math.floor(Math.random() * 500)
        retryAttempt += 1
        retryTimer = window.setTimeout(() => { void connect() }, delay)
      }
      const ws = await connectAISStream(
        (vesselMap: AISVesselMap) => {
          if (cancelled) return
          if (noDataTimer !== null) window.clearTimeout(noDataTimer)
          retryAttempt = 0
          setAisVessels(Array.from(vesselMap.values()))
          setAisConnected(true)
          setAisError(null)
        },
        retry,
        () => {
          if (cancelled) return
          retryAttempt = 0
          setAisConnected(true)
        },
      )
      if (cancelled) {
        ws?.close(1000, 'Map closed')
        return
      }
      wsRef.current = ws
      if (!ws) retry()
    }

    void connect()
    return () => {
      cancelled = true
      if (retryTimer !== null) window.clearTimeout(retryTimer)
      if (noDataTimer !== null) window.clearTimeout(noDataTimer)
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    }
  }, [])

  const allVessels = aisVessels
  const allFlights = liveFlights

  // Poll ADS-B observations every 10 seconds. Airport routes are resolved by
  // the gateway and are never inferred from aircraft movement.
  useEffect(() => {
    if (!filters.flights) return
    let cancelled = false
    const poll = async () => {
      const flights = await fetchGatewayFlights()
      if (flights === null) {
        if (!cancelled) {
          if (!aircraftFeedUnavailableRef.current) setLiveWarningDismissed(false)
          aircraftFeedUnavailableRef.current = true
          setFeedErrors(current => ({
            ...current,
            flights: 'Live aircraft monitoring is temporarily unavailable. Any recently received positions remain visible as stale for up to 5 minutes.',
          }))
          setLiveFlights(previous => previous.filter(flight => Date.now() - flight.lastUpdate < AIRCRAFT_STALE_RETENTION_MS))
        }
        return
      }
      if (!cancelled) {
        aircraftFeedUnavailableRef.current = false
        setFeedErrors(current => { const { flights: _, ...remaining } = current; return remaining })
        setLiveFlights(prev => {
          const now = Date.now()
          const previousById = new Map(prev.map(flight => [flight.icao24, flight]))
          const updated = flights.map(flight => {
            const previous = previousById.get(flight.icao24)
            return previous ? { ...flight, origin: flight.origin || previous.origin, destination: flight.destination || previous.destination, departurePort: flight.departurePort || previous.departurePort, destinationPort: flight.destinationPort || previous.destinationPort, waypoints: flight.waypoints || previous.waypoints, lastUpdate: now } : { ...flight, lastUpdate: now }
          })
          const activeIds = new Set(updated.map(flight => flight.icao24))
          prev.forEach(flight => { if (!activeIds.has(flight.icao24) && now - flight.lastUpdate < AIRCRAFT_LIVE_GRACE_MS) updated.push(flight) })
          return updated
        })
      }
    }
    poll()
    const iv = setInterval(poll, 10_000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [filters.flights])

  useEffect(() => {
    if (!filters.flights || liveFlights.length === 0 || aircraftFeedError) return
    const iv = setInterval(() => setLiveFlights(previous => {
      const now = Date.now()
      return previous
        .filter(flight => now - flight.lastUpdate < AIRCRAFT_LIVE_GRACE_MS)
        .map(flight => interpolateFlightPosition(flight, 2000))
    }), 2000)
    return () => clearInterval(iv)
  }, [aircraftFeedError, filters.flights, liveFlights.length])

  const toggleFilter = (key: keyof FilterState) => {
    if (key === 'vessels' && !MARITIME_MONITORING_AVAILABLE) return
    setFilters(f => {
      const next = { ...f, [key]: !f[key] }
      localStorage.setItem('kalasag_hazard_settings', JSON.stringify(next))
      if (user) {
        upsertUserPreferences(user.id, next as unknown as Record<string, boolean>)
      }
      return next
    })
  }

  const stormOutsideViewport = displayedCyclones.find(c => !c.isDevelopmentPreview && (c.lng > 128 || c.lng < 115 || c.lat > 22 || c.lat < 4))
  const unavailableSourceGroups = ['earthquakes', 'storms', 'floods', 'floodAdvisories', 'stormSurgeAdvisories', 'dams', 'damReleases', 'heat'].filter(feed => {
    const sources = sourceHealth[feed] ?? []
    return sources.length > 0 && sources.every(source => source.status === 'unavailable')
  })
  const heatSources = sourceHealth.heat ?? []
  const heatFeedUnavailable = heatSources.length > 0 && heatSources.every(source => source.status === 'unavailable')
  const officialFreshnessCandidates: Array<[string, HazardFeedMetadata] | null> = [
    filters.floodAdvisories && floodAdvisoryMetadata ? ['Flood advisories', floodAdvisoryMetadata] : null,
    filters.stormSurge && stormSurgeMetadata ? ['Storm-surge status', stormSurgeMetadata] : null,
    filters.dams && damMetadata ? ['Dam observations', damMetadata] : null,
  ]
  const officialRecencyWarnings = officialFreshnessCandidates.filter((entry): entry is [string, HazardFeedMetadata] => Boolean(
    entry && (entry[1].freshness === 'stale' || entry[1].freshness === 'unknown'),
  ))
  const stormSurgeStatusLabel = stormSurgeAdvisories.length
    ? `${stormSurgeAdvisories.length} Storm-Surge Products`
    : feedErrors.stormSurgeAdvisories
      ? 'Storm-surge status unavailable'
      : stormSurgeMetadata
        ? 'Official page reports no active storm-surge product'
        : 'Checking storm-surge status…'
  const urbanHeatIndicationCount = firmsHotspots.filter(hotspot => hotspot.classification.kind === 'potential-residential-fire').length

  const handleFindSafeGround = async () => {
    if (!userLocation) {
      setSafeGroundNotice({ tone: 'warning', message: 'Enable location first so KALASAG can scan around your current GPS position.' })
      return
    }

    let liveCandidates = dynamicSafeGrounds
    let selected: ReturnType<typeof nearestSafeGround> = null
    let selectedRadiusKm: number = SAFE_GROUND_AUTO_RADIUS_KM

    for (const radiusKm of SAFE_GROUND_SEARCH_RADII_KM) {
      const currentScanIsReusable = Boolean(
        lastOsmFetchPos.current
        && distanceKm(lastOsmFetchPos.current, userLocation) < SAFE_GROUND_RESCAN_DISTANCE_KM
        && safeGroundScanRadiusKm >= radiusKm,
      )

      if (!currentScanIsReusable) {
        const fetched = await fetchOsmSafeGrounds(
          userLocation[0],
          userLocation[1],
          radiusKm,
          true,
        )
        if (fetched === null) {
          setSafeGroundNotice({
            tone: 'warning',
            message: safeGroundError || 'The nearby-place service did not respond. The scan will retry from this GPS position the next time you press Find Safe Ground.',
          })
          return
        }
        liveCandidates = fetched
      }

      selected = nearestSafeGround(userLocation, [...evacuationCenters, ...liveCandidates], radiusKm)
      if (selected) {
        selectedRadiusKm = radiusKm
        break
      }
    }

    if (!selected) {
      setSafeGroundRoute(null)
      setSafeGroundNotice({
        tone: 'warning',
        message: `No mapped evacuation center or potential public gathering area was found within ${SAFE_GROUND_SEARCH_RADII_KM.at(-1)} km of this GPS position. Follow local authority instructions and retry as conditions change.`,
      })
      return
    }

    setSafeGroundRoute([userLocation, [selected.lat, selected.lng]])
    setMapCenterTarget([(userLocation[0] + selected.lat) / 2, (userLocation[1] + selected.lng) / 2])
    setMapCenterZoom(selected.distanceKm <= 2 ? 14 : selected.distanceKm <= 5 ? 13 : selected.distanceKm <= 10 ? 12 : 11)
    const distanceLabel = selected.distanceKm < 1
      ? `${Math.round(selected.distanceKm * 1_000)} m`
      : `${selected.distanceKm.toFixed(1)} km`
    setSafeGroundNotice({
      tone: 'success',
      message: `${selected.designated ? 'Nearest designated site' : 'Nearest potential gathering area'}: ${selected.name} (${distanceLabel} away; scanned within ${selectedRadiusKm} km). ${selected.designated ? 'Confirm that it is activated for the current emergency.' : 'This is not a verified evacuation center; check current hazards and local authority guidance before going there.'}`,
    })
    if (window.innerWidth < 640) setShowMapToolbar(false)
  }

  return (
    <div className="relative w-full h-full flex flex-col">
      <MapContainer center={PH_CENTER} zoom={PH_ZOOM} maxZoom={CARTO_RASTER_MAX_ZOOM} className="flex-1 w-full" zoomControl={true}>
        <MapBoundsController centerTarget={mapCenterTarget} centerZoom={mapCenterZoom} />
        <ZoomTracker onZoomChange={handleZoomChange} />
        {HAZARD_REPORTING_ENABLED && isPickingHazardLocation && (
          <HazardReportLocationPicker
            onSelect={position => {
              setHazardPinPos(position)
              setIsPickingHazardLocation(false)
              setIsReportingHazard(true)
            }}
          />
        )}
        {HAZARD_REPORTING_ENABLED && (isPickingHazardLocation || isReportingHazard) && hazardPinPos && <Marker position={hazardPinPos} icon={hazardReportIcon('draft', mapZoom)}><Popup>Hazard report location</Popup></Marker>}
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
          url={mapTheme === 'dark' ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"}
          maxZoom={CARTO_RASTER_MAX_ZOOM}
          maxNativeZoom={CARTO_RASTER_MAX_ZOOM}
        />
        <HazardBaselineLayer enabled={filters.floodSusceptibility} kind="flood" />
        <HazardBaselineLayer enabled={filters.stormSurge} kind="storm-surge" />
        {filters.traffic && <TrafficFlowLayer theme={mapTheme} onError={handleTrafficFlowError} onRecovery={handleTrafficFlowRecovery} />}
        <Polygon positions={PAR_BOUNDARY} pathOptions={{ color: '#3b82f6', weight: 2, dashArray: '5, 5', fillOpacity: 0 }} />
        <HazardAdvisoryAreas
          floodAdvisories={floodAdvisories}
          showFlood={filters.floodAdvisories}
          showStormSurge={filters.stormSurge}
          stormSurgeAdvisories={stormSurgeAdvisories}
        />
        {filters.earthquakes && earthquakes.map(eq => {
          const [lng, lat, depth] = eq.geometry.coordinates
          const mag = eq.properties.mag
          const r = Math.max(6, Math.min(40, mag * 5.5)) * zoomScale(mapZoom, 1.0)
          const time = new Date(eq.properties.time).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })
          return (
            <CircleMarker key={eq.id} center={[lat, lng]} radius={r} pathOptions={{ color: magColor(mag), fillColor: magColor(mag), fillOpacity: 0.4, weight: 1.5 }}>
              <Popup>
                <div className="min-w-[180px] space-y-1 text-xs text-[var(--text)]">
                  <p className="font-bold text-sm" style={{ color: magColor(mag) }}>M{mag.toFixed(1)} Earthquake</p>
                  <p className="text-[var(--text-soft)]">{eq.properties.place}</p>
                  <p>Depth: <span className="font-medium">{depth.toFixed(1)} km</span></p>
                  <p className="text-[10px] text-[var(--muted)]">{time}</p>
                </div>
              </Popup>
            </CircleMarker>
          )
        })}
        {filters.fires && firmsHotspots.map(hotspot => {
          const frp = hotspot.frp
          const dotColor = frp > 50 ? '#ff0000' : frp > 15 ? '#ff4500' : frp > 5 ? '#ff7700' : '#ffaa00'
          const isHigh = hotspot.classification.confidence === 'high'
          const isUrbanHeatIndication = hotspot.classification.kind === 'potential-residential-fire'
          const indicatorColor = isUrbanHeatIndication ? '#dc2626' : dotColor
          const heatLabel = isUrbanHeatIndication ? 'Urban-area satellite heat indication' : 'Satellite heat indication'
          const urbanProximityKm = hotspot.classification.kind === 'potential-residential-fire' ? hotspot.classification.urbanProximityKm : null
          const urbanContext = urbanProximityKm === 0
            ? 'Inside a mapped urban settlement cell'
            : urbanProximityKm === null
              ? ''
              : `Within ${urbanProximityKm.toFixed(1)} km of a mapped urban settlement cell`
          const firePopup = (
            <Popup>
              <div className="min-w-[190px] space-y-1 text-xs text-[var(--text)]">
                <p className="font-bold text-sm" style={{ color: indicatorColor }}>{heatLabel}</p>
                <p className="text-[var(--text-soft)]">Lat: {hotspot.lat.toFixed(4)}°N &nbsp; Lng: {hotspot.lng.toFixed(4)}°E</p>
                {userLocation && (
                  <p className="text-[var(--color-yellow-warn)] font-semibold text-[11px]">
                    📍 {(() => { const R = 6371; const dLat = (hotspot.lat - userLocation[0]) * Math.PI / 180; const dLon = (hotspot.lng - userLocation[1]) * Math.PI / 180; const a = Math.sin(dLat/2)**2 + Math.cos(userLocation[0]*Math.PI/180)*Math.cos(hotspot.lat*Math.PI/180)*Math.sin(dLon/2)**2; const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); return d < 1 ? `${Math.round(d * 1000)}m from you` : `${d.toFixed(1)} km from you` })()}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1">
                  <span className="text-[var(--muted)]">Intensity (FRP)</span><span className="font-semibold" style={{ color: indicatorColor }}>{hotspot.frp.toFixed(1)} MW</span>
                  <span className="text-[var(--muted)]">Brightness</span><span className="font-medium">{hotspot.brightness.toFixed(0)} K</span>
                  <span className="text-[var(--muted)]">Confidence</span><span className="font-medium capitalize">{hotspot.classification.confidence}</span>
                  <span className="text-[var(--muted)]">Satellite</span><span className="font-medium">{hotspot.satellite} VIIRS</span>
                  <span className="text-[var(--muted)]">Observed</span><span className="font-medium">{new Date(hotspot.observedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })}</span>
                  <span className="text-[var(--muted)]">Observation age</span><span className="font-medium">{heatObservationAgeLabel(hotspot)}</span>
                  <span className="text-[var(--muted)]">Pass</span><span className="font-medium">{hotspot.daynight === 'D' ? '☀️ Daytime' : hotspot.daynight === 'N' ? '🌙 Nighttime' : 'Unknown'}</span>
                </div>
                {isUrbanHeatIndication
                  ? <p className="mt-2 border-t border-[var(--border)] pt-2 text-[10px] leading-relaxed text-[var(--danger)]"><strong>{urbanContext}.</strong> Automated from nominal/high-confidence satellite heat data and a settlement grid. It cannot identify whether the source is residential, commercial, industrial, or vegetation, and is not confirmation of a structure fire. Verify through local authorities.</p>
                  : <p className="mt-1 text-[10px] text-[var(--muted)]">Near-real-time satellite thermal observation from the past 24 hours. It is not confirmation of a fire, structure, or land use, and orbital coverage is not continuous.</p>}
              </div>
            </Popup>
          )
          if (isUrbanHeatIndication) {
            return (<Marker key={hotspot.id} position={[hotspot.lat, hotspot.lng]} icon={potentialResidentialFireIcon(mapZoom)}>{firePopup}</Marker>)
          }
          if (mapZoom < 10) {
            return (<CircleMarker key={hotspot.id} center={[hotspot.lat, hotspot.lng]} radius={fireHotspotOverviewRadius(frp, hotspot.classification.confidence, mapZoom)} pathOptions={{ color: dotColor, fillColor: dotColor, fillOpacity: isHigh ? 0.9 : 0.78, weight: 2 }}>{firePopup}</CircleMarker>)
          }
          return (
            <div key={hotspot.id}>
              <Marker position={[hotspot.lat, hotspot.lng]} icon={fireHotspotIcon(hotspot.frp, hotspot.classification.confidence, mapZoom)}>{firePopup}</Marker>
            </div>
          )
        })}
        {filters.weather && displayedCyclones.map(cyc => {
          const animatedPos = getInterpolatedStormPosition(cyc)
          const color = cyc.alertlevel === 'Red' ? '#e53e3e' : cyc.alertlevel === 'Orange' ? '#ff6b00' : '#22c55e'
          return (
            <div key={cyc.id}>
              {cyc.observedTrack && cyc.observedTrack.length > 1 && (
                <Polyline positions={cyc.observedTrack} pathOptions={{ color: '#ff1744', weight: 3.5, opacity: 0.95 }} />
              )}
              {cyc.observedTrack?.map((point, index) => <CircleMarker key={`observed-${cyc.id}-${index}`} center={point} radius={Math.round(3.5 * zoomScale(mapZoom, 1.15))} pathOptions={{ color: '#ff1744', fillColor: '#ff1744', fillOpacity: 1, weight: 1 }} />)}
              {cyc.forecastTrack && cyc.forecastTrack.length > 1 && (
                <Polyline positions={cyc.forecastTrack} pathOptions={{ color: '#fbbf24', weight: 2.5, dashArray: '8, 7', opacity: 0.9 }} />
              )}
              {cyc.forecastTrack && cyc.forecastTrack.slice(1).map((pt, i) => (
                <CircleMarker key={`forecast-${cyc.id}-${i}`} center={pt} radius={Math.round(4 * zoomScale(mapZoom, 1.2))} pathOptions={{ color: '#fbbf24', fillColor: '#201800', fillOpacity: 0.9, weight: 1.5 }} />
              ))}
              <Marker position={animatedPos} icon={createStormCenterIcon(mapZoom)}>
                <Popup>
                  <div className="min-w-[210px] space-y-1.5 text-xs text-[var(--text)]">
                    <p className="font-black text-sm text-[var(--color-red-alert)] tracking-tight">🌀 {cyc.name}</p>
                    {cyc.localName && <p className="text-[var(--color-yellow-warn)] font-semibold text-[11px]">PH Name: {cyc.localName}</p>}
                    {cyc.isDevelopmentPreview && <p className="rounded-md bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-300">Development preview — simulated only. No live alert or safety notification is generated.</p>}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-1">
                      <span className="text-[var(--muted)]">Alert Level</span><span className="font-bold" style={{ color }}>{cyc.alertlevel}</span>
                      {cyc.windKph && <><span className="text-[var(--muted)]">Max Winds</span><span className="font-bold text-[var(--color-red-alert)]">{cyc.windKph} km/h</span></>}
                      <span className="text-[var(--muted)]">Position</span><span className="font-medium">{animatedPos[0].toFixed(1)}°N {animatedPos[1].toFixed(1)}°E</span>
                    </div>
                    <p className="mt-1 leading-relaxed text-[var(--text-soft)]">{cyc.description}</p>
                    <p className="mt-1 text-[10px] text-[var(--muted)]">Red dots: observed trail · dashed amber: forecast</p>
                  </div>
                </Popup>
              </Marker>
            </div>
          )
        })}
        {filters.floods && floods.map(f => {
          const color = f.alertlevel === 'Red' ? '#1d4ed8' : f.alertlevel === 'Orange' ? '#2563eb' : '#60a5fa'
          return (
            <CircleMarker key={f.id} center={[f.lat, f.lng]} radius={Math.round(6 * zoomScale(mapZoom, 1.1))} pathOptions={{ color, fillColor: color, fillOpacity: 0.8, weight: 2 }}>
              <Popup>
                <div className="min-w-[180px] space-y-1 text-xs text-[var(--text)]">
                  <p className="font-bold text-sm text-blue-400">Reported flood event: {f.name}</p>
                  <p>Feed severity: <span className="font-bold" style={{ color }}>{f.severity || 'Not reported'}</span></p>
                  <p className="mt-1 leading-relaxed text-[var(--text-soft)]">{f.description}</p>
                  {f.observedAt && <p className="text-[10px] text-[var(--muted)]">Reported {new Date(f.observedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</p>}
                  <p className="mt-1 rounded bg-blue-500/10 p-1.5 text-[10px] font-semibold text-blue-300">Point location only. It does not represent flood depth, radius, or current inundation extent.</p>
                </div>
              </Popup>
            </CircleMarker>
          )
        })}
        <DamStatusLayer dams={dams} enabled={filters.dams} releases={damReleases} />
        {filters.volcanoes && volcanoes.map(vol => (
          <Marker key={vol.id} position={[vol.lat, vol.lng]} icon={volcanoIcon(vol.alertLevel, mapZoom)}>
            <Popup>
              <div className="min-w-[180px] space-y-1 text-xs text-[var(--text)]">
                <p className="font-bold text-sm text-[var(--color-red-alert)] font-black">🌋 {vol.name}</p>
                <p>Alert Status: <span className="font-bold text-[var(--color-orange)]">Level {vol.alertLevel} – {vol.status}</span></p>
                <p className="mt-1 leading-relaxed text-[var(--text-soft)]">{vol.details}</p>
              </div>
            </Popup>
          </Marker>
        ))}
        {userLocation && (
          <>
            <Circle center={userLocation} radius={Math.min(userAccuracy || 50, 500)} pathOptions={{ color: '#4285f4', fillColor: '#4285f4', fillOpacity: 0.12, weight: 1, dashArray: '4, 4' }} />
            <Marker position={userLocation} icon={userLocationIcon(mapZoom)}>
              <Popup>
                <div className="min-w-[150px] space-y-1 text-xs text-[var(--text)]">
                  <p className="font-bold text-sm text-[#4285f4]">📍 Your Location</p>
                  <p>{userLocation[0].toFixed(5)}°N, {userLocation[1].toFixed(5)}°E</p>
                  <p className="text-[var(--muted)]">Accuracy: ±{Math.round(userAccuracy)}m</p>
                </div>
              </Popup>
            </Marker>
          </>
        )}
        {filters.faultLines && PH_FAULT_LINES.map(fault => {
          const color = fault.riskLevel === 'high' ? '#ef4444' : fault.riskLevel === 'moderate' ? '#f59e0b' : '#6b7280'
          const weight = fault.type === 'subduction' ? 3 : 2
          const dashArray = fault.type === 'subduction' ? '8, 6' : undefined
          return (
            <Polyline key={fault.id} positions={fault.coordinates} pathOptions={{ color, weight, opacity: 0.8, dashArray }}>
              <Popup>
                <div className="min-w-[200px] space-y-1 text-xs text-[var(--text)]">
                  <p className="font-bold text-sm" style={{ color }}>⚡ {fault.name}</p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                    <span className="text-[var(--muted)]">System</span><span className="font-medium">{fault.system}</span>
                    <span className="text-[var(--muted)]">Type</span><span className="font-medium capitalize">{fault.type.replace('-', ' ')}</span>
                    <span className="text-[var(--muted)]">Risk Level</span><span className="font-bold capitalize" style={{ color }}>{fault.riskLevel}</span>
                  </div>
                  <p className="mt-1 leading-relaxed text-[var(--text-soft)]">{fault.description}</p>
                </div>
              </Popup>
            </Polyline>
          )
        })}
        {MARITIME_MONITORING_AVAILABLE && filters.vessels && allVessels.map(v => (
          <div key={v.id}>
            <Polyline positions={v.waypoints} pathOptions={{ color: v.type === 'Military/Patrol' ? '#60a5fa' : v.type === 'Container' ? '#a78bfa' : v.type === 'Cargo' ? '#f59e0b' : v.type === 'Fishing' ? '#34d399' : '#22d3ee', weight: 1.5, opacity: 0.4, dashArray: '6, 8' }} />
            <CircleMarker center={v.waypoints[0]} radius={Math.round(4 * zoomScale(mapZoom, 1.2))} pathOptions={{ color: '#4ade80', fillColor: '#4ade80', fillOpacity: 0.8, weight: 1 }}>
              <Popup><div className="text-xs text-[var(--text)]"><p className="font-bold">🟢 {v.departurePort}</p><p className="text-[var(--muted)]">Departure Port</p></div></Popup>
            </CircleMarker>
            <CircleMarker center={v.waypoints[v.waypoints.length - 1]} radius={Math.round(4 * zoomScale(mapZoom, 1.2))} pathOptions={{ color: '#f87171', fillColor: '#f87171', fillOpacity: 0.8, weight: 1 }}>
              <Popup><div className="text-xs text-[var(--text)]"><p className="font-bold">🔴 {v.destinationPort}</p><p className="text-[var(--muted)]">Destination Port</p></div></Popup>
            </CircleMarker>
            <Marker position={[v.lat, v.lng]} icon={vesselIcon(v.heading, v.type, v.status, mapZoom)} eventHandlers={{ popupopen: () => { void loadGfwIdentity(v.mmsi) } }}>
              <Popup>
                <div className="min-w-[200px] space-y-1 text-xs text-[var(--text)]">
                  <p className="font-bold text-sm text-[#22d3ee]">🚢 {v.name}</p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                    <span className="text-[var(--muted)]">Type</span><span className="font-medium">{v.type}</span>
                    <span className="text-[var(--muted)]">MMSI</span><span className="font-medium">{v.mmsi}</span>
                    <span className="text-[var(--muted)]">Flag</span><span className="font-medium">{v.flag}</span>
                    <span className="text-[var(--muted)]">From</span><span className="font-medium text-green-400">{v.departurePort}</span>
                    <span className="text-[var(--muted)]">To</span><span className="font-medium text-red-400">{v.destinationPort}</span>
                    <span className="text-[var(--muted)]">Speed</span><span className="font-semibold">{v.speedKnots} kn</span>
                    <span className="text-[var(--muted)]">Heading</span><span className="font-medium">{v.heading.toFixed(0)}°</span>
                    <span className="text-[var(--muted)]">Status</span><span className={`font-bold ${v.status === 'underway' ? 'text-green-400' : 'text-yellow-400'}`}>{v.status === 'underway' ? '▶ Underway' : '⚓ At Port'}</span>
                    <span className="text-[var(--muted)]">Position</span><span className="font-medium">Live AIS report</span>
                  </div>
                  <GfwVesselDetails state={gfwLookups[v.mmsi]} />
                  <p className="mt-1 text-[10px] text-[var(--muted)]">🟢 Live AIS position report</p>
                </div>
              </Popup>
            </Marker>
          </div>
        ))}
        {filters.flights && allFlights.map(f => {
          const hasRoute = f.waypoints && f.waypoints.length > 1
          const routeSegments = hasRoute ? flightRouteGuideSegments(f.waypoints!, [f.lat, f.lng]) : null
          const routeEnd = routeSegments?.destinationTrail[routeSegments.destinationTrail.length - 1] ?? routeSegments?.departureTrail[routeSegments.departureTrail.length - 1]
          const trailColor = f.aircraftType === 'Military' ? '#60a5fa' : f.aircraftType === 'Rescue' ? '#f87171' : f.aircraftType === 'Cargo' ? '#f59e0b' : '#c084fc'
          return (
            <div key={f.id}>
              {routeSegments && routeSegments.departureTrail.length > 1 && <Polyline positions={routeSegments.departureTrail} pathOptions={{ color: trailColor, weight: 2.25, opacity: 0.75, dashArray: '7, 7' }} />}
              {routeSegments && routeSegments.destinationTrail.length > 1 && <Polyline positions={routeSegments.destinationTrail} pathOptions={{ color: trailColor, weight: 1.15, opacity: 0.62, dashArray: '5, 8' }} />}
              {hasRoute && <CircleMarker center={f.waypoints![0]} radius={Math.round(4 * zoomScale(mapZoom, 1.2))} pathOptions={{ color: '#4ade80', fillColor: '#4ade80', fillOpacity: 0.8, weight: 1 }}><Popup><div className="text-xs text-[var(--text)]"><p className="font-bold">🟢 {f.departurePort || 'Departure Airport'}</p><p className="text-[var(--muted)]">Departure Airport ({f.origin})</p></div></Popup></CircleMarker>}
              {hasRoute && routeEnd && <CircleMarker center={routeEnd} radius={Math.round(4 * zoomScale(mapZoom, 1.2))} pathOptions={{ color: '#f87171', fillColor: '#f87171', fillOpacity: 0.8, weight: 1 }}><Popup><div className="text-xs text-[var(--text)]"><p className="font-bold">🔴 {f.destinationPort || 'Destination Airport'}</p><p className="text-[var(--muted)]">Destination Airport ({f.destination})</p></div></Popup></CircleMarker>}
              <Marker position={[f.lat, f.lng]} icon={flightIcon(f.heading, f.aircraftType, f.onGround, mapZoom)}>
                <Popup>
                  <div className="min-w-[190px] space-y-1 text-xs text-[var(--text)]">
                    <p className="font-bold text-sm text-[#a78bfa]">✈ {f.callsign}</p>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      <span className="text-[var(--muted)]">Airline</span><span className="font-medium">{f.airline}</span>
                      <span className="text-[var(--muted)]">Type</span><span className="font-medium">{f.aircraftType}</span>
                      <span className="text-[var(--muted)]">Alt</span><span className="font-medium">{f.altitude.toLocaleString()} ft</span>
                      <span className="text-[var(--muted)]">Speed</span><span className="font-medium">{f.groundSpeed} kn</span>
                      <span className="text-[var(--muted)]">Heading</span><span className="font-medium">{(f.heading ?? 0).toFixed(0)}°</span>
                      {f.departurePort && <><span className="text-[var(--muted)]">From</span><span className="font-medium text-green-400">{f.departurePort} ({f.origin})</span></>}
                      {f.destinationPort && <><span className="text-[var(--muted)]">To</span><span className="font-medium text-red-400">{f.destinationPort} ({f.destination})</span></>}
                      {!hasRoute && <><span className="text-[var(--muted)]">Route</span><span className="font-medium text-[var(--text-soft)]">Not resolved by route feed</span></>}
                    </div>
                    <p className={`text-[10px] ${aircraftFeedError ? 'font-semibold text-[var(--warning)]' : 'text-[var(--text-soft)]'}`}>
                      {aircraftFeedError ? 'Stale last-received position — live aircraft feed delayed' : 'Live aircraft position'}
                    </p>
                    {hasRoute && <p className="text-[10px] text-[var(--muted)]">Dotted line connects the reported airports through the current live aircraft position. It is a guide, not an assigned airway or cleared flight plan.</p>}
                  </div>
                </Popup>
              </Marker>
            </div>
          )
        })}
        {filters.evacuation_centers && [...evacuationCenters, ...dynamicSafeGrounds].map(ec => (
          <Marker key={ec.id} position={[ec.lat, ec.lng]} icon={evacuationIcon(mapZoom, ec.isOsm)}>
            <Popup>
              <div className="min-w-[180px] space-y-1 text-xs text-[var(--text)]">
                <p className={`font-bold text-sm ${ec.isOsm ? 'text-[#60a5fa]' : 'text-[#4ade80]'}`}>
                  {ec.isOsm ? '📍' : '🛡️'} {ec.name}
                </p>
                <p className="text-[var(--text-soft)]">{ec.address}</p>
                <p className={ec.designated ? 'font-semibold text-[#4ade80]' : 'font-semibold text-[#93c5fd]'}>{ec.kind || (ec.designated ? 'Evacuation Center' : 'Potential Gathering Area')}</p>
                <p>Status: <span className="font-medium text-[var(--text)]">{ec.status}</span></p>
                {userLocation && <p className="text-[10px] text-[var(--muted)]">Straight-line distance: {distanceKm(userLocation, [ec.lat, ec.lng]).toFixed(1)} km</p>}
                {userLocation && (
                  <button onClick={() => {
                    setSafeGroundRoute([userLocation, [ec.lat, ec.lng]])
                    setMapCenterTarget([ec.lat, ec.lng])
                    setMapCenterZoom(15)
                  }} className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border py-1.5 font-bold transition-colors duration-[150ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--action)] motion-reduce:transition-none ${
                    ec.isOsm 
                      ? 'bg-[#3b82f6]/20 text-[#60a5fa] border-[#3b82f6]/50 hover:bg-[#3b82f6]/30' 
                      : 'bg-[#4ade80]/20 text-[#4ade80] border-[#4ade80]/50 hover:bg-[#4ade80]/30'
                  }`}>
                    <Navigation size={12} /> Route Here
                  </button>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
        {filters.newsReports && newsIncidents.map(article => (
          <Marker
            key={`news-${article.id}`}
            position={[article.lat!, article.lng!]}
            icon={newsIncidentIcon(article, mapZoom)}
          >
            <Popup>
              <div className="min-w-[220px] max-w-[290px] space-y-2 text-xs text-[var(--text)]">
                <div className="flex items-center gap-2">
                  <NewsIncidentSymbol category={article.category} size={24} />
                  <div>
                    <p className="font-bold text-[var(--warning)]">News-reported secondary signal</p>
                    <p className="text-[10px] text-[var(--muted)]">{newsCategoryLabel(article.category)}</p>
                  </div>
                </div>
                <p className="text-sm font-bold leading-snug">{article.title}</p>
                <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[11px]">
                  <span className="text-[var(--muted)]">Publisher</span>
                  <span className="font-semibold">{article.sourceName}</span>
                  <span className="text-[var(--muted)]">Status</span>
                  <span className="font-semibold">
                    {article.verification === 'multiple-outlets-reported'
                      ? 'Reported by multiple outlets'
                      : 'Reported by one outlet'}
                  </span>
                  <span className="text-[var(--muted)]">Published</span>
                  <span>{new Date(article.publishedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</span>
                  <span className="text-[var(--muted)]">Detected</span>
                  <span>{new Date(article.firstDetectedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}</span>
                  <span className="text-[var(--muted)]">Location</span>
                  <span>
                    {article.locationName ?? 'Publisher-described location'}
                    {article.locationPrecision === 'locality'
                      ? ' (approximate locality)'
                      : article.locationPrecision === 'offshore'
                        ? ' (publisher-reported offshore coordinate)'
                        : ''}
                  </span>
                  <span className="text-[var(--muted)]">Confidence</span>
                  <span>{Math.round((article.locationConfidence ?? 0) * 100)}%</span>
                </div>
                <p className="rounded-md bg-[var(--warning-soft)] px-2 py-1.5 text-[10px] leading-relaxed text-[var(--text-soft)]">
                  Verify against official instructions before acting. This marker cannot trigger a proximity alarm.
                </p>
                {article.sourceId === 'inquirer-newsinfo' && (
                  <p className="text-[10px] text-[var(--muted)]">
                    The following link will take you to INQUIRER.net.
                  </p>
                )}
                <a
                  href={article.articleUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ui-control inline-flex min-h-10 w-full items-center justify-center rounded-md bg-[var(--action)] px-3 py-2 font-semibold text-[var(--action-text)] hover:bg-[var(--action-hover)]"
                >
                  {article.sourceId === 'inquirer-newsinfo' ? 'Open on INQUIRER.net' : 'Read original report'}
                </a>
              </div>
            </Popup>
          </Marker>
        ))}
        {filters.hazard_reports && hazardReports.map(hr => (
          <Marker key={hr.id} position={[hr.lat, hr.lng]} icon={hazardReportIcon(hr.type, mapZoom)}>
            <Popup>
              <div className="min-w-[180px] space-y-1 text-xs text-[var(--text)]">
                  <p className="text-sm font-bold text-[var(--danger)]">⚠️ {hr.type}</p>
                <p className="mt-1 text-[var(--text-soft)]">{hr.description}</p>
                <p className="mt-2 text-[10px] text-[var(--muted)]">{new Date(hr.created_at).toLocaleString()}</p>
                <p className="flex items-center gap-1 text-[10px] text-[var(--muted)]">Upvotes: {hr.upvotes}</p>
              </div>
            </Popup>
          </Marker>
        ))}
        {safeGroundRoute && (
          <Polyline positions={safeGroundRoute} pathOptions={{ color: '#4ade80', weight: 4, dashArray: '8, 8', opacity: 0.8 }} />
        )}
      </MapContainer>

      <div className="pointer-events-none absolute left-3 top-3 z-[1000] flex max-h-[calc(100%-1.5rem)] w-[calc(100vw-5rem)] max-w-sm flex-col gap-2 overflow-y-auto pr-1 sm:w-80" aria-live="polite">
        {hasDevelopmentTyphoonPreview && (
          <div role="status" className="pointer-events-auto rounded-[var(--radius-md)] border border-amber-400/40 bg-[var(--panel)] px-3 py-2 text-xs text-[var(--text-soft)] shadow-[var(--shadow-md)]">
            <p className="font-bold text-amber-300">Development typhoon preview active</p>
            <p className="mt-0.5">Simulated local-only data is showing the storm marker and paths. It is not live data and cannot send alerts.</p>
          </div>
        )}
        {!isOnline && (
          <div className="pointer-events-auto glass-card flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--warning-border)] px-3 py-2 text-xs text-[var(--warning)] shadow-[var(--shadow-md)] animate-fade-in">
            <WifiOff size={14} className="shrink-0" />
            <span>Offline - map tiles unavailable. Showing cached data layers.</span>
          </div>
        )}

        {filters.floodSusceptibility && !hazardBaselineConfiguration.flood.configured && (
          <div role="status" className="pointer-events-auto rounded-[var(--radius-md)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--text-soft)] shadow-[var(--shadow-md)]">
            <p className="font-bold text-blue-400">Flood susceptibility layer not configured</p>
            <p className="mt-0.5">An authorized baseline tile URL must be configured for this deployment. No estimated flood extent is being drawn.</p>
          </div>
        )}

        {filters.stormSurge && !hazardBaselineConfiguration.stormSurge.configured && !stormSurgeAdvisories.some(item => item.geometry) && (
          <div role="status" className="pointer-events-auto rounded-[var(--radius-md)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--text-soft)] shadow-[var(--shadow-md)]">
            <p className="font-bold text-rose-400">Storm-surge map layer unavailable</p>
            <p className="mt-0.5">No authorized scenario tiles or official machine-readable advisory geometry are configured. KALASAG will not invent a coastal extent.</p>
          </div>
        )}

        {filters.dams && dams.length > 0 && !dams.some(isMappableDam) && (
          <div role="status" className="pointer-events-auto rounded-[var(--radius-md)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--text-soft)] shadow-[var(--shadow-md)]">
            <p className="font-bold text-sky-400">Dam observations loaded without map positions</p>
            <p className="mt-0.5">The official location service is unavailable. Water-level observations remain available in Dam Status, but no approximate markers are substituted.</p>
          </div>
        )}

        {isOnline && !liveWarningDismissed && (fetchError || unavailableSourceGroups.length > 0) && (
          <div role="alert" className="pointer-events-auto relative rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--panel)] px-3 py-2 pr-10 text-xs text-[var(--text-soft)] shadow-[var(--shadow-md)]">
            <button type="button" onClick={() => setLiveWarningDismissed(true)} aria-label="Dismiss live data warning" className="ui-control absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button>
            <p className="font-bold text-[var(--danger)]">Some live data is unavailable</p>
            <p className="mt-0.5">{fetchError || 'A complete live feed is temporarily unavailable. Verified data already on the map remains visible while it retries.'}</p>
          </div>
        )}

        {isOnline && !liveWarningDismissed && officialRecencyWarnings.length > 0 && (
          <div role="status" className="pointer-events-auto relative rounded-[var(--radius-md)] border border-[var(--warning-border)] bg-[var(--panel)] px-3 py-2 pr-10 text-xs text-[var(--text-soft)] shadow-[var(--shadow-md)]">
            <button type="button" onClick={() => setLiveWarningDismissed(true)} aria-label="Dismiss official data recency warning" className="ui-control absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button>
            <p className="font-bold text-[var(--warning)]">Official data recency warning</p>
            <div className="mt-1 space-y-1">
              {officialRecencyWarnings.map(([label, metadata]) => <p key={label}>{officialFreshnessWarning(label, metadata)}</p>)}
            </div>
          </div>
        )}

        {safeGroundNotice && (
          <div role="status" className={`pointer-events-auto relative rounded-[var(--radius-md)] border px-3 py-2 pr-10 text-xs shadow-[var(--shadow-md)] ${safeGroundNotice.tone === 'success' ? 'border-[var(--success-border)] bg-[var(--panel)] text-[var(--text-soft)]' : 'border-[var(--warning-border)] bg-[var(--panel)] text-[var(--text-soft)]'}`}>
            <button type="button" onClick={() => setSafeGroundNotice(null)} aria-label="Dismiss safe-ground result" className="ui-control absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button>
            <p className={`font-bold ${safeGroundNotice.tone === 'success' ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>{safeGroundNotice.tone === 'success' ? 'Nearby safe-ground result' : 'Safe-ground scan notice'}</p>
            <p className="mt-0.5 leading-relaxed">{safeGroundNotice.message}</p>
          </div>
        )}

        {isOnline && filters.flights && !liveWarningDismissed && aircraftFeedError && (
          <div role="status" className="pointer-events-auto relative rounded-[var(--radius-md)] border border-[var(--warning-border)] bg-[var(--panel)] px-3 py-2 pr-10 text-xs text-[var(--text-soft)] shadow-[var(--shadow-md)]">
            <button type="button" onClick={() => setLiveWarningDismissed(true)} aria-label="Dismiss aircraft warning" className="ui-control absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button>
            <p className="font-bold text-[var(--warning)]">Aircraft monitoring delayed</p>
            <p className="mt-0.5">{aircraftFeedError}</p>
          </div>
        )}

        {MARITIME_MONITORING_AVAILABLE && filters.vessels && aisError && (
          <div role="status" className="pointer-events-auto relative rounded-[var(--radius-md)] border border-[var(--warning-border)] bg-[var(--panel)] px-3 py-2 pr-10 text-xs text-[var(--text-soft)] shadow-[var(--shadow-md)]">
            <button type="button" onClick={() => setAisError(null)} aria-label="Dismiss maritime warning" className="ui-control absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button>
            <p className="font-bold text-[var(--warning)]">Maritime monitoring unavailable</p>
            <p className="mt-0.5">{aisError}</p>
          </div>
        )}

        {filters.traffic && trafficError && (
          <div role="status" className="pointer-events-auto relative rounded-[var(--radius-md)] border border-[var(--warning-border)] bg-[var(--panel)] px-3 py-2 pr-10 text-xs text-[var(--text-soft)] shadow-[var(--shadow-md)]">
            <button type="button" onClick={() => setTrafficError(null)} aria-label="Dismiss road traffic warning" className="ui-control absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button>
            <p className="font-bold text-[var(--warning)]">Road traffic monitoring unavailable</p>
            <p className="mt-0.5">{trafficError}</p>
          </div>
        )}

        {stormOutsideViewport && !stormNoticeDismissed && (
          <div className="pointer-events-auto glass-card relative flex w-full flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--danger-border)] p-3 shadow-[var(--shadow-md)] animate-slide-up">
            <button type="button" onClick={() => setStormNoticeDismissed(true)} aria-label="Dismiss storm notice" className="ui-control absolute right-1 top-1 grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button>
            <div className="flex items-center gap-1.5 pr-7"><CloudLightning size={14} className="text-[var(--color-red-alert)] animate-pulse" /><span className="text-xs font-bold text-[var(--danger)]">Cyclone near the PAR boundary</span></div>
            <p className="text-[11px] leading-relaxed text-[var(--text-soft)]">Cyclone <strong>{stormOutsideViewport.name}</strong> is active in the Western Pacific region (Coord: {stormOutsideViewport.lat.toFixed(1)}°N, {stormOutsideViewport.lng.toFixed(1)}°E).</p>
            <button type="button" onClick={() => setMapCenterTarget([stormOutsideViewport.lat, stormOutsideViewport.lng])} className="ui-control flex min-h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-xs font-bold text-[var(--danger)] hover:bg-[var(--panel-elevated)]"><Eye size={12} />Fly to storm location</button>
          </div>
        )}
      </div>

      <div className="absolute top-3 right-3 z-[1000] flex sm:flex-row-reverse items-end sm:items-center gap-2">
        <button 
          ref={mapToolbarButtonRef}
          onClick={() => {
            setShowMapToolbar(s => !s)
            setShowFilters(false)
            setShowLegend(false)
            setShowMobileStatus(false)
          }}
          aria-label={showMapToolbar ? 'Close map controls' : 'Open map controls'}
          className="glass-card grid h-11 w-11 place-items-center rounded-full sm:rounded-lg border border-[var(--color-border-bright)] hover:border-[var(--color-orange)]/50 transition-all duration-200 text-[var(--color-text-primary)] hover:text-[var(--color-orange)] shadow-lg backdrop-blur-xl"
          title="Toggle Map Controls"
        >
          {showMapToolbar ? <X size={20} /> : <Menu size={20} />}
        </button>

        {showMapToolbar && (
          <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2 animate-scale-in max-h-[85vh] overflow-y-auto p-1 scrollbar-hide">
            <button onClick={() => { void handleFindSafeGround() }} aria-label="Find safe ground" title={safeGroundError || `Scan for nearby evacuation and public gathering sites from this GPS position`} className="glass-card h-11 w-11 sm:h-auto sm:w-auto sm:px-3 sm:py-2.5 rounded-full sm:rounded-lg border border-[var(--color-border-bright)] hover:border-[var(--color-green-safe)]/50 transition-all duration-200 flex items-center justify-center sm:gap-2 text-xs text-[var(--color-text-primary)] hover:text-[var(--color-green-safe)] shadow-md backdrop-blur-xl">
              <span className="hidden sm:inline font-medium whitespace-nowrap">{isFetchingOsm ? 'Scanning nearby…' : 'Find Safe Ground'}</span>
              <Shield size={16} className="text-[var(--color-green-safe)] shrink-0" />
            </button>
            <button disabled={!HAZARD_REPORTING_ENABLED} onClick={event => {
              if (!HAZARD_REPORTING_ENABLED) return
              previousFocusRef.current = event.currentTarget
              setHazardPinPos(userLocation)
              setIsPickingHazardLocation(!userLocation)
              setIsReportingHazard(Boolean(userLocation))
              setShowMobileStatus(false)
              if (window.innerWidth < 640) setShowMapToolbar(false)
            }} aria-label={HAZARD_REPORTING_ENABLED ? 'Report hazard' : 'Hazard reporting temporarily unavailable'} title={HAZARD_REPORTING_ENABLED ? 'Report hazard' : 'Hazard reporting temporarily unavailable'} className="glass-card h-11 w-11 sm:h-auto sm:w-auto sm:px-3 sm:py-2.5 rounded-full sm:rounded-lg border border-[var(--color-border-bright)] hover:border-[#f87171]/50 transition-all duration-200 flex items-center justify-center sm:gap-2 text-xs text-[var(--color-text-primary)] hover:text-[#f87171] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--color-border-bright)] disabled:hover:text-[var(--color-text-primary)] shadow-md backdrop-blur-xl">
              <span className="hidden sm:inline font-medium whitespace-nowrap">Report Hazard</span>
              <AlertTriangle size={16} className="text-[#f87171] shrink-0" />
            </button>
            <button onClick={() => {
              if (gpsWatchId !== null || gpsLocating) { stopGpsWatch(); return }
              void startGpsWatch(15)
              if (window.innerWidth < 640) setShowMapToolbar(false)
            }} aria-label={gpsWatchId !== null ? 'Turn off location tracking' : 'Locate me'} className={`glass-card h-11 w-11 sm:h-auto sm:w-auto sm:px-3 sm:py-2.5 rounded-full sm:rounded-lg border transition-all duration-200 flex items-center justify-center sm:gap-2 text-xs shadow-md backdrop-blur-xl ${gpsWatchId !== null ? 'border-[#4285f4] bg-[#4285f4]/15 text-[#4285f4]' : 'border-[var(--color-border-bright)] hover:border-[#4285f4]/50 text-[var(--color-text-primary)] hover:text-[#4285f4]'}`}>
              <span className="hidden sm:inline font-medium whitespace-nowrap">{gpsLocating ? 'Locating…' : gpsWatchId !== null ? 'GPS On' : 'Locate Me'}</span>
              <Navigation size={16} className={`${gpsWatchId !== null ? 'fill-[#4285f4]' : ''} ${gpsLocating ? 'animate-pulse' : ''} shrink-0`} />
            </button>
            <button onClick={() => { setLiveWarningDismissed(false); refreshAllData(); if (window.innerWidth < 640) setShowMapToolbar(false); }} disabled={loading || !isOnline} aria-label="Refresh live map data" className="glass-card h-11 w-11 sm:h-auto sm:w-auto sm:px-3 sm:py-2.5 rounded-full sm:rounded-lg border border-[var(--color-border-bright)] hover:border-[var(--color-blue-info)]/50 transition-all duration-200 flex items-center justify-center sm:gap-2 text-xs text-[var(--color-text-primary)] hover:text-[var(--color-blue-info)] disabled:opacity-40 disabled:cursor-not-allowed shadow-md backdrop-blur-xl">
              <span className="hidden sm:inline font-medium whitespace-nowrap">{loading ? 'Loading…' : 'Refresh'}</span>
              <RefreshCw size={16} className={`${loading ? 'animate-spin' : ''} shrink-0`} />
            </button>
            <button onClick={() => { setMapTheme(t => t === 'dark' ? 'light' : 'dark'); if (window.innerWidth < 640) setShowMapToolbar(false); }} aria-label={`Switch to ${mapTheme === 'dark' ? 'light' : 'dark'} map`} className="glass-card h-11 w-11 sm:h-auto sm:w-auto sm:px-3 sm:py-2.5 rounded-full sm:rounded-lg border border-[var(--color-border-bright)] hover:border-[var(--color-yellow-warn)]/50 transition-all duration-200 flex items-center justify-center sm:gap-2 text-xs text-[var(--color-text-primary)] hover:text-[var(--color-yellow-warn)] shadow-md backdrop-blur-xl" title={`Switch to ${mapTheme === 'dark' ? 'Light' : 'Dark'} Map`}>
              <span className="hidden sm:inline font-medium whitespace-nowrap">{mapTheme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
              {mapTheme === 'dark' ? <Sun size={16} className="shrink-0" /> : <Moon size={16} className="shrink-0" />}
            </button>
            <button onClick={() => { setShowFilters(false); setShowMobileStatus(false); setShowLegend(s => !s); if (window.innerWidth < 640) setShowMapToolbar(false) }} aria-label="Open map legend" className="glass-card h-11 w-11 sm:h-auto sm:w-auto sm:px-3 sm:py-2.5 rounded-full sm:rounded-lg border border-[var(--color-border-bright)] hover:border-[var(--color-blue-info)]/50 transition-all duration-200 flex items-center justify-center sm:gap-2 text-xs text-[var(--color-text-primary)] hover:text-[var(--color-blue-info)] shadow-md backdrop-blur-xl">
              <span className="hidden sm:inline font-medium whitespace-nowrap">Legend</span>
              <Info size={16} className="shrink-0" />
            </button>
            <button onClick={() => { setShowLegend(false); setShowMobileStatus(false); setShowFilters(s => !s); if (window.innerWidth < 640) setShowMapToolbar(false) }} aria-label="Open map layers" className="glass-card h-11 w-11 sm:h-auto sm:w-auto sm:px-3 sm:py-2.5 rounded-full sm:rounded-lg border border-[var(--color-border-bright)] hover:border-[var(--color-orange)]/50 transition-all duration-200 flex items-center justify-center sm:gap-2 text-xs text-[var(--color-text-primary)] hover:text-[var(--color-orange)] shadow-md backdrop-blur-xl">
              <span className="hidden sm:inline font-medium whitespace-nowrap">Layers</span>
              <Layers size={16} className="shrink-0" />
            </button>
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-3 bottom-3 top-16 z-[1000] grid min-h-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto] gap-2 sm:top-14">
      {showFilters && (
        <div className="pointer-events-auto col-start-2 row-start-1 max-h-full w-60 max-w-[calc(100vw-1.5rem)] self-start space-y-3 overflow-y-auto rounded-xl border border-[var(--color-border-bright)] p-4 glass-card animate-scale-in">
          <div className="flex items-center justify-between gap-3"><p className="text-xs font-bold text-[var(--text)] uppercase tracking-widest flex items-center gap-2"><Layers size={12} className="text-[var(--action)]" />Map layers</p><button type="button" onClick={() => setShowFilters(false)} aria-label="Close map filters" className="ui-control grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button></div>
          {([
            { key: 'evacuation_centers', label: 'Evacuation Centers', icon: Shield, color: '#4ade80' },
            { key: 'hazard_reports', label: 'Hazard Reports', icon: AlertTriangle, color: '#f87171' },
            { key: 'newsReports', label: 'News-Reported Incidents', icon: Newspaper, color: '#0ea5e9' },
            { key: 'earthquakes', label: 'Quake Data', icon: Zap, color: 'var(--color-yellow-warn)' },
            { key: 'fires', label: 'Satellite Heat (past 24h)', icon: Flame, color: 'var(--color-orange)' },
            { key: 'weather', label: 'Typhoons & Storms', icon: CloudLightning, color: 'var(--color-red-alert)' },
            { key: 'floods', label: 'Reported Flood Events', icon: Activity, color: '#60a5fa' },
            { key: 'floodAdvisories', label: 'Official Flood Advisories', icon: Activity, color: '#2563eb' },
            { key: 'floodSusceptibility', label: 'Flood Susceptibility', icon: Layers, color: '#1d4ed8' },
            { key: 'stormSurge', label: 'Storm Surge Hazard', icon: Waves, color: '#fb7185' },
            { key: 'dams', label: 'Dam Status', icon: Waves, color: '#0ea5e9' },
            { key: 'volcanoes', label: 'Volcano Status', icon: Activity, color: 'var(--color-teal)' },
            { key: 'faultLines', label: 'Fault Lines', icon: AlertTriangle, color: '#ef4444' },
            { key: 'vessels', label: 'Ship Tracking', icon: Anchor, color: '#22d3ee' },
            { key: 'flights', label: 'Air Traffic', icon: Plane, color: '#a78bfa' },
            { key: 'traffic', label: 'Road Traffic Flow', icon: Car, color: '#10b981' },
          ] as const).map(({ key, label, icon: Icon, color }) => {
            const available = key !== 'vessels' || MARITIME_MONITORING_AVAILABLE
            const displayLabel = available ? label : `${label} — Unavailable`
            return (
              <div
                key={key}
                className={`flex items-center justify-between gap-3 ${available ? 'group' : 'opacity-60'}`}
                title={available ? undefined : MARITIME_MONITORING_NOTICE}
              >
                <div className={`flex min-w-0 items-center gap-2 text-sm ${available ? 'text-[var(--color-text-secondary)] transition-colors group-hover:text-[var(--color-text-primary)]' : 'text-[var(--muted)]'}`}>
                  <Icon size={14} style={{ color: available ? color : 'var(--muted)' }} />
                  <span>{displayLabel}</span>
                </div>
                <button
                  type="button"
                  disabled={!available}
                  aria-label={available ? `Toggle ${label}` : MARITIME_MONITORING_NOTICE}
                  aria-pressed={available && filters[key]}
                  onClick={() => toggleFilter(key)}
                  className={`ui-control relative h-6 w-11 shrink-0 rounded-full ${available && filters[key] ? 'bg-[var(--action)]' : 'border border-[var(--border)] bg-[var(--panel-elevated)]'} disabled:cursor-not-allowed`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all duration-200 ${available && filters[key] ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {showLegend && (
        <div className="pointer-events-auto col-start-2 row-start-1 max-h-full w-64 max-w-[calc(100vw-1.5rem)] self-start space-y-3 overflow-y-auto rounded-xl border border-[var(--color-border-bright)] p-4 glass-card animate-scale-in">
          <div className="flex items-center justify-between gap-3"><p className="text-xs font-bold text-[var(--text)] uppercase tracking-widest flex items-center gap-2"><Info size={12} className="text-[var(--action)]" />Map legend</p><button type="button" onClick={() => setShowLegend(false)} aria-label="Close map legend" className="ui-control grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button></div>
          <div className="space-y-2 text-xs text-[var(--color-text-secondary)]">
            <div className="flex items-center gap-2"><span className="text-base">🛡️</span> Government Evacuation Center</div>
            <div className="flex items-center gap-2"><span className="text-base">📍</span> Open Area / Safe Ground (OSM)</div>
            <div className="flex items-center gap-2"><span className="text-base">🟢</span> Live Airplanes / Drones</div>
            <div className="flex items-center gap-2"><span className="text-[#f87171]">⚠️</span> Hazard Report (User Submitted)</div>
            <div className="flex items-center gap-2"><NewsIncidentSymbol category="fire" size={18} /> Category-Shaped News Incident (N)</div>
            <div className="flex items-center gap-2"><svg viewBox="0 0 64 64" className="h-5 w-5 shrink-0 overflow-visible text-[#ff1744]" aria-hidden="true"><path d={STORM_CENTER_ARM_PATH} fill="currentColor" /><path d={STORM_CENTER_ARM_PATH} fill="currentColor" transform="rotate(180 32 32)" /><circle cx="32" cy="32" r="8" fill="var(--panel)" stroke="currentColor" strokeWidth="2.5" /></svg> Active Typhoon Center</div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 bg-[#ff7700] transform rotate-45"></div> Satellite Heat Signature</div>
            <div className="flex items-center gap-2"><div className="grid h-4 w-4 shrink-0 rotate-45 place-items-center rounded-[2px] border border-white bg-[#dc2626] text-[9px] font-black text-white shadow-[0_0_8px_rgba(220,38,38,0.8)]"><span className="-rotate-45">!</span></div> Urban-Area Heat Indication</div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[var(--color-yellow-warn)]"></div> Earthquake Epicenter</div>
            <div className="flex items-center gap-2"><div className="h-3 w-3 rounded-full border-2 border-blue-300 bg-blue-500"></div> Reported Flood Event Point</div>
            <div className="flex items-center gap-2"><div className="h-3 w-5 bg-blue-600/60"></div> Flood Susceptibility Baseline</div>
            <div className="flex items-center gap-2"><div className="h-3 w-5 bg-rose-500/60"></div> Storm-Surge Scenario / Official Area</div>
            <div className="flex items-center gap-2"><span className="w-4 text-center text-base font-bold leading-none text-sky-500">D</span> Dam Observation</div>
          </div>
          <div className="space-y-1 border-t border-[var(--border)] pt-2 text-[10px] leading-relaxed text-[var(--muted)]">
            <p>Urban-area heat markers are automated proximity indicators, not confirmed structure fires or verified incident reports.</p>
            <p>Flood event points do not imply a flood radius or current water extent.</p>
            {floodAdvisoryMetadata && <p>Flood advisories: <span className={floodAdvisoryMetadata.freshness !== 'live' ? 'font-bold text-[var(--warning)]' : ''}>{hazardFreshnessLabel(floodAdvisoryMetadata)}</span> · issued {hazardTimestamp(floodAdvisoryMetadata.issuedAt)}.</p>}
            {stormSurgeMetadata && <p>Storm surge: <span className={stormSurgeMetadata.freshness !== 'live' ? 'font-bold text-[var(--warning)]' : ''}>{hazardFreshnessLabel(stormSurgeMetadata)}</span> · issued {hazardTimestamp(stormSurgeMetadata.issuedAt)}.</p>}
            {damMetadata && <p>Dam observations: <span className={damMetadata.freshness !== 'live' ? 'font-bold text-[var(--warning)]' : ''}>{hazardFreshnessLabel(damMetadata)}</span> · observed {hazardTimestamp(damMetadata.observedAt)}.</p>}
          </div>
        </div>
      )}

      {!isPickingHazardLocation && <div className="pointer-events-auto col-span-2 col-start-1 row-start-2 hidden min-w-0 w-full self-end items-center gap-3 overflow-x-auto whitespace-nowrap rounded-lg px-3 py-2 text-xs glass-card scrollbar-hide animate-smooth-slide-up sm:flex md:col-span-1">
        <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Zap size={12} className="text-[var(--color-yellow-warn)]" /><span>{earthquakes.length} Quakes</span></div>
        <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Flame size={12} className="text-[var(--color-orange)]" /><span className={firmsHotspots.length > 0 ? 'font-bold text-orange-400' : heatFeedUnavailable ? 'text-[var(--color-red-alert)]' : 'text-[var(--color-text-muted)]'}>{firmsHotspots.length > 0 ? `${firmsHotspots.length} Thermal Detections (24h)` : heatFeedUnavailable ? 'Satellite heat feed unavailable' : heatSources.length ? 'No detections in the past 24h' : 'Checking satellite heat feed…'}</span></div>
        {urbanHeatIndicationCount > 0 && <div className="flex items-center gap-1.5 font-bold text-[#dc2626]"><AlertTriangle size={12} /><span>{urbanHeatIndicationCount} Urban Heat {urbanHeatIndicationCount === 1 ? 'Indication' : 'Indications'}</span></div>}
        {filters.weather && <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><CloudLightning size={12} className={liveCycloneCount > 0 ? "text-[var(--color-red-alert)] animate-pulse" : hasDevelopmentTyphoonPreview ? "text-amber-300" : "text-[var(--color-text-muted)]"} />{liveCycloneCount > 0 ? <span className="font-bold text-[var(--color-red-alert)]">{liveCycloneCount} Active Storm{liveCycloneCount === 1 ? '' : 's'}{hasDevelopmentTyphoonPreview ? ' + preview' : ''}</span> : hasDevelopmentTyphoonPreview ? <span className="font-semibold text-amber-300">Simulated Typhoon Preview</span> : <span className="text-[var(--color-text-muted)]">No Active Storms</span>}</div>}
        {MARITIME_MONITORING_AVAILABLE && filters.vessels && allVessels.length > 0 && <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Anchor size={12} className="text-[#22d3ee]" /><span>{allVessels.filter(v => v.status === 'underway').length} Ships Underway</span>{aisConnected && <span className="flex items-center gap-1 text-green-400 ml-1"><Radio size={10} className="animate-pulse" />AIS</span>}</div>}
        {filters.flights && allFlights.length > 0 && <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Plane size={12} className="text-[#a78bfa]" /><span>{allFlights.filter(f => !f.onGround).length} aircraft airborne{aircraftFeedError ? ' (stale)' : ''}</span></div>}
        {filters.traffic && <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Car size={12} className="text-[#10b981]" /><span>Live Road Traffic Overlay</span></div>}
        {filters.floods && <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Activity size={12} className="text-blue-400" /><span>{floods.length} Reported Flood Events</span></div>}
        {filters.floodAdvisories && <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Activity size={12} className="text-blue-600" /><span>{floodAdvisories.filter(item => item.severity !== 'normal').length} Basin Advisory States{hazardFreshnessSuffix(floodAdvisoryMetadata)}</span></div>}
        {filters.stormSurge && <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Waves size={12} className="text-rose-400" /><span>{stormSurgeStatusLabel}{hazardFreshnessSuffix(stormSurgeMetadata)}</span></div>}
        {filters.dams && <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Waves size={12} className="text-sky-400" /><span>{dams.length} Latest Dam Observations{hazardFreshnessSuffix(damMetadata)}</span></div>}
        {filters.newsReports && <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]"><Newspaper size={12} className="text-sky-500" /><span>{newsLoading ? 'Loading news-reported incidents' : newsError ? 'News incidents temporarily unavailable' : `${newsIncidents.length} Active News-Reported Incidents`}</span></div>}
        <div className="flex items-center gap-1 text-[var(--color-text-muted)] text-[10px]"><AlertTriangle size={10} /><span>Satellite heat monitoring</span></div>
        {lastUpdated && <div className="text-[var(--color-text-muted)] hidden sm:flex items-center gap-1" title="Last refresh check"><RefreshCw size={10} />Checked {lastUpdated.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' })}</div>}
      </div>}

      {!isPickingHazardLocation && (
        <div className="pointer-events-none col-start-2 row-start-2 hidden self-end flex-col items-end gap-2 md:flex">
          {filters.traffic && (
            <div className="pointer-events-auto space-y-1 rounded-lg px-3 py-2 text-[10px] glass-card animate-smooth-slide-up">
              <p className="mb-1 font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Live Road Traffic</p>
              {[['Severe / Stopped', '#991b1b'], ['Heavy Congestion', '#ef4444'], ['Moderate Slowdown', '#eab308'], ['Free Flow', '#22c55e']].map(([label, color]) => <div key={label} className="flex items-center gap-2 whitespace-nowrap text-[var(--color-text-secondary)]"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />{label}</div>)}
            </div>
          )}
          <div className="pointer-events-auto space-y-1 rounded-lg px-3 py-2 text-[10px] glass-card animate-smooth-slide-up">
            <p className="mb-1 font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Seismic Mag</p>
            {[['≥7.0 Major', '#e53e3e'], ['≥6.0 Strong', '#ff6b00'], ['≥5.0 Moderate', '#f6c90e'], ['≥4.0 Light', '#14b8a6']].map(([label, color]) => <div key={label} className="flex items-center gap-2 whitespace-nowrap text-[var(--color-text-secondary)]"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />{label}</div>)}
          </div>
        </div>
      )}
      </div>
      {isPickingHazardLocation && (
        <div role="status" className="absolute bottom-3 left-3 right-3 z-[1200] mx-auto flex max-w-md items-center gap-3 rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--panel)] p-3 text-xs text-[var(--text-soft)] shadow-[var(--shadow-lg)] sm:bottom-4">
          <MapPin size={18} className="shrink-0 text-[var(--danger)]" />
          <span className="min-w-0 flex-1"><strong className="text-[var(--text)]">Choose the hazard location.</strong> Tap the correct point on the map.</span>
          <button type="button" onClick={() => { setIsPickingHazardLocation(false); setHazardPinPos(null); setShowMapToolbar(true); mapToolbarButtonRef.current?.focus() }} className="ui-control min-h-10 rounded-md px-3 font-semibold text-[var(--danger)] hover:bg-[var(--danger-soft)]">Cancel</button>
        </div>
      )}
      {!isPickingHazardLocation && !showFilters && !showLegend && <button type="button" onClick={() => { setShowFilters(false); setShowLegend(false); setShowMobileStatus(true) }} aria-label="Open live map summary" className="ui-control sm:hidden absolute bottom-3 left-3 z-[1000] grid h-11 w-11 place-items-center rounded-full border border-[var(--border)] bg-[var(--panel)] text-[var(--action)] shadow-[var(--shadow-md)]"><Activity size={19} /></button>}
      {showMobileStatus && !isPickingHazardLocation && <div className="sm:hidden absolute bottom-3 left-3 right-3 z-[1100] max-h-[calc(100%-1.5rem)] overflow-y-auto overscroll-contain glass-card rounded-xl p-4 pr-12 text-xs grid grid-cols-1 gap-2 shadow-2xl animate-smooth-slide-up">
        <button type="button" onClick={() => setShowMobileStatus(false)} aria-label="Close live map summary" className="ui-control absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)]"><X size={16} /></button>
        <div className="flex items-center gap-2"><Zap size={14} className="text-[var(--color-yellow-warn)]" /><span>{earthquakes.length} earthquakes in the current feed</span></div>
        <div className="flex items-center gap-2"><Flame size={14} className="text-[var(--color-orange)]" /><span>{firmsHotspots.length} satellite thermal detections in the past 24h</span></div>
        {urbanHeatIndicationCount > 0 && <div className="flex items-center gap-2 font-bold text-[#dc2626]"><AlertTriangle size={14} /><span>{urbanHeatIndicationCount} urban-area heat {urbanHeatIndicationCount === 1 ? 'indication' : 'indications'}</span></div>}
        <div className="flex items-center gap-2"><CloudLightning size={14} className={liveCycloneCount > 0 ? 'text-[var(--color-red-alert)]' : hasDevelopmentTyphoonPreview ? 'text-amber-300' : 'text-[var(--color-text-muted)]'} /><span>{liveCycloneCount > 0 ? `${liveCycloneCount} active storm${liveCycloneCount === 1 ? '' : 's'} in or within 10 km of PAR${hasDevelopmentTyphoonPreview ? ' · simulated preview also active' : ''}` : hasDevelopmentTyphoonPreview ? 'Simulated typhoon preview active — no alerts' : 'No active storms in or within 10 km of PAR'}</span></div>
        <div className="flex items-center gap-2"><Plane size={14} className="text-[#a78bfa]" /><span>{allFlights.filter(f => !f.onGround).length} aircraft airborne{aircraftFeedError ? ' (stale)' : ''}</span></div>
        {filters.traffic && <div className="flex items-center gap-2"><Car size={14} className="text-[#10b981]" /><span>Live road traffic overlay active</span></div>}
        {filters.floods && <div className="flex items-center gap-2"><Activity size={14} className="text-blue-400" /><span>{floods.length} reported flood event points</span></div>}
        {filters.floodAdvisories && <div className="flex items-center gap-2"><Activity size={14} className="text-blue-600" /><span>{floodAdvisories.filter(item => item.severity !== 'normal').length} basin advisory states{hazardFreshnessSuffix(floodAdvisoryMetadata)}</span></div>}
        {filters.stormSurge && <div className="flex items-center gap-2"><Waves size={14} className="text-rose-400" /><span>{stormSurgeStatusLabel}{hazardFreshnessSuffix(stormSurgeMetadata)}</span></div>}
        {filters.dams && <div className="flex items-center gap-2"><Waves size={14} className="text-sky-400" /><span>{dams.length} latest dam observations{hazardFreshnessSuffix(damMetadata)}</span></div>}
        {filters.newsReports && <div className="flex items-center gap-2"><Newspaper size={14} className="text-sky-500" /><span>{newsLoading ? 'Loading news-reported incidents' : newsError ? 'News incidents temporarily unavailable' : `${newsIncidents.length} active news-reported incidents`}</span></div>}
        {lastUpdated && <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]"><RefreshCw size={11} />Refresh checked {lastUpdated.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' })}</div>}
      </div>}

      {HAZARD_REPORTING_ENABLED && isReportingHazard && hazardPinPos && (
        <div className="absolute inset-0 z-[2000] flex items-start justify-center overflow-y-auto overscroll-contain bg-[var(--overlay)] p-4 sm:items-center">
          <div ref={reportDialogRef} role="dialog" aria-modal="true" aria-labelledby="report-hazard-title" aria-describedby="hazard-report-location" tabIndex={-1} className="glass-card relative max-h-[calc(100%-1rem)] w-full max-w-sm overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border)] p-5 shadow-[var(--shadow-lg)] animate-scale-in sm:p-6">
            <button type="button" onClick={() => { setIsReportingHazard(false); setHazardPinPos(null) }} aria-label="Close hazard report" className="ui-control absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-md text-[var(--muted)] hover:bg-[var(--panel-elevated)] hover:text-[var(--text)] sm:h-9 sm:w-9"><X size={20}/></button>
            <h2 id="report-hazard-title" className="mb-5 flex items-center gap-2 pr-12 text-lg font-bold text-[var(--danger)]"><MapPin size={18}/> Report Hazard</h2>
            <div className="space-y-4">
              <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--panel-elevated)] p-3">
                <p id="hazard-report-location" className="text-xs text-[var(--text-soft)]">Location set: {hazardPinPos[0].toFixed(5)}, {hazardPinPos[1].toFixed(5)}.</p>
                <button type="button" onClick={() => { setIsReportingHazard(false); setIsPickingHazardLocation(true); setShowMapToolbar(false) }} className="ui-control mt-2 min-h-10 rounded-md px-2 text-xs font-semibold text-[var(--action)] hover:bg-[var(--action-soft)]">Choose a different point on the map</button>
              </div>
              <div>
                <label htmlFor="hazard-report-type" className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1.5 block uppercase tracking-wider">Hazard Type</label>
                <Select
                  id="hazard-report-type"
                  value={hazardForm.type}
                  options={HAZARD_REPORT_TYPES.map(type => ({ value: type, label: type }))}
                  onValueChange={value => setHazardForm(form => ({ ...form, type: value as HazardReportType }))}
                  tone="danger"
                  aria-label="Hazard type"
                />
              </div>
              <div>
                <label htmlFor="hazard-report-description" className="text-xs font-semibold text-[var(--color-text-secondary)] mb-1.5 block uppercase tracking-wider">Description</label>
                <textarea 
                  id="hazard-report-description"
                  value={hazardForm.description}
                  onChange={e => setHazardForm(f => ({ ...f, description: e.target.value.slice(0, HAZARD_REPORT_DESCRIPTION_LIMIT) }))}
                  maxLength={HAZARD_REPORT_DESCRIPTION_LIMIT}
                  className="h-24 w-full resize-none rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--panel-elevated)] p-2.5 text-sm text-[var(--text)] transition-colors focus:border-[var(--danger)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  placeholder="Describe the hazard and its severity..."
                />
                <p className="mt-1 text-right text-[10px] text-[var(--muted)]">{hazardForm.description.length}/{HAZARD_REPORT_DESCRIPTION_LIMIT}</p>
              </div>
              <button 
                type="button"
                onClick={async () => {
                  if (!HAZARD_REPORTING_ENABLED) { alert('Hazard reporting is temporarily unavailable.'); return }
                  if (!user) { alert('Please sign in before reporting a hazard.'); return }
                  if (!hazardPinPos) { alert('Select the hazard location on the map first.'); return }
                  const description = hazardForm.description.trim()
                  const [lat, lng] = hazardPinPos
                  if (!HAZARD_REPORT_TYPES.includes(hazardForm.type)) { alert('Select a valid hazard type.'); return }
                  if (!description || description.length > HAZARD_REPORT_DESCRIPTION_LIMIT) { alert(`Describe the hazard in ${HAZARD_REPORT_DESCRIPTION_LIMIT} characters or fewer.`); return }
                  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < HAZARD_REPORT_BOUNDS.minLat || lat > HAZARD_REPORT_BOUNDS.maxLat || lng < HAZARD_REPORT_BOUNDS.minLng || lng > HAZARD_REPORT_BOUNDS.maxLng) {
                    alert('Hazard reports must use a valid location inside the Philippines.')
                    return
                  }
                  setLoading(true)
                  const { error } = await supabase.rpc('submit_hazard_report', {
                    p_type: hazardForm.type,
                    p_description: description,
                    p_lat: lat,
                    p_lng: lng,
                  })
                  setLoading(false)
                  if (error) {
                    alert('Failed to submit report. Please try again.')
                  } else {
                    setIsReportingHazard(false)
                    setHazardPinPos(null)
                    setHazardForm({ type: 'Flood', description: '' })
                    refreshAllData()
                  }
                }}
                disabled={loading || !hazardForm.description.trim()}
                className="ui-control mt-2 min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-sm font-bold text-[var(--danger)] hover:bg-[var(--panel-elevated)] disabled:opacity-50"
              >
                {loading ? 'Submitting…' : 'Submit Report'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
