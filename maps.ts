// ─── maps.ts ──────────────────────────────────────────────────────────────────
//
// Routing and geocoding with automatic backend selection:
//
//   • Google (Routes API + Geocoding API) — when a key is configured
//   • OSRM  (Project OSRM demo server)   — free, no key required
//   • Nominatim (OSM geocoder)           — free, no key required
//
// Call setGoogleMapsKey() at startup with any saved key.
// hasGoogleMapsKey() lets the UI decide what features to show.

export interface LatLng {
  lat: number
  lng: number
}

export interface RouteStep {
  instruction: string
  distanceMeters: number
  durationSeconds: number
  startLat: number
  startLng: number
  endLat: number
  endLng: number
  polylinePoints: Array<[number, number]>  // decoded step polyline (lat, lng pairs)
}

// ─── Key management ───────────────────────────────────────────────────────────

let runtimeGoogleKey: string | null = null

/** Override the build-time VITE_GOOGLE_MAPS_KEY with a user-supplied key. */
export function setGoogleMapsKey(key: string | null): void {
  runtimeGoogleKey = key && key.trim() ? key.trim() : null
}

function activeGoogleKey(): string | null {
  if (runtimeGoogleKey) return runtimeGoogleKey
  const env = import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined
  return env || null
}

/** Returns true when a Google Maps API key is available (build-time or runtime). */
export function hasGoogleMapsKey(): boolean {
  return !!activeGoogleKey()
}

// ─── Public interface ─────────────────────────────────────────────────────────

export async function getRoute(origin: LatLng, destination: LatLng): Promise<RouteStep[]> {
  const key = activeGoogleKey()
  return key ? getRouteGoogle(origin, destination, key) : getRouteOSRM(origin, destination)
}

export async function geocode(address: string): Promise<{ lat: number; lng: number; label: string }> {
  const key = activeGoogleKey()
  return key ? geocodeGoogle(address, key) : geocodeNominatim(address)
}

// ─── Shared utilities ─────────────────────────────────────────────────────────

// Google Encoded Polyline Algorithm Format decoder (5-decimal places)
function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = []
  let lat = 0, lng = 0, i = 0
  while (i < encoded.length) {
    let chunk = 0, shift = 0, b: number
    do {
      b = encoded.charCodeAt(i++) - 63
      chunk |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 32)
    lat += (chunk & 1) ? ~(chunk >> 1) : (chunk >> 1)

    chunk = 0; shift = 0
    do {
      b = encoded.charCodeAt(i++) - 63
      chunk |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 32)
    lng += (chunk & 1) ? ~(chunk >> 1) : (chunk >> 1)

    points.push([lat / 1e5, lng / 1e5])
  }
  return points
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
}

function parseDuration(dur?: string): number {
  if (!dur) return 0
  return parseInt(dur.replace('s', ''), 10) || 0
}

// ─── Google backend ───────────────────────────────────────────────────────────

async function getRouteGoogle(origin: LatLng, destination: LatLng, key: string): Promise<RouteStep[]> {
  const url = 'https://routes.googleapis.com/directions/v2:computeRoutes'

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Goog-Api-Key':   key,
      'X-Goog-FieldMask':
        'routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,' +
        'routes.legs.steps.staticDuration,routes.legs.steps.startLocation,' +
        'routes.legs.steps.endLocation,routes.legs.steps.polyline.encodedPolyline',
    },
    body: JSON.stringify({
      origin:      { location: { latLng: { latitude: origin.lat,      longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      computeAlternativeRoutes: false,
      languageCode: 'en-US',
      units: 'IMPERIAL',
    }),
  })

  if (!res.ok) throw new Error(`Google Routes API ${res.status}: ${await res.text()}`)

  const data = await res.json()
  const legs: any[] = data?.routes?.[0]?.legs ?? []
  return legs.flatMap((leg: any) => (leg.steps ?? []).map(mapGoogleStep))
}

function mapGoogleStep(step: any): RouteStep {
  return {
    instruction:     stripHtml(step.navigationInstruction?.instructions ?? 'Continue'),
    distanceMeters:  step.distanceMeters ?? 0,
    durationSeconds: parseDuration(step.staticDuration),
    startLat:        step.startLocation?.latLng?.latitude  ?? 0,
    startLng:        step.startLocation?.latLng?.longitude ?? 0,
    endLat:          step.endLocation?.latLng?.latitude  ?? 0,
    endLng:          step.endLocation?.latLng?.longitude ?? 0,
    polylinePoints:  step.polyline?.encodedPolyline
      ? decodePolyline(step.polyline.encodedPolyline)
      : [],
  }
}

