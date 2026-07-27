import { useCallback, useEffect, useState, useRef } from 'react'
import { AlertTriangle, MapPin, X } from 'lucide-react'
import { getLiveData } from '../lib/liveData'
import {
  clearDevicePositionWatch,
  getDevicePosition,
  watchDevicePosition,
  type DeviceLocationWatchId,
} from '../lib/deviceGeolocation'
import {
  HEAT_NEARBY_ALERT_MAX_AGE_MS,
  heatObservationAgeLabel,
  isHeatObservationWithinAge,
  normalizeCurrentHeatObservations,
  type HeatObservation,
} from '../lib/heatObservations'

// Distance function in km
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

interface HazardAlert {
  id: string
  type: 'TYPHOON' | 'EARTHQUAKE' | 'FIRE'
  title: string
  distance: number
  threshold: number
  guidance?: string
}

export default function BackgroundSafetyCheck() {
  const [activeAlerts, setActiveAlerts] = useState<HazardAlert[]>([])
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set())
  const lastFetchRef = useRef<number>(0)
  
  const [hazards, setHazards] = useState<{
    earthquakes: any[]
    storms: any[]
    fires: HeatObservation[]
  }>({ earthquakes: [], storms: [], fires: [] })
  const hazardsRef = useRef(hazards)

  const fetchHazards = useCallback(async () => {
    const now = Date.now()
    if (now - lastFetchRef.current < 5 * 60 * 1000) return hazardsRef.current // Throttle 5 mins

    try {
      const [earthquakes, storms, fires] = await Promise.allSettled([
        getLiveData<any[]>('earthquakes'),
        getLiveData<any[]>('storms'),
        getLiveData<unknown[]>('heat'),
      ])

      if ([earthquakes, storms, fires].every(result => result.status === 'rejected')) return null

      const nextHazards = {
        earthquakes: earthquakes.status === 'fulfilled' ? earthquakes.value.data : hazardsRef.current.earthquakes,
        storms: storms.status === 'fulfilled' ? storms.value.data : hazardsRef.current.storms,
        fires: fires.status === 'fulfilled' ? normalizeCurrentHeatObservations(fires.value.data) : hazardsRef.current.fires,
      }
      lastFetchRef.current = now
      hazardsRef.current = nextHazards
      setHazards(nextHazards)
      return nextHazards
    } catch (err) {
      console.warn("Safety Check Fetch Error:", err)
      return null
    }
  }, [])

  const checkDistances = useCallback((currentHazards: typeof hazards, userLat: number, userLng: number) => {
    const newAlerts: HazardAlert[] = []

    currentHazards.earthquakes.forEach(eq => {
      const [lng, lat] = eq.geometry.coordinates
      const dist = haversineKm(userLat, userLng, lat, lng)
      if (dist <= 20) {
        newAlerts.push({
          id: `EQ-${eq.id}`,
          type: 'EARTHQUAKE',
          title: `Earthquake Magnitude ${eq.properties.mag}`,
          distance: dist,
          threshold: 20
        })
      }
    })

    currentHazards.storms.forEach(storm => {
      let lat = Number(storm.lat) || 0, lng = Number(storm.lng) || 0
      if (!lat && !lng && storm.geometry?.coordinates) {
        lng = storm.geometry.coordinates[0]
        lat = storm.geometry.coordinates[1]
      } else if (!lat && !lng && storm.geometry && Array.isArray(storm.geometry) && storm.geometry.length > 0) {
        lng = storm.geometry[0].coordinates[0]
        lat = storm.geometry[0].coordinates[1]
      }
      if (lat !== 0 && lng !== 0) {
        const dist = haversineKm(userLat, userLng, lat, lng)
        if (dist <= 100) {
          newAlerts.push({
            id: `STORM-${storm.id || storm.properties?.eventid}`,
            type: 'TYPHOON',
            title: storm.title || storm.name || storm.properties?.name || 'Severe Storm',
            distance: dist,
            threshold: 100
          })
        }
      }
    })

    const nearbyHeat = currentHazards.fires.flatMap(fire => {
      if (!isHeatObservationWithinAge(fire, HEAT_NEARBY_ALERT_MAX_AGE_MS)) return []
      const distance = haversineKm(userLat, userLng, fire.lat, fire.lng)
      return distance <= 5 ? [{ fire, distance }] : []
    }).sort((left, right) => Date.parse(right.fire.observedAt) - Date.parse(left.fire.observedAt) || left.distance - right.distance)

    const nearestRecentHeat = nearbyHeat[0]
    if (nearestRecentHeat) {
      const count = nearbyHeat.length
      const confidencePrefix = nearestRecentHeat.fire.normalizedConfidence === 'low' || nearestRecentHeat.fire.normalizedConfidence === 'unknown'
        ? 'low-confidence '
        : ''
      newAlerts.push({
        id: `HEAT-${nearestRecentHeat.fire.id}`,
        type: 'FIRE',
        title: count === 1
          ? `Nearby ${confidencePrefix}satellite thermal observation`
          : `${count} nearby satellite thermal observations`,
        distance: nearestRecentHeat.distance,
        threshold: 5,
        guidance: `Newest observation was recorded ${heatObservationAgeLabel(nearestRecentHeat.fire)}. Satellite heat is not confirmation of a structure fire. Check verified local-authority alerts and avoid the area if you can see smoke or flames.`,
      })
    }

    setActiveAlerts(newAlerts.filter(alert => !dismissedAlerts.has(alert.id)))
  }, [dismissedAlerts])

  useEffect(() => {
    let active = true
    let watchId: DeviceLocationWatchId | null = null
    let pollInFlight = false
    const refreshForLocation = (latitude: number, longitude: number) => {
      void fetchHazards().then(nextHazards => {
        if (active && nextHazards) checkDistances(nextHazards, latitude, longitude)
      })
    }

    const startTracking = async () => {
      try {
        const id = await watchDevicePosition(
          position => {
            if (!active) return
            const { latitude, longitude } = position.coords
            refreshForLocation(latitude, longitude)
          },
          error => {
            if (active) console.warn('Safety Check GPS Error:', error)
          },
          {
            enableHighAccuracy: false,
            maximumAge: 60_000,
            timeout: 20_000,
            minimumUpdateInterval: 30_000,
            interval: 60_000,
            enableLocationFallback: true,
          },
        )
        if (!active) {
          void clearDevicePositionWatch(id)
          return
        }
        watchId = id
      } catch (error) {
        if (active) console.warn('Safety Check GPS could not start:', error)
      }
    }
    void startTracking()

    const refreshCurrentPosition = () => {
      if (pollInFlight) return
      pollInFlight = true
      void getDevicePosition({ enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 })
        .then(position => {
          if (active) refreshForLocation(position.coords.latitude, position.coords.longitude)
        })
        .catch(() => {})
        .finally(() => { pollInFlight = false })
    }

    // Re-check on the server-cache cadence and immediately when a suspended
    // WebView becomes usable again. Android may pause timers while backgrounded.
    const interval = window.setInterval(refreshCurrentPosition, 5 * 60 * 1000)
    const refreshWhenActive = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) refreshCurrentPosition()
    }
    document.addEventListener('visibilitychange', refreshWhenActive)
    window.addEventListener('online', refreshWhenActive)

    return () => {
      active = false
      if (watchId !== null) void clearDevicePositionWatch(watchId)
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshWhenActive)
      window.removeEventListener('online', refreshWhenActive)
    }
  }, [checkDistances, fetchHazards])

  const dismissAlert = (id: string) => {
    setDismissedAlerts(prev => new Set(prev).add(id))
    setActiveAlerts(prev => prev.filter(a => a.id !== id))
  }

  if (activeAlerts.length === 0) return null

  return (
    <div className="fixed inset-0 z-[9999] pointer-events-none flex flex-col items-center justify-start p-4 pt-16 sm:pt-4 gap-2">
      {activeAlerts.map(alert => (
        <div key={alert.id} className="pointer-events-auto bg-[var(--color-red-alert)] text-white w-full max-w-sm rounded-xl shadow-2xl overflow-hidden animate-slide-in-right border border-white/20">
          <div className="px-4 py-3 bg-black/20 flex items-center justify-between">
            <h3 className="font-bold text-sm tracking-wider flex items-center gap-2">
              <AlertTriangle size={16} className="animate-pulse" />
              PROXIMITY WARNING
            </h3>
            <button onClick={() => dismissAlert(alert.id)} className="p-1 hover:bg-white/20 rounded-lg transition-colors">
              <X size={16} />
            </button>
          </div>
          <div className="p-4 bg-gradient-to-br from-[var(--color-red-alert)] to-red-900">
            <p className="text-lg font-black mb-1">{alert.title}</p>
            <div className="flex items-center gap-1.5 text-white/90 text-sm font-medium">
              <MapPin size={14} />
              Detected {alert.distance.toFixed(1)}km from your location
            </div>
            <p className="mt-3 text-xs text-white/70">
              {alert.guidance ?? `You are within the monitoring radius (${alert.threshold}km). Check the hazard map and official local advisories for current instructions.`}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}
