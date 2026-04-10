// ─── mapImage.ts ─────────────────────────────────────────────────────────────
//
// Renders the minimap using canvas 2D drawing (no raster image download).
//
// Pipeline:
//   1. Draw black background on an off-screen canvas.
//   2. Project lat/lng → pixel using flat Mercator (zoom-based scale).
//   3. Draw past/current/future route steps in graduated brightness.
//   4. Draw position marker and turn marker.
//   5. Return number[] of 4-bit greyscale values (0–15) for ImageRawDataUpdate.
//
// This matches the approach used in the working v0.2.30 build.

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
  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  canvas.style.cssText = 'position:absolute;left:-9999px;top:-9999px;'
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    document.body.removeChild(canvas)
    log?.('minimap: canvas 2d unavailable')
    return new Array<number>(w * h).fill(0)
  }

  // Black background
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)

  // Flat Mercator scale: metres per pixel at this zoom and latitude
  const cosLat = Math.cos(lat * Math.PI / 180)
  const mpp    = 2 * Math.PI * 6_378_137 * cosLat / (256 * Math.pow(2, zoom))
  const METERS_PER_DEG = 111_320
  const cx = w / 2, cy = h / 2

  function toXY(plat: number, plng: number): [number, number] {
    const em = (plng - lng) * cosLat * METERS_PER_DEG  // east metres
    const nm = (plat - lat) * METERS_PER_DEG            // north metres
    return [cx + em / mpp, cy - nm / mpp]
  }

  function grey(v: number): string {
    const c = Math.round(Math.max(0, Math.min(255, v)))
    return `rgb(${c},${c},${c})`
  }

  // Draw route segments
  for (let i = 0; i < steps.length; i++) {
    const s       = steps[i]
    const current = i === stepIdx
    const v       = i < stepIdx ? 50 : current ? 240 : 160

    const pts: Array<[number, number]> = s.polylinePoints.length >= 2
      ? s.polylinePoints
      : (s.startLat || s.startLng) && (s.endLat || s.endLng)
        ? [[s.startLat, s.startLng], [s.endLat, s.endLng]]
        : []

    if (pts.length < 2) continue

    ctx.strokeStyle = grey(v)
    ctx.lineWidth   = current ? 3 : 2
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.beginPath()
    const [x0, y0] = toXY(pts[0][0], pts[0][1])
    ctx.moveTo(x0, y0)
    for (let j = 1; j < pts.length; j++) {
      const [x, y] = toXY(pts[j][0], pts[j][1])
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  // Next turn marker — 3×3 white square at end of current step
  if (stepIdx < steps.length) {
    const s = steps[stepIdx]
    if (s.endLat || s.endLng) {
      const [tx, ty] = toXY(s.endLat, s.endLng)
      ctx.fillStyle = '#fff'
      ctx.fillRect(Math.round(tx) - 1, Math.round(ty) - 1, 3, 3)
    }
  }

  // Position marker — white circle with dark outline
  const [posX, posY] = toXY(lat, lng)
  ctx.fillStyle = '#000'
  ctx.beginPath(); ctx.arc(posX, posY, 4, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.beginPath(); ctx.arc(posX, posY, 3, 0, Math.PI * 2); ctx.fill()

  // Extract pixels and convert to 4-bit greyscale (0–15)
  const { data } = ctx.getImageData(0, 0, w, h)
  document.body.removeChild(canvas)

  const out: number[] = new Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const luma = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]
    out[i] = Math.max(0, Math.min(15, Math.round(luma / 255 * 15)))
  }
  return out
}
