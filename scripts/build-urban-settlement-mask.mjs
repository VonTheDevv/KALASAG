import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fromFile } from 'geotiff'

const input = process.argv[2]
const output = path.resolve(process.argv[3] || 'public/data/ph-urban-settlements-2025.bin')
if (!input) {
  throw new Error('Usage: npm run urban-mask:build -- /path/to/GHS_SMOD_E2025_GLOBE_R2023A_4326_30ss_V2_0.tif [output]')
}

const MIN_LAT = 4
const MAX_LAT = 22
const MIN_LNG = 116
const MAX_LNG = 128
const RESOLUTION = 1 / 120
const ROWS = Math.round((MAX_LAT - MIN_LAT) / RESOLUTION)
const COLUMNS = Math.round((MAX_LNG - MIN_LNG) / RESOLUTION)
const HEADER_BYTES = 12
const URBAN_CLASSES = new Set([21, 22, 23, 30])

const file = await fromFile(path.resolve(input))
const image = await file.getImage()
const [originLng, originLat] = image.getOrigin()
const [sourceLngResolution, sourceLatResolution] = image.getResolution()
const sourceLatStep = Math.abs(sourceLatResolution)
const firstCenterLng = MIN_LNG + RESOLUTION / 2
const firstCenterLat = MAX_LAT - RESOLUTION / 2
const lastCenterLng = MAX_LNG - RESOLUTION / 2
const lastCenterLat = MIN_LAT + RESOLUTION / 2
const sourceLeft = Math.floor((firstCenterLng - originLng) / sourceLngResolution)
const sourceTop = Math.floor((originLat - firstCenterLat) / sourceLatStep)
const sourceRight = Math.floor((lastCenterLng - originLng) / sourceLngResolution)
const sourceBottom = Math.floor((originLat - lastCenterLat) / sourceLatStep)

if (sourceRight - sourceLeft + 1 !== COLUMNS || sourceBottom - sourceTop + 1 !== ROWS) {
  throw new Error('The GHSL source grid does not align with the expected Philippines output grid')
}

const raster = await image.readRasters({
  window: [sourceLeft, sourceTop, sourceLeft + COLUMNS, sourceTop + ROWS],
  interleave: true,
})
if (raster.length !== ROWS * COLUMNS) throw new Error('The GHSL crop has unexpected dimensions')

const bytes = Buffer.alloc(HEADER_BYTES + Math.ceil((ROWS * COLUMNS) / 8))
bytes.write('KUS1', 0, 'ascii')
bytes.writeUInt8(1, 4)
bytes.writeUInt8(120, 5)
bytes.writeUInt16LE(ROWS, 6)
bytes.writeUInt16LE(COLUMNS, 8)
bytes.writeUInt16LE(2025, 10)

let urbanCells = 0
for (let index = 0; index < raster.length; index += 1) {
  if (!URBAN_CLASSES.has(Number(raster[index]))) continue
  bytes[HEADER_BYTES + (index >> 3)] |= 1 << (index & 7)
  urbanCells += 1
}

await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, bytes)
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
console.log(`Wrote ${output} (${bytes.length} bytes, ${urbanCells} urban cells, sha256 ${sha256})`)
