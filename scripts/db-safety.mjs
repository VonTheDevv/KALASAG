import fs from 'node:fs'
import path from 'node:path'

const RESET_CONFIRMATION = 'YES_I_UNDERSTAND'

export function databaseConfig() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is required')

  const caPath = process.env.DATABASE_CA_CERT_PATH
  const ca = caPath ? fs.readFileSync(path.resolve(caPath), 'utf8') : undefined

  return {
    connectionString,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
    application_name: 'kalasagph-maintenance',
  }
}

export function requireDevelopmentReset(action) {
  if (process.env.APP_ENV !== 'development' || process.env.ALLOW_DATABASE_RESET !== RESET_CONFIRMATION) {
    throw new Error(
      `${action} is restricted to APP_ENV=development and requires ALLOW_DATABASE_RESET=${RESET_CONFIRMATION}`,
    )
  }
}

export function resolveMigrationPath(inputPath) {
  if (!inputPath) throw new Error('Pass an explicit migration path under supabase/migrations')

  const migrationsRoot = path.resolve('supabase', 'migrations')
  const resolvedPath = path.resolve(inputPath)
  const relativePath = path.relative(migrationsRoot, resolvedPath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath) || path.extname(resolvedPath) !== '.sql') {
    throw new Error('Only SQL files under supabase/migrations may be executed')
  }

  return resolvedPath
}
