import {
  waitForEvenAppBridge,
  OsEventTypeList,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  ImageRawDataUpdate,
  TextContainerUpgrade,
  TextContainerProperty,
  ImageContainerProperty,
} from '@evenrealities/even_hub_sdk'

import { getRoute, RouteStep } from './maps'
import { renderMapPixels } from './mapDraw'
import { loadSettings, HudSettings } from './settings'
import { getSpeedLimitMph, resetSpeedLimitCache } from './speedLimit'
import {
  buildEventContainer,
  buildBannerContainer,
  buildMinimapContainer,
  buildSpeedContainer,
  buildBannerText,
  buildSpeedText,
  applyBrightness,
  minimapDims,
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
let mapRefreshTimer: ReturnType<typeof setInterval> | null = null
let pageCreated  = false
let buildingPage = false  // serialises concurrent buildPage calls

// Cached reference to whichever Android/bridge location method worked
let activeLocationProvider: (() => Promise<{ lat: number; lng: number } | null>) | null = null
let androidPollTimer: ReturnType<typeof setInterval> | null = null

// ─── Bridge location probe ────────────────────────────────────────────────────
//
// The Even Hub WebView blocks navigator.geolocation (PERMISSION_DENIED).
// Probe Flutter InAppWebView, Android JS interfaces, and callEvenApp.
// Once a working provider is found it is cached in activeLocationProvider
// so subsequent polls don't re-scan.

function parseLocation(r: any): { lat: number; lng: number } | null {
  if (r == null) return null
  if (typeof r === 'string') {
    try { r = JSON.parse(r) } catch { return null }
  }
  if (r.lat != null && r.lng != null)            return { lat: +r.lat,      lng: +r.lng }
  if (r.latitude != null && r.longitude != null) return { lat: +r.latitude, lng: +r.longitude }
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
  //       Body: {"lat":%LOC,"lng":%LOCLNG}
  //   Run this task on profile entry (e.g. App: Even Hub)
  //
  // Expected response: {"lat": 37.123, "lng": -122.456}
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

// ─── Android location polling ─────────────────────────────────────────────────
//
// Once a working provider is found, poll it every 3 s to keep
// currentLat/currentLng live and auto-advance route steps.

async function pollLocation() {
  if (!activeLocationProvider) return
  const loc = await activeLocationProvider()
  if (!loc) return

  currentLat = loc.lat
  currentLng = loc.lng

  if (navState !== 'navigating') {
    await refreshSpeed()
    return
  }

  const newIdx  = advanceStep(loc.lat, loc.lng)
  const stepped = newIdx !== stepIdx
  stepIdx = newIdx

  if (stepIdx >= steps.length) {
    navState = 'idle'
    steps    = []
    stopAndroidPoll()
    await buildPage(null)
    return
  }

  if (!stepped) {
    await refreshBanner()
    await refreshSpeed()
    return
  }

  // Step changed — rebuild with fresh minimap
  syncPositionFromStep()
  const mapBytes = await fetchMinimap()
  await buildPage(mapBytes)
}

function startAndroidPoll() {
  stopAndroidPoll()
  if (!activeLocationProvider) return
  reportStatus('android poll: started (3 s)')
  androidPollTimer = setInterval(pollLocation, 3000)
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
  stepIdx = newIdx
  syncPositionFromStep()
  const mapBytes = await fetchMinimap()
  await buildPage(mapBytes)
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

function advanceStep(lat: number, lng: number): number {
  for (let i = stepIdx; i < steps.length - 1; i++) {
    if (haversine(lat, lng, steps[i].endLat, steps[i].endLng) < 30) return i + 1
  }
  return stepIdx
}

// ─── Map image fetch + brightness ────────────────────────────────────────────

async function fetchMinimap(): Promise<number[] | null> {
  if (!settings.minimap.visible) return null
  try {
    const { w, h } = minimapDims(settings)
    reportStatus(`minimap draw: ${currentLat.toFixed(4)},${currentLng.toFixed(4)} ${w}x${h}`)
    let pixels = await renderMapPixels({
      lat: currentLat, lng: currentLng,
      steps, stepIdx,
      widthPx: w, heightPx: h,
    })
    const br = settings.minimap.brightness / 100
    if (br < 1) pixels = applyBrightness(pixels, br)
    return pixels
  } catch (e) {
    reportStatus(`minimap error: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// ─── Full page build ──────────────────────────────────────────────────────────
//
// Called on first load, step change, settings change, or state change.
// Tears down and rebuilds all containers.

async function buildPage(mapBytes: number[] | null = null) {
  // Serialise concurrent calls — an overlapping rebuildPageContainer followed
  // by updateImageRawData from a different call causes imageException.
  if (buildingPage) {
    reportStatus('buildPage: queued (dropping duplicate)')
    return
  }
  buildingPage = true
  try {
    const bannerContent = buildBannerText(steps, stepIdx, navState, bannerMode)
    const speedContent  = buildSpeedText(speedMph, limitMph, settings)

    const textContainers: TextContainerProperty[] = [buildEventContainer()]
    const imageContainers: ImageContainerProperty[] = []

    if (bannerMode !== 'always-off') {
      textContainers.push(buildBannerContainer(bannerContent))
    }

    const mapContainer = buildMinimapContainer(settings)
    if (mapContainer) imageContainers.push(mapContainer)

    const speedContainer = buildSpeedContainer(speedContent, settings)
    if (speedContainer) textContainers.push(speedContainer)

    const containerData = {
      containerTotalNum: textContainers.length + imageContainers.length,
      textObject:        textContainers,
      imageObject:       imageContainers.length ? imageContainers : undefined,
    }

    if (!pageCreated) {
      const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer(containerData))
      pageCreated = true
      reportStatus(`create: ${JSON.stringify(result)}`)
    } else {
      const ok = await bridge.rebuildPageContainer(new RebuildPageContainer(containerData))
      reportStatus(`rebuild: ${ok}`)
    }

    // Upload map image immediately after its matching container build (no gaps)
    if (!mapContainer || !mapBytes) {
      reportStatus(`skip upload: container=${!!mapContainer} bytes=${!!mapBytes}`)
      return
    }
    const imgResult = await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID:   CID.MAP,
      containerName: 'minimap',
      imageData:     mapBytes,
    }))
    reportStatus(`minimap upload: ${JSON.stringify(imgResult)}`)
  } finally {
    buildingPage = false
  }
}

// ─── In-place banner update (fast, no flicker) ────────────────────────────────

async function refreshBanner() {
  if (bannerMode === 'always-off') return
  const content = buildBannerText(steps, stepIdx, navState, bannerMode)
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
        const mapBytes = await fetchMinimap()
        await buildPage(mapBytes)
        return
      }

      if (!stepped) {
        // Same step — refresh text in-place
        await refreshBanner()
        await refreshSpeed()   // speed number + limit both live here
        return
      }

      // Step changed — rebuild page with fresh minimap
      const mapBytes = await fetchMinimap()
      await buildPage(mapBytes)
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

// ─── Minimap rotation refresh (every 5s) ─────────────────────────────────────
//
// The map image doesn't auto-rotate — we re-fetch periodically so the
// map stays roughly centred on current position.
// Heading rotation is applied server-side via the Static Maps `heading` param.

function startMapRefresh() {
  stopMapRefresh()
  mapRefreshTimer = setInterval(async () => {
    if (navState === 'idle') return
    const mapBytes = await fetchMinimap()
    await buildPage(mapBytes)
  }, 5000)
}

function stopMapRefresh() {
  if (mapRefreshTimer) { clearInterval(mapRefreshTimer); mapRefreshTimer = null }
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
          const mapBytes = await fetchMinimap()
          await buildPage(mapBytes)
          return
        }
        bannerModeIdx = (bannerModeIdx + 1) % BANNER_MODES.length
        bannerMode    = BANNER_MODES[bannerModeIdx]
        const mapBytes = await fetchMinimap()
        await buildPage(mapBytes)
        break
      }

      // Double tap — open menu (rendered on phone side, result sent back via sessionStorage event)
      case OsEventTypeList.DOUBLE_CLICK_EVENT: {
        // Signal the phone UI to show the menu
        window.dispatchEvent(new CustomEvent('g2maps:showmenu'))
        break
      }

      // Swipe up — previous step (manual review)
      case OsEventTypeList.SCROLL_TOP_EVENT: {
        if (!steps.length || stepIdx <= 0) break
        await changeStep(stepIdx - 1)
        break
      }

      // Swipe down — skip to next step
      case OsEventTypeList.SCROLL_BOTTOM_EVENT: {
        if (!steps.length || stepIdx >= steps.length - 1) break
        await changeStep(stepIdx + 1)
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
  const mapBytes = await fetchMinimap()
  await buildPage(mapBytes)
}

export async function menuPassiveMode() {
  if (navState !== 'passive') {
    navState = 'passive'
    stopGPS()
    const mapBytes = await fetchMinimap()
    await buildPage(mapBytes)
    startMapRefresh()
    return
  }

  // Return to navigation if we have a route
  navState = steps.length ? 'navigating' : 'idle'
  if (navState === 'navigating') startGPS()
  const mapBytes = await fetchMinimap()
  await buildPage(mapBytes)
  startMapRefresh()
}

export async function menuEndNavigation() {
  stopGPS()
  stopMapRefresh()
  stopAndroidPoll()
  resetSpeedLimitCache()
  limitMph = null
  steps    = []
  stepIdx  = 0
  navState = 'idle'
  sessionStorage.removeItem('g2maps_destination')
  sessionStorage.removeItem('g2maps_origin')
  await buildPage(null)
}

// ─── Settings hot-reload (called when user saves settings on phone) ───────────

export async function reloadSettings() {
  settings = loadSettings()
  const mapBytes = await fetchMinimap()
  await buildPage(mapBytes)
}

// ─── Navigation start ─────────────────────────────────────────────────────────

export async function startNavigation() {
  stopGPS()
  stopMapRefresh()
  resetSpeedLimitCache()
  limitMph = null

  const raw = sessionStorage.getItem('g2maps_destination')
  if (!raw) {
    navState = 'idle'
    await buildPage(null)
    return
  }

  navState = 'navigating'
  await buildPage(null)

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
        await buildPage(null)
        return
      }
    }

    reportStatus('fetching route…')
    steps   = await getRoute({ lat: currentLat, lng: currentLng }, { lat: dest.lat, lng: dest.lng })
    stepIdx = 0
    reportStatus(`route: ${steps.length} steps`)

    if (!steps.length) {
      navState = 'idle'
      await buildPage(null)
      return
    }

    // Use step 0's start coordinates (more precise than geocoded address)
    syncPositionFromStep()

    const mapBytes = await fetchMinimap()
    await buildPage(mapBytes)

    // Prefer Android location polling when available; fall back to WebView GPS
    if (activeLocationProvider) {
      startAndroidPoll()
    } else {
      startGPS()
    }
    startMapRefresh()

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    reportStatus(`nav error: ${msg}`)
    navState = 'idle'
    await buildPage(null)
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
    }
    if (sys.eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      stopMapRefresh()
    }
  })

  await buildPage(null)

  // Listen for phone-side events
  window.addEventListener('g2maps:navigate',  () => startNavigation())
  window.addEventListener('g2maps:settings',  () => reloadSettings())
  window.addEventListener('g2maps:pause',     () => menuPauseResume())
  window.addEventListener('g2maps:passive',   () => menuPassiveMode())
  window.addEventListener('g2maps:end',       () => menuEndNavigation())
}

init()
