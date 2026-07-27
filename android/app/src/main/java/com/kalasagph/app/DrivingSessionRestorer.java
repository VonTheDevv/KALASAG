package com.kalasagph.app;

import android.Manifest;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

/**
 * Restores only a user-started Driving Mode session whose encrypted,
 * short-lived capability is still valid. It never creates a new session and
 * never bypasses Android location or notification controls.
 */
final class DrivingSessionRestorer {
    enum Result {
        NOT_NEEDED,
        STARTED,
        USER_ACTION_REQUIRED,
        EXPIRED,
        FAILED
    }

    private DrivingSessionRestorer() {}

    static Result restoreIfActive(Context context, boolean activityVisible) {
        Context appContext = context.getApplicationContext();
        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(appContext);
        if (credentials == null || DrivingCredentialStore.isStopRequested(appContext)) {
            return Result.NOT_NEEDED;
        }

        if (credentials.trackingExpiresAtMs <= System.currentTimeMillis()) {
            DrivingCredentialStore.clearIfSession(appContext, credentials.sessionId);
            DrivingLocationService.clearRuntimeStatus(
                appContext,
                "The previous Driving Mode session expired and was not restored."
            );
            return Result.EXPIRED;
        }

        if (!hasPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION)
            || !locationEnabled(appContext)
            || !notificationPermissionGranted(appContext)
            || !notificationsEnabled(appContext)) {
            DrivingLocationService.markRestoreRequired(
                appContext,
                credentials.sessionId,
                "Open KALASAG and review location and notification permissions to resume Driving Mode."
            );
            return Result.USER_ACTION_REQUIRED;
        }

        // Android 10+ does not allow a background boot receiver to revive a
        // location service using only a while-in-use grant. The separately
        // disclosed background grant is required for this narrow restore path.
        if (!activityVisible && !backgroundLocationPermissionGranted(appContext)) {
            DrivingLocationService.markRestoreRequired(
                appContext,
                credentials.sessionId,
                "Open KALASAG to resume Driving Mode after the device restart."
            );
            return Result.USER_ACTION_REQUIRED;
        }

        try {
            Intent intent = new Intent(appContext, DrivingLocationService.class)
                .setAction(DrivingLocationService.ACTION_START);
            ContextCompat.startForegroundService(appContext, intent);
            return Result.STARTED;
        } catch (RuntimeException error) {
            DrivingLocationService.markRestoreRequired(
                appContext,
                credentials.sessionId,
                "Android paused Driving Mode. Open KALASAG to resume it."
            );
            return Result.FAILED;
        }
    }

    private static boolean hasPermission(Context context, String permission) {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean backgroundLocationPermissionGranted(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || hasPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION);
    }

    private static boolean notificationPermissionGranted(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || hasPermission(context, Manifest.permission.POST_NOTIFICATIONS);
    }

    private static boolean notificationsEnabled(Context context) {
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        return manager != null && manager.areNotificationsEnabled();
    }

    private static boolean locationEnabled(Context context) {
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return manager.isLocationEnabled();
            }
            return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception ignored) {
            return false;
        }
    }
}
