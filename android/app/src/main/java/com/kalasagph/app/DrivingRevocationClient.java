package com.kalasagph.app;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class DrivingRevocationClient {
    private static final int CONNECT_TIMEOUT_MS = 5_000;
    private static final int READ_TIMEOUT_MS = 5_000;

    enum Result {
        SUCCESS,
        RETRYABLE,
        TERMINAL
    }

    private DrivingRevocationClient() {}

    static Result revoke(DrivingCredentialStore.Credentials credentials) {
        if (credentials.trackingExpiresAtMs <= System.currentTimeMillis()) {
            return Result.TERMINAL;
        }

        HttpURLConnection connection = null;
        try {
            URL endpoint = TrustedSupabaseEndpoint.rpcUrl(
                credentials.supabaseUrl,
                "stop_family_driving_with_token"
            );
            if (endpoint == null) {
                return Result.TERMINAL;
            }

            JSONObject payload = new JSONObject();
            payload.put("p_session_id", credentials.sessionId);
            payload.put("p_tracking_token", credentials.trackingToken);

            connection = (HttpURLConnection) endpoint.openConnection();
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
                return Result.SUCCESS;
            }
            drain(connection.getErrorStream());
            if (status == 408 || status == 425 || status == 429 || status >= 500) {
                return Result.RETRYABLE;
            }
            // Rejected, invalid, or already-expired capabilities cannot upload
            // again and are safe to remove from encrypted local storage.
            return Result.TERMINAL;
        } catch (Exception error) {
            return Result.RETRYABLE;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static boolean looksLikeJwt(String value) {
        int firstDot = value.indexOf('.');
        return firstDot > 0 && value.indexOf('.', firstDot + 1) > firstDot + 1;
    }

    private static void drain(InputStream input) {
        if (input == null) return;
        try (InputStream stream = input) {
            byte[] buffer = new byte[512];
            while (stream.read(buffer) >= 0) {
                // Drain so HttpURLConnection can release the socket promptly.
            }
        } catch (Exception ignored) {
            // Response bodies are intentionally ignored.
        }
    }
}
