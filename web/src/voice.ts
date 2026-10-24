import type { TranscribeResponse, VoiceLiveEvent } from '../../shared/protocol.ts';
import { toast } from './ui.ts';
import { shellApi } from './shellapi.ts';

// DICTATE: press the button or Ctrl+Space, talk, press again. Esc cancels. Nothing is sent on its own.
//
// Live: the mic audio streams to the PC over the WebSocket /ws/voice as you talk (16 kHz mono 16-bit,
// about 32 KB a second). The PC cuts it into phrases at pauses: while a phrase is being spoken, a dim
// preview line above the message box shows what it hears so far; when you pause, the whole phrase is
// decoded once more and goes into the message box at the cursor. Stopping turns the last phrase into text.
// If the socket can't connect or breaks, the take still finishes: the audio not yet turned into text is
// sent in one piece to POST /api/transcribe when you stop.
//
// PERF: the audio thread (AudioWorklet) resamples to 16 kHz and posts one 100 ms block of 16-bit samples
// at a time with its peak level. The page only forwards blocks to the socket, moves the level bar
// (transform), ticks the clock once a second and sets the preview text about once a second.
//
// Each take's timing (tap to mic, audio, socket, first words) goes to the PC when the take ends:
// data/voice-diag.log, one line per take, to find what makes a start slow on the phone.

const RATE = 16000;
const MAX_MS = 10 * 60_000; // the server takes up to 10 minutes live
const ONE_SHOT_MAX = 300 * RATE; // the fallback takes up to 5 minutes
const TAIL_MS = 150; // keep listening this long after stop, so the last word is not clipped
const MIN_SAMPLES = 0.3 * RATE;
const DONE_TIMEOUT_MS = 30_000;
const STOP_WAIT_MS = 6000; // SEND waits this long for the last words
const FETCH_TIMEOUT_MS = 130_000;
const RESUME_WAIT_MS = 2000; // a phone's audio engine that has not woken by then: go on, it may wake later
const WAKE_HINT_MS = 700; // engine not ready this long after the socket opens: say it is loading
const HOTKEY = 'Ctrl+Space';

type State = 'idle' | 'starting' | 'rec' | 'busy';

// One recording, from press to text.
type Take = {
  id: number;
  chunks: Int16Array<ArrayBuffer>[]; // everything recorded (kept for the fallback)
  samples: number;
  sent: number; // chunks sent on the socket
  ws: WebSocket | null;
  live: boolean | null; // null while the socket connects; false once it failed or broke
  finalEnd: number; // samples already turned into text
  stopped: boolean;
  done: boolean;
  doneTimer: number;
  inserted: boolean; // some text went into the message box
  ready: boolean; // the PC's voice engine is loaded (audio sent before that waits on the PC)
  waking: boolean; // the preview line says the engine is loading
  why: string; // how the take ended, for the timing log
  t0: number; // the tap
  marks: Record<string, number>; // ms after the tap
  info: Record<string, string | number | boolean>;
  lag: number; // the page's longest stall while the mic started, ms
  lagTimer: number;
  reported: boolean;
};

// First time only: ms from the tap to this step.
function mark(t: Take, name: string): void {
  t.marks[name] ??= Math.round(performance.now() - t.t0);
}

