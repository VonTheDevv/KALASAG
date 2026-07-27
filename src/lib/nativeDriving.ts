import { Capacitor, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export interface NativeDrivingStartOptions {
  supabaseUrl: string;
  publishableKey: string;
  sessionId: string;
  trackingToken: string;
  trackingExpiresAt: string | null;
}

export interface NativeDrivingAvailability {
  native: boolean;
  pushConfigured: boolean;
  coarseLocationPermission: boolean;
  fineLocationPermission: boolean;
  backgroundLocationPermission: boolean;
  notificationPermission: boolean;
  notificationsEnabled: boolean;
  locationEnabled: boolean;
  batteryOptimizationIgnored: boolean;
  accessibilityServiceEnabled: boolean;
  bootReceiverEnabled?: boolean;
  lastBootReceiverAtMs?: number;
  lastBootReceiverAction?: string;
  activeSessionStored: boolean;
  sdkInt?: number;
  reason?: string;
}

export interface NativeDrivingStatus {
  active: boolean;
  restoreRequired?: boolean;
  pendingRevocation?: boolean;
  sessionId?: string;
  lastObservedAt?: number;
  lastUploadedAt?: number;
  lastRecordedAt?: number;
  lastError?: string;
}

interface DrivingLocationPlugin {
  getAvailability(): Promise<NativeDrivingAvailability>;
  isAccessibilityEnabled(): Promise<{ enabled: boolean }>;
  openAppSettings(): Promise<{ opened?: boolean }>;
  openLocationSettings(): Promise<{ opened?: boolean }>;
  openBatteryOptimizationSettings(): Promise<{ opened?: boolean }>;
  openAccessibilitySettings(): Promise<{ opened?: boolean }>;
  start(options: NativeDrivingStartOptions & { trackingExpiresAtMs: number }): Promise<{ native: boolean; active: boolean }>;
  stop(): Promise<{ pendingRevocation: boolean; sessionId?: string }>;
  confirmStopped(options: { sessionId?: string }): Promise<void>;
  getStatus(): Promise<NativeDrivingStatus>;
  consumePushSyncRequired(): Promise<{ required: boolean }>;
  cancelFamilyAlertNotification(options: { familyId: string; reporterUserId: string }): Promise<void>;
}

const DrivingLocation = registerPlugin<DrivingLocationPlugin>('DrivingLocation');

export async function openNativeAppSettings(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  await DrivingLocation.openAppSettings();
}

export async function openNativeLocationSettings(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  await DrivingLocation.openLocationSettings();
}

export async function openNativeBatteryOptimizationSettings(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  await DrivingLocation.openBatteryOptimizationSettings();
}

export async function isNativeAccessibilityEnabled(): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android') return false;
  const result = await DrivingLocation.isAccessibilityEnabled();
  return result.enabled === true;
}

export async function openNativeAccessibilitySettings(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return;
  await DrivingLocation.openAccessibilitySettings();
}

export async function getNativeDrivingAvailability(): Promise<NativeDrivingAvailability> {
  if (Capacitor.getPlatform() !== 'android') {
    return {
      native: false,
      pushConfigured: false,
      coarseLocationPermission: false,
      fineLocationPermission: false,
      backgroundLocationPermission: false,
      notificationPermission: false,
      notificationsEnabled: false,
      locationEnabled: false,
      batteryOptimizationIgnored: false,
      accessibilityServiceEnabled: false,
      activeSessionStored: false,
      reason: 'Background Driving Mode is currently available only in the Android app.',
    };
  }

  try {
    return await DrivingLocation.getAvailability();
  } catch (error) {
    return {
      native: false,
      pushConfigured: false,
      coarseLocationPermission: false,
      fineLocationPermission: false,
      backgroundLocationPermission: false,
      notificationPermission: false,
      notificationsEnabled: false,
      locationEnabled: false,
      batteryOptimizationIgnored: false,
      accessibilityServiceEnabled: false,
      activeSessionStored: false,
      reason: error instanceof Error ? error.message : 'The native Driving Mode plugin is unavailable.',
    };
  }
}

export async function startNativeDriving(
  options: NativeDrivingStartOptions,
): Promise<{ native: boolean }> {
  if (Capacitor.getPlatform() !== 'android') {
    return { native: false };
  }

  const notificationPermission = await LocalNotifications.checkPermissions();
  const resolvedPermission = notificationPermission.display === 'prompt'
    ? await LocalNotifications.requestPermissions()
    : notificationPermission;
  if (resolvedPermission.display !== 'granted') {
    throw new Error('Notification permission is required so Android can show the active Driving Mode service.');
  }

  const trackingExpiresAtMs = options.trackingExpiresAt ? Date.parse(options.trackingExpiresAt) : Number.NaN;
  if (!Number.isFinite(trackingExpiresAtMs) || trackingExpiresAtMs <= Date.now()) {
    throw new Error('The Driving Mode tracking credential is missing a valid expiry time.');
  }

  const result = await DrivingLocation.start({ ...options, trackingExpiresAtMs });
  return { native: result.native };
}

export async function stopNativeDriving(): Promise<{ pendingRevocation: boolean; sessionId?: string }> {
  if (Capacitor.getPlatform() !== 'android') {
    return { pendingRevocation: false };
  }
  return await DrivingLocation.stop();
}

/**
 * Clears the encrypted capability only after an authenticated stop RPC has
 * confirmed that the same server session is no longer active.
 */
export async function confirmNativeDrivingStopped(sessionId?: string): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') {
    return;
  }
  await DrivingLocation.confirmStopped({ sessionId });
}

export async function getNativeDrivingStatus(): Promise<NativeDrivingStatus> {
  if (Capacitor.getPlatform() !== 'android') {
    return { active: false };
  }
  try {
    return await DrivingLocation.getStatus();
  } catch {
    return { active: false, lastError: 'The native Driving Mode service is unavailable.' };
  }
}

export async function consumeNativePushSyncRequired(): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android') {
    return false;
  }
  try {
    const result = await DrivingLocation.consumePushSyncRequired();
    return result.required === true;
  } catch {
    return false;
  }
}

export async function cancelNativeFamilyAlertNotification(
  familyId: string,
  reporterUserId: string,
): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') {
    return;
  }
  await DrivingLocation.cancelFamilyAlertNotification({ familyId, reporterUserId });
}
