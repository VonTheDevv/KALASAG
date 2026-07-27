package com.kalasagph.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

final class NotificationChannels {
    static final String FAMILY_ACTIVITY = "family_activity";
    // Channel sound and importance are immutable after first creation. Use a
    // new local channel ID so installs that created the old silent channel can
    // receive the corrected alarm configuration without deleting user choices.
    static final String FAMILY_DANGER = "family_danger_v2";
    static final String LEGACY_FAMILY_DANGER = "family_danger";

    private NotificationChannels() {}

    static boolean isDangerWireChannel(String channel) {
        return LEGACY_FAMILY_DANGER.equals(channel) || FAMILY_DANGER.equals(channel);
    }

    static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }

        NotificationChannel activity = new NotificationChannel(
            FAMILY_ACTIVITY,
            context.getString(R.string.channel_family_activity_name),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        activity.setDescription(context.getString(R.string.channel_family_activity_description));
        activity.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);

        NotificationChannel danger = new NotificationChannel(
            FAMILY_DANGER,
            context.getString(R.string.channel_family_danger_name),
            NotificationManager.IMPORTANCE_HIGH
        );
        danger.setDescription(context.getString(R.string.channel_family_danger_description));
        danger.enableVibration(true);
        danger.setVibrationPattern(new long[] { 0L, 700L, 350L, 700L, 350L, 900L });
        danger.enableLights(true);
        danger.setLightColor(0xFFFF3B30);
        danger.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);

        Uri alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (alarmSound == null) {
            alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        }
        if (alarmSound != null) {
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_ALARM)
                .build();
            danger.setSound(alarmSound, attributes);
        }

        manager.createNotificationChannel(activity);
        manager.createNotificationChannel(danger);
    }
}
