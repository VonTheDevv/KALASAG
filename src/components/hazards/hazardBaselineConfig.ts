export type BaselineConfiguration = {
  configured: boolean
  mode: 'xyz' | 'arcgis-dynamic'
  url: string
  attribution: string
  layers?: string
  minNativeZoom?: number
  maxNativeZoom?: number
}

function configuredTileLayer(urlValue: unknown, attributionValue: unknown): BaselineConfiguration {
  const url = String(urlValue ?? '').trim()
  const attribution = String(attributionValue ?? '').trim() || 'Authorized official hazard baseline'
  if (!url || !url.includes('{z}') || !url.includes('{x}') || !url.includes('{y}')) {
    return { configured: false, mode: 'xyz', url: '', attribution }
  }

  try {
    const probe = new URL(url.replace('{s}', 'a').replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'), window.location.origin)
    if (probe.protocol !== 'https:' && !(import.meta.env.DEV && probe.origin === window.location.origin)) {
      return { configured: false, mode: 'xyz', url: '', attribution }
    }
  } catch {
    return { configured: false, mode: 'xyz', url: '', attribution }
  }

  const isOfficialMgbFloodCache = url.includes('/GDI_Detailed_Flood_Susceptibility_Public/MapServer/tile/')
  return {
    configured: true,
    mode: 'xyz',
    url,
    attribution,
    minNativeZoom: isOfficialMgbFloodCache ? 6 : undefined,
    maxNativeZoom: isOfficialMgbFloodCache ? 14 : 18,
  }
}

function configuredArcGisLayer(
  urlValue: unknown,
  attributionValue: unknown,
  layers = 'show:0',
): BaselineConfiguration {
  const url = String(urlValue ?? '').trim().replace(/\/$/, '')
  const attribution = String(attributionValue ?? '').trim() || 'Authorized official hazard baseline'
  try {
    const probe = new URL(url, window.location.origin)
    if (!url || !probe.pathname.endsWith('/MapServer') || probe.protocol !== 'https:') {
      return { configured: false, mode: 'arcgis-dynamic', url: '', attribution }
    }
  } catch {
    return { configured: false, mode: 'arcgis-dynamic', url: '', attribution }
  }
  return { configured: true, mode: 'arcgis-dynamic', url, attribution, layers }
}

const OFFICIAL_MGB_FLOOD_TILES = 'https://controlmap.mgb.gov.ph/arcgis/rest/services/GeospatialDataInventory_Public/GDI_Detailed_Flood_Susceptibility_Public/MapServer/tile/{z}/{y}/{x}'
const OFFICIAL_STORM_SURGE_SERVICE = 'https://ulap-hazards.georisk.gov.ph/arcgis/rest/services/PAGASAPublic/StormSurge/MapServer'

export const hazardBaselineConfiguration = {
  // These are public, credential-free government map services. Deployments
  // may replace the cached XYZ layer through environment configuration, but
  // provider secrets must never be embedded in a browser-visible URL.
  flood: configuredTileLayer(
    import.meta.env.VITE_FLOOD_HAZARD_TILE_URL || OFFICIAL_MGB_FLOOD_TILES,
    import.meta.env.VITE_FLOOD_HAZARD_ATTRIBUTION || 'DENR-MGB detailed flood susceptibility',
  ),
  stormSurge: import.meta.env.VITE_STORM_SURGE_TILE_URL
    ? configuredTileLayer(
        import.meta.env.VITE_STORM_SURGE_TILE_URL,
        import.meta.env.VITE_STORM_SURGE_ATTRIBUTION,
      )
    : configuredArcGisLayer(
        OFFICIAL_STORM_SURGE_SERVICE,
        import.meta.env.VITE_STORM_SURGE_ATTRIBUTION || 'DOST-PAGASA 3-meter storm-surge scenario via GeoRiskPH',
      ),
}
