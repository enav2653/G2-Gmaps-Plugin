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

import { getRoute, RouteStep, setGoogleMapsKey, setStadiaKey } from './maps'
import { formatClockTime } from './display'
import { loadSettings, HudSettings, persistGet } from './settings'
import { getSpeedLimitMph, resetSpeedLimitCache } from './speedLimit'
import { renderMinimapBmp, renderCalibrationBmp } from './mapImage'
import { getCachedRoads, refreshRoads } from './roadData'
import {
  buildEventContainer,
  buildBannerContainer,
  buildMinimapImageContainers,
  MAP_TILE_CIDS,
  buildSpeedContainer,
  buildSpeedLabelContainer,
  buildTimeContainer,
  buildBannerText,
  buildSpeedText,
  buildSpeedLabelText,
  buildMediaText,
  buildMediaContainer,
  BANNER_MODES, BannerMode,
  NavState,
  CID,
  MINIMAP_IMG_W,
  MINIMAP_IMG_H,
} from './hud'

// ─── App state ────────────────────────────────────────────────────────────────

let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>
let settings: HudSettings = loadSettings()

// Apply any saved API keys before the first route request
;(function applyPersistedKeys() {
  const gk = persistGet('g2maps_gmaps_key')
  if (gk) setGoogleMapsKey(gk)
  const sk = persistGet('g2maps_stadia_key')
  if (sk) setStadiaKey(sk)
})()

let steps:       RouteStep[] = []
let stepIdx      = 0
let navState:    NavState    = 'passive'
let bannerMode:  BannerMode  = 'always-on'
let bannerModeIdx = 0

let currentLat = 0
let currentLng = 0
let speedMph   = 0
let limitMph:  number | null = null
let speedingStartMs: number | null = null
let limitFlashOn    = true
let limitFlashTimer: ReturnType<typeof setInterval> | null = null
let watchId:    number | null = null
let pageCreated     = false
let buildingPage    = false  // serialises concurrent buildPage calls
let buildPagePending = false  // a call arrived while buildingPage was true

// Cached reference to whichever Android/bridge location method worked
type LocationFix = {
  lat: number
  lng: number
  speedMs?: number
  headingDeg?: number
  mediaTitle?: string
  mediaArtist?: string
  mediaPlaying?: boolean
}
let activeLocationProvider: (() => Promise<LocationFix | null>) | null = null
let locationProviderFailures = 0   // consecutive null returns from activeLocationProvider
let androidPollTimer: ReturnType<typeof setInterval> | null = null
let bridgeScanned = false   // suppress repeated diagnostic logs during retry polls

// Manual step preview (swipe) — null means track navigation step
let previewStepIdx:   number | null = null
let previewResetTimer: ReturnType<typeof setTimeout> | null = null

// Media state — populated from Tasker GPS bridge response
let mediaTitle   = ''
let mediaArtist  = ''
let mediaPlaying = false

// Media marquee — soft scrolling for long title/artist lines
const MEDIA_LINE_W    = 22   // safe character width for media container on G2
const MEDIA_SCROLL_MS = 400  // ms between scroll ticks
const MEDIA_SCROLL_STEP = 2  // characters advanced per tick
let mediaScrollTitle  = 0
let mediaScrollArtist = 0
let mediaMarqueeTimer: ReturnType<typeof setInterval> | null = null

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

// ─── Initial compass calibration (figure-8 motion) ───────────────────────────
// On first run, the user is guided through a figure-8 motion to seed the
// magnetometer and establish good compass accuracy before GPS takes over.
// Coverage is tracked as accumulated absolute change in each sensor axis.
let calActive     = false
let calRot        = 0    // accumulated |Δalpha| — rotation about vertical
let calTilt       = 0    // accumulated |Δbeta|  — forward/back tilt
let calRoll       = 0    // accumulated |Δgamma| — left/right roll
let calLastAlpha  = -1   // -1 = uninitialised
let calLastBeta   = 0
let calLastGamma  = 0
let calDispTimer  = 0    // last display refresh (ms), throttled to 2 Hz
const CAL_ROT_DEG  = 360 // total rotation needed
const CAL_TILT_DEG = 90  // total tilt travel needed
const CAL_ROLL_DEG = 90  // total roll travel needed

