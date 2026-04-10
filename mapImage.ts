const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string

// Dark map styles — black background, roads visible but not overwhelming.
// After 55% brightness scaling the route overlay (240) stands out clearly.
const DARK_STYLES = [
  'feature:all|element:geometry|color:0x1a1a1a',
  'feature:all|element:labels|visibility:off',
  'feature:water|element:geometry|color:0x0a0a0a',
  'feature:road|element:geometry|color:0x555555',
  'feature:road.arterial|element:geometry|color:0x888888',
  'feature:road.highway|element:geometry|color:0xdddddd',
  'feature:road.highway|element:geometry.stroke|color:0x333333',
  'feature:landscape.man_made|element:geometry|color:0x2e2e2e',
]

async function fetchMapSnapshot(lat: number, lng: number, widthPx: number, heightPx: number, zoom: number): Promise<Blob> {
  const url = new URL('https://maps.googleapis.com/maps/api/staticmap')
  url.searchParams.set('center', `${lat},${lng}`)
  url.searchParams.set('zoom',   String(zoom))
  url.searchParams.set('size',   `${widthPx}x${heightPx}`)
  url.searchParams.set('scale',  '1')
  url.searchParams.set('maptype','roadmap')
  for (const s of DARK_STYLES) url.searchParams.append('style', s)
  url.searchParams.set('key', MAPS_KEY)
  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6000)
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal })
    if (!res.ok) throw new Error(`Static Maps ${res.status}`)
    return res.blob()
  } finally {
    clearTimeout(timer)
  }
}

async function imageBlobToGreyscale8bit(blob: Blob, w: number, h: number): Promise<Uint8Array> {
  const blobUrl = URL.createObjectURL(blob)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload  = () => { URL.revokeObjectURL(blobUrl); resolve(image) }
    image.onerror = (e) => { URL.revokeObjectURL(blobUrl); reject(e) }
    image.src = blobUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  canvas.style.cssText = 'position:absolute;left:-9999px;top:-9999px;'
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  document.body.removeChild(canvas)
  const pixels = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    pixels[i] = Math.round(0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2])
  }
  return pixels
}


// ─── Heading-aligned background ───────────────────────────────────────────────
//
// Fetch a square map image large enough that, after rotating by headingDeg and
// cropping to w×h, no black corners appear.  Diagonal = √(w²+h²).

async function fetchHeadingUpBackground(
  lat: number, lng: number,
  w: number, h: number,
  zoom: number, headingDeg: number,
  log?: (msg: string) => void,
): Promise<Uint8Array> {
  const diag = Math.ceil(Math.sqrt(w * w + h * h)) + 2
  let src: Uint8Array

  try {
    const blob = await fetchMapSnapshot(lat, lng, diag, diag, zoom)
    src = await imageBlobToGreyscale8bit(blob, diag, diag)
    // Scale brightness: roads ~28–73, highways ~73 — leaves 240 for route overlay
    for (let i = 0; i < src.length; i++) src[i] = Math.round(src[i] * 0.55)
  } catch (e) {
    log?.(`minimap bg: ${e instanceof Error ? e.message : String(e)}`)
    src = new Uint8Array(diag * diag).fill(35)
  }

  // Rotate src (diag×diag) by headingDeg → crop centre w×h
  const dst = new Uint8Array(w * h)
  const θ    = headingDeg * Math.PI / 180
  const cosθ = Math.cos(θ), sinθ = Math.sin(θ)
  const srcCx = diag / 2, srcCy = diag / 2
  const dstCx = w / 2,   dstCy = h / 2

  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      const dx = ox - dstCx, dy = oy - dstCy
      // Inverse map: output pixel → input pixel
      const ix = Math.round(srcCx + dx * cosθ - dy * sinθ)
      const iy = Math.round(srcCy + dx * sinθ + dy * cosθ)
      if (ix >= 0 && ix < diag && iy >= 0 && iy < diag) {
        dst[oy * w + ox] = src[iy * diag + ix]
      }
    }
  }
  return dst
}

