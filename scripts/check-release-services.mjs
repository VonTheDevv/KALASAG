import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { WebSocket } from 'ws'

const root = process.cwd()
const env = { ...process.env }

function loadEnvFile(name) {
  const filename = path.join(root, name)
  if (!fs.existsSync(filename)) return
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    env[match[1]] = value
  }
}

// Match Vite's production precedence: later files override earlier files.
for (const filename of ['.env', '.env.local', '.env.production', '.env.production.local']) loadEnvFile(filename)

function required(name) {
  const value = String(env[name] || '').trim()
  if (!value) throw new Error(`${name} is required for a complete APK release`)
  return value
}

function timeoutSignal(milliseconds) {
  return AbortSignal.timeout(milliseconds)
}

async function checkLiveData() {
  const supabaseUrl = required('VITE_SUPABASE_URL').replace(/\/$/, '')
  const anonKey = required('VITE_SUPABASE_ANON_KEY')
  const configured = String(env.VITE_LIVE_DATA_URL || '').trim()
  const endpoint = new URL(configured || `${supabaseUrl}/functions/v1/live-data`)
  if (endpoint.protocol !== 'https:') throw new Error('The production live-data gateway must use HTTPS')
  endpoint.searchParams.set('resource', 'weather')
  endpoint.searchParams.set('lat', '14.5995')
  endpoint.searchParams.set('lng', '120.9842')

  const response = await fetch(endpoint, {
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${anonKey}`,
      origin: 'https://localhost',
    },
    signal: timeoutSignal(20_000),
  })
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch { throw new Error(`Live-data gateway returned non-JSON HTTP ${response.status}`) }
  if (!response.ok) {
    const detail = payload?.code === 'NOT_FOUND'
      ? 'the live-data function has not been deployed'
      : String(payload?.message || payload?.error || `HTTP ${response.status}`)
    throw new Error(`Live-data gateway check failed: ${detail}`)
  }
  if (!payload || payload.data === undefined || !Array.isArray(payload.sources) || !payload.fetchedAt) {
    throw new Error('Live-data gateway returned an invalid response contract')
  }
  console.log(`PASS live-data gateway (${endpoint.origin})`)
}

async function checkAddressSearch() {
  const endpoint = new URL(required('VITE_ADDRESS_SEARCH_URL'))
  if (endpoint.protocol !== 'https:') throw new Error('The production address-search gateway must use HTTPS')
  endpoint.searchParams.set('q', 'SM City Valenzuela')
  endpoint.searchParams.set('countrycode', 'PH')
  endpoint.searchParams.set('bbox', '116,4.5,127.5,21.5')
  endpoint.searchParams.set('lang', 'en')
  endpoint.searchParams.set('limit', '3')

  const response = await fetch(endpoint, {
    headers: { accept: 'application/json', origin: 'https://localhost' },
    signal: timeoutSignal(12_000),
  })
  const payload = await response.json().catch(() => null)
  const features = Array.isArray(payload?.features) ? payload.features : []
  const validResult = features.some(feature => {
    const properties = feature?.properties
    return properties?.countrycode === 'PH'
      && typeof properties.city === 'string'
      && typeof properties.postcode === 'string'
  })
  if (!response.ok || !validResult) {
    throw new Error(`Address-search gateway check failed: HTTP ${response.status}`)
  }
  console.log(`PASS Philippine address-search gateway (${endpoint.origin})`)
}

async function checkAisRelay() {
  const supabaseUrl = required('VITE_SUPABASE_URL').replace(/\/$/, '')
  const configured = String(env.VITE_AIS_RELAY_URL || '').trim()
  const endpoint = new URL(configured || `${supabaseUrl}/functions/v1/ais-relay`)
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:'
  if (endpoint.protocol !== 'wss:') throw new Error('The production AIS relay must use WSS')

  const healthUrl = new URL(endpoint)
  healthUrl.protocol = 'https:'
  if (configured && !healthUrl.pathname.includes('/functions/v1/ais-relay')) healthUrl.pathname = '/healthz'
  const response = await fetch(healthUrl, {
    headers: { origin: 'https://localhost' },
    signal: timeoutSignal(15_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true) {
    const missing = response.status === 404 ? 'the ais-relay function has not been deployed' : `HTTP ${response.status}`
    throw new Error(`AIS relay health check failed: ${missing}`)
  }

  // A normal HTTP health response cannot detect hosted WebSocket upgrade
  // failures. Upgrade without credentials, then close before the auth timeout.
  await new Promise((resolve, reject) => {
    let settled = false
    const socket = new WebSocket(endpoint, { origin: 'https://localhost', handshakeTimeout: 12_000 })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.terminate()
      reject(new Error('AIS relay WebSocket upgrade timed out'))
    }, 15_000)
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    socket.once('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close(1000, 'Release preflight complete')
      resolve()
    })
    socket.once('unexpected-response', (_request, upgradeResponse) => {
      upgradeResponse.resume()
      fail(new Error(`AIS relay WebSocket upgrade returned HTTP ${upgradeResponse.statusCode}`))
    })
    socket.once('error', error => fail(new Error(`AIS relay WebSocket upgrade failed: ${error.message}`)))
  })
  console.log(`PASS authenticated AIS relay health and WebSocket upgrade (${endpoint.origin})`)
}

try {
  await checkLiveData()
  await checkAddressSearch()
  await checkAisRelay()
  console.log('Release services are reachable. The APK can be built without known live-service omissions.')
} catch (error) {
  console.error(`RELEASE BLOCKED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
