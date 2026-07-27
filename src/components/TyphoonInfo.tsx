import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleMarker, LayerGroup, MapContainer, Marker, Polygon, Polyline, Popup, TileLayer } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { Activity, AlertTriangle, CloudLightning, Compass, Gauge, MapPin, RefreshCw, Route, Wind } from 'lucide-react'
import { getLiveData } from '../lib/liveData'
import { DEVELOPMENT_TYPHOON_PREVIEW } from '../lib/devTyphoonPreview'
import { createStormCenterIcon } from '../lib/stormCenterIcon'
import { useTheme } from '../hooks/useTheme'
import { Skeleton } from './ui/primitives'

type TrackPoint = { lat: number; lng: number; intensity: string }
type Storm = {
  id: string
  name: string
  lat: number
  lng: number
  alert: string
  alertscore: number
  description: string
  source: string
  windKph?: number
  severity?: number
  updated?: string
  ended?: string
  countries?: string
  distanceToParKm?: number
  observedTrack?: [number, number][]
  forecastTrack?: [number, number][]
  observedPoints?: TrackPoint[]
  forecastPoints?: TrackPoint[]
  isDevelopmentPreview?: boolean
}

type GatewayStorm = Omit<Storm, 'alert'> & { alertlevel: string }

const DEVELOPMENT_TRACKER_STORM: Storm | null = DEVELOPMENT_TYPHOON_PREVIEW
  ? { ...DEVELOPMENT_TYPHOON_PREVIEW, alert: DEVELOPMENT_TYPHOON_PREVIEW.alertlevel }
  : null

const parBoundary: [number, number][] = [[25, 120], [25, 135], [5, 135], [5, 115], [15, 115], [21, 120], [25, 120]]

