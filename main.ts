import {
  waitForEvenAppBridge,
  OsEventTypeList,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  TextContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
} from '@evenrealities/even_hub_sdk'

import { getRoute, RouteStep } from './maps'
import { loadSettings, HudSettings } from './settings'
import { getSpeedLimitMph, resetSpeedLimitCache } from './speedLimit'
import { renderMinimapBmpTiles } from './mapImage'
import { getCachedRoads, refreshRoads } from './roadData'
import {
  buildEventContainer,
  buildBannerContainer,
  buildMinimapImageContainers,
  MAP_TILE_CIDS,
  MINIMAP_TILE_W,
  MINIMAP_TILE_H,
  buildSpeedContainer,
  buildBannerText,
  buildSpeedText,
  BANNER_MODES, BannerMode,
  NavState,
  CID,
  MINIMAP_IMG_W,
  MINIMAP_IMG_H,
} from './hud'

// ─── App state ────────────────────────────────────────────────────────────────

let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>
let settings: HudSettings = loadSettings()

let steps:       RouteStep[] = []
let stepIdx      = 0
let navState:    NavState    = 'passive'
let bannerMode:  BannerMode  = 'always-on'
let bannerModeIdx = 0

let currentLat = 0
let currentLng = 0
let speedMph   = 0
let limitMph:  number | null = null
let watchId:    number | null = null
let pageCreated     = false
let buildingPage    = false  // serialises concurrent buildPage calls
let buildPagePending = false  // a call arrived while buildingPage was true

// Cached reference to whichever Android/bridge location method worked
let activeLocationProvider: (() => Promise<{ lat: number; lng: number; speedMs?: number; headingDeg?: number } | null>) | null = null
let androidPollTimer: ReturnType<typeof setInterval> | null = null
let bridgeScanned = false   // suppress repeated diagnostic logs during retry polls

// Manual step preview (swipe) — null means track navigation step
let previewStepIdx:   number | null = null
let previewResetTimer: ReturnType<typeof setTimeout> | null = null

// Speed calculation from consecutive position fixes
let prevPollLat  = 0
let prevPollLng  = 0
let prevPollTime = 0

// Heading — GPS bearing (when moving) or device compass (when slow/stationary)
let gpsHeadingDeg:    number | null = null
let deviceHeadingDeg: number | null = null
// Circular EMA state for compass smoothing (sin/cos components, initialised north)
let deviceHeadingSin = 0
let deviceHeadingCos = 1
// Compass bias calibration: GPS-learned offset corrects the magnetometer when stationary.
// compassBias  = EMA of (gpsHeading − deviceHeading) while speed ≥ 5 mph
// compassBiasCnf grows toward 1 as GPS calibrates; decays ~1 hr half-life without updates.
let compassBias    = 0
let compassBiasCnf = 0

// Reroute guard
let rerouteInProgress = false

// ─── Bridge location probe ────────────────────────────────────────────────────
//
// The Even Hub WebView blocks navigator.geolocation (PERMISSION_DENIED).
// Probe Flutter InAppWebView, Android JS interfaces, and callEvenApp.
// Once a working provider is found it is cached in activeLocationProvider
// so subsequent polls don't re-scan.

function parseLocation(r: any): { lat: number; lng: number; speedMs?: number; headingDeg?: number } | null {
  if (r == null) return null
  if (typeof r === 'string') {
    try { r = JSON.parse(r) } catch { return null }
  }
  const speedMs = (r.speed != null && +r.speed >= 0) ? +r.speed : undefined
  // Accept heading/bearing/course; Tasker %LOCBEAR returns -1 when unavailable
  const rawHdg = r.heading ?? r.bearing ?? r.course
  const headingDeg = rawHdg != null && !isNaN(+rawHdg) && +rawHdg >= 0 ? +rawHdg : undefined
  if (r.lat != null && r.lng != null)            return { lat: +r.lat,      lng: +r.lng, speedMs, headingDeg }
  if (r.latitude != null && r.longitude != null) return { lat: +r.latitude, lng: +r.longitude, speedMs, headingDeg }
  return null
}

/** Parse a Response body tolerantly: tries JSON, then strips unsubstituted
 *  Tasker variables (e.g. %LOCSPEED, %LOCBEAR) and retries. */
async function fetchJsonTolerant(res: Response): Promise<any> {
  const text = await res.text()
  try { return JSON.parse(text) } catch { /* fall through */ }
  try { return JSON.parse(text.replace(/%[A-Z0-9_]+/g, 'null')) } catch { return null }
}

