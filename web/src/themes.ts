// Theme registry: the THEME choice in SETTINGS (settings.ts) and what each theme turns on.
//
// The page shows the theme id on <html data-theme="...">; amber and green also keep data-phosphor (their palettes
// live in theme.css, which every theme builds on). The inline script in index.html and login.html sets data-theme
// before first paint from the saved id, so it needs no edit for a new theme.
//
// Adding a theme:
//   1. One CSS file: themes/<id>.css. Every rule scoped under html[data-theme='<id>'] (tokens on
//      :root[data-theme='<id>'] so they beat the accent palettes). It loads by itself (the glob below), also on the
//      login page. Set the TOKEN CONTRACT tokens from theme.css (--ph, --bg, --font, ...) and most screens follow;
//      --sprite-dim / --sprite / --sprite-bright / --sprite-face recolor the pixel crew (sprites/engine.ts); the
//      scene's shading ramps (--sprite-skin-1 ...) go in sprites/palette.css.
//   2. One entry in THEMES below.
// A flat theme (crt: false) should also switch off the CRT look in its CSS (see the top of themes/lcars.css),
// because the saved CRT level still applies for a moment before settings.ts runs.

import.meta.glob('./themes/*.css', { eager: true });

export type Theme = {
  id: string;
  label: string; // SETTINGS button
  title: string; // SETTINGS button tooltip
  screen: string; // browser bar color (meta theme-color): the theme's --bg
  phosphor: boolean; // an amber/green style screen: sets data-phosphor too
  crt: boolean; // CRT effects (scanlines, glow, curve, flicker) apply; false = flat panel, the CRT setting waits
  accent: boolean; // the ACCENT COLOR setting applies; false = the theme sets --accent itself
  sounds: 'blip' | 'chirp'; // sound set in sound.ts
  boot: 'terminal' | 'lcars'; // boot screen in boot.ts
};

export const THEMES = [
  { id: 'amber', label: 'AMBER', title: 'Amber phosphor screen', screen: '#0b0700', phosphor: true, crt: true, accent: true, sounds: 'blip', boot: 'terminal' },
  { id: 'green', label: 'GREEN', title: 'Green phosphor screen', screen: '#010a03', phosphor: true, crt: true, accent: true, sounds: 'blip', boot: 'terminal' },
  { id: 'lcars', label: 'LCARS', title: 'Flat panels, rounded frames, color-coded blocks', screen: '#000000', phosphor: false, crt: false, accent: false, sounds: 'chirp', boot: 'lcars' },
] as const satisfies readonly Theme[];

export type ThemeId = (typeof THEMES)[number]['id'];

export function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

// Unknown ids (a removed theme, a typo) get the first theme.
export function themeOf(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

// The theme on screen right now (data-theme, set by the inline script and settings.ts).
export function currentTheme(): Theme {
  return themeOf(document.documentElement.dataset.theme);
}
