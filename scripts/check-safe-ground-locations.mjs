import fs from 'node:fs'
import path from 'node:path'

const env = { ...process.env }
for (const filename of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  const pathname = path.join(process.cwd(), filename)
  if (!fs.existsSync(pathname)) continue
  for (const line of fs.readFileSync(pathname, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    env[match[1]] = value
  }
}

const supabaseUrl = String(env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const anonKey = String(env.VITE_SUPABASE_ANON_KEY || '')
const configuredGateway = String(env.VITE_LIVE_DATA_URL || '').trim()
if (!supabaseUrl || !anonKey) throw new Error('Supabase client configuration is missing')

const gateway = new URL(configuredGateway || `${supabaseUrl}/functions/v1/live-data`)
const radiusKm = 5
const locations = [
  ['Valenzuela', 14.7011, 120.9830],
  ['Cebu', 10.3157, 123.8854],
  ['Davao', 7.0731, 125.6128],
  ['Baguio', 16.4023, 120.5960],
]
const headers = {
  apikey: anonKey,
  authorization: `Bearer ${anonKey}`,
  origin: 'https://localhost',
}

const radians = value => value * Math.PI / 180
function distanceKm(latA, lngA, latB, lngB) {
  const latDelta = radians(latB - latA)
  const lngDelta = radians(lngB - lngA)
  const value = Math.sin(latDelta / 2) ** 2
    + Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(lngDelta / 2) ** 2
  return 6_371.0088 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)))
}

let failures = 0
for (const [name, lat, lng] of locations) {
  const endpoint = new URL(gateway)
  Object.entries({ resource: 'safe-grounds', lat, lng, radiusKm }).forEach(([key, value]) => endpoint.searchParams.set(key, String(value)))
  const started = performance.now()
  try {
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30_000) })
    const payload = await response.json().catch(() => undefined)
    const rows = Array.isArray(payload?.data) ? payload.data : []
    const distances = rows.map(row => distanceKm(lat, lng, Number(row.lat), Number(row.lng)))
    const withinRadius = distances.every(distance => Number.isFinite(distance) && distance <= radiusKm + 0.05)
    const nearestIndex = distances.reduce((best, distance, index) => best < 0 || distance < distances[best] ? index : best, -1)
    const valid = response.ok && Number(payload?.radiusKm) === radiusKm && rows.length > 0 && withinRadius
    if (!valid) failures += 1
    const sources = Array.isArray(payload?.sources) ? payload.sources.map(source => `${source.id}:${source.status}`).join(',') : 'none'
    console.log(`${valid ? 'PASS' : 'FAIL'} ${name}: ${rows.length} candidates; nearest=${nearestIndex >= 0 ? rows[nearestIndex].name : 'none'}; distance=${nearestIndex >= 0 ? distances[nearestIndex].toFixed(3) : 'n/a'}km; sources=${sources}; ${Math.round(performance.now() - started)}ms`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failures) {
  console.error(`${failures} location scan(s) failed.`)
  process.exitCode = 1
} else {
  console.log('All GPS-centered safe-ground scans passed without a location-specific fallback.')
}
