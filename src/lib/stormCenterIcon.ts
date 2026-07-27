import L from 'leaflet'

// A compact, tapered cyclone lobe. Mirroring it around the eye produces the
// familiar two-arm tropical-cyclone symbol without the long propeller look.
export const STORM_CENTER_ARM_PATH =
  'M31 32C33 24 39 18 50 18C43 13 33 15 27 22C23 27 24 33 29 37C28 34 29 32 31 32Z'

function stormMarkerSize(zoom: number) {
  const scaled = 66 * Math.pow(0.98, zoom - 6)
  return Math.round(Math.max(58, Math.min(82, scaled)))
}

export function createStormCenterIcon(zoom = 6) {
  const size = stormMarkerSize(zoom)
  return L.divIcon({
    className: 'kalasag-storm-center-icon',
    html: `<div class="kalasag-storm-marker" role="img" aria-label="Tropical cyclone center">
      <svg class="kalasag-storm-marker__ring" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,23,68,.22)" stroke-width="2.5"
          vector-effect="non-scaling-stroke" />
        <circle cx="32" cy="32" r="26" fill="none" stroke="#ff1744" stroke-width="3.8"
          stroke-linecap="round" stroke-dasharray="59 18 17 69" transform="rotate(-90 32 32)"
          vector-effect="non-scaling-stroke" />
      </svg>
      <svg class="kalasag-storm-marker__glyph" viewBox="0 0 64 64" aria-hidden="true">
        <path d="${STORM_CENTER_ARM_PATH}" fill="#ff1744" />
        <path d="${STORM_CENTER_ARM_PATH}" fill="#ff1744" transform="rotate(180 32 32)" />
        <circle cx="32" cy="32" r="8" fill="#ffffff" stroke="#ff1744" stroke-width="2.5" />
      </svg>
    </div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  })
}
