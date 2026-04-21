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
  headingDeg = 0,
): Uint8Array {
  const METERS_PER_DEG = 111_320
  const cosLat = Math.cos(lat * Math.PI / 180)
  const mpp = 2 * Math.PI * 6_378_137 * cosLat / (256 * Math.pow(2, zoom))
  const cx = w / 2
  const cy = h / 2
  const cosH = Math.cos(headingDeg * Math.PI / 180)
  const sinH = Math.sin(headingDeg * Math.PI / 180)

  const pixels = new Uint8Array(w * h).fill(0)

  function toPixel(plat: number, plng: number): [number, number] {
    const rx = (plng - lng) * cosLat * METERS_PER_DEG / mpp
    const ry = (plat - lat) * METERS_PER_DEG / mpp
    return [Math.round(cx + rx * cosH - ry * sinH), Math.round(cy - (rx * sinH + ry * cosH))]
  }

  function setPixel(x: number, y: number, v: number) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      if (v > pixels[y * w + x]) pixels[y * w + x] = v
    }
  }

  // forcePixel always writes — used for the position pin so it sits on top of everything
  function forcePixel(x: number, y: number, v: number) {
    if (x >= 0 && x < w && y >= 0 && y < h) pixels[y * w + x] = v
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

    const pts: Array<[number, number]> = s.polylinePoints.length >= 2
      ? s.polylinePoints
      : (s.startLat || s.startLng) && (s.endLat || s.endLng)
        ? [[s.startLat, s.startLng], [s.endLat, s.endLng]]
        : []

    // Past steps that still have points inside the minimap viewport stay bright
    // and thick until they fully scroll off, giving a smooth trail after each maneuver.
    const inView = past && pts.some(([plat, plng]) => {
      const [px, py] = toPixel(plat, plng)
      return px >= 0 && px < w && py >= 0 && py < h
    })

    const v     = current ? 240 : inView ? 200 : past ? 50 : 130
    const thick = current || inView

    if (current && pts.length >= 2) {
      // Split the current step at the nearest polyline point to the user.
      // Segments before that point render as past (50, thin); segments from
      // that point onward render as current (240, thick).  This makes the
      // step-advance transition gradual rather than a sudden full-line swap.
      let splitIdx = 0
      let nearestSq = Infinity
      for (let k = 0; k < pts.length; k++) {
        const dlat = lat - pts[k][0]
        const dlng = (lng - pts[k][1]) * cosLat
        const dsq  = dlat * dlat + dlng * dlng
        if (dsq < nearestSq) { nearestSq = dsq; splitIdx = k }
      }
      for (let j = 0; j < pts.length - 1; j++) {
        const sv = j < splitIdx ? 50 : 240
        const [px0, py0] = toPixel(pts[j][0], pts[j][1])
        const [px1, py1] = toPixel(pts[j + 1][0], pts[j + 1][1])
        drawLine(px0, py0, px1, py1, sv, j >= splitIdx)
      }
    } else {
      for (let j = 0; j < pts.length - 1; j++) {
        const [px0, py0] = toPixel(pts[j][0],     pts[j][1])
        const [px1, py1] = toPixel(pts[j + 1][0], pts[j + 1][1])
        drawLine(px0, py0, px1, py1, v, thick)
      }
    }

    // Close any pixel gap at the junction between this step and the next.
    // Google's polylines share the endpoint in theory but rounding to pixels
    // can leave a 1-px break.  Use the dimmer of the two adjacent brightnesses
    // so the join doesn't flash brighter than either segment.
    if (i + 1 < steps.length && pts.length > 0) {
      const ns = steps[i + 1]
      const np: Array<[number, number]> = ns.polylinePoints.length >= 2
        ? ns.polylinePoints
        : (ns.startLat || ns.startLng) && (ns.endLat || ns.endLng)
          ? [[ns.startLat, ns.startLng], [ns.endLat, ns.endLng]]
          : []
      if (np.length > 0) {
        const nv  = i + 1 < stepIdx ? 50 : i + 1 === stepIdx ? 240 : 130
        const [px0, py0] = toPixel(pts[pts.length - 1][0], pts[pts.length - 1][1])
        const [px1, py1] = toPixel(np[0][0], np[0][1])
        drawLine(px0, py0, px1, py1, Math.min(v, nv), false)
      }
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
  // Glyphs rotate with the map so they always show true cardinal directions.
  // Glyph centers are placed at radius (r − GLYPH_H/2) so the outer edge
  // stays inside the inscribed circle at any heading.
  {
    const r  = Math.min(w, h) / 2
    const gr = r - GLYPH_H / 2  // glyph-centre radius
    const gc = 200
    const pad = 2  // dark badge padding around each glyph
    for (const [label, cardDeg] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as [string, number][]) {
      const a  = (cardDeg - headingDeg) * Math.PI / 180
      const lx = Math.round(cx + gr * Math.sin(a) - GLYPH_W / 2)
      const ly = Math.round(cy - gr * Math.cos(a) - GLYPH_H / 2)
      // Black badge so the glyph stays legible over any route line or road
      for (let gy = ly - pad; gy < ly + GLYPH_H + pad; gy++)
        for (let gx = lx - pad; gx < lx + GLYPH_W + pad; gx++)
          forcePixel(gx, gy, 0)
      drawGlyph(label, lx, ly, gc)
    }
  }

  // ── Position arrow — navigation chevron drawn last so it is always on top ────
  //
  // 2× scaled (18 wide × 14 tall). Each logical pixel → 2×2 screen pixels.
  // Logical centre (col 4, row 3) maps to (posX, posY).
  // Tip always points screen-up = heading direction on a heading-up map.
  //
  //   col: -8..+9 screen pixels (logical cols 0-8, ×2 offset -8)
  //         .  .  .  .  X  .  .  .  .   row 0  ← tip
  //         .  .  .  X  X  X  .  .  .   row 1
  //         .  .  X  X  X  X  X  .  .   row 2
  //         .  X  X  X  X  X  X  X  .   row 3  ← centre (posX, posY)
  //         X  X  X  X  X  X  X  X  X   row 4  ← widest
  //         X  X  .  .  .  .  .  X  X   row 5  ← wings
  //         .  X  .  .  .  .  .  X  .   row 6  ← flying-V notch
  //
  // Brightness = midpoint between current-step route (240) and background roads (40).
  {
    const [posX, posY] = toPixel(lat, lng)
    const PV = 140
    const shape = [
      [0,0,0,0,1,0,0,0,0],  // row 0  tip
      [0,0,0,1,1,1,0,0,0],  // row 1
      [0,0,1,1,1,1,1,0,0],  // row 2
      [0,1,1,1,1,1,1,1,0],  // row 3  centre
      [1,1,1,1,1,1,1,1,1],  // row 4  widest
      [1,1,0,0,0,0,0,1,1],  // row 5  wings
      [0,1,0,0,0,0,0,1,0],  // row 6  notch
    ]
    for (let row = 0; row < shape.length; row++)
      for (let col = 0; col < 9; col++)
        if (shape[row][col]) {
          // Each logical pixel → 2×2 block; centre (col 4, row 3) → (posX, posY)
          forcePixel(posX + col*2 - 8, posY + row*2 - 6, PV)
          forcePixel(posX + col*2 - 7, posY + row*2 - 6, PV)
          forcePixel(posX + col*2 - 8, posY + row*2 - 5, PV)
          forcePixel(posX + col*2 - 7, posY + row*2 - 5, PV)
        }
  }

  return pixels
}

export function renderMinimapBmp(
  lat: number, lng: number, steps: StepCoords[], stepIdx: number,
  w: number, h: number, zoom: number,
  roads: Array<Array<[number, number]>> = [],
  headingDeg = 0,
): number[] {
  return Array.from(encodeGreyscale4BitBmp(w, h, renderPixels(lat, lng, steps, stepIdx, w, h, zoom, roads, headingDeg)))
}

export function renderMinimapBmpTiles(
  lat: number, lng: number, steps: StepCoords[], stepIdx: number,
  totalW: number, totalH: number, tileW: number, tileH: number, zoom: number,
  roads: Array<Array<[number, number]>> = [],
  headingDeg = 0,
): number[][] {
  const pixels = renderPixels(lat, lng, steps, stepIdx, totalW, totalH, zoom, roads, headingDeg)
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

// ─── Compass calibration screen ───────────────────────────────────────────────
//
// Replaces the minimap during the initial figure-8 calibration routine.
// Draws three vertical progress bars: rotation (α), tilt (β), roll (γ).
// Each bar fills bottom-up; a checkmark appears below when that axis is done.

/** Renders a compass calibration progress graphic as a single BMP.
 *  rotPct / tiltPct / rollPct are each 0–1. */
function renderCalibrationPixels(
  rotPct: number, tiltPct: number, rollPct: number,
  w: number, h: number,
): Uint8Array {
  const pixels = new Uint8Array(w * h).fill(3)  // dark background

  function px(x: number, y: number, v: number) {
    if (x >= 0 && x < w && y >= 0 && y < h) pixels[y * w + x] = v
  }
  function rect(x0: number, y0: number, x1: number, y1: number, v: number) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(x, y, v)
  }
  function icon(m: number[][], ox: number, oy: number, v: number) {
    for (let r = 0; r < m.length; r++) for (let c = 0; c < m[r].length; c++) if (m[r][c]) px(ox+c, oy+r, v)
  }

  const ICO_ROT: number[][] = [
    [0,0,1,1,1,0,0,0,0], [0,1,0,0,0,1,0,0,0], [0,0,0,0,0,1,0,0,0],
    [0,0,0,0,1,1,1,0,0], [0,1,0,0,0,0,0,0,0], [0,0,1,1,1,0,0,0,0],
    [0,0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0,0],
  ]
  const ICO_TILT: number[][] = [
    [0,0,0,1,0,0,0,0,0], [0,0,1,1,1,0,0,0,0], [0,0,0,1,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0], [0,0,0,1,0,0,0,0,0], [0,0,1,1,1,0,0,0,0],
    [0,0,0,1,0,0,0,0,0], [0,0,0,0,0,0,0,0,0],
  ]
  const ICO_ROLL: number[][] = [
    [0,0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0,0], [0,1,0,0,0,0,0,1,0],
    [1,1,1,0,0,0,1,1,1], [0,1,0,0,0,0,0,1,0], [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0,0],
  ]
  const ICO_CHECK: number[][] = [
    [0,0,0,0,0,0,0,0,0], [0,0,0,0,0,1,0,0,0], [0,0,0,0,1,0,0,0,0],
    [1,0,0,1,0,0,0,0,0], [0,1,1,0,0,0,0,0,0], [0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0,0],
  ]

  const BAR_W  = 14, BAR_H = 76, BAR_Y = 32
  const BAR_XS = [22, 55, 88]
  const PCTS   = [rotPct, tiltPct, rollPct]
  const ICONS  = [ICO_ROT, ICO_TILT, ICO_ROLL]

  for (let i = 0; i < 3; i++) {
    const bx = BAR_XS[i]
    const p  = Math.min(1, Math.max(0, PCTS[i]))

    icon(ICONS[i], bx + 2, 8, 11)
    rect(bx, BAR_Y, bx + BAR_W, BAR_Y + BAR_H, 6)
    rect(bx + 1, BAR_Y + 1, bx + BAR_W - 1, BAR_Y + BAR_H - 1, 2)

    const fillH = Math.round(BAR_H * p)
    if (fillH > 0)
      rect(bx + 1, BAR_Y + BAR_H - fillH, bx + BAR_W - 1, BAR_Y + BAR_H - 1,
           p >= 1 ? 15 : 11)

    if (p >= 1) icon(ICO_CHECK, bx + 2, BAR_Y + BAR_H + 4, 15)
    else         rect(bx + 5, BAR_Y + BAR_H + 5, bx + 9, BAR_Y + BAR_H + 8, 5)
  }

  return pixels
}

/** Renders a compass calibration progress graphic as a single BMP.
 *  rotPct / tiltPct / rollPct are each 0–1. */
export function renderCalibrationBmp(
  rotPct: number, tiltPct: number, rollPct: number,
  w: number, h: number,
): number[] {
  return Array.from(encodeGreyscale4BitBmp(w, h,
    renderCalibrationPixels(rotPct, tiltPct, rollPct, w, h)))
}

