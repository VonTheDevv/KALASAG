// Server-only FCM dispatcher for family safety notifications.
//
// Required secrets:
//   SUPABASE_URL                    (provided by hosted Edge Functions)
//   SUPABASE_SERVICE_ROLE_KEY       (provided by hosted Edge Functions)
//   FIREBASE_SERVICE_ACCOUNT_JSON  (Firebase service-account JSON, one line)
//
// Trusted automation may invoke with the service role. An authenticated client
// may also issue a bounded post-commit "kick" to reduce alert latency. No
// Firebase credential, device token, or queue payload is returned to clients.

import { createClient } from 'npm:@supabase/supabase-js@2.110.7'
import { JWT } from 'npm:google-auth-library@10.9.0'

type JsonRecord = Record<string, unknown>

type PushDevice = {
  id: string
  deliveryId: string
  token: string
  platform: string
}

type OutboxJob = {
  job_id: string
  lease_token: string
  event_type: 'driving_started' | 'family_danger' | 'family_alert_resolved'
  event_id: string
  family_id: string
  recipient_user_id: string
  payload: JsonRecord
  device_tokens: PushDevice[]
}

type FirebaseServiceAccount = {
  project_id: string
  client_email: string
  private_key: string
}

type DeliveryResult = {
  ok: boolean
  providerMessageId?: string
  deliveryId: string
  tokenId: string
  permanent: boolean
  invalidToken: boolean
  error?: string
}

const supabaseUrl = String(Deno.env.get('SUPABASE_URL') ?? '').trim().replace(/\/$/, '')
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim()
const firebaseAccountRaw = String(Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON') ?? '').trim()
const publicApiKey = defaultNamedKey('SUPABASE_PUBLISHABLE_KEYS')
  || String(Deno.env.get('SUPABASE_ANON_KEY') ?? '').trim()
const MAX_BODY_BYTES = 1024
const DEFAULT_BATCH_SIZE = 25
const MAX_BATCH_SIZE = 50
const JOB_CONCURRENCY = 4
const callerWindows = new Map<string, { count: number; resetsAt: number }>()
const allowedOrigins = new Set([
  'https://localhost',
  'https://localhost:5173',
  'capacitor://localhost',
  ...String(Deno.env.get('FAMILY_ALERT_ALLOWED_ORIGINS')
    ?? Deno.env.get('LIVE_DATA_ALLOWED_ORIGINS')
    ?? '').split(','),
].map(value => value.trim().replace(/\/$/, '')).filter(Boolean))

function defaultNamedKey(variable: string) {
  try {
    const keys = JSON.parse(Deno.env.get(variable) ?? '{}') as Record<string, unknown>
    return typeof keys.default === 'string' ? keys.default.trim() : ''
  } catch {
    return ''
  }
}

function response(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store, max-age=0',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  })
}

function originAllowed(origin: string | null) {
  return !origin || allowedOrigins.has(origin.replace(/\/$/, ''))
}

function withCors(result: Response, origin: string | null) {
  if (!origin) return result
  const headers = new Headers(result.headers)
  headers.set('access-control-allow-origin', origin)
  headers.set('access-control-allow-methods', 'POST, OPTIONS')
  headers.set('access-control-allow-headers', 'authorization, x-client-info, apikey, content-type')
  headers.set('vary', 'Origin')
  return new Response(result.body, {
    status: result.status,
    statusText: result.statusText,
    headers,
  })
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function scalarString(value: unknown, maxLength = 500) {
  if (typeof value === 'string') return value.slice(0, maxLength)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return ''
}

async function constantTimeEqual(left: string, right: string) {
  if (!left || !right) return false
  const encoder = new TextEncoder()
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ])
  const a = new Uint8Array(leftHash)
  const b = new Uint8Array(rightHash)
  let difference = a.length ^ b.length
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    difference |= a[index] ^ b[index]
  }
  return difference === 0
}

