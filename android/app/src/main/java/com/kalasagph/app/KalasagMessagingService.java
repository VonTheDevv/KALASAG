package com.kalasagph.app;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Process;
import android.os.UserManager;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.List;
import java.util.Map;

/**
 * Displays ordered, data-only family notifications. FCM does not guarantee
 * arrival order, so every outbox message carries a server-generated monotonic
 * display sequence. Persisting the newest sequence before display prevents a
 * stale danger payload from replacing a newer danger/resolution notification.
 */
public final class KalasagMessagingService extends FirebaseMessagingService {
    private static final String PREFS = "kalasag_family_notification_sequence";
    private static final String PREF_FULL_SYNC_REQUIRED = "full_sync_required";
    private static final int FAMILY_SYNC_NOTIFICATION_ID = 41_023;
    private static final int MAX_KEY_LENGTH = 220;
    private static final int MAX_TITLE_LENGTH = 200;
    private static final int MAX_BODY_LENGTH = 500;

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        String displayKey = bounded(data.get("display_key"), MAX_KEY_LENGTH);
        String notificationTag = bounded(data.get("notification_tag"), MAX_KEY_LENGTH);
        String eventType = bounded(data.get("event_type"), 80);
        String title = bounded(data.get("notification_title"), MAX_TITLE_LENGTH);
        String body = bounded(data.get("notification_body"), MAX_BODY_LENGTH);
        String channel = bounded(data.get("notification_channel"), 80);
        long displaySequence = positiveLong(data.get("display_sequence"));

        boolean hasOrderedProtocol = data.containsKey("display_key")
            || data.containsKey("display_sequence")
            || data.containsKey("notification_tag");
        if (!hasOrderedProtocol) {
            if (isUserUnlocked()) {
                PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
            }
            return;
        }

        boolean danger = "family_danger".equals(eventType);
        boolean familyActivity = "family_alert_resolved".equals(eventType)
            || "driving_started".equals(eventType);
        if (
            displayKey == null
            || notificationTag == null
            || title == null
            || body == null
            || displaySequence <= 0L
            || !safeIdentifier(displayKey)
            || !safeIdentifier(notificationTag)
            || (!danger && !familyActivity)
            || (danger && !NotificationChannels.isDangerWireChannel(channel))
            || (familyActivity && !NotificationChannels.FAMILY_ACTIVITY.equals(channel))
        ) {
            // Never let malformed ordered payloads advance the persisted
            // sequence or reach Capacitor's generic notification path.
            return;
        }

        if (!acceptSequence(displayKey, displaySequence)) {
            return;
        }

