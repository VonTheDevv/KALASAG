import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const filename = path.resolve('public/data/ph-urban-settlements-2025.bin')
const bytes = fs.readFileSync(filename)
const HEADER_BYTES = 12
const ROWS = 2160
const COLUMNS = 1440
const MIN_LAT = 4
const MAX_LAT = 22
const MIN_LNG = 116
const RESOLUTION = 1 / 120
const EXPECTED_SHA256 = '10fc922960876b8210388f16ec112246973c29f6302f77f6761082ceb54d3527'
const EXPECTED_URBAN_CELLS = 72_204
const expectedBytes = HEADER_BYTES + Math.ceil((ROWS * COLUMNS) / 8)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(bytes.length === expectedBytes, `Unexpected mask size: ${bytes.length}`)
assert(bytes.subarray(0, 4).toString('ascii') === 'KUS1', 'Invalid mask magic')
assert(bytes.readUInt8(4) === 1, 'Unsupported mask version')
assert(bytes.readUInt8(5) === 120, 'Unexpected mask resolution')
assert(bytes.readUInt16LE(6) === ROWS, 'Unexpected mask row count')
assert(bytes.readUInt16LE(8) === COLUMNS, 'Unexpected mask column count')
assert(bytes.readUInt16LE(10) === 2025, 'Unexpected mask epoch')

let urbanCells = 0
for (let index = 0; index < ROWS * COLUMNS; index += 1) {
  if ((bytes[HEADER_BYTES + (index >> 3)] & (1 << (index & 7))) !== 0) urbanCells += 1
}
assert(urbanCells === EXPECTED_URBAN_CELLS, `Unexpected urban cell count: ${urbanCells}`)

function isUrban(lat, lng) {
  if (lat < MIN_LAT || lat >= MAX_LAT || lng < MIN_LNG) return false
  const row = Math.floor((MAX_LAT - lat) / RESOLUTION)
  const column = Math.floor((lng - MIN_LNG) / RESOLUTION)
  if (row < 0 || row >= ROWS || column < 0 || column >= COLUMNS) return false
  const index = row * COLUMNS + column
  return (bytes[HEADER_BYTES + (index >> 3)] & (1 << (index & 7))) !== 0
}

assert(isUrban(14.5995, 120.9842), 'Manila control point should be urban')
assert(isUrban(10.3157, 123.8854), 'Cebu City control point should be urban')
assert(isUrban(7.1907, 125.4553), 'Davao City control point should be urban')
assert(!isUrban(8.9537, 119.9066), 'Tubbataha Reef control point should not be urban')

const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
assert(sha256 === EXPECTED_SHA256, `Unexpected mask checksum: ${sha256}`)
console.log(`Urban settlement mask passed (${urbanCells} cells, sha256 ${sha256}).`)
