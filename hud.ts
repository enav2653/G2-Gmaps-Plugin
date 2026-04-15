// ─── hud.ts ───────────────────────────────────────────────────────────────────
//
// Translates navigation + settings state into G2 SDK container calls.
//
// Canvas: 576 × 288 px, 4-bit greyscale
//
// Layout zones:
//   Banner   y=0   h=80   (maneuver instruction + distance + step/ETA)
//   Clear    y=80  h=116  (intentionally empty — environment awareness)
//   Bottom   y=196 h=92   (minimap bottom-left + speed stack bottom-right)
//
// Container map:
//   ID 1  — full-screen event-capture text (invisible, receives all input)
//   ID 2  — banner text container          (top strip)
//   ID 3  — minimap text container         (bottom-left, conditional)
//   ID 4  — speed text container           (bottom-right, conditional)
//   ID 9  — clock text container           (top-right corner, always present)
//
// The event-capture container sits behind everything. We use
// textContainerUpgrade() for in-place updates to avoid full redraws.

import {
  TextContainerProperty,
  ImageContainerProperty,
} from '@evenrealities/even_hub_sdk'

import { RouteStep } from './maps'
import { HudSettings } from './settings'
import { formatInstruction, formatDistance, formatETA, formatClockTime } from './display'

// ─── Canvas constants ─────────────────────────────────────────────────────────

export const CANVAS_W = 576
export const CANVAS_H = 288

const BANNER_H  = 80
const BOTTOM_Y  = 196
const BOTTOM_H  = CANVAS_H - BOTTOM_Y   // 92

// Minimap left padding in px
const MAP_PAD_L = 0

// Minimap tile dimensions — 2×2 grid of 62×62 tiles = 124×124 total
// (125 can't be halved evenly; 124 is the nearest clean split)
export const MINIMAP_TILE_W  = 62
export const MINIMAP_TILE_H  = 62
const        MINIMAP_COLS    = 2
const        MINIMAP_ROWS    = 2
export const MINIMAP_IMG_W   = MINIMAP_TILE_W * MINIMAP_COLS  // 124
export const MINIMAP_IMG_H   = MINIMAP_TILE_H * MINIMAP_ROWS  // 124
const        MINIMAP_Y       = CANVAS_H - MINIMAP_IMG_H       // 164 — bottom-aligned

// Speed stack right margin
const SPD_RIGHT_MARGIN = 8

// Clock container — top-right corner
const CLOCK_W = 100

// Media container — bottom strip between minimap and speed
const MEDIA_PAD = 28
const MEDIA_X   = MAP_PAD_L + MINIMAP_IMG_W + MEDIA_PAD          // 130
const MEDIA_W   = CANVAS_W - MEDIA_X - (56 + SPD_RIGHT_MARGIN + MEDIA_PAD)  // 376

// ─── Container IDs ───────────────────────────────────────────────────────────

export const CID = {
  EVENT:  1,
  BANNER: 2,
  SPEED:  4,
  MEDIA:  8,
  CLOCK:  9,
} as const

// 4 tile IDs for the 2×2 minimap grid (row-major, left-to-right top-to-bottom)
export const MAP_TILE_CIDS = [3, 5, 6, 7] as const

// ─── Banner modes ─────────────────────────────────────────────────────────────

export type BannerMode = 'always-on' | 'as-needed' | 'always-off'
export const BANNER_MODES: BannerMode[] = ['always-on', 'as-needed', 'always-off']

export function bannerModeLabel(m: BannerMode): string {
  if (m === 'always-on') return 'Banner: on'
  if (m === 'as-needed') return 'Banner: auto'
  return 'Banner: off'
}

// ─── Nav states ──────────────────────────────────────────────────────────────

export type NavState = 'navigating' | 'paused' | 'passive' | 'idle' | 'calibrating'

// ─── Banner content ───────────────────────────────────────────────────────────

export function buildBannerText(
  steps: RouteStep[],
  stepIdx: number,
  state: NavState,
  liveDistM?: number,
  use24h = false,
): string {
  if (state === 'idle')        return 'G2 Maps\nSet a destination'
  if (state === 'passive')     return 'No destination set\n '
  if (state === 'paused')      return 'Navigation paused\nTap to resume'
  if (state === 'calibrating') return 'Compass Calibration\nWave phone in figure-8 pattern'

  const step      = steps[stepIdx]
  if (!step) return 'Finding location…\n'

  const instrStep  = steps[stepIdx + 1] ?? step  // next maneuver; fallback on last step
  const instr      = formatInstruction(instrStep.instruction)
  const dist       = formatDistance(liveDistM ?? step.distanceMeters)
  const totalSecs  = steps.slice(stepIdx).reduce((s, st) => s + st.durationSeconds, 0)
  const eta        = formatETA(totalSecs)
  const arrival    = formatClockTime(new Date(Date.now() + totalSecs * 1000), use24h)

  return `${instr}\n${dist}  •  ${stepIdx + 1}/${steps.length}  •  ${eta}  ${arrival}`
}

