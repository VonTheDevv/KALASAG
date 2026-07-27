import pg from 'pg'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { databaseConfig, requireDevelopmentReset } from './db-safety.mjs'

const { Client } = pg

async function main() {
  requireDevelopmentReset('Full user reset')
  const prompt = readline.createInterface({ input, output })
  const answer = await prompt.question('Delete every development user and related record? Type DELETE ALL USERS: ')
  prompt.close()
  if (answer !== 'DELETE ALL USERS') throw new Error('Reset cancelled')

  const client = new Client(databaseConfig())
  try {
    await client.connect()
    await client.query('BEGIN')
    try {
      const { rowCount } = await client.query('DELETE FROM auth.users')
      await client.query('TRUNCATE TABLE public.user_profiles CASCADE')
      await client.query('TRUNCATE TABLE public.emergency_profiles CASCADE')
      await client.query('TRUNCATE TABLE public.qr_codes CASCADE')
      await client.query('COMMIT')
      console.log(`Deleted ${rowCount} users and related development data.`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } finally {
    await client.end()
  }
}

main().catch(error => {
  console.error('Reset failed:', error.message)
  process.exitCode = 1
})
