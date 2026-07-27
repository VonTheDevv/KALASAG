import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from './supabase'

export type FamilySafetyStatus = 'safe' | 'unknown' | 'in_danger'
export type FamilyAlertUrgency = 'need_help' | 'urgent_authorities'
export type FamilyAlertSource = 'safety_status' | 'driving'

export interface FamilyDrivingSession {
  id: string
  family_id: string
  user_id: string
  status: 'active' | 'ended'
  started_at: string
  ended_at: string | null
  last_location_at: string | null
}

export interface FamilyLiveLocation {
  family_id: string
  user_id: string
  session_id: string
  latitude: number
  longitude: number
  accuracy_m: number | null
  heading_deg: number | null
  speed_mps: number | null
  recorded_at: string
  received_at: string
  address_label: string | null
}

export interface FamilyAlert {
  id: string
  family_id: string
  reporter_user_id: string
  source: FamilyAlertSource
  urgency: FamilyAlertUrgency
  reason: string
  latitude: number | null
  longitude: number | null
  accuracy_m: number | null
  address_label: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
  resolved_by: string | null
}

export interface FamilySafetySnapshot {
  sessions: FamilyDrivingSession[]
  locations: FamilyLiveLocation[]
  alerts: FamilyAlert[]
}

export interface LocationPayload {
  latitude: number
  longitude: number
  accuracyM?: number | null
  headingDeg?: number | null
  speedMps?: number | null
  recordedAt?: string
  addressLabel?: string | null
}

export interface StartedDrivingSession {
  sessionId: string
  trackingToken: string
  expiresAt: string | null
}

type StartDrivingRow = {
  session_id?: unknown
  tracking_token?: unknown
  tracking_expires_at?: unknown
}

function firstRpcRow<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T | undefined) ?? null
  if (value && typeof value === 'object') return value as T
  return null
}

