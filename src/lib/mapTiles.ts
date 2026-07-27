// CARTO's public raster basemaps provide tiles through zoom level 20. Keeping
// Leaflet at that native ceiling prevents missing raster tiles from leaving
// hazard overlays on a blank map at excessive zoom levels.
export const CARTO_RASTER_MAX_ZOOM = 20
