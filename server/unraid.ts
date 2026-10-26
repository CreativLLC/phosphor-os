import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { UnraidLinkState, UnraidResponse, UnraidSummary } from '../shared/unraid.ts';
import { DATA_DIR } from './config.ts';
import { askPart, graphqlUrl, httpSend, Link, PARTS, PART_LABEL, parseUnraid, unraidAlerts, type Part, type Send } from './unraidapi.ts';

// STATION > Unraid, the server side: the two .env lines, polling, the last answer, and GET /api/station/unraid.
//   PHOSPHOR_UNRAID_URL   the server's address, like http://192.168.1.10 (no path needed)
//   PHOSPHOR_UNRAID_KEY   an Unraid API key made with the VIEWER role (read-only)
//   PHOSPHOR_UNRAID_SELF_SIGNED=1   only if the address is https with a certificate this PC does not trust
//   PHOSPHOR_UNRAID_SMART=1         also ask for each disk's SMART status (off: Unraid's API may wake sleeping disks for it)
// Read-only, and for the owner's eyes only. The key and the address are taken out of the environment at start (so the
// Claude processes this server starts do not inherit them), live in a Link whose key cannot be printed, and are never
// logged, written to data/ or sent to the page. The summary goes to the logged-in page only: no chat tool, MCP tool or
// prompt touches it (tests/station-unraid.ts checks that no chat code imports this).
// Polling: about every 60 s while a page has STATION open (it asks every 15 s; ?peek=1 does not count), else every 10
// minutes, so the badge on the STATION button and "a container stopped" keep working with the drawer closed. The last good
// answer is kept in memory. data/station-unraid.json holds only which containers were running (for "has stopped").

const OPEN_MS = 60_000;
const IDLE_MS = 10 * 60_000;
const OPEN_GRACE_MS = 45_000; // the page asks every 15 s: asked within this long ago = STATION is on screen
const TICK_MS = 30_000;
const SMART_MS = 60 * 60_000; // SMART status, when asked for at all, at most this often
const FILE = join(DATA_DIR, 'station-unraid.json');

export type UnraidSetup = { link: Link | null; problem: string; smart?: boolean };

// Reads the .env lines and removes them from the environment. Half a setup says which line is missing.
export function takeSetup(env: NodeJS.ProcessEnv = process.env): UnraidSetup {
  const address = (env.PHOSPHOR_UNRAID_URL ?? '').trim();
  const key = (env.PHOSPHOR_UNRAID_KEY ?? '').trim();
  const flag = (v?: string) => /^(1|true|yes|on)$/i.test((v ?? '').trim());
  const selfSigned = flag(env.PHOSPHOR_UNRAID_SELF_SIGNED);
  const smart = flag(env.PHOSPHOR_UNRAID_SMART);
  delete env.PHOSPHOR_UNRAID_URL;
  delete env.PHOSPHOR_UNRAID_KEY;
  delete env.PHOSPHOR_UNRAID_SELF_SIGNED;
  delete env.PHOSPHOR_UNRAID_SMART;
  if (!address && !key) return { link: null, problem: '' };
  if (!address) return { link: null, problem: 'PHOSPHOR_UNRAID_URL is empty.' };
  if (!key) return { link: null, problem: 'PHOSPHOR_UNRAID_KEY is empty.' };
  const url = graphqlUrl(address);
  if (!url) return { link: null, problem: 'PHOSPHOR_UNRAID_URL is not a web address. Use something like http://192.168.1.10.' };
  return { link: new Link(url, key, selfSigned), problem: '', smart };
}

type Seen = Record<string, { up: boolean; at: number }>;

const LOG_WORDS: Record<UnraidLinkState, string> = { loading: 'waiting', ok: 'connected', down: 'no answer', auth: 'the key was refused', wrong: 'that address is not Unraid\'s API', error: 'no usable answer' };

export type WatchOptions = {
  setup: UnraidSetup;
  send?: Send; // tests give a fake; otherwise a real request to the link
  now?: () => number;
  file?: string | null; // where to remember running containers; null = nowhere
  log?: (line: string) => void;
};

export class UnraidWatch {
  private state: UnraidLinkState = 'loading';
  private note = '';
  private at = 0;
  private okAt: number | null = null;
  private summary: UnraidSummary | null = null;
  private gaps: string[] = [];
  private running: Promise<void> | null = null;
  private openAt = 0;
  private logged = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly dropped = new Map<Part, Set<string>>(); // fields this Unraid does not have, per part
  private seen: Seen;
  private smartTried = 0;
  private smartData: Record<string, unknown> | null = null;
  private readonly now: () => number;
  private readonly file: string | null;
  private readonly log: (line: string) => void;

  constructor(private readonly o: WatchOptions) {
    this.now = o.now ?? Date.now;
    this.file = o.file === undefined ? FILE : o.file;
    this.log = o.log ?? ((line) => console.log(line));
    this.seen = this.load();
  }

  get configured(): boolean {
    return !!this.o.setup.link;
  }