// Reroute guard + off-route hysteresis
let rerouteInProgress   = false
let offRouteSamples     = 0    // consecutive polls where we appeared off-route
let lastStepAdvanceTime = 0    // timestamp of the last step index change

// ─── Bridge location probe ────────────────────────────────────────────────────
//
// The Even Hub WebView blocks navigator.geolocation (PERMISSION_DENIED).
// Probe Flutter InAppWebView, Android JS interfaces, and callEvenApp.
// Once a working provider is found it is cached in activeLocationProvider
// so subsequent polls don't re-scan.

function parseLocation(r: any): LocationFix | null {
  if (r == null) return null
  if (typeof r === 'string') {
    try { r = JSON.parse(r) } catch { return null }
  }
  const speedMs     = (r.speed != null && +r.speed >= 0) ? +r.speed : undefined
  const headingDeg  = (r.heading != null && isFinite(+r.heading)) ? +r.heading : undefined
  const mediaTitle  = typeof r.media_title  === 'string' ? r.media_title  : undefined
  const mediaArtist = typeof r.media_artist === 'string' ? r.media_artist : undefined
  const mediaPlaying = r.media_playing === true || r.media_playing === 'true' ? true
    : r.media_playing === false || r.media_playing === 'false' ? false
    : undefined
  if (r.lat != null && r.lng != null)
    return { lat: +r.lat, lng: +r.lng, speedMs, headingDeg, mediaTitle, mediaArtist, mediaPlaying }
  if (r.latitude != null && r.longitude != null)
    return { lat: +r.latitude, lng: +r.longitude, speedMs, headingDeg, mediaTitle, mediaArtist, mediaPlaying }
  return null
}

/** Parse a Response body tolerantly: tries JSON, then strips unsubstituted
 *  Tasker variables (e.g. %LOCSPEED, %LOCBEAR) and retries. */
async function fetchJsonTolerant(res: Response): Promise<any> {
  const text = await res.text()
  try { return JSON.parse(text) } catch { /* fall through */ }
  try { return JSON.parse(text.replace(/%[A-Z0-9_]+/g, 'null')) } catch { return null }
}

