const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string

export interface MapImageOptions {
  widthPx:  number
  heightPx: number
  zoom:     number
}

export async function fetchMapSnapshot(lat: number, lng: number, opts: MapImageOptions): Promise<Blob> {
  const url = new URL('https://maps.googleapis.com/maps/api/staticmap')
  url.searchParams.set('center', `${lat},${lng}`)
  url.searchParams.set('zoom',   String(opts.zoom))
  url.searchParams.set('size',   `${opts.widthPx}x${opts.heightPx}`)
  url.searchParams.set('scale',  '1')
  url.searchParams.set('maptype','roadmap')
  url.searchParams.set('markers',`size:tiny|color:white|${lat},${lng}`)
  url.searchParams.set('style',  'feature:poi|visibility:off')
  url.searchParams.set('key',    MAPS_KEY)

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Static Maps ${res.status}`)
  return res.blob()
}

/**
 * Convert a PNG/JPEG blob to a flat number[] of 4-bit greyscale values (0–15),
 * one integer per pixel — the format expected by ImageRawDataUpdate.imageData.
 *
 * The SDK receives List<int> on the host (Dart) side; values must be 0–15.
 */
export async function imageToGreyscale4bit(blob: Blob, w: number, h: number): Promise<number[]> {
  const url = URL.createObjectURL(blob)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => { URL.revokeObjectURL(url); resolve(image) }
    image.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    image.src = url
  })

  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)

  const { data } = ctx.getImageData(0, 0, w, h)

  // First pass: compute luma + find range for contrast stretch
  const lumas: number[] = new Array(w * h)
  let lo = 255, hi = 0
  for (let i = 0; i < w * h; i++) {
    const luma = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]
    lumas[i] = luma
    if (luma < lo) lo = luma
    if (luma > hi) hi = luma
  }

  // Second pass: stretch [lo..hi] → [0..15] and clamp
  const range = hi > lo ? hi - lo : 1
  const out: number[] = lumas.map(l =>
    Math.max(0, Math.min(15, Math.round((l - lo) / range * 15)))
  )

  return out
}