async function tryBridgeLocation(): Promise<{ lat: number; lng: number } | null> {
  // If we already found a working provider, use it directly
  if (activeLocationProvider) return activeLocationProvider()

  // Log visible bridge-related window properties — once only to avoid status spam
  if (!bridgeScanned) {
    bridgeScanned = true
    const bridgeKeys = Object.keys(window).filter(k =>
      /android|bridge|even|flutter|native|webkit/i.test(k)
    )
    reportStatus(`window bridge keys: [${bridgeKeys.join(', ')}]`)
  }

  // --- 0. Local GPS bridge — Tasker HTTP server or companion app ----------
  //
  // Tasker setup (5.9+):
  //   Task "GPS Server":
  //     Net → HTTP Server → Start, Port 7272
  //     Net → HTTP Server → Response, Path /location
  //       Body: {"lat":%LOC1,"lng":%LOC2,"speed":%LOCSPEED}
  //   (Variable Split %LOC on comma gives %LOC1=lat, %LOC2=lng; %LOCSPEED is m/s)
  //   Run this task on profile entry (e.g. App: Even Hub)
  //
  // Expected response: {"lat": 37.123, "lng": -122.456, "speed": 13.4}
  //                 or {"latitude": 37.123, "longitude": -122.456}
  //
  const GPS_BRIDGE_URL = 'http://127.0.0.1:7272/location'
  try {
    const ctrl  = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 800)
    const res   = await fetch(GPS_BRIDGE_URL, { signal: ctrl.signal })
    clearTimeout(timer)
    if (res.ok) {
      const loc = parseLocation(await fetchJsonTolerant(res))
      if (loc) {
        reportStatus(`local GPS bridge: OK (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`)
        activeLocationProvider = async () => {
          try {
            const c = new AbortController()
            const t = setTimeout(() => c.abort(), 800)
            const r = await fetch(GPS_BRIDGE_URL, { signal: c.signal })
            clearTimeout(t)
            return r.ok ? parseLocation(await fetchJsonTolerant(r)) : null
          } catch { return null }
        }
        return loc
      }
    }
  } catch { /* server not running */ }

  // --- 1. Flutter InAppWebView callHandler ---
  const fwv = (window as any).flutter_inappwebview
  if (fwv?.callHandler) {
    for (const method of ['getLocation', 'getCurrentLocation', 'getGpsLocation', 'getPosition']) {
      try {
        const r   = await fwv.callHandler(method)
        const loc = parseLocation(r)
        if (loc) {
          reportStatus(`flutter_inappwebview.${method}: OK`)
          activeLocationProvider = async () => {
            try { return parseLocation(await fwv.callHandler(method)) } catch { return null }
          }
          return loc
        }
      } catch { }
    }
  }

  // --- 2. Android addJavascriptInterface objects ---
  const ifaces = ['Android', 'EvenApp', 'EvenHub', 'JsBridge', 'AndroidBridge', 'NativeBridge']
  for (const name of ifaces) {
    const obj = (window as any)[name]
    if (obj == null) continue
    reportStatus(`found window.${name}`)
    for (const method of ['getLocation', 'getCurrentLocation', 'getGpsLocation', 'getLatLng', 'getPosition']) {
      if (typeof obj[method] !== 'function') continue
      try {
        const r   = obj[method]()
        const loc = parseLocation(r)
        if (loc) {
          reportStatus(`window.${name}.${method}(): OK`)
          activeLocationProvider = () => {
            try { return Promise.resolve(parseLocation(obj[method]())) } catch { return Promise.resolve(null) }
          }
          return loc
        }
      } catch { }
    }
  }

  // --- 3. SDK callEvenApp (undocumented method names) ---
  for (const method of ['getLocation', 'getCurrentLocation', 'getGpsLocation', 'getPosition', 'location']) {
    try {
      const r   = await bridge.callEvenApp(method)
      const loc = parseLocation(r)
      if (loc) {
        reportStatus(`callEvenApp(${method}): OK`)
        activeLocationProvider = async () => {
          try { return parseLocation(await bridge.callEvenApp(method)) } catch { return null }
        }
        return loc
      }
    } catch { }
  }

  return null
}

// ─── Adaptive poll rate ───────────────────────────────────────────────────────
//
// Poll more frequently as we approach the next maneuver.
// Distances in metres; times in ms.

function pollIntervalMs(): number {
  const d = distToManeuverM()
  if (d <   400) return  250   // < 0.25 mi
  if (d <  1600) return  500   // < 1 mi
  if (d <  8000) return 1000   // < 5 mi
  return 3000                  // >= 5 mi
}

