import process from 'node:process'

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '')
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const dispatchIntervalMs = boundedInteger(process.env.FAMILY_ALERT_DISPATCH_INTERVAL_MS, 3_000, 1_000, 60_000)
const requestTimeoutMs = boundedInteger(process.env.FAMILY_ALERT_DISPATCH_TIMEOUT_MS, 20_000, 5_000, 60_000)
const batchSize = boundedInteger(process.env.FAMILY_ALERT_DISPATCH_BATCH_SIZE, 50, 1, 50)
const maxBackoffMs = 60_000

let stopped = false
let failureCount = 0

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.max(minimum, Math.min(maximum, number))
}

function validateConfiguration() {
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }

  const parsed = new URL(supabaseUrl)
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !local) {
    throw new Error('SUPABASE_URL must use HTTPS outside local development')
  }
}

function delay(milliseconds) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

async function dispatchOnce() {
  const response = await fetch(`${supabaseUrl}/functions/v1/family-alert-dispatch`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'content-type': 'application/json',
      'user-agent': 'kalasag-family-alert-worker/1',
    },
    body: JSON.stringify({ batchSize }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  })

  const responseText = await response.text()
  let result = null
  try {
    result = responseText ? JSON.parse(responseText) : null
  } catch {
    // Do not copy arbitrary upstream response bodies into production logs.
  }

  if (!response.ok) {
    throw new Error(`dispatcher returned HTTP ${response.status}`)
  }

  return result && typeof result === 'object' ? result : {}
}

async function run() {
  validateConfiguration()
  console.log(`Family alert worker started; interval=${dispatchIntervalMs}ms batch=${batchSize}`)

  while (!stopped) {
    try {
      const result = await dispatchOnce()
      failureCount = 0

      const claimed = Number(result.claimed) || 0
      const retrying = Number(result.retrying) || 0
      const dead = Number(result.dead) || 0
      if (claimed > 0) {
        console.log(`Family alert dispatch completed; claimed=${claimed} retrying=${retrying} dead=${dead}`)
      }

      // Drain a full batch immediately; otherwise poll at the configured
      // interval so newly committed danger alerts have bounded server latency.
      if (claimed < batchSize) await delay(dispatchIntervalMs)
    } catch (error) {
      failureCount += 1
      const backoffMs = Math.min(maxBackoffMs, dispatchIntervalMs * 2 ** Math.min(failureCount, 5))
      const message = error instanceof Error ? error.message : 'unknown error'
      console.error(`Family alert dispatcher unavailable; retrying in ${backoffMs}ms (${message})`)
      await delay(backoffMs)
    }
  }

  console.log('Family alert worker stopped')
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopped = true
  })
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : 'Family alert worker failed to start')
  process.exitCode = 1
})
