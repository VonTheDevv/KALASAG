import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { BellRing, Check, MapPin, Phone, Users, X } from 'lucide-react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import type { TabId } from '../App'
import { useAuth } from './useAuth'
import { supabase } from '../lib/supabase'
import { reverseGeocodeCoordinates } from '../lib/reverseGeocode'
import {
  acknowledgeFamilyAlert,
  kickFamilyAlertDispatch,
  loadMyUnacknowledgedFamilyAlerts,
  removeFamilySafetyChannel,
  subscribeToFamilySafety,
  type FamilyAlert,
} from '../lib/familySafety'
import { startAlarmSiren, stopAlarmSiren } from '../utils/audioAlarm'
import {
  cancelFamilyDangerNotification,
  getOrCreateFamilyPushInstallationId,
  initializePushNotifications,
  showFamilyDangerNotification,
} from '../lib/pushNotifications'
import { Button, IconButton } from '../components/ui/primitives'
import { FamilySafetyContext } from './familySafetyContext'

type FamilySummary = {
  family_id: string
  role: 'host' | 'member'
  member_status: 'pending' | 'approved'
}

type FamilyMemberName = {
  user_id: string
  first_name: string
}

function alertMapsUrl(alert: FamilyAlert) {
  if (alert.latitude === null || alert.longitude === null) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${alert.latitude},${alert.longitude}`)}`
}

const PENDING_ACKNOWLEDGEMENT_PREFIX = 'kalasag_pending_family_acknowledgements:'
const MAX_PENDING_ACKNOWLEDGEMENTS = 50
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function loadPendingAcknowledgements(userId: string): Map<string, string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`${PENDING_ACKNOWLEDGEMENT_PREFIX}${userId}`) ?? '[]')
    if (!Array.isArray(value)) return new Map()
    const entries = value
      .filter((item): item is { id: string; updatedAt: string } => Boolean(
        item
          && typeof item === 'object'
          && typeof (item as { id?: unknown }).id === 'string'
          && UUID_PATTERN.test((item as { id: string }).id)
          && typeof (item as { updatedAt?: unknown }).updatedAt === 'string'
          && Number.isFinite(Date.parse((item as { updatedAt: string }).updatedAt)),
      ))
      .slice(-MAX_PENDING_ACKNOWLEDGEMENTS)
      .map(item => [item.id, item.updatedAt] as const)
    // Legacy ID-only entries are intentionally ignored. Replaying an
    // acknowledgement without its alert version could suppress a newer
    // escalation that reused the same durable alert ID.
    return new Map(entries)
  } catch {
    return new Map()
  }
}

function persistPendingAcknowledgements(userId: string, acknowledgements: Map<string, string>): void {
  try {
    const key = `${PENDING_ACKNOWLEDGEMENT_PREFIX}${userId}`
    const bounded = [...acknowledgements.entries()]
      .slice(-MAX_PENDING_ACKNOWLEDGEMENTS)
      .map(([id, updatedAt]) => ({ id, updatedAt }))
    if (bounded.length === 0) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(bounded))
  } catch {
    // The in-memory queue still prevents an acknowledgement from being lost
    // during this app session when private storage is unavailable.
  }
}

