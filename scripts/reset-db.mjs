/**
 * KALASAG — Database Reset Script (Node.js)
 * Run: node scripts/reset-db.mjs
 * Wipes all emergency profiles, QR codes, and password reset data.
 */

import pg from 'pg'
import readline from 'readline'
import { databaseConfig, requireDevelopmentReset } from './db-safety.mjs'

const { Client } = pg

async function askConfirmation() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question('\n⚠ This will DELETE ALL emergency profiles, QR codes, and reset codes. Continue? (yes/no): ', answer => {
      rl.close()
      resolve(answer.toLowerCase() === 'yes')
    })
  })
}

async function main() {
  requireDevelopmentReset('Development profile reset')
  const confirmed = await askConfirmation()
  if (!confirmed) { console.log('Cancelled.'); process.exit(0) }

  const client = new Client(databaseConfig())

  try {
    await client.connect()
    console.log('Connected to PostgreSQL.')
    await client.query('BEGIN')
    try {
      await client.query('TRUNCATE TABLE public.qr_codes CASCADE')
      await client.query(`
        UPDATE public.emergency_profiles SET
          first_name = '', middle_name = '', last_name = '',
          name_extension = '', blood_type = '', allergies = '',
          medications = '', conditions = '', contact_name = '',
          contact_first_name = '', contact_middle_name = '', contact_last_name = '',
          contact_number = '', contact_relation = '', street_address = '',
          city = '', postal_code = '', updated_at = now()
      `)
      await client.query('COMMIT')
      console.log('Development profile reset completed atomically.')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  } catch (err) {
    console.error('Reset failed:', err)
    process.exitCode = 1
  } finally { await client.end() }
}

main()
