// ─── 4-bit greyscale BMP encoder ─────────────────────────────────────────────
//
// The G2 firmware internally works in 4-bit greyscale and appears to validate
// image data against the expected BMP file size for the registered container
// dimensions.  A 4-bit BMP has a fixed, predictable size:
//   14 (file header) + 40 (DIB header) + 64 (16-entry colour table) + rowStride*H
// where rowStride = ceil(W/2) rounded up to a 4-byte boundary.

function encodeGreyscale4BitBmp(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const rowStride = Math.ceil(Math.ceil(width / 2) / 4) * 4  // padded to 4 bytes
  const pixelDataSize = rowStride * height
  const dataOffset    = 14 + 40 + 64   // 118
  const fileSize      = dataOffset + pixelDataSize

  const bmp = new Uint8Array(fileSize)
  let off = 0

  const u16 = (v: number) => { bmp[off++] = v & 0xff; bmp[off++] = (v >> 8) & 0xff }
  const u32 = (v: number) => { u16(v & 0xffff); u16((v >>> 16) & 0xffff) }
  const i32 = (v: number) => u32(v >>> 0)

  // ── File header ──────────────────────────────────────────────────────────────
  bmp[off++] = 0x42; bmp[off++] = 0x4d  // "BM"
  u32(fileSize)
  u16(0); u16(0)        // reserved
  u32(dataOffset)

  // ── BITMAPINFOHEADER ─────────────────────────────────────────────────────────
  u32(40)               // header size
  i32(width)
  i32(-height)          // negative → top-down row order
  u16(1)                // colour planes
  u16(4)                // bits per pixel
  u32(0)                // compression (BI_RGB)
  u32(pixelDataSize)
  i32(0); i32(0)        // pixels per metre (X, Y)
  u32(16)               // colours used
  u32(0)                // colours important

  // ── Colour table: 16 grey levels (index i → grey value i×17) ─────────────────
  for (let i = 0; i < 16; i++) {
    const v = i * 17    // 0, 17, 34, … 255
    bmp[off++] = v; bmp[off++] = v; bmp[off++] = v; bmp[off++] = 0  // BGRA
  }

  // ── Pixel data (top-down, 2 pixels per byte, high nibble = left) ─────────────
  for (let y = 0; y < height; y++) {
    let col = 0
    for (let x = 0; x < width; x += 2) {
      const hi = pixels[y * width + x]           >> 4   // 8-bit → 4-bit index
      const lo = (x + 1 < width ? pixels[y * width + x + 1] : 0) >> 4
      bmp[off++] = (hi << 4) | lo
      col++
    }
    // Row padding
    while (col < rowStride) { bmp[off++] = 0; col++ }
  }

  return bmp
}

// ─── 7×7 bitmap glyphs for compass labels ────────────────────────────────────
//
// Hand-drawn at 7×7 with single-pixel-wide strokes so they match the
// crispness of the Bresenham route lines. Each row is a 7-bit mask (MSB = left).

const COMPASS_GLYPHS: Record<string, number[]> = {
  N: [0b1000001, 0b1100001, 0b1010001, 0b1001001, 0b1000101, 0b1000011, 0b1000001],
  S: [0b0111110, 0b1000000, 0b1000000, 0b0111110, 0b0000001, 0b0000001, 0b0111110],
  E: [0b1111111, 0b1000000, 0b1000000, 0b1111100, 0b1000000, 0b1000000, 0b1111111],
  W: [0b1000001, 0b1000001, 0b1000001, 0b1010101, 0b1010101, 0b0100010, 0b0100010],
}
const GLYPH_W = 7
const GLYPH_H = 7

// ─── Vector minimap renderer ──────────────────────────────────────────────────
//
// Pure pixel-math renderer — no canvas, no API calls.
//
// Brightness levels (8-bit, mapped to 4-bit index = value >> 4):
//    0  — background (index 0 = black)
//   30  — background roads
//   50  — past steps   (index 3)
//  130  — upcoming steps (index 8)
//  180  — corner brackets / compass labels (index 11)
//  200  — turn marker / compass (index 12)
//  240  — current step / thick (index 15)
//  255  — position marker (index 15)

interface StepCoords {
  polylinePoints: Array<[number, number]>
  startLat: number
  startLng: number
  endLat: number
  endLng: number
}

