import type { VoiceLiveEvent } from '../../shared/protocol.ts';
import { loadWorklet, micError, openMic, Recorder } from './voice.ts';

// PROMPTER's mic: this device's mic streams to the PC's speech engine over /ws/voice (the same engine and socket as
// DICTATE, server/voice.ts), and the words it sends back go to POST /api/prompter/live/feed, where the session is.
// The engine takes 10 minutes per socket, so a fresh socket takes over every ROLL_MS and the old one finishes its
// last phrase: an hour or more keeps working, and nothing here grows (audio is sent and dropped, words are fed and
// dropped).

const ROLL_MS = 9 * 60_000;
const FEED_MS = 500; // words and the level go to the PC at most this often
const BEAT_MS = 3000; // and at least this often, so the screens know the mic is on
const RETRY_MS = 3000; // a socket that broke is opened again after this
const MAX_QUEUE = 300; // 100 ms blocks kept while a socket connects (30 s)
const STOP_WAIT_MS = 3000; // STOP waits this long for the last phrase

export type MicState = 'starting' | 'loading' | 'on' | 'error';

type Sock = { ws: WebSocket; queue: Int16Array<ArrayBuffer>[]; ready: boolean; ending: boolean; done: Promise<void>; finish: () => void };

export class CueMic {
  private rec: Recorder | null = null;
  private cur: Sock | null = null;
  private socks = new Set<Sock>();
  private finals: string[] = [];
  private partial: string | null = null;
  private level = 0;
  private sentLevel = -1;
  private lastFeed = 0;
  private feeding = false;
  private timer = 0;
  private roll = 0;
  private retry = 0;
  private stopped = false;

  constructor(
    private token: () => string, // the session's mic token, '' until the server answered START
    private onState: (s: MicState, note?: string) => void,
    private onGone: (why: 'taken' | 'ended') => void,
  ) {}

  // Call inside the click: phones only start audio there.
  start(): void {
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return this.fail('This browser cannot record audio here.');
    }
    void ctx.resume().catch(() => {});
    const worklet = loadWorklet(ctx);
    worklet.catch(() => {});
    this.onState('starting');
    this.cur = this.open();
    openMic()
      .then(async (stream) => {
        if (this.stopped) {
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close();
          return;
        }
        this.rec = await Recorder.open(ctx, stream, worklet, (pcm, peak) => this.onAudio(pcm, peak));
        if (this.stopped) this.rec.close();
      })
      .catch((e: unknown) => {
        void ctx.close().catch(() => {});
        this.fail(micError(e));
      });
    this.timer = window.setInterval(() => void this.feed(), FEED_MS);
    this.roll = window.setInterval(() => this.rollOver(), ROLL_MS);
  }

  // Let the last phrase come in (a few seconds at most), send it, let go of the mic.
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.roll);
    clearTimeout(this.retry);
    await this.rec?.stop();
    this.rec = null;
    const last = [...this.socks];
    for (const s of last) this.end(s);
    await Promise.race([Promise.all(last.map((s) => s.done)), new Promise((r) => setTimeout(r, STOP_WAIT_MS))]);
    for (const s of last) s.ws.close();
    clearInterval(this.timer);
    while (this.feeding) await new Promise((r) => setTimeout(r, 50));
    this.partial = '';
    await this.feed(true);
  }

  private fail(note: string): void {
    this.onState('error', note);
    void this.stop();
  }

  private open(): Sock {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/voice`);
    ws.binaryType = 'arraybuffer';
    let finish = () => {};
    const s: Sock = { ws, queue: [], ready: false, ending: false, done: new Promise<void>((r) => (finish = r)), finish: () => finish() };
    this.socks.add(s);
    ws.onopen = () => {
      for (const c of s.queue) ws.send(c);
      s.queue = [];
      if (s.ending) ws.send('{"t":"end"}');
      if (s === this.cur && !s.ready) this.onState('loading');
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let ev: VoiceLiveEvent;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      if (ev.t === 'ready') {
        s.ready = true;
        if (s === this.cur) this.onState('on');
      } else if (ev.t === 'partial') {
        if (s === this.cur) this.partial = ev.text;
      } else if (ev.t === 'final') {
        if (ev.text.trim()) this.finals.push(ev.text);
        if (s === this.cur) this.partial = '';
      } else if (ev.t === 'error') {
        if (/not installed/i.test(ev.error)) this.fail(ev.error);
        else if (s === this.cur) this.onState('loading', ev.error);
      }
    };
    ws.onclose = () => {
      this.socks.delete(s);
      s.finish();
      if (s !== this.cur || this.stopped) return;
      // Broke (the engine restarted, the network blinked): open a new one; audio waits in its queue meanwhile.
      this.onState('loading', 'Reconnecting to the speech engine…');
      this.cur = null;
      this.retry = window.setTimeout(() => {
        if (!this.stopped) this.cur = this.open();
      }, RETRY_MS);
    };
    return s;
  }

  private end(s: Sock): void {
    if (s.ending) return;
    s.ending = true;
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send('{"t":"end"}');
  }

  // A fresh socket takes the audio from now on; the old one turns its last phrase into text and closes.
  private rollOver(): void {
    const old = this.cur;
    if (!old || this.stopped) return;
    this.cur = this.open();
    this.cur.ready = old.ready;
    this.end(old);
  }

  private onAudio(pcm: Int16Array<ArrayBuffer>, peak: number): void {
    this.level = Math.max(0, Math.min(1, (20 * Math.log10(peak + 1e-9) + 60) / 60));
    const s = this.cur;
    if (s && s.ws.readyState === WebSocket.OPEN) s.ws.send(pcm);
    else {
      const q = s?.queue ?? [];
      q.push(pcm);
      if (q.length > MAX_QUEUE) q.shift();
    }
  }

  private async feed(force = false): Promise<void> {
    if (this.feeding || !this.token()) return;
    const now = performance.now();
    const level = Math.round(this.level * 10) / 10;
    if (!force && !this.finals.length && this.partial === null && level === this.sentLevel && now - this.lastFeed < BEAT_MS) return;
    const finals = this.finals.splice(0);
    const partial = this.partial;
    this.partial = null;
    this.feeding = true;
    try {
      const r = await fetch('/api/prompter/live/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mic: this.token(), finals, ...(partial !== null && { partial }), level: this.stopped ? 0 : level }),
      });
      this.lastFeed = now;
      this.sentLevel = level;
      if ((r.status === 409 || r.status === 410) && !this.stopped) {
        this.onGone(r.status === 409 ? 'taken' : 'ended');
        void this.stop();
      }
    } catch {
      this.finals.unshift(...finals); // the network blinked: send them with the next feed
    } finally {
      this.feeding = false;
    }
  }
}
