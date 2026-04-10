// ─── mapText.ts ───────────────────────────────────────────────────────────────
//
// Renders a schematic minimap as an ASCII character grid for display in a
// TextContainerProperty — no image upload, no imageException possible.
//
// Character grid is projected from lat/lng with a flat Mercator approximation.
// Characters are assumed ~2× taller than wide; vertical scale is halved to
// compensate so the map looks proportional on screen.
//
// Characters used (all printable ASCII — safe for the G2 bitmap font):
//   .   background
//   ~   future route steps
//   -   current step path
//   @   current position
//   >   upcoming turn (end of current step)
//
// Drawing uses a priority grid so higher-priority marks always win:
//   0 = background  1 = future  2 = current  3 = turn  4 = position
function bresenham(grid, pri, x0, y0, x1, y1, ch, prio, cols, rows) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    while (true) {
        if (x >= 0 && x < cols && y >= 0 && y < rows && pri[y][x] < prio) {
            grid[y][x] = ch;
            pri[y][x] = prio;
        }
        if (x === x1 && y === y1)
            break;
        const e2 = 2 * err;
        if (e2 > -dy) {
            err -= dy;
            x += sx;
        }
        if (e2 < dx) {
            err += dx;
            y += sy;
        }
    }
}
export function renderMapText(lat, lng, steps, stepIdx, cols, rows, mpc = 80) {
    const grid = Array.from({ length: rows }, () => Array(cols).fill('.'));
    const pri = Array.from({ length: rows }, () => Array(cols).fill(0));
    // Project geo → character cell.  *2 on vertical to compensate for char aspect ratio.
    const cosLat = Math.cos(lat * Math.PI / 180);
    const toCell = (rlat, rlng) => ({
        c: Math.round(cols / 2 + (rlng - lng) * 111111 * cosLat / mpc),
        r: Math.round(rows / 2 - (rlat - lat) * 111111 / (mpc * 2)),
    });
    const set = (c, r, ch, prio) => {
        if (c >= 0 && c < cols && r >= 0 && r < rows && pri[r][c] < prio) {
            grid[r][c] = ch;
            pri[r][c] = prio;
        }
    };
    // Draw future steps (priority 1 — lowest)
    for (let i = stepIdx + 1; i < steps.length; i++) {
        const s = steps[i];
        if (!s.startLat && !s.startLng)
            continue;
        const a = toCell(s.startLat, s.startLng);
        const b = toCell(s.endLat, s.endLng);
        bresenham(grid, pri, a.c, a.r, b.c, b.r, '~', 1, cols, rows);
    }
    // Draw current step path (priority 2)
    if (steps[stepIdx]) {
        const s = steps[stepIdx];
        if (s.startLat || s.startLng || s.endLat || s.endLng) {
            const a = toCell(s.startLat, s.startLng);
            const b = toCell(s.endLat, s.endLng);
            bresenham(grid, pri, a.c, a.r, b.c, b.r, '-', 2, cols, rows);
            // Upcoming turn marker at step endpoint (priority 3)
            const t = toCell(s.endLat, s.endLng);
            set(t.c, t.r, '>', 3);
        }
    }
    // Current position marker (priority 4 — highest)
    const pos = toCell(lat, lng);
    set(pos.c, pos.r, '@', 4);
    return grid.map(row => row.join('')).join('\n');
}
