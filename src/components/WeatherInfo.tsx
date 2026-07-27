import { useEffect, useState, useCallback, useMemo } from 'react'
import { getLiveData } from '../lib/liveData'
import { Sun, Cloud, CloudRain, CloudLightning, Droplets, Wind, Eye, Thermometer, Sunrise, Sunset, RefreshCw, ChevronRight } from 'lucide-react'
import { Skeleton } from './ui/primitives'

// ── Cities ────────────────────────────────────────────────────
const CITIES = [
  { name: 'Manila', lat: 14.5995, lng: 120.9842, icon: '🏙️' },
  { name: 'Baguio', lat: 16.4023, lng: 120.5960, icon: '🌲' },
  { name: 'Cebu', lat: 10.3157, lng: 123.8854, icon: '🏝️' },
  { name: 'Davao', lat: 7.1907, lng: 125.4553, icon: '🌴' },
  { name: 'Puerto Princesa', lat: 9.7392, lng: 118.7353, icon: '🐚' },
  { name: 'Tacloban', lat: 11.2543, lng: 124.9556, icon: '⛵' },
  { name: 'Zamboanga', lat: 6.9214, lng: 122.0790, icon: '🌺' },
]

// ── Weather Code Map ─────────────────────────────────────────
function weatherCondition(code: number): { label: string; Icon: typeof Sun; color: string } {
  if (code === 0) return { label: 'Clear Sky', Icon: Sun, color: '#f6c90e' }
  if (code <= 3) return { label: 'Partly Cloudy', Icon: Cloud, color: '#9db5cc' }
  if (code <= 48) return { label: 'Foggy', Icon: Cloud, color: '#5a7a9a' }
  if (code <= 57) return { label: 'Drizzle', Icon: CloudRain, color: '#3b82f6' }
  if (code <= 67) return { label: 'Rain', Icon: CloudRain, color: '#3b82f6' }
  if (code <= 77) return { label: 'Snow', Icon: Cloud, color: '#e8f0fe' }
  if (code <= 82) return { label: 'Rain Showers', Icon: CloudRain, color: '#2563eb' }
  if (code <= 86) return { label: 'Snow Showers', Icon: Cloud, color: '#e8f0fe' }
  if (code === 95) return { label: 'Thunderstorm', Icon: CloudLightning, color: '#f6c90e' }
  return { label: 'Thunderstorm + Hail', Icon: CloudLightning, color: '#e53e3e' }
}

function beaufortLabel(speed: number): string {
  if (speed < 2) return 'Calm'
  if (speed < 12) return 'Light'
  if (speed < 29) return 'Gentle'
  if (speed < 39) return 'Moderate'
  if (speed < 50) return 'Fresh'
  if (speed < 62) return 'Strong'
  if (speed < 75) return 'Near Gale'
  if (speed < 89) return 'Gale'
  if (speed < 103) return 'Strong Gale'
  if (speed < 118) return 'Storm'
  return 'Hurricane'
}

function windColor(speed: number): string {
  if (speed < 20) return '#22c55e'
  if (speed < 40) return '#f6c90e'
  if (speed < 60) return '#ff6b00'
  return '#e53e3e'
}

