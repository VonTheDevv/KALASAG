package com.kalasagph.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class DrivingCredentialStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "kalasag_driving_capability_v1";
    private static final String PREFS = "kalasag_driving_credentials";
    private static final String PREF_IV = "iv";
    private static final String PREF_CIPHERTEXT = "ciphertext";
    private static final String PREF_STOP_REQUESTED = "stop_requested";

    static final class Credentials {
        final String supabaseUrl;
        final String publishableKey;
        final String sessionId;
        final String trackingToken;
        final long trackingExpiresAtMs;

        Credentials(
            String supabaseUrl,
            String publishableKey,
            String sessionId,
            String trackingToken,
            long trackingExpiresAtMs
        ) {
            this.supabaseUrl = supabaseUrl;
            this.publishableKey = publishableKey;
            this.sessionId = sessionId;
            this.trackingToken = trackingToken;
            this.trackingExpiresAtMs = trackingExpiresAtMs;
        }
    }

    private DrivingCredentialStore() {}

    static synchronized void save(Context context, Credentials credentials) throws Exception {
        JSONObject object = new JSONObject();
        object.put("supabaseUrl", credentials.supabaseUrl);
        object.put("publishableKey", credentials.publishableKey);
        object.put("sessionId", credentials.sessionId);
        object.put("trackingToken", credentials.trackingToken);
        object.put("trackingExpiresAtMs", credentials.trackingExpiresAtMs);

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] ciphertext = cipher.doFinal(object.toString().getBytes(StandardCharsets.UTF_8));

        preferences(context).edit()
            .putString(PREF_IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString(PREF_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .putBoolean(PREF_STOP_REQUESTED, false)
            .apply();
    }

    static synchronized Credentials load(Context context) {
        String ivValue = preferences(context).getString(PREF_IV, null);
        String ciphertextValue = preferences(context).getString(PREF_CIPHERTEXT, null);
        if (ivValue == null || ciphertextValue == null) {
            return null;
        }

        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            GCMParameterSpec spec = new GCMParameterSpec(128, Base64.decode(ivValue, Base64.NO_WRAP));
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), spec);
            byte[] plaintext = cipher.doFinal(Base64.decode(ciphertextValue, Base64.NO_WRAP));
            JSONObject object = new JSONObject(new String(plaintext, StandardCharsets.UTF_8));
            return new Credentials(
                object.getString("supabaseUrl"),
                object.getString("publishableKey"),
                object.getString("sessionId"),
                object.getString("trackingToken"),
                object.optLong("trackingExpiresAtMs", 0L)
            );
        } catch (Exception error) {
            clear(context);
            return null;
        }
    }

    static synchronized void clear(Context context) {
        preferences(context).edit().clear().apply();
    }

    static synchronized boolean clearIfSession(Context context, String sessionId) {
        Credentials current = load(context);
        if (current == null || !current.sessionId.equals(sessionId)) return false;
        clear(context);
        return true;
    }

    static synchronized void markStopRequested(Context context) {
        preferences(context).edit().putBoolean(PREF_STOP_REQUESTED, true).commit();
    }

    static synchronized boolean isStopRequested(Context context) {
        return preferences(context).getBoolean(PREF_STOP_REQUESTED, false);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return generator.generateKey();
    }
}
