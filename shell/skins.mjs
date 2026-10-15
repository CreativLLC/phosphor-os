// Skins: the Retro look on the owner's self-hosted web apps when they show in the app's site panes (shell/web.mjs).
// The page (web/src/station.ts) says which addresses get which app's skin (STATION > SKIN per service) and the
// app's theme; this file builds the CSS and puts it into those pages with webContents.insertCSS on every new
// page, and swaps it when the theme changes. Nothing else on the page is touched (no scripts).
//
// CSS: shell/skins/<file>.css per app, written against the --rc-* variables below, so one file serves all three
// themes. base.css (frame, scrollbars, selection) goes on every skinned page. Readability first: where an app's
// own colors could not be made readable, its file leaves them alone and only base.css applies (generic.css).
// Fonts are embedded as data: URLs (VT323 from node_modules, Antonio from the LCARS theme's folder when present):
// a page's own Content-Security-Policy usually allows data: fonts and never our server.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// App kind (shared/station.ts) -> CSS file in shell/skins/. Others: generic.
export const SKIN_FILES = {
  nextcloud: 'nextcloud',
  'nextcloud-aio': 'nextcloud',
  immich: 'immich',
  plex: 'plex',
  sonarr: 'arr',
  radarr: 'arr',
  prowlarr: 'arr',
  lidarr: 'arr',
  readarr: 'arr',
  unraid: 'unraid',
};
// Skins that recolor the whole page dark; only these get the faint scanlines (on a light page they cost readability).
const DARK_PAGES = new Set(['nextcloud', 'immich', 'plex', 'arr']);

const MONO = "'Cascadia Mono', 'JetBrains Mono', 'JetBrainsMono Nerd Font', Consolas, 'DejaVu Sans Mono', ui-monospace, monospace";

// The app's themes (web/src/theme.css amber and green; web/src/themes/lcars.css). rgb: "r, g, b" for rgba();
// tri: "r g b" for apps that use rgb(var(--x) / alpha); logo: a filter that turns a white logo into the theme color.
export const PALETTES = {
  amber: {
    bgRgb: '11, 7, 0', tri: { bg: '11 7 0', fg: '255 176 0', gray: '21 14 3', primary: '255 176 0', dim: '176 124 8', alert: '255 106 77', ok: '255 214 138' },
    bg: '#0b0700', raise: '#150e03', deep: '#070400', hover: '#231707', text: '#ffb000', bright: '#ffd68a', dim: '#b07c08', rgb: '255, 176, 0',
    head: '#ffd68a', primary: '#ffb000', onPrimary: '#0b0700', second: '#b07c08', onSecond: '#0b0700', alert: '#ff6a4d', ok: '#ffd68a',
    font: MONO, display: "'RC VT323', " + MONO, radius: '0px', pill: '0px', frame: '#ffb000', frameW: '2px', frameTop: '2px', frameSide: '2px', frameR: '0px',
    glow: '0 0 6px rgba(255, 176, 0, 0.35)', logo: 'sepia(1) brightness(0.62) saturate(56.5) hue-rotate(-17deg)',
  },
  green: {
    bgRgb: '1, 10, 3', tri: { bg: '1 10 3', fg: '51 255 102', gray: '4 20 10', primary: '51 255 102', dim: '35 168 69', alert: '255 106 77', ok: '182 255 201' },
    bg: '#010a03', raise: '#04140a', deep: '#000501', hover: '#082012', text: '#33ff66', bright: '#b6ffc9', dim: '#23a845', rgb: '51, 255, 102',
    head: '#b6ffc9', primary: '#33ff66', onPrimary: '#010a03', second: '#23a845', onSecond: '#010a03', alert: '#ff6a4d', ok: '#b6ffc9',
    font: MONO, display: "'RC VT323', " + MONO, radius: '0px', pill: '0px', frame: '#33ff66', frameW: '2px', frameTop: '2px', frameSide: '2px', frameR: '0px',
    glow: '0 0 6px rgba(51, 255, 102, 0.35)', logo: 'sepia(1) brightness(0.88) saturate(16) hue-rotate(59deg)',
  },
  lcars: {
    bgRgb: '0, 0, 0', tri: { bg: '0 0 0', fg: '255 204 153', gray: '17 15 26', primary: '255 153 0', dim: '170 165 216', alert: '255 85 68', ok: '255 204 102' },
    bg: '#000000', raise: '#110f1a', deep: '#000000', hover: '#1d1a2c', text: '#ffcc99', bright: '#ffe7cf', dim: '#aaa5d8', rgb: '163, 160, 232',
    head: '#ff9900', primary: '#ff9900', onPrimary: '#000000', second: '#cc99cc', onSecond: '#000000', alert: '#ff5544', ok: '#ffcc66',
    font: "system-ui, 'Segoe UI', Roboto, 'Noto Sans', sans-serif", display: "'Antonio', 'Bahnschrift', 'Roboto Condensed', 'Arial Narrow', sans-serif",
    radius: '14px', pill: '999px', frame: '#ff9900', frameW: '10px', frameTop: '5px', frameSide: '0px', frameR: '26px',
    glow: 'none', logo: 'sepia(1) brightness(0.66) saturate(20) hue-rotate(-23deg)',
  },
};