function updatePollRate() {
  if (!activeLocationProvider) return
  const ms = pollIntervalMs()
  stopAndroidPoll()
  androidPollTimer = setInterval(pollLocation, ms)
}

// ─── Android location polling ─────────────────────────────────────────────────

async function pollLocation() {
  if (!activeLocationProvider) {
    // Silently retry until Tasker HTTP server comes online
    await tryBridgeLocation()
    if (!activeLocationProvider) return
    // Provider just came online — switch to adaptive poll rate
    updatePollRate()
  }
  const loc = await activeLocationProvider()
  if (!loc) return

  const now = Date.now()

  // Speed + GPS bearing from position delta (always computed when we have a prev fix)
  if (prevPollTime > 0 && (prevPollLat || prevPollLng)) {
    const distM = haversine(prevPollLat, prevPollLng, loc.lat, loc.lng)
    if (loc.speedMs != null) {
      speedMph = loc.speedMs * 2.23694
    } else {
      const dtSec = (now - prevPollTime) / 1000
      if (dtSec >= 0.1 && dtSec < 30) {
        const sample = distM / dtSec * 2.23694
        if (sample < 200) speedMph = speedMph * 0.7 + sample * 0.3
      }
    }
    // Position-delta bearing as fallback when Tasker doesn't supply heading
    if (loc.headingDeg == null && distM > 5)
      gpsHeadingDeg = bearing(prevPollLat, prevPollLng, loc.lat, loc.lng)
  } else if (loc.speedMs != null) {
    speedMph = loc.speedMs * 2.23694
  }
  // Tasker %LOCBEAR — GPS hardware heading, accurate at all speeds
  if (loc.headingDeg != null) gpsHeadingDeg = loc.headingDeg
  // Calibrate compass from GPS heading + decay confidence (~1 hr half-life at 2 s poll rate)
  compassBiasCnf *= 0.9996
  calibrateCompassFromGPS()
  prevPollLat = loc.lat; prevPollLng = loc.lng; prevPollTime = now

  currentLat = loc.lat
  currentLng = loc.lng

  if (navState !== 'navigating') {
    await refreshSpeed()
    await refreshMinimap()
    updatePollRate()
    return
  }

  // Off-route detection — only when step has valid coordinates
  if (!rerouteInProgress && steps[stepIdx]) {
    const s = steps[stepIdx]
    if ((s.startLat || s.startLng) && (s.endLat || s.endLng)) {
      const offDist = distToSegmentM(loc.lat, loc.lng, s.startLat, s.startLng, s.endLat, s.endLng)
      if (offDist > 150) {
        await reroute()
        return
      }
    }
  }

  const newIdx  = advanceStep(loc.lat, loc.lng)
  const stepped = newIdx !== stepIdx
  stepIdx = newIdx

  if (stepIdx >= steps.length) {
    navState = 'idle'
    steps    = []
    previewStepIdx = null
    stopAndroidPoll()
    await buildPage()
    return
  }

  // Update adaptive rate now that distance may have changed
  updatePollRate()

  if (!stepped) {
    // In-place text update only — live updates without full rebuild
    await refreshBanner()
    await refreshSpeed()
    await refreshMinimap()
    return
  }

  // Step changed — cancel any manual preview and rebuild
  previewStepIdx = null
  if (previewResetTimer) { clearTimeout(previewResetTimer); previewResetTimer = null }
  await buildPage()
}

function startAndroidPoll() {
  stopAndroidPoll()
  // Always start the interval — pollLocation will retry finding Tasker each tick
  // if activeLocationProvider is still null.
  const ms = activeLocationProvider ? pollIntervalMs() : 2000
  reportStatus(`android poll: started (${ms} ms)`)
  androidPollTimer = setInterval(pollLocation, ms)
}

function stopAndroidPoll() {
  if (androidPollTimer) { clearInterval(androidPollTimer); androidPollTimer = null }
}

// ─── Step position tracking ───────────────────────────────────────────────────
//
// GPS is blocked in Even Hub WebView. Instead, update currentLat/currentLng
// from the route step coordinates whenever the step changes.

function syncPositionFromStep() {
  const step = steps[stepIdx]
  if (!step) return
  if (step.startLat && step.startLng) {
    currentLat = step.startLat
    currentLng = step.startLng
  }
}

