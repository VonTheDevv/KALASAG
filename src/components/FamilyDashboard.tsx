import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Users,
  UserPlus,
  Shield,
  Activity,
  ShieldAlert,
  CheckCircle2,
  RefreshCw,
  X,
  MessageSquare,
  Clock,
  ChevronLeft,
  ArrowLeft,
  Car,
  Compass,
  Gauge,
  MapPin,
  Navigation,
  Phone,
  Square,
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { formatJoinCodeCountdown, secondsUntilJoinCodeRotation } from '../lib/familyJoinCode'
import { useAuth } from '../hooks/useAuth'
import { useTheme } from '../hooks/useTheme'
import { useFamilySafety } from '../hooks/familySafetyContext'
import {
  getBestDevicePosition,
  getDevicePosition,
  watchDevicePosition,
  clearDevicePositionWatch,
  type DeviceLocationWatchId,
  type DevicePosition,
} from '../lib/deviceGeolocation'
import {
  loadFamilySafetySnapshot,
  removeFamilyMember,
  setMyFamilySafetyV2,
  startFamilyDriving,
  stopFamilyDriving,
  updateDrivingLocationWithToken,
  type FamilyAlertUrgency,
  type FamilyLiveLocation,
  type FamilySafetySnapshot,
  type LocationPayload,
} from '../lib/familySafety'
import { reverseGeocodeCoordinates } from '../lib/reverseGeocode'
import {
  confirmNativeDrivingStopped,
  startNativeDriving,
  stopNativeDriving,
} from '../lib/nativeDriving'
import { CARTO_RASTER_MAX_ZOOM } from '../lib/mapTiles'
import { Button, IconButton, Skeleton } from './ui/primitives'

const MAX_HOSTED_FAMILIES = 3
const JOIN_CODE_REFRESH_RETRY_MS = 30_000
const EMERGENCY_LOCATION_FALLBACK_MAX_AGE_MS = 2 * 60 * 1_000

type FamilySummaryRow = {
  family_id: string
  family_name: string
  role: 'host' | 'member'
  member_status: 'pending' | 'approved'
}

type FamilyListItem = {
  id: string
  name: string
  role: 'host' | 'member'
  memberStatus: 'pending' | 'approved'
}

type FamilyRecord = {
  id: string
  name: string
  host_id?: string
  join_code?: string
}

type FamilyJoinCodeRow = {
  join_code: string
  rotated_at: string
  expires_at: string
  server_now: string
}

type FamilyMember = {
  id: string
  user_id: string
  first_name: string
  status: 'pending' | 'approved'
  safety_status: 'safe' | 'unknown' | 'in_danger'
}

type DangerDraft = {
  open: boolean
  source: 'safety_status' | 'driving'
}

const EMPTY_SAFETY_SNAPSHOT: FamilySafetySnapshot = { sessions: [], locations: [], alerts: [] }

function toLocationPayload(position: DevicePosition): LocationPayload {
  const timestamp = Number.isFinite(position.timestamp)
    && position.timestamp <= Date.now() + 2 * 60 * 1_000
    ? position.timestamp
    : Date.now()
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracyM: position.coords.accuracy,
    headingDeg: position.coords.heading,
    speedMps: position.coords.speed,
    recordedAt: new Date(timestamp).toISOString(),
  }
}

function recentFamilyLocationPayload(location: FamilyLiveLocation | null): LocationPayload | null {
  if (!location) return null
  const recordedAtMs = Date.parse(location.recorded_at)
  if (
    !Number.isFinite(recordedAtMs)
    || Date.now() - recordedAtMs > EMERGENCY_LOCATION_FALLBACK_MAX_AGE_MS
    || recordedAtMs > Date.now() + 2 * 60 * 1_000
    || !Number.isFinite(location.latitude)
    || location.latitude < -90
    || location.latitude > 90
    || !Number.isFinite(location.longitude)
    || location.longitude < -180
    || location.longitude > 180
    || location.accuracy_m === null
    || !Number.isFinite(location.accuracy_m)
    || location.accuracy_m < 0
  ) return null

  return {
    latitude: location.latitude,
    longitude: location.longitude,
    accuracyM: location.accuracy_m,
    headingDeg: location.heading_deg,
    speedMps: location.speed_mps,
    recordedAt: location.recorded_at,
    addressLabel: location.address_label,
  }
}

