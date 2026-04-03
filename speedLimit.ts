// ─── speedLimit.ts ────────────────────────────────────────────────────────────
//
// Fetches the posted speed limit for the current GPS position using two
// Roads API calls:
//
//   1. nearestRoads  — snaps lat/lng to the closest road segment, returning
//                      a place ID for that segment.
//   2. speedLimits   — returns the posted limit for the given place ID.
//
// Results are cached by place ID so we only hit the API when the driver
// moves onto a new road segment, not on every GPS tick.
//
// NOTE: The Speed Limits endpoint requires a Google Maps Asset Tracking
// license. If your project lacks this license, the call will return a 403.
// The service degrades gracefully — limitMph stays null and the badge hides.

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string

const ROADS_BASE = 'https://roads.googleapis.com/v1'

// ─── Cache ────────────────────────────────────────────────────────────────────

// placeId → speed limit in mph (or null if unavailable)
const limitCache = new Map<string, number | null>()

// The place ID of the road segment we're currently on
let currentPlaceId: string | null = null

// ─── Types ────────────────────────────────────────────────────────────────────

interface NearestRoadsResponse {
  snappedPoints?: Array<{
    location:      { latitude: number; longitude: number }
    originalIndex: number
    placeId:       string
  }>
}

interface SpeedLimitsResponse {
  speedLimits?: Array<{
    placeId:    string
    speedLimit: number   // value in the units field below
    units:      'MPH' | 'KPH'
  }>
}

// ─── API calls ────────────────────────────────────────────────────────────────

/**
 * Snap a single lat/lng to the nearest road segment and return its place ID.
 * Returns null if the API call fails or returns no points.
 */
async function nearestRoadPlaceId(lat: number, lng: number): Promise<string | null> {
  const url = new URL(`${ROADS_BASE}/nearestRoads`)
  url.searchParams.set('points', `${lat},${lng}`)
  url.searchParams.set('key', MAPS_KEY)

  const res = await fetch(url.toString())
  if (!res.ok) {
    console.warn(`nearestRoads ${res.status}:`, await res.text())
    return null
  }

  const data: NearestRoadsResponse = await res.json()
  return data.snappedPoints?.[0]?.placeId ?? null
}

/**
 * Fetch the posted speed limit for a road segment place ID.
 * Returns the limit in mph, or null if unavailable.
 */
async function fetchSpeedLimit(placeId: string): Promise<number | null> {
  const url = new URL(`${ROADS_BASE}/speedLimits`)
  url.searchParams.set('placeId', placeId)
  url.searchParams.set('key', MAPS_KEY)

  const res = await fetch(url.toString())

  if (res.status === 403) {
    // Asset Tracking license not active on this project
    console.warn('Speed Limits API requires an Asset Tracking license (403). Badge will be hidden.')
    return null
  }

  if (!res.ok) {
    console.warn(`speedLimits ${res.status}:`, await res.text())
    return null
  }

  const data: SpeedLimitsResponse = await res.json()
  const entry = data.speedLimits?.[0]
  if (!entry) return null

  // Normalise to mph regardless of what the API returns
  return entry.units === 'KPH'
    ? Math.round(entry.speedLimit * 0.621371)
    : Math.round(entry.speedLimit)
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Returns the posted speed limit in mph for the current GPS position.
 *
 * Workflow:
 *   1. Snap position to nearest road → get place ID
 *   2. If place ID unchanged from last call → return cached value (no API call)
 *   3. If place ID is new → fetch speed limit, cache it, return it
 *
 * Always resolves — returns null on any error or missing data so the
 * caller can safely hide the badge without crashing.
 */
export async function getSpeedLimitMph(lat: number, lng: number): Promise<number | null> {
  try {
    const placeId = await nearestRoadPlaceId(lat, lng)
    if (!placeId) return null

    // Same segment as before — use cache
    if (placeId === currentPlaceId && limitCache.has(placeId)) {
      return limitCache.get(placeId) ?? null
    }

    // New segment — fetch and cache
    currentPlaceId = placeId

    if (limitCache.has(placeId)) {
      // We've been on this segment before (e.g. a loop route)
      return limitCache.get(placeId) ?? null
    }

    const limit = await fetchSpeedLimit(placeId)
    limitCache.set(placeId, limit)
    return limit

  } catch (err) {
    console.warn('Speed limit lookup failed:', err)
    return null
  }
}

/**
 * Clear the place ID cache — call this when starting a new route so
 * stale segment data doesn't bleed across trips.
 */
export function resetSpeedLimitCache(): void {
  limitCache.clear()
  currentPlaceId = null
}