// The take's timing, one line in data/voice-diag.log on the PC.
function report(t: Take, outcome: string): void {
  if (t.reported) return;
  t.reported = true;
  clearInterval(t.lagTimer);
  const body = JSON.stringify({ outcome, ms: t.marks, lag: Math.round(t.lag), ...t.info });
  fetch('/api/voice/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

let state: State = 'idle';
let btn: HTMLButtonElement;
let longLabel: HTMLElement;
let shortLabel: HTMLElement;
let meter: HTMLElement;
let input: HTMLTextAreaElement;
let liveLine: HTMLElement;
let liveText: HTMLElement;
let rec: Recorder | null = null;
let take: Take | null = null;
let abort: AbortController | null = null;
let startedAt = 0;
let clock = 0;
let session = 0; // bumps on every start/cancel, so a late answer from an old take is ignored

// One button and the text box its words go into. The chat's message box is the main one; another screen (LAB's
// prompt) can borrow dictation for its own box while it shows (useDictation).
type Target = { btn: HTMLButtonElement; input: HTMLTextAreaElement; longLabel: HTMLElement; shortLabel: HTMLElement; meter: HTMLElement };
let mainTarget: Target;

function dress(button: HTMLButtonElement, box: HTMLTextAreaElement, where: string): Target {
  button.replaceChildren();
  button.classList.add('dict-btn');
  const dot = document.createElement('span');
  dot.className = 'dict-dot';
  dot.textContent = '●';
  dot.setAttribute('aria-hidden', 'true');
  const t: Target = { btn: button, input: box, longLabel: document.createElement('span'), shortLabel: document.createElement('span'), meter: document.createElement('span') };
  t.longLabel.className = 'dict-long';
  t.shortLabel.className = 'dict-short';
  t.meter.className = 'dict-meter';
  t.meter.setAttribute('aria-hidden', 'true');
  button.append(dot, t.longLabel, t.shortLabel, t.meter);
  button.title = `Voice to text (${HOTKEY}). Press again to stop; Esc cancels. The words go into ${where}; nothing is sent.`;
  button.onclick = (e) => {
    if (btn !== button) use(t); // a borrowed button pressed after the main one took over again
    toggle(e);
  };
  return t;
}

function use(t: Target): void {
  ({ btn, input, longLabel, shortLabel, meter } = t);
  input.before(liveLine);
  render();
}

// Dictate into another box (LAB's prompt) until the returned function is called; then the chat has it again.
// A take still running in the other box is cancelled first.
export function useDictation(button: HTMLButtonElement, box: HTMLTextAreaElement): () => void {
  if (state !== 'idle') cancel();
  const t = dress(button, box, 'the prompt');
  use(t);
  return () => {
    if (btn !== button) return;
    if (state !== 'idle') cancel();
    use(mainTarget);
  };
}

export function mountVoice(button: HTMLButtonElement, box: HTMLTextAreaElement): void {
  // The dim preview line, just above the box being dictated into. Shown only while dictating.
  liveLine = document.createElement('div');
  liveLine.id = 'voice-live';
  liveLine.hidden = true;
  liveLine.setAttribute('aria-live', 'polite');
  liveText = document.createElement('span');
  liveLine.append(liveText);
  mainTarget = dress(button, box, 'the message box');
  use(mainTarget);

  // Ctrl+Space anywhere in the app; Esc cancels while dictating. Capture phase, so it runs first.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing) return;
      if (e.code === 'Space' && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) toggle(e);
      } else if (e.key === 'Escape' && state !== 'idle') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    },
    true,
  );
}

function toggle(e?: Event): void {
  if (state === 'idle') begin(e);
  else if (state === 'starting') cancel();
  else if (state === 'rec') void finish();
  else toast('Still turning your words into text…', 2000);
}

const idleWaiters: (() => void)[] = []; // stopDictation() calls waiting for the take to end

function setState(s: State): void {
  state = s;
  render();
  if (s === 'idle') for (const done of idleWaiters.splice(0)) done();
}

export const isDictating = (): boolean => state !== 'idle';

// SEND while dictating: stop, and wait (a few seconds at most) for the last words to land in the box.
// Words that come later still go into the box, after the message is sent.
export async function stopDictation(): Promise<void> {
  if (state === 'idle') return;
  if (state === 'starting') return cancel();
  const idle = new Promise<void>((done) => idleWaiters.push(done));
  if (state === 'rec') void finish();
  await Promise.race([idle, new Promise((late) => setTimeout(late, STOP_WAIT_MS))]);
}

