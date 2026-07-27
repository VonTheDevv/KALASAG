import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8')
const migration = read(
  'supabase',
  'migrations',
  '20260718081702_harden_family_alert_delivery.sql',
)
const dispatcher = read('supabase', 'functions', 'family-alert-dispatch', 'index.ts')
const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml')
const messaging = read(
  'android', 'app', 'src', 'main', 'java', 'com', 'kalasagph', 'app',
  'KalasagMessagingService.java',
)
const channels = read(
  'android', 'app', 'src', 'main', 'java', 'com', 'kalasagph', 'app',
  'NotificationChannels.java',
)
const provider = read('src', 'hooks', 'FamilySafetyProvider.tsx')

const failures = []
const requireMatch = (value, pattern, message) => {
  if (!pattern.test(value)) failures.push(message)
}

requireMatch(
  migration,
  /EXISTS\s*\([\s\S]*?private\.device_push_tokens AS active_token[\s\S]*?active_token\.is_active[\s\S]*?\)\s*AND NOT EXISTS/,
  'Outbox candidates must remain pending until the recipient has an active token.',
)
requireMatch(
  migration,
  /INSERT INTO private\.notification_outbox_deliveries[\s\S]*?ON CONFLICT \(outbox_id, push_token_id\) DO NOTHING/,
  'Every retry must attach newly registered active device tokens idempotently.',
)
requireMatch(
  migration,
  /last_error = 'Recipient has no active push-capable device'[\s\S]*?created_at >= statement_timestamp\(\) - interval '30 days'[\s\S]*?alert\.resolved_at IS NULL[\s\S]*?alert\.updated_at = \(job\.payload ->> 'updated_at'\)::timestamptz/,
  'Token registration may revive only a recent, exact unresolved danger generation.',
)
requireMatch(
  migration,
  /current_setting\('request\.headers', true\)[\s\S]*?net\.http_post[\s\S]*?REFERENCING NEW TABLE AS inserted_jobs[\s\S]*?FOR EACH STATEMENT/,
  'Outbox inserts must schedule one authenticated post-commit pg_net kick per statement.',
)
requireMatch(
  migration,
  /EXCEPTION WHEN OTHERS THEN[\s\S]*?must never roll back[\s\S]*?RETURN NULL/,
  'A dispatch-kick failure must not roll back the committed emergency state.',
)
if (/body\s*:=\s*jsonb_build_object[\s\S]*?(token|alert|payload)/i.test(migration)) {
  failures.push('pg_net kick bodies must not contain device tokens or alert payloads.')
}

const extendedTtlCount = dispatcher.match(/ttl: '2419200s'/g)?.length ?? 0
if (extendedTtlCount < 2) {
  failures.push('Both danger and resolution delivery must use the 28-day TTL.')
}
requireMatch(
  dispatcher,
  /direct_boot_ok:/,
  'Family safety delivery must explicitly declare Direct Boot eligibility.',
)
requireMatch(
  dispatcher,
  /priority: copy\.priority\.toLowerCase\(\)/,
  'FCM HTTP v1 priority must use the documented normal/high JSON spelling.',
)
requireMatch(
  manifest,
  /DrivingSessionRestoreReceiver[\s\S]*?android:directBootAware="true"[\s\S]*?LOCKED_BOOT_COMPLETED/,
  'The boot receiver must be direct-boot aware.',
)
requireMatch(
  manifest,
  /KalasagMessagingService[\s\S]*?android:directBootAware="true"/,
  'The FCM service must be direct-boot aware.',
)
requireMatch(
  messaging,
  /acceptSequence[\s\S]*?createDeviceProtectedStorageContext\(\)/,
  'Ordered notification state must use device-protected storage.',
)
requireMatch(
  messaging,
  /onDeletedMessages\(\)[\s\S]*?PREF_FULL_SYNC_REQUIRED[\s\S]*?consumeFullSyncRequired/,
  'Dropped FCM messages must trigger an authoritative full-sync reconciliation.',
)
requireMatch(
  channels,
  /FAMILY_DANGER = "family_danger_v2"/,
  'The corrected immutable alarm channel must use a versioned ID.',
)
requireMatch(
  provider,
  /registeredPushRef\.current = \{ owner, token: result\.token \}[\s\S]*?kickFamilyAlertDispatch\(\)/,
  'Successful device-token registration must immediately kick queued alerts.',
)

if (failures.length > 0) {
  console.error(failures.map(value => `- ${value}`).join('\n'))
  process.exit(1)
}

console.log('Family alert delivery hardening checks passed.')
