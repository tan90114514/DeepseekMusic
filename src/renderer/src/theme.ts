export type ThemeMode = 'classic' | 'day' | 'night' | 'custom'

export interface ThemeConfig {
  mode: ThemeMode
  customAccent: string
  customBackground: string
}

const THEME_KEY = 'dsm-theme-v1'
const THEME_CHANNEL = 'dsm-theme-change'
const DEFAULT_CONFIG: ThemeConfig = {
  mode: 'classic',
  customAccent: '#4d6bfe',
  customBackground: '#0b1220'
}

const CUSTOM_VARIABLES = [
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-faint',
  '--accent-rgb',
  '--on-accent',
  '--bg',
  '--bg-elevated',
  '--bg-glow-1',
  '--bg-glow-2',
  '--panel',
  '--panel-soft',
  '--panel-hover',
  '--border',
  '--border-soft',
  '--topbar-bg',
  '--sidebar-bg',
  '--player-bg',
  '--table-bg',
  '--table-head',
  '--row-hover',
  '--row-border',
  '--input-bg',
  '--modal-bg',
  '--modal-backdrop',
  '--hover-bg',
  '--hover-bg-weak',
  '--active-bg',
  '--active-bg-strong',
  '--text',
  '--text-strong',
  '--text-side',
  '--muted',
  '--muted-2',
  '--muted-soft',
  '--border-strong',
  '--divider',
  '--scroll-thumb',
  '--scroll-thumb-hover',
  '--shadow',
  '--empty-bg',
  '--job-bg',
  '--job-track',
  '--job-current-bg',
  '--track-bg',
  '--toast-bg',
  '--toast-success-bg',
  '--toast-success-text',
  '--toast-error-bg',
  '--toast-error-text',
  '--code-bg',
  '--code-text',
  '--green',
  '--green-soft',
  '--amber',
  '--amber-soft',
  '--red',
  '--red-soft',
  '--onboarding-bg',
  '--onboarding-card',
  '--onboarding-glow',
  '--feature-bg',
  '--feature-border',
  '--cover-bg',
  '--player-cover-text',
  '--lyrics-bg',
  '--lyrics-border',
  '--lyrics-shadow',
  '--lyrics-heading',
  '--lyrics-track',
  '--lyrics-tool-bg',
  '--lyrics-tool-border',
  '--lyrics-tool-text',
  '--lyrics-text',
  '--lyrics-dim',
  '--lyrics-next',
  '--lyrics-muted',
  '--lyrics-error',
  '--lyrics-empty-title',
  '--lyrics-load-bg',
  '--lyrics-load-border',
  '--lyrics-load-text'
] as const

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'classic' || value === 'day' || value === 'night' || value === 'custom'
}

function normalizeHex(value: string, fallback: string): string {
  const text = String(value ?? '').trim()
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text
      .slice(1)
      .split('')
      .map((char) => `${char}${char}`)
      .join('')
      .toLowerCase()}`
  }
  return fallback
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ]
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`
}

function mix(first: string, second: string, amount: number): string {
  const a = hexToRgb(first)
  const b = hexToRgb(second)
  const t = Math.max(0, Math.min(1, amount))
  return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
}

