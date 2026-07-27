import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import {
  cancelNativeFamilyAlertNotification,
  consumeNativePushSyncRequired,
  getNativeDrivingAvailability,
} from './nativeDriving';
import { supabase } from './supabase';

export interface PushInitializationOptions {
  onAction?: (payload: Record<string, unknown>) => void;
}

export interface FamilyDangerNotification {
  id: string;
  replacementKey?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

let actionCallback: ((payload: Record<string, unknown>) => void) | null = null;
const listenerHandles: PluginListenerHandle[] = [];
let initializedResult: { available: boolean; token?: string; reason?: string } | null = null;
let initialization: Promise<{ available: boolean; token?: string; reason?: string }> | null = null;
const INSTALLATION_ID_KEY = 'kalasag_installation_id';
const PENDING_TOKEN_INVALIDATION_KEY = 'kalasag_push_token_invalidation_pending';
let pendingRetryListenerInstalled = false;

function localStorageValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setLocalStorageValue(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Persistence is best effort in privacy-restricted browser contexts.
  }
}

export function getOrCreateFamilyPushInstallationId(): string {
  const existing = localStorageValue(INSTALLATION_ID_KEY);
  if (existing) return existing;
  const installationId = crypto.randomUUID();
  setLocalStorageValue(INSTALLATION_ID_KEY, installationId);
  return installationId;
}

export function getCurrentFamilyPushInstallationId(): string | null {
  return localStorageValue(INSTALLATION_ID_KEY);
}

async function invalidateNativePushToken(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await Promise.race([
      PushNotifications.unregister(),
      new Promise<never>((_, reject) => window.setTimeout(
        () => reject(new Error('Push token invalidation timed out.')),
        8_000,
      )),
    ]);
    initializedResult = null;
    initialization = null;
    return true;
  } catch {
    return false;
  }
}

async function retryPendingNativeTokenInvalidation(): Promise<boolean> {
  if (localStorageValue(PENDING_TOKEN_INVALIDATION_KEY) !== '1') return true;
  if (await invalidateNativePushToken()) {
    setLocalStorageValue(PENDING_TOKEN_INVALIDATION_KEY, null);
    return true;
  }
  return false;
}

function ensurePendingRetryListener(): void {
  if (pendingRetryListenerInstalled || typeof window === 'undefined') return;
  pendingRetryListenerInstalled = true;
  window.addEventListener('online', () => { void retryPendingNativeTokenInvalidation(); });
}

export async function resumePendingPushPrivacyCleanup(): Promise<void> {
  ensurePendingRetryListener();
  await retryPendingNativeTokenInvalidation();
}

export interface PushSignOutCleanup {
  serverUnregistered: boolean;
  deviceTokenInvalidated: boolean;
  pending: boolean;
}

/**
 * Deactivates this installation while the user's JWT still exists. If the
 * server is unreachable, deleting the native FCM/APNS token prevents the old
 * database registration from delivering and is retried after connectivity
 * returns.
 */
export async function unregisterFamilyPushForSignOut(): Promise<PushSignOutCleanup> {
  actionCallback = null;
  initializedResult = null;
  initialization = null;
  const installationId = getCurrentFamilyPushInstallationId();

  let serverUnregistered = installationId === null;
  if (installationId) {
    try {
      const result = await Promise.race([
        supabase.rpc('unregister_family_push_token', { p_installation_id: installationId }),
        new Promise<never>((_, reject) => window.setTimeout(
          () => reject(new Error('Push token unregistration timed out.')),
          5_000,
        )),
      ]);
      serverUnregistered = !result.error;
    } catch {
      serverUnregistered = false;
    }
  }

  // Always rotate the platform token on native signout, even after a
  // successful database deactivation. This closes queued-delivery races on a
  // shared device and ensures the next account receives a fresh token.
  const deviceTokenInvalidated = await invalidateNativePushToken();
  const pending = Capacitor.isNativePlatform() && !deviceTokenInvalidated;
  setLocalStorageValue(PENDING_TOKEN_INVALIDATION_KEY, pending ? '1' : null);
  if (pending) ensurePendingRetryListener();
  return { serverUnregistered, deviceTokenInvalidated, pending };
}

function messageFrom(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return 'Push notification registration failed.';
}

function notifyAction(payload: Record<string, unknown>): void {
  actionCallback?.(payload);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('kalasag:notification-action', { detail: payload }));
  }
}

async function createAndroidChannels(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') {
    return;
  }

  await LocalNotifications.createChannel({
    id: 'family_activity',
    name: 'Family activity',
    description: 'Driving status and routine family safety updates',
    importance: 3,
    visibility: 0,
    vibration: true,
  });
  await LocalNotifications.createChannel({
    id: 'family_danger_v2',
    name: 'Family danger alerts',
    description: 'Urgent alerts from family members who need help',
    importance: 5,
    visibility: 0,
    vibration: true,
    lights: true,
    lightColor: '#FF3B30',
  });
}

