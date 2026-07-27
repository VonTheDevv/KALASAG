import { App } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import { Accessibility, BatteryCharging, BellRing, CheckCircle2, MapPin, Navigation, Settings } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getBestDevicePosition,
  getDeviceLocationPermissionState,
  requestDeviceLocationPermission,
} from '../lib/deviceGeolocation'
import {
  getNativeDrivingAvailability,
  openNativeAppSettings,
  openNativeAccessibilitySettings,
  openNativeBatteryOptimizationSettings,
  openNativeLocationSettings,
  type NativeDrivingAvailability,
} from '../lib/nativeDriving'
import { Button, Panel } from './ui/primitives'

const INITIAL_CHECK_DELAY_MS = 1_350
const AUTO_REQUEST_KEY = 'kalasag_location_permission_requested_v1'
const LATER_SESSION_KEY = 'kalasag_location_permission_later'
const RELIABILITY_PROMPT_KEY = 'kalasag_alert_reliability_prompt_seen_v2'

type LocationIssue = 'permission' | 'services' | 'unavailable'

interface LocationAssessment {
  issue: LocationIssue | null
  detail?: string
}

let assessmentInFlight: Promise<LocationAssessment> | null = null
let requestedDuringThisProcess = false

function readStorage(storage: Storage, key: string) {
  try {
    return storage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeStorage(storage: Storage, key: string, value: boolean) {
  try {
    if (value) storage.setItem(key, '1')
    else storage.removeItem(key)
  } catch {
    // Hardened WebViews may block storage. The permission flow still works for
    // the current component lifetime through the module-level flag above.
  }
}

function messageFrom(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = String((error as { message?: unknown }).message ?? '').trim()
    if (message) return message
  }
  return fallback
}

async function assessNativeLocation(allowAutomaticRequest: boolean): Promise<LocationAssessment> {
  if (assessmentInFlight) return assessmentInFlight

  const assessmentPromise = (async (): Promise<LocationAssessment> => {
    let permission = await getDeviceLocationPermissionState()

    const alreadyRequested = requestedDuringThisProcess || readStorage(window.localStorage, AUTO_REQUEST_KEY)
    if (permission === 'prompt' && allowAutomaticRequest && !alreadyRequested) {
      // Write before invoking Android's dialog so React StrictMode cannot open
      // the runtime permission prompt twice during its development remount.
      requestedDuringThisProcess = true
      writeStorage(window.localStorage, AUTO_REQUEST_KEY, true)
      permission = await requestDeviceLocationPermission()
    }

    if (permission === 'unavailable') {
      return {
        issue: 'unavailable',
        detail: 'This device did not expose Android location services to KALASAG.',
      }
    }

    if (permission !== 'granted') {
      return { issue: 'permission' }
    }

    try {
      // This is a one-shot foreground fix. Continuous or background tracking
      // is started only by an explicit safety feature such as Driving Mode.
      const position = await getBestDevicePosition(
        {
          enableHighAccuracy: true,
          maximumAge: 30_000,
          timeout: 20_000,
          enableLocationFallback: true,
        },
        2 * 60_000,
      )

      window.dispatchEvent(
        new CustomEvent('kalasag:location-readiness', {
          detail: {
            available: true,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
          },
        }),
      )
      return { issue: null }
    } catch (error) {
      const availability = await getNativeDrivingAvailability().catch(() => null)
      if (availability && !availability.locationEnabled) {
        return { issue: 'services' }
      }
      return {
        issue: 'unavailable',
        detail: messageFrom(error, 'Android could not obtain a current GPS fix.'),
      }
    }
  })().finally(() => {
    assessmentInFlight = null
  })

  assessmentInFlight = assessmentPromise
  return assessmentPromise
}

export default function NativeLocationOnboarding() {
  const [assessment, setAssessment] = useState<LocationAssessment>({ issue: null })
  const [deferred, setDeferred] = useState(() => readStorage(window.sessionStorage, LATER_SESSION_KEY))
  const [locationCheckComplete, setLocationCheckComplete] = useState(false)
  const [reliabilityAvailability, setReliabilityAvailability] = useState<NativeDrivingAvailability | null>(null)
  const [showReliabilityPrompt, setShowReliabilityPrompt] = useState(false)
  const [openingSettings, setOpeningSettings] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const returningFromSettingsRef = useRef(false)
  const returningFromReliabilitySettingsRef = useRef(false)
  const primaryActionRef = useRef<HTMLButtonElement>(null)

  const checkLocation = useCallback(async (allowAutomaticRequest: boolean) => {
    try {
      const result = await assessNativeLocation(allowAutomaticRequest)
      if (!mountedRef.current) return
      setAssessment(result)
      if (!result.issue) {
        setDeferred(false)
        writeStorage(window.sessionStorage, LATER_SESSION_KEY, false)
      }
    } catch (error) {
      if (!mountedRef.current) return
      setAssessment({
        issue: 'unavailable',
        detail: messageFrom(error, 'Android location readiness could not be checked.'),
      })
    } finally {
      if (mountedRef.current) setLocationCheckComplete(true)
    }
  }, [])

  const checkReliability = useCallback(async (promptWhenIncomplete: boolean) => {
    if (Capacitor.getPlatform() !== 'android') return

    try {
      const availability = await getNativeDrivingAvailability()
      if (!mountedRef.current) return
      setReliabilityAvailability(availability)

      const ready = availability.pushConfigured
        && availability.notificationPermission
        && availability.notificationsEnabled
        && availability.batteryOptimizationIgnored
        && availability.accessibilityServiceEnabled
        && availability.backgroundLocationPermission

      if (ready) {
        writeStorage(window.localStorage, RELIABILITY_PROMPT_KEY, true)
        setShowReliabilityPrompt(false)
        setSettingsError(null)
        return
      }

      if (promptWhenIncomplete || !readStorage(window.localStorage, RELIABILITY_PROMPT_KEY)) {
        setShowReliabilityPrompt(true)
      }
    } catch (error) {
      if (!mountedRef.current) return
      setSettingsError(messageFrom(error, 'Android alert readiness could not be checked.'))
      if (promptWhenIncomplete || !readStorage(window.localStorage, RELIABILITY_PROMPT_KEY)) {
        setShowReliabilityPrompt(true)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    if (!Capacitor.isNativePlatform()) return

    const timer = window.setTimeout(() => {
      void checkLocation(true)
    }, INITIAL_CHECK_DELAY_MS)

    let listener: PluginListenerHandle | null = null
    let disposed = false
    void App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) return

      const returningFromSettings = returningFromSettingsRef.current
      const returningFromReliabilitySettings = returningFromReliabilitySettingsRef.current
      returningFromSettingsRef.current = false
      returningFromReliabilitySettingsRef.current = false
      setOpeningSettings(false)
      setSettingsError(null)
      if (returningFromSettings) {
        setDeferred(false)
        writeStorage(window.sessionStorage, LATER_SESSION_KEY, false)
      }
      void checkLocation(false)
      if (returningFromReliabilitySettings) {
        void checkReliability(true)
      }
    }).then(handle => {
      if (disposed) void handle.remove()
      else listener = handle
    })

    return () => {
      mountedRef.current = false
      disposed = true
      window.clearTimeout(timer)
      if (listener) void listener.remove()
    }
  }, [checkLocation, checkReliability])

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !locationCheckComplete) return
    if (assessment.issue !== null && !deferred) return
    void checkReliability(false)
  }, [assessment.issue, checkReliability, deferred, locationCheckComplete])

  const locationVisible = Capacitor.isNativePlatform() && assessment.issue !== null && !deferred
  const reliabilityVisible = Capacitor.getPlatform() === 'android'
    && showReliabilityPrompt
    && !locationVisible
  const visible = locationVisible || reliabilityVisible

  useEffect(() => {
    if (!visible) return
    const timer = window.setTimeout(() => primaryActionRef.current?.focus(), 40)
    const activeDialog = locationVisible ? 'location' : 'reliability'
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const dialog = window.document.querySelector<HTMLElement>(`[data-native-onboarding-dialog="${activeDialog}"]`)
      const focusable = dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      if (!dialog || !focusable?.length) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = window.document.activeElement
      if (!dialog.contains(activeElement)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.document.addEventListener('keydown', trapFocus)
    return () => {
      window.clearTimeout(timer)
      window.document.removeEventListener('keydown', trapFocus)
    }
  }, [locationVisible, reliabilityVisible, visible])

  const handleLater = useCallback(() => {
    setDeferred(true)
    setSettingsError(null)
    writeStorage(window.sessionStorage, LATER_SESSION_KEY, true)
  }, [])

  const handleReliabilityLater = useCallback(() => {
    writeStorage(window.localStorage, RELIABILITY_PROMPT_KEY, true)
    setShowReliabilityPrompt(false)
    setSettingsError(null)
  }, [])

  const handleOpenSettings = useCallback(async () => {
    if (!assessment.issue) return
    setOpeningSettings(true)
    setSettingsError(null)
    returningFromSettingsRef.current = true

    try {
      if (assessment.issue === 'permission') {
        await openNativeAppSettings()
      } else {
        try {
          await openNativeLocationSettings()
        } catch {
          await openNativeAppSettings()
        }
      }
    } catch (error) {
      returningFromSettingsRef.current = false
      setOpeningSettings(false)
      setSettingsError(messageFrom(error, 'Android settings could not be opened.'))
    }
  }, [assessment.issue])

  const handleOpenReliabilitySettings = useCallback(async (
    destination: 'permissions' | 'battery' | 'accessibility',
  ) => {
    setOpeningSettings(true)
    setSettingsError(null)
    returningFromReliabilitySettingsRef.current = true

    try {
      if (destination === 'permissions') await openNativeAppSettings()
      else if (destination === 'battery') await openNativeBatteryOptimizationSettings()
      else await openNativeAccessibilitySettings()
    } catch (error) {
      returningFromReliabilitySettingsRef.current = false
      setOpeningSettings(false)
      setSettingsError(messageFrom(error, 'Android reliability settings could not be opened.'))
    }
  }, [])

  const handleRequestNotifications = useCallback(async () => {
    setOpeningSettings(true)
    setSettingsError(null)
    try {
      const current = await PushNotifications.checkPermissions()
      const permission = current.receive === 'prompt' || current.receive === 'prompt-with-rationale'
        ? await PushNotifications.requestPermissions()
        : current

      if (permission.receive !== 'granted') {
        returningFromReliabilitySettingsRef.current = true
        await openNativeAppSettings()
        return
      }

      window.dispatchEvent(new CustomEvent('kalasag:notification-readiness', {
        detail: { granted: true },
      }))
      await checkReliability(true)
      setOpeningSettings(false)
    } catch (error) {
      returningFromReliabilitySettingsRef.current = false
      setOpeningSettings(false)
      setSettingsError(messageFrom(error, 'Notification permission could not be requested.'))
    }
  }, [checkReliability])

  if (!visible) return null

  if (reliabilityVisible) {
    const notificationsReady = Boolean(
      reliabilityAvailability?.pushConfigured
      && reliabilityAvailability.notificationPermission
      && reliabilityAvailability.notificationsEnabled,
    )
    const backgroundRestoreReady = Boolean(reliabilityAvailability?.backgroundLocationPermission)
    const batteryReady = Boolean(reliabilityAvailability?.batteryOptimizationIgnored)
    const accessibilityReady = Boolean(reliabilityAvailability?.accessibilityServiceEnabled)

    return (
      <div
        className="fixed inset-0 z-[100000] grid place-items-end bg-[var(--overlay)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:place-items-center sm:p-5"
        role="presentation"
      >
        <Panel
          data-native-onboarding-dialog="reliability"
          role="dialog"
          aria-modal="true"
          aria-labelledby="native-reliability-title"
          aria-describedby="native-reliability-description"
          className="animate-scale-in max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto p-4 sm:p-6"
        >
          <div className="flex items-start gap-3.5">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--action-soft)] text-[var(--action)]">
              <BellRing size={21} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-data text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--action)]">
                First-start safety setup
              </p>
              <h2 id="native-reliability-title" className="mt-1 text-xl font-bold text-[var(--text)]">
                Improve alert reliability
              </h2>
              <p id="native-reliability-description" className="mt-2 text-sm leading-5 text-[var(--text-soft)]">
                Allow notifications so family danger alerts can appear when KALASAG is closed. The remaining settings are optional and apply to active Driving Mode.
              </p>
            </div>
          </div>

          <div className="mt-4 divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius-md)] bg-[var(--surface-alt)] px-3">
            <div className="flex min-h-12 items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[var(--text-soft)]">
                {notificationsReady
                  ? <CheckCircle2 className="shrink-0 text-[var(--success)]" size={17} aria-hidden="true" />
                  : <BellRing className="shrink-0 text-[var(--warning)]" size={17} aria-hidden="true" />}
                Alert notifications
              </span>
              <Button
                variant={notificationsReady ? 'secondary' : 'primary'}
                className="min-h-9 shrink-0 px-2.5 text-[10px]"
                disabled={openingSettings || notificationsReady}
                onClick={() => void handleRequestNotifications()}
              >
                {notificationsReady ? 'Ready' : 'Allow'}
              </Button>
            </div>

            <div className="flex min-h-12 items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[var(--text-soft)]">
                {backgroundRestoreReady
                  ? <CheckCircle2 className="shrink-0 text-[var(--success)]" size={17} aria-hidden="true" />
                  : <MapPin className="shrink-0 text-[var(--muted)]" size={17} aria-hidden="true" />}
                Driving Mode after reboot
              </span>
              <Button
                variant="secondary"
                className="min-h-9 shrink-0 px-2.5 text-[10px]"
                disabled={openingSettings || backgroundRestoreReady}
                onClick={() => void handleOpenReliabilitySettings('permissions')}
              >
                {backgroundRestoreReady ? 'Allowed' : 'Permissions'}
              </Button>
            </div>

            <div className="flex min-h-12 items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[var(--text-soft)]">
                {batteryReady
                  ? <CheckCircle2 className="shrink-0 text-[var(--success)]" size={17} aria-hidden="true" />
                  : <BatteryCharging className="shrink-0 text-[var(--muted)]" size={17} aria-hidden="true" />}
                Driving Mode battery access
              </span>
              <Button
                variant="secondary"
                className="min-h-9 shrink-0 px-2.5 text-[10px]"
                disabled={openingSettings || batteryReady}
                onClick={() => void handleOpenReliabilitySettings('battery')}
              >
                {batteryReady ? 'Unrestricted' : 'Settings'}
              </Button>
            </div>

            <div className="flex min-h-12 items-center justify-between gap-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-[var(--text-soft)]">
                {accessibilityReady
                  ? <CheckCircle2 className="shrink-0 text-[var(--success)]" size={17} aria-hidden="true" />
                  : <Accessibility className="shrink-0 text-[var(--muted)]" size={17} aria-hidden="true" />}
                Optional Driving Mode helper
              </span>
              <Button
                variant="secondary"
                className="min-h-9 shrink-0 px-2.5 text-[10px]"
                disabled={openingSettings || accessibilityReady}
                onClick={() => void handleOpenReliabilitySettings('accessibility')}
              >
                {accessibilityReady ? 'Enabled' : 'Settings'}
              </Button>
            </div>
          </div>

          <p className="mt-3 text-[11px] leading-4 text-[var(--muted)]">
            Family push alerts do not require background location or Accessibility. “Allow all the time” and the optional helper only support a Driving Mode session you explicitly started. Android registers KALASAG's push service and boot receiver automatically; there is no standard autostart switch. Force-stop blocks delivery until the app is opened again.
          </p>

          {settingsError && (
            <p className="mt-4 rounded-[var(--radius-md)] bg-[var(--danger-soft)] px-3.5 py-3 text-sm text-[var(--danger)]" role="alert">
              {settingsError}
            </p>
          )}

          <div className="mt-4">
            <Button
              ref={primaryActionRef}
              className="w-full"
              disabled={openingSettings}
              onClick={handleReliabilityLater}
            >
              {notificationsReady ? 'Finish setup' : 'Continue without changes'}
            </Button>
          </div>
        </Panel>
      </div>
    )
  }

  const permissionIssue = assessment.issue === 'permission'
  const servicesIssue = assessment.issue === 'services'
  const title = permissionIssue
    ? 'Allow location access'
    : servicesIssue
      ? 'Turn on device location'
      : 'Location is not ready'
  const description = permissionIssue
    ? 'KALASAG does not currently have location permission. Until it is enabled, danger alerts may be sent without coordinates or a street address.'
    : servicesIssue
      ? 'Location permission is allowed, but Android location services are turned off. Turn them on so KALASAG can attach your current position to safety alerts.'
      : 'KALASAG could not obtain a current GPS fix. Check Android location settings before relying on street-level family alerts.'
  const settingsLabel = permissionIssue ? 'Open app permissions' : 'Open location settings'

  return (
    <div
      className="fixed inset-0 z-[100000] grid place-items-end bg-[var(--overlay)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:place-items-center sm:p-5"
      role="presentation"
    >
      <Panel
        data-native-onboarding-dialog="location"
        role="dialog"
        aria-modal="true"
        aria-labelledby="native-location-title"
        aria-describedby="native-location-description"
        className="animate-scale-in max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto p-5 sm:p-6"
      >
        <div className="flex items-start gap-3.5">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--action-soft)] text-[var(--action)]">
            {servicesIssue ? <Navigation size={21} aria-hidden="true" /> : <MapPin size={21} aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-data text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--action)]">
              Location readiness
            </p>
            <h2 id="native-location-title" className="mt-1 text-xl font-bold text-[var(--text)]">
              {title}
            </h2>
            <p id="native-location-description" className="mt-2 text-sm leading-6 text-[var(--text-soft)]">
              {description}
            </p>
          </div>
        </div>

        {assessment.detail && (
          <p className="mt-4 rounded-[var(--radius-md)] bg-[var(--surface-alt)] px-3.5 py-3 text-xs leading-5 text-[var(--muted)]">
            {assessment.detail}
          </p>
        )}

        {settingsError && (
          <p className="mt-4 rounded-[var(--radius-md)] bg-[var(--danger-soft)] px-3.5 py-3 text-sm text-[var(--danger)]" role="alert">
            {settingsError}
          </p>
        )}

        <div className="mt-5 grid gap-2.5 sm:grid-cols-[1fr_auto]">
          <Button
            ref={primaryActionRef}
            busy={openingSettings}
            leadingIcon={<Settings size={17} aria-hidden="true" />}
            onClick={() => void handleOpenSettings()}
          >
            {settingsLabel}
          </Button>
          <Button variant="secondary" disabled={openingSettings} onClick={handleLater}>
            Later
          </Button>
        </div>

        <p className="mt-4 text-center text-[11px] leading-4 text-[var(--muted)]">
          This check uses one foreground GPS fix. Background tracking starts only when you explicitly enable a safety feature.
        </p>
      </Panel>
    </div>
  )
}