// ─── Speed block text ─────────────────────────────────────────────────────────
//
// The G2 has no sub-pixel layout, so we compose the speed block as a
// right-aligned text container. Characters are ~8px wide at default font.
// We right-pad with spaces to right-align within the container.

export function buildSpeedText(
  speedMph: number,
  limitMph: number | null,
  settings: HudSettings,
): string {
  if (!settings.speed.visible) return ''

  const spd   = Math.round(speedMph).toString()
  const unit  = 'mph'
  const limit = settings.speed.showLimit && limitMph !== null
    ? `\n─────\n${Math.round(limitMph)}`
    : ''

  return `${spd}\n${unit}${limit}`
}

// ─── Container builders ───────────────────────────────────────────────────────

/** Full-screen invisible event-capture container. Always present. */
export function buildEventContainer(): TextContainerProperty {
  return new TextContainerProperty({
    containerID:   CID.EVENT,
    containerName: 'event_sink',
    xPosition:     0,
    yPosition:     0,
    width:         CANVAS_W,
    height:        CANVAS_H,
    borderWidth:   0,
    borderColor:   0,
    paddingLength: 0,
    content:       '',
    isEventCapture: 1,
  })
}

/** Banner text container — top strip. Width leaves room for clock in top-right. */
export function buildBannerContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    containerID:   CID.BANNER,
    containerName: 'banner',
    xPosition:     0,
    yPosition:     0,
    width:         CANVAS_W - CLOCK_W,
    height:        BANNER_H,
    borderWidth:   0,
    borderColor:   0,
    paddingLength: 6,
    content,
    isEventCapture: 0,
  })
}

/** Minimap text container — bottom-left. Returns null if hidden or content empty. */
export function buildMinimapTextContainer(
  content: string,
  settings: HudSettings,
): TextContainerProperty | null {
  if (!settings.minimap.visible || !content) return null

  return new TextContainerProperty({
    containerID:   MAP_TILE_CIDS[0],
    containerName: 'minimap',
    xPosition:     MAP_PAD_L,
    yPosition:     BOTTOM_Y,
    width:         200,
    height:        BOTTOM_H,
    borderWidth:   0,
    borderColor:   0,
    paddingLength: 2,
    content,
    isEventCapture: 0,
  })
}

/** Minimap image container — single full-size image. Returns [] if hidden. */
export function buildMinimapImageContainers(
  settings: HudSettings,
): ImageContainerProperty[] {
  if (!settings.minimap.visible) return []
  return [new ImageContainerProperty({
    containerID:   MAP_TILE_CIDS[0],
    containerName: 'minimap',
    xPosition:     MAP_PAD_L,
    yPosition:     MINIMAP_Y,
    width:         MINIMAP_IMG_W,
    height:        MINIMAP_IMG_H,
  })]
}

/** Now-playing text container — bottom strip, between minimap and speed.
 *  Caller is responsible for windowing/scrolling long strings before passing in. */
export function buildMediaText(title: string, artist: string): string {
  return `${title}\n${artist}`
}

export function buildMediaContainer(content: string): TextContainerProperty | null {
  if (!content.trim()) return null
  return new TextContainerProperty({
    containerID:   CID.MEDIA,
    containerName: 'media',
    xPosition:     MEDIA_X,
    yPosition:     CANVAS_H - 72,
    width:         MEDIA_W,
    height:        72,
    borderWidth:   0,
    borderColor:   0,
    paddingLength: 4,
    content,
    isEventCapture: 0,
  })
}

/** Clock time container — top-right corner. Always present. */
export function buildTimeContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    containerID:   CID.CLOCK,
    containerName: 'clock',
    xPosition:     CANVAS_W - CLOCK_W,
    yPosition:     0,
    width:         CLOCK_W,
    height:        40,
    borderWidth:   0,
    borderColor:   0,
    paddingLength: 4,
    content,
    isEventCapture: 0,
  })
}

/** Speed stack text container — bottom-right. Returns null if hidden. */
export function buildSpeedContainer(
  content: string,
  settings: HudSettings,
): TextContainerProperty | null {
  if (!settings.speed.visible || !content.trim()) return null

  // Width sized to fit "mph" + padding comfortably
  const containerW = 56
  const containerH = BOTTOM_H

  return new TextContainerProperty({
    containerID:   CID.SPEED,
    containerName: 'speed',
    xPosition:     CANVAS_W - containerW - SPD_RIGHT_MARGIN,
    yPosition:     BOTTOM_Y,
    width:         containerW,
    height:        containerH,
    borderWidth:   0,
    borderColor:   0,
    paddingLength: 4,
    content,
    isEventCapture: 0,
  })
}