        NotificationManager manager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            // React local alerts use this untagged ID. Clear both notification
            // forms before showing any accepted newer family state.
            manager.cancel(notificationTag, 0);
            manager.cancel(stableLocalNotificationId(displayKey));
        }

        if (isUserUnlocked()) {
            // Capacitor's WebView and plugin state live in credential-protected
            // storage. Do not touch them during Android Direct Boot.
            PushNotificationsPlugin.sendRemoteMessage(remoteMessage);
        }
        if (isAppForeground()) {
            // The React safety provider refreshes the authoritative database
            // state and shows its stable local alert while the app is visible.
            return;
        }

        NotificationChannels.ensure(getApplicationContext());
        String resolvedChannel = danger
            ? NotificationChannels.FAMILY_DANGER
            : NotificationChannels.FAMILY_ACTIVITY;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, resolvedChannel)
            .setSmallIcon(R.drawable.ic_stat_kalasag)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(
                danger
                    ? NotificationCompat.CATEGORY_ALARM
                    : NotificationCompat.CATEGORY_STATUS
            )
            .setPriority(
                danger
                    ? NotificationCompat.PRIORITY_HIGH
                    : NotificationCompat.PRIORITY_DEFAULT
            );

        if (danger) {
            builder.setDefaults(Notification.DEFAULT_ALL);
        }

        Intent launchIntent = isUserUnlocked()
            ? getPackageManager().getLaunchIntentForPackage(getPackageName())
            : null;
        if (launchIntent != null) {
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            String messageId = remoteMessage.getMessageId();
            if (messageId != null) {
                launchIntent.putExtra("google.message_id", messageId);
            }
            for (Map.Entry<String, String> entry : data.entrySet()) {
                launchIntent.putExtra(entry.getKey(), entry.getValue());
            }
            PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                notificationTag.hashCode(),
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            builder.setContentIntent(contentIntent);
        }

        if (manager != null) {
            // Firebase also uses ID 0 for explicitly tagged notifications.
            try {
                manager.notify(notificationTag, 0, builder.build());
            } catch (SecurityException ignored) {
                // Android 13+ can revoke notification permission between the
                // readiness check/FCM send and this local display attempt. The
                // ordered sequence stays advanced so a stale alert cannot be
                // displayed later if permission is restored.
            }
        }
    }

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        if (isUserUnlocked()) {
            PushNotificationsPlugin.onNewToken(token);
        }
    }

    /**
     * Firebase calls this when it had to discard queued messages for this
     * installation. Persist a Direct-Boot-safe reconciliation flag so the
     * WebView performs an authoritative database refresh on its next start.
     * The notification is deliberately informational: it must never invent a
     * danger state when the dropped messages could also contain a resolution.
     */
    @Override
    public void onDeletedMessages() {
        super.onDeletedMessages();
        reliabilityPreferences(getApplicationContext())
            .edit()
            .putBoolean(PREF_FULL_SYNC_REQUIRED, true)
            .commit();

        NotificationChannels.ensure(getApplicationContext());
        NotificationCompat.Builder builder = new NotificationCompat.Builder(
            this,
            NotificationChannels.FAMILY_ACTIVITY
        )
            .setSmallIcon(R.drawable.ic_stat_kalasag)
            .setContentTitle(getString(R.string.family_sync_notification_title))
            .setContentText(getString(R.string.family_sync_notification_body))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(
                getString(R.string.family_sync_notification_body)
            ))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        Intent launchIntent = isUserUnlocked()
            ? getPackageManager().getLaunchIntentForPackage(getPackageName())
            : null;
        if (launchIntent != null) {
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            builder.setContentIntent(PendingIntent.getActivity(
                this,
                FAMILY_SYNC_NOTIFICATION_ID,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            ));
        }

        NotificationManager manager =
            (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            try {
                manager.notify(FAMILY_SYNC_NOTIFICATION_ID, builder.build());
            } catch (SecurityException ignored) {
                // The durable reconciliation flag is still consumed next time
                // the app opens, even when Android notification access is off.
            }
        }
    }

    static boolean consumeFullSyncRequired(Context context) {
        synchronized (KalasagMessagingService.class) {
            SharedPreferences preferences = reliabilityPreferences(context);
            boolean required = preferences.getBoolean(PREF_FULL_SYNC_REQUIRED, false);
            if (required) {
                preferences.edit().remove(PREF_FULL_SYNC_REQUIRED).commit();
            }
            return required;
        }
    }

    private boolean acceptSequence(String displayKey, long sequence) {
        synchronized (KalasagMessagingService.class) {
            SharedPreferences preferences = reliabilityPreferences(this);
            long current = preferences.getLong(displayKey, 0L);
            if (sequence <= current) {
                return false;
            }
            return preferences.edit().putLong(displayKey, sequence).commit();
        }
    }

    private static SharedPreferences reliabilityPreferences(Context context) {
        Context storage = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
            ? context.createDeviceProtectedStorageContext()
            : context;
        return storage.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private boolean isAppForeground() {
        ActivityManager manager =
            (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) {
            return false;
        }
        List<ActivityManager.RunningAppProcessInfo> processes = manager.getRunningAppProcesses();
        if (processes == null) {
            return false;
        }
        for (ActivityManager.RunningAppProcessInfo process : processes) {
            if (process.pid == Process.myPid()) {
                return process.importance
                    <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
            }
        }
        return false;
    }

    private boolean isUserUnlocked() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return true;
        }
        UserManager manager = (UserManager) getSystemService(Context.USER_SERVICE);
        return manager != null && manager.isUserUnlocked();
    }

    private static long positiveLong(String value) {
        if (value == null) {
            return -1L;
        }
        try {
            long result = Long.parseLong(value);
            return result > 0L ? result : -1L;
        } catch (NumberFormatException ignored) {
            return -1L;
        }
    }

    private static boolean safeIdentifier(String value) {
        return value.matches("^[A-Za-z0-9:_-]{1," + MAX_KEY_LENGTH + "}$");
    }

    /**
     * Java String.hashCode uses the same signed 32-bit 31x recurrence as the
     * TypeScript stableNotificationId helper (Math.imul + bitwise coercion).
     */
    private static int stableLocalNotificationId(String value) {
        int hash = value.hashCode();
        if (hash == Integer.MIN_VALUE) {
            return Integer.MAX_VALUE;
        }
        return Math.abs(hash == 0 ? 1 : hash);
    }

    private static String bounded(String value, int maxLength) {
        if (value == null) {
            return null;
        }
        String result = value.trim();
        if (result.isEmpty() || result.length() > maxLength) {
            return null;
        }
        return result;
    }
}