function alpha(hex: string, value: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, value))})`
}

function luminance(hex: string): number {
  const channels = hexToRgb(hex).map((value) => {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

export function readThemeConfig(): ThemeConfig {
  try {
    const raw = localStorage.getItem(THEME_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw) as Partial<ThemeConfig>
    return {
      mode: isThemeMode(parsed.mode) ? parsed.mode : DEFAULT_CONFIG.mode,
      customAccent: normalizeHex(String(parsed.customAccent ?? ''), DEFAULT_CONFIG.customAccent),
      customBackground: normalizeHex(
        String(parsed.customBackground ?? ''),
        DEFAULT_CONFIG.customBackground
      )
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function persistTheme(config: ThemeConfig): void {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(config))
  } catch {
    // Theme persistence is optional.
  }
  try {
    const channel = new BroadcastChannel(THEME_CHANNEL)
    channel.postMessage(config)
    channel.close()
  } catch {
    // BroadcastChannel is unavailable in very old Chromium; storage events still work.
  }
}

interface CustomPalette {
  accent: string
  accentStrong: string
  accentSoft: string
  bg: string
  panel: string
  panelSoft: string
  panelHover: string
  border: string
  borderSoft: string
  text: string
  textStrong: string
  muted: string
  muted2: string
  tone: 'light' | 'dark'
}

function customPalette(config: ThemeConfig): CustomPalette {
  const accent = normalizeHex(config.customAccent, DEFAULT_CONFIG.customAccent)
  const bg = normalizeHex(config.customBackground, DEFAULT_CONFIG.customBackground)
  const tone: 'light' | 'dark' = luminance(bg) > 0.55 ? 'light' : 'dark'
  const light = tone === 'light'
  const panel = light ? mix(bg, '#ffffff', 0.78) : mix(bg, '#ffffff', 0.065)
  const text = light ? '#14213d' : '#eef4ff'
  return {
    accent,
    accentStrong: light ? mix(accent, '#000000', 0.18) : mix(accent, '#ffffff', 0.24),
    accentSoft: alpha(accent, light ? 0.1 : 0.14),
    bg,
    panel,
    panelSoft: light ? mix(bg, '#ffffff', 0.5) : mix(bg, '#ffffff', 0.095),
    panelHover: mix(panel, accent, light ? 0.07 : 0.16),
    border: light ? mix(panel, '#1b2a46', 0.15) : mix(bg, '#ffffff', 0.18),
    borderSoft: light ? mix(panel, '#1b2a46', 0.085) : mix(bg, '#ffffff', 0.1),
    text,
    textStrong: light ? '#0f1a30' : '#f7faff',
    muted: light ? '#65718b' : mix(text, bg, 0.48),
    muted2: light ? '#8a95a9' : mix(text, bg, 0.64),
    tone
  }
}

export function applyTheme(config: ThemeConfig, persist = true): void {
  const root = document.documentElement
  const normalized: ThemeConfig = {
    mode: isThemeMode(config.mode) ? config.mode : 'classic',
    customAccent: normalizeHex(config.customAccent, DEFAULT_CONFIG.customAccent),
    customBackground: normalizeHex(config.customBackground, DEFAULT_CONFIG.customBackground)
  }
  const tone: 'light' | 'dark' =
    normalized.mode === 'day'
      ? 'light'
      : normalized.mode === 'custom'
        ? customPalette(normalized).tone
        : 'dark'

  root.dataset.theme = normalized.mode
  root.dataset.tone = tone

  for (const property of CUSTOM_VARIABLES) root.style.removeProperty(property)

  if (normalized.mode === 'custom') {
    const palette = customPalette(normalized)
    const light = palette.tone === 'light'
    const vars: Record<string, string> = {
      '--accent': palette.accent,
      '--accent-strong': palette.accentStrong,
      '--accent-soft': palette.accentSoft,
      '--accent-faint': alpha(palette.accent, 0.06),
      '--accent-rgb': hexToRgb(palette.accent).join(', '),
      '--on-accent': luminance(palette.accent) > 0.56 ? '#101827' : '#ffffff',
      '--bg': palette.bg,
      '--bg-elevated': palette.panelSoft,
      '--bg-glow-1': alpha(palette.accent, light ? 0.08 : 0.12),
      '--bg-glow-2': alpha(palette.accent, light ? 0.035 : 0.055),
      '--panel': palette.panel,
      '--panel-soft': palette.panelSoft,
      '--panel-hover': palette.panelHover,
      '--border': palette.border,
      '--border-soft': palette.borderSoft,
      '--border-strong': light ? mix(palette.border, '#000000', 0.1) : mix(palette.border, '#ffffff', 0.1),
      '--topbar-bg': alpha(palette.panel, light ? 0.9 : 0.86),
      '--sidebar-bg': alpha(light ? mix(palette.bg, palette.panel, 0.4) : mix(palette.bg, '#000000', 0.12), 0.86),
      '--player-bg': alpha(palette.panel, 0.95),
      '--table-bg': alpha(palette.panel, light ? 0.88 : 0.82),
      '--table-head': mix(palette.panel, palette.bg, light ? 0.42 : 0.45),
      '--row-hover': alpha(palette.accent, light ? 0.05 : 0.065),
      '--row-border': palette.borderSoft,
      '--input-bg': light ? mix(palette.panel, palette.bg, 0.35) : mix(palette.bg, '#000000', 0.18),
      '--modal-bg': palette.panel,
      '--modal-backdrop': light ? 'rgba(28, 45, 80, 0.28)' : 'rgba(3, 8, 16, 0.7)',
      '--hover-bg': alpha(light ? '#1b2a46' : '#ffffff', light ? 0.04 : 0.045),
      '--hover-bg-weak': alpha(light ? '#1b2a46' : '#ffffff', light ? 0.025 : 0.03),
      '--active-bg': alpha(palette.accent, light ? 0.08 : 0.12),
      '--active-bg-strong': alpha(palette.accent, light ? 0.13 : 0.17),
      '--text': palette.text,
      '--text-strong': palette.textStrong,
      '--text-side': light ? mix(palette.text, palette.bg, 0.22) : '#b9c6dd',
      '--muted': palette.muted,
      '--muted-2': palette.muted2,
      '--muted-soft': light ? '#9aa4b6' : mix(palette.text, palette.bg, 0.72),
      '--divider': palette.borderSoft,
      '--scroll-thumb': light ? mix(palette.bg, '#344a73', 0.25) : mix(palette.bg, '#ffffff', 0.24),
      '--scroll-thumb-hover': light ? mix(palette.bg, '#344a73', 0.38) : mix(palette.bg, '#ffffff', 0.34),
      '--shadow': light
        ? '0 18px 55px rgba(29, 56, 120, 0.15)'
        : '0 18px 60px rgba(0, 0, 0, 0.48)',
      '--empty-bg': light ? 'rgba(255, 255, 255, 0.58)' : 'rgba(14, 23, 40, 0.55)',
      '--job-bg': alpha(palette.panel, light ? 0.92 : 0.84),
      '--job-track': light ? mix(palette.bg, '#334a74', 0.16) : mix(palette.bg, '#ffffff', 0.14),
      '--job-current-bg': alpha(light ? '#1b2a46' : '#ffffff', light ? 0.035 : 0.04),
      '--track-bg': light ? mix(palette.bg, '#334a74', 0.16) : mix(palette.bg, '#ffffff', 0.14),
      '--toast-bg': palette.panel,
      '--toast-success-bg': light ? '#e9fbf3' : '#162b26',
      '--toast-success-text': light ? '#0b6b4f' : '#c9f3e1',
      '--toast-error-bg': light ? '#fff0f0' : '#2b1d21',
      '--toast-error-text': light ? '#a52a2a' : '#ffd0d0',
      '--code-bg': light ? mix(palette.bg, '#ffffff', 0.5) : mix(palette.bg, '#ffffff', 0.1),
      '--code-text': light ? palette.accentStrong : '#ffc1d4',
      '--green': light ? '#0f9d74' : '#4ecb9a',
      '--green-soft': light ? 'rgba(15, 157, 116, 0.1)' : 'rgba(78, 203, 154, 0.11)',
      '--amber': light ? '#a8750c' : '#f2bb64',
      '--amber-soft': light ? 'rgba(168, 117, 12, 0.1)' : 'rgba(242, 187, 100, 0.1)',
      '--red': light ? '#cf4b4b' : '#ff7676',
      '--red-soft': light ? 'rgba(207, 75, 75, 0.08)' : 'rgba(255, 118, 118, 0.1)',
      '--onboarding-bg': light
        ? `radial-gradient(circle at 18% 8%, ${alpha(palette.accent, 0.14)}, transparent 31%), radial-gradient(circle at 88% 100%, ${alpha(palette.accent, 0.08)}, transparent 34%), ${palette.bg}`
        : `radial-gradient(circle at 18% 8%, ${alpha(palette.accent, 0.16)}, transparent 31%), radial-gradient(circle at 88% 100%, ${alpha(palette.accent, 0.08)}, transparent 34%), ${palette.bg}`,
      '--onboarding-card': alpha(palette.panel, light ? 0.95 : 0.97),
      '--onboarding-glow': alpha(palette.accent, 0.08),
      '--feature-bg': alpha(light ? '#1b2a46' : '#ffffff', light ? 0.03 : 0.025),
      '--feature-border': palette.border,
      '--cover-bg': alpha(palette.accent, 0.16),
      '--player-cover-text': light ? palette.accentStrong : '#f2c1d2',
      '--lyrics-bg': alpha(palette.panel, light ? 0.92 : 0.86),
      '--lyrics-border': light ? palette.border : 'rgba(255, 255, 255, 0.13)',
      '--lyrics-shadow': light
        ? '0 22px 60px rgba(29, 56, 120, 0.2)'
        : '0 22px 60px rgba(0, 0, 0, 0.46)',
      '--lyrics-heading': light ? palette.muted : '#b9b7c7',
      '--lyrics-track': light ? palette.muted2 : '#6f6e7e',
      '--lyrics-tool-bg': alpha(light ? '#1b2a46' : '#ffffff', light ? 0.04 : 0.04),
      '--lyrics-tool-border': light ? palette.borderSoft : 'rgba(255, 255, 255, 0.1)',
      '--lyrics-tool-text': light ? palette.muted : '#9d9bac',
      '--lyrics-text': light ? palette.textStrong : '#fff6fa',
      '--lyrics-dim': light ? alpha(palette.text, 0.38) : 'rgba(218, 212, 228, 0.35)',
      '--lyrics-next': light ? alpha(palette.accentStrong, 0.65) : 'rgba(241, 194, 212, 0.56)',
      '--lyrics-muted': light ? palette.muted : '#8e8b9d',
      '--lyrics-error': light ? '#cf4b4b' : '#de9999',
      '--lyrics-empty-title': light ? palette.textStrong : '#d8d5e0',
      '--lyrics-load-bg': alpha(palette.accent, light ? 0.1 : 0.1),
      '--lyrics-load-border': alpha(palette.accent, 0.3),
      '--lyrics-load-text': light ? palette.accentStrong : '#f7a8bf'
    }
    for (const [property, value] of Object.entries(vars)) root.style.setProperty(property, value)
  }

  root.style.colorScheme = tone
  if (persist) persistTheme(normalized)
}

export function watchTheme(callback: (config: ThemeConfig) => void): () => void {
  const storageHandler = (event: StorageEvent): void => {
    if (event.key === THEME_KEY) callback(readThemeConfig())
  }
  window.addEventListener('storage', storageHandler)
  let channel: BroadcastChannel | null = null
  try {
    channel = new BroadcastChannel(THEME_CHANNEL)
    channel.onmessage = (): void => callback(readThemeConfig())
  } catch {
    channel = null
  }
  return () => {
    window.removeEventListener('storage', storageHandler)
    channel?.close()
  }
}
