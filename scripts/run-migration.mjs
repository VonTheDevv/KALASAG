import pg from 'pg'
import fs from 'fs'
import { databaseConfig, resolveMigrationPath } from './db-safety.mjs'

const { Client } = pg

async function main() {
  const migrationPath = resolveMigrationPath(process.argv[2])

  const client = new Client(databaseConfig())
  try {
    await client.connect()
    const sql = fs.readFileSync(migrationPath, 'utf8')
    await client.query(sql)
    console.log(`Migration executed: ${migrationPath}`)
  } finally {
    await client.end()
  }
}

main().catch(error => {
  console.error('Migration failed:', error.message)
  process.exitCode = 1
})
