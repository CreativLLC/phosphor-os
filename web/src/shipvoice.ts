import { funSettings, onFun } from './funsettings.ts';
import { getSettings } from './settings.ts';
import { chunks, speakable } from './speech.ts';
import { store } from './store.ts';
import { el } from './ui.ts';

// SHIP VOICE: reads Claude's finished reply aloud (SETTINGS > VOICE OUT: OFF / SHORT / FULL) with the
// browser's own speech (speechSynthesis), low and steady like a ship's computer. Text rules live in speech.ts.
// - Only the active tab's reply, and only on the device that is visible and focused, so the PC and the
//   phone never both talk.
// - Stops on any key (typing, Esc), STOP, SEND, DICTATE, a new message, the page hiding, or STOP VOICE.
// - Browsers only speak after the page has had a tap or key press; before that nothing plays.

const PITCH = 0.7;
const RATE = 0.95;
const CHIME_MS = 330;
const STOPPED_GRACE_MS = 5000; // a turn ended by STOP is not read out

let session = 0;
let speaking = false;
let chimeTimer = 0;
let watchdog = 0;
let chip: HTMLButtonElement | null = null;
let stoppedAt = 0;
let lastSpoken = '';

const synth = (): SpeechSynthesis | null => ('speechSynthesis' in window ? window.speechSynthesis : null);

export function voiceSupported(): boolean {
  return !!synth() && typeof window.SpeechSynthesisUtterance === 'function';
}

// ---------- Voices ----------

// Flat, classic voices first (they sound like a machine); the newer "natural" ones sound like a person.
const PREFER = [/\bdavid\b/i, /\bmark\b/i, /\bgeorge\b/i, /\bzira\b/i, /\bhazel\b/i, /google uk english male/i, /google us english/i, /\bdaniel\b/i, /\bfred\b/i, /\balex\b/i];

function score(v: SpeechSynthesisVoice): number {
  let s = v.localService ? 100 : 0; // on this device: no network, starts at once
  const lang = v.lang.replace('_', '-').toLowerCase();
  if (lang === 'en-us' || lang === 'en-gb') s += 20;
  const i = PREFER.findIndex((re) => re.test(v.name));
  if (i >= 0) s += 50 - i * 4;
  if (/natural|neural|online|wavenet/i.test(v.name)) s -= 30;
  return s;
}

// English voices, best first (any voice if there is no English one).
export function fittingVoices(): SpeechSynthesisVoice[] {
  const all = synth()?.getVoices() ?? [];
  const en = all.filter((v) => /^en([-_]|$)/i.test(v.lang));
  return (en.length ? en : all).slice().sort((a, b) => score(b) - score(a));
}

export function voiceLabel(v: SpeechSynthesisVoice): string {
  const name = v.name.replace(/^(Microsoft|Google|Apple)\s+/i, '').replace(/\s+-\s+.*$/, '');
  return `${name} (${v.lang.replace('_', '-')})`.toUpperCase();
}

function pickVoice(): SpeechSynthesisVoice | null {
  const list = fittingVoices();
  return list.find((v) => v.voiceURI === funSettings().voice) ?? list[0] ?? null;
}

// Voice lists load late in Chrome; SETTINGS redraws its picker when they arrive.
export function onVoices(fn: () => void): void {
  synth()?.addEventListener?.('voiceschanged', fn);
}

// ---------- Chime (own tiny WebAudio, same style as sound.ts) ----------

let actx: AudioContext | null = null;
let actxSleep = 0;

function chime(): void {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try {
    actx ??= new AC();
  } catch {
    return;
  }
  const a = actx;
  void a.resume().catch(() => {});
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  lp.connect(a.destination);
  // Two short falling notes: "message follows".
  [
    [1175, 0, 0.07],
    [784, 0.09, 0.14],
  ].forEach(([f, at, dur]) => {
    const t = a.currentTime + 0.01 + at;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.03);
  });
  // Let the audio thread sleep again once the chime is over.
  clearTimeout(actxSleep);
  actxSleep = window.setTimeout(() => void a.suspend().catch(() => {}), 800);
}

// ---------- Speak / stop ----------

export function isSpeaking(): boolean {
  return speaking;
}

