import { getSettings, onSettings } from './settings.ts';
import { store } from './store.ts';
import { currentTheme } from './themes.ts';

// Soft terminal blips, made with WebAudio (no sound files).
// - key blip when you send a message or press a card button
// - two-tone alert when a tab starts waiting for you (permission or question)
// - short chime when Claude finishes in a tab
// Phosphor themes get square-wave blips; LCARS gets short sine chirps that slide in pitch (themes.ts 'sounds').
// Also puts "(!) " in front of the page title while any tab is waiting.
// Browsers only allow sound after the user has tapped or pressed a key, so nothing plays before that.

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
let clean: GainNode | null = null; // chirps skip the low-pass: sine waves are soft already
let gestured = false;

function audio(): AudioContext | null {
  if (!gestured || !getSettings().sound) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
    // Everything goes through a gentle low-pass so square waves sound like an old speaker, not a buzzer.
    const soften = ctx.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 2400;
    out = ctx.createGain();
    out.gain.value = 0.6;
    out.connect(soften);
    soften.connect(ctx.destination);
    clean = ctx.createGain();
    clean.gain.value = 0.6;
    clean.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

// glide: pitch at the end of the note (a chirp); omitted = steady.
function tone(freq: number, at: number, dur: number, type: OscillatorType, vol: number, glide?: number): void {
  const a = audio();
  const dest = glide === undefined ? out : clean;
  if (!a || !dest) return;
  const t = a.currentTime + 0.01 + at;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glide !== undefined) osc.frequency.exponentialRampToValueAtTime(glide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

type SoundSet = { key(): void; alert(): void; done(): void };

const SETS: Record<'blip' | 'chirp', SoundSet> = {
  blip: {
    key(): void {
      tone(1200, 0, 0.035, 'square', 0.03);
      tone(1800, 0.028, 0.03, 'square', 0.018);
    },
    alert(): void {
      tone(880, 0, 0.13, 'square', 0.045);
      tone(587, 0.16, 0.2, 'square', 0.045);
    },
    done(): void {
      tone(660, 0, 0.08, 'triangle', 0.09);
      tone(880, 0.08, 0.08, 'triangle', 0.09);
      tone(1320, 0.16, 0.16, 'triangle', 0.07);
    },
  },
  // Panel chirps: quick sine slides, a touch of triangle for body.
  chirp: {
    key(): void {
      tone(1480, 0, 0.045, 'sine', 0.07, 2350);
    },
    alert(): void {
      tone(1050, 0, 0.09, 'triangle', 0.07, 1400);
      tone(1400, 0.11, 0.09, 'triangle', 0.07, 1050);
      tone(1050, 0.22, 0.14, 'triangle', 0.06, 1400);
    },
    done(): void {
      tone(990, 0, 0.05, 'sine', 0.08, 1180);
      tone(1320, 0.065, 0.05, 'sine', 0.08, 1570);
      tone(1760, 0.13, 0.11, 'sine', 0.07, 2090);
    },
  },
};

const set = (): SoundSet => SETS[currentTheme().sounds];

export const sounds = {
  key: (): void => set().key(),
  alert: (): void => set().alert(),
  done: (): void => set().done(),
};

let lastAlert = 0;

export function initSound(): void {
  // Unlock audio on the first tap or key press (and wake it up again if the browser paused it).
  const wake = () => {
    gestured = true;
    if (getSettings().sound) audio();
  };
  window.addEventListener('pointerdown', wake, { capture: true, passive: true });
  window.addEventListener('keydown', wake, { capture: true, passive: true });

  // Turning sound on plays a blip so you know it works.
  onSettings((s, changed) => {
    if (changed === 'sound' && s.sound) sounds.done();
  });

  // Send blip. Capture phase, so the message box still has the text when we look.
  const input = () => document.getElementById('input') as HTMLTextAreaElement | null;
  document.addEventListener(
    'keydown',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.id !== 'input' || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (!matchMedia('(pointer: fine)').matches) return;
      if (store.active && input()?.value.trim()) sounds.key();
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('#send')) {
        if (store.active && input()?.value.trim()) sounds.key();
      } else if (t?.closest?.('.item .buttons button, .seg button')) {
        sounds.key();
      }
    },
    true,
  );

  // Alert and done chime from tab meta changes.
  const prev = new Map<string, { busy: boolean; attention: boolean }>();
  let primed = false;
  store.on((c) => {
    if (c.kind !== 'tabs') return;
    let alert = false;
    let done = false;
    for (const t of store.tabs.values()) {
      const p = prev.get(t.meta.id);
      if (primed) {
        if (t.meta.attention && !p?.attention) alert = true;
        if (p?.busy && !t.meta.busy) done = true;
      }
      prev.set(t.meta.id, { busy: t.meta.busy, attention: t.meta.attention });
    }
    for (const id of [...prev.keys()]) if (!store.tabs.has(id)) prev.delete(id);
    primed = true;

    if (alert && Date.now() - lastAlert > 1500) {
      lastAlert = Date.now();
      sounds.alert();
    } else if (done) {
      sounds.done();
    }
    updateTitle();
  });
  updateTitle();
}

function updateTitle(): void {
  const waiting = [...store.tabs.values()].some((t) => t.meta.attention);
  const base = document.title.replace(/^\(!\) /, '');
  const next = waiting ? `(!) ${base}` : base;
  if (document.title !== next) document.title = next;
}