// ─── Vector minimap renderer ──────────────────────────────────────────────────
//
// Composes background map (heading-rotated) + route overlay + position marker.
//
// Brightness guide:
//   background (roads scaled 55%):   roads ~30–120
//   past steps:    50
//   future steps:  160
//   current step:  240 (3 px thick)
//   position dot:  255 (white)
//   turn marker:   255

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
  headingDeg = 0,
  log?: (msg: string) => void,
): Promise<number[]> {
  const pixels = await fetchHeadingUpBackground(lat, lng, w, h, zoom, headingDeg, log)

  const METERS_PER_DEG = 111_320
  const cosLat = Math.cos(lat * Math.PI / 180)
  const mpp    = 2 * Math.PI * 6_378_137 * cosLat / (256 * Math.pow(2, zoom))
  const cx = w / 2, cy = h / 2
  const θ    = headingDeg * Math.PI / 180
  const cosθ = Math.cos(θ), sinθ = Math.sin(θ)

  function setPixel(x: number, y: number, v: number) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      if (v > pixels[y * w + x]) pixels[y * w + x] = v
    }
  }

  // Geo → screen using heading-aligned projection
  function toPixel(plat: number, plng: number): [number, number] {
    const em = (plng - lng) * cosLat * METERS_PER_DEG   // east metres
    const nm = (plat - lat) * METERS_PER_DEG             // north metres
    return [
      Math.round(cx + (em * cosθ - nm * sinθ) / mpp),
      Math.round(cy - (em * sinθ + nm * cosθ) / mpp),
    ]
  }

  function drawLine(x0: number, y0: number, x1: number, y1: number, v: number, thick: boolean) {
    const dx = Math.abs(x1-x0), dy = Math.abs(y1-y0)
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    for (;;) {
      setPixel(x0, y0, v)
      if (thick) {
        if (dx >= dy) { setPixel(x0, y0+1, v); setPixel(x0, y0-1, v) }
        else          { setPixel(x0+1, y0, v); setPixel(x0-1, y0, v) }
      }
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; x0 += sx }
      if (e2 <  dx) { err += dx; y0 += sy }
    }
  }

  // Draw route segments
  for (let i = 0; i < steps.length; i++) {
    const s       = steps[i]
    const current = i === stepIdx
    const v       = i < stepIdx ? 50 : current ? 240 : 160
    const thick   = current

    const pts: Array<[number, number]> = s.polylinePoints.length >= 2
      ? s.polylinePoints
      : (s.startLat || s.startLng) && (s.endLat || s.endLng)
        ? [[s.startLat, s.startLng], [s.endLat, s.endLng]]
        : []

    for (let j = 0; j < pts.length - 1; j++) {
      const [px0, py0] = toPixel(pts[j][0],     pts[j][1])
      const [px1, py1] = toPixel(pts[j+1][0], pts[j+1][1])
      drawLine(px0, py0, px1, py1, v, thick)
    }
  }

  // Next turn marker — 3×3 bright square at end of current step
  if (stepIdx < steps.length) {
    const s = steps[stepIdx]
    if (s.endLat || s.endLng) {
      const [tx, ty] = toPixel(s.endLat, s.endLng)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          setPixel(tx+dx, ty+dy, 255)
    }
  }

  // Position marker — 5×5 white square, clearly visible
  const [posX, posY] = toPixel(lat, lng)
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      setPixel(posX+dx, posY+dy, 255)

  // Bright border so we can confirm the container is rendering
  for (let x = 0; x < w; x++) { setPixel(x, 0, 200); setPixel(x, h-1, 200) }
  for (let y = 0; y < h; y++) { setPixel(0, y, 200); setPixel(w-1, y, 200) }

  // Return one 4-bit value (0–15) per pixel as number[].
  // The G2 SDK expects imageData.length == w * h with each entry in [0, 15].
  const out = new Array<number>(w * h)
  for (let i = 0; i < w * h; i++) {
    out[i] = Math.min(15, Math.round(pixels[i] / 255 * 15))
  }
  return out
}