const files = new Map();
function read(name) {
  if (!files.has(name)) {
    let css = '';
    try {
      css = readFileSync(join(HERE, 'skins', `${name}.css`), 'utf8');
    } catch {
      /* missing file: no skin rules */
    }
    files.set(name, css);
  }
  return files.get(name);
}

// A font file as a data: URL @font-face, or '' when the file is not there.
const faces = new Map();
function face(family, rel, weight = 400) {
  const key = `${family}|${rel}|${weight}`;
  if (!faces.has(key)) {
    const file = join(ROOT, rel);
    faces.set(key, existsSync(file) ? `@font-face { font-family: ${family}; font-weight: ${weight}; font-display: block; src: url(data:font/woff2;base64,${readFileSync(file).toString('base64')}) format('woff2'); }` : '');
  }
  return faces.get(key);
}

function fonts(theme) {
  if (theme === 'lcars') return [face("'Antonio'", 'web/src/fonts/antonio/antonio-latin-400-normal.woff2'), face("'Antonio'", 'web/src/fonts/antonio/antonio-latin-700-normal.woff2', 700)].join('\n');
  return face("'RC VT323'", 'node_modules/@fontsource/vt323/files/vt323-latin-400-normal.woff2');
}

function vars(p) {
  return `:root, :root body, [data-themes] {
  --rc-bg: ${p.bg}; --rc-raise: ${p.raise}; --rc-deep: ${p.deep}; --rc-hover: ${p.hover};
  --rc-text: ${p.text}; --rc-bright: ${p.bright}; --rc-dim: ${p.dim}; --rc-rgb: ${p.rgb};
  --rc-line: rgba(${p.rgb}, 0.32); --rc-faint: rgba(${p.rgb}, 0.12);
  --rc-head: ${p.head}; --rc-primary: ${p.primary}; --rc-on-primary: ${p.onPrimary}; --rc-second: ${p.second}; --rc-on-second: ${p.onSecond};
  --rc-alert: ${p.alert}; --rc-ok: ${p.ok};
  --rc-font: ${p.font}; --rc-display: ${p.display};
  --rc-radius: ${p.radius}; --rc-pill: ${p.pill};
  --rc-frame: ${p.frame}; --rc-frame-w: ${p.frameW}; --rc-frame-top: ${p.frameTop}; --rc-frame-side: ${p.frameSide}; --rc-frame-r: ${p.frameR};
  --rc-glow: ${p.glow}; --rc-logo-filter: ${p.logo}; --rc-bg-rgb: ${p.bgRgb}; --rc-alert-rgb: ${p.tri.alert.replaceAll(' ', ', ')};
  --rc-t-bg: ${p.tri.bg}; --rc-t-fg: ${p.tri.fg}; --rc-t-gray: ${p.tri.gray}; --rc-t-primary: ${p.tri.primary};
  --rc-t-dim: ${p.tri.dim}; --rc-t-alert: ${p.tri.alert}; --rc-t-ok: ${p.tri.ok};
}`;
}

