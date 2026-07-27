const fs = require('node:fs')
const { Client } = require('pg')

const expectedTables = [
  'family_alert_acknowledgements',
  'family_alerts',
  'family_driving_sessions',
  'family_live_locations',
]

const expectedFunctions = [
  'acknowledge_family_alert',
  'acknowledge_family_alert_v2',
  'claim_family_notification_deliveries',
  'claim_family_notification_deliveries_v3',
  'complete_family_notification_deliveries',
  'is_family_notification_job_current',
  'list_my_unacknowledged_family_alerts',
  'register_family_push_token',
  'remove_family_member_v2',
  'resolve_my_family_alert',
  'set_my_family_safety_v2',
  'start_family_driving',
  'stop_family_driving',
  'stop_family_driving_with_token',
  'update_family_driving_location_with_token',
]

const expectedMigrationVersions = [
  '20260716182645',
  '20260717014141',
  '20260717114500',
  '20260717152000',
  '20260717155500',
  '20260717160500',
  '20260717164000',
  '20260717174000',
  '20260717180000',
  '20260718081702',
]

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: true,
      ...(process.env.DATABASE_CA_CERT_PATH
        ? { ca: fs.readFileSync(process.env.DATABASE_CA_CERT_PATH, 'utf8') }
        : {}),
    },
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
    application_name: 'kalasag-family-safety-schema-check',
  })

  try {
    await client.connect()
    const tables = await client.query(`
        SELECT c.relname, c.relrowsecurity,
          (SELECT count(*)::int FROM pg_policies p
            WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policy_count
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY c.relname
      `, [expectedTables])
    const functions = await client.query(`
        SELECT DISTINCT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
        ORDER BY p.proname
      `, [expectedFunctions])
    const privateDeliveryState = await client.query(`
        SELECT
          to_regclass('private.notification_outbox_deliveries') IS NOT NULL AS exists,
          NOT has_table_privilege('anon', 'private.notification_outbox_deliveries', 'SELECT')
            AND NOT has_table_privilege('authenticated', 'private.notification_outbox_deliveries', 'SELECT')
            AND NOT has_table_privilege('authenticated', 'private.notification_outbox_deliveries', 'INSERT')
            AND NOT has_table_privilege('authenticated', 'private.notification_outbox_deliveries', 'UPDATE')
            AS client_access_revoked
      `)
    const liveLocationPolicy = await client.query(`
        SELECT coalesce(bool_or(
          coalesce(qual, '') ILIKE '%tracking_token_expires_at%'
          AND coalesce(qual, '') ILIKE '%status%active%'
        ), false) AS hides_expired_locations
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'family_live_locations'
          AND cmd = 'SELECT'
      `)
    const lifecycleHardening = await client.query(`
        SELECT
          NOT has_table_privilege('authenticated', 'public.family_members', 'DELETE')
            AS membership_delete_is_rpc_only,
          EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger
            JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relname = 'family_members'
              AND trigger.tgname = 'cleanup_family_safety_before_member_delete'
              AND trigger.tgenabled <> 'D'
          ) AS membership_cleanup_trigger_ready,
          pg_get_functiondef(
            'public.update_family_driving_location_with_token(uuid,text,double precision,double precision,double precision,double precision,double precision,timestamp with time zone,text)'::regprocedure
          ) ILIKE '%address_label = EXCLUDED.address_label%'
            AS native_updates_clear_stale_address,
          pg_get_functiondef(
            'private.create_family_alert(uuid,uuid,text,text,text,uuid,double precision,double precision,double precision,double precision,double precision,timestamp with time zone,text)'::regprocedure
          ) ILIKE '%Superseded by a newer emergency alert%'
            AS renotify_uses_unique_alert_generation,
          pg_get_functiondef(
            'public.acknowledge_family_alert_v2(uuid,timestamp with time zone)'::regprocedure
          ) ILIKE '%RETURN false%'
            AS stale_acknowledgement_is_terminal,
          position(
            'family_safety_client_events' in pg_get_functiondef(
              'public.set_my_family_safety_v2(uuid,text,text,text,double precision,double precision,double precision,double precision,double precision,timestamp with time zone,text,uuid,text)'::regprocedure
            )
          ) > 0
          AND position(
            'family_safety_client_events' in pg_get_functiondef(
              'public.set_my_family_safety_v2(uuid,text,text,text,double precision,double precision,double precision,double precision,double precision,timestamp with time zone,text,uuid,text)'::regprocedure
            )
          ) < position(
            'UPDATE public.family_members' in pg_get_functiondef(
              'public.set_my_family_safety_v2(uuid,text,text,text,double precision,double precision,double precision,double precision,double precision,timestamp with time zone,text,uuid,text)'::regprocedure
            )
          ) AS danger_idempotency_precedes_status_mutation,
          EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger
            JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'private'
              AND relation.relname = 'notification_outbox'
              AND trigger.tgname = 'mark_notification_deliveries_dead_with_outbox'
              AND trigger.tgenabled <> 'D'
          ) AS terminal_outbox_cleans_device_deliveries,
          to_regclass('private.family_safety_client_events') IS NOT NULL
            AND NOT has_table_privilege('authenticated', 'private.family_safety_client_events', 'SELECT')
            AS all_safety_events_are_private,
          EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'private'
              AND table_name = 'notification_outbox'
              AND column_name = 'display_key'
              AND is_nullable = 'NO'
          ) AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'private'
              AND table_name = 'notification_outbox'
              AND column_name = 'superseded_at'
          ) AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema = 'private'
              AND table_name = 'notification_outbox'
              AND column_name = 'display_sequence'
              AND is_nullable = 'NO'
          ) AS ordered_notification_state_ready,
          pg_get_functiondef(
            'public.claim_family_notification_deliveries(integer)'::regprocedure
          ) ILIKE '%active.display_key = job.display_key%'
            AND pg_get_functiondef(
              'public.claim_family_notification_deliveries(integer)'::regprocedure
            ) ILIKE '%job.superseded_at IS NULL%'
            AS notification_claims_are_serialized,
          pg_get_functiondef(
            'private.set_notification_outbox_display_key()'::regprocedure
          ) ILIKE '%display_sequence%'
            AND pg_get_functiondef(
              'private.set_notification_outbox_display_key()'::regprocedure
            ) ILIKE '%NEW.payload%'
            AND pg_get_functiondef(
              'private.set_notification_outbox_display_key()'::regprocedure
            ) ILIKE '%notification_protocol_version%'
            AS notification_generation_is_persisted,
          EXISTS (
            SELECT 1
            FROM pg_constraint AS constraint_row
            JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'private'
              AND relation.relname = 'notification_outbox'
              AND constraint_row.conname = 'notification_outbox_display_protocol_check'
              AND constraint_row.convalidated
          )
            AND has_function_privilege(
              'service_role',
              'public.claim_family_notification_deliveries_v3(integer)',
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              'service_role',
              'public.claim_family_notification_deliveries(integer)',
              'EXECUTE'
            )
            AND NOT has_function_privilege(
              'service_role',
              'public.claim_family_notification_outbox(integer)',
              'EXECUTE'
            )
            AS notification_protocol_v3_is_exclusive,
          pg_get_functiondef(
            'public.raise_family_alert(uuid,text,text,text,uuid,double precision,double precision,double precision,double precision,double precision,timestamp with time zone,text)'::regprocedure
          ) ILIKE '%v_recorded_status IS DISTINCT FROM ''in_danger''%'
            AND pg_get_functiondef(
              'public.set_my_family_safety_v2(uuid,text,text,text,double precision,double precision,double precision,double precision,double precision,timestamp with time zone,text,uuid,text)'::regprocedure
            ) ILIKE '%v_recorded_status IS DISTINCT FROM p_safety_status%'
            AS safety_idempotency_status_is_bound,
          EXISTS (
            SELECT 1 FROM pg_extension WHERE extname = 'pg_net'
          ) AS pg_net_ready,
          EXISTS (
            SELECT 1
            FROM pg_trigger AS trigger
            JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'private'
              AND relation.relname = 'notification_outbox'
              AND trigger.tgname = 'kick_family_alert_dispatch_after_insert'
              AND trigger.tgenabled <> 'D'
          ) AS dispatch_kick_trigger_ready,
          pg_get_functiondef(
            'public.claim_family_notification_deliveries(integer)'::regprocedure
          ) ILIKE '%private.device_push_tokens AS active_token%'
            AND pg_get_functiondef(
              'public.claim_family_notification_deliveries(integer)'::regprocedure
            ) ILIKE '%ON CONFLICT (outbox_id, push_token_id) DO NOTHING%'
            AS notification_claim_waits_for_device,
          pg_get_functiondef(
            'public.register_family_push_token(uuid,text,text,text)'::regprocedure
          ) ILIKE '%interval ''30 days''%'
            AND pg_get_functiondef(
              'public.register_family_push_token(uuid,text,text,text)'::regprocedure
            ) ILIKE '%alert.resolved_at IS NULL%'
            AS notification_registration_recovery_ready
      `)
    const migrationHistory = await client.query(`
        SELECT version, name
        FROM supabase_migrations.schema_migrations
        WHERE version = ANY($1::text[])
      `, [expectedMigrationVersions])
    const tableNames = tables.rows.map(row => row.relname)
    const functionNames = functions.rows.map(row => row.proname)
    const missingTables = expectedTables.filter(name => !tableNames.includes(name))
    const missingFunctions = expectedFunctions.filter(name => !functionNames.includes(name))
    const unprotectedTables = tables.rows
      .filter(row => !row.relrowsecurity || row.policy_count < 1)
      .map(row => row.relname)

    const recordedVersions = new Set(migrationHistory.rows.map(row => row.version))
    const missingMigrations = expectedMigrationVersions.filter(version => !recordedVersions.has(version))
    const privateDeliveryStateReady = privateDeliveryState.rows[0]?.exists === true
      && privateDeliveryState.rows[0]?.client_access_revoked === true
    const expiredLocationsHidden = liveLocationPolicy.rows[0]?.hides_expired_locations === true
    const membershipDeleteIsRpcOnly = lifecycleHardening.rows[0]?.membership_delete_is_rpc_only === true
    const membershipCleanupTriggerReady = lifecycleHardening.rows[0]?.membership_cleanup_trigger_ready === true
    const nativeUpdatesClearStaleAddress = lifecycleHardening.rows[0]?.native_updates_clear_stale_address === true
    const renotifyUsesUniqueAlertGeneration = lifecycleHardening.rows[0]?.renotify_uses_unique_alert_generation === true
    const staleAcknowledgementIsTerminal = lifecycleHardening.rows[0]?.stale_acknowledgement_is_terminal === true
    const dangerIdempotencyPrecedesStatusMutation = lifecycleHardening.rows[0]?.danger_idempotency_precedes_status_mutation === true
    const terminalOutboxCleansDeviceDeliveries = lifecycleHardening.rows[0]?.terminal_outbox_cleans_device_deliveries === true
    const allSafetyEventsArePrivate = lifecycleHardening.rows[0]?.all_safety_events_are_private === true
    const orderedNotificationStateReady = lifecycleHardening.rows[0]?.ordered_notification_state_ready === true
    const notificationClaimsAreSerialized = lifecycleHardening.rows[0]?.notification_claims_are_serialized === true
    const notificationGenerationIsPersisted = lifecycleHardening.rows[0]?.notification_generation_is_persisted === true
    const notificationProtocolV3IsExclusive = lifecycleHardening.rows[0]?.notification_protocol_v3_is_exclusive === true
    const safetyIdempotencyStatusIsBound = lifecycleHardening.rows[0]?.safety_idempotency_status_is_bound === true
    const pgNetReady = lifecycleHardening.rows[0]?.pg_net_ready === true
    const dispatchKickTriggerReady = lifecycleHardening.rows[0]?.dispatch_kick_trigger_ready === true
    const notificationClaimWaitsForDevice = lifecycleHardening.rows[0]?.notification_claim_waits_for_device === true
    const notificationRegistrationRecoveryReady = lifecycleHardening.rows[0]?.notification_registration_recovery_ready === true
    if (
      missingTables.length
      || missingFunctions.length
      || unprotectedTables.length
      || missingMigrations.length
      || !privateDeliveryStateReady
      || !expiredLocationsHidden
      || !membershipDeleteIsRpcOnly
      || !membershipCleanupTriggerReady
      || !nativeUpdatesClearStaleAddress
      || !renotifyUsesUniqueAlertGeneration
      || !staleAcknowledgementIsTerminal
      || !dangerIdempotencyPrecedesStatusMutation
      || !terminalOutboxCleansDeviceDeliveries
      || !allSafetyEventsArePrivate
      || !orderedNotificationStateReady
      || !notificationClaimsAreSerialized
      || !notificationGenerationIsPersisted
      || !notificationProtocolV3IsExclusive
      || !safetyIdempotencyStatusIsBound
      || !pgNetReady
      || !dispatchKickTriggerReady
      || !notificationClaimWaitsForDevice
      || !notificationRegistrationRecoveryReady
    ) {
      throw new Error(JSON.stringify({
        missingTables,
        missingFunctions,
        unprotectedTables,
        missingMigrations,
        privateDeliveryStateReady,
        expiredLocationsHidden,
        membershipDeleteIsRpcOnly,
        membershipCleanupTriggerReady,
        nativeUpdatesClearStaleAddress,
        renotifyUsesUniqueAlertGeneration,
        staleAcknowledgementIsTerminal,
        dangerIdempotencyPrecedesStatusMutation,
        terminalOutboxCleansDeviceDeliveries,
        allSafetyEventsArePrivate,
        orderedNotificationStateReady,
        notificationClaimsAreSerialized,
        notificationGenerationIsPersisted,
        notificationProtocolV3IsExclusive,
        safetyIdempotencyStatusIsBound,
        pgNetReady,
        dispatchKickTriggerReady,
        notificationClaimWaitsForDevice,
        notificationRegistrationRecoveryReady,
      }))
    }

    console.log(JSON.stringify({
      ok: true,
      tables: tables.rows,
      functions: functionNames,
      migrationVersions: [...recordedVersions].sort(),
      privateDeliveryStateReady,
      expiredLocationsHidden,
      membershipDeleteIsRpcOnly,
      membershipCleanupTriggerReady,
      nativeUpdatesClearStaleAddress,
      renotifyUsesUniqueAlertGeneration,
      staleAcknowledgementIsTerminal,
      dangerIdempotencyPrecedesStatusMutation,
      terminalOutboxCleansDeviceDeliveries,
      allSafetyEventsArePrivate,
      orderedNotificationStateReady,
      notificationClaimsAreSerialized,
      notificationGenerationIsPersisted,
      notificationProtocolV3IsExclusive,
      safetyIdempotencyStatusIsBound,
      pgNetReady,
      dispatchKickTriggerReady,
      notificationClaimWaitsForDevice,
      notificationRegistrationRecoveryReady,
    }))
  } finally {
    await client.end()
  }
}

main().catch(error => {
  console.error(`Family safety schema check failed: ${error.message}`)
  process.exitCode = 1
})
