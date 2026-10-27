// PROMPTER: a punch list for recording a video. The owner talks; the page streams the mic to the PC's speech engine;
// a decision model is asked about once a second "has the speaker started talking about point N?" for the points
// still open; points tick off. The pure parts live here (list format, the rolling transcript, the tick rule, the
// AFTER check) so tests/prompter.ts can run them with a fake decider and a fake clock. Server: server/prompter.ts.

export const PROMPTER_MAX_POINTS = 40;
const MAX_POINT = 200; // characters
const MAX_NOTE = 300;

// The rolling transcript the decider sees: the last WINDOW_MS of speech, at most WINDOW_CHARS characters.
export const WINDOW_MS = 45_000;
const WINDOW_CHARS = 1500;
const HEARD_TAIL = 220; // the live line on screen
const QUOTE = 240; // the words kept with a tick

// The tick rule. The decider answers with how sure it is (0..1) that a point has started. A wrong tick hides a point
// the speaker has not made yet, which is worse than a tick that comes a second late, so a tick needs either one very
// sure answer, or two sure-enough answers in a row for that point (two calls about a second apart, each with new words).
export const TICK_SURE = 0.92;
export const TICK_LIKELY = 0.75;
const MAX_ASK = 12; // points per call: the first ASK_HEAD open ones in list order, plus a few of the rest in turn
const ASK_HEAD = 8;
const CALL_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const COVERED_IN_ASK = 8; // ticked points named in each call, newest first

export type Point = { id: string; text: string; note: string };

export type PromptList = { id: string; name: string; text: string; updated: number };
export type PromptListSummary = { id: string; name: string; points: number; updated: number };

// What the decider is asked: the recent words, the points already covered (short summary), the open points.
export type CueAsk = { heard: string; covered: string[]; points: Point[] };
// One answer per asked point: how sure (0..1) the speaker has started talking about it.
export type CueVerdict = { id: string; yes: number };
export type CueDecide = (ask: CueAsk, signal: AbortSignal) => Promise<CueVerdict[]>;

export type CuePoint = Point & {
  done: boolean;
  by: 'model' | 'hand' | null;
  at: number | null; // ms after the start: when the point started (model) or was ticked (hand)
  yes: number | null; // the last answer for this point
  quote: string; // the words that covered it (model ticks)
};

// The live session as every screen sees it (GET /api/prompter/live).
export type PrompterLive = {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  points: CuePoint[];
  heard: string; // the end of what was heard
  words: number; // words heard so far
  mic: 'on' | 'off'; // a device is sending speech (seen in the last few seconds)
  level: number; // that mic's level, 0..1
  engine: { ready: boolean; label: string; note: string };
  calls: number;
  callMs: number; // the last call's time
  error: string; // the last decider error, '' when the last call worked
  v: number; // changes with every change
};

export type AfterPoint = Point & { covered: boolean; quote: string; at: string };
export type AfterJob = { id: string; state: 'running' | 'done' | 'error'; done: number; total: number; points: AfterPoint[]; error: string; by: string };

// ------------------------------------------------------------ the list format