async function changeStep(newIdx: number) {
  previewStepIdx = newIdx
  // Auto-return to navigation step after 10 s of no further input
  if (previewResetTimer) clearTimeout(previewResetTimer)
  previewResetTimer = setTimeout(async () => {
    previewStepIdx   = null
    previewResetTimer = null
    await buildPage()
  }, 10_000)
  await buildPage()
}

// ─── GPS helpers ──────────────────────────────────────────────────────────────

/** Bearing in degrees clockwise from north, from point 1 → point 2. */
function gpsHeading(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δλ = (lng2 - lng1) * Math.PI / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a    = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}

/** Bearing from (lat1, lng1) → (lat2, lng2), 0° = north, clockwise. */
function bearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const phi1 = lat1 * Math.PI / 180
  const phi2 = lat2 * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const x = Math.sin(dLng) * Math.cos(phi2)
  const y = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng)
  return ((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360
}

/**
 * When GPS heading is reliable (speed ≥ 5 mph), learn the offset between GPS and
 * the device compass so we can correct the compass at lower speeds / when stationary.
 * Uses circular EMA so 0°/360° boundaries don't create jumps.
 */
function calibrateCompassFromGPS() {
  if (gpsHeadingDeg === null || deviceHeadingDeg === null || speedMph < 5) return
  let diff = gpsHeadingDeg - deviceHeadingDeg
  if (diff >  180) diff -= 360
  if (diff < -180) diff += 360
  compassBias    = 0.15 * diff + 0.85 * compassBias
  compassBiasCnf = Math.min(1, compassBiasCnf + 0.1)
}

/**
 * Active map heading: GPS bearing when speed ≥ 5 mph, GPS-calibrated compass otherwise.
 * When moving, the observed GPS−compass offset is stored as a bias. At lower speeds the
 * bias is applied to the compass reading (dead-reckoning from last known good heading).
 * Confidence [0,1] blends raw→corrected so the correction fades if GPS was long ago.
 * Returns 0 (north-up) when neither source is available.
 */
function activeHeadingDeg(): number {
  if (speedMph >= 5 && gpsHeadingDeg !== null) return gpsHeadingDeg
  if (deviceHeadingDeg !== null) {
    if (compassBiasCnf <= 0) return deviceHeadingDeg
    // Corrected heading = deviceHeading + bias; blend toward raw at low confidence
    const corrected = ((deviceHeadingDeg + compassBias) % 360 + 360) % 360
    const c   = compassBiasCnf
    const cR  = corrected * Math.PI / 180
    const rR  = deviceHeadingDeg * Math.PI / 180
    const sinH = c * Math.sin(cR) + (1 - c) * Math.sin(rR)
    const cosH = c * Math.cos(cR) + (1 - c) * Math.cos(rR)
    return ((Math.atan2(sinH, cosH) * 180 / Math.PI) + 360) % 360
  }
  return 0
}

/** Distance from a point to a line segment, in metres. */
function distToSegmentM(
  lat: number, lng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const cosLat = Math.cos(aLat * Math.PI / 180)
  const px = (lng  - aLng) * cosLat, py = lat  - aLat
  const dx = (bLng - aLng) * cosLat, dy = bLat - aLat
  const len2 = dx*dx + dy*dy
  const t    = len2 > 0 ? Math.max(0, Math.min(1, (px*dx + py*dy) / len2)) : 0
  return haversine(lat, lng, aLat + t*dy, aLng + t*(bLng - aLng))
}

/** Metres from current position to the end of the current route step. */
function distToManeuverM(): number {
  const step = steps[stepIdx]
  if (!step || (!currentLat && !currentLng)) return Infinity
  if (!step.endLat && !step.endLng) return Infinity
  return haversine(currentLat, currentLng, step.endLat, step.endLng)
}

/** Which step to DISPLAY — may differ from stepIdx when user is previewing. */
function effectiveStepIdx(): number {
  return previewStepIdx ?? stepIdx
}

/** Advance past any step whose endpoint we've entered.
 *  Threshold scales with speed to keep roughly 15 s of lookahead:
 *    20 mph → ~134 m   40 mph → ~268 m   60 mph → ~402 m
 *  Minimum 120 m so the step still advances promptly when nearly stopped. */
function advanceStep(lat: number, lng: number): number {
  const threshold = Math.max(120, speedMph * 6.7)  // 6.7 ≈ 15 s × 0.447 (mph→m/s)
  for (let i = stepIdx; i < steps.length - 1; i++) {
    const s = steps[i]
    if (!s.endLat && !s.endLng) continue  // missing coordinates — skip
    if (haversine(lat, lng, s.endLat, s.endLng) < threshold) return i + 1
  }
  return stepIdx
}

// ─── Rerouting ────────────────────────────────────────────────────────────────

async function reroute() {
  if (rerouteInProgress) return
  rerouteInProgress = true
  reportStatus('off route — rerouting…')
  try {
    const raw = sessionStorage.getItem('g2maps_destination')
    if (!raw) return
    const dest = JSON.parse(raw) as { lat: number; lng: number }
    steps   = await getRoute({ lat: currentLat, lng: currentLng }, dest)
    stepIdx = 0
    previewStepIdx = null
    reportStatus(`rerouted: ${steps.length} steps`)
    await buildPage()
  } catch (e) {
    reportStatus(`reroute failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    rerouteInProgress = false
  }
}

// ─── Vector minimap ───────────────────────────────────────────────────────────
//
// Pure pixel renderer — draws route polylines on a dark background,
// encodes as PNG, uploads via updateImageRawData.  No API calls.

let minimapRefreshing = false

function minimapZoom(): number {
  const d = distToManeuverM()
  if (d <   400) return 17
  if (d <  1600) return 16
  if (d <  5000) return 15
  return 14
}

// ─── Full page build ──────────────────────────────────────────────────────────

async function buildPage() {
  if (buildingPage) {
    buildPagePending = true   // will re-run with latest state once current build finishes
    return
  }
  do {
    buildPagePending = false
    buildingPage = true
  try {
    const esi       = effectiveStepIdx()
    const liveDistM = navState === 'navigating' && steps[esi]
      ? haversine(currentLat, currentLng, steps[esi].endLat, steps[esi].endLng)
      : undefined
    const bannerContent = buildBannerText(steps, esi, navState, bannerMode, liveDistM)
    const speedContent  = buildSpeedText(speedMph, limitMph, settings)

    const textContainers: TextContainerProperty[] = [buildEventContainer()]
    if (bannerMode !== 'always-off') textContainers.push(buildBannerContainer(bannerContent))
    const speedContainer = buildSpeedContainer(speedContent, settings)
    if (speedContainer) textContainers.push(speedContainer)

    const imageContainers: ImageContainerProperty[] = [
      ...buildMinimapImageContainers(settings),
    ]

    const containerData = {
      containerTotalNum: textContainers.length + imageContainers.length,
      textObject:        textContainers,
      imageObject:       imageContainers,
    }

    if (!pageCreated) {
      const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(containerData))
      pageCreated = true
      reportStatus(`create: ${JSON.stringify(result)}`)
    } else {
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(containerData))
      reportStatus(`rebuild: ${ok}`)
      if (!ok) {
        pageCreated = false
        const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(containerData))
        pageCreated = true
        reportStatus(`recreate: ${JSON.stringify(result)}`)
      }
    }

    // Image containers are empty after every create/rebuild — repopulate immediately
    // rather than waiting for the next position poll (which would leave a blank gap).
    refreshMinimap().catch(() => {})

  } finally {
    buildingPage = false
  }
  } while (buildPagePending)
}

// ─── In-place banner update (fast, no flicker) ────────────────────────────────

async function refreshBanner() {
  if (bannerMode === 'always-off') return
  const esi       = effectiveStepIdx()
  const liveDistM = navState === 'navigating' && steps[esi]
    ? haversine(currentLat, currentLng, steps[esi].endLat, steps[esi].endLng)
    : undefined
  const content = buildBannerText(steps, esi, navState, bannerMode, liveDistM)
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID:   CID.BANNER,
    containerName: 'banner',
    content,
    contentOffset: 0,
    contentLength: content.length,
  }))
}

async function refreshSpeed() {
  if (!settings.speed.visible) return
  const content = buildSpeedText(speedMph, limitMph, settings)
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID:   CID.SPEED,
    containerName: 'speed',
    content,
    contentOffset: 0,
    contentLength: content.length,
  }))
}

async function refreshMinimap() {
  if (!settings.minimap.visible || !pageCreated) return
  if (!currentLat && !currentLng) return
  if (minimapRefreshing) return

  minimapRefreshing = true
  try {
    // Kick off a background road-data refresh (non-blocking; uses cached data this frame)
    refreshRoads(currentLat, currentLng, minimapZoom(), MINIMAP_IMG_W, MINIMAP_IMG_H).catch(() => {})

    const tiles = renderMinimapBmpTiles(
      currentLat, currentLng, steps, effectiveStepIdx(),
      MINIMAP_IMG_W, MINIMAP_IMG_H, MINIMAP_TILE_W, MINIMAP_TILE_H, minimapZoom(),
      getCachedRoads(),
      activeHeadingDeg(),
    )
    const results = await Promise.all(tiles.map((tileData, i) =>
      bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID:   MAP_TILE_CIDS[i],
        containerName: `minimap_${i % 2}_${Math.floor(i / 2)}`,
        imageData:     tileData,
      }))
    ))
    reportStatus(`minimap: ${tiles[0].length}B×${tiles.length} → ${JSON.stringify(results)}`)
  } catch (e) {
    reportStatus(`minimap: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    minimapRefreshing = false
  }
}

// ─── GPS watch ────────────────────────────────────────────────────────────────

function startGPS() {
  if (!navigator.geolocation) return
  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng, speed, heading } = pos.coords
      currentLat = lat
      currentLng = lng
      speedMph   = speed != null ? speed * 2.23694 : speedMph
      if (heading != null && !isNaN(heading) && speed != null && speed > 2)
        gpsHeadingDeg = heading
      compassBiasCnf *= 0.9996
      calibrateCompassFromGPS()

      // Fetch speed limit in parallel — cached by place ID so usually instant
      const newLimit   = await getSpeedLimitMph(lat, lng)
      const limitChanged = newLimit !== limitMph
      limitMph = newLimit

      if (navState !== 'navigating') {
        await refreshSpeed()
        return
      }

      const newIdx = advanceStep(lat, lng)
      const stepped = newIdx !== stepIdx
      stepIdx = newIdx
      if (stepped) syncPositionFromStep()

      if (stepIdx >= steps.length) {
        navState = 'idle'
        steps    = []
        await buildPage()
        return
      }

      if (!stepped) {
        // Same step — refresh text in-place
        await refreshBanner()
        await refreshSpeed()
        await refreshMinimap()
        return
      }

      // Step changed — rebuild page
      await buildPage()
    },
    (err) => console.error('GPS error', err),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 5000 },
  )
}

