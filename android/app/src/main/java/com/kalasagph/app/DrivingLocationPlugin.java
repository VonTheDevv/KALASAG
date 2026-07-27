package com.kalasagph.app;

import android.Manifest;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.accessibility.AccessibilityManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.UUID;
import java.util.List;

@CapacitorPlugin(name = "DrivingLocation")
public class DrivingLocationPlugin extends Plugin {
    // ACTION_ACCESSIBILITY_DETAILS_SETTINGS is a platform SystemApi rather
    // than part of the public SDK, so use its stable platform action string
    // and always retain the documented public-settings fallback.
    private static final String ACTION_ACCESSIBILITY_DETAILS_SETTINGS =
        "android.settings.ACCESSIBILITY_DETAILS_SETTINGS";

    @PluginMethod
    public void getAvailability(PluginCall call) {
        JSObject result = new JSObject();
        result.put("native", true);
        result.put("pushConfigured", BuildConfig.HAS_GOOGLE_SERVICES);
        result.put("coarseLocationPermission", hasAndroidPermission(Manifest.permission.ACCESS_COARSE_LOCATION));
        result.put("fineLocationPermission", hasAndroidPermission(Manifest.permission.ACCESS_FINE_LOCATION));
        result.put("backgroundLocationPermission", hasBackgroundLocationPermission());
        result.put("notificationPermission", hasNotificationPermission());
        result.put("notificationsEnabled", notificationsEnabled());
        result.put("locationEnabled", locationEnabled());
        result.put("batteryOptimizationIgnored", batteryOptimizationIgnored());
        result.put("activeSessionStored", hasRestorableActiveSession());
        result.put("accessibilityServiceEnabled", accessibilityServiceEnabled());
        result.put("bootReceiverEnabled", bootReceiverEnabled());
        result.put("lastBootReceiverAtMs", BootReliabilityState.lastReceivedAt(getContext()));
        result.put("lastBootReceiverAction", BootReliabilityState.lastAction(getContext()));
        result.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(result);
    }

