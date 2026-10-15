// Speech-to-text worker for DICTATE. Plain JavaScript on purpose: server/voice.ts forks it with plain
// Node (no tsx) and talks to it over the IPC pipe only. It opens no network port.
//
// Engine: sherpa-onnx (Node addon) with NVIDIA Parakeet TDT 0.6B v2 (int8) and Silero VAD, installed by
// scripts/setup-voice.ps1 (Linux: scripts/setup-voice.sh) into the folder given as the first argument.
// sherpa-onnx-node loads the addon for this OS from the package next to it (sherpa-onnx-win-x64, sherpa-onnx-linux-x64).
//
// Two ways in:
//  - One shot: { t: 'decode', id, pcm } -> { t: 'result', id, text, ms } | { t: 'fail', id, message }
//  - Live: { t: 'open', sid }, then { t: 'audio', sid, pcm } as you talk, then { t: 'end', sid } (or
//    { t: 'close', sid } to drop it). Silero VAD cuts the speech into phrases at pauses. While a phrase is
//    open it is re-decoded about every PARTIAL_MS -> { t: 'partial', sid, text }. When the pause comes,
//    the whole phrase is decoded once -> { t: 'final', sid, text, end } (end = samples used so far).
//    After 'end': the last phrase as a final, then { t: 'done', sid }.
// pcm is always a Uint8Array of 16 kHz mono 16-bit little-endian samples.
// Only one decode runs at a time (2 CPU threads; 4 were 30% faster but cost 2.5x the CPU, because
// ONNX Runtime threads spin after each decode). Finals and one-shots go first, in order;
// partials fill the gaps and are skipped when the CPU is behind.
// Out at start: { t: 'ready', ms, live } | { t: 'error', message }

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

const RATE = 16000;
const MIN_SAMPLES = 0.3 * RATE; // shorter than this is a mis-tap; the model guesses words ("Yeah.")
const SILENT_PEAK = 0.003; // about -50 dBFS: nothing was said
// One shot: long audio is decoded in pieces cut at the quietest moment between 15 s and 25 s.
const CHUNK_MIN = 15 * RATE;
const CHUNK_MAX = 25 * RATE;
// Live. Tuning knobs (optional, in .env): PHOSPHOR_VOICE_THREADS, PHOSPHOR_VOICE_PAUSE (s), PHOSPHOR_VOICE_PARTIAL_MS.
const VAD_WINDOW = 512; // Silero works on 32 ms windows
const PAUSE_S = Number(process.env.PHOSPHOR_VOICE_PAUSE) || 0.8; // this much silence ends a phrase
const MAX_PHRASE_S = 20; // a phrase is cut here even without a pause
const PRE = Math.round(0.25 * RATE); // audio kept before a phrase starts (soft first sounds)
const POST = Math.round(0.2 * RATE); // and after it ends (less than PAUSE_S, so the next phrase is not touched)
const LOOKBACK = 1 * RATE; // silence kept before speech is detected
const PARTIAL_MS = Number(process.env.PHOSPHOR_VOICE_PARTIAL_MS) || 800; // preview cadence; slower when decoding takes longer (never more than half the time)
const PARTIAL_MIN_NEW = 0.25 * RATE; // only re-decode when this much new audio came in
// Each phrase is decoded alone, so the model ends it with a period even when the pause was mid-sentence.
// The seam is decoded again with a short gap: up to SEAM s from each side. Not a sentence end there -> joinPrev.
const SEAM = 3 * RATE;
const SEAM_GAP = new Float32Array(0.25 * RATE);

