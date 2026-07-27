import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { Circle, CircleMarker, MapContainer, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { AlertTriangle, Car, Clock, Layers, LocateFixed, MapPin, Navigation, Wifi, WifiOff, X } from 'lucide-react'
import TrafficFlowLayer from './TrafficFlowLayer'
import { fetchTrafficIncidents, haversineKm, TRAFFIC_RADIUS_KM, trafficIncidentColor, type TrafficIncident } from '../data/traffic'
import { useOnlineStatus } from '../hooks/useOnlineStatus'
import { useTheme } from '../hooks/useTheme'
import { CARTO_RASTER_MAX_ZOOM } from '../lib/mapTiles'
import { getDevicePosition } from '../lib/deviceGeolocation'
import { Skeleton } from './ui/primitives'

const MANILA: [number, number] = [14.5995, 120.9842]
const INCIDENTS_PER_PAGE = 5



function FitRadius({ center }: { center: [number, number] }) {
  const map = useMap()
  useEffect(() => {
    map.fitBounds(L.latLng(center).toBounds(TRAFFIC_RADIUS_KM * 2_000), { padding: [18, 18], animate: true })
  }, [map, center])
  return null
}

export default function RoadTraffic() {
  const isOnline = useOnlineStatus()
  const { resolvedTheme } = useTheme()
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null)
  const [accuracy, setAccuracy] = useState(0)
  const [locating, setLocating] = useState(true)
  const [gpsError, setGpsError] = useState('')
  const [incidents, setIncidents] = useState<TrafficIncident[]>([])
  const [loading, setLoading] = useState(false)
  const [feedError, setFeedError] = useState('')
  const [flowError, setFlowError] = useState('')
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const locateRequestRef = useRef(0)

  const locate = useCallback(async () => {
    const requestId = ++locateRequestRef.current
    setLocating(true)
    setGpsError('')
    try {
      const position = await getDevicePosition({
        enableHighAccuracy: true,
        maximumAge: 15_000,
        timeout: 20_000,
        enableLocationFallback: true,
      })
      if (requestId === locateRequestRef.current) {
        setUserLocation([position.coords.latitude, position.coords.longitude])
        setAccuracy(position.coords.accuracy)
        setLocating(false)
      }
    } catch (error) {
      if (requestId === locateRequestRef.current) {
        setGpsError(error instanceof Error ? error.message : 'Location permission is required for the 20 km traffic scan.')
        setLocating(false)
      }
    }
  }, [])

  useEffect(() => {
    void locate()
    return () => { locateRequestRef.current += 1 }
  }, [locate])

  const refreshIncidents = useCallback(async () => {
    if (!isOnline || !userLocation) return
    setLoading(true)
    setFeedError('')
    try {
      const response = await fetchTrafficIncidents(userLocation[0], userLocation[1], TRAFFIC_RADIUS_KM)
      response.incidents.sort((a, b) => b.delaySeconds - a.delaySeconds)
      setIncidents(response.incidents)
      setCurrentPage(1)
      setLastRefreshed(new Date(response.fetchedAt))
    } catch (error) {
      setFeedError(error instanceof Error ? error.message : 'The live traffic incident feed is unavailable.')
    } finally {
      setLoading(false)
    }
  }, [isOnline, userLocation])

  useEffect(() => {
    if (!userLocation) return
    void refreshIncidents()
    const interval = window.setInterval(refreshIncidents, 60_000)
    return () => window.clearInterval(interval)
  }, [refreshIncidents, userLocation])

  const handleFlowError = useCallback((message: string) => setFlowError(message), [])
  const handleFlowRecovery = useCallback(() => setFlowError(''), [])
  const mapCenter = userLocation ?? MANILA
  const totalPages = Math.max(1, Math.ceil(incidents.length / INCIDENTS_PER_PAGE))
  const pageIncidents = useMemo(
    () => incidents.slice((currentPage - 1) * INCIDENTS_PER_PAGE, currentPage * INCIDENTS_PER_PAGE),
    [currentPage, incidents],
  )

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg-primary)]">
      <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6 animate-smooth-slide-up">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#10b981]/25 bg-[#10b981]/15">
            <Car size={18} className="text-[#10b981]" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold text-[var(--color-text-primary)]">Road Traffic</h1>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              {isOnline ? <span className="flex items-center gap-1"><Wifi size={10} className="text-[var(--color-green-safe)]" /> Live road flow and incidents</span> : <span className="flex items-center gap-1"><WifiOff size={10} /> Offline</span>}
              {lastRefreshed && <span className="flex items-center gap-1"><Clock size={10} /> Updated {lastRefreshed.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' })}</span>}
            </div>
          </div>
          <button type="button" onClick={locate} disabled={locating} className="grid h-10 w-10 place-items-center rounded-full border border-[var(--color-border-bright)] text-[#4285f4] disabled:opacity-50" aria-label="Refresh GPS location">
            <Navigation size={17} className={locating ? 'animate-pulse' : ''} />
          </button>
        </div>

        {gpsError && <DismissibleError message={`${gpsError} Enable precise location, then press the location button.`} onClose={() => setGpsError('')} />}
        {feedError && <DismissibleError message={`Incident monitor: ${feedError}`} onClose={() => setFeedError('')} />}
        {flowError && <DismissibleError message={`Road flow: ${flowError}`} onClose={() => setFlowError('')} />}

        <section className="elevated-panel overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)]">
          <div className="border-b border-[var(--color-border)] px-4 py-2.5">
            <h2 className="flex items-center gap-1.5 text-xs font-bold text-[var(--color-text-primary)]">
              <Layers size={13} className="text-[#10b981]" />
              TomTom road flow — 20 km
            </h2>
            <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">Live flow and reported incidents</p>
          </div>
          <div id="traffic-map-panel" role="tabpanel" className="relative h-[320px]">
            {!isOnline ? (
              <div className="grid h-full place-items-center text-sm text-[var(--color-text-muted)]"><span className="flex items-center gap-2"><WifiOff size={18} /> Internet is required</span></div>
            ) : (
              <MapContainer center={mapCenter} zoom={userLocation ? 11 : 12} maxZoom={CARTO_RASTER_MAX_ZOOM} className="h-full w-full" zoomControl attributionControl>
                <TileLayer attribution='&copy; OpenStreetMap contributors &copy; CARTO' url={`https://{s}.basemaps.cartocdn.com/${resolvedTheme === 'dark' ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`} maxZoom={CARTO_RASTER_MAX_ZOOM} maxNativeZoom={CARTO_RASTER_MAX_ZOOM} />
                {userLocation && <>
                  <FitRadius center={userLocation} />
                  <TrafficFlowLayer center={userLocation} radiusKm={TRAFFIC_RADIUS_KM} minZoom={9} theme={resolvedTheme} onError={handleFlowError} onRecovery={handleFlowRecovery} />
                  <Circle center={userLocation} radius={TRAFFIC_RADIUS_KM * 1_000} pathOptions={{ color: '#4285f4', weight: 2, dashArray: '8 7', fillColor: '#4285f4', fillOpacity: 0.035 }} />
                  <CircleMarker center={userLocation} radius={8} pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#4285f4', fillOpacity: 1 }}>
                    <Popup><strong>Your GPS location</strong><br />Accuracy: ±{Math.round(accuracy)} m<br />Monitoring radius: 20 km</Popup>
                  </CircleMarker>
                  {incidents.map(incident => <Polyline key={incident.id} positions={incident.geometry} pathOptions={{ color: trafficIncidentColor(incident), weight: 5, opacity: 0.9, dashArray: '7 5' }}>
                    <Popup><strong>{incident.description}</strong><br />{incident.roadName}<br />{incident.delaySeconds > 0 ? `${Math.round(incident.delaySeconds / 60)} min reported delay` : 'No delay value reported'}</Popup>
                  </Polyline>)}
                </>}
              </MapContainer>
            )}
            {!userLocation && isOnline && <div className="pointer-events-none absolute inset-x-4 bottom-4 z-[500] rounded-lg border border-[#4285f4]/30 bg-[var(--color-bg-card)]/95 p-3 text-center text-xs text-[var(--color-text-secondary)] shadow-lg"><LocateFixed size={16} className="mx-auto mb-1 text-[#4285f4]" />Waiting for GPS before loading nearby road conditions.</div>}
          </div>
        </section>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['#22c55e', 'Free flow', 'Near normal speed'],
            ['#eab308', 'Moderate', 'Slower than normal'],
            ['#f97316', 'Heavy', 'Strong congestion'],
            ['#ef4444', 'Severe', 'Very slow or stopped'],
          ].map(([color, label, detail]) => <div key={label} className="elevated-panel rounded-lg p-2.5"><div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} /><span className="text-xs font-bold text-[var(--color-text-primary)]">{label}</span></div><p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{detail}</p></div>)}
        </div>

        <section className="elevated-panel overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)]">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
            <h2 className="flex items-center gap-2 text-xs font-bold text-[var(--color-text-primary)]"><AlertTriangle size={13} className="text-[var(--color-orange)]" /> Live traffic incidents — 20 km</h2>
            <span className="text-[10px] text-[var(--color-text-muted)]">{incidents.length} found</span>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {loading && incidents.length === 0 ? <div role="status" aria-label="Checking the live incident feed" className="space-y-3 p-4">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="flex items-start gap-3"><Skeleton variant="block" className="h-10 w-10 shrink-0" /><div className="flex-1 space-y-2"><Skeleton variant="line" className="w-3/4" /><Skeleton variant="line" className="h-2 w-1/2" /></div></div>)}<span className="sr-only">Checking the live incident feed</span></div>
              : !userLocation ? <EmptyState text="GPS is required to monitor incidents within 20 km." />
              : incidents.length === 0 ? <EmptyState text="No live incidents are currently reported within 20 km." />
              : pageIncidents.map(incident => {
                const distance = Math.min(...incident.geometry.map(point => haversineKm(userLocation, point)))
                return <article key={incident.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0"><p className="text-xs font-semibold text-[var(--color-text-primary)]">{incident.description}</p><p className="mt-1 text-[10px] font-medium text-[var(--color-text-muted)]">{incident.roadName}</p><p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">{distance < 1 ? `${Math.round(distance * 1_000)} m` : `${distance.toFixed(1)} km`} away{incident.delaySeconds > 0 ? ` · ${Math.round(incident.delaySeconds / 60)} min delay` : ''}</p></div>
                    <span className="shrink-0 rounded border px-2 py-0.5 text-[9px] font-bold" style={{ color: trafficIncidentColor(incident), borderColor: `${trafficIncidentColor(incident)}55`, background: `${trafficIncidentColor(incident)}18` }}>{incident.magnitude >= 3 ? 'MAJOR' : incident.magnitude >= 2 ? 'MODERATE' : 'REPORTED'}</span>
                  </div>
                </article>
              })}
          </div>
          {totalPages > 1 && <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3 text-[10px]"><button type="button" disabled={currentPage === 1} onClick={() => setCurrentPage(page => page - 1)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 disabled:opacity-40">Previous</button><span>Page {currentPage} of {totalPages}</span><button type="button" disabled={currentPage === totalPages} onClick={() => setCurrentPage(page => page + 1)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 disabled:opacity-40">Next</button></div>}
        </section>

        <div className="elevated-panel rounded-[var(--radius-lg)] bg-[var(--panel)] p-4 text-[11px] leading-relaxed text-[var(--text-soft)]">
          <h3 className="mb-1 text-xs font-bold text-[var(--color-text-primary)]">Live traffic source</h3>
          <p>TomTom supplies the road flow and incident data used by KALASAG. Missing live coverage is left blank; the app does not invent a road condition.</p>
        </div>
      </div>
    </div>
  )
}

function DismissibleError({ message, onClose }: { message: string; onClose: () => void }) {
  return <div role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-xs text-[var(--danger)]"><span className="flex-1 py-1">{message}</span><button type="button" onClick={onClose} aria-label="Dismiss error" className="ui-control grid h-10 w-10 shrink-0 place-items-center rounded-md hover:bg-[var(--panel-elevated)] sm:h-8 sm:w-8"><X size={15} /></button></div>
}

function EmptyState({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center"><MapPin size={23} className="mx-auto mb-2 opacity-30" /><p className="text-xs text-[var(--color-text-muted)]">{text}</p></div>
}