async function authenticateCaller(bearer: string) {
  if (await constantTimeEqual(bearer, serviceRoleKey)) {
    return { trustedScheduler: true, callerId: 'service-role' }
  }
  if (!bearer || !publicApiKey) return null

  try {
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: publicApiKey, authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(7_000),
    })
    if (!authResponse.ok) return null
    const user = asRecord(await authResponse.json())
    const id = boundedString(user?.id, 100)
    return id ? { trustedScheduler: false, callerId: id } : null
  } catch {
    return null
  }
}

function allowAuthenticatedKick(callerId: string) {
  const now = Date.now()
  let window = callerWindows.get(callerId)
  if (!window || window.resetsAt <= now) window = { count: 0, resetsAt: now + 60_000 }
  window.count += 1
  callerWindows.delete(callerId)
  callerWindows.set(callerId, window)
  while (callerWindows.size > 2_048) {
    const oldest = callerWindows.keys().next().value
    if (oldest === undefined) break
    callerWindows.delete(oldest)
  }
  return window.count <= 12
}

function parseFirebaseAccount(): FirebaseServiceAccount | null {
  try {
    const value = asRecord(JSON.parse(firebaseAccountRaw))
    if (!value) return null
    const projectId = boundedString(value.project_id, 200)
    const clientEmail = boundedString(value.client_email, 320)
    const privateKey = typeof value.private_key === 'string'
      ? value.private_key.replace(/\\n/g, '\n').trim()
      : ''
    if (!projectId || !clientEmail || !privateKey.includes('BEGIN PRIVATE KEY')) return null
    return { project_id: projectId, client_email: clientEmail, private_key: privateKey }
  } catch {
    return null
  }
}

async function getFirebaseAccessToken(account: FirebaseServiceAccount) {
  const client = new JWT({
    email: account.client_email,
    key: account.private_key,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  })
  const credentials = await client.authorize()
  const token = credentials.access_token
  if (!token) throw new Error('Firebase OAuth did not return an access token')
  return token
}

function notificationCopy(job: OutboxJob) {
  const actor = boundedString(job.payload.actor_name, 80) || 'A family member'
  const reason = boundedString(job.payload.reason, 180)
  const address = boundedString(job.payload.address_label, 140)
  const alertActorId = boundedString(
    job.payload.triggered_by ?? job.payload.resolved_by ?? job.payload.user_id,
    80,
  ) || job.event_id
  // Material re-alerts have distinct database IDs, but the Android tray should
  // show only this member's latest emergency state within the family.
  const familyAlertTag = `family-alert-${job.family_id}-${alertActorId}`

  if (job.event_type === 'family_danger') {
    const urgent = job.payload.urgency === 'urgent_authorities'
    const detail = [reason, address].filter(Boolean).join(' • ').slice(0, 300)
    return {
      title: urgent ? `URGENT: ${actor} needs authorities` : `${actor} needs help`,
      body: detail || 'Open KALASAG to view the latest emergency location.',
      channelId: 'family_danger',
      // Android 8+ takes the actual alarm sound from the immutable channel;
      // use a valid fallback instead of naming an unbundled raw resource.
      sound: 'default',
      priority: 'HIGH',
      // Keep an unresolved emergency deliverable across extended offline or
      // unused periods. The Android monotonic sequence guard rejects it if a
      // newer resolution/generation reached the device first.
      ttl: '2419200s',
      tag: familyAlertTag,
    }
  }

  if (job.event_type === 'family_alert_resolved') {
    return {
      title: `${actor}'s alert was resolved`,
      body: boundedString(job.payload.resolution_note, 220) || 'The family safety alert is no longer active.',
      channelId: 'family_activity',
      sound: 'default',
      // Resolution must wake promptly enough to stop a stale emergency alarm.
      // Android still renders it on the non-alarming activity channel.
      priority: 'HIGH',
      ttl: '2419200s',
      tag: familyAlertTag,
    }
  }

  return {
    title: `${actor} started driving`,
    body: 'Live family location sharing is active.',
    channelId: 'family_activity',
    sound: 'default',
    priority: 'NORMAL',
    ttl: '3600s',
    tag: `family-driving-${job.event_id}`,
  }
}