function stopGPS() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId)
    watchId = null
  }
}

// ─── Compass heading ──────────────────────────────────────────────────────────
//
// Primary: AbsoluteOrientationSensor (Generic Sensor API) — backed by Android's
// TYPE_ROTATION_VECTOR fusion (accel + gyro + mag), the same pipeline as the
// Android Fused Orientation Provider. Returns quaternion → tilt-compensated heading.
// Fallback: DeviceOrientationEvent.alpha (used when sensor API unavailable).

/**
 * Extract tilt-compensated compass heading (0°=N, clockwise) from an
 * AbsoluteOrientationSensor quaternion [qx, qy, qz, qw].
 *
 * Works for any phone orientation by blending two reference axes:
 *   flat    → heading of device Y (top of phone) in world horizontal plane
 *   upright → heading of device −Z (back camera) in world horizontal plane
 * The blend is continuous, driven by how vertical the Y axis has become.
 */
function quaternionToHeading(qx: number, qy: number, qz: number, qw: number): number {
  // World-frame East/North of device Y axis (top of phone)
  const yEast  = 2 * (qx*qy - qw*qz)
  const yNorth = 1 - 2 * (qx*qx + qz*qz)
  const yUp    = 2 * (qy*qz + qw*qx)   // 1 = phone flat, 0 = phone upright

  // World-frame East/North of device −Z axis (back camera / forward when upright)
  const nzEast  = -(2 * (qx*qz + qw*qy))
  const nzNorth = -(2 * (qy*qz - qw*qx))

  // Continuously blend: flatness=1 → Y formula, flatness=0 → −Z formula
  const flatness = Math.abs(yUp)
  const hY  = Math.atan2(yEast,  yNorth)
  const hNZ = Math.atan2(nzEast, nzNorth)

  // Circular average handles 0°/360° wrap cleanly
  const sinH = flatness * Math.sin(hY)  + (1 - flatness) * Math.sin(hNZ)
  const cosH = flatness * Math.cos(hY)  + (1 - flatness) * Math.cos(hNZ)
  return ((Math.atan2(sinH, cosH) * 180 / Math.PI) + 360) % 360
}

