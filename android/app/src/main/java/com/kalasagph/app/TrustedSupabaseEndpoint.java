package com.kalasagph.app;

import java.net.URI;
import java.net.URL;

/**
 * Native tracking capabilities may only be sent to this application's own
 * Supabase project. Treating an arbitrary HTTPS URL from the WebView as trusted
 * would let a compromised page exfiltrate the bearer-style tracking token.
 */
final class TrustedSupabaseEndpoint {
    private static final String EXPECTED_HOST = "arkvqihazxrfdxuwzqur.supabase.co";

    private TrustedSupabaseEndpoint() {}

    static String normalize(String value) {
        if (value == null) return null;
        String candidate = value.trim();
        if (candidate.isEmpty() || candidate.length() > 2048) return null;

        try {
            URI uri = new URI(candidate);
            String path = uri.getRawPath();
            if (
                !"https".equalsIgnoreCase(uri.getScheme())
                    || uri.getHost() == null
                    || !EXPECTED_HOST.equalsIgnoreCase(uri.getHost())
                    || uri.getUserInfo() != null
                    || uri.getQuery() != null
                    || uri.getFragment() != null
                    || (uri.getPort() != -1 && uri.getPort() != 443)
                    || (path != null && !path.isEmpty() && !"/".equals(path))
            ) {
                return null;
            }
            return "https://" + EXPECTED_HOST;
        } catch (Exception ignored) {
            return null;
        }
    }

    static URL rpcUrl(String baseUrl, String functionName) {
        if (functionName == null || !functionName.matches("^[a-z0-9_]{1,80}$")) return null;
        String trustedBase = normalize(baseUrl);
        if (trustedBase == null) return null;
        try {
            return new URL(trustedBase + "/rest/v1/rpc/" + functionName);
        } catch (Exception ignored) {
            return null;
        }
    }
}
