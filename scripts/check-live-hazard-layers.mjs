import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  OFFICIAL_DAM_LOCATION_BASELINE,
  OFFICIAL_DAM_LOCATION_BASELINE_SOURCE,
} from '../supabase/functions/_shared/dam-location-baseline.js'

const root = process.cwd()
const hazardMap = fs.readFileSync(path.join(root, 'src/components/HazardMap.tsx'), 'utf8')
const liveDataClient = fs.readFileSync(path.join(root, 'src/lib/liveData.ts'), 'utf8')
const roadTraffic = fs.readFileSync(path.join(root, 'src/components/RoadTraffic.tsx'), 'utf8')
const baselineLayers = fs.readFileSync(path.join(root, 'src/components/hazards/HazardBaselineLayers.tsx'), 'utf8')
const baselineConfig = fs.readFileSync(path.join(root, 'src/components/hazards/hazardBaselineConfig.ts'), 'utf8')
const damPanel = fs.readFileSync(path.join(root, 'src/components/hazards/DamStatusPanel.tsx'), 'utf8')
const officialHazardData = fs.readFileSync(path.join(root, 'scripts/official-hazard-data.ts'), 'utf8')

assert.doesNotMatch(hazardMap, /RoadIncidentLayer|roadIncidents|Provider-reported Road Incident/)
assert.equal(fs.existsSync(path.join(root, 'src/components/RoadIncidentLayer.tsx')), false)
assert.match(roadTraffic, /fetchTrafficIncidents/, 'The separate Road Traffic incident feed must remain available')

assert.doesNotMatch(hazardMap, /landslide|LHASA/i)
assert.doesNotMatch(liveDataClient, /landslide-image|LHASA/i)
assert.equal(fs.existsSync(path.join(root, 'src/components/LandslideRiskLayer.tsx')), false)
assert.equal(fs.existsSync(path.join(root, 'src/lib/landslideMarkers.ts')), false)

assert.match(hazardMap, /Reported flood event:/, 'Flood events must be labelled as contextual point reports')
assert.doesNotMatch(hazardMap, /f\.severity === 'Severe' \? 25000/, 'Flood event points must not render fabricated radius circles')
assert.doesNotMatch(hazardMap, /cyc\.alertlevel === 'Red' \? 200000/, 'Cyclones must not render a fabricated alert-level radius')
assert.match(hazardMap, /Flood Susceptibility/)
assert.match(hazardMap, /Storm Surge Hazard/)
assert.match(hazardMap, /Dam Status/)
assert.match(baselineConfig, /VITE_FLOOD_HAZARD_TILE_URL/)
assert.match(baselineConfig, /VITE_STORM_SURGE_TILE_URL/)
assert.match(baselineLayers, /HazardBaselineLayer/)
assert.match(damPanel, /release times are never estimated/i)
assert.match(damPanel, /reservoirWaterLevelM/)
assert.equal(OFFICIAL_DAM_LOCATION_BASELINE.length, 7, 'The verified official dam-location baseline must remain complete')
assert.match(OFFICIAL_DAM_LOCATION_BASELINE_SOURCE, /^https:\/\/portal\.georisk\.gov\.ph\//)
for (const location of OFFICIAL_DAM_LOCATION_BASELINE) {
  assert.ok(location.name.length >= 3)
  assert.ok(Number.isFinite(location.lat) && location.lat >= 4.5 && location.lat <= 21.5)
  assert.ok(Number.isFinite(location.lng) && location.lng >= 116 && location.lng <= 127.5)
}
assert.match(officialHazardData, /OFFICIAL_DAM_LOCATION_BASELINE/, 'The development gateway must retain verified dam positions during location-provider outages')

for (const gatewayPath of [
  'supabase/functions/live-data/index.ts',
  'scripts/vite-live-data.ts',
  'server/storm-relay.mjs',
]) {
  const gateway = fs.readFileSync(path.join(root, gatewayPath), 'utf8')
  assert.doesNotMatch(gateway, /landslide-image|LHASA_Hazard_Today|NASA_LHASA/i)
  if (!gatewayPath.endsWith('storm-relay.mjs')) {
    for (const resource of ['flood-advisories', 'storm-surge-advisories', 'dams', 'dam-release-advisories', 'reverse-geocode']) {
      assert.match(gateway, new RegExp(resource), `${gatewayPath} must expose ${resource}`)
    }
    if (gatewayPath.startsWith('supabase/')) {
      assert.match(gateway, /OFFICIAL_DAM_LOCATION_BASELINE/, `${gatewayPath} must retain verified dam positions during location-provider outages`)
    }
  }
}

const productionNginx = fs.readFileSync(path.join(root, 'deploy/nginx/kalasagph-domain.conf'), 'utf8')
assert.match(productionNginx, /if\s*\(\$arg_resource\s*=\s*landslide-image\)\s*\{\s*return\s+410;\s*\}/)

console.log('Hazard layers use explicit official/advisory contracts; flood event points have no fabricated radius; dam and configured baseline layers are present.')