  start(): void {
    if (!this.configured || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // A page has STATION open: answer from the last poll, and poll again when that is a minute old (same rule as tick).
  onScreen(): void {
    if (!this.configured) return;
    this.openAt = this.now();
    this.tick();
  }

  private tick(): void {
    if (this.running) return;
    const open = this.now() - this.openAt < OPEN_GRACE_MS;
    // A refused key or a wrong address will not mend itself: look again only now and then.
    const patient = this.state === 'auth' || this.state === 'wrong' || this.state === 'error';
    const every = open && !patient ? OPEN_MS : IDLE_MS;
    if (this.now() - this.at >= every - 1000) void this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.configured) return Promise.resolve();
    this.running ??= this.poll()
      .catch(() => this.finish('error', 'Something went wrong reading Unraid\'s answer.'))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  view(): UnraidResponse {
    const t = this.now();
    return {
      configured: this.configured,
      problem: this.o.setup.problem,
      state: this.state,
      note: this.note,
      at: this.at,
      okAt: this.okAt,
      checking: !!this.running || (this.configured && this.at === 0),
      everyMs: OPEN_MS,
      summary: this.summary,
      alerts: this.summary ? unraidAlerts(this.summary, t) : [],
      gaps: this.gaps,
    };
  }

  // ---------------------------------------------------------------- one poll

  private async poll(): Promise<void> {
    const link = this.o.setup.link!;
    const send = this.o.send ?? httpSend(link);
    const parts: Partial<Record<Part, Record<string, unknown>>> = {};
    const gaps: string[] = [];
    let stop: { state: UnraidLinkState; note: string } | null = null;
    let forbidden = 0;
    // One part at a time. The link itself failing (no answer, key refused, wrong address) ends the poll at once.
    for (const part of PARTS) {
      if (part === 'disks') {
        // SMART status: only if asked for in .env, and not more than once an hour (it can wake sleeping disks).
        if (!this.o.setup.smart) continue;
        if (this.now() - this.smartTried < SMART_MS) {
          if (this.smartData) parts.disks = this.smartData;
          continue;
        }
        this.smartTried = this.now();
      }
      const drop = this.dropped.get(part) ?? new Set<string>();
      this.dropped.set(part, drop);
      const r = await askPart(part, send, drop, (s) => link.scrub(s));
      if (r.ok) {
        parts[part] = r.data;
        if (part === 'disks') this.smartData = r.data;
        continue;
      }
      if (r.why === 'down' || r.why === 'auth' || r.why === 'wrong' || r.why === 'limit') {
        stop = { state: r.why === 'limit' ? 'error' : r.why, note: r.note };
        break;
      }
      if (r.why === 'forbidden') forbidden++;
      // A server that never ran a parity check has no history file: Unraid says so as an error, which is not news.
      const quiet = part === 'parity' && /not found/i.test(r.note);
      if (!quiet && (PART_LABEL[part] || r.why === 'forbidden')) gaps.push(`${PART_LABEL[part] || part.toUpperCase()}: ${r.note}`);
    }
    if (stop) return this.finish(stop.state, stop.note);
    if (!Object.keys(parts).length) {
      return this.finish(forbidden ? 'auth' : 'error', forbidden ? 'Unraid accepts the key, but it may read nothing. Make it with the VIEWER role.' : 'Unraid answered, but with nothing this page can use.');
    }
    const t = this.now();
    const summary = parseUnraid(parts, t);
    this.track(summary, t);
    this.summary = summary;
    this.gaps = gaps;
    this.okAt = t;
    this.finish('ok', '');
  }

  private finish(state: UnraidLinkState, note: string): void {
    this.state = state;
    this.note = note;
    this.at = this.now();
    // The log gets the state in words, once per change; never the address, the key or anything Unraid said.
    if (this.logged !== state) {
      this.logged = state;
      this.log(`unraid: ${LOG_WORDS[state]}`);
    }
  }

  // ---------------------------------------------------------------- containers that stopped

  // Remembers which containers were running, so one that is stopped now but was running at the last answer shows as
  // stopped (stoppedAt) even when it is not set to start with the array. Docker not answering changes nothing.
  private track(s: UnraidSummary, t: number): void {
    if (!s.containers) return;
    const next: Seen = {};
    for (const c of s.containers) {
      const old = this.seen[c.name];
      if (c.state !== 'stopped') next[c.name] = { up: true, at: old?.up ? old.at : t };
      else if (old?.up) next[c.name] = { up: false, at: t };
      else if (old) next[c.name] = old;
      if (c.state === 'stopped' && next[c.name]) c.stoppedAt = next[c.name].at;
    }
    if (JSON.stringify(next) !== JSON.stringify(this.seen)) {
      this.seen = next;
      this.store();
    }
  }

  private load(): Seen {
    if (!this.file) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { containers?: Record<string, { up?: unknown; at?: unknown }> };
      const out: Seen = {};
      for (const [name, v] of Object.entries(raw.containers ?? {})) if (typeof v?.up === 'boolean' && typeof v.at === 'number') out[name] = { up: v.up, at: v.at };
      return out;
    } catch {
      return {};
    }
  }

  private store(): void {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ containers: this.seen }));
      renameSync(tmp, this.file);
    } catch {
      /* the memory is a nicety */
    }
  }
}

// ---------------------------------------------------------------- route

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

// GET /api/station/unraid (login-only: server/station.ts is reached after the login check in server/index.ts).
// Counts as "STATION is on screen" unless it has ?peek=1 (the page's badge check).
export const unraidRoute = (watch: UnraidWatch) => async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
  if (req.method !== 'GET') return json(res, { error: 'GET only.' }, 405);
  if (!url.searchParams.has('peek')) watch.onScreen();
  return json(res, watch.view());
};

const watch = new UnraidWatch({ setup: takeSetup() });
export const handleUnraid = unraidRoute(watch);
export const startUnraid = (): void => watch.start();