const dir = process.argv[2];
const SETUP = process.platform === 'win32' ? 'scripts\\setup-voice.ps1' : 'scripts/setup-voice.sh';
// The addon package for this OS, named the way sherpa-onnx-node looks for it.
const ADDON = `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
let sherpa;
let recognizer;
let vadConfig = null;

try {
  const started = performance.now();
  const install = JSON.parse(readFileSync(join(dir, 'install.json'), 'utf8'));
  const require = createRequire(join(dir, 'package.json'));
  // Without this, sherpa-onnx-node throws a long list of paths; say what to do instead.
  if (!existsSync(join(dir, 'node_modules', ADDON))) throw new Error(`The engine for this PC (${ADDON}) is missing. Run ${SETUP}.`);
  sherpa = require('sherpa-onnx-node');
  const model = join(dir, install.modelDir);
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(model, 'encoder.int8.onnx'),
        decoder: join(model, 'decoder.int8.onnx'),
        joiner: join(model, 'joiner.int8.onnx'),
      },
      tokens: join(model, 'tokens.txt'),
      numThreads: Math.min(Number(process.env.PHOSPHOR_VOICE_THREADS) || 2, availableParallelism()),
      provider: 'cpu',
      debug: 0,
      modelType: 'nemo_transducer',
    },
    decodingMethod: 'greedy_search',
  });
  if (install.vad) {
    vadConfig = {
      sileroVad: {
        model: join(dir, install.vad),
        threshold: 0.5,
        minSilenceDuration: PAUSE_S,
        minSpeechDuration: 0.25,
        maxSpeechDuration: MAX_PHRASE_S,
        windowSize: VAD_WINDOW,
      },
      sampleRate: RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    };
    new sherpa.Vad(vadConfig, 1); // fail now, not on the first live session, if the VAD is broken
  }
  process.send({ t: 'ready', ms: Math.round(performance.now() - started), live: !!vadConfig });
} catch (e) {
  process.send({ t: 'error', message: e instanceof Error ? e.message : String(e) }, () => process.exit(1));
}

// The app server went away (closed, crashed or restarted): leave with it.
process.on('disconnect', () => process.exit(0));

// ---- Decode queue: one decode at a time ----

const jobs = []; // finals and one-shots, in order: { run: async () => void }
const sessions = new Map(); // sid -> Live
let busy = false;

function pump() {
  if (busy || !recognizer) return;
  const job = jobs.shift();
  if (job) {
    busy = true;
    job.run().finally(() => {
      busy = false;
      pump();
    });
    return;
  }
  // Nothing urgent: the most overdue live preview.
  let pick = null;
  const now = performance.now();
  for (const s of sessions.values()) if (s.wantsPartial(now) && (!pick || s.nextPartialAt < pick.nextPartialAt)) pick = s;
  if (!pick) return;
  busy = true;
  pick.partial().finally(() => {
    busy = false;
    pump();
  });
}

async function decode(samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: RATE, samples });
  const r = await recognizer.decodeAsync(stream);
  return (r.text ?? '').trim();
}

process.on('message', (msg) => {
  if (!recognizer || !msg) return;
  if (msg.t === 'decode') {
    const id = msg.id;
    const samples = toFloat(msg.pcm);
    jobs.push({
      run: async () => {
        const started = performance.now();
        try {
          const text = await oneShot(samples);
          process.send({ t: 'result', id, text, ms: Math.round(performance.now() - started) });
        } catch (e) {
          process.send({ t: 'fail', id, message: e instanceof Error ? e.message : String(e) });
        }
      },
    });
    pump();
    return;
  }
  if (msg.t === 'open') {
    if (!vadConfig) {
      process.send({ t: 'error', sid: msg.sid, message: `Live dictation needs the Silero VAD. Run ${SETUP} again.` });
      return;
    }
    try {
      sessions.set(msg.sid, new Live(msg.sid));
    } catch (e) {
      process.send({ t: 'error', sid: msg.sid, message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  const s = sessions.get(msg.sid);
  if (!s) return;
  if (msg.t === 'audio') s.audio(toFloat(msg.pcm));
  else if (msg.t === 'end') s.end();
  else if (msg.t === 'close') s.close();
  pump();
});

function toFloat(bytes) {
  const n = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

// The seam decode reads "...last word first word..." with no sentence end between them: the new phrase
// goes on the same sentence. Returns it with the first word cased as in the seam ("the", but "I", "Ann").
function continuation(prev, text, seamText) {
  const bare = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const last = bare(prev.split(/\s+/).pop());
  const words = text.split(/\s+/);
  const first = bare(words[0]);
  const seam = seamText.split(/\s+/);
  for (let i = 0; i + 1 < seam.length; i++) {
    if (bare(seam[i]) !== last || bare(seam[i + 1]) !== first) continue;
    if (/[.!?]["')\]]?$/.test(seam[i])) return null;
    const cased = seam[i + 1].replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
    const lead = words[0].match(/^[^\p{L}\p{N}']*/u)[0].length; // a quote or bracket before the word stays
    words[0] = words[0].slice(0, lead) + cased + words[0].slice(lead + cased.length);
    return words.join(' ');
  }
  return null;
}

// ---- One shot ----

async function oneShot(samples) {
  if (samples.length < MIN_SAMPLES) return '';
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < SILENT_PEAK) return '';
  const parts = [];
  for (const piece of split(samples)) {
    const text = await decode(piece);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

// Cut at the quietest 100 ms window between CHUNK_MIN and CHUNK_MAX (a pause between words).
function split(x) {
  const out = [];
  const win = RATE / 10;
  let start = 0;
  while (x.length - start > CHUNK_MAX) {
    let cut = start + CHUNK_MAX;
    let best = Infinity;
    for (let w = start + CHUNK_MIN; w + win <= start + CHUNK_MAX; w += win / 2) {
      let e = 0;
      for (let i = w; i < w + win; i++) e += x[i] * x[i];
      if (e < best) {
        best = e;
        cut = w + win / 2;
      }
    }
    out.push(x.subarray(start, cut));
    start = cut;
  }
  out.push(x.subarray(start));
  return out;
}

// ---- Live session ----

class Live {
  constructor(sid) {
    this.sid = sid;
    this.vad = new sherpa.Vad(vadConfig, 60);
    this.buf = new Float32Array(30 * RATE); // audio from sample `base` on
    this.base = 0;
    this.len = 0;
    this.fed = 0; // samples given to the VAD (whole windows only)
    this.cut = 0; // everything before this sample is final
    this.heard = false; // speech since `cut`
    this.phrase = 0; // bumps when a phrase is finalized: a late preview of an old phrase is dropped
    this.nextPartialAt = 0;
    this.partialLen = 0;
    this.lastPartial = '';
    this.pendingFinals = 0;
    this.prevText = ''; // the last final and the end of its audio, for the seam check
    this.prevTail = null;
    this.ending = false;
    this.closed = false;
  }

  get total() {
    return this.base + this.len;
  }

  audio(x) {
    if (this.closed || this.ending) return;
    if (this.len + x.length > this.buf.length) this.compact(x.length);
    this.buf.set(x, this.len);
    this.len += x.length;
    // Feed the VAD whole windows.
    const whole = Math.floor((this.total - this.fed) / VAD_WINDOW) * VAD_WINDOW;
    if (whole > 0) {
      this.vad.acceptWaveform(this.slice(this.fed, this.fed + whole));
      this.fed += whole;
    }
    if (this.vad.isDetected()) this.heard = true;
    // Long silence is not kept: the VAD finds a phrase start within LOOKBACK of hearing it.
    else if (!this.heard) this.cut = Math.max(this.cut, this.fed - LOOKBACK);
    this.takeSegments();
  }

  // Drop audio that is final; grow the buffer if one phrase needs more room.
  compact(extra) {
    const keepFrom = Math.max(this.base, Math.min(this.cut, this.fed) - PRE);
    const drop = keepFrom - this.base;
    const need = this.len - drop + extra;
    const next = need > this.buf.length ? new Float32Array(Math.max(need, this.buf.length * 2)) : this.buf;
    next.set(this.buf.subarray(drop, this.len), 0);
    this.buf = next;
    this.base += drop;
    this.len -= drop;
  }

  slice(from, to) {
    const a = Math.max(from, this.base) - this.base;
    const b = Math.min(to, this.total) - this.base;
    return this.buf.slice(a, Math.max(a, b));
  }

  // Each finished VAD segment becomes one final decode of the whole phrase (with a little air around it).
  takeSegments() {
    while (!this.vad.isEmpty()) {
      const seg = this.vad.front(false);
      this.vad.pop();
      const from = Math.max(this.cut, seg.start - PRE);
      const to = Math.min(this.total, seg.start + seg.samples.length + POST);
      if (to <= from) continue;
      const samples = this.slice(from, to);
      this.cut = to;
      this.phrase++;
      this.heard = this.vad.isDetected();
      this.lastPartial = '';
      this.partialLen = 0;
      this.queueFinal(samples, to);
    }
  }

  queueFinal(samples, end) {
    this.pendingFinals++;
    jobs.push({
      run: async () => {
        try {
          if (this.closed) return;
          const started = performance.now();
          let text = await decode(samples);
          let joinPrev = false;
          if (text && this.prevTail && /[^.]\.$/.test(this.prevText)) {
            const seam = new Float32Array(this.prevTail.length + SEAM_GAP.length + Math.min(SEAM, samples.length));
            seam.set(this.prevTail);
            seam.set(samples.subarray(0, SEAM), this.prevTail.length + SEAM_GAP.length);
            const next = continuation(this.prevText, text, await decode(seam));
            if (next) [text, joinPrev] = [next, true];
          }
          if (text) [this.prevText, this.prevTail] = [text, samples.slice(Math.max(0, samples.length - SEAM))];
          const ms = Math.round(performance.now() - started);
          if (!this.closed) process.send({ t: 'final', sid: this.sid, text, end, ms, joinPrev });
        } catch (e) {
          if (!this.closed) process.send({ t: 'error', sid: this.sid, message: e instanceof Error ? e.message : String(e) });
        } finally {
          this.pendingFinals--;
          this.maybeDone();
        }
      },
    });
  }

  wantsPartial(now) {
    return !this.closed && !this.ending && this.heard && now >= this.nextPartialAt && this.total - this.cut - this.partialLen >= PARTIAL_MIN_NEW;
  }

  async partial() {
    const phrase = this.phrase;
    const samples = this.slice(this.cut, this.total);
    this.partialLen = samples.length;
    const started = performance.now();
    try {
      const text = await decode(samples);
      if (this.closed || this.ending || phrase !== this.phrase || text === this.lastPartial) return;
      this.lastPartial = text;
      process.send({ t: 'partial', sid: this.sid, text, ms: Math.round(performance.now() - started) });
    } catch {
      /* a preview can fail quietly; the final will say */
    } finally {
      // Never spend more than about half the time on previews.
      const took = performance.now() - started;
      this.nextPartialAt = started + Math.max(PARTIAL_MS, 2 * took);
    }
  }

  // Stop pressed: the rest of the audio becomes the last phrase.
  end() {
    if (this.closed || this.ending) return;
    const rest = this.total - this.fed;
    if (rest > 0) {
      // Pad the last partial window with silence so the VAD sees every sample.
      const tail = new Float32Array(VAD_WINDOW);
      tail.set(this.slice(this.fed, this.total));
      this.vad.acceptWaveform(tail);
      this.fed = this.total;
    }
    this.vad.flush();
    this.takeSegments();
    this.ending = true;
    this.maybeDone();
  }

  maybeDone() {
    if (!this.ending || this.closed || this.pendingFinals > 0) return;
    process.send({ t: 'done', sid: this.sid, end: this.total });
    this.close();
  }

  close() {
    this.closed = true;
    sessions.delete(this.sid);
  }
}
