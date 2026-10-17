import type { LocalSpeed, LocalSpeedRun } from '../shared/protocol.ts';

// Speed of the local model, for the SYS panel. The relay (server/localrelay.ts) hands every streamed /v1/messages
// answer to a Meter chunk by chunk, after the same chunk went on to Claude Code: the meter reads a copy and never
// holds the stream up. Anthropic's SSE events: message_start (usage.input_tokens), content_block_delta (each piece
// of thinking, text or tool input), message_delta (usage.output_tokens, and input_tokens on Strata), message_stop.
// llama.cpp sends message_start with the first token, Strata at once. Live token counts are estimated from the
// pieces (about 4 characters a token); the final count is the server's. A `timings` object (llama.cpp's names) on any
// event wins over the relay's own clock. Only numbers and the model name are kept: no prompt or answer text.

const RECENT = 5;
const WINDOW_MS = 3000; // live writing speed: over the last 3 s
const MAX_EVENT = 4 << 20; // a longer event (a huge tool input in one piece) is skipped, not collected
const MIN_SPAN_MS = 250; // shorter answers give no writing speed: too noisy

type Phase = NonNullable<LocalSpeedRun['phase']>;
type Usage = { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown };
type Timings = { prompt_n?: unknown; prompt_ms?: unknown; prompt_per_second?: unknown; predicted_per_second?: unknown };

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const whole = (v: number | null) => (v === null ? null : Math.round(v));
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

let enabled = false;
const running = new Set<Meter>();
const done: LocalSpeedRun[] = [];

export class Meter {
  private readonly arrived: number;
  private sent: number | null = null; // when the request went to the model server
  private first: number | null = null; // first output piece
  private last: number | null = null; // latest output piece
  private phase: Phase = 'loading';
  private input: number | null = null;
  private cached: number | null = null;
  private output: number | null = null; // the server's count
  private estimate = 0; // counted from the pieces
  private samples: [number, number][] = []; // [time, estimate] for the live speed
  private timings: Timings | null = null;
  private failed = false;
  private finished = false;
  private rest: string[] = []; // a line not finished yet, in pieces (joined once, at its end)
  private restLen = 0;
  private event = ''; // data lines of the event so far
  private tooBig = false; // the line being read is over MAX_EVENT
  private bad = false; // this event had such a line: skipped
  private decoder = new TextDecoder();

  constructor(
    readonly model: string,
    private readonly now: () => number = Date.now,
  ) {
    this.arrived = now();
    running.add(this);
  }

  // The request leaves for the model server (after a model switch, if any): the prompt clock starts.
  forwarded(): void {
    this.sent = this.now();
    this.phase = 'reading';
  }

  // A copy of one chunk of the answer. Never throws.
  feed(chunk: Uint8Array | string): void {
    if (this.finished) return;
    try {
      const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
      let from = 0;
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', from)) {
        this.rest.push(text.slice(from, i));
        from = i + 1;
        const raw = this.tooBig ? '' : this.rest.join('');
        this.rest = [];
        this.restLen = 0;
        if (this.tooBig) {
          this.tooBig = false;
          this.bad = true;
        } else this.line(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      }
      const tail = text.slice(from);
      if (tail && !this.tooBig) {
        this.rest.push(tail);
        this.restLen += tail.length;
        if (this.restLen + this.event.length > MAX_EVENT) {
          this.tooBig = true;
          this.rest = [];
          this.restLen = 0;
        }
      }
    } catch {
      /* a bad chunk only costs its numbers */
    }
  }

  private line(l: string): void {
    if (l === '') {
      const data = this.bad ? '' : this.event;
      this.event = '';
      this.bad = false;
      if (data) this.data(data);
      return;
    }
    if (!l.startsWith('data:') || this.bad) return; // event:, id:, comments
    const part = l.slice(l[5] === ' ' ? 6 : 5);
    if (this.event.length + part.length > MAX_EVENT) this.bad = true;
    else this.event = this.event ? `${this.event}\n${part}` : part;
  }

