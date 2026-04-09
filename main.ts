import {
  waitForEvenAppBridge,
  OsEventTypeList,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'

import { getRoute, RouteStep } from './maps'
import { renderMapText } from './mapText'
import { loadSettings, HudSettings } from './settings'
import { getSpeedLimitMph, resetSpeedLimitCache } from './speedLimit'
import {
  buildEventContainer,
  buildBannerContainer,
  buildMinimapTextContainer,
  buildSpeedContainer,
  buildBannerText,
  buildSpeedText,
  BANNER_MODES, BannerMode,
  NavState,
  CID,
} from './hud'

// ─── App state ────────────────────────────────────────────────────────────────

let bridge: Awaited<ReturnType<typeof waitForEvenAppBridge>>
let settings: HudSettings = loadSettings()

let steps:       RouteStep[] = []
let stepIdx      = 0
let navState:    NavState    = 'idle'
let bannerMode:  BannerMode  = 'always-on'
let bannerModeIdx = 0

let currentLat = 0
let currentLng = 0
let speedMph   = 0
let limitMph:  number | null = null
let watchId:    number | null = null
let pageCreated  = false
let buildingPage = false  // serialises concurrent buildPage calls

// Cached reference to whichever Android/bridge location method worked
let activeLocationProvider: (() => Promise<{ lat: number; lng: number; speedMs?: number } | null>) | null = null
let androidPollTimer: ReturnType<typeof setInterval> | null = null

// Manual step preview (swipe) — null means track navigation step
let previewStepIdx:   number | null = null
let previewResetTimer: ReturnType<typeof setTimeout> | null = null

// Speed calculation from consecutive position fixes
let prevPollLat  = 0
let prevPollLng  = 0
let prevPollTime = 0

// Reroute guard
let rerouteInProgress = false

// ─── Bridge location probe ────────────────────────────────────────────────────
//
// The Even Hub WebView blocks navigator.geolocation (PERMISSION_DENIED).
// Probe Flutter InAppWebView, Android JS interfaces, and callEvenApp.
// Once a working provider is found it is cached in activeLocationProvider
// so subsequent polls don't re-scan.

function parseLocation(r: any): { lat: number; lng: number; speedMs?: number } | null {
  if (r == null) return null
  if (typeof r === 'string') {
    try { r = JSON.parse(r) } catch { return null }
  }
  const speedMs = (r.speed != null && +r.speed >= 0) ? +r.speed : undefined
  if (r.lat != null && r.lng != null)            return { lat: +r.lat,      lng: +r.lng, speedMs }
  if (r.latitude != null && r.longitude != null) return { lat: +r.latitude, lng: +r.longitude, speedMs }
  return null
}

async function tryBridgeLocation(): Promise<{ lat: number; lng: number } | null> {
  // If we already found a working provider, use it directly
  if (activeLocationProvider) return activeLocationProvider()

  // Log visible bridge-related window properties for diagnostics
  const bridgeKeys = Object.keys(window).filter(k =>
    /android|bridge|even|flutter|native|webkit/i.test(k)
  )
  reportStatus(`window bridge keys: [${bridgeKeys.join(', ')}]`)

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
      const loc = parseLocation(await res.json())
      if (loc) {
        reportStatus(`local GPS bridge: OK (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`)
        activeLocationProvider = async () => {
          try {
            const c = new AbortController()
            const t = setTimeout(() => c.abort(), 800)
            const r = await fetch(GPS_BRIDGE_URL, { signal: c.signal })
            clearTimeout(t)
            return r.ok ? parseLocation(await r.json()) : null
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
  if (!activeLocationProvider) return
  const loc = await activeLocationProvider()
  if (!loc) return

  const now = Date.now()

  // Speed — prefer GPS-reported m/s from Tasker (%LOCSPEED); fall back to position delta
  if (loc.speedMs != null) {
    speedMph = loc.speedMs * 2.23694
  } else if (prevPollTime > 0 && (prevPollLat || prevPollLng)) {
    const distM = haversine(prevPollLat, prevPollLng, loc.lat, loc.lng)
    const dtSec = (now - prevPollTime) / 1000
    if (dtSec >= 0.1 && dtSec < 30) {
      const sample = distM / dtSec * 2.23694
      if (sample < 200) speedMph = speedMph * 0.7 + sample * 0.3
    }
  }
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
  if (!activeLocationProvider) return
  const ms = pollIntervalMs()
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

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a    = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
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

/** Advance past any step whose endpoint we've entered (80 m threshold). */
function advanceStep(lat: number, lng: number): number {
  for (let i = stepIdx; i < steps.length - 1; i++) {
    const s = steps[i]
    if (!s.endLat && !s.endLng) continue  // missing coordinates — skip
    if (haversine(lat, lng, s.endLat, s.endLng) < 80) return i + 1
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

// ─── Text minimap ─────────────────────────────────────────────────────────────
//
// ASCII character grid rendered by renderMapText.
// Uses the same TextContainerProperty path as banner + speed — no image
// upload, no imageException possible.
//
// Characters: . background  ~ future route  - current step  > turn  @ position
// mpc (metres per character column) controls zoom level.

const MAP_COLS = 22
const MAP_ROWS = 8

function buildMinimapContent(): string {
  if (!settings.minimap.visible) return ''
  const distM = distToManeuverM()
  const mpc   = distM < 400 ? 15 : distM < 1600 ? 30 : distM < 5000 ? 60 : 100
  return renderMapText(currentLat, currentLng, steps, effectiveStepIdx(), MAP_COLS, MAP_ROWS, mpc)
}

// ─── Full page build ──────────────────────────────────────────────────────────
//
// All containers are TextContainerProperty — no image upload, no imageException.

async function buildPage() {
  if (buildingPage) {
    reportStatus('buildPage: queued (dropping duplicate)')
    return
  }
  buildingPage = true
  try {
    const esi       = effectiveStepIdx()
    const liveDistM = navState === 'navigating' && steps[esi]
      ? haversine(currentLat, currentLng, steps[esi].endLat, steps[esi].endLng)
      : undefined
    const bannerContent = buildBannerText(steps, esi, navState, bannerMode, liveDistM)
    const speedContent  = buildSpeedText(speedMph, limitMph, settings)
    const mapContent    = buildMinimapContent()

    const containers: TextContainerProperty[] = [buildEventContainer()]
    if (bannerMode !== 'always-off') containers.push(buildBannerContainer(bannerContent))
    const mapContainer = buildMinimapTextContainer(mapContent, settings)
    if (mapContainer) containers.push(mapContainer)
    const speedContainer = buildSpeedContainer(speedContent, settings)
    if (speedContainer) containers.push(speedContainer)

    const containerData = {
      containerTotalNum: containers.length,
      textObject:        containers,
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
  } finally {
    buildingPage = false
  }
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
  if (!settings.minimap.visible) return
  const content = buildMinimapContent()
  if (!content) return
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID:   CID.MAP,
    containerName: 'minimap',
    content,
    contentOffset: 0,
    contentLength: content.length,
  }))
}

// ─── GPS watch ────────────────────────────────────────────────────────────────

function startGPS() {
  if (!navigator.geolocation) return
  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng, speed } = pos.coords
      currentLat = lat
      currentLng = lng
      speedMph   = speed != null ? speed * 2.23694 : speedMph

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

// ─── IMU — heading tracking ───────────────────────────────────────────────────
// Disabled: headingDeg is not currently used in any display output.
// Re-enable when minimap heading rotation is implemented.

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

  // Listen for phone-side events
  window.addEventListener('g2maps:navigate',  () => startNavigation())
  window.addEventListener('g2maps:settings',  () => reloadSettings())
  window.addEventListener('g2maps:pause',     () => menuPauseResume())
  window.addEventListener('g2maps:passive',   () => menuPassiveMode())
  window.addEventListener('g2maps:end',       () => menuEndNavigation())
}

init()