// Faint scanlines, only when the app's CRT effect is on (never LCARS, a flat theme). Static: no animation.
function scanlines(crt) {
  const a = crt === 'high' ? 0.12 : 0.07;
  return `html::before { content: ''; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
  background: repeating-linear-gradient(to bottom, transparent 0, rgba(0, 0, 0, ${a}) 1px, transparent 3px); }`;
}

export const isSkinTheme = (t) => Object.hasOwn(PALETTES, t);

// The whole CSS for one app kind in one theme.
export function skinCss(kind, theme = 'amber', crt = 'off') {
  const t = isSkinTheme(theme) ? theme : 'amber';
  const file = SKIN_FILES[kind] ?? 'generic';
  const parts = [fonts(t), vars(PALETTES[t]), read('base'), read(file)];
  if (t !== 'lcars' && DARK_PAGES.has(file) && (crt === 'low' || crt === 'high')) parts.push(scanlines(crt));
  return parts.filter(Boolean).join('\n');
}

// From the page: { theme, crt, sites: [{ origin, kind }] }. Anything odd is dropped.
function clean(cfg) {
  const out = { theme: 'amber', crt: 'off', sites: [] };
  if (!cfg || typeof cfg !== 'object') return out;
  if (isSkinTheme(cfg.theme)) out.theme = cfg.theme;
  if (['off', 'low', 'high'].includes(cfg.crt)) out.crt = cfg.crt;
  if (Array.isArray(cfg.sites)) {
    for (const s of cfg.sites.slice(0, 100)) {
      if (typeof s?.origin !== 'string' || typeof s.kind !== 'string' || !/^[a-z-]{1,32}$/.test(s.kind)) continue;
      try {
        const u = new URL(s.origin);
        if (/^https?:$/.test(u.protocol) && !out.sites.some((x) => x.origin === u.origin)) out.sites.push({ origin: u.origin, kind: s.kind });
      } catch {
        /* not an address */
      }
    }
  }
  return out;
}

// One per desktop app window. attach(wc) for every site pane; set(cfg) when the page sends the list or theme.
export function skinner() {
  let cfg = clean(null);
  const panes = new Map(); // webContents -> { key, ids }: the CSS in its current page

  const wanted = (wc) => {
    let origin = '';
    try {
      origin = new URL(wc.getURL()).origin;
    } catch {
      return null;
    }
    const site = cfg.sites.find((s) => s.origin === origin);
    return site ? { kind: site.kind, key: `${site.kind}|${cfg.theme}|${cfg.crt}` } : null;
  };

  async function apply(wc) {
    const st = panes.get(wc);
    if (!st || wc.isDestroyed()) return;
    const want = wanted(wc);
    const key = want?.key ?? '';
    if (key === st.key) return;
    st.key = key;
    const old = st.ids;
    st.ids = [];
    for (const id of old) await wc.removeInsertedCSS(id).catch(() => {});
    if (!want || wc.isDestroyed()) return;
    const id = await wc.insertCSS(skinCss(want.kind, cfg.theme, cfg.crt), { cssOrigin: 'author' }).catch(() => null);
    // The page changed while the CSS went in: the next event puts it in again.
    if (id && panes.get(wc) === st && st.key === key) st.ids.push(id);
  }

  return {
    set(next) {
      cfg = clean(next);
      for (const wc of panes.keys()) void apply(wc);
    },
    attach(wc) {
      if (panes.has(wc)) return;
      const st = { key: '', ids: [] };
      panes.set(wc, st);
      // A new page has none of the old page's CSS: start over. dom-ready covers a page that was still loading.
      wc.on('did-navigate', () => {
        st.key = '';
        st.ids = [];
        void apply(wc);
      });
      wc.on('dom-ready', () => void apply(wc));
      wc.once('destroyed', () => panes.delete(wc));
    },
    config: () => cfg,
  };
}
