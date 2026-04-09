const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string

export interface MapImageOptions {
  widthPx:  number
  heightPx: number
  zoom:     number
}

// Dark map styles — black background, roads scaled by prominence.
// Chosen so the contrast-stretched greyscale output fills 0–15 with
// meaningful detail rather than being a mostly-white wash-out.
const DARK_STYLES = [
  'feature:all|element:geometry|color:0x1a1a1a',
  'feature:all|element:labels|visibility:off',
  'feature:water|element:geometry|color:0x0a0a0a',
  'feature:road|element:geometry|color:0x555555',
  'feature:road.arterial|element:geometry|color:0x888888',
  'feature:road.highway|element:geometry|color:0xdddddd',
  'feature:road.highway|element:geometry.stroke|color:0x333333',
]

export async function fetchMapSnapshot(lat: number, lng: number, opts: MapImageOptions): Promise<Blob> {
  const url = new URL('https://maps.googleapis.com/maps/api/staticmap')
  url.searchParams.set('center', `${lat},${lng}`)
  url.searchParams.set('zoom',   String(opts.zoom))
  url.searchParams.set('size',   `${opts.widthPx}x${opts.heightPx}`)
  url.searchParams.set('scale',  '1')
  url.searchParams.set('maptype','roadmap')
  // Position marker: small white dot
  url.searchParams.set('markers', `size:tiny|color:white|${lat},${lng}`)
  for (const s of DARK_STYLES) url.searchParams.append('style', s)
  url.searchParams.set('key', MAPS_KEY)

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Static Maps ${res.status}`)
  return res.blob()
}

/**
 * Convert a PNG/JPEG blob to a flat number[] of 4-bit greyscale values (0–15),
 * one integer per pixel — the format expected by ImageRawDataUpdate.imageData.
 *
 * The SDK receives List<int> on the host (Dart) side; values must be 0–15.
 * Applies contrast stretching so the full 0–15 range is always used.
 */
export async function imageToGreyscale4bit(blob: Blob, w: number, h: number): Promise<number[]> {
  const blobUrl = URL.createObjectURL(blob)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(blobUrl); resolve(image) }
    image.onerror = (e) => { URL.revokeObjectURL(blobUrl); reject(e) }
    image.src = blobUrl
  })

  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  // Attach off-screen so WebViews don't defer canvas rendering
  canvas.style.cssText = 'position:absolute;left:-9999px;top:-9999px;'
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  document.body.removeChild(canvas)

  // First pass: BT.601 luma + find actual range for contrast stretch
  const lumas: number[] = new Array(w * h)
  let lo = 255, hi = 0
  for (let i = 0; i < w * h; i++) {
    const luma = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]
    lumas[i] = luma
    if (luma < lo) lo = luma
    if (luma > hi) hi = luma
  }

  // Second pass: stretch [lo..hi] → [0..15]
  const range = hi > lo ? hi - lo : 1
  return lumas.map(l => Math.max(0, Math.min(15, Math.round((l - lo) / range * 15))))
}
