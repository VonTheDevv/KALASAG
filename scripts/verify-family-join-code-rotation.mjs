import assert from 'node:assert/strict'
import pg from 'pg'
import { databaseConfig } from './db-safety.mjs'

const client = new pg.Client(databaseConfig())
let transactionOpen = false

try {
  await client.connect()

  const { rows: [schema] } = await client.query(`
    SELECT
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS cron_installed,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'families'
          AND column_name = 'join_code_rotated_at'
          AND is_nullable = 'NO'
      ) AS rotation_timestamp_required,
      to_regprocedure('private.rotate_family_join_code_if_due(uuid,timestamp with time zone)') IS NOT NULL
        AS has_single_rotation,
      to_regprocedure('private.rotate_due_family_join_codes(integer)') IS NOT NULL
        AS has_batch_rotation,
      to_regprocedure('public.get_family_join_code(uuid)') IS NOT NULL AS has_host_rpc,
      NOT has_schema_privilege('authenticated', 'private', 'USAGE') AS private_schema_hidden,
      NOT has_function_privilege(
        'authenticated',
        'private.rotate_due_family_join_codes(integer)',
        'EXECUTE'
      ) AS batch_rotation_hidden,
      has_function_privilege('authenticated', 'public.get_family_join_code(uuid)', 'EXECUTE')
        AS host_rpc_available,
      EXISTS (
        SELECT 1
        FROM cron.job
        WHERE jobname = 'kalasag-rotate-family-join-codes'
          AND schedule = '* * * * *'
          AND command = 'SELECT private.rotate_due_family_join_codes(5000)'
          AND active
      ) AS cron_job_active
  `)
  const failedSchemaChecks = Object.entries(schema).filter(([, passed]) => passed !== true).map(([name]) => name)
  assert.deepEqual(failedSchemaChecks, [], `Family code schema checks failed: ${failedSchemaChecks.join(', ')}`)

  await client.query('BEGIN')
  transactionOpen = true
  const { rows: [family] } = await client.query(`
    SELECT id, host_id, join_code
    FROM public.families
    ORDER BY id
    LIMIT 1
    FOR UPDATE
  `)
  assert.ok(family, 'At least one family is required for live rotation verification')

  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [family.host_id])
  await client.query(`DELETE FROM public.family_join_attempt_limits WHERE user_id = $1`, [family.host_id])
  await client.query(`
    UPDATE public.families
    SET join_code_rotated_at = statement_timestamp() - interval '2 hours 1 second'
    WHERE id = $1
  `, [family.id])

  const { rows: firstRefresh } = await client.query(`SELECT * FROM public.get_family_join_code($1)`, [family.id])
  assert.equal(firstRefresh.length, 1)
  assert.match(firstRefresh[0].join_code, /^\d{8}$/)
  assert.notEqual(firstRefresh[0].join_code, family.join_code)
  assert.equal(
    new Date(firstRefresh[0].expires_at).getTime() - new Date(firstRefresh[0].rotated_at).getTime(),
    2 * 60 * 60 * 1000,
  )
  assert.ok(new Date(firstRefresh[0].expires_at) > new Date(firstRefresh[0].server_now))

  await client.query(`
    UPDATE public.families
    SET join_code_rotated_at = statement_timestamp() - interval '2 hours 1 second'
    WHERE id = $1
  `, [family.id])
  const { rows: [expiredAttempt] } = await client.query(`
    SELECT public.join_family_by_code($1, 'ignored') AS result
  `, [firstRefresh[0].join_code])
  assert.equal(expiredAttempt.result.success, false)
  assert.equal(expiredAttempt.result.error, 'Invalid or expired join code')

  const { rows: secondRefresh } = await client.query(`SELECT * FROM public.get_family_join_code($1)`, [family.id])
  assert.equal(secondRefresh.length, 1)
  assert.notEqual(secondRefresh[0].join_code, firstRefresh[0].join_code)

  await client.query('ROLLBACK')
  transactionOpen = false
  console.log('Live family join-code rotation passed (cron, host refresh, expiry rejection, and rollback-safe behavior).')
} finally {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
  await client.end()
}
