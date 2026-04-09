// ─── PNG encoder ─────────────────────────────────────────────────────────────
// Matches visionote's approach: full 8-bit greyscale PNG passed to
// updateImageRawData, not raw pixel values.

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeU32BE(arr: Uint8Array, offset: number, value: number): void {
  arr[offset]     = (value >>> 24) & 0xff
  arr[offset + 1] = (value >>> 16) & 0xff
  arr[offset + 2] = (value >>> 8)  & 0xff
  arr[offset + 3] = value & 0xff
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + data.length + 4)
  writeU32BE(chunk, 0, data.length)
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(data, 8)
  const crcData = new Uint8Array(4 + data.length)
  for (let i = 0; i < 4; i++) crcData[i] = type.charCodeAt(i)
  crcData.set(data, 4)
  writeU32BE(chunk, 8 + data.length, crc32(crcData))
  return chunk
}

async function zlibCompress(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  writer.write(data as unknown as BufferSource)
  writer.close()
  const reader = cs.readable.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let total = 0
  for (const c of chunks) total += c.length
  const result = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { result.set(c, off); off += c.length }
  return result
}

async function encodeGreyscalePng(width: number, height: number, pixels: Uint8Array): Promise<Uint8Array> {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = new Uint8Array(13)
  writeU32BE(ihdrData, 0, width)
  writeU32BE(ihdrData, 4, height)
  ihdrData[8]  = 8  // bit depth
  ihdrData[9]  = 0  // color type: greyscale
  ihdrData[10] = 0  // compression
  ihdrData[11] = 0  // filter
  ihdrData[12] = 0  // interlace
  const ihdr = makePngChunk('IHDR', ihdrData)

  // Each row: filter byte 0x00 (None) + pixel data
  const rawData = new Uint8Array(height * (1 + width))
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width)] = 0
    rawData.set(pixels.subarray(y * width, (y + 1) * width), y * (1 + width) + 1)
  }
  const compressed = await zlibCompress(rawData)
  const idat = makePngChunk('IDAT', compressed)
  const iend = makePngChunk('IEND', new Uint8Array(0))

  const png = new Uint8Array(signature.length + ihdr.length + idat.length + iend.length)
  let off = 0
  png.set(signature, off); off += signature.length
  png.set(ihdr,      off); off += ihdr.length
  png.set(idat,      off); off += idat.length
  png.set(iend,      off)
  return png
}

// ─── Vector minimap renderer ──────────────────────────────────────────────────
//
// Pure pixel-math renderer — no canvas, no API calls.
// Draws the route as bright lines on a dark background.
//
// Brightness levels:
//   20  — background
//   50  — past steps (already driven)
//   130 — upcoming steps
//   240 — current step (thick)
//   255 — position marker / turn point

interface StepCoords {
  polylinePoints: Array<[number, number]>
  startLat: number
  startLng: number
  endLat: number
  endLng: number
}

export async function renderMinimapPng(
  lat: number,
  lng: number,
  steps: StepCoords[],
  stepIdx: number,
  w: number,
  h: number,
  zoom: number,
): Promise<number[]> {
  const METERS_PER_DEG = 111_320
  const cosLat = Math.cos(lat * Math.PI / 180)
  // metres per pixel at this zoom level and latitude
  const mpp = 2 * Math.PI * 6_378_137 * cosLat / (256 * Math.pow(2, zoom))
  const cx = w / 2
  const cy = h / 2

  const pixels = new Uint8Array(w * h).fill(20)

  function toPixel(plat: number, plng: number): [number, number] {
    const px = cx + (plng - lng) * cosLat * METERS_PER_DEG / mpp
    const py = cy - (plat - lat) * METERS_PER_DEG / mpp
    return [Math.round(px), Math.round(py)]
  }

  function setPixel(x: number, y: number, v: number) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      if (v > pixels[y * w + x]) pixels[y * w + x] = v
    }
  }

  // Bresenham line — draws extra pixel for thick lines (current step)
  function drawLine(x0: number, y0: number, x1: number, y1: number, v: number, thick: boolean) {
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    for (;;) {
      setPixel(x0, y0, v)
      if (thick) {
        // Thicken perpendicular to dominant direction
        if (dx >= dy) { setPixel(x0, y0 + 1, v); setPixel(x0, y0 - 1, v) }
        else          { setPixel(x0 + 1, y0, v); setPixel(x0 - 1, y0, v) }
      }
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; x0 += sx }
      if (e2 <  dx) { err += dx; y0 += sy }
    }
  }

  // Draw route segments
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const past    = i < stepIdx
    const current = i === stepIdx
    const v       = past ? 50 : current ? 240 : 130
    const thick   = current

    // Use decoded polyline if available, else fall back to start→end straight line
    const pts: Array<[number, number]> = s.polylinePoints.length >= 2
      ? s.polylinePoints
      : (s.startLat || s.startLng) && (s.endLat || s.endLng)
        ? [[s.startLat, s.startLng], [s.endLat, s.endLng]]
        : []

    for (let j = 0; j < pts.length - 1; j++) {
      const [px0, py0] = toPixel(pts[j][0],     pts[j][1])
      const [px1, py1] = toPixel(pts[j + 1][0], pts[j + 1][1])
      drawLine(px0, py0, px1, py1, v, thick)
    }
  }

  // Next turn marker — small cross at end of current step
  if (stepIdx < steps.length) {
    const s = steps[stepIdx]
    if (s.endLat || s.endLng) {
      const [tx, ty] = toPixel(s.endLat, s.endLng)
      setPixel(tx,     ty,     255)
      setPixel(tx + 1, ty,     200); setPixel(tx - 1, ty,     200)
      setPixel(tx,     ty + 1, 200); setPixel(tx,     ty - 1, 200)
    }
  }

  // Position marker — filled diamond at current position
  const [posX, posY] = toPixel(lat, lng)
  setPixel(posX,     posY,     255)
  setPixel(posX + 1, posY,     255); setPixel(posX - 1, posY,     255)
  setPixel(posX,     posY + 1, 255); setPixel(posX,     posY - 1, 255)
  setPixel(posX + 1, posY + 1, 200); setPixel(posX - 1, posY + 1, 200)
  setPixel(posX + 1, posY - 1, 200); setPixel(posX - 1, posY - 1, 200)

  const pngBytes = await encodeGreyscalePng(w, h, pixels)
  return Array.from(pngBytes)
}