function startCompass() {
  const ALPHA = 0.15

  function applyCompassReading(rawDeg: number) {
    const rad = rawDeg * Math.PI / 180
    deviceHeadingSin = ALPHA * Math.sin(rad) + (1 - ALPHA) * deviceHeadingSin
    deviceHeadingCos = ALPHA * Math.cos(rad) + (1 - ALPHA) * deviceHeadingCos
    deviceHeadingDeg = ((Math.atan2(deviceHeadingSin, deviceHeadingCos) * 180 / Math.PI) + 360) % 360
  }

  function startDeviceOrientationFallback() {
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.alpha === null) return
      applyCompassReading(e.alpha)
    }
    // deviceorientationabsolute is always compass-referenced on Android
    window.addEventListener('deviceorientationabsolute', onOrientation as EventListener, true)
    // deviceorientation as fallback (may be relative on some browsers)
    window.addEventListener('deviceorientation',         onOrientation as EventListener, true)
  }

  // Try AbsoluteOrientationSensor first (Chrome 67+, Generic Sensor API)
  if (typeof (window as any).AbsoluteOrientationSensor !== 'undefined') {
    Promise.all([
      navigator.permissions.query({ name: 'accelerometer' as PermissionName }),
      navigator.permissions.query({ name: 'gyroscope'     as PermissionName }),
      navigator.permissions.query({ name: 'magnetometer'  as PermissionName }),
    ]).then(results => {
      if (results.some(r => r.state === 'denied')) {
        startDeviceOrientationFallback()
        return
      }
      try {
        const sensor = new (window as any).AbsoluteOrientationSensor({ frequency: 30 })
        sensor.addEventListener('reading', () => {
          const [qx, qy, qz, qw] = sensor.quaternion as [number, number, number, number]
          applyCompassReading(quaternionToHeading(qx, qy, qz, qw))
        })
        sensor.addEventListener('error', () => startDeviceOrientationFallback())
        sensor.start()
      } catch {
        startDeviceOrientationFallback()
      }
    }).catch(() => startDeviceOrientationFallback())
  } else {
    startDeviceOrientationFallback()
  }

  // iOS 13+ requires explicit permission for DeviceOrientationEvent (fallback path)
  const DOE = DeviceOrientationEvent as any
  if (typeof DOE.requestPermission === 'function') {
    DOE.requestPermission()
      .then((s: string) => { if (s !== 'granted') reportStatus('compass: iOS permission denied') })
      .catch(() => {})
  }
}