async function tryBridgeLocation(): Promise<LocationFix | null> {
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
    const timer = setTimeout(() => ctrl.abort(), 2000)
    const res   = await fetch(GPS_BRIDGE_URL, { signal: ctrl.signal })
    clearTimeout(timer)
    if (res.ok) {
      const loc = parseLocation(await fetchJsonTolerant(res))
      if (loc) {
        reportStatus(`local GPS bridge: OK (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`)
        activeLocationProvider = async () => {
          try {
            const c = new AbortController()
            const t = setTimeout(() => c.abort(), 2000)
            const r = await fetch(GPS_BRIDGE_URL, { signal: c.signal })
            clearTimeout(t)
            return r.ok ? parseLocation(await fetchJsonTolerant(r)) : null
          } catch { return null }
        }
        return loc
      } else {
        reportStatus(`local GPS bridge: reachable but parse failed (status ${res.status})`)
      }
    } else {
      reportStatus(`local GPS bridge: HTTP ${res.status}`)
    }
  } catch (e: any) {
    reportStatus(`local GPS bridge: ${e?.name === 'AbortError' ? 'timeout' : String(e)}`)
  }

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
  const ifaces = ['EvenAppBridge', 'Android', 'EvenApp', 'EvenHub', 'JsBridge', 'AndroidBridge', 'NativeBridge']
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

  reportStatus('bridge probe: no provider found (GPS, Tasker, Flutter, Android all failed)')
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
  if (!loc) {
    // Reset provider after 5 consecutive nulls so the probe re-runs next tick
    if (++locationProviderFailures >= 5) {
      reportStatus('bridge: provider returned null 5x — resetting for re-probe')
      activeLocationProvider = null
      locationProviderFailures = 0
    }
    return
  }
  locationProviderFailures = 0

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
  // Calibrate compass from GPS heading + decay confidence (~1 hr half-life at 2 s poll rate)
  compassBiasCnf *= 0.9996
  calibrateCompassFromGPS()
  prevPollLat = loc.lat; prevPollLng = loc.lng; prevPollTime = now

  currentLat = loc.lat
  currentLng = loc.lng

  // Fetch speed limit — cached by road segment, degrades gracefully on 403
  getSpeedLimitMph(loc.lat, loc.lng).then(l => {
    if (l !== limitMph) { limitMph = l; refreshSpeed() }
  }).catch(() => {})

  // ─── Media state ──────────────────────────────────────────────────────────
  const prevMediaPlaying = mediaPlaying
  const prevMediaTitle   = mediaTitle
  const prevMediaArtist  = mediaArtist
  if (loc.mediaTitle   !== undefined) mediaTitle   = loc.mediaTitle
  if (loc.mediaArtist  !== undefined) mediaArtist  = loc.mediaArtist
  if (loc.mediaPlaying !== undefined) mediaPlaying = loc.mediaPlaying
  const mediaStateChanged = prevMediaPlaying !== mediaPlaying
  const trackChanged = mediaPlaying && !mediaStateChanged &&
    (mediaTitle !== prevMediaTitle || mediaArtist !== prevMediaArtist)
  if (mediaStateChanged) {
    if (mediaPlaying) {
      reportStatus(`media: playing — ${mediaTitle} / ${mediaArtist}`)
      mediaScrollTitle = 0; mediaScrollArtist = 0
      startMediaMarquee()
    } else {
      reportStatus('media: stopped')
      stopMediaMarquee()
    }
  } else if (trackChanged) {
    reportStatus(`media: track — ${mediaTitle} / ${mediaArtist}`)
    mediaScrollTitle = 0; mediaScrollArtist = 0
  }

  if (navState !== 'navigating') {
    if (mediaStateChanged) {
      await buildPage()
    } else {
      await refreshSpeed()
      await refreshMinimap()
      if (mediaPlaying) await refreshMedia()
    }
    updatePollRate()
    return
  }

  // Off-route detection — uses full step polyline for accuracy on curved roads.
  // Requires 2 consecutive off-route readings to avoid triggering on GPS glitches.
  // Suppressed for 5 s after any step advance to avoid false positives at intersections.
  if (!rerouteInProgress && steps[stepIdx] && Date.now() - lastStepAdvanceTime > 5000) {
    const s = steps[stepIdx]
    // Prefer the full decoded polyline; fall back to start→end segment
    const pts: Array<[number, number]> = s.polylinePoints.length >= 2
      ? s.polylinePoints
      : (s.startLat || s.startLng) && (s.endLat || s.endLng)
        ? [[s.startLat, s.startLng], [s.endLat, s.endLng]]
        : []
    if (pts.length >= 2) {
      const offDist = distToPolylineM(loc.lat, loc.lng, pts)
      if (offDist > 200) {
        if (++offRouteSamples >= 2) {
          offRouteSamples = 0
          await reroute()
          return
        }
      } else {
        offRouteSamples = 0
      }
    }
  }

  const newIdx  = advanceStep(loc.lat, loc.lng)
  const stepped = newIdx !== stepIdx
  if (stepped) { lastStepAdvanceTime = Date.now(); offRouteSamples = 0 }
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
    if (mediaStateChanged) {
      await buildPage()
    } else {
      // In-place text update only — live updates without full rebuild
      await refreshBanner()
      await refreshTime()
      await refreshSpeed()
      await refreshMinimap()
      if (mediaPlaying) await refreshMedia()
    }
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

// ─── Figure-8 calibration ─────────────────────────────────────────────────────

/** Feed one orientation sample into the calibration tracker.
 *  Called from startCompass() for every sensor event while calActive=true. */
