import L from 'leaflet'
import { Marker, Popup } from 'react-leaflet'
import type { DamReleaseAdvisory, DamStatus } from '../../lib/liveData'

type Props = {
  dams: DamStatus[]
  enabled: boolean
  releases: DamReleaseAdvisory[]
}

function damIcon(releaseObserved: boolean) {
  const color = releaseObserved ? '#f97316' : '#0ea5e9'
  return L.divIcon({
    className: '',
    html: `<div role="img" aria-label="${releaseObserved ? 'Dam with observed discharge' : 'Dam observation'}" style="width:24px;height:24px;display:grid;place-items:center;color:${color};font:700 18px/1 system-ui,sans-serif">D</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  })
}

function value(value: number | null, unit = '') {
  return value === null ? 'Not reported' : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit}`
}

export default function DamStatusLayer({ dams, enabled, releases }: Props) {
  if (!enabled) return null
  const releaseByDam = new Map(releases.map(release => [release.damName.toLowerCase(), release]))

  return dams.flatMap(dam => {
    const lat = dam.lat
    const lng = dam.lng
    if (
      typeof lat !== 'number'
      || typeof lng !== 'number'
      || !Number.isFinite(lat)
      || !Number.isFinite(lng)
      || lat < 4.5
      || lat > 21.5
      || lng < 116
      || lng > 127.5
    ) return []
    const release = releaseByDam.get(dam.name.toLowerCase())
    const releaseObserved = release?.noticeStatus === 'discharge-observed-at-source-time' || release?.noticeStatus === 'current-discharge-observed'
    return [(
      <Marker key={dam.id} position={[lat, lng]} icon={damIcon(releaseObserved)}>
        <Popup>
          <div className="min-w-[220px] space-y-1 text-xs text-[var(--text)]">
            <p className="text-sm font-bold text-sky-400">{dam.name} Dam</p>
            <p className="text-[10px] text-[var(--muted)]">
              Observed {dam.observedAt ? new Date(dam.observedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : 'time not reported'}
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1">
              <span className="text-[var(--muted)]">Water level</span><span>{value(dam.reservoirWaterLevelM, ' m')}</span>
              <span className="text-[var(--muted)]">24-hour change</span><span>{value(dam.changeM, ' m')}</span>
              <span className="text-[var(--muted)]">Normal high</span><span>{value(dam.normalHighWaterLevelM, ' m')}</span>
              <span className="text-[var(--muted)]">Rule curve</span><span>{value(dam.ruleCurveElevationM, ' m')}</span>
              <span className="text-[var(--muted)]">Gate opening</span><span>{value(dam.gateOpeningCount)} / {value(dam.gateOpeningM, ' m')}</span>
              <span className="text-[var(--muted)]">Inflow</span><span>{value(dam.inflowCms, ' cms')}</span>
              <span className="text-[var(--muted)]">Outflow</span><span>{value(dam.outflowCms, ' cms')}</span>
            </div>
            <p className={`mt-2 rounded-md px-2 py-1.5 text-[10px] ${releaseObserved ? 'bg-orange-500/15 text-orange-300' : 'bg-sky-500/10 text-[var(--text-soft)]'}`}>
              {release?.message ?? 'No release schedule was published in the checked official source.'}
            </p>
          </div>
        </Popup>
      </Marker>
    )]
  })
}