function renderPixels(
  lat: number,
  lng: number,
  steps: StepCoords[],
  stepIdx: number,
  w: number,
  h: number,
  zoom: number,
  roads: Array<Array<[number, number]>> = [],
): Uint8Array {
  const METERS_PER_DEG = 111_320
  const cosLat = Math.cos(lat * Math.PI / 180)
  const mpp = 2 * Math.PI * 6_378_137 * cosLat / (256 * Math.pow(2, zoom))
  const cx = w / 2
  const cy = h / 2

  const pixels = new Uint8Array(w * h).fill(0)

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
        if (dx >= dy) { setPixel(x0, y0 + 1, v); setPixel(x0, y0 - 1, v) }
        else          { setPixel(x0 + 1, y0, v); setPixel(x0 - 1, y0, v) }
      }
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; x0 += sx }
      if (e2 <  dx) { err += dx; y0 += sy }
    }
  }

  // Draw a 5×5 glyph at pixel position (x0, y0)
  function drawGlyph(key: string, x0: number, y0: number, v: number) {
    const rows = COMPASS_GLYPHS[key]
    if (!rows) return
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (rows[row] & (1 << (GLYPH_W - 1 - col))) setPixel(x0 + col, y0 + row, v)
      }
    }
  }

  // ── Background roads (from OSM Overpass) ─────────────────────────────────────
  for (const road of roads) {
    for (let j = 0; j < road.length - 1; j++) {
      const [px0, py0] = toPixel(road[j][0],     road[j][1])
      const [px1, py1] = toPixel(road[j + 1][0], road[j + 1][1])
      drawLine(px0, py0, px1, py1, 40, false)
    }
  }

  // ── Route segments ────────────────────────────────────────────────────────────
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    const past    = i < stepIdx
    const current = i === stepIdx
    const v       = past ? 50 : current ? 240 : 130
    const thick   = current

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

  // ── Next turn marker — small cross at end of current step ─────────────────────
  if (stepIdx < steps.length) {
    const s = steps[stepIdx]
    if (s.endLat || s.endLng) {
      const [tx, ty] = toPixel(s.endLat, s.endLng)
      setPixel(tx,     ty,     255)
      setPixel(tx + 1, ty,     200); setPixel(tx - 1, ty,     200)
      setPixel(tx,     ty + 1, 200); setPixel(tx,     ty - 1, 200)
    }
  }

  // ── Position marker — filled diamond at current position ──────────────────────
  const [posX, posY] = toPixel(lat, lng)
  setPixel(posX,     posY,     255)
  setPixel(posX + 1, posY,     255); setPixel(posX - 1, posY,     255)
  setPixel(posX,     posY + 1, 255); setPixel(posX,     posY - 1, 255)
  setPixel(posX + 1, posY + 1, 200); setPixel(posX - 1, posY + 1, 200)
  setPixel(posX + 1, posY - 1, 200); setPixel(posX - 1, posY - 1, 200)

  // ── Corner brackets ───────────────────────────────────────────────────────────
  const CL = 12  // arm length in pixels
  const CV = 180 // brightness
  for (let i = 0; i < CL; i++) {
    setPixel(i,         0,         CV); setPixel(0,         i,         CV)  // top-left
    setPixel(w - 1 - i, 0,         CV); setPixel(w - 1,     i,         CV)  // top-right
    setPixel(i,         h - 1,     CV); setPixel(0,         h - 1 - i, CV)  // bottom-left
    setPixel(w - 1 - i, h - 1,     CV); setPixel(w - 1,     h - 1 - i, CV)  // bottom-right
  }

  // ── Compass labels — N/S/E/W placed on the largest inscribed circle ───────────
  //
  // The circle has radius r = min(w,h)/2. Each glyph (5×5) is positioned so
  // its outermost edge (the face furthest from centre) touches the circle.
  {
    const r  = Math.min(w, h) / 2
    const gc = 200  // glyph brightness
    // N — top edge of glyph at y = cy − r
    drawGlyph('N', Math.round(cx - GLYPH_W / 2), Math.round(cy - r),                  gc)
    // S — bottom edge of glyph at y = cy + r − 1
    drawGlyph('S', Math.round(cx - GLYPH_W / 2), Math.round(cy + r) - GLYPH_H,        gc)
    // E — right edge of glyph at x = cx + r − 1
    drawGlyph('E', Math.round(cx + r) - GLYPH_W, Math.round(cy - GLYPH_H / 2),        gc)
    // W — left edge of glyph at x = cx − r
    drawGlyph('W', Math.round(cx - r),            Math.round(cy - GLYPH_H / 2),        gc)
  }

  return pixels
}

export function renderMinimapBmp(
  lat: number, lng: number, steps: StepCoords[], stepIdx: number,
  w: number, h: number, zoom: number,
  roads: Array<Array<[number, number]>> = [],
): number[] {
  return Array.from(encodeGreyscale4BitBmp(w, h, renderPixels(lat, lng, steps, stepIdx, w, h, zoom, roads)))
}

export function renderMinimapBmpTiles(
  lat: number, lng: number, steps: StepCoords[], stepIdx: number,
  totalW: number, totalH: number, tileW: number, tileH: number, zoom: number,
  roads: Array<Array<[number, number]>> = [],
): number[][] {
  const pixels = renderPixels(lat, lng, steps, stepIdx, totalW, totalH, zoom, roads)
  const cols = totalW / tileW
  const rows = totalH / tileH
  const tiles: number[][] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sub = new Uint8Array(tileW * tileH)
      for (let y = 0; y < tileH; y++)
        for (let x = 0; x < tileW; x++)
          sub[y * tileW + x] = pixels[(row * tileH + y) * totalW + (col * tileW + x)]
      tiles.push(Array.from(encodeGreyscale4BitBmp(tileW, tileH, sub)))
    }
  }
  return tiles
}
