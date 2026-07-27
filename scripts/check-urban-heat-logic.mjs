import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'

const root = process.cwd()
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kalasag-urban-heat-'))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function transpile(source, destination) {
  const result = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: source,
    reportDiagnostics: true,
  })
  const errors = result.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  if (errors.length) throw new Error(`TypeScript transpilation failed for ${source}`)
  fs.writeFileSync(destination, result.outputText)
}

try {
  fs.writeFileSync(path.join(temporaryDirectory, 'package.json'), '{"type":"commonjs"}\n')
  transpile(path.join(root, 'src/lib/safeGrounds.ts'), path.join(temporaryDirectory, 'safeGrounds.js'))
  transpile(path.join(root, 'src/lib/urbanHeat.ts'), path.join(temporaryDirectory, 'urbanHeat.js'))
  transpile(path.join(root, 'src/lib/heatObservations.ts'), path.join(temporaryDirectory, 'heatObservations.js'))

  const require = createRequire(import.meta.url)
  const {
    classifyHeatDetection,
    normalizeHeatConfidence,
    parseUrbanSettlementMask,
  } = require(path.join(temporaryDirectory, 'urbanHeat.js'))
  const {
    HEAT_NEARBY_ALERT_MAX_AGE_MS,
    heatObservationAgeLabel,
    isHeatObservationWithinAge,
    normalizeHeatObservation,
    parseFirmsObservedAt,
  } = require(path.join(temporaryDirectory, 'heatObservations.js'))

  assert(normalizeHeatConfidence('l') === 'low', 'FIRMS l confidence was not normalized')
  assert(normalizeHeatConfidence('N') === 'nominal', 'FIRMS N confidence was not normalized')
  assert(normalizeHeatConfidence('high') === 'high', 'Long-form high confidence was not normalized')
  assert(normalizeHeatConfidence('invalid') === 'unknown', 'Invalid confidence should be unknown')

  assert(parseFirmsObservedAt('2026-07-18', '512') === '2026-07-18T05:12:00.000Z', 'FIRMS UTC acquisition time was not normalized')
  assert(parseFirmsObservedAt('2026-07-18', '2460') === null, 'Invalid FIRMS acquisition time should be rejected')
  assert(parseFirmsObservedAt('2026-02-31', '0512') === null, 'Invalid FIRMS calendar dates should be rejected')
  const observation = normalizeHeatObservation({
    id: 'heat-test', lat: 14.66, lng: 120.96, confidence: 'l', acq_date: '2026-07-18', acq_time: '0512',
    satellite: 'test', brightness: 310, frp: 4.43, daynight: 'D',
  })
  assert(observation?.observedAt === '2026-07-18T05:12:00.000Z', 'Heat records should get an auditable observedAt timestamp')
  const now = Date.parse('2026-07-18T06:00:00.000Z')
  assert(isHeatObservationWithinAge(observation, HEAT_NEARBY_ALERT_MAX_AGE_MS, now), 'A recent thermal observation should qualify for nearby monitoring')
  assert(!isHeatObservationWithinAge(observation, HEAT_NEARBY_ALERT_MAX_AGE_MS, now + 7 * 60 * 60 * 1000), 'An old thermal observation should not trigger a nearby alert')
  assert(heatObservationAgeLabel(observation, now) === '48 minutes ago', 'Heat observation age should be user-readable')

  const file = fs.readFileSync(path.join(root, 'public/data/ph-urban-settlements-2025.bin'))
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
  const mask = parseUrbanSettlementMask(buffer)

  const manila = classifyHeatDetection({ lat: 14.5995, lng: 120.9842, confidence: 'n' }, mask)
  assert(manila.kind === 'potential-residential-fire' && manila.urbanProximityKm === 0, 'Nominal Manila detection should be classified inside an urban cell')

  const rows = 2160, columns = 1440, headerBytes = 12, resolution = 1 / 120
  const isUrbanCell = (row, column) => {
    const index = row * columns + column
    return (file[headerBytes + (index >> 3)] & (1 << (index & 7))) !== 0
  }
  let nearbyUrban
  for (let row = 1; row < rows - 1 && !nearbyUrban; row += 1) {
    for (let column = 1; column < columns - 1; column += 1) {
      if (isUrbanCell(row, column) || !isUrbanCell(row, column - 1)) continue
      const lat = 22 - (row + 0.5) * resolution
      const lng = 116 + (column + 0.5) * resolution
      const classification = classifyHeatDetection({ lat, lng, confidence: 'h' }, mask)
      if (classification.kind === 'potential-residential-fire' && classification.urbanProximityKm > 0) {
        nearbyUrban = classification
        break
      }
    }
  }
  assert(nearbyUrban?.urbanProximityKm <= 1, 'Nearby non-urban cell should be classified within the one-kilometre limit')

  const lowConfidenceManila = classifyHeatDetection({ lat: 14.5995, lng: 120.9842, confidence: 'l' }, mask)
  assert(lowConfidenceManila.kind === 'heat-indication', 'Low-confidence urban detection should remain generic')

  const rural = classifyHeatDetection({ lat: 8.9537, lng: 119.9066, confidence: 'h' }, mask)
  assert(rural.kind === 'heat-indication', 'Remote marine control point should remain generic')

  const missingContext = classifyHeatDetection({ lat: 14.5995, lng: 120.9842, confidence: 'h' }, null)
  assert(missingContext.kind === 'heat-indication', 'Missing settlement context should fail closed')

  const corrupted = buffer.slice(0)
  new Uint8Array(corrupted)[0] = 0
  let rejectedCorruption = false
  try { parseUrbanSettlementMask(corrupted) } catch { rejectedCorruption = true }
  assert(rejectedCorruption, 'Corrupted settlement mask should be rejected')

  for (const relativePath of ['supabase/functions/live-data/index.ts', 'scripts/vite-live-data.ts']) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    assert(/observedAt/.test(source), `${relativePath} must publish normalized observation times`)
    assert(/satellite-active-fire-c2-regional-24h/.test(source), `${relativePath} must publish heat-dataset metadata`)
  }

  console.log('Urban heat and observation-age logic passed (timestamp, freshness, confidence, context, fallback, and corruption cases).')
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}
