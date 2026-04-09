// ─── hud.ts ───────────────────────────────────────────────────────────────────
//
// Translates navigation + settings state into G2 SDK container calls.
//
// Canvas: 576 × 288 px, 4-bit greyscale
//
// Layout zones:
//   Banner   y=0   h=44   (maneuver instruction + distance + step/ETA)
//   Clear    y=44  h=152  (intentionally empty — environment awareness)
//   Bottom   y=196 h=92   (minimap bottom-left + speed stack bottom-right)
//
// Container map:
//   ID 1  — full-screen event-capture text (invisible, receives all input)
//   ID 2  — banner text container          (top strip)
//   ID 3  — minimap image container        (bottom-left, conditional)
//   ID 4  — speed text container           (bottom-right, conditional)
//
// The event-capture container sits behind everything. We use
// textContainerUpgrade() for in-place updates to avoid full redraws.

import {
  TextContainerProperty,
  ImageContainerProperty,
} from '@evenrealities/even_hub_sdk'

import { RouteStep } from './maps'
import { HudSettings } from './settings'
import { formatInstruction, formatDistance, formatETA } from './display'

// ─── Canvas constants ─────────────────────────────────────────────────────────

export const CANVAS_W = 576
export const CANVAS_H = 288

const BANNER_H  = 64
const BOTTOM_Y  = 196
const BOTTOM_H  = CANVAS_H - BOTTOM_Y   // 92

// Base minimap dimensions (at 100% size)
const MAP_BASE_W = 80
const MAP_BASE_H = 88

// Minimap padding in px
const MAP_PAD_L = 4
const MAP_PAD_B = 2

// Speed stack right margin
const SPD_RIGHT_MARGIN = 8

// ─── Container IDs ───────────────────────────────────────────────────────────

export const CID = {
  EVENT:  1,
  BANNER: 2,
  MAP:    3,
  SPEED:  4,
} as const

// ─── Banner modes ─────────────────────────────────────────────────────────────

export type BannerMode = 'always-on' | 'as-needed' | 'always-off'
export const BANNER_MODES: BannerMode[] = ['always-on', 'as-needed', 'always-off']

export function bannerModeLabel(m: BannerMode): string {
  if (m === 'always-on') return 'Banner: on'
  if (m === 'as-needed') return 'Banner: auto'
  return 'Banner: off'
}

// ─── Nav states ──────────────────────────────────────────────────────────────

export type NavState = 'navigating' | 'paused' | 'passive' | 'idle'

// ─── Banner content ───────────────────────────────────────────────────────────

export function buildBannerText(
  steps: RouteStep[],
  stepIdx: number,
  state: NavState,
  bannerMode: BannerMode,
  liveDistM?: number,
): string {
  if (state === 'idle')    return 'G2 Maps  •  Set a destination'
  if (state === 'passive') return 'Passive map  •  No active route'
  if (state === 'paused')  return 'Navigation paused  •  Tap to resume'

  const step = steps[stepIdx]
  if (!step) return 'Finding location…'

  const instr = formatInstruction(step.instruction)
  const dist  = formatDistance(liveDistM ?? step.distanceMeters)
  const eta   = formatETA(steps.slice(stepIdx).reduce((s, st) => s + st.durationSeconds, 0))

  // Mode indicator shown in always-off / as-needed so user knows they're not stuck
  const modeHint = bannerMode === 'always-on' ? '' : `\n${bannerModeLabel(bannerMode)}`

  return `${instr}\n${dist}  •  ${stepIdx + 1}/${steps.length}  •  ETA ${eta}${modeHint}`
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

// ─── Minimap pixel dimensions (settings-adjusted) ─────────────────────────────

export function minimapDims(settings: HudSettings): { w: number; h: number } {
  const scale = settings.minimap.size / 100
  // Clamp to SDK image container limits (20–288 w, 20–144 h)
  // Width must be even for 4-bit packing (2 pixels per byte)
  const w = Math.max(20, Math.min(288, Math.round(MAP_BASE_W * scale / 2) * 2))
  const h = Math.max(20, Math.min(144, Math.round(MAP_BASE_H * scale)))
  return { w, h }
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

/** Banner text container — top strip. */
export function buildBannerContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    containerID:   CID.BANNER,
    containerName: 'banner',
    xPosition:     0,
    yPosition:     0,
    width:         CANVAS_W,
    height:        BANNER_H,
    borderWidth:   0,
    borderColor:   0,
    paddingLength: 6,
    content,
    isEventCapture: 0,
  })
}

/** Minimap image container — bottom-left. Returns null if hidden. */
export function buildMinimapContainer(settings: HudSettings): ImageContainerProperty | null {
  if (!settings.minimap.visible) return null

  const { w, h } = minimapDims(settings)
  return new ImageContainerProperty({
    containerID:   CID.MAP,
    containerName: 'minimap',
    xPosition:     MAP_PAD_L,
    yPosition:     CANVAS_H - h - MAP_PAD_B,
    width:         w,
    height:        h,
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