// ─── Touchpad input ───────────────────────────────────────────────────────────

function setupInput() {
  bridge.onEvenHubEvent(async event => {
    const e = event.textEvent
    if (!e) return

    switch (e.eventType) {

      // Single tap — cycle banner mode
      case OsEventTypeList.CLICK_EVENT:
      case undefined: {
        if (navState === 'paused') {
          // Tap to resume from paused state
          navState = 'navigating'
          await buildPage()
          return
        }
        bannerModeIdx = (bannerModeIdx + 1) % BANNER_MODES.length
        bannerMode    = BANNER_MODES[bannerModeIdx]
        await buildPage()
        break
      }

      // Double tap — open menu (rendered on phone side, result sent back via sessionStorage event)
      case OsEventTypeList.DOUBLE_CLICK_EVENT: {
        // Signal the phone UI to show the menu
        window.dispatchEvent(new CustomEvent('g2maps:showmenu'))
        break
      }

      // Swipe up — previous step (manual preview)
      case OsEventTypeList.SCROLL_TOP_EVENT: {
        const cur = effectiveStepIdx()
        if (!steps.length || cur <= 0) break
        await changeStep(cur - 1)
        break
      }

      // Swipe down — next step (manual preview)
      case OsEventTypeList.SCROLL_BOTTOM_EVENT: {
        const cur = effectiveStepIdx()
        if (!steps.length || cur >= steps.length - 1) break
        await changeStep(cur + 1)
        break
      }
    }
  })
}

// ─── Menu actions (called from phone UI) ─────────────────────────────────────

export async function menuPauseResume() {
  if (navState === 'paused') {
    navState = 'navigating'
    if (activeLocationProvider) { startAndroidPoll() } else { startGPS() }
  } else {
    navState = 'paused'
    stopGPS()
    stopAndroidPoll()
  }
  await buildPage()
}

export async function menuPassiveMode() {
  if (navState !== 'passive') {
    navState = 'passive'
    stopGPS()
    await buildPage()
    return
  }

  // Return to navigation if we have a route
  navState = steps.length ? 'navigating' : 'idle'
  if (navState === 'navigating') startGPS()
  await buildPage()
}

export async function menuEndNavigation() {
  stopGPS()
  stopAndroidPoll()
  resetSpeedLimitCache()
  limitMph = null
  steps    = []
  stepIdx  = 0
  navState = 'idle'
  sessionStorage.removeItem('g2maps_destination')
  sessionStorage.removeItem('g2maps_origin')
  await buildPage()
}

// ─── Settings hot-reload (called when user saves settings on phone) ───────────

