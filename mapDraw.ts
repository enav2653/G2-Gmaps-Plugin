// ─── mapDraw.ts ───────────────────────────────────────────────────────────────
//
// Renders a minimap as a vector line drawing (no raster image download needed).
//
// Pipeline:
//   1. Fetch nearby road geometry from OpenStreetMap Overpass API (cached).
//   2. Project lat/lng → canvas pixel using a flat Mercator approximation.
//   3. Draw roads as grey lines; current route step in bright white.
//   4. Draw a filled circle at current position.
//   5. Return number[] of 4-bit greyscale values (0–15) for ImageRawDataUpdate.
//
// The dark-background / bright-line approach naturally spans the full 0–15
// range, so no contrast stretching is required.

import { RouteStep } from './maps'

// ─── OSM road fetch (Overpass API) ───────────────────────────────────────────

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

// Highway tags ordered by prominence (used for render priority + brightness)
const ROAD_CLASSES = [
  'motorway', 'trunk', 'primary', 'secondary',
  'tertiary', 'residential', 'unclassified', 'service',
] as const
type RoadClass = (typeof ROAD_CLASSES)[number]

interface OsmWay {
  highway: RoadClass
  nodes: Array<{ lat: number; lng: number }>
}

async function fetchOsmRoads(lat: number, lng: number, radiusM: number): Promise<OsmWay[]> {
  const query =
    `[out:json][timeout:10];` +
    `(way["highway"~"^(${ROAD_CLASSES.join('|')})$"](around:${radiusM},${lat},${lng}););` +
    `out geom;`

  const res = await fetch(OVERPASS_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `data=${encodeURIComponent(query)}`,
  })
  if (!res.ok) throw new Error(`Overpass ${res.status}`)

  const data = await res.json()
  const ways: OsmWay[] = []
  for (const el of data.elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue
    const hw = el.tags?.highway as string
    if (!ROAD_CLASSES.includes(hw as RoadClass)) continue
    ways.push({
      highway: hw as RoadClass,
      nodes:   el.geometry.map((n: any) => ({ lat: n.lat, lng: n.lon })),
    })
  }
  return ways
}

// ─── Simple in-memory road cache (avoid re-fetching every 5 s) ───────────────

interface RoadCache {
  lat: number
  lng: number
  roads: OsmWay[]
  fetchedAt: number
}

let roadCache: RoadCache | null = null
const CACHE_TTL_MS  = 90_000  // re-fetch after 1.5 min
const CACHE_DIST_M  = 150     // re-fetch if moved > 150 m

function approxDistM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dlat = (lat2 - lat1) * 111_111
  const dlng = (lng2 - lng1) * 111_111 * Math.cos(lat1 * Math.PI / 180)
  return Math.hypot(dlat, dlng)
}

async function getCachedRoads(lat: number, lng: number, radiusM: number): Promise<OsmWay[]> {
  if (roadCache) {
    const stale = Date.now() - roadCache.fetchedAt > CACHE_TTL_MS
    const moved = approxDistM(lat, lng, roadCache.lat, roadCache.lng) > CACHE_DIST_M
    if (!stale && !moved) return roadCache.roads
  }
  const roads = await fetchOsmRoads(lat, lng, radiusM)
  roadCache = { lat, lng, roads, fetchedAt: Date.now() }
  return roads
}

// ─── Coordinate → canvas projection ──────────────────────────────────────────
//
// Flat/equirectangular projection (accurate enough for the small area shown).
// metersPerPx controls zoom: 4 m/px ≈ zoom 15, 2 m/px ≈ zoom 16.

function geoToXY(
  lat: number, lng: number,
  centerLat: number, centerLng: number,
  mpp: number, cw: number, ch: number,
): { x: number; y: number } {
  const cosLat = Math.cos(centerLat * Math.PI / 180)
  const dx =  (lng - centerLng) * 111_111 * cosLat / mpp
  const dy = -(lat - centerLat) * 111_111            / mpp
  return { x: cw / 2 + dx, y: ch / 2 + dy }
}

// ─── Road render style ────────────────────────────────────────────────────────

const ROAD_STYLE: Record<RoadClass, { width: number; luma: number }> = {
  motorway:      { width: 2.5, luma: 180 },
  trunk:         { width: 2.5, luma: 160 },
  primary:       { width: 2,   luma: 140 },
  secondary:     { width: 1.5, luma: 120 },
  tertiary:      { width: 1.5, luma: 100 },
  residential:   { width: 1,   luma: 80  },
  unclassified:  { width: 1,   luma: 70  },
  service:       { width: 1,   luma: 55  },
}