async function installListeners(): Promise<void> {
  if (listenerHandles.length > 0) {
    return;
  }

  listenerHandles.push(
    await PushNotifications.addListener('registration', ({ value }) => {
      if (!value) return;
      // FCM may rotate a registration token while this WebView remains alive.
      // Keep the cached initialization result current so the provider can
      // idempotently upsert the replacement token on the next readiness event.
      initializedResult = { available: true, token: value };
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('kalasag:notification-readiness', {
            detail: { granted: true, tokenChanged: true },
          }),
        );
      }
    }),
  );
  listenerHandles.push(
    await PushNotifications.addListener('pushNotificationReceived', () => {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kalasag:family-safety-refresh'));
      }
    }),
  );
  listenerHandles.push(
    await PushNotifications.addListener('pushNotificationActionPerformed', (event) => {
      notifyAction({
        ...((event.notification.data ?? {}) as Record<string, unknown>),
        source: 'push',
        actionId: event.actionId,
        notificationId: event.notification.id,
        title: event.notification.title,
        body: event.notification.body,
      });
    }),
  );
  listenerHandles.push(
    await LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
      notifyAction({
        ...((event.notification.extra ?? {}) as Record<string, unknown>),
        source: 'local',
        actionId: event.actionId,
        notificationId: event.notification.id,
        title: event.notification.title,
        body: event.notification.body,
      });
    }),
  );
  listenerHandles.push(
    await App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive || typeof window === 'undefined') {
        return;
      }
      void PushNotifications.checkPermissions().then(({ receive }) => {
        window.dispatchEvent(
          new CustomEvent('kalasag:notification-readiness', {
            detail: { granted: receive === 'granted' },
          }),
        );
      });
    }),
  );
}

async function registerForPush(): Promise<{ available: boolean; token?: string; reason?: string }> {
  if (!Capacitor.isNativePlatform()) {
    return { available: false, reason: 'Push notifications require the installed mobile app.' };
  }

  // Local danger alerts and their tap actions remain useful when Firebase has
  // not yet been provisioned, so install this plumbing before the FCM check.
  await createAndroidChannels();
  await installListeners();
  if (await consumeNativePushSyncRequired() && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('kalasag:family-safety-refresh'));
  }

  if (Capacitor.getPlatform() === 'android') {
    const availability = await getNativeDrivingAvailability();
    if (!availability.pushConfigured) {
      return {
        available: false,
        reason: 'Firebase is not configured in this Android build. Add android/app/google-services.json and rebuild.',
      };
    }
  }

  const currentPermission = await PushNotifications.checkPermissions();
  const permission = currentPermission.receive === 'prompt'
    ? await PushNotifications.requestPermissions()
    : currentPermission;
  if (permission.receive !== 'granted') {
    return { available: false, reason: 'Notification permission was not granted.' };
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { available: boolean; token?: string; reason?: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      void registrationHandle.then((handle) => handle.remove());
      void errorHandle.then((handle) => handle.remove());
      resolve(result);
    };

    const registrationHandle = PushNotifications.addListener('registration', ({ value }) => {
      finish({ available: true, token: value });
    });
    const errorHandle = PushNotifications.addListener('registrationError', ({ error }) => {
      finish({ available: false, reason: error || 'Firebase registration failed.' });
    });
    const timeout = window.setTimeout(() => {
      finish({ available: false, reason: 'Push registration timed out.' });
    }, 15_000);

    void PushNotifications.register().catch((error: unknown) => {
      finish({ available: false, reason: messageFrom(error) });
    });
  });
}

export async function initializePushNotifications(
  options: PushInitializationOptions = {},
): Promise<{ available: boolean; token?: string; reason?: string }> {
  ensurePendingRetryListener();
  if (!await retryPendingNativeTokenInvalidation()) {
    return {
      available: false,
      reason: 'A previous account notification token is still being removed. Reconnect and try again.',
    };
  }
  if (options.onAction) {
    actionCallback = options.onAction;
  }
  if (initializedResult) {
    return initializedResult;
  }
  if (!initialization) {
    initialization = registerForPush()
      .catch((error: unknown) => ({ available: false, reason: messageFrom(error) }))
      .then((result) => {
        if (result.available) {
          initializedResult = result;
        } else {
          // Permission and device configuration can change while the app is
          // running, so an unavailable result must remain retryable.
          initialization = null;
        }
        return result;
      });
  }
  return await initialization;
}

export async function showFamilyDangerNotification(
  notification: FamilyDangerNotification,
): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return false;
  }

  const permission = await LocalNotifications.checkPermissions();
  const resolvedPermission = permission.display === 'prompt'
    ? await LocalNotifications.requestPermissions()
    : permission;
  if (resolvedPermission.display !== 'granted') {
    return false;
  }

  await createAndroidChannels();
  await LocalNotifications.schedule({
    notifications: [{
      id: stableNotificationId(notification.replacementKey || notification.id),
      title: notification.title,
      body: notification.body,
      channelId: 'family_danger_v2',
      smallIcon: 'ic_stat_kalasag',
      extra: notification.data,
    }],
  });
  return true;
}

export async function cancelFamilyDangerNotification(
  familyId: string,
  reporterUserId: string,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    return;
  }

  const replacementKey = `${familyId}:${reporterUserId}`;
  await Promise.allSettled([
    LocalNotifications.cancel({
      notifications: [{ id: stableNotificationId(replacementKey) }],
    }),
    cancelNativeFamilyAlertNotification(familyId, reporterUserId),
  ]);
}

function stableNotificationId(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  if (hash === -2_147_483_648) {
    return 2_147_483_647;
  }
  return Math.abs(hash || 1);
}