function render(): void {
  btn.dataset.state = state;
  btn.classList.toggle('on', state !== 'idle');
  btn.setAttribute('aria-pressed', String(state === 'rec'));
  let long = 'DICTATE';
  let short = 'DICTATE';
  if (state === 'starting') long = short = 'MIC…';
  else if (state === 'rec') {
    const s = Math.floor((performance.now() - startedAt) / 1000);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    long = `REC ${t}`;
    short = t;
  } else if (state === 'busy') {
    long = 'TRANSCRIBING…';
    short = 'WAIT…';
  }
  longLabel.textContent = long;
  shortLabel.textContent = short;
  if (state !== 'rec') meter.style.transform = 'scaleX(0)';
  liveLine.hidden = state === 'idle' || state === 'starting';
  liveLine.parentElement?.classList.toggle('dictating', !liveLine.hidden);
}

// The preview line shows the newest words; when they don't fit, the start is cut off.
function setLive(text: string): void {
  const t = take;
  const empty = !text;
  let idle = 'Listening…';
  if (t?.live === false) idle = 'Listening… the words come when you stop.';
  else if (t?.waking) idle = 'Listening… the PC is loading the voice engine. Keep talking.';
  liveText.textContent = empty ? idle : text;
  liveLine.classList.toggle('empty', empty);
  liveLine.classList.toggle('overflow', !empty && liveText.scrollWidth > liveLine.clientWidth);
}

function begin(ev?: Event): void {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    toast('Dictation needs a secure address: open the app over https (Tailscale) or http://localhost.', 6000);
    return;
  }
  const id = ++session;
  const t0 = performance.now();
  // Make the audio context now, inside the click or key press, or phones keep it paused.
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    toast('This browser cannot record audio here.');
    return;
  }
  const t: Take = {
    id, chunks: [], samples: 0, sent: 0, ws: null, live: null, finalEnd: 0, stopped: false, done: false, doneTimer: 0, inserted: false,
    ready: false, waking: false, why: '', t0, marks: {}, lag: 0, lagTimer: 0, reported: false,
    info: {
      page: Math.round(t0), // ms since the page opened
      delay: ev ? Math.round(t0 - ev.timeStamp) : -1, // tap to this code running
      ctx0: ctx.state,
      rate: ctx.sampleRate,
      focus: document.hasFocus(),
      app: matchMedia('(display-mode: standalone)').matches,
    },
  };
  take = t;
  // While the phone starts the mic, also wake its audio engine and load the recorder code (each can take a
  // moment). The wake call has to be here, inside the tap.
  ctx.resume().then(() => mark(t, 'audio'), () => {});
  const worklet = loadWorklet(ctx);
  worklet.then(() => mark(t, 'worklet'), () => {});
  // How long the page itself stalls (busy drawing the chat, for example) while the mic starts.
  let last = t0;
  t.lagTimer = window.setInterval(() => {
    const now = performance.now();
    t.lag = Math.max(t.lag, now - last - 100);
    last = now;
  }, 100);
  setState('starting');
  setLive('');
  connect(t);
  // Some home-screen apps never show the browser's "allow the microphone?" question, so the mic just waits.
  const stuck = window.setTimeout(() => {
    if (id !== session || state !== 'starting') return;
    t.why = 'stuck';
    cancel();
    toast("The mic didn't start. Allow the microphone for this site in the browser (Firefox: open the site in a normal tab, tap the shield or lock by the address, set Microphone to Allow), then try again.", 12000);
  }, 12000);

  openMic()
    .then(async (stream) => {
      clearTimeout(stuck);
      mark(t, 'mic');
      if (id !== session) {
        stream.getTracks().forEach((s) => s.stop());
        void ctx.close();
        return;
      }
      rec = await Recorder.open(ctx, stream, worklet, (pcm, peak) => onAudio(t, pcm, peak));
      if (id !== session) {
        rec.close();
        rec = null;
        return;
      }
      clearInterval(t.lagTimer);
      mark(t, 'rec');
      t.info.ctx = ctx.state;
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (id === session && state === 'rec') void finish();
      });
      startedAt = performance.now();
      setState('rec');
      if (ctx.state === 'suspended') wakeOnTap(t, ctx);
      clock = window.setInterval(() => {
        if (performance.now() - startedAt >= MAX_MS) {
          toast('10-minute limit reached. Finishing now.');
          void finish();
        } else render();
      }, 1000);
    })
    .catch((e: unknown) => {
      clearTimeout(stuck);
      void ctx.close().catch(() => {});
      if (id !== session) return;
      t.why = `error: ${e instanceof Error ? `${e.name} ${e.message}` : String(e)}`.slice(0, 200);
      dropTake();
      setState('idle');
      toast(micError(e), 7000);
    });
}

