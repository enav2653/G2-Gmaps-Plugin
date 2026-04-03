# G2 Maps

Google Maps navigation HUD for the Even Realities G2 smart glasses. 

Turn-by-turn directions, a live minimap, and a speed readout beam directly to your lenses — designed around the Android Auto HUD pattern with a permanently clear center so you stay aware of your environment.

---

## What it does

### On the glasses

The 576×288 greyscale display is divided into three permanent zones:

```
┌──────────────────────────────────────────────┐
│  ▶  Turn right onto Oak Ave  │  3/9  ETA 12m │  ← maneuver banner (44px)
├──────────────────────────────────────────────┤
│                                              │
│              (clear — see the world)         │  ← open center (152px)
│                                              │
├──────────────────────────────────────────────┤
│ [minimap]                          28  mph   │  ← bottom strip (92px)
│                                    ┌──┐      │
│                                    │35│      │
└──────────────────────────────────────────────┘
```

**Maneuver banner** — next turn instruction, distance to maneuver, step counter, and ETA. Three modes cycled by single tap on the glasses: always on, as-needed (shown when approaching a turn), always off.

**Clear center** — intentionally empty. Nothing competes with your actual field of view.

**Minimap** — a live rectangular greyscale map thumbnail in the bottom-left corner, re-fetched every 5 seconds to stay centred on your current position. Size and brightness are configurable from the phone.

**Speed readout** — your current speed and the posted speed limit badge, bottom-right. Also configurable from the phone. Both elements can be hidden independently.

### On the phone

A three-tab web app running in the Even Realities WebView:

**Navigate** — address search with Google Places autocomplete, destination selection, and the "Navigate on G2" button that kicks everything off.

**Controls** — pause/resume navigation, switch to passive map mode (minimap and speed still live, no directions), or end the route entirely. These same actions are accessible via double-tap on the glasses, which automatically switches the phone to this tab.

**HUD settings** — independent size (50–150%) and brightness (20–100%) sliders for the minimap and speed readout, visibility toggles for each element and the speed limit badge specifically, plus a live preview that mirrors the glasses layout. Changes apply immediately when you save.

---

## Architecture

```
Phone (Even Realities App + WebView)
│
├── index.html          Phone UI — three tabs: Navigate, Controls, HUD Settings
│
└── src/
    ├── main.ts         App entry point. Owns all state, GPS watch, IMU heading,
    │                   touchpad input, and coordinates every other module.
    │
    ├── hud.ts          G2 display layer. Translates app state into SDK container
    │                   calls. Owns the canvas layout (zone pixel math, container
    │                   IDs, banner/speed text builders, minimap sizing, brightness
    │                   byte-processing for image containers).
    │
    ├── maps.ts         Google Routes API. Fetches a turn-by-turn RouteStep[] from
    │                   origin to destination. Also exposes a geocode() helper used
    │                   by the phone search UI.
    │
    ├── mapImage.ts     Google Maps Static API. Fetches a PNG snapshot centred on
    │                   current position, then converts it to 4-bit greyscale packed
    │                   bytes (2 pixels/byte, high nibble first) as required by
    │                   bridge.updateImageRawData().
    │
    ├── speedLimit.ts   Google Roads API. Two-step lookup: nearestRoads snaps the
    │                   current lat/lng to a road segment place ID, then speedLimits
    │                   fetches the posted limit for that ID. Results are cached by
    │                   place ID so the API is only called when you move onto a new
    │                   road segment. Degrades gracefully to null if the Asset
    │                   Tracking license is absent (403).
    │
    ├── settings.ts     HudSettings type, defaults, and sessionStorage persistence.
    │                   Shared between the phone UI and the glasses display layer.
    │
    └── display.ts      Text formatting helpers: instruction abbreviation, imperial
                        distance formatting, ETA formatting.
```

The glasses themselves run no logic — they render containers sent over Bluetooth and forward input events back. All computation happens in the phone WebView.

---

## Touchpad controls (on the glasses)