// ── SVG Line Chart ────────────────────────────────────────────
function TempLineChart({ hourlyTemps, hourlyTimes }: { hourlyTemps: number[]; hourlyTimes: string[] }) {
  const [animated, setAnimated] = useState(false)
  const [hovered, setHovered] = useState<number | null>(null)
  useEffect(() => { setAnimated(false); const t = setTimeout(() => setAnimated(true), 200); return () => clearTimeout(t) }, [hourlyTemps])

  // Take every 3rd hour for 24 hours
  const data = useMemo(() => {
    const pts: { hour: string; temp: number }[] = []
    for (let i = 0; i < Math.min(24, hourlyTemps.length); i += 3) {
      pts.push({ hour: hourlyTimes[i]?.slice(11, 16) || `${i}h`, temp: hourlyTemps[i] })
    }
    return pts
  }, [hourlyTemps, hourlyTimes])

  if (data.length < 2) return null

  const width = 560, height = 200
  const pad = { top: 20, right: 20, bottom: 30, left: 40 }
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom
  const maxT = Math.max(...data.map(d => d.temp)) + 2
  const minT = Math.min(...data.map(d => d.temp)) - 2

  const points = data.map((d, i) => ({
    x: pad.left + (i / (data.length - 1)) * w,
    y: pad.top + h - ((d.temp - minT) / (maxT - minT)) * h,
    ...d,
  }))

  const isHot = points[0].temp > 30
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const areaPath = linePath + ` L${points[points.length - 1].x},${pad.top + h} L${points[0].x},${pad.top + h} Z`

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height }}>
      <defs>
        <linearGradient id="tempGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={isHot ? '#ff6b00' : '#3b82f6'} stopOpacity="0.3" />
          <stop offset="100%" stopColor={isHot ? '#ff6b00' : '#3b82f6'} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map(f => {
        const y = pad.top + h - f * h
        return <g key={f}>
          <line x1={pad.left} y1={y} x2={pad.left + w} y2={y} stroke="#1f2d3d" strokeWidth="1" />
          <text x={pad.left - 8} y={y + 4} textAnchor="end" fill="#5a7a9a" fontSize="9">{Math.round(minT + f * (maxT - minT))}°</text>
        </g>
      })}
      <path d={areaPath} fill="url(#tempGrad)" opacity={animated ? 1 : 0} style={{ transition: 'opacity 0.6s' }} />
      <path d={linePath} fill="none" stroke={isHot ? '#ff6b00' : '#3b82f6'} strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={animated ? 'none' : `${w * 3}`} strokeDashoffset={animated ? '0' : `${w * 3}`}
        style={{ transition: 'stroke-dashoffset 1.2s ease-out' }} />
      {points.map((p, i) => (
        <g key={i}>
          <text x={p.x} y={height - 5} textAnchor="middle" fill="#5a7a9a" fontSize="9">{p.hour}</text>
          <circle cx={p.x} cy={p.y} r={hovered === i ? 5 : 3} fill={isHot ? '#ff6b00' : '#3b82f6'} stroke="#080c10" strokeWidth="2"
            onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} style={{ cursor: 'pointer' }} />
          {hovered === i && (
            <g>
              <rect x={p.x - 22} y={p.y - 26} width="44" height="18" rx="3" fill="#131a21" stroke="#2a3f55" />
              <text x={p.x} y={p.y - 13} textAnchor="middle" fill="#e8f0fe" fontSize="10" fontWeight="700">{p.temp.toFixed(1)}°</text>
            </g>
          )}
        </g>
      ))}
    </svg>
  )
}

// ── SVG Bar Chart — Precipitation ──────────────────────────────
function PrecipBarChart({ daily }: { daily: { day: string; precip: number; prob: number }[] }) {
  const [animated, setAnimated] = useState(false)
  useEffect(() => { setAnimated(false); const t = setTimeout(() => setAnimated(true), 400); return () => clearTimeout(t) }, [daily])

  if (daily.length < 2) return null

  const maxP = Math.max(...daily.map(d => d.precip), 5) * 1.2
  const barW = 40, gap = 18
  const width = daily.length * (barW + gap) + 60
  const height = 180, chartH = 120

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: height }}>
      <defs>
        <linearGradient id="precipGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.4" />
        </linearGradient>
      </defs>
      {daily.map((d, i) => {
        const x = 40 + i * (barW + gap)
        const barH = animated ? Math.max((d.precip / maxP) * chartH, 2) : 0
        const y = 10 + chartH - barH
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={barH} rx="3" fill="url(#precipGrad)"
              style={{ transition: 'height 0.5s ease-out, y 0.5s ease-out' }} />
            <text x={x + barW / 2} y={y - 5} textAnchor="middle" fill="#3b82f6" fontSize="9" fontWeight="600">
              {animated ? `${d.precip.toFixed(1)}` : ''}
            </text>
            {/* Probability dot */}
            <circle cx={x + barW / 2} cy={10 + chartH - (d.prob / 100) * chartH} r="3" fill="#f6c90e" stroke="#080c10" strokeWidth="1.5"
              opacity={animated ? 1 : 0} style={{ transition: 'opacity 0.5s 0.5s' }} />
            <text x={x + barW / 2} y={height - 6} textAnchor="middle" fill="#5a7a9a" fontSize="9">{d.day}</text>
          </g>
        )
      })}
      {/* Prob line */}
      {animated && daily.length > 1 && (
        <polyline
          points={daily.map((d, i) => `${40 + i * (barW + gap) + barW / 2},${10 + chartH - (d.prob / 100) * chartH}`).join(' ')}
          fill="none" stroke="#f6c90e" strokeWidth="1.5" strokeDasharray="4,3" opacity="0.7"
        />
      )}
    </svg>
  )
}

