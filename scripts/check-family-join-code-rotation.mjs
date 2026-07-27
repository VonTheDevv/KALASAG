import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = process.cwd()
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kalasag-family-code-'))

try {
  const sourcePath = path.join(root, 'src/lib/familyJoinCode.ts')
  const modulePath = path.join(temporaryDirectory, 'familyJoinCode.mjs')
  const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  })
  const errors = transpiled.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  assert.equal(errors.length, 0, 'Family join-code utilities must transpile')
  fs.writeFileSync(modulePath, transpiled.outputText)

  const joinCode = await import(pathToFileURL(modulePath).href)
  assert.equal(joinCode.FAMILY_JOIN_CODE_LIFETIME_SECONDS, 7200)
  assert.equal(joinCode.formatJoinCodeCountdown(7200), '02:00:00')
  assert.equal(joinCode.formatJoinCodeCountdown(3661), '01:01:01')
  assert.equal(joinCode.formatJoinCodeCountdown(-1), '00:00:00')
  assert.equal(
    joinCode.secondsUntilJoinCodeRotation('2026-07-15T12:00:00.000Z', 0, Date.parse('2026-07-15T10:00:00.000Z')),
    7200,
  )
  assert.equal(
    joinCode.secondsUntilJoinCodeRotation('2026-07-15T12:00:00.000Z', 30_000, Date.parse('2026-07-15T11:59:45.000Z')),
    0,
  )

  const migration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260715083502_rotate_family_join_codes_every_two_hours.sql'),
    'utf8',
  )
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pg_cron/)
  assert.match(migration, /join_code_rotated_at\s*>\s*statement_timestamp\(\)\s*-\s*interval '2 hours'/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION private\.rotate_due_family_join_codes/)
  assert.match(migration, /REVOKE ALL ON FUNCTION private\.rotate_due_family_join_codes\(integer\)[\s\S]*FROM PUBLIC, anon, authenticated/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_family_join_code/)
  assert.match(migration, /'kalasag-rotate-family-join-codes'[\s\S]*'\* \* \* \* \*'/)

  const dashboard = fs.readFileSync(path.join(root, 'src/components/FamilyDashboard.tsx'), 'utf8')
  assert.match(dashboard, /rpc\('get_family_join_code'/)
  assert.match(dashboard, /secondsUntilJoinCodeRotation/)
  assert.match(dashboard, /joinCodeSecondsRemaining\s*>\s*0/)
  assert.match(dashboard, /Next code in/)

  console.log('Family join-code rotation checks passed (two-hour expiry, cron enforcement, host RPC, and countdown).')
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
