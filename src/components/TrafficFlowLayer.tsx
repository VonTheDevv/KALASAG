import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useMap } from 'react-leaflet'
import { haversineKm } from '../data/traffic'
import { getLiveDataAsset } from '../lib/liveData'

interface TrafficFlowLayerProps {
  center?: [number, number]
  radiusKm?: number
  minZoom?: number
  theme?: 'light' | 'dark'
  onError?: (message: string) => void
  onRecovery?: () => void
}

/** TomTom's live relative-speed tiles, fetched through the server gateway so
 * the provider key is never placed in browser URLs. Tiles outside the user's
 * monitoring circle are skipped. */
export default function TrafficFlowLayer({ center, radiusKm, minZoom = 5, theme = 'dark', onError, onRecovery }: TrafficFlowLayerProps) {
  const map = useMap()
  const errorReported = useRef(false)
  const failureCount = useRef(0)
  const retryTimer = useRef<number | null>(null)
  const onErrorRef = useRef(onError)
  const onRecoveryRef = useRef(onRecovery)

  useEffect(() => { onErrorRef.current = onError }, [onError])
  useEffect(() => { onRecoveryRef.current = onRecovery }, [onRecovery])

  useEffect(() => {
    const paneName = 'traffic-flow'
    const pane = map.getPane(paneName) ?? map.createPane(paneName)
    pane.style.zIndex = '430'
    pane.style.pointerEvents = 'none'

    const objectUrls = new Set<string>()
    const layer = L.gridLayer({
      pane: paneName,
      opacity: 0.9,
      minZoom,
      maxZoom: 20,
      updateWhenIdle: true,
      updateWhenZooming: false,
      updateInterval: 350,
      keepBuffer: 0,
    })

    const scheduleRecovery = (delayMs = 30_000) => {
      if (retryTimer.current !== null) return
      retryTimer.current = window.setTimeout(() => {
        retryTimer.current = null
        failureCount.current = 0
        layer.redraw()
      }, Math.min(60_000, Math.max(2_000, delayMs)) + Math.round(Math.random() * 1_500))
    }

    type MutableGridLayer = L.GridLayer & {
      createTile: (coords: L.Coords, done: L.DoneCallback) => HTMLElement
    }

    ;(layer as MutableGridLayer).createTile = (coords, done) => {
      const image = document.createElement('img')
      image.alt = ''
      image.setAttribute('role', 'presentation')
      image.width = 256
      image.height = 256

      const tileSize = 256
      const northWest = map.unproject([coords.x * tileSize, coords.y * tileSize], coords.z)
      const southEast = map.unproject([(coords.x + 1) * tileSize, (coords.y + 1) * tileSize], coords.z)
      const tileCenter: [number, number] = [(northWest.lat + southEast.lat) / 2, (northWest.lng + southEast.lng) / 2]
      const halfDiagonalKm = haversineKm([northWest.lat, northWest.lng], [southEast.lat, southEast.lng]) / 2

      if (center && radiusKm && haversineKm(center, tileCenter) > radiusKm + halfDiagonalKm) {
        queueMicrotask(() => done(undefined, image))
        return image
      }

      void getLiveDataAsset('traffic-tile', { z: coords.z, x: coords.x, y: coords.y, style: theme === 'dark' ? 'relative0-dark' : 'relative0' })
        .then(asset => {
          const objectUrl = URL.createObjectURL(asset.blob)
          objectUrls.add(objectUrl)
          image.onload = () => {
            objectUrls.delete(objectUrl)
            URL.revokeObjectURL(objectUrl)
            failureCount.current = 0
            if (asset.freshness === 'stale') {
              if (!errorReported.current) {
                errorReported.current = true
                onErrorRef.current?.('Provider road flow is delayed; showing recently received tiles while the live feed reconnects.')
              }
              scheduleRecovery()
            } else if (errorReported.current) {
              errorReported.current = false
              onRecoveryRef.current?.()
            }
            done(undefined, image)
          }
          image.onerror = () => {
            objectUrls.delete(objectUrl)
            URL.revokeObjectURL(objectUrl)
            done(new Error('Traffic flow tile could not be decoded'), image)
          }
          image.src = objectUrl
        })
        .catch(error => {
          failureCount.current += 1
          const retryAfterMs = error && typeof error === 'object' && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number'
            ? error.retryAfterMs
            : 30_000
          scheduleRecovery(retryAfterMs)
          if (!errorReported.current && failureCount.current >= 3) {
            errorReported.current = true
            onErrorRef.current?.('Some provider road-flow tiles are refreshing. Other hazard indicators remain active.')
          }
          done(error instanceof Error ? error : new Error('Live road flow tile is temporarily unavailable'), image)
        })

      return image
    }

    layer.addTo(map)
    return () => {
      layer.remove()
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current)
        retryTimer.current = null
      }
      objectUrls.forEach(objectUrl => URL.revokeObjectURL(objectUrl))
    }
  }, [map, center, radiusKm, minZoom, theme])

  return null
}