// ── SVG Wind Compass ──────────────────────────────────────────
function WindCompass({ speed, direction }: { speed: number; direction: number }) {
  const size = 160, cx = size / 2, cy = size / 2, r = 58
  const dirs = ['N', 'E', 'S', 'W']
  const color = windColor(speed)

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {/* Compass ring */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1f2d3d" strokeWidth="2" />
        <circle cx={cx} cy={cy} r={r - 12} fill="none" stroke="#1f2d3d" strokeWidth="0.5" strokeDasharray="2,4" />
        {/* Cardinal directions */}
        {dirs.map((d, i) => {
          const angle = (i * 90 - 90) * Math.PI / 180
          const tx = cx + (r + 10) * Math.cos(angle)
          const ty = cy + (r + 10) * Math.sin(angle)
          return <text key={d} x={tx} y={ty + 3} textAnchor="middle" fill="#5a7a9a" fontSize="10" fontWeight="700">{d}</text>
        })}
        {/* Tick marks */}
        {Array.from({ length: 36 }, (_, i) => {
          const angle = (i * 10 - 90) * Math.PI / 180
          const inner = i % 9 === 0 ? r - 8 : r - 4
          return <line key={i} x1={cx + inner * Math.cos(angle)} y1={cy + inner * Math.sin(angle)}
            x2={cx + r * Math.cos(angle)} y2={cy + r * Math.sin(angle)} stroke="#2a3f55" strokeWidth={i % 9 === 0 ? 2 : 0.5} />
        })}
        {/* Wind arrow */}
        <g transform={`rotate(${direction} ${cx} ${cy})`}>
          <line x1={cx} y1={cy + 15} x2={cx} y2={cy - r + 16} stroke={color} strokeWidth="3" strokeLinecap="round" />
          <polygon points={`${cx},${cy - r + 8} ${cx - 6},${cy - r + 22} ${cx + 6},${cy - r + 22}`} fill={color} />
        </g>
        {/* Center value */}
        <circle cx={cx} cy={cy} r="20" fill="#131a21" stroke="#2a3f55" strokeWidth="1.5" />
        <text x={cx} y={cy + 1} textAnchor="middle" fill={color} fontSize="14" fontWeight="900">{Math.round(speed)}</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fill="#5a7a9a" fontSize="7">km/h</text>
      </svg>
      <span className="text-xs font-semibold mt-1" style={{ color }}>{beaufortLabel(speed)}</span>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────
export default function WeatherInfo() {
  const [cityIdx, setCityIdx] = useState(0)
  const [current, setCurrent] = useState<any>(null)
  const [hourly, setHourly] = useState<any>(null)
  const [daily, setDaily] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const city = CITIES[cityIdx]

  const fetchWeather = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const response = await getLiveData<any>('weather', { lat: city.lat, lng: city.lng })
      const data = response.data
      setCurrent(data.current)
      setHourly(data.hourly)
      setDaily(data.daily)
    } catch (err) {
      console.error('Weather fetch failed:', err)
      setError(err instanceof Error ? err.message : 'Live weather feed is unavailable.')
    }
    setLoading(false)
  }, [city])

  useEffect(() => { fetchWeather() }, [fetchWeather])

  const cond = current ? weatherCondition(current.weather_code) : null

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dailyData = useMemo(() => {
    if (!daily?.time) return []
    return daily.time.map((t: string, i: number) => ({
      day: dayNames[new Date(t).getDay()],
      precip: daily.precipitation_sum[i] || 0,
      prob: daily.precipitation_probability_max?.[i] || 0,
      high: daily.temperature_2m_max[i],
      low: daily.temperature_2m_min[i],
      code: daily.weather_code[i],
      sunrise: daily.sunrise?.[i],
      sunset: daily.sunset?.[i],
    }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daily])

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg-primary)]">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6 animate-smooth-slide-up">
        {/* Title */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl sm:text-2xl font-black text-[var(--color-text-primary)] tracking-tight flex items-center gap-2">
              <Sun size={24} className="text-[var(--color-yellow-warn)]" />
              Weather Forecast
            </h1>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              Live weather · 7-day forecast · Philippine cities
            </p>
          </div>
          <button onClick={fetchWeather} disabled={loading}
            className="p-2 rounded-lg border border-[var(--color-border-bright)] text-[var(--color-text-muted)] hover:text-[var(--color-blue-info)] transition-all">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {error && <p role="alert" className="rounded-lg border border-[var(--color-red-alert)]/30 bg-[var(--color-red-alert)]/10 px-3 py-2 text-xs text-[var(--color-red-alert)]">{error}</p>}

        {/* City Selector */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
          {CITIES.map((c, i) => {
            const isActive = i === cityIdx
            return (
              <button key={c.name} onClick={() => setCityIdx(i)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border whitespace-nowrap text-xs font-semibold transition-all shrink-0 ${
                  isActive
                    ? 'border-[var(--color-orange)] bg-[var(--color-orange)]/10 text-[var(--color-text-primary)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-bright)] hover:text-[var(--color-text-secondary)]'
                }`}>
                <span>{c.icon}</span>
                {c.name}
              </button>
            )
          })}
        </div>

        {/* Current Weather Hero Card */}
        {loading ? <Skeleton className="h-52" /> : current && cond && (
          <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] p-5 animate-scale-in">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              {/* Main temp */}
              <div className="flex items-center gap-3">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: `${cond.color}15` }}>
                  <cond.Icon size={32} style={{ color: cond.color }} />
                </div>
                <div>
                  <p className="text-4xl font-black text-[var(--color-text-primary)] tracking-tight">
                    {Math.round(current.temperature_2m)}°C
                  </p>
                  <p className="text-sm text-[var(--color-text-secondary)] font-medium">{cond.label}</p>
                  <p className="text-[10px] text-[var(--color-text-muted)]">{city.name}, Philippines</p>
                </div>
              </div>

              {/* Detail grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1 w-full sm:w-auto">
                {[
                  { icon: Thermometer, label: 'Feels Like', value: `${Math.round(current.apparent_temperature)}°C`, color: '#ff6b00' },
                  { icon: Droplets, label: 'Humidity', value: `${current.relative_humidity_2m}%`, color: '#3b82f6' },
                  { icon: Wind, label: 'Wind', value: `${Math.round(current.wind_speed_10m)} km/h`, color: windColor(current.wind_speed_10m) },
                  { icon: Eye, label: 'UV Index', value: `${current.uv_index}`, color: current.uv_index > 6 ? '#e53e3e' : '#f6c90e' },
                ].map(({ icon: Icon, label, value, color }, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 rounded-lg bg-[var(--color-bg-elevated)]/30">
                    <Icon size={14} style={{ color }} className="shrink-0" />
                    <div>
                      <p className="text-[9px] text-[var(--color-text-muted)] uppercase">{label}</p>
                      <p className="text-sm font-bold text-[var(--color-text-primary)]">{value}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Sunrise / Sunset */}
            {dailyData[0] && (
              <div className="flex items-center gap-4 mt-4 pt-3 border-t border-[var(--color-border)]">
                <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                  <Sunrise size={14} className="text-[var(--color-yellow-warn)]" />
                  {dailyData[0].sunrise?.slice(11, 16) || '—'}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
                  <Sunset size={14} className="text-[var(--color-orange)]" />
                  {dailyData[0].sunset?.slice(11, 16) || '—'}
                </div>
                <div className="ml-auto text-[10px] text-[var(--color-text-muted)]">
                  Pressure: {Math.round(current.surface_pressure)} hPa
                </div>
              </div>
            )}
          </div>
        )}

        {/* Charts Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Temp Line Chart */}
          <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] p-4">
            <h3 className="text-sm font-bold text-[var(--color-text-primary)] mb-3 flex items-center gap-2">
              <Thermometer size={14} className="text-[var(--color-orange)]" />
              24-Hour Temperature Trend
            </h3>
            {hourly ? (
              <TempLineChart hourlyTemps={hourly.temperature_2m} hourlyTimes={hourly.time} />
            ) : <Skeleton className="h-40" />}
            <p className="text-[10px] text-[var(--color-text-muted)] mt-2">
              <span className="text-[var(--color-orange)]">●</span> Temperature (°C) · 3-hour intervals
            </p>
          </div>

          {/* Precip Bar Chart */}
          <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] p-4">
            <h3 className="text-sm font-bold text-[var(--color-text-primary)] mb-3 flex items-center gap-2">
              <CloudRain size={14} className="text-[var(--color-blue-info)]" />
              7-Day Precipitation
            </h3>
            {dailyData.length > 0 ? (
              <PrecipBarChart daily={dailyData} />
            ) : <Skeleton className="h-40" />}
            <p className="text-[10px] text-[var(--color-text-muted)] mt-2">
              <span className="text-[#3b82f6]">█</span> Rain (mm) &nbsp;
              <span className="text-[#f6c90e]">●</span> Probability (%)
            </p>
          </div>
        </div>

        {/* Wind Compass + 7-Day Forecast */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Wind */}
          <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] p-4 flex flex-col items-center justify-center">
            <h3 className="text-sm font-bold text-[var(--color-text-primary)] mb-3 flex items-center gap-2 self-start">
              <Wind size={14} className="text-[var(--color-teal)]" />
              Wind Direction
            </h3>
            {current ? (
              <WindCompass speed={current.wind_speed_10m} direction={current.wind_direction_10m} />
            ) : <Skeleton className="w-40 h-40 rounded-full" />}
          </div>

          {/* 7-Day Forecast Cards */}
          <div className="elevated-panel lg:col-span-2 bg-[var(--panel)] rounded-[var(--radius-lg)] p-4">
            <h3 className="text-sm font-bold text-[var(--color-text-primary)] mb-3 flex items-center gap-2">
              <ChevronRight size={14} className="text-[var(--color-blue-info)]" />
              7-Day Forecast
            </h3>
            <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-thin">
              {dailyData.map((d: any, i: number) => {
                const cond = weatherCondition(d.code)
                return (
                  <div key={i} className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-[var(--color-bg-elevated)]/30 border border-[var(--color-border)] min-w-[80px] shrink-0">
                    <span className="text-xs font-bold text-[var(--color-text-primary)]">{i === 0 ? 'Today' : d.day}</span>
                    <cond.Icon size={20} style={{ color: cond.color }} />
                    <span className="text-[10px] text-[var(--color-text-muted)]">{cond.label}</span>
                    <div className="flex items-center gap-1 text-xs">
                      <span className="font-bold text-[var(--color-text-primary)]">{Math.round(d.high)}°</span>
                      <span className="text-[var(--color-text-muted)]">/</span>
                      <span className="text-[var(--color-text-muted)]">{Math.round(d.low)}°</span>
                    </div>
                    <div className="flex items-center gap-1 text-[9px] text-[var(--color-blue-info)]">
                      <Droplets size={10} />
                      {d.prob}%
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <p className="text-center text-[10px] text-[var(--color-text-muted)] pb-4">
          Live forecast · Auto-updated · {city.name} coordinates ({city.lat}°N, {city.lng}°E)
        </p>
      </div>
    </div>
  )
}
