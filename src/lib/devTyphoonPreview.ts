/**
 * Temporary local-only visual preview for the tropical-cyclone UI.
 *
 * Vite replaces `import.meta.env.DEV` with `false` for production builds, so
 * this sample never becomes an APK, deployed web build, live-data response,
 * or background safety alert.
 */
export type DevelopmentTyphoonPreview = {
  id: string
  name: string
  localName: string
  lat: number
  lng: number
  alertlevel: string
  alertscore: number
  description: string
  windKph: number
  source: string
  countries: string
  updated: string
  distanceToParKm: number
  observedTrack: [number, number][]
  forecastTrack: [number, number][]
  observedPoints: Array<{ lat: number; lng: number; intensity: string }>
  forecastPoints: Array<{ lat: number; lng: number; intensity: string }>
  isDevelopmentPreview: true
}

export const DEVELOPMENT_TYPHOON_PREVIEW: DevelopmentTyphoonPreview | null = import.meta.env.DEV
  ? {
      id: 'development-typhoon-preview',
      name: 'SIMULATED TYPHOON',
      localName: 'Development Preview',
      lat: 14.6,
      lng: 125.4,
      alertlevel: 'Red',
      alertscore: 3,
      description: 'Temporary local development preview. This is simulated data for checking the marker, observed trail, forecast path, popup, and tracker charts. It is not a live weather warning and cannot trigger alerts.',
      windKph: 155,
      source: 'KALASAG local development preview — not a live source',
      countries: 'Preview path: Philippine Sea to eastern Luzon',
      updated: 'Development preview only',
      distanceToParKm: 0,
      observedTrack: [
        [13.4, 130.8],
        [13.7, 129.6],
        [14.1, 128.4],
        [14.4, 127.1],
        [14.6, 125.4],
      ],
      forecastTrack: [
        [14.6, 125.4],
        [14.9, 124.2],
        [15.2, 123.1],
        [15.5, 122.1],
      ],
      observedPoints: [
        { lat: 13.4, lng: 130.8, intensity: 'TS' },
        { lat: 13.7, lng: 129.6, intensity: 'TS' },
        { lat: 14.1, lng: 128.4, intensity: 'TY' },
        { lat: 14.4, lng: 127.1, intensity: 'TY' },
        { lat: 14.6, lng: 125.4, intensity: 'TY' },
      ],
      forecastPoints: [
        { lat: 14.6, lng: 125.4, intensity: 'TY' },
        { lat: 14.9, lng: 124.2, intensity: 'TY' },
        { lat: 15.2, lng: 123.1, intensity: 'TS' },
        { lat: 15.5, lng: 122.1, intensity: 'TS' },
      ],
      isDevelopmentPreview: true,
    }
  : null
