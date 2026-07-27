# Family alert dispatcher

This Edge Function leases durable jobs from `private.notification_outbox` and
sends Android notifications through Firebase Cloud Messaging HTTP v1. It never
returns device tokens or Firebase credentials.

## Required configuration

1. Create the Firebase Android app for the Capacitor application ID.
2. Generate a Firebase service-account JSON key dedicated to messaging.
3. Store it as one Supabase secret named `FIREBASE_SERVICE_ACCOUNT_JSON`:

   ```powershell
   npx supabase secrets set FIREBASE_SERVICE_ACCOUNT_JSON='<service-account-json>'
   ```

4. Deploy with normal JWT verification enabled:

   ```powershell
   npx supabase functions deploy family-alert-dispatch
   ```

Do not commit the service-account JSON, `google-services.json`, a service-role
key, or push registration tokens to this directory.

## Invocation

Immediately after an authenticated client commits a driving-start or danger
RPC, it may invoke `family-alert-dispatch` once to reduce delivery latency. The
function validates the user's access token, applies a bounded per-user kick
rate, returns no queue details, and processes only durable server-created jobs.

A trusted VPS worker should additionally invoke it every few seconds with the
service-role bearer token. This recovers jobs when the initiating device loses
connectivity after the database commit. Trusted invocations receive queue
counts for monitoring; authenticated client invocations receive only
`{ ok, processed }`.

The Android client must create matching channels before registering for push:

- `family_activity` — normal driving/resolution notifications.
- `family_danger` — high-importance emergency channel using an alarm-category
  sound and vibration pattern configured natively by the Android app.

Push delivery is not an absolute alarm guarantee: Android notification
permission, Do Not Disturb, force-stop, OEM battery restrictions, and network
availability still apply. The app should show readiness and acknowledgement
state rather than claiming guaranteed delivery.