function updateCalibration(alpha: number, beta: number, gamma: number) {
  if (!calActive) return

  if (calLastAlpha >= 0) {
    let da = Math.abs(alpha - calLastAlpha)
    if (da > 180) da = 360 - da          // handle 0°/360° wrap
    calRot  += da
    calTilt += Math.abs(beta  - calLastBeta)
    calRoll += Math.abs(gamma - calLastGamma)
  }
  calLastAlpha = alpha; calLastBeta = beta; calLastGamma = gamma

  const rotPct  = Math.min(1, calRot  / CAL_ROT_DEG)
  const tiltPct = Math.min(1, calTilt / CAL_TILT_DEG)
  const rollPct = Math.min(1, calRoll / CAL_ROLL_DEG)

  // Throttle display to 2 Hz — bridge can't keep up with sensor rate
  const now = Date.now()
  if (now - calDispTimer > 500) {
    calDispTimer = now
    void refreshCalibrationDisplay(rotPct, tiltPct, rollPct)
  }

  if (rotPct >= 1 && tiltPct >= 1 && rollPct >= 1) finishCalibration()
}

async function refreshCalibrationDisplay(rotPct: number, tiltPct: number, rollPct: number) {
  if (!pageCreated) return
  try {
    const pct = Math.round((rotPct + tiltPct + rollPct) / 3 * 100)
    const bannerText = pct >= 100
      ? 'Compass Calibrated  ✓  Accuracy improves as you drive'
      : `Compass Cal  ${pct}%  –  Wave phone in figure-8 pattern`
    await bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: CID.BANNER, containerName: 'banner', content: bannerText,
    }))

    const imageData = renderCalibrationBmp(rotPct, tiltPct, rollPct, MINIMAP_IMG_W, MINIMAP_IMG_H)
    await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID:   MAP_TILE_CIDS[0],
      containerName: 'minimap',
      imageData,
    }))
  } catch { /* bridge not ready yet */ }
}

async function startCalibration() {
  calActive = true; calRot = calTilt = calRoll = 0; calLastAlpha = -1
  navState = 'calibrating'
  await buildPage()
  await refreshCalibrationDisplay(0, 0, 0)
}

async function finishCalibration() {
  if (!calActive) return
  calActive = false
  localStorage.setItem('g2maps_compass_cal', '1')
  await refreshCalibrationDisplay(1, 1, 1)
  await new Promise(r => setTimeout(r, 2000))  // show "Done" briefly
  navState = 'passive'
  await buildPage()
  await refreshMinimap()
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

// ─── Media marquee helpers ────────────────────────────────────────────────────

/** Returns a MEDIA_LINE_W-char window into text, scrolled by offset.
 *  If text fits, returns it unchanged (no scroll needed). */
function mediaWindow(text: string, offset: number): string {
  if (text.length <= MEDIA_LINE_W) return text
  const padded = text + '    '   // gap before loop-back
  const len    = padded.length
  const start  = offset % len
  return (padded + padded).slice(start, start + MEDIA_LINE_W)
}

function startMediaMarquee() {
  if (mediaMarqueeTimer) return
  mediaMarqueeTimer = setInterval(() => {
    if (!mediaPlaying || !pageCreated) return
    let changed = false
    if (mediaTitle.length > MEDIA_LINE_W) {
      mediaScrollTitle = (mediaScrollTitle + MEDIA_SCROLL_STEP) % (mediaTitle.length + 4)
      changed = true
    }
    if (mediaArtist.length > MEDIA_LINE_W) {
      mediaScrollArtist = (mediaScrollArtist + MEDIA_SCROLL_STEP) % (mediaArtist.length + 4)
      changed = true
    }
    if (changed) refreshMedia().catch(() => {})
  }, MEDIA_SCROLL_MS)
}

function stopMediaMarquee() {
  if (mediaMarqueeTimer) { clearInterval(mediaMarqueeTimer); mediaMarqueeTimer = null }
}

/** Minimum distance in metres from a point to any segment in a polyline. */
function distToPolylineM(lat: number, lng: number, pts: Array<[number, number]>): number {
  if (pts.length === 0) return Infinity
  if (pts.length === 1) return haversine(lat, lng, pts[0][0], pts[0][1])
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToSegmentM(lat, lng, pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1])
    if (d < best) best = d
  }
  return best
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
 *  Fixed 30 m radius — purely maneuver-based, not speed-scaled.
 *  Capped at 40% of the step's own length so very short ramp/interchange
 *  steps don't trigger prematurely. */