function notificationData(job: OutboxJob) {
  const allowedKeys = [
    'type',
    'alert_id',
    'session_id',
    'family_id',
    'triggered_by',
    'user_id',
    'actor_name',
    'source',
    'urgency',
    'reason',
    'latitude',
    'longitude',
    'accuracy_m',
    'heading_deg',
    'speed_mps',
    'location_recorded_at',
    'recorded_at',
    'address_label',
    'created_at',
    'updated_at',
    'resolved_at',
    'resolution_note',
    'display_key',
    'display_sequence',
  ]
  const data: Record<string, string> = {
    event_type: job.event_type,
    event_id: job.event_id,
    family_id: job.family_id,
    route: job.event_type === 'family_danger' && job.payload.urgency === 'urgent_authorities'
      ? 'hotlines'
      : 'family',
  }
  for (const key of allowedKeys) {
    const value = scalarString(job.payload[key], key === 'reason' || key === 'address_label' ? 500 : 200)
    if (value) data[key] = value
  }
  return data
}

function fcmErrorDetails(value: unknown) {
  const root = asRecord(value)
  const error = asRecord(root?.error)
  const details = Array.isArray(error?.details) ? error.details : []
  const detailCodes = details
    .map(detail => boundedString(asRecord(detail)?.errorCode, 100))
    .filter(Boolean)
  return {
    status: boundedString(error?.status, 100),
    message: boundedString(error?.message, 500),
    detailCodes,
  }
}

async function sendToDevice(
  account: FirebaseServiceAccount,
  accessToken: string,
  job: OutboxJob,
  device: PushDevice,
): Promise<DeliveryResult> {
  if (device.platform !== 'android') {
    return {
      ok: false,
      deliveryId: device.deliveryId,
      tokenId: device.id,
      permanent: true,
      invalidToken: false,
      error: `Unsupported push platform: ${device.platform}`,
    }
  }

  const copy = notificationCopy(job)
  const data = {
    ...notificationData(job),
    notification_title: copy.title,
    notification_body: copy.body,
    notification_channel: copy.channelId,
    notification_tag: copy.tag,
    notification_priority: copy.priority,
  }
  const directBootEligible = job.event_type !== 'driving_started'
  const request = {
    message: {
      token: device.token,
      // Data-only delivery is intentional. KALASAG's Android service applies a
      // persisted display-sequence guard before showing anything, so an older
      // FCM message can never overwrite a newer emergency state.
      data,
      android: {
        priority: copy.priority.toLowerCase(),
        ttl: copy.ttl,
        // Family danger and resolution updates remain eligible immediately
        // after reboot, before the user's first unlock. The Android service
        // uses device-protected sequence state and private lock-screen text.
        direct_boot_ok: directBootEligible,
        // A late, timed-out worker can submit an older emergency generation
        // after its successor. Collapsing family state at FCM could discard
        // that successor; deliver both and let Android's persisted sequence
        // guard choose the authoritative state.
        ...(job.event_type === 'driving_started' ? { collapse_key: copy.tag } : {}),
      },
    },
  }

  let fetchResponse: Response
  try {
    fetchResponse = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(10_000),
      },
    )
  } catch (error) {
    return {
      ok: false,
      deliveryId: device.deliveryId,
      tokenId: device.id,
      permanent: false,
      invalidToken: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'FCM request failed',
    }
  }

  let result: unknown = null
  try {
    result = await fetchResponse.json()
  } catch {
    // A bounded generic error below is safer than echoing an upstream body.
  }

  if (fetchResponse.ok) {
    return {
      ok: true,
      deliveryId: device.deliveryId,
      tokenId: device.id,
      permanent: false,
      invalidToken: false,
      providerMessageId: boundedString(asRecord(result)?.name, 500),
    }
  }

  const details = fcmErrorDetails(result)
  const invalidToken = details.status === 'UNREGISTERED'
    || details.detailCodes.includes('UNREGISTERED')
    || details.detailCodes.includes('SENDER_ID_MISMATCH')
  const transient = fetchResponse.status === 408
    || fetchResponse.status === 429
    || fetchResponse.status >= 500
    || details.status === 'UNAVAILABLE'
    || details.status === 'INTERNAL'
    || details.status === 'RESOURCE_EXHAUSTED'

  return {
    ok: false,
    deliveryId: device.deliveryId,
    tokenId: device.id,
    permanent: invalidToken || !transient,
    invalidToken,
    error: `${details.status || `HTTP ${fetchResponse.status}`}: ${details.message || 'FCM rejected the message'}`
      .slice(0, 700),
  }
}