    @PluginMethod
    public void isAccessibilityEnabled(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", accessibilityServiceEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            try {
                ComponentName service = new ComponentName(getContext(), KalasagAccessibilityService.class);
                Intent detailsIntent = new Intent(ACTION_ACCESSIBILITY_DETAILS_SETTINGS)
                    .putExtra(Intent.EXTRA_COMPONENT_NAME, service.flattenToString())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(detailsIntent);
                JSObject result = new JSObject();
                result.put("opened", true);
                call.resolve(result);
                return;
            } catch (RuntimeException ignored) {
                // AOSP protects this detail screen with a system permission;
                // some OEM builds expose it. Fall back to the public list.
            }
        }
        launchSettings(
            new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
            call,
            "Accessibility settings are unavailable on this device"
        );
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", getContext().getPackageName(), null)
        );
        launchSettings(intent, call, "Application settings are unavailable on this device");
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        launchSettings(
            new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS),
            call,
            "Location settings are unavailable on this device"
        );
    }

    @PluginMethod
    public void openBatteryOptimizationSettings(PluginCall call) {
        // Open the system-managed list instead of requesting a silent or
        // automatic exemption. The user remains in control of the setting.
        launchSettings(
            new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            call,
            "Battery optimization settings are unavailable on this device"
        );
    }

    @PluginMethod
    public void start(PluginCall call) {
        String supabaseUrl = normalizedUrl(call.getString("supabaseUrl"));
        String publishableKey = trimmed(call.getString("publishableKey"));
        String sessionId = trimmed(call.getString("sessionId"));
        String trackingToken = trimmed(call.getString("trackingToken"));
        Long trackingExpiresAtMs = call.getLong("trackingExpiresAtMs");

        if (supabaseUrl == null) {
            call.reject("A valid HTTPS Supabase URL is required", "invalid_supabase_url");
            return;
        }
        if (publishableKey == null || publishableKey.length() < 20 || publishableKey.length() > 2048) {
            call.reject("A valid Supabase publishable key is required", "invalid_publishable_key");
            return;
        }
        if (!isUuid(sessionId)) {
            call.reject("A valid driving session ID is required", "invalid_session_id");
            return;
        }
        if (trackingToken == null || !trackingToken.matches("^[0-9a-f]{64}$")) {
            call.reject("A valid session tracking token is required", "invalid_tracking_token");
            return;
        }
        long now = System.currentTimeMillis();
        if (trackingExpiresAtMs == null || trackingExpiresAtMs <= now || trackingExpiresAtMs > now + 24L * 60L * 60L * 1_000L) {
            call.reject("A valid tracking capability expiry is required", "invalid_tracking_expiry");
            return;
        }
        if (!hasAndroidPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            call.reject("Precise location permission is required before Driving Mode can start", "location_permission_required");
            return;
        }
        if (!hasNotificationPermission() || !notificationsEnabled()) {
            call.reject("Notification permission is required so Android can show the active Driving Mode service", "notification_permission_required");
            return;
        }
        if (!locationEnabled()) {
            call.reject("Turn on device location before starting Driving Mode", "location_services_disabled");
            return;
        }

        try {
            DrivingCredentialStore.Credentials existing = DrivingCredentialStore.load(getContext());
            if (existing != null && DrivingCredentialStore.isStopRequested(getContext())) {
                call.reject("A previous Driving Mode stop is still being confirmed", "revocation_pending");
                return;
            }
            DrivingCredentialStore.save(
                getContext(),
                new DrivingCredentialStore.Credentials(
                    supabaseUrl,
                    publishableKey,
                    sessionId,
                    trackingToken,
                    trackingExpiresAtMs
                )
            );
            DrivingRevocationJobService.cancel(getContext());
            NotificationChannels.ensure(getContext());
            Intent intent = new Intent(getContext(), DrivingLocationService.class)
                .setAction(DrivingLocationService.ACTION_START);
            ContextCompat.startForegroundService(getContext(), intent);

            JSObject result = new JSObject();
            result.put("native", true);
            result.put("active", true);
            call.resolve(result);
        } catch (Exception error) {
            DrivingCredentialStore.clear(getContext());
            call.reject("Driving Mode credentials could not be secured on this device", "secure_storage_failed", error);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(getContext());
        JSObject result = new JSObject();
        if (credentials == null) {
            getContext().stopService(new Intent(getContext(), DrivingLocationService.class));
            DrivingLocationService.clearRuntimeStatus(getContext(), null);
            result.put("pendingRevocation", false);
            call.resolve(result);
            return;
        }

        // Synchronous persistence closes the race where Android kills the web
        // process immediately after logout but before the service sees intent.
        DrivingCredentialStore.markStopRequested(getContext());
        Intent intent = new Intent(getContext(), DrivingLocationService.class)
            .setAction(DrivingLocationService.ACTION_STOP_WITH_TOKEN);
        ContextCompat.startForegroundService(getContext(), intent);
        result.put("pendingRevocation", true);
        result.put("sessionId", credentials.sessionId);
        call.resolve(result);
    }

    @PluginMethod
    public void confirmStopped(PluginCall call) {
        String expectedSessionId = trimmed(call.getString("sessionId"));
        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(getContext());
        if (credentials != null && (expectedSessionId == null || credentials.sessionId.equals(expectedSessionId))) {
            DrivingCredentialStore.clear(getContext());
            DrivingRevocationJobService.cancel(getContext());
            getContext().stopService(new Intent(getContext(), DrivingLocationService.class));
            DrivingLocationService.clearRuntimeStatus(getContext(), null);
        }
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = DrivingLocationService.readRuntimeStatus(getContext());
        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(getContext());
        boolean pendingRevocation = credentials != null && DrivingCredentialStore.isStopRequested(getContext());
        boolean active = result.optBoolean("active", false) && credentials != null && !pendingRevocation;
        result.put("active", active);
        result.put("pendingRevocation", pendingRevocation);
        if (active || pendingRevocation) {
            result.put("sessionId", credentials.sessionId);
        } else {
            result.remove("sessionId");
        }
        call.resolve(result);
    }

    @PluginMethod
    public void cancelFamilyAlertNotification(PluginCall call) {
        String familyId = trimmed(call.getString("familyId"));
        String reporterUserId = trimmed(call.getString("reporterUserId"));
        if (!isUuid(familyId) || !isUuid(reporterUserId)) {
            call.reject("Valid family and reporter IDs are required", "invalid_notification_identity");
            return;
        }

        NotificationManager manager =
            (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            // Firebase Messaging 25 uses ID 0 whenever an explicit FCM tag is
            // supplied. Keep this tag identical to family-alert-dispatch.
            manager.cancel("family-alert-" + familyId + "-" + reporterUserId, 0);
        }
        call.resolve();
    }

    @PluginMethod
    public void consumePushSyncRequired(PluginCall call) {
        JSObject result = new JSObject();
        result.put(
            "required",
            KalasagMessagingService.consumeFullSyncRequired(getContext())
        );
        call.resolve(result);
    }

    private boolean hasAndroidPermission(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasAndroidPermission(Manifest.permission.POST_NOTIFICATIONS);
    }

    private boolean hasBackgroundLocationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || hasAndroidPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION);
    }

    private boolean batteryOptimizationIgnored() {
        PowerManager manager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return manager != null && manager.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private boolean hasRestorableActiveSession() {
        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(getContext());
        return credentials != null
            && credentials.trackingExpiresAtMs > System.currentTimeMillis()
            && !DrivingCredentialStore.isStopRequested(getContext());
    }

    private boolean accessibilityServiceEnabled() {
        AccessibilityManager manager =
            (AccessibilityManager) getContext().getSystemService(Context.ACCESSIBILITY_SERVICE);
        if (manager == null || !manager.isEnabled()) {
            return false;
        }

        ComponentName expected = new ComponentName(getContext(), KalasagAccessibilityService.class);
        List<AccessibilityServiceInfo> enabledServices =
            manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
        for (AccessibilityServiceInfo info : enabledServices) {
            if (info == null || info.getResolveInfo() == null) continue;
            ServiceInfo serviceInfo = info.getResolveInfo().serviceInfo;
            if (serviceInfo == null) continue;
            ComponentName enabled = new ComponentName(serviceInfo.packageName, serviceInfo.name);
            if (expected.equals(enabled)) {
                return true;
            }
        }
        return false;
    }

    private boolean bootReceiverEnabled() {
        try {
            ComponentName receiver = new ComponentName(getContext(), DrivingSessionRestoreReceiver.class);
            getContext().getPackageManager().getReceiverInfo(receiver, 0);
            int state = getContext().getPackageManager().getComponentEnabledSetting(receiver);
            return state != PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                && state != PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER;
        } catch (PackageManager.NameNotFoundException ignored) {
            return false;
        }
    }

    private boolean notificationsEnabled() {
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
    }

    private boolean locationEnabled() {
        LocationManager manager = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return manager.isLocationEnabled();
        }
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
            || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }

    private void launchSettings(Intent intent, PluginCall call, String errorMessage) {
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("opened", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(errorMessage, "settings_unavailable", error);
        }
    }

    private static String normalizedUrl(String value) {
        return TrustedSupabaseEndpoint.normalize(value);
    }

    private static String trimmed(String value) {
        if (value == null) {
            return null;
        }
        String result = value.trim();
        return result.isEmpty() ? null : result;
    }

    private static boolean isUuid(String value) {
        if (value == null) {
            return false;
        }
        try {
            return UUID.fromString(value).toString().equalsIgnoreCase(value);
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }
}
