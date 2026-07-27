const fs = require('node:fs')
const { Client } = require('pg')

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required')

const caPath = process.env.DATABASE_CA_CERT_PATH
const client = new Client({
  connectionString,
  ssl: {
    rejectUnauthorized: true,
    ...(caPath ? { ca: fs.readFileSync(caPath, 'utf8') } : {}),
  },
  connectionTimeoutMillis: 15_000,
  statement_timeout: 15_000,
  query_timeout: 15_000,
  application_name: 'kalasag-alert-diagnostic',
})

async function main() {
  await client.connect()
  const result = {}

  result.outbox = (await client.query(`
    SELECT event_type, status, count(*)::int AS jobs,
      max(attempts)::int AS max_attempts,
      min(created_at) AS oldest,
      max(updated_at) AS latest
    FROM private.notification_outbox
    GROUP BY event_type, status
    ORDER BY event_type, status
  `)).rows

  result.recentOutbox = (await client.query(`
    SELECT event_type, status, attempts, created_at, updated_at,
      left(coalesce(last_error, ''), 160) AS last_error
    FROM private.notification_outbox
    ORDER BY created_at DESC
    LIMIT 20
  `)).rows

  result.deliveries = (await client.query(`
    SELECT status, count(*)::int AS deliveries,
      max(attempts)::int AS max_attempts,
      max(updated_at) AS latest
    FROM private.notification_outbox_deliveries
    GROUP BY status
    ORDER BY status
  `)).rows

  result.recentDeliveryErrors = (await client.query(`
    SELECT status, left(coalesce(last_error, ''), 180) AS last_error,
      count(*)::int AS occurrences,
      max(updated_at) AS latest
    FROM private.notification_outbox_deliveries
    WHERE last_error IS NOT NULL
    GROUP BY status, left(coalesce(last_error, ''), 180)
    ORDER BY latest DESC
    LIMIT 12
  `)).rows

  result.tokens = (await client.query(`
    SELECT platform, app_version, is_active, count(*)::int AS tokens,
      max(last_seen_at) AS latest_seen,
      min(last_seen_at) AS oldest_seen
    FROM private.device_push_tokens
    GROUP BY platform, app_version, is_active
    ORDER BY platform, app_version, is_active DESC
  `)).rows

  result.jobsWithoutDevices = (await client.query(`
    SELECT count(*)::int AS jobs
    FROM private.notification_outbox AS outbox
    WHERE outbox.status IN ('pending', 'retry', 'processing')
      AND NOT EXISTS (
        SELECT 1
        FROM private.device_push_tokens AS token
        WHERE token.user_id = outbox.recipient_user_id
          AND token.is_active
      )
  `)).rows[0]

  result.cronSchema = (await client.query(`
    SELECT to_regnamespace('cron') IS NOT NULL AS available
  `)).rows[0]

  result.extensions = (await client.query(`
    SELECT extname
    FROM pg_extension
    WHERE extname IN ('pg_net', 'http', 'pg_cron', 'vault')
    ORDER BY extname
  `)).rows.map(row => row.extname)

  result.vaultSecretNames = toRegnamespaceAvailable(await client.query(`
    SELECT to_regnamespace('vault') IS NOT NULL AS available
  `))
    ? (await client.query(`SELECT name FROM vault.secrets ORDER BY name`)).rows.map(row => row.name)
    : []

  result.schedulerCredentialAvailability = (await client.query(`
    SELECT
      nullif(current_setting('app.settings.service_role_key', true), '') IS NOT NULL
        AS service_role_key,
      nullif(current_setting('app.settings.jwt_secret', true), '') IS NOT NULL
        AS jwt_secret,
      nullif(current_setting('app.settings.anon_key', true), '') IS NOT NULL
        AS anon_key
  `)).rows[0]

  if (result.cronSchema.available) {
    result.cronJobs = (await client.query(`
      SELECT jobid, jobname, schedule, active
      FROM cron.job
      ORDER BY jobname
    `)).rows
    result.cronRuns = (await client.query(`
      SELECT job.jobname, detail.status, detail.start_time, detail.end_time
      FROM cron.job_run_details AS detail
      JOIN cron.job AS job ON job.jobid = detail.jobid
      ORDER BY detail.start_time DESC
      LIMIT 20
    `)).rows
  }

  console.log(JSON.stringify(result, null, 2))
}

function toRegnamespaceAvailable(result) {
  return result.rows[0]?.available === true
}

main()
  .catch(error => {
    console.error(`Family alert diagnostic failed: ${error.message}`)
    process.exitCode = 1
  })
  .finally(() => client.end())
