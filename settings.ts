export interface HudSettings {
  minimap: {
    visible: boolean
  }
  speed: {
    visible:   boolean
    showLimit: boolean
  }
}

export const DEFAULT_SETTINGS: HudSettings = {
  minimap: { visible: true },
  speed:   { visible: true, showLimit: true },
}

// ── Persistent storage: localStorage + cookie fallback ────────────────────────
//
// Flutter InAppWebView may recreate the localStorage context on each launch.
// Cookies are managed by Android CookieManager with a separate lifecycle and
// survive WebView recreation, so we dual-write to both.

function cookieGet(key: string): string | null {
  const match = document.cookie.split('; ')
    .find(r => r.startsWith(encodeURIComponent(key) + '='))
  return match ? decodeURIComponent(match.split('=')[1]) : null
}

function cookieSet(key: string, value: string): void {
  const exp = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toUTCString()
  document.cookie =
    `${encodeURIComponent(key)}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`
}

export function persistGet(key: string): string | null {
  try { const v = localStorage.getItem(key); if (v !== null) return v } catch { /* fall through */ }
  return cookieGet(key)
}

export function persistSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* fall through */ }
  cookieSet(key, value)
}

export function loadSettings(): HudSettings {
  try {
    const raw = persistGet('g2maps_settings_v2')
    if (!raw) return DEFAULT_SETTINGS
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(s: HudSettings): void {
  persistSet('g2maps_settings_v2', JSON.stringify(s))
}
