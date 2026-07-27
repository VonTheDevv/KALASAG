package com.kalasagph.app;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.app.NotificationCompat;

/**
 * Re-enters only an already active, user-authorized Driving Mode session after
 * reboot/app replacement. If Android cannot legally start location work from
 * the background, a notification lets the user resume from a visible screen.
 */
public final class DrivingSessionRestoreReceiver extends BroadcastReceiver {
    private static final int RESTORE_NOTIFICATION_ID = 41022;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)
            && !Intent.ACTION_BOOT_COMPLETED.equals(action)
            && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }

        NotificationChannels.ensure(context);
        BootReliabilityState.record(context, action);
        if (Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            // Encrypted Driving Mode credentials are credential-protected and
            // cannot be read safely until BOOT_COMPLETED after first unlock.
            return;
        }
        DrivingSessionRestorer.Result result = DrivingSessionRestorer.restoreIfActive(context, false);
        if (result == DrivingSessionRestorer.Result.USER_ACTION_REQUIRED
            || result == DrivingSessionRestorer.Result.FAILED) {
            showResumeNotification(context);
        }
    }

    private static void showResumeNotification(Context context) {
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || !manager.areNotificationsEnabled()) return;

        Intent launchIntent = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context,
            RESTORE_NOTIFICATION_ID,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        try {
            manager.notify(
                RESTORE_NOTIFICATION_ID,
                new NotificationCompat.Builder(context, NotificationChannels.FAMILY_ACTIVITY)
                    .setSmallIcon(R.drawable.ic_stat_kalasag)
                    .setContentTitle(context.getString(R.string.driving_restore_title))
                    .setContentText(context.getString(R.string.driving_restore_body))
                    .setStyle(
                        new NotificationCompat.BigTextStyle()
                            .bigText(context.getString(R.string.driving_restore_body))
                    )
                    .setContentIntent(pendingIntent)
                    .setAutoCancel(true)
                    .setCategory(NotificationCompat.CATEGORY_STATUS)
                    .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .build()
            );
        } catch (SecurityException ignored) {
            // Android 13+ may revoke notification permission between the
            // capability check and notification delivery.
        }
    }
}
