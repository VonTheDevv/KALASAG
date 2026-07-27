import pg from 'pg'
import { databaseConfig } from './db-safety.mjs'

const client = new pg.Client(databaseConfig())

try {
  await client.connect()
  const result = await client.query(`
    SELECT
      to_regclass('public.password_reset_codes') IS NULL
        AND to_regclass('public.password_reset_otps') IS NULL AS legacy_otp_removed,
      to_regprocedure('public.create_family(text)') IS NOT NULL AS has_create_family,
      to_regprocedure('public.get_my_family_summaries()') IS NOT NULL AS has_family_summaries,
      to_regprocedure('public.submit_hazard_report(text,double precision,double precision,text)') IS NOT NULL
        AS has_hazard_submit,
      to_regprocedure('public.send_family_message(uuid,text,text,double precision,double precision,text)') IS NOT NULL
        AS has_secure_message_rpc,
      NOT has_table_privilege('authenticated', 'public.families', 'INSERT')
        AND NOT has_table_privilege('authenticated', 'public.family_members', 'INSERT')
        AS family_inserts_are_rpc_only,
      NOT has_table_privilege('authenticated', 'public.hazard_reports', 'INSERT')
        AS hazard_inserts_are_rpc_only,
      NOT has_any_column_privilege('authenticated', 'public.family_messages', 'INSERT')
        AS message_inserts_are_rpc_only,
      has_column_privilege('anon', 'public.hazard_reports', 'id', 'SELECT')
        AND has_column_privilege('anon', 'public.hazard_reports', 'description', 'SELECT')
        AND NOT has_column_privilege('anon', 'public.hazard_reports', 'user_id', 'SELECT')
        AS hazard_reporter_is_private,
      EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'public_hazard_reports'
          AND 'security_invoker=true' = ANY(coalesce(relation.reloptions, ARRAY[]::text[]))
      ) AS hazard_view_is_invoker,
      EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'family_messages'
          AND policyname = 'Approved members can send messages'
      ) AS has_secure_message_insert,
      EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'storage'
          AND tablename = 'objects'
          AND policyname = 'Approved members upload chat media'
      ) AS has_private_media_policy,
      EXISTS (
        SELECT 1 FROM storage.buckets
        WHERE id = 'chat_media'
          AND public = false
          AND file_size_limit = 20971520
          AND allowed_mime_types IS NOT NULL
      ) AS chat_media_is_bounded,
      EXISTS (
        SELECT 1 FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'family_join_attempt_limits'
          AND relation.relrowsecurity
      ) AS join_throttle_has_rls
  `)

  const checks = result.rows[0]
  const failures = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name)

  if (failures.length > 0) {
    throw new Error(`Security migration verification failed: ${failures.join(', ')}`)
  }

  console.log(`Security migration verification passed (${Object.keys(checks).length} checks).`)
} finally {
  await client.end()
}
