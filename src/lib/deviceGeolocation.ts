import { Capacitor } from '@capacitor/core'
import {
  Geolocation,
  type Position as CapacitorPosition,
  type PositionOptions as CapacitorPositionOptions,
} from '@capacitor/geolocation'

export type DevicePosition = CapacitorPosition | GeolocationPosition
export type DeviceLocationWatchId = string | number
export type DevicePositionOptions = CapacitorPositionOptions
export type DeviceLocationPermissionState = 'granted' | 'prompt' | 'denied' | 'unavailable'

const isNative = () => Capacitor.isNativePlatform()
const DEFAULT_FALLBACK_MAXIMUM_AGE_MS = 2 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 2 * 60 * 1_000
let recentPosition: DevicePosition | null = null

function toError(error: unknown, fallback: string) {
  if (error instanceof Error) return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = String((error as { message?: unknown }).message || fallback)
    return new Error(message)
  }
  return new Error(fallback)
}

function nativePermissionState(status: Awaited<ReturnType<typeof Geolocation.checkPermissions>>): DeviceLocationPermissionState {
  if (status.location === 'granted' || status.coarseLocation === 'granted') return 'granted'
  if (
    status.location === 'prompt'
    || status.location === 'prompt-with-rationale'
    || status.coarseLocation === 'prompt'
    || status.coarseLocation === 'prompt-with-rationale'
  ) return 'prompt'
  return 'denied'
}

function isUsablePosition(position: DevicePosition | null): position is DevicePosition {
  if (!position) return false
  const { latitude, longitude, accuracy } = position.coords
  return Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
    && Number.isFinite(longitude)
    && longitude >= -180
    && longitude <= 180
    && Number.isFinite(accuracy)
    && accuracy >= 0
    && Number.isFinite(position.timestamp)
}

function rememberPosition(position: DevicePosition): DevicePosition {
  if (isUsablePosition(position)) recentPosition = position
  return position
}

export async function getDeviceLocationPermissionState(): Promise<DeviceLocationPermissionState> {
  if (isNative()) {
    try {
      return nativePermissionState(await Geolocation.checkPermissions())
    } catch {
      return 'unavailable'
    }
  }

  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unavailable'
  if (!navigator.permissions?.query) return 'prompt'

  try {
    const result = await navigator.permissions.query({ name: 'geolocation' })
    return result.state
  } catch {
    // Some browsers expose geolocation but do not implement its Permissions API
    // descriptor. The first position request remains the source of truth there.
    return 'prompt'
  }
}

export async function requestDeviceLocationPermission(): Promise<DeviceLocationPermissionState> {
  if (!isNative()) {
    const current = await getDeviceLocationPermissionState()
    if (current !== 'prompt') return current
    try {
      await getDevicePosition({ enableHighAccuracy: false, timeout: 8_000, maximumAge: 30_000 })
      return 'granted'
    } catch {
      return await getDeviceLocationPermissionState()
    }
  }

  try {
    const current = nativePermissionState(await Geolocation.checkPermissions())
    if (current === 'granted') return current
    if (current === 'denied') return current
    return nativePermissionState(await Geolocation.requestPermissions({ permissions: ['location'] }))
  } catch {
    return 'unavailable'
  }
}

async function requireNativeLocationPermission() {
  const current = await Geolocation.checkPermissions()
  const state = nativePermissionState(current)
  if (state === 'granted') return

  if (state === 'denied') {
    throw new Error('Location permission is disabled. Enable it in the device app settings and try again.')
  }

  if (await requestDeviceLocationPermission() !== 'granted') {
    throw new Error('Location permission was denied.')
  }
}

function browserOptions(options: DevicePositionOptions): PositionOptions {
  return {
    enableHighAccuracy: options.enableHighAccuracy,
    maximumAge: options.maximumAge,
    timeout: options.timeout,
  }
}

export async function getDevicePosition(
  options: DevicePositionOptions = {},
): Promise<DevicePosition> {
  if (isNative()) {
    try {
      await requireNativeLocationPermission()
      return rememberPosition(await Geolocation.getCurrentPosition(options))
    } catch (error) {
      throw toError(error, 'The device location is unavailable.')
    }
  }

  if (!navigator.geolocation) {
    throw new Error('This device does not provide location services.')
  }

  return await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      position => resolve(rememberPosition(position) as GeolocationPosition),
      error => reject(toError(error, 'The device location is unavailable.')),
      browserOptions(options),
    )
  })
}

export function getRecentDevicePosition(
  maximumAgeMs = DEFAULT_FALLBACK_MAXIMUM_AGE_MS,
): DevicePosition | null {
  if (!isUsablePosition(recentPosition)) return null
  const ageMs = Date.now() - recentPosition.timestamp
  if (ageMs < -MAX_CLOCK_SKEW_MS || ageMs > Math.max(0, maximumAgeMs)) return null
  return recentPosition
}

/**
 * Returns the freshest safe device fix available. A recent warmed fix is used
 * immediately, then precise and coarse acquisitions are attempted in order,
 * and finally a strictly age-bounded cached fix is returned. This keeps an
 * emergency action responsive without turning an old coordinate into a current
 * location.
 */
export async function getBestDevicePosition(
  options: DevicePositionOptions = {},
  fallbackMaximumAgeMs = DEFAULT_FALLBACK_MAXIMUM_AGE_MS,
): Promise<DevicePosition> {
  const preferredMaximumAgeMs = Math.min(
    Math.max(0, options.maximumAge ?? 0),
    Math.max(0, fallbackMaximumAgeMs),
  )
  const warmed = getRecentDevicePosition(preferredMaximumAgeMs)
  if (warmed) return warmed

  let preciseError: unknown = null
  try {
    return await getDevicePosition({ ...options, enableHighAccuracy: true })
  } catch (error) {
    preciseError = error
  }

  try {
    return await getDevicePosition({
      ...options,
      enableHighAccuracy: false,
      maximumAge: Math.max(options.maximumAge ?? 0, Math.min(fallbackMaximumAgeMs, 60_000)),
      timeout: Math.min(options.timeout ?? 5_000, 3_000),
    })
  } catch {
    const fallback = getRecentDevicePosition(fallbackMaximumAgeMs)
    if (fallback) return fallback
    throw toError(preciseError, 'The device location is unavailable.')
  }
}

export async function watchDevicePosition(
  onPosition: (position: DevicePosition) => void,
  onError?: (error: Error) => void,
  options: DevicePositionOptions = {},
): Promise<DeviceLocationWatchId> {
  if (isNative()) {
    try {
      await requireNativeLocationPermission()
      return await Geolocation.watchPosition(options, (position, error) => {
        if (error) {
          onError?.(toError(error, 'The device location is unavailable.'))
          return
        }
        if (position) onPosition(rememberPosition(position))
      })
    } catch (error) {
      throw toError(error, 'Location tracking could not be started.')
    }
  }

  if (!navigator.geolocation) {
    throw new Error('This device does not provide location services.')
  }

  return navigator.geolocation.watchPosition(
    position => onPosition(rememberPosition(position)),
    error => onError?.(toError(error, 'The device location is unavailable.')),
    browserOptions(options),
  )
}

export async function clearDevicePositionWatch(id: DeviceLocationWatchId): Promise<void> {
  if (isNative()) {
    try {
      await Geolocation.clearWatch({ id: String(id) })
    } catch (error) {
      console.warn('Location watch cleanup failed:', toError(error, 'Unknown cleanup error'))
    }
    return
  }

  if (navigator.geolocation && typeof id === 'number') {
    navigator.geolocation.clearWatch(id)
  }
}
