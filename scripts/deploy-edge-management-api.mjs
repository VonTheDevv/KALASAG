import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function argumentsFor(name) {
  const values = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === `--${name}` && process.argv[index + 1]) {
      values.push(process.argv[index + 1])
    }
  }
  return values
}

const slug = argument('slug')
const entrypointPath = argument('entrypoint')
const fileMappings = argumentsFor('file')
const projectRef = argument('project-ref') || process.env.SUPABASE_PROJECT_REF
const accessToken = process.env.SUPABASE_ACCESS_TOKEN
const bundleOnly = process.argv.includes('--bundle-only')

if (!slug || fileMappings.length === 0 || !entrypointPath || !projectRef || !accessToken) {
  console.error('Required: SUPABASE_ACCESS_TOKEN and --project-ref, --slug, --entrypoint, one or more --file local=remote')
  process.exit(2)
}
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || !/^[a-z0-9]{20}$/.test(projectRef)) {
  console.error('Invalid function slug or project reference')
  process.exit(2)
}

const form = new FormData()
for (const mapping of fileMappings) {
  const separator = mapping.indexOf('=')
  const localPath = separator >= 0 ? mapping.slice(0, separator) : mapping
  const remotePath = separator >= 0 ? mapping.slice(separator + 1) : path.basename(mapping)
  if (!localPath || !remotePath || remotePath.startsWith('/') || remotePath.includes('..')) {
    throw new Error(`Invalid function file mapping: ${mapping}`)
  }
  const source = await readFile(localPath)
  form.append('file', new Blob([source], { type: 'application/typescript' }), remotePath.replaceAll('\\', '/'))
}
form.append('metadata', JSON.stringify({
  name: slug,
  entrypoint_path: entrypointPath,
  verify_jwt: true,
}))

const url = new URL(`https://api.supabase.com/v1/projects/${projectRef}/functions/deploy`)
url.searchParams.set('slug', slug)
if (bundleOnly) url.searchParams.set('bundleOnly', 'true')

const response = await fetch(url, {
  method: 'POST',
  headers: { authorization: `Bearer ${accessToken}` },
  body: form,
  signal: AbortSignal.timeout(120_000),
})
const body = await response.text()
if (!response.ok) {
  console.error(body.slice(0, 1_200))
  throw new Error(`Supabase function deployment returned HTTP ${response.status}`)
}

let parsed = null
try {
  parsed = JSON.parse(body)
} catch {
  // The bundle-only API response may change representation. A successful HTTP
  // status remains authoritative; never print bundled source or credentials.
}
console.log(JSON.stringify({
  ok: true,
  status: response.status,
  bundleOnly,
  slug: parsed?.slug ?? slug,
  version: parsed?.version ?? null,
  deploymentStatus: parsed?.status ?? null,
  verifyJwt: parsed?.verify_jwt ?? true,
  responseBytes: body.length,
}, null, 2))
