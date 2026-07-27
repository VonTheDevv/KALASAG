import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const env = { ...process.env }

function loadEnvFile(name) {
  const filename = path.join(process.cwd(), name)
  if (!fs.existsSync(filename)) return
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    env[match[1]] = value
  }
}

for (const filename of ['.env', '.env.local', '.env.production', '.env.production.local']) loadEnvFile(filename)

const supabaseUrl = String(env.VITE_SUPABASE_URL || '').replace(/\/$/, '')
const anonKey = String(env.VITE_SUPABASE_ANON_KEY || '')
const configuredGateway = String(env.VITE_LIVE_DATA_URL || '').trim()
if (!supabaseUrl || !anonKey) throw new Error('Supabase client configuration is missing')

const baseUrl = new URL(configuredGateway || `${supabaseUrl}/functions/v1/live-data`)
const headers = {
  apikey: anonKey,
  authorization: `Bearer ${anonKey}`,
  origin: 'https://localhost',
}

const checks = [
  ['weather', { lat: 14.5995, lng: 120.9842 }],
  ['earthquakes', {}],
  ['heat', {}],
  ['storms', {}],
  ['floods', {}],
  ['flood-advisories', {}],
  ['storm-surge-advisories', {}],
  ['dams', {}],
  ['dam-release-advisories', {}],
  ['reverse-geocode', { lat: 14.5995, lng: 120.9842 }],
  ['flights', {}],
  ['safe-grounds', { lat: 14.5995, lng: 120.9842 }],
  ['traffic', { lat: 14.5995, lng: 120.9842, radiusKm: 20 }],
  ['gfw-vessel', { mmsi: '548000000' }],
]
const metadataResources = new Set(['floods', 'flood-advisories', 'storm-surge-advisories', 'dams', 'dam-release-advisories', 'reverse-geocode'])

function summarizeData(data) {
  if (Array.isArray(data)) return `${data.length} records`
  if (!data || typeof data !== 'object') return typeof data
  const counts = Object.entries(data)
    .filter(([, value]) => Array.isArray(value))
    .map(([key, value]) => `${key}=${value.length}`)
  return counts.length ? counts.join(', ') : `${Object.keys(data).length} fields`
}

async function checkResource(resource, params) {
  const endpoint = new URL(baseUrl)
  endpoint.searchParams.set('resource', resource)
  for (const [key, value] of Object.entries(params)) endpoint.searchParams.set(key, String(value))
  const started = performance.now()
  try {
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30_000) })
    const payload = await response.json().catch(() => undefined)
    const elapsed = Math.round(performance.now() - started)
    const sources = Array.isArray(payload?.sources)
      ? payload.sources.map(source => `${source.id}:${source.status}`).join(', ')
      : 'no source health'
    if (!response.ok || payload?.data === undefined) {
      return { ok: false, resource, detail: `HTTP ${response.status}; ${payload?.error || payload?.message || 'invalid response'}; ${sources}; ${elapsed}ms` }
    }
    if (metadataResources.has(resource)) {
      const metadata = payload?.metadata
      const valid = metadata
        && typeof metadata.sourceClass === 'string'
        && ['live', 'cached', 'stale', 'unknown'].includes(metadata.freshness)
        && typeof metadata.datasetVersion === 'string'
        && metadata.validity && typeof metadata.validity === 'object'
      if (!valid) return { ok: false, resource, detail: `HTTP ${response.status}; invalid normalized hazard metadata; ${elapsed}ms` }
    }
    return { ok: true, resource, detail: `${summarizeData(payload.data)}; ${sources}; ${elapsed}ms` }
  } catch (error) {
    return { ok: false, resource, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function checkTrafficTile() {
  const z = 12
  const lat = 14.5995
  const lng = 120.9842
  const scale = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * scale)
  const latitudeRadians = lat * Math.PI / 180
  const y = Math.floor((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale)
  const endpoint = new URL(baseUrl)
  for (const [key, value] of Object.entries({ resource: 'traffic-tile', z, x, y, style: 'relative0-dark' })) endpoint.searchParams.set(key, String(value))
  const started = performance.now()
  try {
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30_000) })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const elapsed = Math.round(performance.now() - started)
    const validImage = response.headers.get('content-type')?.startsWith('image/') && bytes.length > 8
    return validImage && response.ok
      ? { ok: true, resource: 'traffic-tile', detail: `${bytes.length} bytes; ${response.headers.get('x-kalasag-cache-state') || 'live'}; ${elapsed}ms` }
      : { ok: false, resource: 'traffic-tile', detail: `HTTP ${response.status}; invalid image response; ${elapsed}ms` }
  } catch (error) {
    return { ok: false, resource: 'traffic-tile', detail: error instanceof Error ? error.message : String(error) }
  }
}

const results = await Promise.all([
  ...checks.map(([resource, params]) => checkResource(resource, params)),
  checkTrafficTile(),
])
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.resource}: ${result.detail}`)

const failed = results.filter(result => !result.ok)
if (failed.length) {
  console.error(`${failed.length} live provider check(s) failed.`)
  process.exitCode = 1
} else {
  console.log(`All ${results.length} live-data resources passed through ${baseUrl.origin}.`)
}
