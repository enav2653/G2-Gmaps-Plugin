export interface HudSettings {
  minimap: {
    visible:    boolean
    brightness: number  // 20–100
  }
  speed: {
    visible:    boolean
    brightness: number  // 20–100
    showLimit:  boolean
  }
}

export const DEFAULT_SETTINGS: HudSettings = {
  minimap: { visible: true,  brightness: 100 },
  speed:   { visible: true,  brightness: 100, showLimit: true },
}

export function loadSettings(): HudSettings {
  try {
    const raw = sessionStorage.getItem('g2maps_settings_v2')
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: HudSettings): void {
  sessionStorage.setItem('g2maps_settings_v2', JSON.stringify(s))
}