function showChip(on: boolean): void {
  if (on && !chip) {
    chip = el('button', 'voice-chip', 'STOP VOICE');
    chip.type = 'button';
    chip.title = 'Stop reading aloud (any key stops it too)';
    chip.onclick = () => stopVoice();
    document.body.append(chip);
  }
  if (!chip) return;
  if (on) chip.style.top = `${Math.round((document.getElementById('top')?.getBoundingClientRect().bottom ?? 0) + 10)}px`;
  chip.hidden = !on;
}

function finish(token: number): void {
  if (token !== session) return;
  speaking = false;
  clearInterval(watchdog);
  showChip(false);
}

// Speak now. Replaces anything already being read.
export function speak(text: string): void {
  const s = synth();
  if (!s || !voiceSupported()) return;
  stopVoice();
  const parts = chunks(text);
  if (!parts.length) return;
  const token = ++session;
  const voice = pickVoice();
  speaking = true;
  showChip(true);
  const go = () => {
    if (token !== session) return;
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.pitch = PITCH;
      u.rate = RATE;
      if (i === parts.length - 1) {
        u.onend = () => finish(token);
        u.onerror = () => finish(token);
      }
      s.speak(u);
    });
    // Some engines never fire onend: notice the queue running dry.
    clearInterval(watchdog);
    watchdog = window.setInterval(() => {
      if (!s.speaking && !s.pending) finish(token);
    }, 1500);
  };
  if (funSettings().chime && getSettings().sound) {
    chime();
    chimeTimer = window.setTimeout(go, CHIME_MS);
  } else go();
}

export function stopVoice(): void {
  if (!speaking) return;
  session++;
  speaking = false;
  clearTimeout(chimeTimer);
  clearInterval(watchdog);
  synth()?.cancel();
  showChip(false);
}

// ---------- Reading finished replies ----------

function replyText(tabId: string): { id: string; text: string } | null {
  const items = store.tabs.get(tabId)?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user') return null; // nothing from Claude since your last message
    if (it.kind === 'claude' && it.text.trim()) return { id: it.id, text: it.text };
  }
  return null;
}

function onTurnEnd(tabId: string): void {
  const mode = funSettings().voiceOut;
  if (mode === 'off' || funSettings().game || tabId !== store.active) return;
  if (Date.now() - stoppedAt < STOPPED_GRACE_MS) return;
  // The device you are looking at speaks; the others stay quiet.
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
  const r = replyText(tabId);
  if (!r) return;
  const text = speakable(r.text, mode);
  const key = `${r.id}|${text}`;
  if (!text || key === lastSpoken) return;
  lastSpoken = key;
  speak(text);
}

export function initShipVoice(): void {
  if (!voiceSupported()) return;

  const busy = new Map<string, boolean>();
  let primed = false;
  store.on((c) => {
    if (c.kind === 'item' && c.op === 'add' && c.item.kind === 'user') stopVoice();
    if (c.kind !== 'tabs') return;
    for (const t of store.tabs.values()) {
      if (primed && busy.get(t.meta.id) && !t.meta.busy) onTurnEnd(t.meta.id);
      busy.set(t.meta.id, t.meta.busy);
    }
    primed = true;
  });

  // Any key stops it (typing, Esc, Ctrl+Space for DICTATE). Lone modifier keys do not.
  window.addEventListener(
    'keydown',
    (e) => {
      if (speaking && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) stopVoice();
    },
    true,
  );
  window.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Element | null;
      if (t?.closest?.('#stop')) stoppedAt = Date.now();
      if (speaking && t?.closest?.('#stop, #send, #dictate')) stopVoice();
    },
    true,
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopVoice();
  });
  onFun((s, changed) => {
    if ((changed === 'voiceOut' && s.voiceOut === 'off') || (changed === 'game' && s.game)) stopVoice();
  });

  // DICTATE started some other way (phone tap, shortcut): its button shows the state.
  const dictate = document.getElementById('dictate');
  if (dictate) {
    new MutationObserver(() => {
      const st = dictate.dataset.state;
      if (st === 'starting' || st === 'rec') stopVoice();
    }).observe(dictate, { attributes: true, attributeFilter: ['data-state'] });
  }
}