async function geocodeGoogle(address: string, key: string): Promise<{ lat: number; lng: number; label: string }> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('key', key)

  const res  = await fetch(url.toString())
  const data = await res.json()

  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocoding failed: ${data.status}`)
  }

  const r = data.results[0]
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, label: r.formatted_address }
}

// ─── OSRM backend (routing) ───────────────────────────────────────────────────
//
// Uses the public Project OSRM demo server — free, no key, OSM data.
// Coordinate order for OSRM is longitude,latitude (GeoJSON).

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving'

async function getRouteOSRM(origin: LatLng, destination: LatLng): Promise<RouteStep[]> {
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`
  const url    = `${OSRM_URL}/${coords}?steps=true&geometries=polyline&overview=false`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`OSRM ${res.status}: ${await res.text()}`)

  const data = await res.json()
  if (data.code !== 'Ok') throw new Error(`OSRM: ${data.message ?? data.code}`)

  const steps: any[] = data.routes?.[0]?.legs?.[0]?.steps ?? []
  return steps.map((step, idx) => mapOsrmStep(step, idx, steps))
}

function formatOsrmInstruction(maneuver: any, name: string): string {
  const type = (maneuver.type  ?? '') as string
  const mod  = (maneuver.modifier ?? '') as string
  const on   = name ? ` onto ${name}` : ''
  const road = name ? ` on ${name}`   : ''

  switch (type) {
    case 'depart':   return `Head ${mod}${road}`
    case 'arrive':   return 'Arrive at destination'
    case 'turn':     return mod === 'straight' ? `Continue straight${road}` : `Turn ${mod}${on}`
    case 'continue': return `Continue${mod && mod !== 'straight' ? ` ${mod}` : ' straight'}${road}`
    case 'new name': return `Continue${road}`
    case 'merge':    return `Merge ${mod}${road}`
    case 'on ramp':
    case 'ramp':     return `Take${mod ? ' ' + mod : ''} ramp${on}`
    case 'off ramp': return `Take exit${on}`
    case 'fork':     return `Keep ${mod || 'straight'}${on}`
    case 'end of road': return `Turn ${mod}${on}`
    case 'use lane': return `Use lane${road}`
    case 'roundabout':
    case 'rotary': {
      const exit = maneuver.exit ? ` (exit ${maneuver.exit})` : ''
      return `Enter roundabout${exit}${on}`
    }
    case 'roundabout turn': return `Turn ${mod} at roundabout${on}`
    default: return name ? `Continue${road}` : 'Continue'
  }
}

function mapOsrmStep(step: any, idx: number, allSteps: any[]): RouteStep {
  // OSRM maneuver.location is [lng, lat]
  const loc   = step.maneuver?.location ?? [0, 0]
  const next  = allSteps[idx + 1]?.maneuver?.location ?? null
  const pts   = decodePolyline(step.geometry ?? '')

  const startLat = loc[1],  startLng = loc[0]
  const endLng   = next ? next[0] : (pts[pts.length - 1]?.[1] ?? loc[0])
  const endLat   = next ? next[1] : (pts[pts.length - 1]?.[0] ?? loc[1])

  return {
    instruction:     formatOsrmInstruction(step.maneuver ?? {}, step.name ?? ''),
    distanceMeters:  step.distance  ?? 0,
    durationSeconds: Math.round(step.duration ?? 0),
    startLat, startLng,
    endLat,   endLng,
    polylinePoints: pts,
  }
}

// ─── Nominatim backend (geocoding) ───────────────────────────────────────────
//
// OpenStreetMap Nominatim — free geocoding, no key required.
// Usage policy: 1 req/s max, User-Agent identifying the app.

async function geocodeNominatim(address: string): Promise<{ lat: number; lng: number; label: string }> {
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', address)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', '1')

  const res  = await fetch(url.toString(), {
    headers: { 'User-Agent': 'G2-Maps-GlassesApp/0.3 (personal navigation)' },
  })
  if (!res.ok) throw new Error(`Nominatim ${res.status}`)

  const data = await res.json()
  if (!data?.length) throw new Error('No results found')

  const r = data[0]
  return {
    lat:   parseFloat(r.lat),
    lng:   parseFloat(r.lon),
    label: r.display_name,
  }
}