function normalizeJobs(value: unknown): OutboxJob[] {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    const row = asRecord(item)
    const payload = asRecord(row?.payload)
    const rawDevices = Array.isArray(row?.device_tokens) ? row.device_tokens : []
    if (!row || !payload) {
      throw new Error(`Notification claim ${index} is malformed`)
    }
    const displayKey = boundedString(payload.display_key, 220)
    const displaySequence = scalarString(payload.display_sequence, 30)
    if (!displayKey || !/^[1-9]\d*$/.test(displaySequence)) {
      throw new Error(`Notification claim ${index} has no ordered-display protocol`)
    }
    const devices = rawDevices.map((raw, deviceIndex) => {
      const device = asRecord(raw)
      const id = boundedString(device?.id, 100)
      const deliveryId = boundedString(device?.delivery_id, 100)
      const token = boundedString(device?.token, 4096)
      const platform = boundedString(device?.platform, 20)
      if (!id || !deliveryId || !token || !platform) {
        throw new Error(`Notification claim ${index} device ${deviceIndex} is malformed`)
      }
      return { id, deliveryId, token, platform }
    })
    const job: OutboxJob = {
      job_id: boundedString(row.job_id, 100),
      lease_token: boundedString(row.lease_token, 100),
      event_type: row.event_type as OutboxJob['event_type'],
      event_id: boundedString(row.event_id, 100),
      family_id: boundedString(row.family_id, 100),
      recipient_user_id: boundedString(row.recipient_user_id, 100),
      payload,
      device_tokens: devices,
    }
    if (
      !job.job_id
      || !job.lease_token
      || !job.event_id
      || !job.family_id
      || !job.recipient_user_id
      || !['driving_started', 'family_danger', 'family_alert_resolved'].includes(job.event_type)
    ) {
      throw new Error(`Notification claim ${index} has invalid identity fields`)
    }
    return job
  })
}