// Firefox on Android sometimes keeps the audio engine paused even after the DICTATE tap: the mic is open but no
// sound arrives (5 takes 2026-10-19 to 10-23 heard nothing, "ctx suspended"). A second tap wakes it, so ask for
// one and wake it on any tap or key until it runs.
function wakeOnTap(t: Take, ctx: AudioContext): void {
  const kinds = ['pointerdown', 'touchend', 'click', 'keydown'];
  const wake = () => void ctx.resume().catch(() => {});
  const done = () => {
    for (const k of kinds) document.removeEventListener(k, wake, true);
    ctx.removeEventListener('statechange', onState);
  };
  const onState = () => {
    if (ctx.state === 'running') {
      mark(t, 'woke');
      if (take === t) setLive('');
      done();
    } else if (ctx.state === 'closed') done();
  };
  for (const k of kinds) document.addEventListener(k, wake, true);
  ctx.addEventListener('statechange', onState);
  setLive('Tap the chat once to start the mic.');
  toast('The mic is paused by the browser. Tap the chat once (not DICTATE) to start it.', 6000);
}

// ---- Live socket ----

function connect(t: Take): void {
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice`);
  } catch {
    liveFailed(t);
    return;
  }
  ws.binaryType = 'arraybuffer';
  t.ws = ws;
  ws.onopen = () => {
    if (t.id !== session) return ws.close();
    mark(t, 'ws');
    t.live = true;
    sendPending(t);
    if (t.stopped) sendEnd(t);
    // The engine is asleep (first use, or 20 minutes unused): say so, so the empty preview is not a worry.
    setTimeout(() => {
      if (t.id !== session || t.ready || t.live !== true) return;
      t.waking = true;
      setLive('');
    }, WAKE_HINT_MS);
  };
  ws.onmessage = (e) => {
    if (t.id !== session || typeof e.data !== 'string') return;
    let ev: VoiceLiveEvent;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (ev.t === 'ready') {
      mark(t, 'ready');
      t.ready = true;
      if (t.waking) {
        t.waking = false;
        setLive('');
      }
    } else if (ev.t === 'partial') {
      mark(t, 'partial');
      setLive(ev.text);
    } else if (ev.t === 'final') {
      mark(t, 'final');
      t.finalEnd = Math.max(t.finalEnd, ev.end);
      setLive('');
      insert(ev.text, ev.joinPrev);
    } else if (ev.t === 'done') {
      mark(t, 'done');
      t.finalEnd = Math.max(t.finalEnd, ev.end);
      t.done = true;
      clearTimeout(t.doneTimer);
      ws.close();
      if (state !== 'busy') return;
      if (!t.inserted) toast('No words heard. Try again a little closer to the mic.', 3000);
      endTake();
    }
    // 'error': the server closes the socket next; onclose handles it.
  };
  ws.onclose = () => {
    t.ws = null;
    if (t.done || t.id !== session) return;
    liveFailed(t);
  };
}

// The live socket did not connect (server not updated yet, engine missing) or broke. The take goes on;
// what is not yet text is sent in one piece when you stop.
function liveFailed(t: Take): void {
  if (t.live === false) return;
  mark(t, 'wsFail');
  t.live = false;
  t.waking = false;
  clearTimeout(t.doneTimer);
  if (state === 'busy') {
    void fallback(t);
    return;
  }
  setLive('');
  // Warm the model for the one-shot path; this also tells us when the engine is missing.
  fetch('/api/voice/warm', { method: 'POST' })
    .then(async (r) => {
      if (r.ok || t.id !== session) return;
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      cancel();
      toast(serverError(r.status, data.error), 7000);
    })
    .catch(() => {});
}

// Stop: every phrase becomes final, then the server says done. No answer in time -> fallback.
function sendEnd(t: Take): void {
  sendPending(t);
  t.ws?.send('{"t":"end"}');
  t.doneTimer = window.setTimeout(() => t.ws?.close(), DONE_TIMEOUT_MS); // onclose -> fallback
}

function sendPending(t: Take): void {
  const ws = t.ws;
  if (!t.live || ws?.readyState !== WebSocket.OPEN) return;
  while (t.sent < t.chunks.length) ws.send(t.chunks[t.sent++]);
}

function onAudio(t: Take, pcm: Int16Array<ArrayBuffer>, peak: number): void {
  if (t.id !== session) return;
  mark(t, 'sound');
  t.chunks.push(pcm);
  t.samples += pcm.length;
  sendPending(t);
  // About -60 dBFS (room hiss) shows nothing; 0 dBFS fills the bar.
  const level = Math.max(0, Math.min(1, (20 * Math.log10(peak + 1e-9) + 60) / 60));
  meter.style.transform = `scaleX(${level.toFixed(2)})`;
}

// ---- Stop, cancel ----

// Stop recording; the last phrase becomes text (live), or everything not yet text (fallback).
async function finish(): Promise<void> {
  const r = rec;
  const t = take;
  if (!r || !t || state !== 'rec') return;
  clearInterval(clock);
  mark(t, 'stop');
  setState('busy');
  await new Promise((ok) => setTimeout(ok, TAIL_MS));
  if (t.id !== session) return;
  try {
    await r.stop(); // the last blocks arrive through onAudio first
  } catch {
    /* use what we have */
  }
  rec = null;
  if (t.id !== session) return;
  t.stopped = true;
  if (t.live === true && t.ws?.readyState === WebSocket.OPEN) {
    sendEnd(t);
  } else if (t.live === false) {
    void fallback(t);
  }
  // live === null: still connecting; onopen sends "end", onclose falls back.
}

// One shot: everything after the last final, as a WAV to /api/transcribe.
async function fallback(t: Take): Promise<void> {
  if (t.id !== session || t.done) return;
  t.done = true;
  mark(t, 'fallback');
  const from = Math.min(t.finalEnd, t.samples);
  const n = t.samples - from;
  if (n < MIN_SAMPLES) {
    if (t.finalEnd === 0) toast('Too short. Press DICTATE, talk, then press it again.', 3000);
    return endTake();
  }
  if (n > ONE_SHOT_MAX) {
    toast('The live link broke and the rest is over 5 minutes: it was not turned into text.', 7000);
    return endTake();
  }
  abort = new AbortController();
  const timer = setTimeout(() => abort?.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: toWav(t.chunks, from), signal: abort.signal });
    const data = (await res.json().catch(() => ({ error: '' }))) as TranscribeResponse;
    if (t.id !== session) return;
    if (!res.ok || !('text' in data)) throw new Error(serverError(res.status, 'error' in data ? data.error : ''));
    if (data.text.trim()) insert(data.text);
    endTake();
    if (!data.text.trim() && t.finalEnd === 0) toast('No words heard. Try again a little closer to the mic.', 3000);
  } catch (e) {
    if (t.id !== session) return; // cancelled
    endTake();
    toast(e instanceof Error && e.name !== 'AbortError' ? e.message : 'Dictation timed out. Try a shorter take.', 7000);
  } finally {
    clearTimeout(timer);
    abort = null;
  }
}

function endTake(): void {
  const focus = take?.inserted && matchMedia('(pointer: fine)').matches;
  dropTake();
  setState('idle');
  // Desktop: back to the message box to edit or send. (A phone would pop up its keyboard over the chat.)
  if (focus) input.focus();
}

function dropTake(): void {
  if (take) {
    report(take, take.why || (!take.done ? 'cancel' : take.live === false ? 'fallback' : 'ok'));
    clearTimeout(take.doneTimer);
    take.ws?.close();
    take.chunks = [];
  }
  take = null;
}

// Esc: stop everything; text not yet in the message box is dropped.
function cancel(): void {
  session++;
  clearInterval(clock);
  rec?.close();
  rec = null;
  abort?.abort();
  abort = null;
  dropTake();
  setState('idle');
}

// Put the words at the cursor (or over the selected text), with a space on either side when needed.
// A phrase that starts a sentence gets a capital letter. joinPrev: the last phrase's period was only a pause.
function insert(raw: string, joinPrev = false): void {
  let text = raw.trim();
  if (!text) return;
  let start = input.selectionStart ?? input.value.length;
  let end = input.selectionEnd ?? start;
  if (joinPrev && start === end) {
    const dot = input.value.slice(0, start).search(/[^.]\.\s*$/);
    if (dot >= 0) {
      input.setRangeText('', dot + 1, start, 'end');
      start = end = dot + 1;
    }
  }
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  if (!before.trim() || /[.!?]["')\]]?\s*$/.test(before)) text = text.charAt(0).toUpperCase() + text.slice(1);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const post = after && !/^\s/.test(after) ? ' ' : '';
  input.setRangeText(pre + text + post, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true })); // chat.ts saves the draft and resizes the box
  if (take) take.inserted = true;
}

function serverError(status: number, msg?: string): string {
  if (status === 404) return 'The server update for dictation has not loaded yet. Reload in a minute.';
  if (status === 401) return 'Logged out. Reload the page and log in.';
  return msg || `Dictation failed (error ${status}).`;
}

// A USB mic that dropped off and came back (a USB switch, 2026-10-22) can read as "no microphone" while the
// browser still lists the old device. Asking for the device list again and retrying once picks up the new one.
async function openMic(): Promise<MediaStream> {
  const want = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
  try {
    return await navigator.mediaDevices.getUserMedia(want);
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name !== 'NotFoundError' && name !== 'NotReadableError' && name !== 'OverconstrainedError') throw e;
    await navigator.mediaDevices.enumerateDevices().catch(() => []);
    await new Promise((r) => setTimeout(r, 300));
    return navigator.mediaDevices.getUserMedia(want);
  }
}

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone blocked. Allow it for this site (lock icon next to the address), then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return shellApi
      ? 'No microphone found. If it was unplugged and plugged back in, restart the window (Super + Alt + R on Linux), then try again.'
      : 'No microphone found. Plug one in and try again.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is busy in another app. Close that app and try again.';
  return `Could not start the microphone${e instanceof Error && e.message ? `: ${e.message}` : '.'}`;
}

// ---- Recording ----

// Runs on the audio thread: low-pass filter + resample to 16 kHz, 16-bit samples, posted in 100 ms
// blocks with the block's peak level. The filter (97-tap Hamming windowed sinc, cut at 7 kHz) keeps
// sounds above 8 kHz from folding back into the speech band.
const WORKLET = `
const OUT = 16000, BLOCK = 1600, N = 97, H = 48;
class PhosphorDictate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUT;
    this.copy = sampleRate === OUT;
    this.taps = new Float32Array(N);
    const fc = 7000 / sampleRate;
    let sum = 0;
    for (let k = 0; k < N; k++) {
      const m = k - H;
      const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
      this.taps[k] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (N - 1)));
      sum += this.taps[k];
    }
    for (let k = 0; k < N; k++) this.taps[k] /= sum;
    this.x = new Float32Array(8192); // input history; x[0] is input sample number x0
    this.x0 = -H;
    this.n = H; // starts with H zeros
    this.t = 0; // input position of the next output sample
    this.out = new Int16Array(BLOCK);
    this.k = 0;
    this.peak = 0;
    this.live = true;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.post(); this.port.postMessage({ done: true }); }
      else if (e.data === 'close') this.live = false;
    };
  }
  post() {
    if (!this.k) return;
    const pcm = this.out.slice(0, this.k);
    this.port.postMessage({ pcm, peak: this.peak }, [pcm.buffer]);
    this.k = 0;
    this.peak = 0;
  }
  emit(v) {
    const a = v < 0 ? -v : v;
    if (a > this.peak) this.peak = a;
    this.out[this.k++] = v < 0 ? Math.max(-32768, v * 32768) : Math.min(32767, v * 32767);
    if (this.k === BLOCK) this.post();
  }
  fir(i) {
    const x = this.x, taps = this.taps, base = i - H - this.x0;
    let s = 0;
    for (let k = 0; k < N; k++) s += taps[k] * x[base + k];
    return s;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return this.live;
    if (this.copy) {
      for (let i = 0; i < ch.length; i++) this.emit(ch[i]);
      return this.live;
    }
    if (this.n + ch.length > this.x.length) {
      // Keep only what the filter still needs.
      const keep = Math.max(0, Math.floor(this.t) - H - 1 - this.x0);
      this.x.copyWithin(0, keep, this.n);
      this.n -= keep;
      this.x0 += keep;
    }
    this.x.set(ch, this.n);
    this.n += ch.length;
    const last = this.x0 + this.n - 1; // newest input sample number
    while (true) {
      const i = Math.floor(this.t);
      if (i + 1 + H > last) break;
      const f = this.t - i;
      const a = this.fir(i);
      this.emit(f ? a + (this.fir(i + 1) - a) * f : a);
      this.t += this.step;
    }
    return this.live;
  }
}
registerProcessor('phosphor-dictate', PhosphorDictate);
`;
let workletUrl = '';

// Load the recorder code into this audio context. Started at the tap, so it loads while the mic starts.
function loadWorklet(ctx: AudioContext): Promise<void> {
  if (!ctx.audioWorklet) return Promise.reject(new Error('this browser has no AudioWorklet'));
  workletUrl ||= URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  return ctx.audioWorklet.addModule(workletUrl);
}

class Recorder {
  private flushed: (() => void) | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode;

  private constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
  ) {
    this.source = ctx.createMediaStreamSource(stream);
  }

  static async open(ctx: AudioContext, stream: MediaStream, worklet: Promise<void>, onAudio: (pcm: Int16Array<ArrayBuffer>, peak: number) => void): Promise<Recorder> {
    const r = new Recorder(ctx, stream);
    try {
      // A paused audio engine can make resume() wait for good. Don't hang on "MIC…": the recording starts
      // and the sound comes when the engine wakes.
      if (ctx.state === 'suspended') await Promise.race([ctx.resume().catch(() => {}), new Promise((late) => setTimeout(late, RESUME_WAIT_MS))]);
      await worklet;
      const node = new AudioWorkletNode(ctx, 'phosphor-dictate', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e: MessageEvent<{ pcm?: Int16Array<ArrayBuffer>; peak?: number; done?: boolean }>) => {
        if (e.data.pcm) onAudio(e.data.pcm, e.data.peak ?? 0);
        if (e.data.done) r.flushed?.();
      };
      r.source.connect(node);
      r.node = node;
    } catch (e) {
      r.close();
      throw e;
    }
    return r;
  }

  // Get the last samples out of the audio thread, then release the mic.
  async stop(): Promise<void> {
    const port = this.node?.port;
    if (port) {
      await new Promise<void>((ok) => {
        this.flushed = ok;
        port.postMessage('flush');
        setTimeout(ok, 500); // the audio thread is stuck: use what we have
      });
    }
    this.close();
  }

  close(): void {
    if (this.node) {
      this.node.port.postMessage('close');
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.source.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close().catch(() => {});
    this.node = null;
  }
}

// 16 kHz mono 16-bit WAV of the recorded blocks, from sample `from` on.
function toWav(chunks: Int16Array<ArrayBuffer>[], from: number): Blob {
  const parts: Int16Array<ArrayBuffer>[] = [];
  let skip = from;
  let n = 0;
  for (const c of chunks) {
    if (skip >= c.length) {
      skip -= c.length;
      continue;
    }
    const part = skip ? c.subarray(skip) : c;
    skip = 0;
    parts.push(part);
    n += part.length;
  }
  const v = new DataView(new ArrayBuffer(44));
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  return new Blob([v, ...parts], { type: 'audio/wav' });
}
