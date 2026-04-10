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
 * Convert a PNG/JPEG blob to raw PNG bytes with optional brightness applied.
 *
 * The G2 firmware converts the image to 4-bit greyscale internally, so we
 * send a standard PNG. Brightness (0.0–1.0) is applied via canvas filter
 * before re-encoding. When brightness is 1.0 the raw blob bytes are returned
 * directly without a canvas round-trip.
 *
 * Uses HTMLCanvasElement for WebView compatibility.
 */
export async function imageToBytes(blob: Blob, w: number, h: number, brightness: number): Promise<Uint8Array> {
  // Fast path: no brightness adjustment needed
  if (brightness >= 1) {
    return new Uint8Array(await blob.arrayBuffer())
  }

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
  ctx.filter = `brightness(${brightness})`
  ctx.drawImage(img, 0, 0, w, h)

  const adjusted = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png')
  })
  return new Uint8Array(await adjusted.arrayBuffer())
}
