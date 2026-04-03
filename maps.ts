const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY as string

export interface LatLng {
  lat: number
  lng: number
}

export interface RouteStep {
  instruction: string
  distanceMeters: number
  durationSeconds: number
  endLat: number
  endLng: number
}

export async function getRoute(origin: LatLng, destination: LatLng): Promise<RouteStep[]> {
  const url = 'https://routes.googleapis.com/directions/v2:computeRoutes'

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': MAPS_KEY,
      'X-Goog-FieldMask':
        'routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,routes.legs.steps.endLocation',
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

  if (!res.ok) throw new Error(`Routes API ${res.status}: ${await res.text()}`)

  const data = await res.json()
  const legs: any[] = data?.routes?.[0]?.legs ?? []
  return legs.flatMap((leg: any) => (leg.steps ?? []).map(mapStep))
}

function mapStep(step: any): RouteStep {
  return {
    instruction:     stripHtml(step.navigationInstruction?.instructions ?? 'Continue'),
    distanceMeters:  step.distanceMeters ?? 0,
    durationSeconds: parseDuration(step.staticDuration),
    endLat:          step.endLocation?.latLng?.latitude  ?? 0,
    endLng:          step.endLocation?.latLng?.longitude ?? 0,
  }
}

export async function geocode(address: string): Promise<{ lat: number; lng: number; label: string }> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('key', MAPS_KEY)

  const res  = await fetch(url.toString())
  const data = await res.json()

  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocoding failed: ${data.status}`)
  }

  const r = data.results[0]
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, label: r.formatted_address }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
}

function parseDuration(dur?: string): number {
  if (!dur) return 0
  return parseInt(dur.replace('s', ''), 10) || 0
}
