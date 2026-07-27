import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const findings = []
const sourceRoots = ['src', 'server', 'scripts', 'supabase', 'deploy', 'vite.config.ts', 'migrate.cjs', 'index.html']
const ignoredNames = new Set(['node_modules', 'dist', '.git'])

function walk(target) {
  const absolute = path.resolve(root, target)
  if (!fs.existsSync(absolute)) return []
  const stat = fs.statSync(absolute)
  if (stat.isFile()) return [absolute]
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    if (ignoredNames.has(entry.name)) return []
    return walk(path.join(target, entry.name))
  })
}

const sourceFiles = sourceRoots.flatMap(walk).filter(file => (
  !path.basename(file).startsWith('.env')
  && path.basename(file) !== 'security-check.mjs'
))
const forbiddenPatterns = [
  { label: 'public CORS proxy fallback', expression: /corsproxy\.io/i },
  { label: 'disabled TLS certificate verification', expression: /rejectUnauthorized\s*:\s*false|secure\s*:\s*false/i },
  { label: 'browser-prefixed provider secret', expression: /VITE_(?:TOMTOM|AISSTREAM|GFW|DATABASE|POSTGRES|SERVICE_ROLE)[A-Z0-9_]*/ },
  { label: 'dangerous raw HTML sink', expression: /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(/ },
  { label: 'embedded PostgreSQL connection string', expression: /postgres(?:ql)?:\/\/[^\s'"`]+/i },
]

for (const envName of ['.env', '.env.local', '.env.example']) {
  const envPath = path.resolve(root, envName)
  if (!fs.existsSync(envPath)) continue
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const variableName = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)?.[1]
    if (variableName && /^VITE_(?:TOMTOM|AISSTREAM|GFW|DATABASE|POSTGRES|SERVICE_ROLE)/.test(variableName)) {
      findings.push(`${envName}: server-only credential ${variableName} must not use the VITE_ prefix`)
    }
  }
}

for (const file of sourceFiles) {
  const contents = fs.readFileSync(file, 'utf8')
  for (const pattern of forbiddenPatterns) {
    if (pattern.expression.test(contents)) findings.push(`${path.relative(root, file)}: ${pattern.label}`)
  }
  if (path.relative(root, file).startsWith(`src${path.sep}`) && /fetch\s*\(\s*['"`]https?:\/\//i.test(contents)) {
    findings.push(`${path.relative(root, file)}: browser code must use the bounded same-origin live-data gateway`)
  }
  if (path.relative(root, file).startsWith(`src${path.sep}`) && /from\(['"](?:family_messages|hazard_reports)['"]\)[\s\S]{0,120}\.insert\s*\(/.test(contents)) {
    findings.push(`${path.relative(root, file)}: protected chat and hazard writes must use validated RPCs`)
  }
}

for (const resetScript of ['scripts/reset-all.mjs', 'scripts/reset-db.mjs', 'scripts/reset.py']) {
  const resetPath = path.resolve(root, resetScript)
  if (fs.existsSync(resetPath) && fs.readFileSync(resetPath, 'utf8').includes('password_reset_otps')) {
    findings.push(`${resetScript}: references the removed legacy OTP table`)
  }
}

const indexPath = path.resolve(root, 'index.html')
if (!fs.readFileSync(indexPath, 'utf8').includes('http-equiv="Content-Security-Policy"')) {
  findings.push('index.html: Content Security Policy is required')
}

const addressSearchPath = path.resolve(root, 'src', 'lib', 'addressSearch.ts')
const addressSearch = fs.existsSync(addressSearchPath) ? fs.readFileSync(addressSearchPath, 'utf8') : ''
if (/photon\.komoot\.io/i.test(addressSearch)) {
  findings.push('address search: browser code must not contact the upstream geocoder directly')
}
const productionNginxPath = path.resolve(root, 'deploy', 'nginx', 'kalasagph-domain.conf')
const productionNginx = fs.existsSync(productionNginxPath) ? fs.readFileSync(productionNginxPath, 'utf8') : ''
if (!/location\s*=\s*\/api\/address-search/.test(productionNginx)
  || !/limit_req\s+zone=kalasag_address_per_ip/.test(productionNginx)
  || !/proxy_pass\s+https:\/\/photon\.komoot\.io\/api/.test(productionNginx)) {
  findings.push('address search: production gateway must remain bounded and server-side')
}

const stormRelayPath = path.resolve(root, 'server', 'storm-relay.mjs')
const stormRelay = fs.existsSync(stormRelayPath) ? fs.readFileSync(stormRelayPath, 'utf8') : ''
if (!/MAX_FEED_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024/.test(stormRelay)
  || !/readLimitedJson/.test(stormRelay)
  || !/STALE_MS\s*=\s*30\s*\*\s*60_000/.test(stormRelay)
  || !/feature\?\.geometry\?\.type\s*!==\s*['"]Point['"]/.test(stormRelay)) {
  findings.push('storm relay: GDACS retrieval must remain bounded, cached, and limited to point events')
}
if (!/if\s*\(\$arg_resource\s*=\s*storms\)\s*\{\s*return\s+418;\s*\}/.test(productionNginx)
  || !/if\s*\(\$arg_resource\s*=\s*landslide-image\)\s*\{\s*return\s+410;\s*\}/.test(productionNginx)
  || !/location\s+@kalasag_storm_feed/.test(productionNginx)
  || !/proxy_pass\s+http:\/\/127\.0\.0\.1:8790/.test(productionNginx)
  || !/proxy_read_timeout\s+30s/.test(productionNginx)
  || /landslide-image|LHASA/i.test(stormRelay)) {
  findings.push('live hazard relay: production Nginx must retire landslide-image and route only cyclone requests to the loopback service')
}

const supabaseConfigPath = path.resolve(root, 'supabase', 'config.toml')
const supabaseConfig = fs.existsSync(supabaseConfigPath) ? fs.readFileSync(supabaseConfigPath, 'utf8') : ''
if (!/\[functions\.live-data\][\s\S]*?verify_jwt\s*=\s*true/.test(supabaseConfig)) {
  findings.push('supabase/config.toml: live-data must require JWT verification')
}

const aisRelayFunctionPath = path.resolve(root, 'supabase', 'functions', 'ais-relay', 'index.ts')
const aisRelayFunction = fs.existsSync(aisRelayFunctionPath) ? fs.readFileSync(aisRelayFunctionPath, 'utf8') : ''
if (!/\[functions\.ais-relay\][\s\S]*?verify_jwt\s*=\s*false/.test(supabaseConfig)
  || !/accessTokenFromAuthFrame/.test(aisRelayFunction)
  || !/authenticateUser\(accessToken\)/.test(aisRelayFunction)) {
  findings.push('ais-relay: gateway JWT exemption requires bounded first-frame user authentication')
}
if (/searchParams\.(?:get|set)\(\s*['"](?:jwt|token|access_token)['"]/i.test(aisRelayFunction)) {
  findings.push('ais-relay: access tokens must never be placed in WebSocket URLs')
}
if (/upgradeWebSocket\([^\n]*\bprotocol\b/.test(aisRelayFunction)) {
  findings.push('ais-relay: hosted Supabase WebSocket upgrades must not use unsupported protocol selection')
}

const familyDispatcherPath = path.resolve(root, 'supabase', 'functions', 'family-alert-dispatch', 'index.ts')
const familyDispatcher = fs.existsSync(familyDispatcherPath) ? fs.readFileSync(familyDispatcherPath, 'utf8') : ''
const familyProviderPath = path.resolve(root, 'src', 'hooks', 'FamilySafetyProvider.tsx')
const familyProvider = fs.existsSync(familyProviderPath) ? fs.readFileSync(familyProviderPath, 'utf8') : ''
const familyHardeningMigrationPath = path.resolve(
  root,
  'supabase',
  'migrations',
  '20260717164000_family_alert_idempotency_terminal_ack.sql',
)
const familyHardeningMigration = fs.existsSync(familyHardeningMigrationPath)
  ? fs.readFileSync(familyHardeningMigrationPath, 'utf8')
  : ''
const orderedFamilyMigrationPath = path.resolve(
  root,
  'supabase',
  'migrations',
  '20260717174000_family_safety_ordered_delivery.sql',
)
const orderedFamilyMigration = fs.existsSync(orderedFamilyMigrationPath)
  ? fs.readFileSync(orderedFamilyMigrationPath, 'utf8')
  : ''
const protocolCutoverMigrationPath = path.resolve(
  root,
  'supabase',
  'migrations',
  '20260717180000_family_notification_protocol_cutover.sql',
)
const protocolCutoverMigration = fs.existsSync(protocolCutoverMigrationPath)
  ? fs.readFileSync(protocolCutoverMigrationPath, 'utf8')
  : ''
if (!/familyAlertTag\s*=\s*`family-alert-\$\{job\.family_id\}-\$\{alertActorId\}`/.test(familyDispatcher)
  || !/replacementKey:\s*`\$\{activeAlert\.family_id\}:\$\{activeAlert\.reporter_user_id\}`/.test(familyProvider)) {
  findings.push('family safety: danger notifications must replace older occurrences for the same family member')
}
if (!/mark_notification_deliveries_dead_with_outbox/.test(familyHardeningMigration)
  || !/p_alert_updated_at[\s\S]*RETURN false;/.test(familyHardeningMigration)
  || (familyHardeningMigration.match(/FROM private\.family_alert_client_events AS event/g)?.length ?? 0) < 2) {
  findings.push('family safety: offline acknowledgements and duplicate danger events must remain terminal and idempotent')
}
if (!/family_safety_client_events/.test(orderedFamilyMigration)
  || !/active\.display_key\s*=\s*job\.display_key/.test(orderedFamilyMigration)
  || !/is_family_notification_job_current/.test(orderedFamilyMigration)
  || (orderedFamilyMigration.match(/FOR UPDATE;/g)?.length ?? 0) < 3
  || !/cancelFamilyDangerNotification/.test(familyProvider)
  || !/is_family_notification_job_current/.test(familyDispatcher)) {
  findings.push('family safety: safety transitions and notification delivery must remain ordered across retries')
}
if (!/claim_family_notification_deliveries_v3/.test(protocolCutoverMigration)
  || !/notification_outbox_display_protocol_check/.test(protocolCutoverMigration)
  || !/v_recorded_status IS DISTINCT FROM 'in_danger'/.test(protocolCutoverMigration)
  || !/v_recorded_status IS DISTINCT FROM p_safety_status/.test(protocolCutoverMigration)
  || !/claim_family_notification_deliveries_v3/.test(familyDispatcher)
  || /claim_family_notification_outbox|complete_family_notification_outbox|rpcIsUnavailable/.test(familyDispatcher)) {
  findings.push('family safety: ordered notification protocol v3 must fail closed without legacy queue fallbacks')
}
const androidMessagingPath = path.resolve(
  root,
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'kalasagph',
  'app',
  'KalasagMessagingService.java',
)
const androidMessaging = fs.existsSync(androidMessagingPath)
  ? fs.readFileSync(androidMessagingPath, 'utf8')
  : ''
const androidManifestPath = path.resolve(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
const androidManifest = fs.existsSync(androidManifestPath)
  ? fs.readFileSync(androidManifestPath, 'utf8')
  : ''
if (!/sequence\s*<=\s*current/.test(androidMessaging)
  || !/SharedPreferences/.test(androidMessaging)
  || !/stableLocalNotificationId\(displayKey\)/.test(androidMessaging)
  || !/manager\.cancel\(notificationTag,\s*0\)/.test(androidMessaging)
  || !/KalasagMessagingService/.test(androidManifest)
  || !/com\.capacitorjs\.plugins\.pushnotifications\.MessagingService[\s\S]*tools:node="remove"/.test(androidManifest)
  || !/Data-only delivery is intentional/.test(familyDispatcher)) {
  findings.push('family safety: Android must reject stale FCM generations before displaying notifications')
}
if (/job\.event_type === 'family_danger'[\s\S]{0,600}collapse_key/.test(familyDispatcher)
  || /job\.event_type === 'family_alert_resolved'[\s\S]{0,600}collapse_key/.test(familyDispatcher)) {
  findings.push('family safety: ordered danger/resolution generations must not share an FCM collapse key')
}

const dist = path.resolve(root, 'dist')
if (fs.existsSync(dist)) {
  const distFiles = walk('dist')
  const maps = distFiles.filter(file => file.endsWith('.map'))
  if (maps.length) findings.push(`dist: ${maps.length} source map(s) must not be shipped`)

  const envFiles = ['.env', '.env.local'].map(file => path.resolve(root, file)).filter(fs.existsSync)
  const secrets = new Map()
  for (const envFile of envFiles) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (!match || match[1].startsWith('VITE_SUPABASE_')) continue
      const value = match[2].trim().replace(/^['"]|['"]$/g, '')
      if (value.length >= 12) secrets.set(match[1], value)
    }
  }

  for (const file of distFiles.filter(file => fs.statSync(file).isFile())) {
    const contents = fs.readFileSync(file)
    for (const [name, value] of secrets) {
      if (contents.includes(Buffer.from(value))) findings.push(`${path.relative(root, file)}: contains server-only secret ${name}`)
    }
  }
}

if (findings.length) {
  console.error('Security regression check failed:')
  findings.forEach(finding => console.error(`- ${finding}`))
  process.exitCode = 1
} else {
  console.log(`Security regression check passed (${sourceFiles.length} source/config files inspected).`)
}