const BULLET = /^(?:[-*+•]|\d{1,3}[.)]|\[[ xX]?\])\s+/;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// One point per line; indented lines under a point are its notes. Leading list marks ("- ", "1. ", "[ ] ") go.
export function parsePoints(text: string): Point[] {
  const out: Point[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (!raw.trim()) continue;
    const indented = /^[ \t]/.test(raw);
    const line = raw.trim().replace(BULLET, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const last = out.at(-1);
    if (indented && last) last.note = clip(last.note ? `${last.note} ${line}` : line, MAX_NOTE);
    else if (out.length < PROMPTER_MAX_POINTS) out.push({ id: `p${out.length + 1}`, text: clip(line, MAX_POINT), note: '' });
  }
  return out;
}

// ------------------------------------------------------------ the rolling transcript

// Finals (whole phrases) with the time they arrived, plus the phrase being spoken now. Old phrases fall off, so an
// hour of talk keeps the same small memory.
export class Heard {
  private finals: { at: number; text: string }[] = [];
  private partial = '';
  version = 0; // changes when new words arrive
  words = 0;

  add(text: string, final: boolean, at: number): void {
    const t = text.replace(/\s+/g, ' ').trim();
    if (final) {
      this.partial = '';
      if (!t) return;
      this.finals.push({ at, text: t });
      this.words += t.split(' ').length;
      this.version++;
      this.prune(at);
    } else if (t !== this.partial) {
      this.partial = t;
      if (t) this.version++;
    }
  }

  private prune(now: number): void {
    while (this.finals.length > 1 && now - this.finals[0].at > WINDOW_MS) this.finals.shift();
    let n = this.finals.reduce((s, f) => s + f.text.length + 1, this.partial.length);
    while (this.finals.length > 1 && n > WINDOW_CHARS) n -= this.finals.shift()!.text.length + 1;
  }

  // What the decider sees: the last WINDOW_MS of phrases and the one being spoken.
  window(now: number): string {
    this.prune(now);
    const s = [...this.finals.map((f) => f.text), this.partial].filter(Boolean).join(' ');
    return s.length > WINDOW_CHARS ? s.slice(s.length - WINDOW_CHARS).replace(/^\S*\s/, '') : s;
  }

  // The newest words, for the line on screen and a tick's quote.
  tail(n = HEARD_TAIL): string {
    const s = [...this.finals.slice(-4).map((f) => f.text), this.partial].filter(Boolean).join(' ');
    return s.length > n ? `…${s.slice(s.length - n).replace(/^\S*\s/, '')}` : s;
  }
}

// ------------------------------------------------------------ the tick rule

type Track = { streak: number; since: number; holdUntil: number; quote: string };

// The points of one session and the calls about them. Never more than one call in flight; no call when nothing new
// was heard. The clock is passed in (tests and the AFTER check use their own).
export class Cue {
  readonly points: CuePoint[];
  private track = new Map<string, Track>();
  private busy = false;
  private askedVersion = -1;
  private turn = 0; // rotates the points after the first ASK_HEAD
  private notBefore = 0; // after an error, wait
  private backoff = 0;
  calls = 0;
  callMs = 0;
  error = '';

  constructor(points: Point[], private startedAt: number, private onChange: () => void = () => {}) {
    this.points = points.map((p) => ({ ...p, done: false, by: null, at: null, yes: null, quote: '' }));
    for (const p of points) this.track.set(p.id, { streak: 0, since: 0, holdUntil: 0, quote: '' });
  }

  get inFlight(): boolean {
    return this.busy;
  }

  // The open points to ask about this time (manual unticks wait out one window: the old words would tick them again).
  pick(now: number): CuePoint[] {
    const open = this.points.filter((p) => !p.done && this.track.get(p.id)!.holdUntil <= now);
    if (open.length <= MAX_ASK) return open;
    const rest = open.slice(ASK_HEAD);
    const n = MAX_ASK - ASK_HEAD;
    const from = (this.turn * n) % rest.length;
    const more = [...rest.slice(from), ...rest.slice(0, from)].slice(0, n);
    return [...open.slice(0, ASK_HEAD), ...more];
  }

  // Start a call if it is time; resolves when it is answered (null: no call now).
  step(heard: Heard, decide: CueDecide | null, now: number): Promise<void> | null {
    if (this.busy || !decide || now < this.notBefore || heard.version === this.askedVersion) return null;
    const ask = this.pick(now);
    if (!ask.length) return null;
    const text = heard.window(now);
    if (!text) return null;
    this.askedVersion = heard.version;
    this.busy = true;
    this.turn++;
    const covered = this.points.filter((p) => p.done).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, COVERED_IN_ASK).map((p) => p.text);
    const quote = heard.tail(QUOTE);
    const t0 = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CALL_TIMEOUT_MS);
    return decide({ heard: text, covered, points: ask.map(({ id, text, note }) => ({ id, text, note })) }, abort.signal)
      .then(
        (verdicts) => {
          this.error = '';
          this.backoff = 0;
          this.apply(ask, verdicts, quote, now);
        },
        (e: unknown) => {
          this.error = abort.signal.aborted ? 'The decision model took too long.' : e instanceof Error ? e.message : String(e);
          this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff ? this.backoff * 2 : 2000);
          this.notBefore = now + this.backoff;
          this.askedVersion = -1; // ask again once the wait is over, even with no new words
        },
      )
      .finally(() => {
        clearTimeout(timer);
        this.busy = false;
        this.calls++;
        this.callMs = Date.now() - t0;
        this.onChange();
      });
  }

  private apply(asked: CuePoint[], verdicts: CueVerdict[], quote: string, now: number): void {
    const got = new Map(verdicts.map((v) => [v.id, Math.max(0, Math.min(1, Number(v.yes) || 0))]));
    for (const p of asked) {
      if (p.done || !got.has(p.id)) continue; // ticked by hand meanwhile, or no answer for it
      const yes = got.get(p.id)!;
      const t = this.track.get(p.id)!;
      p.yes = yes;
      if (yes >= TICK_LIKELY) {
        if (!t.streak) {
          t.since = now; // where it started
          t.quote = quote;
        }
        t.streak++;
      } else t.streak = 0;
      if (yes >= TICK_SURE || t.streak >= 2) {
        p.done = true;
        p.by = 'model';
        p.at = (t.streak ? t.since : now) - this.startedAt;
        p.quote = t.quote || quote;
      }
    }
  }

  // Tick or untick by hand (the model is wrong sometimes).
  mark(id: string, done: boolean, now: number): boolean {
    const p = this.points.find((x) => x.id === id);
    if (!p || p.done === done) return false;
    const t = this.track.get(id)!;
    p.done = done;
    p.by = done ? 'hand' : null;
    p.at = done ? now - this.startedAt : null;
    p.quote = '';
    t.streak = 0;
    t.quote = '';
    t.holdUntil = done ? 0 : now + WINDOW_MS;
    this.onChange();
    return true;
  }
}