function advanceStep(lat: number, lng: number): number {
  for (let i = stepIdx; i < steps.length - 1; i++) {
    const s = steps[i]
    if (!s.endLat && !s.endLng) continue  // missing coordinates — skip
    const threshold = Math.min(30, s.distanceMeters * 0.4)
    if (haversine(lat, lng, s.endLat, s.endLng) < threshold) return i + 1
  }
  return stepIdx
}

// ─── Rerouting ────────────────────────────────────────────────────────────────

/** Project a point distM metres from (lat, lng) along headingDeg. */
function projectPoint(lat: number, lng: number, headingDeg: number, distM: number): { lat: number; lng: number } {
  const R  = 6371000
  const δ  = distM / R
  const θ  = headingDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lng * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: φ2 * 180 / Math.PI, lng: λ2 * 180 / Math.PI }
}

async function reroute() {
  if (rerouteInProgress) return
  rerouteInProgress = true
  reportStatus('off route — rerouting…')
  try {
    const raw = sessionStorage.getItem('g2maps_destination')
    if (!raw) return
    const dest = JSON.parse(raw) as { lat: number; lng: number }

    // Project 150 m ahead in the current travel direction so the router
    // doesn't immediately send us back to the missed turn.
    const heading = gpsHeadingDeg ?? deviceHeadingDeg
    const origin  = (heading !== null && speedMph > 5)
      ? projectPoint(currentLat, currentLng, heading, 150)
      : { lat: currentLat, lng: currentLng }

    steps   = await getRoute(origin, dest, settings.route)
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
let minimapPendingRefresh = false   // re-render queued while a render was in-flight
let lastMinimapBytes: number[] | null = null

const MINIMAP_ZOOM = 14  // fixed — passive-mode level; dynamic zoom caused thrashing

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
    const bannerContent = buildBannerText(steps, esi, navState, liveDistM, settings.clock?.use24h)
    const speedContent  = buildSpeedText(speedMph, limitMph, settings, limitFlashOn)
    const speedLblText  = buildSpeedLabelText(settings, limitMph, limitFlashOn)

    const textContainers: TextContainerProperty[] = [buildEventContainer()]
    if (bannerMode !== 'always-off') textContainers.push(buildBannerContainer(bannerContent))
    const speedLblContainer = buildSpeedLabelContainer(speedLblText, settings)
    if (speedLblContainer) textContainers.push(speedLblContainer)
    const speedContainer = buildSpeedContainer(speedContent, settings)
    if (speedContainer) textContainers.push(speedContainer)
    if (mediaPlaying) {
      const mediaContainer = buildMediaContainer(buildMediaText(
        mediaWindow(mediaTitle,  mediaScrollTitle),
        mediaWindow(mediaArtist, mediaScrollArtist),
      ))
      if (mediaContainer) textContainers.push(mediaContainer)
    }
    textContainers.push(buildTimeContainer(formatClockTime(undefined, settings.clock?.use24h)))

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
  const content = buildBannerText(steps, esi, navState, liveDistM, settings.clock?.use24h)
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID:   CID.BANNER,
    containerName: 'banner',
    content,
    contentOffset: 0,
    contentLength: content.length,
  }))
}

async function refreshTime() {
  const content = formatClockTime(undefined, settings.clock?.use24h)
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID:   CID.CLOCK,
    containerName: 'clock',
    content,
    contentOffset: 0,
    contentLength: content.length,
  }))
}

