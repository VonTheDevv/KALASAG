import { GeoJSON, Pane } from 'react-leaflet'
import type { GeoJsonObject } from 'geojson'
import type { FloodAdvisory, HazardAreaGeometry, StormSurgeAdvisory } from '../../lib/liveData'

type Props = {
  floodAdvisories: FloodAdvisory[]
  showFlood: boolean
  showStormSurge: boolean
  stormSurgeAdvisories: StormSurgeAdvisory[]
}

function geoJsonFeature(id: string, geometry: HazardAreaGeometry): GeoJsonObject {
  return {
    type: 'Feature',
    properties: { id },
    geometry,
  } as GeoJsonObject
}

function validOfficialGeometry(geometry: HazardAreaGeometry | null): geometry is HazardAreaGeometry {
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') || !Array.isArray(geometry.coordinates)) return false
  let coordinatePairs = 0
  let valid = true
  const visit = (value: unknown) => {
    if (!valid || coordinatePairs > 20_000 || !Array.isArray(value)) { valid = false; return }
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      const lng = value[0], lat = value[1]
      coordinatePairs += 1
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 3 || lat > 23 || lng < 114 || lng > 137) valid = false
      return
    }
    value.forEach(visit)
  }
  visit(geometry.coordinates)
  return valid && coordinatePairs >= 3 && coordinatePairs <= 20_000
}

export default function HazardAdvisoryAreas({ floodAdvisories, showFlood, showStormSurge, stormSurgeAdvisories }: Props) {
  const floodAreas = showFlood ? floodAdvisories.filter(item => validOfficialGeometry(item.geometry)) : []
  const stormSurgeAreas = showStormSurge ? stormSurgeAdvisories.filter(item => validOfficialGeometry(item.geometry)) : []

  return (
    <>
      {floodAreas.length > 0 && (
        <Pane name="official-flood-advisories" style={{ zIndex: 410 }}>
          {floodAreas.map(item => (
            <GeoJSON
              key={item.id}
              data={geoJsonFeature(item.id, item.geometry!)}
              pane="official-flood-advisories"
              style={{ color: '#2563eb', fillColor: '#3b82f6', fillOpacity: 0.35, weight: 1.5 }}
            />
          ))}
        </Pane>
      )}
      {stormSurgeAreas.length > 0 && (
        <Pane name="official-storm-surge-advisories" style={{ zIndex: 420 }}>
          {stormSurgeAreas.map(item => (
            <GeoJSON
              key={item.id}
              data={geoJsonFeature(item.id, item.geometry!)}
              pane="official-storm-surge-advisories"
              style={{ color: '#e11d48', fillColor: '#fb7185', fillOpacity: 0.38, weight: 1.5 }}
            />
          ))}
        </Pane>
      )}
    </>
  )
}
