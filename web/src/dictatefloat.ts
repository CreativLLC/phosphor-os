import './theme.css';
import './dictatefloat.css';
import { cleanUp, finalText, joinPhrase } from '../../shared/dictate.mjs';
import type { TranscribeResponse, VoiceLiveEvent } from '../../shared/protocol.ts';
import { shellApi } from './shellapi.ts';
import { loadWorklet, micError, openMic, Recorder, toWav } from './voice.ts';

// The floating mic of the desktop app on Windows and Mac (shell/dictate.mjs makes its 64 x 64 window, which never
// takes the keyboard). Click: start; click again: the words go into the app in front (the desktop app pastes them).
// Right click: its menu. Drag: move it. Ctrl+Alt+D does what a click does. A take is DICTATE's (voice.ts): the mic as
// 16 kHz PCM over /ws/voice, phrases as they come; at the stop the last one, then CLEAN UP if it is on, then the paste.
// If the live socket fails, the whole take goes to /api/transcribe at the stop.
// ?demo=idle|listening|working|done|error shows that look and does nothing (for screenshots).

type Look = 'idle' | 'listening' | 'working' | 'done' | 'error';
type Take = { ctx: AudioContext; ws: WebSocket | null; rec: Recorder | null; chunks: Int16Array<ArrayBuffer>[]; sent: number; text: string; finished: (ok: boolean) => void; done: Promise<boolean> };

const DONE_TIMEOUT_MS = 30_000;
const ONE_SHOT_MAX = 300 * 16000;
const mic = document.getElementById('mic') as HTMLButtonElement;
let take: Take | null = null;
let busy = false;
let flashTimer = 0;

function look(state: Look, why = ''): void {
  mic.dataset.state = state;
  mic.title = why || 'DICTATE in any app: click, talk, click again (or Ctrl+Alt+D). Right click: options. Drag: move.';
  clearTimeout(flashTimer);
  if (state === 'done' || state === 'error') flashTimer = window.setTimeout(() => look('idle'), state === 'done' ? 1200 : 4000);
  if (state !== 'listening') mic.style.setProperty('--level', '0');
}

function fail(why: string): void {
  look('error', why);
  if ('Notification' in window) new Notification('DICTATE', { body: why, silent: true });
}

async function start(): Promise<void> {
  // The audio context now, inside the click or key press.
  const ctx = new AudioContext();
  void ctx.resume();
  const worklet = loadWorklet(ctx);
  let finished: (ok: boolean) => void = () => {};
  const done = new Promise<boolean>((ok) => (finished = ok));
  const t: Take = { ctx, ws: null, rec: null, chunks: [], sent: 0, text: '', finished, done };
  take = t;
  look('listening');
  try {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice`);
    ws.binaryType = 'arraybuffer';
    t.ws = ws;
    ws.onopen = () => {
      while (t.sent < t.chunks.length) ws.send(t.chunks[t.sent++]);
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      const ev = JSON.parse(e.data) as VoiceLiveEvent;
      if (ev.t === 'final') t.text = joinPhrase(t.text, ev.text, ev.joinPrev);
      else if (ev.t === 'done') t.finished(true);
    };
    ws.onclose = () => t.finished(false);
  } catch {
    t.finished(false);
  }
  try {
    const stream = await openMic();
    t.rec = await Recorder.open(ctx, stream, worklet, (pcm, peak) => {
      t.chunks.push(pcm);
      if (t.ws?.readyState === WebSocket.OPEN) while (t.sent < t.chunks.length) t.ws.send(t.chunks[t.sent++]);
      mic.style.setProperty('--level', Math.max(0, Math.min(1, (20 * Math.log10(peak + 1e-9) + 60) / 60)).toFixed(2));
    });
  } catch (e) {
    t.ws?.close();
    void ctx.close().catch(() => {});
    take = null;
    fail(micError(e));
  }
}

async function stop(t: Take): Promise<void> {
  take = null;
  busy = true;
  look('working');
  try {
    await t.rec?.stop(); // the last blocks arrive first
    let live = false;
    if (t.ws?.readyState === WebSocket.OPEN) {
      while (t.sent < t.chunks.length) t.ws.send(t.chunks[t.sent++]);
      t.ws.send('{"t":"end"}');
      live = await Promise.race([t.done, new Promise<boolean>((late) => setTimeout(() => late(false), DONE_TIMEOUT_MS))]);
    }
    t.ws?.close();
    let text = t.text;
    if (!live) text = await oneShot(t.chunks);
    if (!text.trim()) return look('error', 'NOTHING HEARD');
    const settings = await shellApi?.dictate?.().catch(() => null);
    if (settings?.cleanup) text = (await cleanUp(text)).text; // any failure: the words as they were
    const r = (await shellApi?.dictatePaste?.(finalText(text))) ?? 'failed';
    if (r === 'pasted') look('done');
    else if (r === 'copied') fail('Could not press the paste key (Mac: allow Phosphor-OS under Accessibility). The words are on the clipboard.');
    else fail('Could not put the words in.');
  } catch (e) {
    fail(e instanceof Error ? e.message : 'Dictation failed.');
  } finally {
    busy = false;
  }
}

// The live socket failed: everything in one piece.
async function oneShot(chunks: Int16Array<ArrayBuffer>[]): Promise<string> {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  if (n < 0.3 * 16000) return '';
  if (n > ONE_SHOT_MAX) throw new Error('The live link broke and the take is over 5 minutes.');
  const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: toWav(chunks, 0) });
  const data = (await res.json().catch(() => ({ error: `error ${res.status}` }))) as TranscribeResponse;
  if (!res.ok || !('text' in data)) throw new Error('error' in data ? data.error : `Dictation failed (error ${res.status}).`);
  return data.text;
}

function toggle(): void {
  if (busy) return;
  if (take) void stop(take);
  else void start();
}

// A click toggles; a drag (past a few pixels) moves the window instead.
let press: { x: number; y: number; moved: boolean } | null = null;
mic.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, moved: false };
  mic.setPointerCapture(e.pointerId);
});
mic.addEventListener('pointermove', (e) => {
  if (!press) return;
  const dx = e.screenX - press.x;
  const dy = e.screenY - press.y;
  if (!press.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
  if (!press.moved) shellApi?.dictateDrag?.('start', 0, 0);
  press.moved = true;
  shellApi?.dictateDrag?.('move', dx, dy);
});
mic.addEventListener('pointerup', (e) => {
  if (!press) return;
  const p = press;
  press = null;
  if (p.moved) shellApi?.dictateDrag?.('end', e.screenX - p.x, e.screenY - p.y);
  else toggle();
});
mic.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  shellApi?.dictateMenu?.();
});
shellApi?.onDictateCommand?.((c) => c === 'toggle' && toggle());

const demo = new URLSearchParams(location.search).get('demo');
if (demo && ['idle', 'listening', 'working', 'done', 'error'].includes(demo)) {
  look(demo as Look, demo === 'error' ? 'NOTHING HEARD' : '');
  clearTimeout(flashTimer);
  if (demo === 'listening') mic.style.setProperty('--level', '0.6');
} else look('idle');
