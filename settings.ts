export interface HudSettings {
  minimap: {
    visible: boolean
    size: number        // 50–150, percent of base dimensions
    brightness: number  // 20–100, maps to opacity
  }
  speed: {
    visible: boolean
    size: number        // 50–150
    brightness: number  // 20–100
    showLimit: boolean
  }
}

export const DEFAULT_SETTINGS: HudSettings = {
  minimap:  { visible: true,  size: 100, brightness: 100 },
  speed:    { visible: true,  size: 100, brightness: 100, showLimit: true },
}

export function loadSettings(): HudSettings {
  try {
    const raw = sessionStorage.getItem('g2maps_hud_settings')
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: HudSettings): void {
  sessionStorage.setItem('g2maps_hud_settings', JSON.stringify(s))
}
