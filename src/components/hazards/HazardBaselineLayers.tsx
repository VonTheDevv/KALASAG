import { useEffect } from 'react'
import L from 'leaflet'
import { Pane, TileLayer, useMap } from 'react-leaflet'
import { hazardBaselineConfiguration } from './hazardBaselineConfig'

type BaselineLayerProps = {
  enabled: boolean
  kind: 'flood' | 'storm-surge'
}

function ArcGisDynamicTileLayer({
  serviceUrl,
  layers,
  attribution,
  opacity,
  pane,
}: {
  serviceUrl: string
  layers: string
  attribution: string
  opacity: number
  pane: string
}) {
  const map = useMap()

  useEffect(() => {
    const layer = L.tileLayer('', {
      attribution,
      opacity,
      pane,
      maxZoom: 20,
      tileSize: 256,
    })

    layer.getTileUrl = coordinates => {
      const tileSize = layer.getTileSize()
      const northWestPixel = coordinates.scaleBy(tileSize)
      const southEastPixel = northWestPixel.add(tileSize)
      const northWest = map.unproject(northWestPixel, coordinates.z)
      const southEast = map.unproject(southEastPixel, coordinates.z)
      const projectedNorthWest = L.CRS.EPSG3857.project(northWest)
      const projectedSouthEast = L.CRS.EPSG3857.project(southEast)
      const parameters = new URLSearchParams({
        bbox: [
          projectedNorthWest.x,
          projectedSouthEast.y,
          projectedSouthEast.x,
          projectedNorthWest.y,
        ].join(','),
        bboxSR: '3857',
        imageSR: '3857',
        size: `${tileSize.x},${tileSize.y}`,
        dpi: '96',
        format: 'png32',
        transparent: 'true',
        layers,
        f: 'image',
      })
      return `${serviceUrl}/export?${parameters.toString()}`
    }

    layer.addTo(map)
    return () => { layer.removeFrom(map) }
  }, [attribution, layers, map, opacity, pane, serviceUrl])

  return null
}

export default function HazardBaselineLayer({ enabled, kind }: BaselineLayerProps) {
  if (!enabled) return null
  const configuration = kind === 'flood'
    ? hazardBaselineConfiguration.flood
    : hazardBaselineConfiguration.stormSurge
  if (!configuration.configured) return null

  const paneName = kind === 'flood' ? 'flood-susceptibility' : 'storm-surge-scenarios'
  return (
    <Pane name={paneName} style={{ zIndex: kind === 'flood' ? 310 : 320, pointerEvents: 'none' }}>
      {configuration.mode === 'arcgis-dynamic' ? (
        <ArcGisDynamicTileLayer
          serviceUrl={configuration.url}
          layers={configuration.layers ?? 'show:0'}
          attribution={configuration.attribution}
          opacity={kind === 'flood' ? 0.62 : 0.58}
          pane={paneName}
        />
      ) : (
        <TileLayer
          url={configuration.url}
          attribution={configuration.attribution}
          opacity={kind === 'flood' ? 0.62 : 0.58}
          pane={paneName}
          maxZoom={20}
          minNativeZoom={configuration.minNativeZoom}
          maxNativeZoom={configuration.maxNativeZoom ?? 18}
        />
      )}
    </Pane>
  )
}
