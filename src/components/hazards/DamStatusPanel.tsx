import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, RefreshCw, Waves } from 'lucide-react'
import {
  getLiveData,
  type DamReleaseAdvisory,
  type DamStatus,
  type HazardFeedMetadata,
} from '../../lib/liveData'

function metric(value: number | null, unit = '') {
  return value === null ? 'Not reported' : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit}`
}

function dateTime(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Observation time not reported'
  return new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })
}

export default function DamStatusPanel() {
  const [dams, setDams] = useState<DamStatus[]>([])
  const [releases, setReleases] = useState<DamReleaseAdvisory[]>([])
  const [metadata, setMetadata] = useState<HazardFeedMetadata | null>(null)
  const [releaseMetadata, setReleaseMetadata] = useState<HazardFeedMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [releaseError, setReleaseError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    const [damResult, releaseResult] = await Promise.allSettled([
      getLiveData<DamStatus[]>('dams'),
      getLiveData<DamReleaseAdvisory[]>('dam-release-advisories'),
    ])
    if (damResult.status === 'fulfilled') {
      setDams(damResult.value.data)
      setMetadata(damResult.value.metadata ?? null)
      setError(null)
    } else {
      setError(damResult.reason instanceof Error ? damResult.reason.message : 'Dam observations are temporarily unavailable.')
    }
    if (releaseResult.status === 'fulfilled') {
      setReleases(releaseResult.value.data)
      setReleaseMetadata(releaseResult.value.metadata ?? null)
      setReleaseError(null)
    } else {
      setReleaseError(releaseResult.reason instanceof Error ? releaseResult.reason.message : 'Dam release observations are temporarily unavailable.')
    }
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const releaseByDam = useMemo(() => new Map(releases.map(item => [item.damName.toLowerCase(), item])), [releases])
  const stale = metadata?.freshness === 'stale' || releaseMetadata?.freshness === 'stale'
  const unknown = metadata?.freshness === 'unknown' || releaseMetadata?.freshness === 'unknown'

  return (
    <div className="h-full overflow-y-auto bg-[var(--surface)] p-4 text-[var(--text)] sm:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Waves className="text-sky-500" size={24} />
              <h1 className="text-xl font-bold sm:text-2xl">Dam status</h1>
            </div>
            <p className="mt-1 max-w-2xl text-sm text-[var(--text-soft)]">Latest published water-level, gate, inflow and outflow observations. Their official timestamp is shown on every card; release times are never estimated.</p>
          </div>
          <button type="button" onClick={() => void refresh()} disabled={loading} className="ui-control flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] bg-[var(--panel)] px-4 text-sm font-semibold shadow-[var(--shadow-sm)] disabled:opacity-60">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {stale && <div role="status" className="rounded-[var(--radius-md)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning)] shadow-[var(--shadow-sm)]"><AlertTriangle className="mr-2 inline" size={16} />These values are stale: the official timestamp is older than the daily publication window, or the latest source refresh failed.</div>}
        {unknown && !stale && <div role="status" className="rounded-[var(--radius-md)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning)] shadow-[var(--shadow-sm)]"><AlertTriangle className="mr-2 inline" size={16} />The official source did not publish a usable observation time. Recency cannot be verified; do not treat these values as current.</div>}
        {error && dams.length > 0 && <div role="status" className="rounded-[var(--radius-md)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning)] shadow-[var(--shadow-sm)]"><AlertTriangle className="mr-2 inline" size={16} />The latest dam refresh failed. Previously loaded values remain visible and must not be treated as current.</div>}
        {releaseError && <div role="status" className="rounded-[var(--radius-md)] bg-[var(--warning-soft)] p-3 text-sm text-[var(--warning)] shadow-[var(--shadow-sm)]"><AlertTriangle className="mr-2 inline" size={16} />Release-status refresh failed. Do not infer a release schedule from the water-level table.</div>}
        {error && dams.length === 0 && <div role="alert" className="rounded-[var(--radius-md)] bg-[var(--danger-soft)] p-4 text-sm text-[var(--danger)] shadow-[var(--shadow-sm)]">{error}</div>}

        {loading && dams.length === 0 ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading dam observations">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="h-64 animate-pulse rounded-[var(--radius-lg)] bg-[var(--panel)] shadow-[var(--shadow-md)]" />)}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {dams.map(dam => {
              const release = releaseByDam.get(dam.name.toLowerCase())
              const dischargeObserved = release?.noticeStatus === 'discharge-observed-at-source-time' || release?.noticeStatus === 'current-discharge-observed'
              return (
                <article key={dam.id} className="rounded-[var(--radius-lg)] bg-[var(--panel)] p-5 shadow-[var(--shadow-md)]">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-bold">{dam.name}</h2>
                      <p className="mt-0.5 text-[11px] text-[var(--muted)]">{dateTime(dam.observedAt)}</p>
                    </div>
                    <Activity size={20} className={dischargeObserved ? 'text-orange-500' : 'text-sky-500'} />
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <dt className="text-[var(--muted)]">Reservoir level</dt><dd className="text-right font-semibold">{metric(dam.reservoirWaterLevelM, ' m')}</dd>
                    <dt className="text-[var(--muted)]">24-hour change</dt><dd className="text-right font-semibold">{metric(dam.changeM, ' m')}</dd>
                    <dt className="text-[var(--muted)]">Normal high</dt><dd className="text-right font-semibold">{metric(dam.normalHighWaterLevelM, ' m')}</dd>
                    <dt className="text-[var(--muted)]">Rule curve</dt><dd className="text-right font-semibold">{metric(dam.ruleCurveElevationM, ' m')}</dd>
                    <dt className="text-[var(--muted)]">Gate count</dt><dd className="text-right font-semibold">{metric(dam.gateOpeningCount)}</dd>
                    <dt className="text-[var(--muted)]">Gate opening</dt><dd className="text-right font-semibold">{metric(dam.gateOpeningM, ' m')}</dd>
                    <dt className="text-[var(--muted)]">Inflow</dt><dd className="text-right font-semibold">{metric(dam.inflowCms, ' cms')}</dd>
                    <dt className="text-[var(--muted)]">Outflow</dt><dd className="text-right font-semibold">{metric(dam.outflowCms, ' cms')}</dd>
                  </dl>
                  <div className={`mt-4 rounded-[var(--radius-md)] p-3 text-xs leading-relaxed ${dischargeObserved ? 'bg-orange-500/10 text-orange-400' : 'bg-[var(--panel-elevated)] text-[var(--text-soft)]'}`}>
                    <p className="font-semibold">{dischargeObserved ? 'Discharge values reported at observation time' : 'No schedule in checked source'}</p>
                    <p className="mt-1">{release?.message ?? 'Release-notice status is temporarily unavailable. Do not infer release timing from the water level.'}</p>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
