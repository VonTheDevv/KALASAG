import { useCallback, useEffect, useMemo, useState } from 'react'
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { AlertTriangle, Mountain, RefreshCw } from 'lucide-react'
import { fetchVolcanoes, type Volcano } from '../lib/supabase'
import { useTheme } from '../hooks/useTheme'
import { CARTO_RASTER_MAX_ZOOM } from '../lib/mapTiles'
import { IconButton, Skeleton } from './ui/primitives'

const alertColor = (level: number) => level >= 3 ? '#e53e3e' : level === 2 ? '#ff6b00' : level === 1 ? '#f6c90e' : '#22c55e'

export default function VolcanoInfo() {
  const { resolvedTheme } = useTheme()
  const [volcanoes, setVolcanoes] = useState<Volcano[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await fetchVolcanoes()
      setVolcanoes(data)
      setSelectedId(current => data.some(volcano => volcano.id === current) ? current : data[0]?.id ?? null)
    } catch {
      setError('Official volcano status data is unavailable right now.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => void refresh(), 10 * 60 * 1000)
    return () => window.clearInterval(interval)
  }, [refresh])

  const selected = volcanoes.find(volcano => volcano.id === selectedId) ?? null
  const elevated = useMemo(() => volcanoes.filter(volcano => volcano.alert_level > 0), [volcanoes])
  const latestUpdate = useMemo(() => volcanoes.reduce<string | null>((latest, volcano) => !latest || volcano.updated_at > latest ? volcano.updated_at : latest, null), [volcanoes])
  const initialLoading = loading && volcanoes.length === 0

  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)]">
      <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-extrabold text-[var(--text)] sm:text-2xl"><Mountain className="text-[var(--color-orange)]" />Volcano status</h1>
            <p className="mt-1 text-xs text-[var(--muted)]">Values are loaded from the project’s PHIVOLCS-backed status dataset. No simulated seismicity is shown.</p>
          </div>
          <IconButton variant="secondary" onClick={() => void refresh()} disabled={loading} aria-label="Refresh volcano status" title="Refresh volcano status"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></IconButton>
        </header>

        {error && <p role="alert" className="rounded-[var(--radius-md)] border border-[var(--danger-border)] bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)]">{error}</p>}

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Monitored" value={volcanoes.length.toString()} loading={initialLoading} />
          <Stat label="Elevated alerts" value={elevated.length.toString()} loading={initialLoading} />
          <Stat label="Last dataset update" value={latestUpdate ? new Date(latestUpdate).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Unavailable'} loading={initialLoading} />
        </section>

        <section className="elevated-panel h-[320px] overflow-hidden rounded-[var(--radius-lg)]">
          <MapContainer center={[12.5, 122]} zoom={6} maxZoom={CARTO_RASTER_MAX_ZOOM} className="h-full w-full" attributionControl={false}>
            <TileLayer url={`https://{s}.basemaps.cartocdn.com/${resolvedTheme === 'dark' ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`} maxZoom={CARTO_RASTER_MAX_ZOOM} maxNativeZoom={CARTO_RASTER_MAX_ZOOM} />
            {volcanoes.map(volcano => <CircleMarker key={volcano.id} center={[volcano.lat, volcano.lng]} radius={selectedId === volcano.id ? 10 : 7} pathOptions={{ color: alertColor(volcano.alert_level), fillColor: alertColor(volcano.alert_level), fillOpacity: 0.75 }} eventHandlers={{ click: () => setSelectedId(volcano.id) }}><Popup><strong>{volcano.name}</strong><br />Alert level {volcano.alert_level}<br />{volcano.status}</Popup></CircleMarker>)}
          </MapContainer>
        </section>

        {selected && <section className="elevated-panel rounded-[var(--radius-lg)] bg-[var(--panel)] p-4" style={{ boxShadow: `inset 4px 0 0 ${alertColor(selected.alert_level)}, var(--shadow-card)` }}><div className="flex items-start justify-between gap-3"><div><h2 className="font-bold text-[var(--text)]">{selected.name}</h2><p className="mt-1 text-xs text-[var(--muted)]">Updated {new Date(selected.updated_at).toLocaleString('en-PH')}</p></div><span className="rounded-md px-2 py-1 text-xs font-bold" style={{ color: alertColor(selected.alert_level), background: `${alertColor(selected.alert_level)}20` }}>Alert level {selected.alert_level}</span></div><p className="mt-3 text-sm text-[var(--text-soft)]">{selected.details || selected.status}</p></section>}

        <section className="elevated-panel overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)]">
          <h2 className="border-b border-[var(--border)] px-4 py-3 text-sm font-bold text-[var(--text)]">Current monitored volcanoes</h2>
          {initialLoading ? (
            <div role="status" aria-label="Loading volcano status" className="space-y-3 p-4">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="flex items-center justify-between gap-4"><Skeleton variant="line" className="w-40" /><Skeleton variant="line" className="w-28" /></div>)}</div>
          ) : volcanoes.length === 0 ? (
            <p className="p-4 text-sm text-[var(--muted)]">No published volcano records are currently available.</p>
          ) : (
            <div className="divide-y divide-[var(--border)]">{volcanoes.slice().sort((a, b) => b.alert_level - a.alert_level || a.name.localeCompare(b.name)).map(volcano => <button type="button" key={volcano.id} onClick={() => setSelectedId(volcano.id)} className="ui-control flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[var(--panel-elevated)]"><span className="text-sm font-medium text-[var(--text)]">{volcano.name}</span><span className="text-right text-xs font-bold" style={{ color: alertColor(volcano.alert_level) }}>Level {volcano.alert_level} · {volcano.status}</span></button>)}</div>
          )}
        </section>

        <p className="flex items-center justify-center gap-1 text-center text-[10px] text-[var(--muted)]"><AlertTriangle size={11} />Verify evacuation instructions with PHIVOLCS and local authorities.</p>
      </div>
    </div>
  )
}

function Stat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return <div className="elevated-panel rounded-[var(--radius-lg)] bg-[var(--panel)] p-3"><p className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</p>{loading ? <Skeleton variant="line" className="mt-2 h-4 w-24" /> : <p className="mt-1 break-words text-sm font-bold text-[var(--text)]">{value}</p>}</div>
}
