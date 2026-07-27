/**
 * Last-known-good physical dam positions returned by GeoRiskPH's official
 * PAGASA MapServer. Dam positions are static reference data; live reservoir
 * observations continue to come from PAGASA's current dam table.
 *
 * Keep this catalog independent from observation caching so a temporary
 * GeoRisk outage cannot remove otherwise valid markers from the map.
 */
export const OFFICIAL_DAM_LOCATION_BASELINE_SOURCE =
  'https://portal.georisk.gov.ph/arcgis/rest/services/PAGASA/PAGASA/MapServer'

export const OFFICIAL_DAM_LOCATION_BASELINE_CAPTURED_AT = '2026-07-17T09:59:35.983Z'

export const OFFICIAL_DAM_LOCATION_BASELINE = Object.freeze([
  Object.freeze({ name: 'Angat', lat: 14.91139, lng: 121.165 }),
  Object.freeze({ name: 'Ipo', lat: 14.875, lng: 121.06222 }),
  Object.freeze({ name: 'Ambuklao', lat: 16.46111, lng: 120.74389 }),
  Object.freeze({ name: 'Binga', lat: 16.39611, lng: 120.72667 }),
  Object.freeze({ name: 'San Roque', lat: 16.146, lng: 120.684 }),
  Object.freeze({ name: 'Pantabangan', lat: 15.81833, lng: 121.10944 }),
  Object.freeze({ name: 'Magat', lat: 16.83333, lng: 121.45056 }),
])
