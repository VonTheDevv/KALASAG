package com.kalasagph.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DrivingLocationPlugin.class);
        super.onCreate(savedInstanceState);
        NotificationChannels.ensure(this);
    }

    @Override
    public void onResume() {
        super.onResume();
        // Restoring from a visible activity is permitted on modern Android
        // even when a while-in-use location grant would block a boot-time
        // foreground-service start.
        DrivingSessionRestorer.restoreIfActive(this, true);
    }
}
