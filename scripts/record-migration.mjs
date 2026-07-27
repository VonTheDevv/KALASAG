import path from 'node:path'
import pg from 'pg'
import { databaseConfig, resolveMigrationPath } from './db-safety.mjs'

const migrationPath = resolveMigrationPath(process.argv[2])
const match = path.basename(migrationPath).match(/^(\d{14})_(.+)\.sql$/)
if (!match) throw new Error('Migration filename must use <14-digit-version>_<name>.sql')

const [, version, name] = match
const client = new pg.Client(databaseConfig())

try {
  await client.connect()
  await client.query(`
    INSERT INTO supabase_migrations.schema_migrations (version, name)
    SELECT $1, $2
    WHERE NOT EXISTS (
      SELECT 1
      FROM supabase_migrations.schema_migrations
      WHERE version = $1
    )
  `, [version, name])
  console.log(`Migration history recorded: ${version} ${name}`)
} finally {
  await client.end()
}