function grey(luma: number): string {
  const v = Math.round(Math.max(0, Math.min(255, luma)))
  return `rgb(${v},${v},${v})`
}

// ─── Public render entry point ────────────────────────────────────────────────

export interface DrawMapOptions {
  lat:       number          // current centre position
  lng:       number
  steps:     RouteStep[]     // full route
  stepIdx:   number          // current step (highlighted in white)
  widthPx:   number
  heightPx:  number
  metersPerPx?: number       // default 4 (shows ~320 m wide)
}

export async function renderMapPixels(opts: DrawMapOptions): Promise<number[]> {
  const { lat, lng, steps, stepIdx, widthPx, heightPx } = opts
  const mpp = opts.metersPerPx ?? 4

  // Fetch radius = half-diagonal + 20% margin
  const radiusM = Math.round(Math.hypot(widthPx, heightPx) * mpp / 2 * 1.2)

  let roads: OsmWay[] = []
  try {
    roads = await getCachedRoads(lat, lng, radiusM)
  } catch {
    // Road fetch failed — render route-only
  }

  // ── Canvas setup ──────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas')
  canvas.width  = widthPx
  canvas.height = heightPx
  // Attach off-screen so WebViews that defer path rendering for detached
  // canvases still execute fillRect / stroke / arc correctly.
  canvas.style.cssText = 'position:absolute;left:-9999px;top:-9999px;'
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  if (!ctx) { document.body.removeChild(canvas); throw new Error('canvas 2d unavailable') }

  // Black background
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, widthPx, heightPx)

  const toXY = (rlat: number, rlng: number) =>
    geoToXY(rlat, rlng, lat, lng, mpp, widthPx, heightPx)

  // ── Draw background roads (lower prominence first → overdraw with wider) ──
  for (const cls of [...ROAD_CLASSES].reverse()) {
    const style = ROAD_STYLE[cls]
    ctx.strokeStyle = grey(style.luma)
    ctx.lineWidth   = style.width
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    for (const road of roads) {
      if (road.highway !== cls) continue
      ctx.beginPath()
      let first = true
      for (const n of road.nodes) {
        const { x, y } = toXY(n.lat, n.lng)
        if (first) { ctx.moveTo(x, y); first = false } else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  // ── Draw future route in medium white ─────────────────────────────────────
  if (steps.length > 0) {
    ctx.strokeStyle = grey(160)
    ctx.lineWidth   = 2
    ctx.lineCap     = 'round'
    ctx.lineJoin    = 'round'
    ctx.beginPath()
    let started = false
    for (let i = stepIdx + 1; i < steps.length; i++) {
      const s = steps[i]
      const { x: sx, y: sy } = toXY(s.startLat, s.startLng)
      const { x: ex, y: ey } = toXY(s.endLat,   s.endLng)
      if (!started) { ctx.moveTo(sx, sy); started = true }
      ctx.lineTo(ex, ey)
    }
    ctx.stroke()

    // ── Draw current step in bright white ────────────────────────────────────
    const cur = steps[stepIdx]
    if (cur) {
      ctx.strokeStyle = '#fff'
      ctx.lineWidth   = 3
      ctx.lineCap     = 'round'
      ctx.beginPath()
      const { x: sx, y: sy } = toXY(cur.startLat, cur.startLng)
      const { x: ex, y: ey } = toXY(cur.endLat,   cur.endLng)
      ctx.moveTo(sx, sy)
      ctx.lineTo(ex, ey)
      ctx.stroke()
    }
  }

  // ── Position marker — filled circle with dark outline ────────────────────
  const { x: cx, y: cy } = toXY(lat, lng)
  ctx.fillStyle   = '#000'
  ctx.beginPath()
  ctx.arc(cx, cy, 4, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.arc(cx, cy, 3, 0, Math.PI * 2)
  ctx.fill()

  // ── Convert to 4-bit greyscale number[] ───────────────────────────────────
  const { data } = ctx.getImageData(0, 0, widthPx, heightPx)
  document.body.removeChild(canvas)

  const out: number[] = new Array(widthPx * heightPx)
  for (let i = 0; i < widthPx * heightPx; i++) {
    const luma = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]
    out[i] = Math.max(0, Math.min(15, Math.round(luma / 255 * 15)))
  }
  return out
}