function haversine(first: [number, number], second: [number, number]) {
  const toRad = (value: number) => value * Math.PI / 180
  const latDistance = toRad(second[0] - first[0]), lngDistance = toRad(second[1] - first[1])
  const a = Math.sin(latDistance / 2) ** 2 + Math.cos(toRad(first[0])) * Math.cos(toRad(second[0])) * Math.sin(lngDistance / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function totalDistance(points: [number, number][]) {
  return points.slice(1).reduce((total, point, index) => total + haversine(points[index], point), 0)
}

function Stat({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: string }) {
  return <div className="elevated-panel rounded-xl bg-[var(--color-bg-card)] p-3"><div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"><Icon size={13} />{label}</div><p className="mt-1.5 text-base font-bold text-[var(--color-text-primary)]">{value}</p></div>
}

function DistanceLineChart({ observed, forecast }: { observed: [number, number][]; forecast: [number, number][] }) {
  const points = [...observed, ...forecast.filter((point, index) => index > 0 || !observed.some(existing => existing[0] === point[0] && existing[1] === point[1]))]
  if (points.length < 2) return <p className="py-12 text-center text-xs text-[var(--color-text-muted)]">The live feed has not supplied enough track points for a distance profile.</p>
  const cumulative = points.map((_, index) => totalDistance(points.slice(0, index + 1)))
  const max = Math.max(...cumulative, 1)
  const path = cumulative.map((value, index) => `${20 + index * (280 / Math.max(1, cumulative.length - 1))},${100 - value * 78 / max}`).join(' ')
  return <div><svg viewBox="0 0 320 120" className="h-40 w-full" role="img" aria-label={`Cumulative track distance up to ${Math.round(max)} kilometers`}><line x1="20" y1="100" x2="300" y2="100" stroke="var(--color-border-bright)" /><line x1="20" y1="20" x2="20" y2="100" stroke="var(--color-border-bright)" /><polyline points={path} fill="none" stroke="#ff1744" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />{path.split(' ').map((pair, index) => { const [x, y] = pair.split(','); return <circle key={index} cx={x} cy={y} r="3" fill="#ff1744" /> })}<text x="20" y="116" fill="var(--color-text-muted)" fontSize="9">First point</text><text x="264" y="116" fill="var(--color-text-muted)" fontSize="9">Latest / forecast</text><text x="24" y="17" fill="var(--color-text-muted)" fontSize="9">{Math.round(max)} km</text></svg><p className="text-[10px] text-[var(--color-text-muted)]">Derived from the distances between the returned track coordinates. Point spacing is sequence-based because this feed does not include a timestamp for every point.</p></div>
}

function IntensityBars({ points }: { points: TrackPoint[] }) {
  const counts = points.reduce<Record<string, number>>((result, point) => { const label = point.intensity || 'Unknown'; result[label] = (result[label] ?? 0) + 1; return result }, {})
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const max = Math.max(...entries.map(([, count]) => count), 1)
  if (!entries.length) return <p className="py-12 text-center text-xs text-[var(--color-text-muted)]">No intensity labels were supplied with this storm track.</p>
  return <div className="space-y-3 py-2">{entries.map(([label, count]) => <div key={label} className="grid grid-cols-[3.5rem_1fr_2rem] items-center gap-2 text-xs"><span className="font-bold text-[var(--color-text-secondary)]">{label}</span><div className="h-3 overflow-hidden rounded-full bg-[var(--color-bg-elevated)]"><div className="h-full rounded-full bg-gradient-to-r from-[#ff1744] to-[#ff8c33]" style={{ width: `${Math.max(6, count / max * 100)}%` }} /></div><span className="text-right font-mono text-[var(--color-text-muted)]">{count}</span></div>)}</div>
}

function TrackDonut({ observed, forecast }: { observed: number; forecast: number }) {
  const total = observed + forecast
  if (!total) return <p className="py-12 text-center text-xs text-[var(--color-text-muted)]">No observed or forecast track points were supplied.</p>
  const observedShare = observed / total * 100
  return <div className="flex items-center justify-center gap-6 py-3"><div role="img" aria-label={`${observed} observed and ${forecast} forecast track points`} className="relative h-32 w-32 shrink-0 rounded-full" style={{ background: `conic-gradient(#ff1744 0 ${observedShare}%, #fbbf24 ${observedShare}% 100%)` }}><div className="absolute inset-5 grid place-items-center rounded-full bg-[var(--color-bg-card)] text-center"><span className="text-xl font-black">{total}</span><span className="-mt-3 text-[9px] uppercase text-[var(--color-text-muted)]">points</span></div></div><div className="space-y-2 text-xs"><p className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[#ff1744]" />Observed <strong>{observed}</strong></p><p className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-[#fbbf24]" />Forecast <strong>{forecast}</strong></p></div></div>
}

export default function TyphoonInfo() {
  const { resolvedTheme } = useTheme()
  const [storms, setStorms] = useState<Storm[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const displayedStorms = useMemo<Storm[]>(() => {
    if (!DEVELOPMENT_TRACKER_STORM) return storms
    return storms.some(storm => storm.id === DEVELOPMENT_TRACKER_STORM.id)
      ? storms
      : [...storms, DEVELOPMENT_TRACKER_STORM]
  }, [storms])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const response = await getLiveData<GatewayStorm[]>('storms')
      const liveStorms = response.data.map(storm => ({ ...storm, alert: storm.alertlevel }))
      const selectableStorms = DEVELOPMENT_TRACKER_STORM ? [...liveStorms, DEVELOPMENT_TRACKER_STORM] : liveStorms
      setStorms(liveStorms)
      setSelectedId(current => selectableStorms.some(storm => storm.id === current) ? current : selectableStorms[0]?.id ?? null)
      setUpdatedAt(new Date(response.fetchedAt))
      setError('')
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Live storm data is unavailable.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void refresh(); const interval = window.setInterval(() => void refresh(), 10 * 60 * 1000); return () => window.clearInterval(interval) }, [refresh])

  const selected = useMemo(() => displayedStorms.find(storm => storm.id === selectedId) ?? displayedStorms[0], [selectedId, displayedStorms])
  const observed = selected?.observedTrack ?? []
  const forecast = selected?.forecastTrack ?? []
  const allIntensityPoints = [...(selected?.observedPoints ?? []), ...(selected?.forecastPoints ?? [])]
  const mappedDistance = totalDistance(observed) + totalDistance(forecast)
  const showingStaleData = Boolean(error && storms.length > 0 && updatedAt)

  if (loading && displayedStorms.length === 0) return <TyphoonLoading />

  return <div className="h-full overflow-y-auto bg-[var(--color-bg-primary)]"><div className="mx-auto max-w-6xl space-y-5 p-4 pb-8 sm:p-6">
    <header className="flex items-start justify-between gap-4"><div><h1 className="flex items-center gap-2 text-xl font-black text-[var(--color-text-primary)] sm:text-2xl"><CloudLightning className="text-[#ff1744]" />Tropical cyclone tracker</h1><p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--color-text-muted)]">Live cyclones whose current center is inside PAR or within 10 km of its boundary. Neon red dots are observed history; amber dashed points are forecast positions.</p>{DEVELOPMENT_TRACKER_STORM && <p className="mt-2 inline-flex rounded-md bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-300">Development preview — simulated data only; no alert is sent.</p>}</div><button type="button" onClick={() => void refresh()} disabled={loading} aria-label="Refresh tropical cyclone data" className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[var(--color-border)] disabled:opacity-50"><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button></header>

    {error && <div role="alert" className="rounded-xl border border-[var(--color-red-alert)]/30 bg-[var(--color-red-alert)]/10 px-4 py-3 text-sm text-[var(--color-red-alert)]"><p className="font-bold">{showingStaleData ? 'Live cyclone feed delayed — showing stale, last-received data' : 'Live cyclone feed unavailable'}</p><p className="mt-1 text-xs leading-relaxed">{error}</p>{showingStaleData && updatedAt && <p className="mt-1 text-[10px]">Last successful update: {updatedAt.toLocaleString('en-PH')}</p>}</div>}

    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat icon={Activity} label="Monitored storms" value={DEVELOPMENT_TRACKER_STORM ? `${storms.length} live + 1 preview` : loading && storms.length === 0 ? '…' : error && storms.length === 0 ? 'Unavailable' : `${storms.length}${showingStaleData ? ' (stale)' : ''}`} /><Stat icon={RefreshCw} label="Last successful update" value={updatedAt ? updatedAt.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }) : 'Unavailable'} /><Stat icon={Route} label="Mapped distance" value={selected && mappedDistance ? `${Math.round(mappedDistance).toLocaleString()} km` : 'Unavailable'} /><Stat icon={Compass} label="PAR distance" value={selected?.distanceToParKm != null ? selected.distanceToParKm === 0 ? 'Inside PAR' : `${selected.distanceToParKm} km outside` : 'Unavailable'} /></section>

    {displayedStorms.length > 1 && <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Choose a tropical cyclone">{displayedStorms.map(storm => <button key={storm.id} type="button" role="tab" aria-selected={storm.id === selected?.id} onClick={() => setSelectedId(storm.id)} className={`min-h-11 shrink-0 rounded-xl border px-4 py-2 text-sm font-bold ${storm.id === selected?.id ? 'border-[#ff1744] bg-[#ff1744]/10 text-[#ff1744]' : 'border-[var(--color-border)] text-[var(--color-text-secondary)]'}`}>{storm.name}{storm.isDevelopmentPreview ? ' · Preview' : ''}</button>)}</div>}

    <section className="h-[320px] overflow-hidden rounded-2xl border border-[var(--color-border)] sm:h-[430px]"><MapContainer center={selected ? [selected.lat, selected.lng] : [15, 125]} zoom={selected ? 6 : 5} className="h-full w-full" attributionControl={false}><TileLayer url={`https://{s}.basemaps.cartocdn.com/${resolvedTheme === 'dark' ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`} /><Polygon positions={parBoundary} pathOptions={{ color: '#60a5fa', weight: 1.5, dashArray: '6 5', fillOpacity: 0.02 }} />{displayedStorms.map(storm => <LayerGroup key={storm.id}>{storm.observedTrack && storm.observedTrack.length > 1 && <Polyline positions={storm.observedTrack} pathOptions={{ color: '#ff1744', weight: 3.5, opacity: 0.95 }} />}{storm.observedTrack?.map((point, index) => <CircleMarker key={`observed-${storm.id}-${index}`} center={point} radius={4} pathOptions={{ color: '#ff1744', fillColor: '#ff1744', fillOpacity: 1, weight: 1 }} />)}{storm.forecastTrack && storm.forecastTrack.length > 1 && <Polyline positions={storm.forecastTrack} pathOptions={{ color: '#fbbf24', weight: 2.5, dashArray: '8 7', opacity: 0.9 }} />}{storm.forecastTrack?.map((point, index) => <CircleMarker key={`forecast-${storm.id}-${index}`} center={point} radius={4} pathOptions={{ color: '#fbbf24', fillColor: '#201800', fillOpacity: 1, weight:1.5 }} />)}<Marker position={[storm.lat, storm.lng]} icon={createStormCenterIcon(6)}><Popup><strong>{storm.name}</strong><br />Alert level: {storm.alert}<br />Current center: {storm.lat.toFixed(1)}°N, {storm.lng.toFixed(1)}°E<br />{storm.isDevelopmentPreview ? 'Development preview only — no alerts' : 'Neon red: observed trail · Dashed amber: forecast'}</Popup></Marker></LayerGroup>)}</MapContainer></section>

    {!loading && !selected ? error ? <section className="rounded-2xl border border-[var(--color-red-alert)]/30 bg-[var(--color-bg-card)] p-8 text-center"><AlertTriangle className="mx-auto mb-3 text-[var(--color-red-alert)]" /><h2 className="font-bold text-[var(--color-text-primary)]">Cyclone status cannot be confirmed</h2><p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-[var(--color-text-muted)]">The live feed could not be reached, so the tracker cannot currently confirm whether the monitoring zone is clear. Retry the feed and follow current official weather bulletins.</p></section> : <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-8 text-center"><CloudLightning className="mx-auto mb-3 text-[var(--color-text-muted)]" /><h2 className="font-bold text-[var(--color-text-primary)]">No cyclone currently in the monitoring zone</h2><p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-[var(--color-text-muted)]">No active tropical-cyclone center is currently reported inside PAR or within the configured 10 km buffer. The tracker will update automatically every 10 minutes.</p></section> : selected && <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Stat icon={Gauge} label="Alert level" value={`${selected.alert} (${selected.alertscore || 0})`} /><Stat icon={MapPin} label="Current center" value={`${selected.lat.toFixed(1)}°N ${selected.lng.toFixed(1)}°E`} /><Stat icon={Wind} label="Reported wind" value={selected.windKph ? `${selected.windKph} km/h` : 'Not supplied'} /><Stat icon={Route} label="Track points" value={`${observed.length} observed · ${forecast.length} forecast`} /></section>

      <section className="grid gap-4 lg:grid-cols-3"><article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4 lg:col-span-2"><h2 className="text-sm font-bold text-[var(--color-text-primary)]">Cumulative track distance</h2><p className="mt-1 text-[10px] text-[var(--color-text-muted)]">Line graph from the returned track coordinates</p><DistanceLineChart observed={observed} forecast={forecast} /></article><article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4"><h2 className="text-sm font-bold text-[var(--color-text-primary)]">Observed vs forecast</h2><p className="mt-1 text-[10px] text-[var(--color-text-muted)]">Share of available track points</p><TrackDonut observed={observed.length} forecast={forecast.length} /></article></section>

      <section className="grid gap-4 lg:grid-cols-2"><article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4"><h2 className="text-sm font-bold text-[var(--color-text-primary)]">Track intensity labels</h2><p className="mt-1 text-[10px] text-[var(--color-text-muted)]">Bar chart of reported labels such as TD, TS, and HU; these are counts, not invented wind values.</p><IntensityBars points={allIntensityPoints} /></article><article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-card)] p-4"><h2 className="text-sm font-bold text-[var(--color-text-primary)]">Live event details</h2><div className="mt-3 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-xs"><span className="text-[var(--color-text-muted)]">Name</span><strong>{selected.name}</strong><span className="text-[var(--color-text-muted)]">Affected areas</span><span>{selected.countries || 'Not supplied'}</span><span className="text-[var(--color-text-muted)]">Event period</span><span>{selected.updated || 'Start unavailable'}{selected.ended ? ` — ${selected.ended}` : ''}</span><span className="text-[var(--color-text-muted)]">Reported severity</span><span>{selected.severity ?? 'Not supplied'}</span><span className="text-[var(--color-text-muted)]">Description</span><span>{selected.description}</span></div></article></section>
    </>}

    <p className="flex items-start justify-center gap-1.5 text-center text-[10px] leading-relaxed text-[var(--color-text-muted)]"><AlertTriangle size={12} className="mt-0.5 shrink-0" />Use current national weather bulletins and local authority instructions for official Philippine warnings and evacuation decisions. Landfall does not make a cyclone harmless, so the app does not hide an in-zone storm merely because it crosses land.</p>
  </div></div>
}

function TyphoonLoading() {
  return <div role="status" aria-label="Loading tropical cyclone data" className="h-full overflow-hidden bg-[var(--surface)] p-4 sm:p-6"><div className="mx-auto max-w-6xl space-y-5"><div className="space-y-2"><Skeleton variant="line" className="h-6 w-56" /><Skeleton variant="line" className="w-full max-w-xl" /></div><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} variant="block" className="h-20" />)}</div><Skeleton variant="block" className="h-[320px] sm:h-[430px]" /><div className="grid gap-4 sm:grid-cols-2"><Skeleton variant="block" className="h-36" /><Skeleton variant="block" className="h-36" /></div></div><span className="sr-only">Loading tropical cyclone data</span></div>
}