| Gesture | Action |
|---|---|
| Single tap | Cycle banner mode: always on → as-needed → always off |
| Single tap (while paused) | Resume navigation |
| Double tap | Open the Controls tab on the phone |
| Swipe up | Go back one step (review previous instruction) |
| Swipe down | Skip forward one step |

Navigation auto-advances steps when you come within 30 metres of a maneuver point.

---

## Navigation states

| State | Glasses display | GPS |
|---|---|---|
| `idle` | Welcome message | Off |
| `navigating` | Full HUD — banner + minimap + speed | On |
| `paused` | "Navigation paused" banner + minimap + speed | Off |
| `passive` | Minimap + speed only, no banner | Off |

---

## Setup

### 1. Prerequisites

- Node.js 18+
- Even Realities G2 paired to your phone, or use the simulator
- A Google Cloud project with billing enabled

### 2. Enable APIs

Go to [console.cloud.google.com](https://console.cloud.google.com) and enable:

| API | Used for |
|---|---|
| Routes API | Turn-by-turn directions |
| Maps Static API | Minimap image |
| Geocoding API | Address → lat/lng fallback |
| Places API | Autocomplete in the phone search UI |
| Roads API | Speed limit lookups (requires Asset Tracking license — see note below) |

**Speed limit note:** The Roads API `speedLimits` endpoint requires a [Google Maps Asset Tracking license](https://mapsplatform.google.com/pricing/). Without it, `nearestRoads` still works but `speedLimits` returns 403. The app catches this and hides the speed limit badge — everything else continues normally.

### 3. Install and configure

```bash
git clone <this-repo>
cd g2-maps

npm install

cp .env.example .env
# Open .env and paste your Google Maps API key
```

### 4. Run in the simulator

```bash
npm run dev          # Vite dev server on :5173
npm run simulate     # Even Hub simulator
```

### 5. Test on device

```bash
# Terminal 1
npm run dev

# Terminal 2
npx evenhub-cli qr   # Scan the QR with the Even Realities App
```

### 6. Package for distribution

```bash
npm run build
npm run pack         # → g2-maps.ehpk
```

Upload `g2-maps.ehpk` to [evenhub.evenrealities.com](https://evenhub.evenrealities.com).

---

## Customisation

**Driving vs walking:** In `src/maps.ts`, change `travelMode: 'DRIVE'` to `'WALK'`.

**Metric units:** Change `units: 'IMPERIAL'` to `'METRIC'` in `maps.ts` and update `formatDistance()` in `display.ts` to use km/m.

**Step advance threshold:** The 30-metre threshold in `main.ts → advanceStep()` can be tuned — increase it for faster highways where GPS updates are less frequent, decrease it for dense urban grids.

**Minimap refresh rate:** The 5-second interval in `startMapRefresh()` balances freshness against Static Maps API cost. Each refresh is one API call.

**Banner as-needed distance:** Currently the banner always renders its content regardless of distance. To implement true proximity triggering (show banner only within Xm of the next turn), add a distance check in `refreshBanner()` using `haversine()` against `steps[stepIdx].endLat/endLng`.

**Free routing alternative:** Replace `getRoute()` in `maps.ts` with a call to the OSRM public API (`router.project-osrm.org/route/v1/driving/`) — no API key required. Map `legs[].steps[].maneuver.instruction` and `legs[].steps[].distance` to the `RouteStep` shape.

---

## API cost estimate

All APIs have a free monthly credit ($200 USD). For personal use you will almost certainly stay within it.

| API | Approximate cost |
|---|---|
| Routes API | $5 / 1,000 requests (one per trip) |
| Maps Static API | $2 / 1,000 requests (one per 5s while navigating) |
| Geocoding API | $5 / 1,000 requests (one per destination search) |
| Roads nearestRoads | $10 / 1,000 requests (one per GPS tick) |
| Roads speedLimits | Included with Asset Tracking license |

The most frequent call is `nearestRoads` — once per GPS update (roughly every 2 seconds while moving). On a 30-minute trip that's ~900 calls, well within the free tier.
