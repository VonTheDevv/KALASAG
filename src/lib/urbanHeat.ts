import { distanceKm } from './safeGrounds'

const MASK_URL = '/data/ph-urban-settlements-2025.bin'
const MASK_MAGIC = 'KUS1'
const MASK_VERSION = 1
const MASK_EPOCH = 2025
const MASK_HEADER_BYTES = 12
const GRID_MIN_LAT = 4
const GRID_MAX_LAT = 22
const GRID_MIN_LNG = 116
const GRID_MAX_LNG = 128
const GRID_RESOLUTION = 1 / 120
const GRID_ROWS = 2160
const GRID_COLUMNS = 1440
const URBAN_PROXIMITY_LIMIT_KM = 1
const URBAN_SEARCH_CELL_RADIUS = 2

export type HeatConfidence = 'low' | 'nominal' | 'high' | 'unknown'

export type HeatClassification =
  | { kind: 'heat-indication'; confidence: HeatConfidence }
  | { kind: 'potential-residential-fire'; confidence: 'nominal' | 'high'; urbanProximityKm: number }

type HeatDetection = {
  lat: number
  lng: number
  confidence: string
}

type UrbanSettlementMask = {
  bits: Uint8Array
}

let maskRequest: Promise<UrbanSettlementMask | null> | undefined

export function normalizeHeatConfidence(value: unknown): HeatConfidence {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'h' || normalized === 'high') return 'high'
  if (normalized === 'n' || normalized === 'nominal') return 'nominal'
  if (normalized === 'l' || normalized === 'low') return 'low'
  return 'unknown'
}

export function parseUrbanSettlementMask(buffer: ArrayBuffer): UrbanSettlementMask {
  const expectedBytes = MASK_HEADER_BYTES + Math.ceil((GRID_ROWS * GRID_COLUMNS) / 8)
  if (buffer.byteLength !== expectedBytes) throw new Error('Urban settlement mask has an invalid size')

  const bytes = new Uint8Array(buffer)
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  const header = new DataView(buffer, 0, MASK_HEADER_BYTES)
  if (
    magic !== MASK_MAGIC
    || header.getUint8(4) !== MASK_VERSION
    || header.getUint8(5) !== 120
    || header.getUint16(6, true) !== GRID_ROWS
    || header.getUint16(8, true) !== GRID_COLUMNS
    || header.getUint16(10, true) !== MASK_EPOCH
  ) {
    throw new Error('Urban settlement mask has an unsupported header')
  }

  return { bits: bytes.subarray(MASK_HEADER_BYTES) }
}

async function fetchUrbanSettlementMask() {
  try {
    const response = await fetch(MASK_URL, {
      cache: 'force-cache',
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return null
    return parseUrbanSettlementMask(await response.arrayBuffer())
  } catch {
    return null
  }
}

async function loadUrbanSettlementMask() {
  const request = maskRequest ??= fetchUrbanSettlementMask()
  const mask = await request
  if (!mask && maskRequest === request) maskRequest = undefined
  return mask
}

function isUrbanCell(mask: UrbanSettlementMask, row: number, column: number) {
  if (row < 0 || row >= GRID_ROWS || column < 0 || column >= GRID_COLUMNS) return false
  const index = row * GRID_COLUMNS + column
  return (mask.bits[index >> 3] & (1 << (index & 7))) !== 0
}

function urbanProximityKm(mask: UrbanSettlementMask, lat: number, lng: number) {
  if (
    !Number.isFinite(lat)
    || !Number.isFinite(lng)
    || lat < GRID_MIN_LAT
    || lat >= GRID_MAX_LAT
    || lng < GRID_MIN_LNG
    || lng >= GRID_MAX_LNG
  ) return null

  const sourceRow = Math.floor((GRID_MAX_LAT - lat) / GRID_RESOLUTION)
  const sourceColumn = Math.floor((lng - GRID_MIN_LNG) / GRID_RESOLUTION)
  let nearestDistance = Number.POSITIVE_INFINITY

  for (let row = sourceRow - URBAN_SEARCH_CELL_RADIUS; row <= sourceRow + URBAN_SEARCH_CELL_RADIUS; row += 1) {
    for (let column = sourceColumn - URBAN_SEARCH_CELL_RADIUS; column <= sourceColumn + URBAN_SEARCH_CELL_RADIUS; column += 1) {
      if (!isUrbanCell(mask, row, column)) continue
      const north = GRID_MAX_LAT - row * GRID_RESOLUTION
      const south = north - GRID_RESOLUTION
      const west = GRID_MIN_LNG + column * GRID_RESOLUTION
      const east = west + GRID_RESOLUTION
      const nearestLat = Math.max(south, Math.min(north, lat))
      const nearestLng = Math.max(west, Math.min(east, lng))
      const candidateDistance = distanceKm([lat, lng], [nearestLat, nearestLng])
      if (candidateDistance < nearestDistance) nearestDistance = candidateDistance
      if (nearestDistance === 0) return 0
    }
  }

  return Number.isFinite(nearestDistance) ? nearestDistance : null
}

export function classifyHeatDetection(
  detection: HeatDetection,
  mask: UrbanSettlementMask | null,
): HeatClassification {
  const confidence = normalizeHeatConfidence(detection.confidence)
  if (!mask || (confidence !== 'nominal' && confidence !== 'high')) {
    return { kind: 'heat-indication', confidence }
  }

  const proximityKm = urbanProximityKm(mask, detection.lat, detection.lng)
  if (proximityKm === null || proximityKm > URBAN_PROXIMITY_LIMIT_KM) {
    return { kind: 'heat-indication', confidence }
  }

  return {
    kind: 'potential-residential-fire',
    confidence,
    urbanProximityKm: proximityKm,
  }
}

export async function classifyHeatDetections<T extends HeatDetection>(
  detections: readonly T[],
): Promise<Array<T & { classification: HeatClassification }>> {
  const mask = await loadUrbanSettlementMask()
  return detections.map(detection => ({
    ...detection,
    classification: classifyHeatDetection(detection, mask),
  }))
}
