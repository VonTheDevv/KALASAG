package com.kalasagph.app;

import android.Manifest;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class DrivingLocationService extends Service implements LocationListener {
    static final String ACTION_START = "com.kalasagph.app.action.START_DRIVING";
    static final String ACTION_STOP = "com.kalasagph.app.action.STOP_DRIVING";
    static final String ACTION_STOP_WITH_TOKEN = "com.kalasagph.app.action.STOP_DRIVING_WITH_TOKEN";

    private static final int NOTIFICATION_ID = 41021;
    private static final String STATUS_PREFS = "kalasag_driving_status";
    private static final long FAST_INTERVAL_MS = 5_000L;
    private static final long STATIONARY_INTERVAL_MS = 20_000L;
    private static final float FAST_DISTANCE_METERS = 5f;
    private static final float STATIONARY_DISTANCE_METERS = 10f;
    private static final long MAX_LAST_KNOWN_AGE_MS = 120_000L;
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 10_000;
    private static final long STOP_DEADLINE_MS = 18_000L;
    private static final long MAX_RETRY_MS = 60_000L;

    private final AtomicBoolean uploadInFlight = new AtomicBoolean(false);
    private final Object latestLock = new Object();

    private LocationManager locationManager;
    private Handler mainHandler;
    private ExecutorService networkExecutor;
    private ExecutorService stopExecutor;
    private Location latestLocation;
    private long latestSequence;
    private long configuredIntervalMs;
    private int retryAttempt;
    private long nextUploadAllowedAt;
    private Runnable retryRunnable;
    private volatile HttpURLConnection activeUploadConnection;
    private boolean explicitlyStopped;
    private volatile boolean stopping;
    private final AtomicBoolean stopFinalized = new AtomicBoolean(false);
    private Runnable stopDeadlineRunnable;
    private BroadcastReceiver locationProviderReceiver;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationChannels.ensure(this);
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        mainHandler = new Handler(Looper.getMainLooper());
        networkExecutor = Executors.newSingleThreadExecutor();
        stopExecutor = Executors.newSingleThreadExecutor();
        locationProviderReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!LocationManager.PROVIDERS_CHANGED_ACTION.equals(intent.getAction()) || stopping) {
                    return;
                }
                if (locationServicesEnabled()) {
                    requestLocationUpdates(FAST_INTERVAL_MS);
                    uploadRecentLastKnownLocation();
                } else {
                    statusPreferences(DrivingLocationService.this).edit()
                        .putString("lastError", "Device location services are disabled.")
                        .apply();
                }
            }
        };
        ContextCompat.registerReceiver(
            this,
            locationProviderReceiver,
            new IntentFilter(LocationManager.PROVIDERS_CHANGED_ACTION),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP_WITH_TOKEN.equals(action)) {
            stopDrivingFromNotification();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            stopDrivingFromNotification();
            return START_NOT_STICKY;
        }

        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(this);
        if (credentials == null) {
            stopDriving("The secure driving session credential is missing or expired.");
            return START_NOT_STICKY;
        }
        if (DrivingCredentialStore.isStopRequested(this)) {
            if (canShowLocationForegroundService()) {
                stopDrivingFromNotification();
            } else {
                stopWithoutForegroundAndScheduleRevocation(
                    credentials,
                    "Driving Mode stopped locally; secure server revocation is pending."
                );
            }
            return START_NOT_STICKY;
        }

        if (!hasLocationPermission()) {
            stopWithoutForegroundAndScheduleRevocation(
                credentials,
                "Precise location permission was removed, so Driving Mode was stopped."
            );
            return START_NOT_STICKY;
        }
        if (!notificationsAvailable()) {
            stopWithoutForegroundAndScheduleRevocation(
                credentials,
                "Notifications were disabled, so Android could not keep Driving Mode visible and active."
            );
            return START_NOT_STICKY;
        }

        try {
            startForeground(NOTIFICATION_ID, buildNotification());
        } catch (RuntimeException error) {
            stopWithoutForegroundAndScheduleRevocation(
                credentials,
                "Android could not restore the visible Driving Mode service. Open KALASAG and start it again."
            );
            return START_NOT_STICKY;
        }
        writeRuntimeStatus(true, credentials.sessionId, null, 0L, 0L);

        requestLocationUpdates(FAST_INTERVAL_MS);
        uploadRecentLastKnownLocation();
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onLocationChanged(@NonNull Location location) {
        if (!isUsable(location)) {
            return;
        }

        synchronized (latestLock) {
            latestLocation = new Location(location);
            latestSequence += 1L;
        }
        statusPreferences(this).edit()
            .putLong("lastObservedAt", location.getTime())
            .apply();

        if (location.hasSpeed()) {
            long desiredInterval = location.getSpeed() >= 1f
                ? FAST_INTERVAL_MS
                : STATIONARY_INTERVAL_MS;
            if (desiredInterval != configuredIntervalMs) {
                requestLocationUpdates(desiredInterval);
            }
        }
        uploadLatest();
    }

    @Override
    public void onProviderEnabled(@NonNull String provider) {
        requestLocationUpdates(FAST_INTERVAL_MS);
    }

    @Override
    public void onProviderDisabled(@NonNull String provider) {
        boolean locationAvailable = false;
        try {
            locationAvailable = locationManager != null && (
                locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
            );
        } catch (Exception ignored) {
            // Status is updated below.
        }
        if (!locationAvailable) {
            statusPreferences(this).edit().putString("lastError", "Device location services are disabled.").apply();
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {
        // Required by older Android LocationListener implementations.
    }

    @Override
    public void onDestroy() {
        removeLocationUpdates();
        cancelRetry();
        if (networkExecutor != null) {
            networkExecutor.shutdownNow();
        }
        if (stopExecutor != null) {
            stopExecutor.shutdownNow();
        }
        if (locationProviderReceiver != null) {
            try {
                unregisterReceiver(locationProviderReceiver);
            } catch (IllegalArgumentException ignored) {
                // Receiver was already removed during teardown.
            }
            locationProviderReceiver = null;
        }
        if (!explicitlyStopped) {
            statusPreferences(this).edit().putBoolean("active", false).apply();
        }
        super.onDestroy();
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, DrivingLocationService.class).setAction(ACTION_STOP_WITH_TOKEN);
        PendingIntent stopPendingIntent = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, NotificationChannels.FAMILY_ACTIVITY)
            .setSmallIcon(R.drawable.ic_stat_kalasag)
            .setContentTitle(getString(R.string.driving_notification_title))
            .setContentText(getString(R.string.driving_notification_body))
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addAction(
                R.drawable.ic_stat_kalasag,
                getString(R.string.driving_notification_stop),
                stopPendingIntent
            )
            .build();
    }

    private void requestLocationUpdates(long intervalMs) {
        if (locationManager == null || !hasLocationPermission()) {
            return;
        }

        removeLocationUpdates();
        configuredIntervalMs = intervalMs;
        float minDistance = intervalMs == FAST_INTERVAL_MS ? FAST_DISTANCE_METERS : STATIONARY_DISTANCE_METERS;
        boolean registered = false;
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER,
                    intervalMs,
                    minDistance,
                    this,
                    Looper.getMainLooper()
                );
                registered = true;
            }
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    Math.max(intervalMs, 10_000L),
                    minDistance,
                    this,
                    Looper.getMainLooper()
                );
                registered = true;
            }
        } catch (SecurityException error) {
            stopDriving("Precise location permission was removed.");
            return;
        } catch (Exception error) {
            statusPreferences(this).edit().putString("lastError", "Location provider failed to start.").apply();
        }

        if (!registered) {
            statusPreferences(this).edit().putString("lastError", "No device location provider is available.").apply();
        }
    }

    private void uploadRecentLastKnownLocation() {
        if (locationManager == null || !hasLocationPermission()) {
            return;
        }
        try {
            Location best = newer(
                locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER),
                locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            );
            if (best != null && System.currentTimeMillis() - best.getTime() <= MAX_LAST_KNOWN_AGE_MS) {
                synchronized (latestLock) {
                    latestLocation = new Location(best);
                    latestSequence += 1L;
                }
                statusPreferences(this).edit().putLong("lastObservedAt", best.getTime()).apply();
                uploadLatest();
            }
        } catch (SecurityException ignored) {
            stopDriving("Precise location permission was removed.");
        }
    }

    private void uploadLatest() {
        if (stopping) {
            return;
        }
        long retryDelay = nextUploadAllowedAt - System.currentTimeMillis();
        if (retryDelay > 0L) {
            scheduleRetry(retryDelay);
            return;
        }
        if (!uploadInFlight.compareAndSet(false, true)) {
            return;
        }

        final Location location;
        final long sequence;
        synchronized (latestLock) {
            location = latestLocation == null ? null : new Location(latestLocation);
            sequence = latestSequence;
        }
        if (location == null) {
            uploadInFlight.set(false);
            return;
        }

        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(this);
        if (credentials == null) {
            uploadInFlight.set(false);
            stopDriving("The secure driving session credential is missing or expired.");
            return;
        }

        networkExecutor.execute(() -> {
            UploadResult result = upload(credentials, location);
            mainHandler.post(() -> finishUpload(result, sequence, location.getTime()));
        });
    }

    private UploadResult upload(DrivingCredentialStore.Credentials credentials, Location location) {
        HttpURLConnection connection = null;
        try {
            URL endpoint = TrustedSupabaseEndpoint.rpcUrl(
                credentials.supabaseUrl,
                "update_family_driving_location_with_token"
            );
            if (endpoint == null) {
                return UploadResult.permanent("The configured tracking endpoint is not trusted.");
            }

            JSONObject payload = new JSONObject();
            payload.put("p_session_id", credentials.sessionId);
            payload.put("p_tracking_token", credentials.trackingToken);
            payload.put("p_latitude", location.getLatitude());
            payload.put("p_longitude", location.getLongitude());
            payload.put("p_accuracy_m", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
            payload.put("p_heading_deg", location.hasBearing() ? location.getBearing() : JSONObject.NULL);
            payload.put("p_speed_mps", location.hasSpeed() ? location.getSpeed() : JSONObject.NULL);
            payload.put("p_recorded_at", isoTimestamp(location.getTime()));
            payload.put("p_address_label", JSONObject.NULL);

            connection = (HttpURLConnection) endpoint.openConnection();
            activeUploadConnection = connection;
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("apikey", credentials.publishableKey);
            if (looksLikeJwt(credentials.publishableKey)) {
                connection.setRequestProperty("Authorization", "Bearer " + credentials.publishableKey);
            }

            byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }

            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                drain(connection.getInputStream());
                return UploadResult.success();
            }

            drain(connection.getErrorStream());
            if (status == 401 || status == 403 || status == 404) {
                return UploadResult.permanent("Driving session authorization was rejected (HTTP " + status + ").");
            }
            if (status == 400 || status == 409 || status == 422) {
                return UploadResult.permanent("Driving location was rejected (HTTP " + status + ").");
            }
            return UploadResult.retryable("Location upload failed (HTTP " + status + ").");
        } catch (Exception error) {
            return UploadResult.retryable("Location upload failed: " + safeMessage(error));
        } finally {
            if (activeUploadConnection == connection) activeUploadConnection = null;
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private void finishUpload(UploadResult result, long uploadedSequence, long recordedAt) {
        uploadInFlight.set(false);
        if (stopping) {
            return;
        }
        if (result.success) {
            retryAttempt = 0;
            nextUploadAllowedAt = 0L;
            cancelRetry();
            statusPreferences(this).edit()
                .putLong("lastUploadedAt", System.currentTimeMillis())
                .putLong("lastRecordedAt", recordedAt)
                .remove("lastError")
                .apply();
            synchronized (latestLock) {
                if (latestSequence > uploadedSequence) {
                    uploadLatest();
                }
            }
            return;
        }

        statusPreferences(this).edit().putString("lastError", result.message).apply();
        if (result.permanent) {
            stopDriving(result.message);
            return;
        }

        retryAttempt = Math.min(retryAttempt + 1, 6);
        long retryDelay = Math.min(MAX_RETRY_MS, 2_000L * (1L << retryAttempt));
        nextUploadAllowedAt = System.currentTimeMillis() + retryDelay;
        scheduleRetry(retryDelay);
    }

    private void scheduleRetry(long delayMs) {
        cancelRetry();
        retryRunnable = this::uploadLatest;
        mainHandler.postDelayed(retryRunnable, delayMs);
    }

    private void cancelRetry() {
        if (mainHandler != null && retryRunnable != null) {
            mainHandler.removeCallbacks(retryRunnable);
            retryRunnable = null;
        }
    }

    private void stopDriving(@Nullable String error) {
        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(this);
        if (credentials == null) {
            explicitlyStopped = true;
            stopping = true;
            removeLocationUpdates();
            cancelRetry();
            cancelActiveUpload();
            clearRuntimeStatus(this, error);
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }
        DrivingCredentialStore.markStopRequested(this);
        stopDrivingFromNotification();
    }

    private void stopDrivingFromNotification() {
        if (stopping) {
            return;
        }
        DrivingCredentialStore.Credentials credentials = DrivingCredentialStore.load(this);
        if (!canShowLocationForegroundService()) {
            stopWithoutForegroundAndScheduleRevocation(
                credentials,
                "Driving Mode stopped locally; secure server revocation is pending."
            );
            return;
        }
        explicitlyStopped = true;
        stopping = true;
        removeLocationUpdates();
        cancelRetry();
        cancelActiveUpload();
        try {
            startForeground(NOTIFICATION_ID, buildStoppingNotification());
        } catch (RuntimeException error) {
            stopWithoutForegroundAndScheduleRevocation(
                credentials,
                "Driving Mode stopped locally; secure server revocation is pending."
            );
            return;
        }
        clearRuntimeStatus(this, null);

        if (credentials == null) {
            finalizeCompletedStop(null, null);
            return;
        }
        DrivingCredentialStore.markStopRequested(this);

        stopDeadlineRunnable = () -> finalizePendingStop(
            credentials,
            "Driving Mode stopped locally, but the server could not be reached to confirm it."
        );
        mainHandler.postDelayed(stopDeadlineRunnable, STOP_DEADLINE_MS);

        stopExecutor.execute(() -> {
            DrivingRevocationClient.Result result = DrivingRevocationClient.revoke(credentials);
            if (result == DrivingRevocationClient.Result.RETRYABLE && !Thread.currentThread().isInterrupted()) {
                try {
                    Thread.sleep(1_000L);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                if (!Thread.currentThread().isInterrupted()) {
                    result = DrivingRevocationClient.revoke(credentials);
                }
            }
            DrivingRevocationClient.Result finalResult = result;
            mainHandler.post(() -> {
                if (finalResult == DrivingRevocationClient.Result.RETRYABLE) {
                    finalizePendingStop(
                        credentials,
                        "Driving Mode stopped locally; secure server revocation is pending."
                    );
                } else {
                    finalizeCompletedStop(credentials, null);
                }
            });
        });
    }

    private void finalizePendingStop(
        DrivingCredentialStore.Credentials credentials,
        @Nullable String error
    ) {
        if (!stopFinalized.compareAndSet(false, true)) {
            return;
        }
        if (stopDeadlineRunnable != null) {
            mainHandler.removeCallbacks(stopDeadlineRunnable);
            stopDeadlineRunnable = null;
        }
        DrivingRevocationJobService.schedule(this);
        writePendingRevocationStatus(this, credentials.sessionId, error);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void finalizeCompletedStop(
        @Nullable DrivingCredentialStore.Credentials credentials,
        @Nullable String error
    ) {
        if (!stopFinalized.compareAndSet(false, true)) return;
        if (stopDeadlineRunnable != null) {
            mainHandler.removeCallbacks(stopDeadlineRunnable);
            stopDeadlineRunnable = null;
        }
        if (credentials == null) DrivingCredentialStore.clear(this);
        else DrivingCredentialStore.clearIfSession(this, credentials.sessionId);
        DrivingRevocationJobService.cancel(this);
        clearRuntimeStatus(this, error);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private Notification buildStoppingNotification() {
        return new NotificationCompat.Builder(this, NotificationChannels.FAMILY_ACTIVITY)
            .setSmallIcon(R.drawable.ic_stat_kalasag)
            .setContentTitle(getString(R.string.driving_notification_title))
            .setContentText(getString(R.string.driving_notification_stopping))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .build();
    }

    private void removeLocationUpdates() {
        if (locationManager == null) {
            return;
        }
        try {
            locationManager.removeUpdates(this);
        } catch (SecurityException ignored) {
            // Permission may have been revoked while the service was active.
        }
    }

    private void cancelActiveUpload() {
        HttpURLConnection connection = activeUploadConnection;
        activeUploadConnection = null;
        if (connection != null) connection.disconnect();
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean notificationsAvailable() {
        boolean permissionGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        NotificationManager manager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        return permissionGranted && manager != null && manager.areNotificationsEnabled();
    }

    private boolean canShowLocationForegroundService() {
        return hasLocationPermission() && notificationsAvailable();
    }

    private boolean locationServicesEnabled() {
        if (locationManager == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return locationManager.isLocationEnabled();
            }
            return locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception ignored) {
            return false;
        }
    }

    private void stopWithoutForegroundAndScheduleRevocation(
        @Nullable DrivingCredentialStore.Credentials credentials,
        @Nullable String error
    ) {
        explicitlyStopped = true;
        stopping = true;
        removeLocationUpdates();
        cancelRetry();
        cancelActiveUpload();
        if (credentials == null) {
            DrivingCredentialStore.clear(this);
            clearRuntimeStatus(this, error);
        } else {
            DrivingCredentialStore.markStopRequested(this);
            DrivingRevocationJobService.schedule(this);
            writePendingRevocationStatus(this, credentials.sessionId, error);
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private static boolean isUsable(Location location) {
        return Double.isFinite(location.getLatitude())
            && Double.isFinite(location.getLongitude())
            && Math.abs(location.getLatitude()) <= 90d
            && Math.abs(location.getLongitude()) <= 180d
            && (!location.hasAccuracy() || location.getAccuracy() <= 5_000f);
    }

    @Nullable
    private static Location newer(@Nullable Location first, @Nullable Location second) {
        if (first == null) {
            return second;
        }
        if (second == null) {
            return first;
        }
        return first.getTime() >= second.getTime() ? first : second;
    }

    private static String isoTimestamp(long timestamp) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(timestamp));
    }

    private static boolean looksLikeJwt(String value) {
        int firstDot = value.indexOf('.');
        return firstDot > 0 && value.indexOf('.', firstDot + 1) > firstDot + 1;
    }

    private static void drain(InputStream input) {
        if (input == null) {
            return;
        }
        try (InputStream stream = input) {
            byte[] buffer = new byte[512];
            while (stream.read(buffer) >= 0) {
                // Drain so HttpURLConnection can release the socket promptly.
            }
        } catch (Exception ignored) {
            // Successful response bodies are intentionally ignored.
        }
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return message.length() > 160 ? message.substring(0, 160) : message;
    }

    private void writeRuntimeStatus(
        boolean active,
        @Nullable String sessionId,
        @Nullable String error,
        long lastObservedAt,
        long lastUploadedAt
    ) {
        SharedPreferences.Editor editor = statusPreferences(this).edit()
            .putBoolean("active", active)
            .remove("restoreRequired")
            .remove("pendingRevocation");
        if (sessionId == null) {
            editor.remove("sessionId");
        } else {
            editor.putString("sessionId", sessionId);
        }
        if (error == null) {
            editor.remove("lastError");
        } else {
            editor.putString("lastError", error);
        }
        if (lastObservedAt > 0L) {
            editor.putLong("lastObservedAt", lastObservedAt);
        }
        if (lastUploadedAt > 0L) {
            editor.putLong("lastUploadedAt", lastUploadedAt);
        }
        editor.apply();
    }

    static JSObject readRuntimeStatus(Context context) {
        SharedPreferences preferences = statusPreferences(context);
        JSObject result = new JSObject();
        result.put("active", preferences.getBoolean("active", false));
        String sessionId = preferences.getString("sessionId", null);
        if (sessionId != null) {
            result.put("sessionId", sessionId);
        }
        String error = preferences.getString("lastError", null);
        if (error != null) {
            result.put("lastError", error);
        }
        long lastObservedAt = preferences.getLong("lastObservedAt", 0L);
        long lastUploadedAt = preferences.getLong("lastUploadedAt", 0L);
        long lastRecordedAt = preferences.getLong("lastRecordedAt", 0L);
        boolean restoreRequired = preferences.getBoolean("restoreRequired", false);
        if (lastObservedAt > 0L) {
            result.put("lastObservedAt", lastObservedAt);
        }
        if (lastUploadedAt > 0L) {
            result.put("lastUploadedAt", lastUploadedAt);
        }
        if (lastRecordedAt > 0L) {
            result.put("lastRecordedAt", lastRecordedAt);
        }
        if (restoreRequired) {
            result.put("restoreRequired", true);
        }
        return result;
    }

    static void clearRuntimeStatus(Context context, @Nullable String error) {
        SharedPreferences.Editor editor = statusPreferences(context).edit().clear().putBoolean("active", false);
        if (error != null) {
            editor.putString("lastError", error);
        }
        editor.apply();
    }

    static void writePendingRevocationStatus(
        Context context,
        String sessionId,
        @Nullable String error
    ) {
        SharedPreferences.Editor editor = statusPreferences(context).edit().clear()
            .putBoolean("active", false)
            .putBoolean("pendingRevocation", true)
            .putString("sessionId", sessionId);
        if (error != null) editor.putString("lastError", error);
        editor.apply();
    }

    static void markRestoreRequired(Context context, String sessionId, @Nullable String error) {
        SharedPreferences.Editor editor = statusPreferences(context).edit()
            .putBoolean("active", false)
            .putBoolean("restoreRequired", true)
            .putString("sessionId", sessionId);
        if (error == null) editor.remove("lastError");
        else editor.putString("lastError", error);
        editor.apply();
    }

    private static SharedPreferences statusPreferences(Context context) {
        return context.getSharedPreferences(STATUS_PREFS, Context.MODE_PRIVATE);
    }

    private static final class UploadResult {
        final boolean success;
        final boolean permanent;
        final String message;

        private UploadResult(boolean success, boolean permanent, String message) {
            this.success = success;
            this.permanent = permanent;
            this.message = message;
        }

        static UploadResult success() {
            return new UploadResult(true, false, "");
        }

        static UploadResult retryable(String message) {
            return new UploadResult(false, false, message);
        }

        static UploadResult permanent(String message) {
            return new UploadResult(false, true, message);
        }
    }

}
