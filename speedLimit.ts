// ─── speedLimit.ts ────────────────────────────────────────────────────────────
//
// Fetches the posted speed limit using the Overpass API (OpenStreetMap data).
// No API key required — queries the public Overpass endpoint.
//
// Strategy:
//   • Find all OSM ways with a maxspeed tag within 40 m of the GPS fix.
//   • Score candidates by centre-distance + road-type priority.
//   • Cache results by ≈ 111 m grid tile so we hit the API at most once
//     per tile (roughly every 6 s at 60 mph) rather than every GPS tick.
//
// maxspeed parsing:
//   "30 mph"  →  30 mph
//   "50"      →  50 km/h → 31 mph  (OSM default unit is km/h)
//   "50 km/h" →  50 km/h → 31 mph
//   "national" / "walk" / country-codes → null (badge hidden)

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

// ─── Cache ────────────────────────────────────────────────────────────────────

// Keyed by grid tile (~111 m resolution at equator)
const limitCache = new Map<string, number | null>()

function tileKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a    = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Lower index = prefer this road type when multiple candidates match
const HIGHWAY_PRIO: Record<string, number> = {
  motorway: 0, motorway_link: 0,
  trunk: 1, trunk_link: 1,
  primary: 2, primary_link: 2,
  secondary: 3, secondary_link: 3,
  tertiary: 4, tertiary_link: 4,
  residential: 5, unclassified: 6, service: 7,
}

/** Convert an OSM maxspeed tag value to mph.  Returns null for unparseable values. */
function parseMaxspeed(val: string | undefined): number | null {
  if (!val) return null
  const v = val.trim()

  // "30 mph" or "30mph"
  const mph = v.match(/^(\d+(?:\.\d+)?)\s*mph$/i)
  if (mph) return Math.round(parseFloat(mph[1]))

  // Plain number, "50 km/h", or "50 kph" — OSM default unit is km/h
  const kph = v.match(/^(\d+(?:\.\d+)?)(?:\s*(?:km\/h|kph))?$/i)
  if (kph) return Math.round(parseFloat(kph[1]) * 0.621371)

  return null  // "national", "walk", "none", "DE:urban", etc.
}

// ─── Overpass query ───────────────────────────────────────────────────────────

async function queryNearestLimit(lat: number, lng: number): Promise<number | null> {
  // Ask for all road ways with a maxspeed tag within 40 m, including centre point
  const query =
    `[out:json][timeout:6];` +
    `way(around:40,${lat.toFixed(6)},${lng.toFixed(6)})[highway][maxspeed];` +
    `out tags center;`

  const ctrl  = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 6500)
  let res: Response
  try {
    res = await fetch(OVERPASS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `data=${encodeURIComponent(query)}`,
      signal:  ctrl.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    console.warn(`Overpass API ${res.status}`)
    return null
  }

  const data: { elements?: any[] } = await res.json()
  const elements = data.elements ?? []
  if (elements.length === 0) return null

  // Score each candidate: prefer closest centre + higher road priority.
  // 10 m penalty per priority level so a nearer minor road beats a distant major one.
  let bestScore = Infinity
  let bestLimit: number | null = null

  for (const el of elements) {
    if (!el.center || !el.tags?.maxspeed) continue
    const limit = parseMaxspeed(el.tags.maxspeed)
    if (limit === null) continue

    const dist  = haversineM(lat, lng, el.center.lat, el.center.lon)
    const prio  = HIGHWAY_PRIO[el.tags.highway as string] ?? 8
    const score = dist + prio * 10

    if (score < bestScore) { bestScore = score; bestLimit = limit }
  }

  return bestLimit
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Returns the posted speed limit in mph for the given GPS position, or null
 * if no speed limit data is available nearby.  Always resolves — never throws.
 */
export async function getSpeedLimitMph(lat: number, lng: number): Promise<number | null> {
  const key = tileKey(lat, lng)
  if (limitCache.has(key)) return limitCache.get(key) ?? null

  try {
    const limit = await queryNearestLimit(lat, lng)
    limitCache.set(key, limit)
    return limit
  } catch (err) {
    console.warn('Speed limit lookup failed:', err)
    return null
  }
}

/** Clear the cache — call when starting a new route. */
export function resetSpeedLimitCache(): void {
  limitCache.clear()
}
