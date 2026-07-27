package com.kalasagph.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.view.accessibility.AccessibilityEvent;

import androidx.annotation.Nullable;

/**
 * An explicitly user-enabled, zero-observation accessibility service.
 *
 * It intentionally receives no accessibility events and has no capability to
 * inspect windows, filter keys, perform gestures, take screenshots, or operate
 * other apps. Android remains free to stop this process at any time.
 */
public final class KalasagAccessibilityService extends AccessibilityService {
    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            // Defense in depth: XML omits accessibilityEventTypes, and runtime
            // configuration explicitly subscribes to zero events.
            info.eventTypes = 0;
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
            info.flags = AccessibilityServiceInfo.DEFAULT;
            info.notificationTimeout = 0L;
            info.packageNames = new String[] { getPackageName() };
            setServiceInfo(info);
        }

        NotificationChannels.ensure(this);
        // This can only resume a valid, encrypted, explicitly user-started
        // Driving Mode capability. It cannot create a tracking session.
        DrivingSessionRestorer.restoreIfActive(this, false);
    }

    @Override
    public void onAccessibilityEvent(@Nullable AccessibilityEvent event) {
        // Intentionally empty. No event data is inspected, retained, or sent.
    }

    @Override
    public void onInterrupt() {
        // No feedback operation is in progress, so there is nothing to stop.
    }
}