export function FamilySafetyProvider({
  children,
  onNavigate,
}: {
  children: ReactNode
  onNavigate: (tab: TabId) => void
}) {
  const { user } = useAuth()
  const userId = user?.id
  const [alerts, setAlerts] = useState<FamilyAlert[]>([])
  const [acknowledgedVersions, setAcknowledgedVersions] = useState<Map<string, string>>(new Map())
  const [memberNames, setMemberNames] = useState<Record<string, string>>({})
  const [familyIds, setFamilyIds] = useState<string[]>([])
  const [dismissing, setDismissing] = useState(false)
  const [notificationReady, setNotificationReady] = useState(false)
  const [notificationReason, setNotificationReason] = useState<string | null>(null)
  const [resolvedAlertAddress, setResolvedAlertAddress] = useState<{
    alertKey: string
    label: string | null
    complete: boolean
  } | null>(null)
  const channelsRef = useRef<RealtimeChannel[]>([])
  const previousAlertKeyRef = useRef<string | null>(null)
  const displayedNotificationRef = useRef<{ familyId: string; reporterUserId: string } | null>(null)
  const navigateRef = useRef(onNavigate)
  const pendingAcknowledgementsRef = useRef<Map<string, string>>(new Map())
  const retryingAcknowledgementsRef = useRef(false)
  const familyUpdateListenersRef = useRef<Map<string, Set<() => void>>>(new Map())
  const pushOwnerRef = useRef(userId)
  const pushSetupRef = useRef<{ owner: string; promise: Promise<void> } | null>(null)
  const registeredPushRef = useRef<{ owner: string; token: string } | null>(null)
  pushOwnerRef.current = userId

  const subscribeToFamilyUpdates = useCallback((familyId: string, listener: () => void) => {
    const listeners = familyUpdateListenersRef.current.get(familyId) ?? new Set<() => void>()
    listeners.add(listener)
    familyUpdateListenersRef.current.set(familyId, listeners)

    return () => {
      const current = familyUpdateListenersRef.current.get(familyId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) familyUpdateListenersRef.current.delete(familyId)
    }
  }, [])

  const notifyFamilyUpdate = useCallback((familyId: string) => {
    const listeners = familyUpdateListenersRef.current.get(familyId)
    if (!listeners) return
    for (const listener of [...listeners]) listener()
  }, [])

  useEffect(() => {
    const pending = userId ? loadPendingAcknowledgements(userId) : new Map<string, string>()
    pendingAcknowledgementsRef.current = pending
    setAcknowledgedVersions(new Map(pending))
  }, [userId])

  const loadMemberships = useCallback(async () => {
    if (!userId) {
      setFamilyIds([])
      setMemberNames({})
      return [] as string[]
    }

    const { data, error } = await supabase.rpc('get_my_family_summaries')
    if (error) return [] as string[]
    const ids = ((data ?? []) as FamilySummary[])
      .filter(summary => summary.role === 'host' || summary.member_status === 'approved')
      .map(summary => summary.family_id)

    setFamilyIds(ids)
    if (ids.length === 0) {
      setMemberNames({})
      return ids
    }

    const { data: names } = await supabase
      .from('family_members')
      .select('user_id, first_name')
      .in('family_id', ids)

    const nextNames: Record<string, string> = {}
    for (const member of (names ?? []) as FamilyMemberName[]) {
      if (!nextNames[member.user_id]) nextNames[member.user_id] = member.first_name
    }
    setMemberNames(nextNames)
    return ids
  }, [userId])

  const refreshAlerts = useCallback(async () => {
    if (!userId) {
      setAlerts([])
      setAcknowledgedVersions(new Map())
      pendingAcknowledgementsRef.current = new Map()
      return
    }

    const ids = familyIds.length > 0 ? familyIds : await loadMemberships()
    if (ids.length === 0) {
      setAlerts([])
      return
    }

    try {
      // The database filters acknowledgements before applying the limit. Doing
      // this client-side could let acknowledged newer rows permanently hide an
      // older emergency that still needs this user's attention.
      setAlerts(await loadMyUnacknowledgedFamilyAlerts())
      setAcknowledgedVersions(new Map(pendingAcknowledgementsRef.current))
    } catch {
      // A later Realtime event, app resume, or connectivity restoration retries.
      // Never replace the current alert with a false all-clear on query failure.
    }
  }, [familyIds, loadMemberships, userId])

  const retryPendingAcknowledgements = useCallback(async () => {
    if (!userId || retryingAcknowledgementsRef.current || pendingAcknowledgementsRef.current.size === 0) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return

    retryingAcknowledgementsRef.current = true
    try {
      const entries = [...pendingAcknowledgementsRef.current.entries()]
      const results = await Promise.allSettled(entries.map(([id, updatedAt]) => acknowledgeFamilyAlert(id, updatedAt)))
      const next = new Map(pendingAcknowledgementsRef.current)
      const reconciledVersions = new Set<string>()
      results.forEach((result, index) => {
        // true means the exact alert generation was acknowledged; false means
        // it was superseded and must be shown again. Both remove this old local
        // queue item. Network/server failures remain queued for retry.
        if (result.status === 'fulfilled') {
          const [id, updatedAt] = entries[index]
          next.delete(id)
          reconciledVersions.add(`${id}:${updatedAt}`)
        }
      })
      if (reconciledVersions.size > 0) {
        // Remove only the cached generation that was reconciled. A newer
        // generation with the same durable ID remains eligible to alarm even
        // if the follow-up list request fails.
        setAlerts(current => current.filter(alert => (
          !reconciledVersions.has(`${alert.id}:${alert.updated_at}`)
        )))
      }
      pendingAcknowledgementsRef.current = next
      persistPendingAcknowledgements(userId, next)
      setAcknowledgedVersions(new Map(next))
      await refreshAlerts()
    } finally {
      retryingAcknowledgementsRef.current = false
    }
  }, [refreshAlerts, userId])

  const refreshAlertsRef = useRef(refreshAlerts)
  useEffect(() => { navigateRef.current = onNavigate }, [onNavigate])
  useEffect(() => { refreshAlertsRef.current = refreshAlerts }, [refreshAlerts])

  useEffect(() => {
    void loadMemberships()
  }, [loadMemberships])

  const setupPushNotifications = useCallback((): Promise<void> => {
    const owner = userId
    if (!owner) {
      setNotificationReady(false)
      setNotificationReason(null)
      return Promise.resolve()
    }
    const activeSetup = pushSetupRef.current
    if (activeSetup?.owner === owner) return activeSetup.promise

    const onAction = (payload: Record<string, unknown>) => {
      void refreshAlertsRef.current()
      const destination = String(payload.route ?? payload.destination ?? payload.actionId ?? '')
      navigateRef.current(destination.includes('hotline') ? 'hotlines' : 'family')
    }

    const operation = (async () => {
      try {
        const result = await initializePushNotifications({ onAction })
        if (pushOwnerRef.current !== owner) return
        setNotificationReady(result.available)
        setNotificationReason(result.available ? null : result.reason ?? 'Push notifications are unavailable on this device.')
        if (!result.available || !result.token) return

        if (
          registeredPushRef.current?.owner === owner
          && registeredPushRef.current.token === result.token
        ) {
          return
        }

        const installationId = getOrCreateFamilyPushInstallationId()

        const { error } = await supabase.rpc('register_family_push_token', {
          p_installation_id: installationId,
          p_token: result.token,
          p_platform: 'android',
          p_app_version: String(import.meta.env.VITE_APP_VERSION ?? 'development'),
        })
        if (pushOwnerRef.current !== owner) return
        if (error) {
          setNotificationReady(false)
          setNotificationReason('This device could not be registered for family alerts.')
          return
        }
        registeredPushRef.current = { owner, token: result.token }
        // A freshly registered token can make a previously queued family
        // emergency deliverable. Flush the durable outbox immediately.
        void kickFamilyAlertDispatch()
      } catch {
        if (pushOwnerRef.current !== owner) return
        setNotificationReady(false)
        setNotificationReason('This device could not initialize family alert notifications.')
      }
    })()

    const promise = operation.finally(() => {
      if (pushSetupRef.current?.promise === promise) pushSetupRef.current = null
    })
    pushSetupRef.current = { owner, promise }
    return promise
  }, [userId])

  useEffect(() => {
    if (!userId) {
      registeredPushRef.current = null
      void setupPushNotifications()
      return
    }

    void setupPushNotifications()

    const onNotificationReadiness = (event: Event) => {
      const detail = (event as CustomEvent<{ granted?: boolean }>).detail
      if (detail?.granted === false) {
        setNotificationReady(false)
        setNotificationReason('Notification permission is disabled. Enable it in Android app settings for family alarms.')
        return
      }
      if (detail?.granted === true) void setupPushNotifications()
    }
    const onOnline = () => { void setupPushNotifications() }

    window.addEventListener('kalasag:notification-readiness', onNotificationReadiness)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('kalasag:notification-readiness', onNotificationReadiness)
      window.removeEventListener('online', onOnline)
    }
  }, [setupPushNotifications, userId])

  useEffect(() => {
    if (familyIds.length > 0) void refreshAlerts()
    else setAlerts([])
  }, [familyIds, refreshAlerts])

  useEffect(() => {
    if (userId) void retryPendingAcknowledgements()
  }, [retryPendingAcknowledgements, userId])

  useEffect(() => {
    for (const channel of channelsRef.current) void removeFamilySafetyChannel(channel)
    channelsRef.current = familyIds.map(familyId => subscribeToFamilySafety(familyId, () => {
      notifyFamilyUpdate(familyId)
      void refreshAlerts()
    }))

    return () => {
      for (const channel of channelsRef.current) void removeFamilySafetyChannel(channel)
      channelsRef.current = []
    }
  }, [familyIds, notifyFamilyUpdate, refreshAlerts])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void retryPendingAcknowledgements().finally(() => refreshAlerts())
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onVisible)
    window.addEventListener('kalasag:family-safety-refresh', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onVisible)
      window.removeEventListener('kalasag:family-safety-refresh', onVisible)
    }
  }, [refreshAlerts, retryPendingAcknowledgements])

  const activeAlert = useMemo(
    () => alerts.find(alert => (
      alert.reporter_user_id !== user?.id
      && acknowledgedVersions.get(alert.id) !== alert.updated_at
    )) ?? null,
    [acknowledgedVersions, alerts, user?.id],
  )

  useEffect(() => {
    if (!activeAlert) {
      setResolvedAlertAddress(null)
      return
    }

    const alertKey = `${activeAlert.id}:${activeAlert.updated_at}`
    if (
      activeAlert.address_label
      || activeAlert.latitude === null
      || activeAlert.longitude === null
    ) {
      setResolvedAlertAddress(null)
      return
    }

    let cancelled = false
    setResolvedAlertAddress({ alertKey, label: null, complete: false })
    void reverseGeocodeCoordinates(activeAlert.latitude, activeAlert.longitude)
      .then(result => {
        if (cancelled) return
        setResolvedAlertAddress({
          alertKey,
          label: result?.displayName ?? null,
          complete: true,
        })
      })

    return () => { cancelled = true }
  }, [activeAlert])

  useEffect(() => {
    if (!activeAlert) {
      const displayed = displayedNotificationRef.current
      if (displayed) {
        void cancelFamilyDangerNotification(displayed.familyId, displayed.reporterUserId)
        displayedNotificationRef.current = null
      }
      previousAlertKeyRef.current = null
      stopAlarmSiren()
      return
    }

    const previousDisplayed = displayedNotificationRef.current
    if (
      previousDisplayed
      && (
        previousDisplayed.familyId !== activeAlert.family_id
        || previousDisplayed.reporterUserId !== activeAlert.reporter_user_id
      )
    ) {
      void cancelFamilyDangerNotification(
        previousDisplayed.familyId,
        previousDisplayed.reporterUserId,
      )
    }
    displayedNotificationRef.current = {
      familyId: activeAlert.family_id,
      reporterUserId: activeAlert.reporter_user_id,
    }
    const alertKey = `${activeAlert.id}:${activeAlert.updated_at}`
    if (previousAlertKeyRef.current === alertKey) return
    previousAlertKeyRef.current = alertKey

    try {
      startAlarmSiren()
    } catch {
      // Browsers may require an interaction before audio can start. The visual
      // alert and native notification remain available.
    }
    if ('vibrate' in navigator) navigator.vibrate([600, 250, 600, 250, 900])
    void showFamilyDangerNotification({
      id: activeAlert.id,
      replacementKey: `${activeAlert.family_id}:${activeAlert.reporter_user_id}`,
      title: 'A family member needs help',
      body: 'Open KALASAG to view the verified family alert and latest available location.',
      data: { alert_id: activeAlert.id, family_id: activeAlert.family_id, route: 'family' },
    })
  }, [activeAlert])

  const acknowledge = useCallback(async () => {
    if (!activeAlert) return
    setDismissing(true)
    void cancelFamilyDangerNotification(activeAlert.family_id, activeAlert.reporter_user_id)
    const pending = new Map(pendingAcknowledgementsRef.current)
    pending.set(activeAlert.id, activeAlert.updated_at)
    pendingAcknowledgementsRef.current = pending
    if (userId) persistPendingAcknowledgements(userId, pending)
    setAcknowledgedVersions(current => new Map(current).set(activeAlert.id, activeAlert.updated_at))
    stopAlarmSiren()
    if ('vibrate' in navigator) navigator.vibrate(0)
    try {
      await acknowledgeFamilyAlert(activeAlert.id, activeAlert.updated_at)
      setAlerts(current => current.filter(alert => (
        alert.id !== activeAlert.id || alert.updated_at !== activeAlert.updated_at
      )))
      const remaining = new Map(pendingAcknowledgementsRef.current)
      remaining.delete(activeAlert.id)
      pendingAcknowledgementsRef.current = remaining
      if (userId) persistPendingAcknowledgements(userId, remaining)
      setAcknowledgedVersions(new Map(remaining))
      await refreshAlerts()
    } catch {
      // Keep the persisted acknowledgement queued. Visibility and online
      // events retry it before refreshing server acknowledgement state.
    } finally {
      setDismissing(false)
    }
  }, [activeAlert, refreshAlerts, userId])

  const contextValue = useMemo(
    () => ({
      refreshAlerts,
      subscribeToFamilyUpdates,
      activeAlert,
      notificationReady,
      notificationReason,
    }),
    [activeAlert, notificationReady, notificationReason, refreshAlerts, subscribeToFamilyUpdates],
  )
  const mapsUrl = activeAlert ? alertMapsUrl(activeAlert) : null
  const reporterName = activeAlert ? memberNames[activeAlert.reporter_user_id] || 'A family member' : ''
  const activeAlertKey = activeAlert ? `${activeAlert.id}:${activeAlert.updated_at}` : null
  const liveResolvedAddress = activeAlertKey && resolvedAlertAddress?.alertKey === activeAlertKey
    ? resolvedAlertAddress
    : null

  return (
    <FamilySafetyContext.Provider value={contextValue}>
      {children}

      {activeAlert && (
        <div className="fixed inset-0 z-[3000] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" role="alertdialog" aria-modal="true" aria-labelledby="family-danger-title">
          <section className="elevated-panel relative w-full max-w-lg overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)] shadow-2xl">
            <div className="flex items-start gap-3 bg-[var(--danger-soft)] p-5 text-[var(--danger)]">
              <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[var(--danger)] text-white shadow-lg">
                <BellRing size={24} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em]">Family emergency</p>
                <h2 id="family-danger-title" className="mt-1 text-xl font-black text-[var(--text)]">{reporterName} needs help</h2>
                <p className="mt-1 text-xs font-medium text-[var(--text-soft)]">
                  {activeAlert.urgency === 'urgent_authorities' ? 'Urgent assistance and authorities requested.' : 'The member requested help from the family.'}
                </p>
              </div>
              <IconButton variant="ghost" size="sm" onClick={() => void acknowledge()} aria-label="Acknowledge and close alert">
                <X size={18} />
              </IconButton>
            </div>

            <div className="space-y-4 p-5">
              <div className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-4 shadow-[inset_0_1px_2px_rgb(2_8_23_/_0.2)]">
                <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">Reason</p>
                <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-[var(--text)]">{activeAlert.reason}</p>
              </div>

              <div className="flex gap-3 rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-4">
                <MapPin className="mt-0.5 shrink-0 text-[var(--danger)]" size={18} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[var(--text)]">
                    {activeAlert.address_label
                      || liveResolvedAddress?.label
                      || (activeAlert.latitude !== null && activeAlert.longitude !== null
                        ? liveResolvedAddress?.complete
                          ? 'Street address could not be resolved; use the coordinates below.'
                          : 'Resolving street address…'
                        : 'Street address is unavailable because no location was captured.')}
                  </p>
                  {activeAlert.latitude !== null && activeAlert.longitude !== null ? (
                    <p className="mt-1 font-mono text-[11px] text-[var(--muted)]">
                      {activeAlert.latitude.toFixed(6)}, {activeAlert.longitude.toFixed(6)}
                      {activeAlert.accuracy_m !== null ? ` · ±${Math.round(activeAlert.accuracy_m)} m` : ''}
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] text-[var(--warning)]">Location was unavailable when the alert was sent.</p>
                  )}
                  <p className="mt-1 text-[10px] text-[var(--muted)]">Reported {new Date(activeAlert.created_at).toLocaleString()}</p>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <Button variant="danger" onClick={() => { void acknowledge(); onNavigate('hotlines') }}>
                  <Phone size={16} aria-hidden="true" /> Call authorities
                </Button>
                <Button variant="secondary" onClick={() => { void acknowledge(); onNavigate('family') }}>
                  <Users size={16} aria-hidden="true" /> Open Family Hub
                </Button>
                {mapsUrl && (
                  <a className="ui-control inline-flex min-h-10 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--surface-alt)] px-4 text-sm font-semibold text-[var(--text)] sm:col-span-2" href={mapsUrl} target="_blank" rel="noreferrer">
                    <MapPin size={16} aria-hidden="true" /> Open location in maps
                  </a>
                )}
              </div>

              <Button variant="primary" className="w-full" disabled={dismissing} onClick={() => void acknowledge()}>
                <Check size={16} aria-hidden="true" /> {dismissing ? 'Acknowledging…' : 'Acknowledge alert'}
              </Button>
            </div>
          </section>
        </div>
      )}
    </FamilySafetyContext.Provider>
  )
}