Deno.serve(async request => {
  const origin = request.headers.get('origin')
  if (!originAllowed(origin)) return response({ error: 'Request origin is not allowed' }, 403)
  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), origin)
  }
  const reply = (body: unknown, status: number) => withCors(response(body, status), origin)

  if (request.method !== 'POST') {
    return reply({ error: 'Method not allowed' }, 405)
  }
  if (!supabaseUrl || !serviceRoleKey || !firebaseAccountRaw) {
    return reply({ error: 'Dispatcher is not configured' }, 503)
  }

  const authorization = request.headers.get('authorization') ?? ''
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  const caller = await authenticateCaller(bearer)
  if (!caller) {
    return reply({ error: 'Unauthorized' }, 401)
  }
  if (!caller.trustedScheduler && !allowAuthenticatedKick(caller.callerId)) {
    return reply({ error: 'Too many dispatch requests' }, 429)
  }

  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return reply({ error: 'Request body is too large' }, 413)
  }

  let batchSize = DEFAULT_BATCH_SIZE
  try {
    const rawBody = await request.text()
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return reply({ error: 'Request body is too large' }, 413)
    }
    if (rawBody) {
      const body = asRecord(JSON.parse(rawBody))
      const requested = Number(body?.batchSize)
      if (Number.isInteger(requested)) {
        batchSize = Math.max(
          1,
          Math.min(caller.trustedScheduler ? MAX_BATCH_SIZE : 10, requested),
        )
      }
    }
  } catch {
    return reply({ error: 'Invalid JSON body' }, 400)
  }

  const account = parseFirebaseAccount()
  if (!account) return reply({ error: 'Firebase credentials are invalid' }, 503)

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // v3 is the ordered-display protocol boundary. Fail closed if the database
  // has not been migrated: data-only FCM payloads must never be emitted
  // without persisted display-key and display-sequence guarantees.
  const perDeviceClaim = await supabase.rpc('claim_family_notification_deliveries_v3', {
    p_limit: batchSize,
  })
  const claimData: unknown = perDeviceClaim.data
  const claimError = perDeviceClaim.error

  if (claimError) {
    console.error('Unable to claim family notification jobs', claimError.code)
    return reply({ error: 'Unable to claim notification jobs' }, 500)
  }

  let jobs: OutboxJob[]
  try {
    jobs = normalizeJobs(claimData)
  } catch (claimValidationError) {
    console.error(
      'Family notification claim failed validation',
      claimValidationError instanceof Error ? claimValidationError.message : 'unknown',
    )
    return reply({ error: 'Notification claim failed validation' }, 500)
  }
  if (jobs.length === 0) {
    return reply(
      caller.trustedScheduler
        ? { ok: true, claimed: 0, sent: 0, retrying: 0, dead: 0 }
        : { ok: true, processed: false },
      200,
    )
  }

  let accessToken: string
  try {
    accessToken = await getFirebaseAccessToken(account)
  } catch (oauthError) {
    console.error('Unable to authorize Firebase dispatcher', oauthError instanceof Error ? oauthError.message : 'unknown')
    // Do not complete leases. The five-minute lease recovery safely retries all
    // claimed jobs after a transient OAuth/configuration outage.
    return reply(
      caller.trustedScheduler
        ? { error: 'Unable to authorize notification provider', claimed: jobs.length }
        : { error: 'Notification delivery is temporarily unavailable' },
      503,
    )
  }

  let sent = 0
  let retrying = 0
  let dead = 0

  const processJob = async (job: OutboxJob) => {
    // The database serializes jobs with the same family/member display key.
    // Re-check the leased generation immediately before FCM so a superseded
    // payload already held by this worker cannot overtake its replacement.
    const currentJob = await supabase.rpc('is_family_notification_job_current', {
      p_job_id: job.job_id,
      p_lease_token: job.lease_token,
    })
    if (currentJob.error) throw currentJob.error

    const results = currentJob.data === true
      ? await Promise.all(
          job.device_tokens.map(device => sendToDevice(account, accessToken, job, device)),
        )
      : job.device_tokens.map(device => ({
          ok: false,
          deliveryId: device.deliveryId,
          tokenId: device.id,
          permanent: true,
          invalidToken: false,
          error: 'Superseded notification was not sent',
        }))
    for (const result of results) {
      if (!result.invalidToken) continue
      const { error: disableError } = await supabase.rpc('disable_family_push_token', {
        p_token_id: result.tokenId,
      })
      if (disableError) console.error('Unable to disable invalid push token', disableError.code)
    }

    const perDeviceCompletion = await supabase.rpc('complete_family_notification_deliveries', {
      p_job_id: job.job_id,
      p_lease_token: job.lease_token,
      p_results: results.map(result => ({
        delivery_id: result.deliveryId,
        success: result.ok,
        permanent: result.permanent,
        provider_message_id: result.providerMessageId ?? null,
        error: result.error ?? null,
      })),
    })
    if (perDeviceCompletion.error) throw perDeviceCompletion.error
    const completionStatus = typeof perDeviceCompletion.data === 'string'
      ? perDeviceCompletion.data
      : ''

    if (completionStatus === 'sent') sent += 1
    else if (completionStatus === 'retry') retrying += 1
    else if (completionStatus === 'dead') dead += 1
    else throw new Error('Notification completion returned an invalid status')
  }

  try {
    for (let offset = 0; offset < jobs.length; offset += JOB_CONCURRENCY) {
      await Promise.all(jobs.slice(offset, offset + JOB_CONCURRENCY).map(processJob))
    }
  } catch (dispatchError) {
    console.error('Family notification dispatch failed', dispatchError instanceof Error ? dispatchError.message : 'unknown')
    return reply(
      caller.trustedScheduler
        ? {
            error: 'One or more notification jobs could not be finalized',
            claimed: jobs.length,
            sent,
            retrying,
            dead,
          }
        : { error: 'Notification delivery is temporarily unavailable' },
      500,
    )
  }

  return reply(
    caller.trustedScheduler
      ? { ok: true, claimed: jobs.length, sent, retrying, dead }
      : { ok: true, processed: true },
    200,
  )
})