function startLimitFlash() {
  if (limitFlashTimer !== null) return
  limitFlashTimer = setInterval(() => {
    limitFlashOn = !limitFlashOn
    refreshSpeed()
  }, 500)
}

function stopLimitFlash() {
  if (limitFlashTimer !== null) { clearInterval(limitFlashTimer); limitFlashTimer = null }
  limitFlashOn = true
}

function updateLimitFlash() {
  const overLimit = limitMph !== null && speedMph > limitMph
  if (overLimit) {
    if (speedingStartMs === null) speedingStartMs = Date.now()
    if (Date.now() - speedingStartMs >= 5000) startLimitFlash()
  } else {
    speedingStartMs = null
    stopLimitFlash()
  }
}

async function refreshSpeed() {
  if (!settings.speed.visible) return
  updateLimitFlash()
  const lblContent = buildSpeedLabelText(settings, limitMph, limitFlashOn)
  const valContent = buildSpeedText(speedMph, limitMph, settings, limitFlashOn)
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID:   CID.SPEED_LBL,
    containerName: 'spd_lbl',
    content:       lblContent,
    contentOffset: 0,
    contentLength: lblContent.length,
  }))
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID:   CID.SPEED,
    containerName: 'speed',
    content:       valContent,
    contentOffset: 0,
    contentLength: valContent.length,
  }))
}

async function refreshMedia() {
  if (!mediaPlaying) return
  const content = buildMediaText(
    mediaWindow(mediaTitle,  mediaScrollTitle),
    mediaWindow(mediaArtist, mediaScrollArtist),
  )
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID:   CID.MEDIA,
    containerName: 'media',
    content,
    contentOffset: 0,
    contentLength: content.length,
  }))
}

