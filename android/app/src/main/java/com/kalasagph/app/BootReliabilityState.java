package com.kalasagph.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * Non-sensitive evidence that Android delivered the app's manifest boot
 * receiver. Device-protected storage keeps this diagnostic available before
 * first unlock; it contains no account, location, or notification content.
 */
final class BootReliabilityState {
    private static final String PREFS = "kalasag_boot_reliability";
    private static final String LAST_RECEIVED_AT = "last_received_at";
    private static final String LAST_ACTION = "last_action";

    private BootReliabilityState() {}

    static void record(Context context, String action) {
        preferences(context).edit()
            .putLong(LAST_RECEIVED_AT, System.currentTimeMillis())
            .putString(LAST_ACTION, action == null ? "" : action)
            .apply();
    }

    static long lastReceivedAt(Context context) {
        return preferences(context).getLong(LAST_RECEIVED_AT, 0L);
    }

    static String lastAction(Context context) {
        return preferences(context).getString(LAST_ACTION, "");
    }

    private static SharedPreferences preferences(Context context) {
        Context storage = Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
            ? context.createDeviceProtectedStorageContext()
            : context;
        return storage.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
