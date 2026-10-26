import './settings.css';
import { alertsSection } from './alerts.ts';
import { funSection } from './funsection.ts';
import { securitySection } from './security.ts';
import { THEMES, isThemeId, themeOf, type Theme, type ThemeId } from './themes.ts';
import { button, el } from './ui.ts';
import { voiceSection } from './voicesettings.ts';

// Display and sound settings, kept in this browser (localStorage).
// The inline script in index.html / login.html applies theme, crt and size before first paint;
// keep its key and values in step with this file.
// Fires 'themechange' on window when colors or glow change, so canvas sprites can repaint.

export type Settings = {
  theme: ThemeId; // themes.ts. Saved as 'phosphor' (amber | green) before there were other themes.
  crt: 'off' | 'low' | 'high';
  sound: boolean;
  size: 's' | 'm' | 'l';
  accent: 'cyan' | 'pink' | 'off';
};

const KEY = 'phosphor.settings';

let current: Settings = load();
const listeners = new Set<(s: Settings, changed: keyof Settings) => void>();

export function getSettings(): Settings {
  return current;
}

export function onSettings(fn: (s: Settings, changed: keyof Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage blocked: the setting still works until reload */
  }
  apply();
  if (key === 'theme' || key === 'crt' || key === 'accent') window.dispatchEvent(new Event('themechange'));
  for (const fn of listeners) fn(current, key);
}

function load(): Settings {
  let saved: Partial<Settings> & { phosphor?: unknown } = {};
  try {
    saved = (JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Settings>) ?? {};
  } catch {
    /* blocked or bad JSON: defaults */
  }
  return {
    theme: isThemeId(saved.theme) ? saved.theme : saved.phosphor === 'green' ? 'green' : 'amber',
    crt: saved.crt === 'off' || saved.crt === 'low' ? saved.crt : 'high',
    sound: saved.sound !== false,
    size: saved.size === 's' || saved.size === 'l' ? saved.size : 'm',
    accent: saved.accent === 'pink' || saved.accent === 'off' ? saved.accent : 'cyan',
  };
}

function apply(): void {
  const d = document.documentElement;
  const t = themeOf(current.theme);
  d.dataset.theme = t.id;
  if (t.phosphor) d.dataset.phosphor = t.id;
  else delete d.dataset.phosphor;
  // A flat theme shows no CRT effects; the saved level stays for the other themes.
  d.dataset.crt = t.crt ? current.crt : 'off';
  d.dataset.size = current.size;
  d.dataset.accent = current.accent;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.screen);
}

// Scanlines look even only when their period is a whole number of device pixels (Windows 125% scaling, phones).
function snapScanlines(): void {
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(2, Math.round(3 * dpr)) / dpr;
  document.documentElement.style.setProperty('--scan-h', `${px.toFixed(4)}px`);
}

type Choice<K extends keyof Settings> = { label: string; value: Settings[K]; title?: string };

export function mountSettings(root: HTMLElement): void {
  const before = document.documentElement.dataset.theme;
  apply();
  if (before !== current.theme) window.dispatchEvent(new Event('themechange'));
  snapScanlines();
  window.addEventListener('resize', snapScanlines);

  const open = button('SETTINGS', () => toggle(), 'settings-btn');
  open.setAttribute('aria-haspopup', 'true');
  open.setAttribute('aria-expanded', 'false');
  open.title = 'Display and sound settings';

  const pop = el('div', 'settings-pop');
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Settings');

  const rows: (() => void)[] = [];
  // usedBy: rows that only some themes use (CRT, accent) go dim with a note under the others; the choice is kept.
  const row = <K extends keyof Settings>(label: string, key: K, choices: Choice<K>[], usedBy?: keyof Pick<Theme, 'crt' | 'accent'>) => {
    const r = el('div', 'set-row');
    const seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', label);
    const btns = choices.map((c) => {
      const b = button(c.label, () => setSetting(key, c.value));
      if (c.title) b.title = c.title;
      return b;
    });
    seg.append(...btns);
    const note = el('div', 'set-note');
    note.hidden = true;
    const sync = () => {
      const t = themeOf(current.theme);
      const used = !usedBy || t[usedBy];
      btns.forEach((b, i) => {
        const on = current[key] === choices[i].value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
        b.disabled = !used;
      });
      r.classList.toggle('set-unused', !used);
      note.hidden = used;
      note.textContent = used ? '' : `Not used by ${t.label}. Kept for the other themes.`;
    };
    rows.push(sync);
    r.append(el('div', 'set-label', label), seg, note);
    return r;
  };

  pop.append(
    el('div', 'set-head', 'SETTINGS'),
    row(
      'THEME',
      'theme',
      THEMES.map((t) => ({ label: t.label, value: t.id, title: t.title })),
    ),
    row(
      'CRT EFFECTS',
      'crt',
      [
        { label: 'OFF', value: 'off', title: 'Flat screen, no glow' },
        { label: 'LOW', value: 'low', title: 'Soft scanlines and glow' },
        { label: 'HIGH', value: 'high', title: 'Scanlines, glow, curve and flicker' },
      ],
      'crt',
    ),
    row(
      'ACCENT COLOR',
      'accent',
      [
        { label: 'CYAN', value: 'cyan' },
        { label: 'PINK', value: 'pink' },
        { label: 'OFF', value: 'off', title: 'Phosphor only' },
      ],
      'accent',
    ),
    row('SOUND', 'sound', [
      { label: 'ON', value: true },
      { label: 'OFF', value: false },
    ]),
    row('TEXT SIZE', 'size', [
      { label: 'S', value: 's', title: 'Small text' },
      { label: 'M', value: 'm', title: 'Medium text' },
      { label: 'L', value: 'l', title: 'Large text' },
    ]),
    funSection(),
    securitySection(),
    alertsSection(),
    voiceSection(),
    el('div', 'set-foot', 'Display settings are saved in this browser.'),
  );
  const syncAll = () => rows.forEach((f) => f());
  syncAll();
  onSettings(syncAll);

  const onOutside = (e: PointerEvent) => {
    if (!root.contains(e.target as Node)) toggle(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      toggle(false);
      open.focus();
    }
  };
  function toggle(show = pop.hidden === true): void {
    pop.hidden = !show;
    open.classList.toggle('on', show);
    open.setAttribute('aria-expanded', String(show));
    if (show) {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey);
    } else {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
    }
  }

  root.replaceChildren(open, pop);
}
