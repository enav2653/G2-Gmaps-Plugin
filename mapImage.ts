const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string

export interface MapImageOptions {
  widthPx:  number
  heightPx: number
  zoom:     number
}

// Dark map styles — black background, roads scaled by prominence.
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
  url.searchParams.set('markers', `size:tiny|color:white|${lat},${lng}`)
  for (const s of DARK_STYLES) url.searchParams.append('style', s)
  url.searchParams.set('key', MAPS_KEY)

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`Static Maps ${res.status}`)
  return res.blob()
}

// ─── PNG encoder (following visionote's approach) ─────────────────────────────

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

// ─── Blob → 8-bit greyscale pixels ───────────────────────────────────────────

async function imageBlobToGreyscale8bit(blob: Blob, w: number, h: number): Promise<Uint8Array> {
  const blobUrl = URL.createObjectURL(blob)
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload  = () => { URL.revokeObjectURL(blobUrl); resolve(image) }
    image.onerror = (e) => { URL.revokeObjectURL(blobUrl); reject(e) }
    image.src = blobUrl
  })

  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a static map snapshot and return it as a PNG-encoded number[]
 * ready for ImageRawDataUpdate.imageData.
 */
export async function fetchMinimapPng(
  lat: number,
  lng: number,
  w: number,
  h: number,
  zoom: number,
): Promise<number[]> {
  const blob    = await fetchMapSnapshot(lat, lng, { widthPx: w, heightPx: h, zoom })
  const pixels  = await imageBlobToGreyscale8bit(blob, w, h)
  const pngBytes = await encodeGreyscalePng(w, h, pixels)
  return Array.from(pngBytes)
}