  private data(data: string): void {
    let e: { type?: string; message?: { usage?: Usage }; usage?: Usage; delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }; timings?: Timings };
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    if (!e || typeof e !== 'object') return;
    if (e.timings && typeof e.timings === 'object') this.timings = e.timings;
    if (e.type === 'message_start') this.usage(e.message?.usage);
    else if (e.type === 'message_delta') this.usage(e.usage);
    else if (e.type === 'error') this.failed = true;
    else if (e.type === 'content_block_delta') {
      const t = this.now();
      const d = e.delta ?? {};
      this.first ??= t;
      this.last = t;
      this.phase = d.type === 'thinking_delta' ? 'thinking' : 'writing';
      const piece = d.text ?? d.thinking ?? d.partial_json ?? '';
      this.estimate += Math.max(1, Math.round((typeof piece === 'string' ? piece.length : 0) / 4));
      this.samples.push([t, this.estimate]);
      while (this.samples.length > 2 && this.samples[1][0] < t - WINDOW_MS) this.samples.shift();
    }
  }

  private usage(u: Usage | undefined): void {
    if (!u || typeof u !== 'object') return;
    this.input = n(u.input_tokens) ?? this.input;
    this.cached = n(u.cache_read_input_tokens) ?? this.cached;
    const out = n(u.output_tokens);
    if (out) this.output = out; // message_start says 0: not a count yet
  }

  // Not an answer to measure (the server did not stream): forget it.
  drop(): void {
    this.finished = true;
    running.delete(this);
  }

  // The answer ended: 'ok' (the stream ran out), 'cancelled' (Claude Code hung up) or 'error'.
  end(outcome: 'ok' | 'cancelled' | 'error'): void {
    if (this.finished) return;
    this.finished = true;
    running.delete(this);
    const run = this.run();
    run.outcome = outcome === 'ok' && this.failed ? 'error' : outcome;
    delete run.phase;
    done.push(run);
    if (done.length > RECENT * 4) done.shift();
  }

  // The numbers so far (live) or at the end.
  run(): LocalSpeedRun {
    const t = this.now();
    const out = this.output ?? (this.estimate || null);
    const sent = this.sent ?? t;
    const firstTokenMs = this.first === null ? null : this.first - sent;
    const span = this.first !== null && this.last !== null ? this.last - this.first : 0;
    const tm = this.timings;
    const engineRead = n(tm?.prompt_per_second);
    const engineWrite = n(tm?.predicted_per_second);
    let readTps = engineRead;
    if (readTps === null && this.input && firstTokenMs && firstTokenMs > 0) readTps = this.input / (firstTokenMs / 1000);
    let writeTps = engineWrite;
    if (writeTps === null && out && span >= MIN_SPAN_MS) writeTps = out / (span / 1000);
    // Live: pieces over the last few seconds (drops while the stream is quiet).
    let nowTps: number | null = null;
    if (!this.finished && this.samples.length) {
      const [t0, e0] = this.samples[0];
      const dt = t - t0;
      nowTps = dt >= MIN_SPAN_MS ? (this.estimate - e0) / (dt / 1000) : null;
    }
    return {
      model: this.model,
      outcome: 'running',
      phase: this.phase,
      inputTokens: this.input,
      cachedTokens: this.cached,
      outputTokens: out,
      outputExact: this.output !== null,
      firstTokenMs,
      readTps: round1(readTps),
      readExact: engineRead !== null,
      writeTps: round1(writeTps),
      nowTps: round1(nowTps),
      totalMs: t - this.arrived,
      endedAt: this.finished ? t : null,
    };
  }
}

// The middle value: one odd request does not move it.
function median(v: (number | null)[]): number | null {
  const s = v.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function meterOn(): void {
  enabled = true;
}

// What the SYS panel gets: undefined when no local model is set up.
export function localSpeed(): LocalSpeed | undefined {
  if (!enabled) return undefined;
  const live = [...running].at(-1);
  const ok = done.filter((r) => r.outcome === 'ok').slice(-RECENT);
  return {
    live: live ? live.run() : null,
    last: done.at(-1) ?? null,
    recent: ok.length
      ? { count: ok.length, writeTps: round1(median(ok.map((r) => r.writeTps))), readTps: round1(median(ok.map((r) => r.readTps))), firstTokenMs: whole(median(ok.map((r) => r.firstTokenMs))) }
      : null,
  };
}

// Tests only.
export function resetMeter(): void {
  running.clear();
  done.length = 0;
}