async function refreshMinimap() {
  if (navState === 'calibrating') return
  if (!settings.minimap.visible || !pageCreated) return
  if (!currentLat && !currentLng) return
  if (minimapRefreshing) {
    minimapPendingRefresh = true   // re-render once current one finishes
    return
  }

  minimapRefreshing = true
  minimapPendingRefresh = false
  try {
    // Kick off a background road-data refresh (non-blocking; uses cached data this frame)
    refreshRoads(currentLat, currentLng, MINIMAP_ZOOM, MINIMAP_IMG_W, MINIMAP_IMG_H).catch(() => {})

    const imageData = renderMinimapBmp(
      currentLat, currentLng, steps, effectiveStepIdx(),
      MINIMAP_IMG_W, MINIMAP_IMG_H, MINIMAP_ZOOM,
      getCachedRoads(),
      activeHeadingDeg(),
    )
    lastMinimapBytes = imageData
    const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID:   MAP_TILE_CIDS[0],
      containerName: 'minimap',
      imageData,
    }))
    reportStatus(`minimap: ${imageData.length}B → ${JSON.stringify(result)}`)
  } catch (e) {
    reportStatus(`minimap: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    minimapRefreshing = false
    // If a rebuild happened while we were rendering, fire another pass now
    if (minimapPendingRefresh) refreshMinimap().catch(() => {})
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
        await refreshTime()
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
// DeviceOrientationEvent.alpha gives absolute compass heading (0°=N, clockwise)
// on Android WebViews. Used when speed < 5 mph; GPS position-delta heading is
// used at speed. A GPS-learned bias offset corrects the magnetometer over time.

function startCompass() {
  // Circular EMA: smooth sin+cos independently, recover angle with atan2.
  // Handles 0°/360° wrap correctly. alpha=0.1 matches original 0.2.78 behaviour.
  const ALPHA = 0.1
  let compassFired      = false
  let lastRefreshHeading = -1

  const onOrientation = (e: DeviceOrientationEvent) => {
    if (e.alpha === null) return
    // alpha follows W3C convention: positive = CCW. Convert to CW compass bearing.
    const rad = (360 - e.alpha) * Math.PI / 180
    deviceHeadingSin = ALPHA * Math.sin(rad) + (1 - ALPHA) * deviceHeadingSin
    deviceHeadingCos = ALPHA * Math.cos(rad) + (1 - ALPHA) * deviceHeadingCos
    deviceHeadingDeg = ((Math.atan2(deviceHeadingSin, deviceHeadingCos) * 180 / Math.PI) + 360) % 360

    if (!compassFired) {
      compassFired = true
      reportStatus(`compass: first event alpha=${e.alpha.toFixed(1)}°`)
    }
  }
  // deviceorientationabsolute is always compass-referenced on Android
  window.addEventListener('deviceorientationabsolute', onOrientation as EventListener, true)
  // deviceorientation as fallback (may be relative on some browsers)
  window.addEventListener('deviceorientation',         onOrientation as EventListener, true)

  // Compass-driven minimap refresh — update the map whenever heading changes ≥ 1°,
  // independently of the GPS poll rate. Capped at ~10 Hz by the 100 ms interval.
  // minimapRefreshing guard prevents concurrent renders from queuing up.
  setInterval(() => {
    if (deviceHeadingDeg === null || speedMph >= 5) return
    let diff = Math.abs(deviceHeadingDeg - lastRefreshHeading)
    if (diff > 180) diff = 360 - diff
    if (diff >= 1) {
      lastRefreshHeading = deviceHeadingDeg
      refreshMinimap().catch(() => {})
    }
  }, 100)

  // iOS 13+ requires explicit permission
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
    // Tap/swipe events arrive as sysEvent on G2 hardware; textEvent is a fallback.
    const eventObj  = event.sysEvent ?? event.textEvent
    const eventType = eventObj?.eventType
    const channel   = event.sysEvent ? 'sys' : event.textEvent ? 'txt' : 'none'

    reportStatus(`ev type=${eventType ?? 'undef'} ch=${channel}`)

    switch (eventType) {

      // Foreground resume
      case OsEventTypeList.FOREGROUND_ENTER_EVENT: {
        refreshBanner()
        refreshSpeed()
        refreshMinimap()
        if (mediaPlaying) refreshMedia()
        return
      }

      // Single tap — cycle banner mode / resume from pause
      case OsEventTypeList.CLICK_EVENT:
      case undefined: {
        if (!eventObj) return  // no event data — ignore
        if (navState === 'paused') {
          navState = 'navigating'
          await buildPage()
          return
        }
        bannerModeIdx = (bannerModeIdx + 1) % BANNER_MODES.length
        bannerMode    = BANNER_MODES[bannerModeIdx]
        await buildPage()
        break
      }

      // Double tap — invoke the standard EvenHub exit dialog from any state
      case OsEventTypeList.DOUBLE_CLICK_EVENT: {
        reportStatus('double-tap: calling shutDownPageContainer(1)')
        try {
          const ok = await bridge.shutDownPageContainer(1)
          reportStatus(`shutDown result: ${ok}`)
        } catch (err) {
          reportStatus(`exit dialog error: ${String(err)}`)
        }
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
  stopLimitFlash()
  resetSpeedLimitCache()
  limitMph = null
  steps    = []
  stepIdx  = 0
  navState = 'idle'
  sessionStorage.removeItem('g2maps_destination')
  await buildPage()
}

/** Go to passive mode and clear the route so the minimap doesn't show a stale line. */
export async function menuGoPassive() {  if (navState === 'passive') return
  navState = 'passive'
  steps   = []
  stepIdx = 0
  stopGPS()
  stopAndroidPoll()
  await buildPage()
}

// ─── Settings hot-reload (called when user saves settings on phone) ───────────

/** Returns raw device compass heading (degrees, 0 = north, CW) or null if unavailable. */
export function getDeviceHeading(): number | null {
  return deviceHeadingDeg
}

/** Returns the current GPS position, or null if no fix yet. */
export function getCurrentLocation(): { lat: number; lng: number } | null {
  if (!currentLat && !currentLng) return null
  return { lat: currentLat, lng: currentLng }
}

/** Manual north calibration: call when phone is physically pointing north.
 *  Sets compassBias so corrected = 0 at the current sensor reading. */
export async function calibrateCompassManual(): Promise<void> {
  if (deviceHeadingDeg === null) {
    reportStatus('compass: no sensor data — move phone first')
    return
  }
  let bias = -deviceHeadingDeg
  if (bias < -180) bias += 360
  if (bias >  180) bias -= 360
  compassBias    = bias
  compassBiasCnf = 1
  reportStatus(`compass: manual cal — bias ${compassBias.toFixed(1)}°`)
  refreshMinimap().catch(() => {})
}

/** Live snapshot of all HUD display state — used by the phone Preview tab. */
export function getHudState() {
  const esi       = effectiveStepIdx()
  const liveDistM = navState === 'navigating' && steps[esi]
    ? haversine(currentLat, currentLng, steps[esi].endLat, steps[esi].endLng)
    : undefined
  return {
    bannerText:     buildBannerText(steps, esi, navState, liveDistM, settings.clock?.use24h),
    bannerVisible:  bannerMode !== 'always-off',
    speedText:      buildSpeedText(speedMph, limitMph, settings, limitFlashOn),
    speedVisible:   settings.speed.visible,
    mediaText:      mediaPlaying ? buildMediaText(mediaTitle, mediaArtist) : '',
    mediaPlaying,
    minimapVisible: settings.minimap.visible,
    minimapBytes:   lastMinimapBytes as number[] | null,
  }
}

export async function reloadSettings() {
  settings = loadSettings()
  await buildPage()
}

// ─── Navigation start ─────────────────────────────────────────────────────────

export async function startNavigation() {
  stopGPS()
  stopAndroidPoll()
  stopLimitFlash()
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

  try {
    // Always probe Android/bridge — sets activeLocationProvider for live polling
    reportStatus('probing Android location…')
    const bridgeLoc = await tryBridgeLocation()

    if (bridgeLoc) {
      currentLat = bridgeLoc.lat
      currentLng = bridgeLoc.lng
      reportStatus(`android GPS: ${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`)
    } else {
      // Fall back to WebView geolocation
      reportStatus('trying WebView GPS…')
      try {
        const pos = await new Promise<GeolocationPosition>((res, rej) => {
          const timer = setTimeout(() => rej(new Error('GPS timed out')), 5000)
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
        navState = 'idle'
        await buildPage()
        return
      }
    }

    reportStatus('fetching route…')
    steps   = await getRoute({ lat: currentLat, lng: currentLng }, { lat: dest.lat, lng: dest.lng }, settings.route)
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



  await buildPage()

  // Start passive GPS immediately — probe the Android bridge first, fall back
  // to WebView geolocation.  startNavigation() calls stop* before taking over,
  // so this won't interfere with a later navigation session.
  // Always start the poll loop; if Tasker isn't running yet, it retries every 2 s.
  tryBridgeLocation()
    .then(async loc => {
      if (loc) {
        currentLat = loc.lat
        currentLng = loc.lng
        if (loc.mediaTitle   !== undefined) mediaTitle   = loc.mediaTitle
        if (loc.mediaArtist  !== undefined) mediaArtist  = loc.mediaArtist
        if (loc.mediaPlaying !== undefined) mediaPlaying = loc.mediaPlaying
        if (mediaPlaying) {
          reportStatus(`media: playing — ${mediaTitle} / ${mediaArtist}`)
          await buildPage()
        }
      }
      startAndroidPoll()
      if (!loc) startGPS()   // parallel fallback — harmless if Tasker picks up later
    })
    .catch(() => { startAndroidPoll(); startGPS() })

  // Listen for phone-side events
  window.addEventListener('g2maps:navigate',  () => startNavigation())
  window.addEventListener('g2maps:settings',  () => reloadSettings())
  window.addEventListener('g2maps:pause',     () => menuPauseResume())
  window.addEventListener('g2maps:passive',   () => menuPassiveMode())
  window.addEventListener('g2maps:end',       () => menuGoPassive())
}

init()
