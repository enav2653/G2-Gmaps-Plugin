// ─── Background road data (OpenStreetMap Overpass API) ───────────────────────
//
// Fetches driveable road geometry for the current viewport and caches it.
// Refreshes only when the map centre drifts more than 30% of the viewport
// half-width — typically every few hundred metres at navigation zoom levels.
let _roads = [];
let _cacheLat = NaN;
let _cacheLng = NaN;
let _cacheHalf = 0;
let _fetching = false;
export function getCachedRoads() {
    return _roads;
}
export async function refreshRoads(lat, lng, zoom, imgW, imgH) {
    if (_fetching)
        return;
    // Compute viewport size in degrees (same formula as the renderer)
    const METERS_PER_DEG = 111320;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const mpp = 2 * Math.PI * 6378137 * cosLat / (256 * Math.pow(2, zoom));
    const halfWDeg = (imgW / 2 * mpp) / (cosLat * METERS_PER_DEG);
    const halfHDeg = (imgH / 2 * mpp) / METERS_PER_DEG;
    // Skip if the centre hasn't drifted enough to matter
    const drift = Math.max(Math.abs(lat - _cacheLat), Math.abs(lng - _cacheLng));
    if (!isNaN(_cacheLat) && drift < _cacheHalf * 0.3)
        return;
    _fetching = true;
    try {
        const margin = 1.5; // fetch 50% beyond the visible viewport in each direction
        const s = lat - halfHDeg * margin;
        const n = lat + halfHDeg * margin;
        const w = lng - (halfWDeg / cosLat) * margin;
        const e = lng + (halfWDeg / cosLat) * margin;
        const query = `[out:json][bbox:${s},${w},${n},${e}];way["highway"];out geom;`;
        const resp = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query),
        });
        if (!resp.ok)
            return;
        const data = await resp.json();
        _roads = (data.elements ?? [])
            .filter((el) => el.type === 'way' && (el.geometry?.length ?? 0) >= 2)
            .map((el) => el.geometry.map((pt) => [pt.lat, pt.lon]));
        _cacheLat = lat;
        _cacheLng = lng;
        _cacheHalf = Math.max(halfWDeg, halfHDeg);
    }
    catch {
        // silently keep stale data on network error
    }
    finally {
        _fetching = false;
    }
}