export async function reloadSettings() {
  settings = loadSettings()
  await buildPage()
}

// ─── Navigation start ─────────────────────────────────────────────────────────

export async function startNavigation() {
  stopGPS()
  stopAndroidPoll()
  resetSpeedLimitCache()
  limitMph = null

  const raw = sessionStorage.getItem('g2maps_destination')
  if (!raw) {
    navState = 'idle'
    await buildPage()
    return
  }

  navState = 'navigating'
  await buildPage()

  const dest   = JSON.parse(raw) as { lat: number; lng: number; label: string }
  const rawOrg = sessionStorage.getItem('g2maps_origin')

  try {
    // Always probe Android/bridge — sets activeLocationProvider for live polling
    // even when an origin address is already known.
    reportStatus('probing Android location…')
    const bridgeLoc = await tryBridgeLocation()

    if (rawOrg) {
      // Use typed origin as starting point (more reliable than live GPS for routing)
      const org  = JSON.parse(rawOrg) as { lat: number; lng: number; label: string }
      currentLat = org.lat
      currentLng = org.lng
      reportStatus(`origin: ${org.label}`)
      if (bridgeLoc) reportStatus('android GPS active for live tracking')
    } else if (bridgeLoc) {
      currentLat = bridgeLoc.lat
      currentLng = bridgeLoc.lng
      reportStatus(`android GPS: ${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`)
    } else {
      // Fall back to WebView geolocation (blocked in Even Hub — prompts user to set origin)
      reportStatus('trying WebView GPS…')
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) => {
          const timer = setTimeout(() => rej(new Error('GPS timed out — enter a starting address')), 5000)
          navigator.geolocation.getCurrentPosition(
            p => { clearTimeout(timer); res(p) },
            e => { clearTimeout(timer); rej(new Error(`GPS error ${e.code}: ${e.message}`)) },
            { enableHighAccuracy: false },
          )
        })
        currentLat = pos.coords.latitude
        currentLng = pos.coords.longitude
        reportStatus(`WebView GPS: ${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`)
      } catch (gpsErr) {
        reportStatus(`GPS failed: ${gpsErr instanceof Error ? gpsErr.message : String(gpsErr)}`)
        reportStatus('enter a starting address to navigate')
        navState = 'idle'
        await buildPage()
        return
      }
    }

    reportStatus('fetching route…')
    steps   = await getRoute({ lat: currentLat, lng: currentLng }, { lat: dest.lat, lng: dest.lng })
    stepIdx = 0
    reportStatus(`route: ${steps.length} steps`)

    if (!steps.length) {
      navState = 'idle'
      await buildPage()
      return
    }

    // Use step 0's start coordinates (more precise than geocoded address)
    syncPositionFromStep()

    await buildPage()

    // Prefer Android location polling when available; fall back to WebView GPS
    if (activeLocationProvider) {
      startAndroidPoll()
    } else {
      startGPS()
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    reportStatus(`nav error: ${msg}`)
    navState = 'idle'
    await buildPage()
    throw err
  }
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

function reportStatus(msg: string) {
  console.warn('[G2Maps]', msg)
  window.dispatchEvent(new CustomEvent('g2maps:status', { detail: msg }))
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

async function init() {
  bridge = await waitForEvenAppBridge()

  setupInput()
  startCompass()

  bridge.onEvenHubEvent(event => {
    const sys = event.sysEvent
    if (!sys) return
    if (sys.eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      refreshBanner()
      refreshSpeed()
      refreshMinimap()
    }
  })

  await buildPage()

  // Start passive GPS immediately — probe the Android bridge first, fall back
  // to WebView geolocation.  startNavigation() calls stop* before taking over,
  // so this won't interfere with a later navigation session.
  // Always start the poll loop; if Tasker isn't running yet, it retries every 2 s.
  tryBridgeLocation()
    .then(loc => {
      if (loc) { currentLat = loc.lat; currentLng = loc.lng }
      startAndroidPoll()
      if (!loc) startGPS()   // parallel fallback — harmless if Tasker picks up later
    })
    .catch(() => { startAndroidPoll(); startGPS() })

  // Listen for phone-side events
  window.addEventListener('g2maps:navigate',  () => startNavigation())
  window.addEventListener('g2maps:settings',  () => reloadSettings())
  window.addEventListener('g2maps:pause',     () => menuPauseResume())
  window.addEventListener('g2maps:passive',   () => menuPassiveMode())
  window.addEventListener('g2maps:end',       () => menuEndNavigation())
}

init()