function distanceKm(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }) {
  const earthKm = 6371
  const radians = (degrees: number) => degrees * Math.PI / 180
  const latitudeDelta = radians(to.latitude - from.latitude)
  const longitudeDelta = radians(to.longitude - from.longitude)
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2
  return earthKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function compassLabel(heading: number | null) {
  if (heading === null || !Number.isFinite(heading)) return 'Unavailable'
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return `${labels[Math.round((((heading % 360) + 360) % 360) / 45) % 8]} · ${Math.round(heading)}°`
}

export default function FamilyDashboard({ onNavigate }: { onNavigate: (tab: any) => void }) {
  const { user, profile } = useAuth()
  const { resolvedTheme } = useTheme()
  const {
    refreshAlerts,
    subscribeToFamilyUpdates,
    notificationReady,
    notificationReason,
  } = useFamilySafety()
  const [loading, setLoading] = useState(true)
  
  const [familiesList, setFamiliesList] = useState<FamilyListItem[]>([])
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null)
  
  const [family, setFamily] = useState<FamilyRecord | null>(null)
  const [members, setMembers] = useState<FamilyMember[]>([])
  const [isHost, setIsHost] = useState(false)
  const [joinCodeExpiresAt, setJoinCodeExpiresAt] = useState<string | null>(null)
  const [joinCodeSecondsRemaining, setJoinCodeSecondsRemaining] = useState<number | null>(null)
  const [serverTimeOffsetMs, setServerTimeOffsetMs] = useState(0)
  const joinCodeRefreshInFlightRef = useRef(false)
  const joinCodeRetryAtRef = useRef(0)
  
  const [joinCode, setJoinCode] = useState('')
  const [familyName, setFamilyName] = useState('')
  
  const [errorMsg, setErrorMsg] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  const [myStatus, setMyStatus] = useState<'pending' | 'approved' | null>(null)
  const [safetySnapshot, setSafetySnapshot] = useState<FamilySafetySnapshot>(EMPTY_SAFETY_SNAPSHOT)
  const [drivingBusy, setDrivingBusy] = useState(false)
  const [dangerBusy, setDangerBusy] = useState(false)
  const [dangerDraft, setDangerDraft] = useState<DangerDraft>({ open: false, source: 'safety_status' })
  const [dangerReason, setDangerReason] = useState('')
  const [selectedDriver, setSelectedDriver] = useState<FamilyMember | null>(null)
  const [viewerLocation, setViewerLocation] = useState<LocationPayload | null>(null)
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null)
  const selectedAddressRequestRef = useRef(0)
  const webWatchRef = useRef<DeviceLocationWatchId | null>(null)
  const pendingDrivingEventRef = useRef<{ familyId: string; id: string } | null>(null)
  const pendingSafetyEventRef = useRef<{
    familyId: string
    status: 'safe'
    id: string
  } | null>(null)
  const pendingDangerEventRef = useRef<{ fingerprint: string; id: string } | null>(null)
  const lastWebUploadAtRef = useRef(0)
  const lastReverseAtRef = useRef(0)
  const lastReversePointRef = useRef<{ latitude: number; longitude: number } | null>(null)
  const lastAddressRef = useRef<string | null>(null)
  
  const firstName = profile?.first_name || user?.email?.split('@')[0] || 'Unknown'
  const hostedFamilyCount = familiesList.filter(candidate => candidate.role === 'host').length
  const hasReachedHostLimit = hostedFamilyCount >= MAX_HOSTED_FAMILIES

  const selectFamily = (familyId: string | null) => {
    setSelectedFamilyId(familyId)
    if (!familyId) return
    try {
      window.localStorage.setItem('kalasag_selected_family', familyId)
    } catch {
      // Selection persistence is a convenience only.
    }
  }

  const loadFamiliesList = useCallback(async () => {
    if (!user) return
    setLoading(true)

    const { data, error } = await supabase.rpc('get_my_family_summaries')
    if (error) {
      setErrorMsg('Your family list could not be loaded. Please try again.')
      setFamiliesList([])
      setLoading(false)
      return
    }

    const list = ((data ?? []) as FamilySummaryRow[]).map(row => ({
      id: row.family_id,
      name: row.family_name,
      role: row.role,
      memberStatus: row.member_status,
    }))
    setFamiliesList(list)
    setLoading(false)
  }, [user])

  useEffect(() => {
    loadFamiliesList()
  }, [loadFamiliesList])

  const loadHostJoinCode = useCallback(async (familyId: string, reportError = true) => {
    if (joinCodeRefreshInFlightRef.current) return false

    joinCodeRefreshInFlightRef.current = true
    const requestedAtMs = Date.now()
    try {
      const { data, error } = await supabase
        .rpc('get_family_join_code', { p_family_id: familyId })
        .single()

      if (error || !data) throw error ?? new Error('No join code was returned.')

      const code = data as FamilyJoinCodeRow
      const serverNowMs = Date.parse(code.server_now)
      const expiresAtMs = Date.parse(code.expires_at)
      if (!/^\d{8}$/.test(code.join_code) || !Number.isFinite(serverNowMs) || !Number.isFinite(expiresAtMs)) {
        throw new Error('The join code response was invalid.')
      }

      const receivedAtMs = Date.now()
      const offsetMs = serverNowMs - Math.round((requestedAtMs + receivedAtMs) / 2)
      setFamily(current => current?.id === familyId ? { ...current, join_code: code.join_code } : current)
      setJoinCodeExpiresAt(code.expires_at)
      setServerTimeOffsetMs(offsetMs)
      setJoinCodeSecondsRemaining(secondsUntilJoinCodeRotation(code.expires_at, offsetMs))
      joinCodeRetryAtRef.current = 0
      return true
    } catch {
      joinCodeRetryAtRef.current = Date.now() + JOIN_CODE_REFRESH_RETRY_MS
      setFamily(current => current?.id === familyId ? { ...current, join_code: undefined } : current)
      setJoinCodeSecondsRemaining(0)
      if (reportError) {
        setErrorMsg('The current join code could not be loaded. Retrying automatically.')
      }
      return false
    } finally {
      joinCodeRefreshInFlightRef.current = false
    }
  }, [])

  const loadFamily = useCallback(async () => {
    if (!user || !selectedFamilyId) return
    setLoading(true)

    const summary = familiesList.find(candidate => candidate.id === selectedFamilyId)
    if (!summary) {
      setFamily(null)
      setMembers([])
      setJoinCodeExpiresAt(null)
      setJoinCodeSecondsRemaining(null)
      setErrorMsg('This family is no longer available to your account.')
      setLoading(false)
      return
    }

    if (summary.role === 'member' && summary.memberStatus === 'pending') {
      const { data: membership, error: membershipError } = await supabase
        .from('family_members')
        .select('status')
        .eq('family_id', selectedFamilyId)
        .eq('user_id', user.id)
        .single()
      if (membershipError || membership?.status !== 'approved') {
        setFamily({ id: summary.id, name: summary.name })
        setIsHost(false)
        setMyStatus('pending')
        setMembers([])
        setJoinCodeExpiresAt(null)
        setJoinCodeSecondsRemaining(null)
        setLoading(false)
        return
      }
    }

    const { data: famData, error: familyError } = await supabase
      .from('families')
      .select('id, name, host_id')
      .eq('id', selectedFamilyId)
      .single()
    if (familyError || !famData) {
      setFamily(null)
      setMembers([])
      setErrorMsg('This family could not be loaded. Please try again.')
      setLoading(false)
      return
    }
    setFamily(famData as FamilyRecord)

    const isHostUser = famData?.host_id === user.id
    setIsHost(isHostUser)
    
    if (!isHostUser) {
      const { data: myData } = await supabase.from('family_members').select('status, safety_status').eq('family_id', selectedFamilyId).eq('user_id', user.id).single()
      setMyStatus(myData?.status || null)
    } else {
      setMyStatus('approved')
      await loadHostJoinCode(selectedFamilyId)
    }

    if (!isHostUser) {
      setJoinCodeExpiresAt(null)
      setJoinCodeSecondsRemaining(null)
    }

    const { data: mems } = await supabase
      .from('family_members')
      .select('id, user_id, first_name, status, safety_status')
      .eq('family_id', selectedFamilyId)
    setMembers(mems || [])
    
    setLoading(false)
  }, [user, selectedFamilyId, familiesList, loadHostJoinCode])

  useEffect(() => {
    if (selectedFamilyId) {
      loadFamily()
    }
  }, [loadFamily, selectedFamilyId])

  const loadSafetyState = useCallback(async () => {
    if (!selectedFamilyId || myStatus !== 'approved') {
      setSafetySnapshot(EMPTY_SAFETY_SNAPSHOT)
      return
    }
    try {
      setSafetySnapshot(await loadFamilySafetySnapshot(selectedFamilyId))
    } catch {
      setSafetySnapshot(EMPTY_SAFETY_SNAPSHOT)
    }
  }, [myStatus, selectedFamilyId])

  useEffect(() => {
    void loadSafetyState()
    if (!selectedFamilyId || myStatus !== 'approved') return

    return subscribeToFamilyUpdates(selectedFamilyId, () => {
      void Promise.all([loadSafetyState(), loadFamily()])
    })
  }, [loadFamily, loadSafetyState, myStatus, selectedFamilyId, subscribeToFamilyUpdates])

  useEffect(() => () => {
    if (webWatchRef.current !== null) void clearDevicePositionWatch(webWatchRef.current)
  }, [])

  useEffect(() => {
    const stopWebTrackingForSignOut = () => {
      if (webWatchRef.current === null) return
      const watchId = webWatchRef.current
      webWatchRef.current = null
      void clearDevicePositionWatch(watchId)
    }
    window.addEventListener('kalasag:signing-out', stopWebTrackingForSignOut)
    return () => window.removeEventListener('kalasag:signing-out', stopWebTrackingForSignOut)
  }, [])

  useEffect(() => {
    if (!isHost || !selectedFamilyId || !joinCodeExpiresAt) return

    const updateCountdown = () => {
      const remaining = secondsUntilJoinCodeRotation(joinCodeExpiresAt, serverTimeOffsetMs)
      setJoinCodeSecondsRemaining(remaining)

      if (
        remaining === 0
        && !joinCodeRefreshInFlightRef.current
        && Date.now() >= joinCodeRetryAtRef.current
      ) {
        void loadHostJoinCode(selectedFamilyId)
      }
    }

    updateCountdown()
    const intervalId = window.setInterval(updateCountdown, 1000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') updateCountdown()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [isHost, joinCodeExpiresAt, loadHostJoinCode, selectedFamilyId, serverTimeOffsetMs])

  const handleCreateFamily = async () => {
    if (hasReachedHostLimit) {
      setErrorMsg(`You can create a maximum of ${MAX_HOSTED_FAMILIES} families.`)
      return
    }
    if (!familyName.trim()) {
      setErrorMsg('Please enter a family name')
      return
    }
    if (!user) return
    setLoading(true)
    try {
      setErrorMsg('')
      const { data: authData, error: authError } = await supabase.auth.getUser()
      if (authError || !authData.user || authData.user.id !== user.id) {
        throw new Error('Your sign-in session expired. Please sign in again before creating a family.')
      }
      const { error } = await supabase
        .rpc('create_family', { p_name: familyName.trim() })
        .single()
      if (error) throw error
      setSuccessMsg('Family created successfully!')
      setFamilyName('')
      await loadFamiliesList()
      setLoading(false)
    } catch (err: any) { 
      setErrorMsg(err.message)
      setLoading(false) 
    }
  }

  const handleJoinFamily = async () => {
    if (!joinCode || joinCode.length !== 8) {
      setErrorMsg('Please enter a valid 8-digit join code')
      return
    }
    setLoading(true)
    try {
      const { data, error } = await supabase.rpc('join_family_by_code', {
        p_join_code: joinCode,
        p_first_name: firstName
      })
      
      if (error || (data && data.success === false)) {
        setErrorMsg(error?.message || data?.error || 'Failed to join')
      } else {
        setSuccessMsg(`Requested to join ${data?.family_name || 'the family'}. Wait for host approval.`)
        setJoinCode('')
        loadFamiliesList()
      }
    } catch (err: any) { 
      setErrorMsg(err.message)
    }
    setLoading(false)
  }

  const handleApprove = async (memberId: string, memberName: string) => {
    if (!window.confirm(`Are you sure you want to approve ${memberName}?`)) return
    const { error } = await supabase.rpc('approve_family_member', { p_member_id: memberId })
    if (error) setErrorMsg(error.message)
    else loadFamily()
  }

  const handleRemove = async (memberId: string, memberName: string) => {
    if (!window.confirm(`Are you sure you want to remove ${memberName}?`)) return
    setErrorMsg('')
    try {
      await removeFamilyMember(memberId)
      await loadFamily()
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'The family member could not be removed.')
    }
  }

  const sessionByUserId = useMemo(
    () => new Map(safetySnapshot.sessions.map(session => [session.user_id, session])),
    [safetySnapshot.sessions],
  )
  const locationByUserId = useMemo(
    () => new Map(safetySnapshot.locations.map(location => [location.user_id, location])),
    [safetySnapshot.locations],
  )
  const myDrivingSession = user ? sessionByUserId.get(user.id) ?? null : null
  const selectedDriverLocation = selectedDriver ? locationByUserId.get(selectedDriver.user_id) ?? null : null
  const selectedDriverSession = selectedDriver ? sessionByUserId.get(selectedDriver.user_id) ?? null : null
  const selectedDriverAlert = selectedDriver
    ? safetySnapshot.alerts.find(alert => alert.reporter_user_id === selectedDriver.user_id) ?? null
    : null
  const selectedPoint = selectedDriverLocation
    ? { latitude: selectedDriverLocation.latitude, longitude: selectedDriverLocation.longitude }
    : selectedDriverAlert?.latitude !== null && selectedDriverAlert?.latitude !== undefined
      && selectedDriverAlert.longitude !== null && selectedDriverAlert.longitude !== undefined
      ? { latitude: selectedDriverAlert.latitude, longitude: selectedDriverAlert.longitude }
      : null
  const viewerDistanceKm = selectedPoint && viewerLocation ? distanceKm(viewerLocation, selectedPoint) : null
  const selectedRecordedAt = selectedDriverLocation?.recorded_at ?? selectedDriverAlert?.created_at ?? null
  const selectedLocationAgeSeconds = selectedRecordedAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(selectedRecordedAt)) / 1_000))
    : null

  const uploadWebPosition = useCallback(async (
    sessionId: string,
    trackingToken: string,
    position: Awaited<ReturnType<typeof getDevicePosition>>,
  ) => {
    const now = Date.now()
    if (now - lastWebUploadAtRef.current < 5_000) return
    lastWebUploadAtRef.current = now
    const payload = toLocationPayload(position)
    const movedKm = lastReversePointRef.current ? distanceKm(lastReversePointRef.current, payload) : Number.POSITIVE_INFINITY
    if (now - lastReverseAtRef.current >= 60_000 || movedKm >= 0.1) {
      const address = await Promise.race([
        reverseGeocodeCoordinates(payload.latitude, payload.longitude),
        new Promise<null>(resolve => window.setTimeout(() => resolve(null), 1_200)),
      ])
      if (address) lastAddressRef.current = address.displayName
      lastReverseAtRef.current = now
      lastReversePointRef.current = payload
    }
    await updateDrivingLocationWithToken(sessionId, trackingToken, {
      ...payload,
      addressLabel: lastAddressRef.current,
    })
  }, [])

  const handleStartDriving = async () => {
    if (!family || !user || drivingBusy || myDrivingSession) return
    setDrivingBusy(true)
    setErrorMsg('')
    let startedSessionId: string | null = null
    let nativeTrackingStarted = false
    try {
      const initialPosition = await getDevicePosition({ enableHighAccuracy: true, timeout: 12_000, maximumAge: 5_000 })
      const pendingEvent = pendingDrivingEventRef.current?.familyId === family.id
        ? pendingDrivingEventRef.current
        : { familyId: family.id, id: crypto.randomUUID() }
      pendingDrivingEventRef.current = pendingEvent
      const started = await startFamilyDriving(family.id, pendingEvent.id)
      // The RPC response is now known. A later native startup failure ends the
      // session and the next deliberate attempt must use a new event ID.
      pendingDrivingEventRef.current = null
      startedSessionId = started.sessionId
      const nativeResult = await startNativeDriving({
        supabaseUrl: String(import.meta.env.VITE_SUPABASE_URL),
        publishableKey: String(import.meta.env.VITE_SUPABASE_ANON_KEY),
        sessionId: started.sessionId,
        trackingToken: started.trackingToken,
        trackingExpiresAt: started.expiresAt,
      })
      nativeTrackingStarted = nativeResult.native

      await uploadWebPosition(started.sessionId, started.trackingToken, initialPosition)
      if (!nativeResult.native) {
        webWatchRef.current = await watchDevicePosition(
          position => { void uploadWebPosition(started.sessionId, started.trackingToken, position) },
          error => setErrorMsg(error.message),
          { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
        )
      }

      setSuccessMsg('Driving Mode is active. Your approved family members can now see your latest location.')
      await Promise.all([loadSafetyState(), refreshAlerts()])
    } catch (error) {
      if (nativeTrackingStarted) {
        try { await stopNativeDriving() } catch { /* server-side expiry remains the final fallback */ }
      }
      if (webWatchRef.current !== null) {
        try { await clearDevicePositionWatch(webWatchRef.current) } catch { /* the page lifecycle will release it */ }
        webWatchRef.current = null
      }
      if (startedSessionId) {
        try {
          await stopFamilyDriving(startedSessionId)
          await confirmNativeDrivingStopped(startedSessionId)
        } catch { /* native revocation or session expiry remains the final fallback */ }
      }
      setErrorMsg(error instanceof Error ? error.message : 'Driving Mode could not be started.')
    } finally {
      setDrivingBusy(false)
    }
  }

  const handleStopDriving = async () => {
    if (!myDrivingSession || drivingBusy) return
    setDrivingBusy(true)
    setErrorMsg('')
    let localStopError: unknown = null
    let remoteStopped = false
    try {
      try {
        await stopNativeDriving()
      } catch (error) {
        localStopError = error
      }
      if (webWatchRef.current !== null) {
        const watchId = webWatchRef.current
        webWatchRef.current = null
        try {
          await clearDevicePositionWatch(watchId)
        } catch (error) {
          localStopError ??= error
        }
      }
      await stopFamilyDriving(myDrivingSession.id)
      remoteStopped = true
      try {
        await confirmNativeDrivingStopped(myDrivingSession.id)
      } catch (error) {
        localStopError ??= error
      }
      setSuccessMsg('Driving Mode stopped. Live location sharing has ended.')
      try {
        await loadSafetyState()
      } catch {
        // Realtime or the next foreground refresh will reconcile the UI. The
        // authenticated stop RPC above already ended location sharing.
      }
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Driving Mode could not be stopped.')
    } finally {
      if (localStopError && remoteStopped) {
        setErrorMsg(localStopError instanceof Error
          ? `Location sharing was stopped on the server, but Android cleanup needs attention: ${localStopError.message}`
          : 'Location sharing was stopped on the server, but Android cleanup needs attention.')
      }
      setDrivingBusy(false)
    }
  }

  const captureBestLocation = async (): Promise<LocationPayload | null> => {
    try {
      const position = await getBestDevicePosition(
        { enableHighAccuracy: true, timeout: 5_000, maximumAge: 15_000 },
        EMERGENCY_LOCATION_FALLBACK_MAX_AGE_MS,
      )
      const location = toLocationPayload(position)
      const recentDrivingLocation = user ? recentFamilyLocationPayload(locationByUserId.get(user.id) ?? null) : null
      const canReuseDrivingAddress = recentDrivingLocation?.addressLabel
        && distanceKm(recentDrivingLocation, location) <= 0.1
      // Reverse geocoding is intentionally not awaited here. Coordinates are
      // the life-safety payload; recipients resolve a street label from them
      // without delaying or preventing the alert dispatch.
      return {
        ...location,
        addressLabel: canReuseDrivingAddress ? recentDrivingLocation.addressLabel : null,
      }
    } catch {
      // The native foreground driving service may have uploaded a newer fix
      // than the WebView can acquire. Reuse it only while it is strictly fresh.
      return user ? recentFamilyLocationPayload(locationByUserId.get(user.id) ?? null) : null
    }
  }

  const handleStatusUpdate = async (status: 'safe' | 'in_danger') => {
    if (!family || !user) return
    if (status === 'in_danger') {
      setDangerDraft({ open: true, source: myDrivingSession ? 'driving' : 'safety_status' })
      setDangerReason('')
      pendingDangerEventRef.current = null
      return
    }

    setDangerBusy(true)
    setErrorMsg('')
    try {
      const pendingEvent = pendingSafetyEventRef.current?.familyId === family.id
        && pendingSafetyEventRef.current.status === status
        ? pendingSafetyEventRef.current
        : { familyId: family.id, status, id: crypto.randomUUID() }
      pendingSafetyEventRef.current = pendingEvent
      await setMyFamilySafetyV2(family.id, status, { clientEventId: pendingEvent.id })
      pendingSafetyEventRef.current = null
      await Promise.all([loadFamily(), loadSafetyState(), refreshAlerts()])
      setSuccessMsg('Your family can now see that you are safe.')
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Your safety status could not be updated.')
    } finally {
      setDangerBusy(false)
    }
  }

  const submitDangerAlert = async (urgency: FamilyAlertUrgency) => {
    if (!family || dangerBusy) return
    const reason = dangerReason.trim()
    if (reason.length < 3) {
      setErrorMsg('Tell your family what is happening using at least 3 characters.')
      return
    }

    setDangerBusy(true)
    setErrorMsg('')
    try {
      const location = await captureBestLocation()
      const fingerprint = JSON.stringify([
        family.id,
        'in_danger',
        urgency,
        dangerDraft.source,
        reason,
      ])
      const pendingEvent = pendingDangerEventRef.current?.fingerprint === fingerprint
        ? pendingDangerEventRef.current
        : { fingerprint, id: crypto.randomUUID() }
      pendingDangerEventRef.current = pendingEvent
      await setMyFamilySafetyV2(family.id, 'in_danger', {
        reason,
        urgency,
        source: dangerDraft.source,
        location,
        clientEventId: pendingEvent.id,
      })
      pendingDangerEventRef.current = null
      setDangerDraft(current => ({ ...current, open: false }))
      setDangerReason('')
      setSuccessMsg(location
        ? 'Emergency alert sent with your latest location.'
        : 'Emergency alert sent. Location was unavailable, but your family was still notified.')
      await Promise.all([loadFamily(), loadSafetyState(), refreshAlerts()])
      if (urgency === 'urgent_authorities') onNavigate('hotlines')
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'The emergency alert could not be sent.')
    } finally {
      setDangerBusy(false)
    }
  }

  const openDriverDetails = async (member: FamilyMember) => {
    if (!sessionByUserId.has(member.user_id) && member.safety_status !== 'in_danger') return
    setSelectedDriver(member)
    setViewerLocation(null)
    setSelectedAddress(null)
    const addressRequestId = ++selectedAddressRequestRef.current
    const remote = locationByUserId.get(member.user_id)
    const memberAlert = safetySnapshot.alerts.find(alert => alert.reporter_user_id === member.user_id) ?? null
    const addressPoint = remote
      ? { latitude: remote.latitude, longitude: remote.longitude }
      : memberAlert?.latitude !== null && memberAlert?.latitude !== undefined
        && memberAlert.longitude !== null && memberAlert.longitude !== undefined
        ? { latitude: memberAlert.latitude, longitude: memberAlert.longitude }
        : null
    if (addressPoint) {
      void reverseGeocodeCoordinates(addressPoint.latitude, addressPoint.longitude)
        .then(result => {
          if (selectedAddressRequestRef.current !== addressRequestId) return
          setSelectedAddress(result?.displayName ?? 'Current street could not be resolved; use the coordinates below.')
        })
    }
    try {
      const current = await getDevicePosition({ enableHighAccuracy: true, timeout: 8_000, maximumAge: 15_000 })
      setViewerLocation(toLocationPayload(current))
    } catch {
      // Remote member details remain useful even when the viewer denies GPS.
    }
  }

  const getStatusColor = (status: string) => {
    if (status === 'safe') return 'text-[var(--color-green-safe)]'
    if (status === 'in_danger') return 'text-[var(--color-red-alert)]'
    return 'text-[var(--color-yellow-warn)]'
  }

  if (loading && !family) {
    return (
      <div role="status" aria-label="Loading Family Hub" className="h-full overflow-hidden bg-[var(--surface)] p-4 sm:p-6">
        <div className="mx-auto max-w-xl space-y-5">
          <div className="flex items-center gap-3"><Skeleton variant="block" className="h-10 w-10" /><div className="flex-1 space-y-2"><Skeleton variant="line" className="w-28" /><Skeleton variant="line" className="h-2 w-44" /></div></div>
          <Skeleton variant="block" className="h-44 w-full" />
          <div className="grid gap-4 sm:grid-cols-2"><Skeleton variant="block" className="h-40" /><Skeleton variant="block" className="h-40" /></div>
        </div>
        <span className="sr-only">Loading Family Hub</span>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg-primary)]">
      <div className="max-w-xl mx-auto p-4 sm:p-6 space-y-6 animate-smooth-slide-up pb-24">
        
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-[var(--color-blue-info)]/15 border border-[var(--color-blue-info)]/25 flex items-center justify-center shrink-0">
            <Users size={20} className="text-[var(--color-blue-info)]" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-[var(--color-text-primary)]">Family Hub</h1>
            <p className="text-[11px] text-[var(--color-text-muted)]">Stay connected and safe together.</p>
          </div>
        </div>

        {errorMsg && (
          <div className="p-3 bg-[var(--color-red-alert)]/10 border border-[var(--color-red-alert)]/20 rounded-lg text-xs text-[var(--color-red-alert)] flex items-center justify-between">
            {errorMsg}
            <button onClick={() => setErrorMsg('')}><X size={14}/></button>
          </div>
        )}
        
        {successMsg && (
          <div className="p-3 bg-[var(--color-green-safe)]/10 border border-[var(--color-green-safe)]/20 rounded-lg text-xs text-[var(--color-green-safe)] flex items-center justify-between">
            {successMsg}
            <button onClick={() => setSuccessMsg('')}><X size={14}/></button>
          </div>
        )}

        {!selectedFamilyId ? (
          <div className="space-y-6">
            
            {/* Family List */}
            <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] overflow-hidden">
               <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
                <h3 className="text-xs font-bold text-[var(--color-text-primary)]">My Families</h3>
               </div>
               <div className="divide-y divide-[var(--color-border)]">
                 {familiesList.length === 0 ? (
                   <div className="p-6 text-center text-xs text-[var(--color-text-muted)]">
                     You haven't joined any families yet.
                   </div>
                 ) : (
                   familiesList.map(fam => (
                     <button 
                       key={fam.id}
                       onClick={() => selectFamily(fam.id)}
                       className="w-full text-left p-4 flex items-center justify-between hover:bg-[var(--color-bg-elevated)]/50 transition-colors"
                     >
                       <div>
                         <p className="text-sm font-bold text-[var(--color-text-primary)] flex items-center gap-2">
                           {fam.name}
                           {fam.role === 'host' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-blue-info)]/20 text-[var(--color-blue-info)] font-bold">HOST</span>}
                           {fam.memberStatus === 'pending' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-yellow-warn)]/20 text-[var(--color-yellow-warn)] font-bold">PENDING</span>}
                         </p>
                       </div>
                       <ChevronLeft size={16} className="text-[var(--color-text-muted)] rotate-180" />
                     </button>
                   ))
                 )}
               </div>
            </div>

            <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] p-5">
              <h2 className="text-sm font-bold text-[var(--color-text-primary)] mb-3 flex items-center gap-2">
                <Shield size={16} className="text-[var(--color-orange)]" /> Create a Family
              </h2>
              <p className="mb-3 text-[10px] text-[var(--color-text-muted)]">
                Hosted families: {hostedFamilyCount} / {MAX_HOSTED_FAMILIES}
              </p>
              <input
                type="text"
                value={familyName}
                onChange={e => setFamilyName(e.target.value)}
                maxLength={100}
                disabled={hasReachedHostLimit}
                placeholder="e.g. The Dela Cruz Family"
                className="w-full bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-orange)] outline-none mb-3 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <button 
                onClick={handleCreateFamily}
                disabled={loading || hasReachedHostLimit}
                className="w-full py-2.5 rounded-lg bg-[var(--color-orange)] text-[var(--color-bg-primary)] text-sm font-bold active:scale-[0.98] transition-all disabled:cursor-not-allowed disabled:opacity-50"
              >
                {hasReachedHostLimit ? '3-Family Limit Reached' : 'Create Family'}
              </button>
            </div>
            
            <div className="flex items-center gap-3">
              <div className="h-[1px] flex-1 bg-[var(--color-border)]"></div>
              <span className="text-[10px] text-[var(--color-text-muted)] font-bold uppercase tracking-widest">OR</span>
              <div className="h-[1px] flex-1 bg-[var(--color-border)]"></div>
            </div>

            <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] p-5">
              <h2 className="text-sm font-bold text-[var(--color-text-primary)] mb-3 flex items-center gap-2">
                <UserPlus size={16} className="text-[var(--color-blue-info)]" /> Join a Family
              </h2>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={joinCode}
                onChange={e => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                maxLength={8}
                placeholder="8-digit Join Code"
                className="w-full bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:border-[var(--color-blue-info)] outline-none tracking-widest font-mono text-center mb-3"
              />
              <button 
                onClick={handleJoinFamily}
                className="w-full py-2.5 rounded-lg bg-[var(--color-blue-info)] text-[var(--color-bg-primary)] text-sm font-bold active:scale-[0.98] transition-all"
              >
                Join Family
              </button>
            </div>
          </div>
        ) : myStatus === 'pending' ? (
          <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] p-6 text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-[var(--color-yellow-warn)]/10 flex items-center justify-center mx-auto">
              <Clock className="text-[var(--color-yellow-warn)]" size={24} />
            </div>
            <h2 className="text-base font-bold text-[var(--color-text-primary)]">Pending Host Approval</h2>
            <p className="text-xs text-[var(--color-text-muted)] max-w-sm mx-auto">
              Your request to join <strong>{family?.name}</strong> is currently pending. Please ask the family host to approve your request.
            </p>
            <div className="pt-2 flex items-center justify-center gap-3">
              <button 
                onClick={loadFamily}
                className="px-4 py-2 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] hover:bg-[var(--color-bg-elevated)]/85 text-xs font-bold rounded-lg text-[var(--color-text-primary)] transition-all flex items-center gap-2"
              >
                <RefreshCw size={12} /> Check Status
              </button>
              <button 
                onClick={() => setSelectedFamilyId(null)}
                className="px-4 py-2 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] hover:bg-[var(--color-bg-elevated)]/85 text-xs font-bold rounded-lg text-[var(--color-text-primary)] transition-all"
              >
                Back
              </button>
            </div>
          </div>
        ) : family ? (
          <div className="space-y-4">
            
            <button 
              onClick={() => setSelectedFamilyId(null)}
              className="flex items-center gap-1.5 text-xs font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors mb-2"
            >
              <ArrowLeft size={14} /> Back to Families
            </button>
            
            <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] p-5 text-center">
              <h2 className="text-xl font-black text-[var(--color-text-primary)]">{family.name}</h2>
              {isHost && (
                <div className="mt-3 flex flex-col items-center gap-2">
                  <div className="flex items-center justify-center gap-2">
                    <span className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider font-bold">Join Code:</span>
                    <code className="min-w-28 px-2 py-1 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded text-sm font-mono tracking-widest text-[var(--color-orange)]">
                      {joinCodeSecondsRemaining === null
                        ? 'Loading...'
                        : joinCodeSecondsRemaining > 0 && family.join_code
                          ? family.join_code
                          : 'Refreshing...'}
                    </code>
                  </div>
                  <div className="flex items-center gap-1.5 text-[10px] font-medium tabular-nums text-[var(--color-text-muted)]">
                    <Clock size={12} aria-hidden="true" />
                    <span>Next code in {formatJoinCodeCountdown(joinCodeSecondsRemaining ?? 0)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Driving Mode */}
            <div className="elevated-panel rounded-[var(--radius-lg)] bg-[var(--panel)] p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 gap-3">
                  <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${myDrivingSession ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--action-soft)] text-[var(--action)]'}`}>
                    <Car size={20} aria-hidden="true" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-[var(--text)]">Driving Mode</h3>
                    <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">
                      {myDrivingSession
                        ? 'Your latest location is shared only with approved members of this family.'
                        : 'Share live driving progress so your family can check your direction and distance.'}
                    </p>
                    <p className={`mt-2 text-[10px] font-semibold ${notificationReady ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
                      {notificationReady ? 'Device alarms are ready.' : notificationReason || 'Foreground family alerts remain available.'}
                    </p>
                  </div>
                </div>
                {myDrivingSession && (
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--success-soft)] px-2.5 py-1 text-[10px] font-bold text-[var(--success)]">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> Live
                  </span>
                )}
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {myDrivingSession ? (
                  <Button variant="secondary" disabled={drivingBusy} onClick={() => void handleStopDriving()}>
                    <Square size={15} aria-hidden="true" /> {drivingBusy ? 'Stopping…' : 'Stop Driving'}
                  </Button>
                ) : (
                  <Button variant="primary" disabled={drivingBusy} onClick={() => void handleStartDriving()}>
                    <Navigation size={15} aria-hidden="true" /> {drivingBusy ? 'Starting…' : 'Start Driving'}
                  </Button>
                )}
                <Button
                  variant="danger"
                  disabled={dangerBusy}
                  onClick={() => {
                    setDangerDraft({ open: true, source: 'driving' })
                    setDangerReason('')
                  }}
                >
                  <ShieldAlert size={15} aria-hidden="true" /> I am in danger
                </Button>
              </div>

            </div>
            
            {/* My Status */}
            <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] p-5">
              <h3 className="text-xs font-bold text-[var(--color-text-primary)] mb-3 flex items-center gap-2">
                <Activity size={14} className="text-[var(--color-text-muted)]"/> Update My Status
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <button disabled={dangerBusy} onClick={() => void handleStatusUpdate('safe')} className="py-3 flex flex-col items-center justify-center gap-1.5 rounded-xl bg-[var(--color-green-safe)]/10 text-[var(--color-green-safe)] hover:bg-[var(--color-green-safe)]/20 active:scale-95 transition-all disabled:opacity-50">
                  <CheckCircle2 size={24} />
                  <span className="text-xs font-bold">I Am Safe</span>
                </button>
                <button disabled={dangerBusy} onClick={() => void handleStatusUpdate('in_danger')} className="py-3 flex flex-col items-center justify-center gap-1.5 rounded-xl bg-[var(--color-red-alert)]/10 text-[var(--color-red-alert)] hover:bg-[var(--color-red-alert)]/20 active:scale-95 transition-all disabled:opacity-50">
                  <ShieldAlert size={24} />
                  <span className="text-xs font-bold">In Danger</span>
                </button>
              </div>
            </div>

            {/* Chat button */}
            <button 
              onClick={() => onNavigate('familyChat')}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-[var(--color-bg-elevated)] border border-[var(--color-border)] hover:bg-[var(--color-bg-elevated)]/70 transition-all text-sm font-bold text-[var(--color-text-primary)]"
            >
              <MessageSquare size={16} className="text-[var(--color-blue-info)]"/>
              Open Family Chat
            </button>

            {/* Members List */}
            <div className="elevated-panel bg-[var(--panel)] rounded-[var(--radius-lg)] overflow-hidden">
               <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
                <h3 className="text-xs font-bold text-[var(--color-text-primary)]">Members ({members.length})</h3>
                <button onClick={loadFamily} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"><RefreshCw size={12}/></button>
               </div>
               <div className="divide-y divide-[var(--color-border)]">
                 {members.map(m => (
                   <div key={m.id} className="flex items-center justify-between gap-3 p-4">
                     <button
                       type="button"
                       onClick={() => void openDriverDetails(m)}
                       disabled={!sessionByUserId.has(m.user_id) && m.safety_status !== 'in_danger'}
                       className="min-w-0 flex-1 text-left disabled:cursor-default"
                     >
                       <p className="text-sm font-bold text-[var(--color-text-primary)] flex items-center gap-2">
                         {m.first_name} {m.user_id === user?.id && '(You)'}
                         {m.status === 'pending' && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-yellow-warn)]/20 text-[var(--color-yellow-warn)]">PENDING</span>}
                         {sessionByUserId.has(m.user_id) && (
                           <span className="inline-flex items-center gap-1 rounded-full bg-[var(--action-soft)] px-2 py-0.5 text-[9px] font-bold text-[var(--action)]">
                             <Car size={10} aria-hidden="true" /> DRIVING
                           </span>
                         )}
                       </p>
                       <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                         Status: <span className={`font-bold ${getStatusColor(m.safety_status)}`}>{m.safety_status.toUpperCase()}</span>
                       </p>
                       {locationByUserId.get(m.user_id) && (
                         <p className="mt-1 flex items-center gap-1 text-[10px] text-[var(--muted)]">
                           <MapPin size={10} aria-hidden="true" />
                           Updated {new Date(locationByUserId.get(m.user_id)!.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                         </p>
                       )}
                     </button>
                     {isHost && m.user_id !== user?.id && (
                       <div className="flex items-center gap-2">
                         {m.status === 'pending' && (
                           <button onClick={() => handleApprove(m.id, m.first_name)} className="px-2 py-1 bg-[var(--color-green-safe)]/20 text-[var(--color-green-safe)] text-[10px] font-bold rounded">
                             Approve
                           </button>
                         )}
                         <button onClick={() => handleRemove(m.id, m.first_name)} className="px-2 py-1 bg-[var(--color-red-alert)]/20 text-[var(--color-red-alert)] text-[10px] font-bold rounded">
                           Remove
                         </button>
                       </div>
                     )}
                   </div>
                 ))}
               </div>
            </div>

          </div>
        ) : null}
      </div>

      {dangerDraft.open && family && (
        <div className="fixed inset-0 z-[2500] grid place-items-center bg-black/65 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="danger-title">
          <section className="elevated-panel w-full max-w-md overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)] shadow-2xl">
            <div className="flex items-start gap-3 bg-[var(--danger-soft)] p-5">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--danger)] text-white">
                <ShieldAlert size={22} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="danger-title" className="text-lg font-black text-[var(--text)]">Tell your family what is happening</h2>
                <p className="mt-1 text-xs text-[var(--text-soft)]">The alert is sent even when GPS or the street address is temporarily unavailable.</p>
              </div>
              <IconButton variant="ghost" size="sm" disabled={dangerBusy} onClick={() => setDangerDraft(current => ({ ...current, open: false }))} aria-label="Close emergency alert">
                <X size={18} />
              </IconButton>
            </div>

            <div className="space-y-4 p-5">
              <label className="block">
                <span className="mb-2 block text-xs font-bold text-[var(--text)]">Reason</span>
                <textarea
                  autoFocus
                  value={dangerReason}
                  onChange={event => setDangerReason(event.target.value.slice(0, 500))}
                  maxLength={500}
                  rows={4}
                  placeholder="Example: Vehicle broke down on a dark road and I need assistance."
                  className="downlifted-field w-full resize-none rounded-[var(--radius-md)] bg-[var(--surface-alt)] px-3 py-3 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)] focus:ring-2 focus:ring-[var(--danger)]/40"
                />
                <span className="mt-1 block text-right text-[10px] tabular-nums text-[var(--muted)]">{dangerReason.length}/500</span>
              </label>

              <div className="grid gap-2">
                <Button variant="danger" className="min-h-12" disabled={dangerBusy} onClick={() => void submitDangerAlert('urgent_authorities')}>
                  <Phone size={17} aria-hidden="true" /> {dangerBusy ? 'Sending alert…' : 'Urgent — Call Authorities'}
                </Button>
                <Button variant="secondary" className="min-h-12" disabled={dangerBusy} onClick={() => void submitDangerAlert('need_help')}>
                  <Users size={17} aria-hidden="true" /> {dangerBusy ? 'Sending alert…' : 'Need Help'}
                </Button>
              </div>
            </div>
          </section>
        </div>
      )}

      {selectedDriver && (
        <div className="fixed inset-0 z-[2400] grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-5" role="dialog" aria-modal="true" aria-labelledby="driver-title">
          <section className="elevated-panel flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--panel)] shadow-2xl">
            <div className="flex items-start gap-3 p-4 sm:p-5">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--action-soft)] text-[var(--action)]">
                {selectedDriver.safety_status === 'in_danger' ? <ShieldAlert size={20} /> : <Car size={20} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="driver-title" className="text-base font-black text-[var(--text)]">{selectedDriver.first_name}</h2>
                  {selectedDriverSession && <span className="rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-[9px] font-bold text-[var(--success)]">DRIVING</span>}
                  {selectedDriver.safety_status === 'in_danger' && <span className="rounded-full bg-[var(--danger-soft)] px-2 py-0.5 text-[9px] font-bold text-[var(--danger)]">IN DANGER</span>}
                </div>
                <p className="mt-1 truncate text-xs text-[var(--muted)]">{selectedAddress || selectedDriverAlert?.address_label || (selectedDriverLocation ? 'Resolving the current street…' : 'Street address unavailable')}</p>
              </div>
              <IconButton variant="ghost" size="sm" onClick={() => { selectedAddressRequestRef.current += 1; setSelectedDriver(null) }} aria-label="Close member location">
                <X size={18} />
              </IconButton>
            </div>

            <div className="relative h-64 shrink-0 bg-[var(--surface-alt)] sm:h-80">
              {selectedPoint ? (
                <MapContainer
                  key={`${selectedDriver.user_id}-${selectedPoint.latitude}-${selectedPoint.longitude}`}
                  center={[selectedPoint.latitude, selectedPoint.longitude]}
                  zoom={15}
                  maxZoom={CARTO_RASTER_MAX_ZOOM}
                  className="h-full w-full"
                  zoomControl
                >
                  <TileLayer
                    attribution='&copy; OpenStreetMap contributors &copy; CARTO'
                    url={resolvedTheme === 'dark'
                      ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
                      : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'}
                    maxNativeZoom={CARTO_RASTER_MAX_ZOOM}
                    maxZoom={CARTO_RASTER_MAX_ZOOM}
                  />
                  <CircleMarker
                    center={[selectedPoint.latitude, selectedPoint.longitude]}
                    radius={9}
                    pathOptions={{ color: selectedDriver.safety_status === 'in_danger' ? '#ef4444' : '#22c55e', fillOpacity: 0.9, weight: 3 }}
                  >
                    <Popup>{selectedDriver.first_name}'s latest verified device position</Popup>
                  </CircleMarker>
                  {viewerLocation && (
                    <>
                      <CircleMarker center={[viewerLocation.latitude, viewerLocation.longitude]} radius={7} pathOptions={{ color: '#1f6feb', fillOpacity: 0.9, weight: 3 }}>
                        <Popup>Your location</Popup>
                      </CircleMarker>
                      <Polyline positions={[[viewerLocation.latitude, viewerLocation.longitude], [selectedPoint.latitude, selectedPoint.longitude]]} pathOptions={{ color: '#1f6feb', weight: 2, dashArray: '7 7' }} />
                    </>
                  )}
                </MapContainer>
              ) : (
                <div className="grid h-full place-items-center p-6 text-center">
                  <div>
                    <MapPin className="mx-auto text-[var(--muted)]" size={28} />
                    <p className="mt-2 text-sm font-semibold text-[var(--text)]">No location received</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">The safety alert remains active even without GPS.</p>
                  </div>
                </div>
              )}
            </div>

            <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
              {selectedDriverAlert && (
                <div className="mb-4 rounded-[var(--radius-md)] bg-[var(--danger-soft)] p-3 text-sm text-[var(--text)]">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--danger)]">Emergency reason</p>
                  <p className="mt-1 font-semibold">{selectedDriverAlert.reason}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3">
                  <Navigation size={15} className="text-[var(--action)]" />
                  <p className="mt-2 text-[10px] font-bold uppercase text-[var(--muted)]">Distance</p>
                  <p className="mt-0.5 text-sm font-black text-[var(--text)]">{viewerDistanceKm === null ? 'Unavailable' : viewerDistanceKm < 1 ? `${Math.round(viewerDistanceKm * 1000)} m` : `${viewerDistanceKm.toFixed(1)} km`}</p>
                </div>
                <div className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3">
                  <Compass size={15} className="text-[var(--action)]" />
                  <p className="mt-2 text-[10px] font-bold uppercase text-[var(--muted)]">Direction</p>
                  <p className="mt-0.5 text-sm font-black text-[var(--text)]">{compassLabel(selectedDriverLocation?.heading_deg ?? null)}</p>
                </div>
                <div className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3">
                  <Gauge size={15} className="text-[var(--action)]" />
                  <p className="mt-2 text-[10px] font-bold uppercase text-[var(--muted)]">Speed</p>
                  <p className="mt-0.5 text-sm font-black text-[var(--text)]">{selectedDriverLocation?.speed_mps === null || selectedDriverLocation?.speed_mps === undefined ? 'Unavailable' : `${Math.max(0, selectedDriverLocation.speed_mps * 3.6).toFixed(0)} km/h`}</p>
                </div>
                <div className="rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3">
                  <Clock size={15} className={selectedLocationAgeSeconds !== null && selectedLocationAgeSeconds > 60 ? 'text-[var(--warning)]' : 'text-[var(--success)]'} />
                  <p className="mt-2 text-[10px] font-bold uppercase text-[var(--muted)]">Freshness</p>
                  <p className="mt-0.5 text-sm font-black text-[var(--text)]">{selectedLocationAgeSeconds === null ? 'Unavailable' : selectedLocationAgeSeconds < 60 ? `${selectedLocationAgeSeconds}s ago` : `${Math.round(selectedLocationAgeSeconds / 60)}m ago`}</p>
                </div>
              </div>

              {selectedPoint && (
                <p className="mt-3 break-all font-mono text-[10px] text-[var(--muted)]">
                  {selectedPoint.latitude.toFixed(6)}, {selectedPoint.longitude.toFixed(6)}
                  {selectedDriverLocation?.accuracy_m !== null && selectedDriverLocation?.accuracy_m !== undefined ? ` · ±${Math.round(selectedDriverLocation.accuracy_m)} m` : ''}
                </p>
              )}

              {selectedDriverAlert?.urgency === 'urgent_authorities' && (
                <Button variant="danger" className="mt-4 w-full" onClick={() => onNavigate('hotlines')}>
                  <Phone size={16} aria-hidden="true" /> Call authorities
                </Button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