function numberOrNull(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function kickFamilyAlertDispatch(): Promise<void> {
  const invoke = async () => {
    try {
      await Promise.race([
        supabase.functions.invoke('family-alert-dispatch', { body: { batchSize: 10 } }),
        new Promise<void>(resolve => window.setTimeout(resolve, 2_500)),
      ])
    } catch {
      // The durable outbox remains available to the VPS worker. A dispatch
      // kick must never turn a committed safety action into a visible failure.
    }
  }

  await invoke()
  // A replacement/resolution waits behind an already leased notification for
  // the same member. Bounded follow-up kicks flush that ordered successor even
  // before the production VPS worker performs its next poll.
  window.setTimeout(() => { void invoke() }, 3_500)
  window.setTimeout(() => { void invoke() }, 12_000)
}

export async function loadFamilySafetySnapshot(familyId: string): Promise<FamilySafetySnapshot> {
  const [sessionsResult, locationsResult, alertsResult] = await Promise.all([
    supabase
      .from('family_driving_sessions')
      .select('id, family_id, user_id, status, started_at, ended_at, last_location_at')
      .eq('family_id', familyId)
      .eq('status', 'active')
      .order('started_at', { ascending: false }),
    supabase
      .from('family_live_locations')
      .select('family_id, user_id, session_id, latitude, longitude, accuracy_m, heading_deg, speed_mps, recorded_at, received_at, address_label')
      .eq('family_id', familyId),
    supabase
      .from('family_alerts')
      .select('id, family_id, reporter_user_id:triggered_by, source, urgency, reason, latitude, longitude, accuracy_m, address_label, created_at, updated_at, resolved_at, resolved_by')
      .eq('family_id', familyId)
      .is('resolved_at', null)
      .order('created_at', { ascending: false }),
  ])

  const failure = sessionsResult.error || locationsResult.error || alertsResult.error
  if (failure) throw failure

  return {
    sessions: (sessionsResult.data ?? []) as FamilyDrivingSession[],
    locations: (locationsResult.data ?? []) as FamilyLiveLocation[],
    alerts: (alertsResult.data ?? []) as FamilyAlert[],
  }
}

export async function startFamilyDriving(
  familyId: string,
  clientEventId: string = crypto.randomUUID(),
): Promise<StartedDrivingSession> {
  const { data, error } = await supabase.rpc('start_family_driving', {
    p_family_id: familyId,
    p_client_event_id: clientEventId,
  })
  if (error) throw error

  const row = firstRpcRow<StartDrivingRow>(data)
  const sessionId = typeof row?.session_id === 'string' ? row.session_id : ''
  const trackingToken = typeof row?.tracking_token === 'string' ? row.tracking_token : ''
  if (!sessionId || !trackingToken) throw new Error('Driving mode started without a usable tracking session.')

  void kickFamilyAlertDispatch()

  return {
    sessionId,
    trackingToken,
    expiresAt: typeof row?.tracking_expires_at === 'string' ? row.tracking_expires_at : null,
  }
}

export async function updateDrivingLocationWithToken(
  sessionId: string,
  trackingToken: string,
  location: LocationPayload,
): Promise<void> {
  const { error } = await supabase.rpc('update_family_driving_location_with_token', {
    p_session_id: sessionId,
    p_tracking_token: trackingToken,
    p_latitude: location.latitude,
    p_longitude: location.longitude,
    p_accuracy_m: numberOrNull(location.accuracyM),
    p_heading_deg: numberOrNull(location.headingDeg),
    p_speed_mps: numberOrNull(location.speedMps),
    p_recorded_at: location.recordedAt ?? new Date().toISOString(),
    p_address_label: location.addressLabel ?? null,
  })
  if (error) throw error
}

export async function stopFamilyDriving(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('stop_family_driving', { p_session_id: sessionId })
  if (error) throw error
}

export interface FamilyDrivingSignOutCleanup {
  stoppedSessionIds: string[]
  pendingSessionIds: string[]
}

/**
 * Ends every active session owned by the account while its authenticated
 * session is still available. A native capability session can be supplied in
 * case the foreground service has already hidden it from the active-session
 * query by winning the revocation race.
 */
export async function stopMyFamilyDrivingForSignOut(
  userId: string,
  nativeSessionId?: string,
): Promise<FamilyDrivingSignOutCleanup> {
  const { data, error } = await supabase
    .from('family_driving_sessions')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'active')

  const sessionIds = new Set<string>()
  if (!error) {
    for (const row of data ?? []) {
      if (typeof row.id === 'string') sessionIds.add(row.id)
    }
  }
  if (nativeSessionId) sessionIds.add(nativeSessionId)

  const stoppedSessionIds: string[] = []
  const pendingSessionIds: string[] = []
  for (const sessionId of sessionIds) {
    const { error: stopError } = await supabase.rpc('stop_family_driving', {
      p_session_id: sessionId,
    })
    if (!stopError) {
      stoppedSessionIds.push(sessionId)
      continue
    }

    // The native capability endpoint may have ended the same session first.
    // Confirm that it is no longer active before treating that race as success.
    const { data: activeSession, error: verifyError } = await supabase
      .from('family_driving_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle()
    if (!verifyError && !activeSession) stoppedSessionIds.push(sessionId)
    else pendingSessionIds.push(sessionId)
  }

  if (error && sessionIds.size === 0) {
    // The query itself failed, so the caller must not report remote cleanup as
    // complete. Local tracking still stops and native revocation remains durable.
    return { stoppedSessionIds, pendingSessionIds: ['unknown'] }
  }
  return { stoppedSessionIds, pendingSessionIds }
}

export async function setMyFamilySafetyV2(
  familyId: string,
  status: FamilySafetyStatus,
  options: {
    reason?: string
    urgency?: FamilyAlertUrgency
    source?: FamilyAlertSource
    location?: LocationPayload | null
    clientEventId?: string
  } = {},
): Promise<void> {
  const location = options.location
  const { error } = await supabase.rpc('set_my_family_safety_v2', {
    p_family_id: familyId,
    p_safety_status: status,
    p_reason: options.reason?.trim() || null,
    p_urgency: options.urgency ?? null,
    p_source: options.source ?? 'safety_status',
    p_latitude: location?.latitude ?? null,
    p_longitude: location?.longitude ?? null,
    p_accuracy_m: numberOrNull(location?.accuracyM),
    p_heading_deg: numberOrNull(location?.headingDeg),
    p_speed_mps: numberOrNull(location?.speedMps),
    p_recorded_at: location?.recordedAt ?? null,
    p_address_label: location?.addressLabel ?? null,
    p_client_event_id: options.clientEventId ?? crypto.randomUUID(),
  })
  if (error) throw error
  void kickFamilyAlertDispatch()
}

export async function acknowledgeFamilyAlert(alertId: string, alertUpdatedAt: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('acknowledge_family_alert_v2', {
    p_alert_id: alertId,
    p_alert_updated_at: alertUpdatedAt,
  })
  if (error) throw error
  return data === true
}

export async function loadMyUnacknowledgedFamilyAlerts(limit = 100): Promise<FamilyAlert[]> {
  const { data, error } = await supabase.rpc('list_my_unacknowledged_family_alerts', {
    p_limit: Math.max(1, Math.min(100, Math.trunc(limit))),
  })
  if (error) throw error
  return (data ?? []) as FamilyAlert[]
}

export async function removeFamilyMember(memberId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_family_member_v2', {
    p_member_id: memberId,
  })
  if (error) throw error
}

export async function resolveMyFamilyAlert(alertId: string): Promise<void> {
  const { error } = await supabase.rpc('resolve_my_family_alert', { p_alert_id: alertId })
  if (error) throw error
  void kickFamilyAlertDispatch()
}

export function subscribeToFamilySafety(familyId: string, onChange: () => void): RealtimeChannel {
  return supabase
    .channel(`family:${familyId}:safety`, { config: { private: true } })
    .on('broadcast', { event: '*' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'family_driving_sessions', filter: `family_id=eq.${familyId}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'family_live_locations', filter: `family_id=eq.${familyId}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'family_alerts', filter: `family_id=eq.${familyId}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'family_members', filter: `family_id=eq.${familyId}` }, onChange)
    .subscribe()
}

export function removeFamilySafetyChannel(channel: RealtimeChannel) {
  return supabase.removeChannel(channel)
}
