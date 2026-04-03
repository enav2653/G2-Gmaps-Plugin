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
 * Convert a PNG/JPEG blob to 4-bit greyscale packed bytes (2 pixels per byte,
 * high nibble first) as expected by bridge.updateImageRawData().
 */
export async function imageToGreyscaleBytes(blob: Blob, w: number, h: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(w, h)
  const ctx    = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)

  const { data } = ctx.getImageData(0, 0, w, h)
  const out = new Uint8Array(Math.ceil((w * h) / 2))

  for (let i = 0; i < w * h; i++) {
    const luma   = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]
    const nibble = Math.min(15, Math.round((luma / 255) * 15))
    const bi     = Math.floor(i / 2)
    if (i % 2 === 0) { out[bi] = nibble << 4; continue }
    out[bi] |= nibble & 0x0f
  }

  return out
}
