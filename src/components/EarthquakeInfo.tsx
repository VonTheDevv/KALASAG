import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { Layers, MapPin, RefreshCw, TrendingUp, Zap } from 'lucide-react'
import { getLiveData } from '../lib/liveData'
import { useTheme } from '../hooks/useTheme'
import { CARTO_RASTER_MAX_ZOOM } from '../lib/mapTiles'
import { IconButton, Skeleton } from './ui/primitives'

type Earthquake = { id: string; properties: { mag: number; place: string; time: number }; geometry: { coordinates: [number, number, number] } }
const colorForMagnitude = (magnitude: number) => magnitude >= 7 ? '#e53e3e' : magnitude >= 6 ? '#ff6b00' : magnitude >= 5 ? '#f6c90e' : '#14b8a6'

export default function EarthquakeInfo() {
  const { resolvedTheme } = useTheme()
  const [earthquakes, setEarthquakes] = useState<Earthquake[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await getLiveData<Earthquake[]>('earthquakes')
      setEarthquakes(response.data)
      setPage(1)
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Earthquake data is unavailable.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => void refresh(), 10 * 60 * 1000)
    return () => window.clearInterval(interval)
  }, [refresh])

  const strongest = useMemo(() => earthquakes.reduce<Earthquake | null>((current, quake) => !current || quake.properties.mag > current.properties.mag ? quake : current, null), [earthquakes])
  const averageDepth = useMemo(() => earthquakes.length ? earthquakes.reduce((sum, quake) => sum + quake.geometry.coordinates[2], 0) / earthquakes.length : 0, [earthquakes])
  const buckets = useMemo(() => [
    { label: 'M4–4.9', min: 4, max: 5, color: '#14b8a6' },
    { label: 'M5–5.9', min: 5, max: 6, color: '#f6c90e' },
    { label: 'M6–6.9', min: 6, max: 7, color: '#ff6b00' },
    { label: 'M7+', min: 7, max: Infinity, color: '#e53e3e' },
  ].map(bucket => ({ ...bucket, count: earthquakes.filter(quake => quake.properties.mag >= bucket.min && quake.properties.mag < bucket.max).length })), [earthquakes])
  const pageItems = earthquakes.slice((page - 1) * 10, page * 10)
  const pages = Math.max(1, Math.ceil(earthquakes.length / 10))
  const initialLoading = loading && earthquakes.length === 0

  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)]">
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-extrabold text-[var(--text)] sm:text-2xl"><Zap className="text-[var(--color-yellow-warn)]" />Earthquake information</h1>
            <p className="mt-1 text-xs text-[var(--muted)]">Live seismic events, M4.0+ in the Philippine region over the last 30 days.</p>
          </div>
          <IconButton variant="secondary" onClick={() => void refresh()} disabled={loading} aria-label="Refresh earthquake data" title="Refresh earthquake data"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></IconButton>
        </header>

        {error && <p role="alert" className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{error}</p>}

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={Zap} label="Detected" value={earthquakes.length.toString()} loading={initialLoading} />
          <Stat icon={TrendingUp} label="Strongest" value={strongest ? `M${strongest.properties.mag.toFixed(1)}` : '—'} loading={initialLoading} />
          <Stat icon={Layers} label="Average depth" value={earthquakes.length ? `${averageDepth.toFixed(1)} km` : '—'} loading={initialLoading} />
          <Stat icon={MapPin} label="Latest event" value={earthquakes[0] ? new Date(earthquakes[0].properties.time).toLocaleDateString('en-PH') : '—'} loading={initialLoading} />
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="elevated-panel rounded-[var(--radius-lg)] bg-[var(--panel)] p-4">
            <h2 className="mb-4 text-sm font-bold text-[var(--text)]">Live magnitude distribution</h2>
            {initialLoading ? <div className="space-y-4">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} variant="line" className="h-7 w-full" />)}</div> : (
              <div className="space-y-3">{buckets.map(bucket => <div key={bucket.label}><div className="flex justify-between text-xs text-[var(--text-soft)]"><span>{bucket.label}</span><span>{bucket.count}</span></div><div className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--panel-elevated)]"><div className="h-full rounded-full" style={{ width: `${earthquakes.length ? bucket.count / earthquakes.length * 100 : 0}%`, background: bucket.color }} /></div></div>)}</div>
            )}
          </article>
          <div className="elevated-panel h-[260px] overflow-hidden rounded-[var(--radius-lg)]">
            <MapContainer center={[12.5, 122]} zoom={6} maxZoom={CARTO_RASTER_MAX_ZOOM} className="h-full w-full" attributionControl={false}>
              <TileLayer url={`https://{s}.basemaps.cartocdn.com/${resolvedTheme === 'dark' ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`} maxZoom={CARTO_RASTER_MAX_ZOOM} maxNativeZoom={CARTO_RASTER_MAX_ZOOM} />
              {earthquakes.map(quake => {
                const [lng, lat, depth] = quake.geometry.coordinates
                return <CircleMarker key={quake.id} center={[lat, lng]} radius={Math.max(4, quake.properties.mag * 2.5)} pathOptions={{ color: colorForMagnitude(quake.properties.mag), fillColor: colorForMagnitude(quake.properties.mag), fillOpacity: 0.6 }}><Popup><strong>M{quake.properties.mag.toFixed(1)}</strong><br />{quake.properties.place}<br />Depth {depth.toFixed(1)} km</Popup></CircleMarker>
              })}
            </MapContainer>
          </div>
        </section>

        <section className="elevated-panel overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)]">
          <h2 className="border-b border-[var(--border)] px-4 py-3 text-sm font-bold text-[var(--text)]">Recent live events</h2>
          {initialLoading ? (
            <div role="status" aria-label="Loading earthquake events" className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="flex gap-3"><Skeleton variant="block" className="h-10 w-10 shrink-0" /><div className="flex-1 space-y-2"><Skeleton variant="line" className="w-3/4" /><Skeleton variant="line" className="h-2 w-1/2" /></div></div>)}</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">{pageItems.map(quake => <div key={quake.id} className="flex gap-3 px-4 py-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-md)] font-bold" style={{ color: colorForMagnitude(quake.properties.mag), background: `${colorForMagnitude(quake.properties.mag)}20` }}>{quake.properties.mag.toFixed(1)}</span><div className="min-w-0 flex-1"><p className="truncate text-sm text-[var(--text)]">{quake.properties.place}</p><p className="text-xs text-[var(--muted)]">Depth {quake.geometry.coordinates[2].toFixed(1)} km · {new Date(quake.properties.time).toLocaleString('en-PH')}</p></div></div>)}</div>
          )}
          <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-2 text-xs"><button type="button" disabled={page === 1} onClick={() => setPage(current => current - 1)} className="ui-control rounded-md px-2 py-1 text-[var(--text-soft)] hover:bg-[var(--panel-elevated)] disabled:opacity-40">Previous</button><span className="text-[var(--muted)]">Page {page} of {pages}</span><button type="button" disabled={page === pages} onClick={() => setPage(current => current + 1)} className="ui-control rounded-md px-2 py-1 text-[var(--text-soft)] hover:bg-[var(--panel-elevated)] disabled:opacity-40">Next</button></div>
        </section>
      </div>
    </div>
  )
}

function Stat({ icon: Icon, label, value, loading }: { icon: typeof Zap; label: string; value: string; loading: boolean }) {
  return <div className="elevated-panel rounded-[var(--radius-lg)] bg-[var(--panel)] p-3"><Icon size={16} className="text-[var(--color-yellow-warn)]" /><p className="mt-2 text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</p>{loading ? <Skeleton variant="line" className="mt-1 h-4 w-16" /> : <p className="text-sm font-bold text-[var(--text)]">{value}</p>}</div>
}
