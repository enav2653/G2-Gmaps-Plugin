// ─── mapText.ts ───────────────────────────────────────────────────────────────
//
// Renders a schematic minimap as a Unicode character grid for display in a
// TextContainerProperty — no image upload, no imageException possible.
//
// Character grid is projected from lat/lng with a flat Mercator approximation.
// Characters are assumed ~2× taller than wide; vertical scale is halved to
// compensate so the map looks proportional on screen.
//
// Characters used:
//   ·   background/future route steps
//   ─   current step path
//   ◉   current position
//   ▶   upcoming turn (end of current step)

import { RouteStep } from './maps'

function bresenham(
  grid: string[][],
  x0: number, y0: number,
  x1: number, y1: number,
  ch: string,
  cols: number, rows: number,
) {
  const dx = Math.abs(x1-x0), dy = Math.abs(y1-y0)
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
  let err = dx - dy, x = x0, y = y0
  while (true) {
    if (x >= 0 && x < cols && y >= 0 && y < rows && grid[y][x] === ' ')
      grid[y][x] = ch
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 <  dx) { err += dx; y += sy }
  }
}

export function renderMapText(
  lat: number,
  lng: number,
  steps: RouteStep[],
  stepIdx: number,
  cols: number,
  rows: number,
  mpc: number = 80,   // metres per character column
): string {
  const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '))

  // Project geo → character cell.  *2 on vertical to compensate for char aspect ratio.
  const cosLat = Math.cos(lat * Math.PI / 180)
  const toCell = (rlat: number, rlng: number) => ({
    c: Math.round(cols / 2 + (rlng - lng) * 111_111 * cosLat / mpc),
    r: Math.round(rows / 2 - (rlat - lat) * 111_111 / (mpc * 2)),
  })

  const set = (c: number, r: number, ch: string) => {
    if (c >= 0 && c < cols && r >= 0 && r < rows) grid[r][c] = ch
  }

  // Draw future steps (lower priority — drawn first so current step overwrites)
  for (let i = stepIdx + 1; i < steps.length; i++) {
    const s = steps[i]
    if (!s.startLat && !s.startLng) continue
    const a = toCell(s.startLat, s.startLng)
    const b = toCell(s.endLat,   s.endLng)
    bresenham(grid, a.c, a.r, b.c, b.r, '·', cols, rows)
  }

  // Draw current step path
  if (steps[stepIdx]) {
    const s = steps[stepIdx]
    if (s.startLat || s.startLng || s.endLat || s.endLng) {
      const a = toCell(s.startLat, s.startLng)
      const b = toCell(s.endLat,   s.endLng)
      bresenham(grid, a.c, a.r, b.c, b.r, '─', cols, rows)

      // Upcoming turn marker at step endpoint
      const t = toCell(s.endLat, s.endLng)
      set(t.c, t.r, '▶')
    }
  }

  // Current position marker (highest priority — drawn last)
  const pos = toCell(lat, lng)
  set(pos.c, pos.r, '◉')

  return grid.map(row => row.join('')).join('\n')
}
