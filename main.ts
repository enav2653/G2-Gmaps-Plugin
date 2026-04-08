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
import { fetchMapSnapshot, imageToGreyscaleBytes } from './mapImage'
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
let pageCreated = false

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

async function fetchMinimap(): Promise<Uint8Array | null> {
  if (!settings.minimap.visible) return null
  try {
    const { w, h } = minimapDims(settings)
    reportStatus(`minimap fetch: ${currentLat.toFixed(4)},${currentLng.toFixed(4)} ${w}x${h}`)
    const blob  = await fetchMapSnapshot(currentLat, currentLng, { widthPx: w, heightPx: h, zoom: 17 })
    reportStatus(`minimap blob: ${blob.size} bytes`)
    let   bytes = await imageToGreyscaleBytes(blob, w, h)
    reportStatus(`minimap bytes: ${bytes.length}`)
    const br    = settings.minimap.brightness / 100
    if (br < 1) bytes = applyBrightness(bytes, br)
    return bytes
  } catch (e) {
    reportStatus(`minimap error: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// ─── Full page build ──────────────────────────────────────────────────────────
//
// Called on first load, step change, settings change, or state change.
// Tears down and rebuilds all containers.

async function buildPage(mapBytes: Uint8Array | null = null) {
  const bannerContent = buildBannerText(steps, stepIdx, navState, bannerMode)
  const speedContent  = buildSpeedText(speedMph, limitMph, settings)

  const textContainers: TextContainerProperty[] = [buildEventContainer()]
  const imageContainers: ImageContainerProperty[] = []

  // Banner visibility:
  //   always-on  → always show (except passive/idle handled via content)
  //   as-needed  → shown here at build time; dimmed via opacity simulation is
  //                not possible — we instead show a short version
  //   always-off → omit container entirely
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

  // Upload map image after page is created (SDK requirement)
  if (!mapContainer || !mapBytes) return
  const imgResult = await bridge.updateImageRawData(new ImageRawDataUpdate({
    containerID:   CID.MAP,
    containerName: 'minimap',
    imageData:     mapBytes,
  }))
  reportStatus(`minimap upload: ${JSON.stringify(imgResult)}`)
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
    if (!mapBytes) return
    await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID:   CID.MAP,
      containerName: 'minimap',
      imageData:     mapBytes,
    }))
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
        stepIdx--
        await refreshBanner()
        break
      }

      // Swipe down — skip to next step
      case OsEventTypeList.SCROLL_BOTTOM_EVENT: {
        if (!steps.length || stepIdx >= steps.length - 1) break
        stepIdx++
        await refreshBanner()
        break
      }
    }
  })
}

// ─── Menu actions (called from phone UI) ─────────────────────────────────────

export async function menuPauseResume() {
  if (navState === 'paused') {
    navState = 'navigating'
    startGPS()
  } else {
    navState = 'paused'
    stopGPS()
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
    if (rawOrg) {
      const org  = JSON.parse(rawOrg) as { lat: number; lng: number; label: string }
      currentLat = org.lat
      currentLng = org.lng
      reportStatus(`origin: ${org.label}`)
    } else {
      reportStatus('trying GPS…')
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
      reportStatus(`GPS: ${currentLat.toFixed(4)}, ${currentLng.toFixed(4)}`)
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

    const mapBytes = await fetchMinimap()
    await buildPage(mapBytes)

    startGPS()
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