// ------------------------------------------------------------ AFTER: a finished recording's transcript

// "[1:02:03] words", "12:34 words" or a line with only a time ("12:34" then the words, as YouTube's transcript
// copies); SRT and VTT cue numbers and arrows are dropped.
const STAMP = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d+)?\]?\s*/;

export type Spoken = { words: string[]; times: (string | null)[] };

const short = (t: string) => t.replace(/^0{1,2}:(?=\d{2}:)/, ''); // 00:01:10 -> 01:10

export function parseTranscript(text: string): Spoken {
  const words: string[] = [];
  const times: (string | null)[] = [];
  let time: string | null = null;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    let line = raw.trim();
    if (!line || /^WEBVTT/.test(line) || /^\d+$/.test(line)) continue;
    if (/-->/.test(line)) {
      const m = STAMP.exec(line);
      if (m) time = short(m[1]);
      continue;
    }
    const m = STAMP.exec(line);
    if (m) {
      time = short(m[1]);
      line = line.slice(m[0].length);
    }
    for (const w of line.replace(/<[^>]+>/g, ' ').split(/\s+/)) {
      if (!w) continue;
      words.push(w);
      times.push(time);
    }
  }
  return { words, times };
}

const STEP_WORDS = 55; // about 20 s of speech
const STEP_MS = 20_000;

// Replay the transcript through the same tick rule as a live session, about 20 s of speech per step, and report
// which points were covered (with the words that covered them) and which were missed.
export async function checkAfter(text: string, points: Point[], decide: CueDecide, progress: (done: number, total: number) => void = () => {}): Promise<AfterPoint[]> {
  const { words, times } = parseTranscript(text);
  const heard = new Heard();
  const cue = new Cue(points, 0);
  const total = Math.ceil(words.length / STEP_WORDS);
  for (let s = 0; s < total; s++) {
    heard.add(words.slice(s * STEP_WORDS, (s + 1) * STEP_WORDS).join(' '), true, s * STEP_MS);
    await cue.step(heard, decide, s * STEP_MS);
    if (cue.error) throw new Error(cue.error);
    progress(s + 1, total);
    if (cue.points.every((p) => p.done)) break;
  }
  // A point's time is the middle of the step its streak started at: the transcript's own time there, or how far in.
  const at = (ms: number) => {
    const i = Math.min(words.length - 1, Math.round(ms / STEP_MS) * STEP_WORDS + (STEP_WORDS >> 1));
    return times[i] ?? `${Math.round((i / Math.max(1, words.length)) * 100)}% IN`;
  };
  return cue.points.map(({ id, text: t, note, done, quote, at: ms }) => ({ id, text: t, note, covered: done, quote: done ? quote : '', at: done && ms !== null ? at(ms) : '' }));
}

// AFTER, an audio file: the page decodes it at 16 kHz and sends it in pieces under the 5-minute limit of POST
// /api/transcribe.
const PIECE_S = 270;

// Pieces of at most PIECE_S seconds, each cut at the quietest 100 ms in its last 20 seconds (not mid-word).
export function cutPieces(ch: Float32Array, rate = 16000): [number, number][] {
  const out: [number, number][] = [];
  const max = PIECE_S * rate;
  const block = rate / 10;
  let a = 0;
  while (a < ch.length) {
    let b = Math.min(ch.length, a + max);
    if (b < ch.length) {
      let best = b;
      let low = Infinity;
      for (let s = b - 20 * rate; s + block <= b; s += block) {
        let e = 0;
        for (let i = s; i < s + block; i++) e += ch[i] * ch[i];
        if (e < low) {
          low = e;
          best = s + block / 2;
        }
      }
      b = best;
    }
    out.push([a, b]);
    a = b;
  }
  return out;
}
