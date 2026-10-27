import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  checkAfter, Cue, Heard, parsePoints,
  type AfterJob, type PromptList, type PromptListSummary, type PrompterLive,
} from '../shared/prompter.ts';
import { DATA_DIR } from './config.ts';
import { prompterDecider, type PrompterDecider } from './prompterdecide.ts';

// PROMPTER (PLAN.md "PROMPTER"): punch lists for recording a video, the live session and the AFTER check.
// The page that has the mic streams it to the speech engine itself (/ws/voice, server/voice.ts) and sends the words
// here; this file keeps the rolling transcript, asks the decision model about once a second (server/prompterdecide.ts)
// and holds the session every screen shows (PC, second monitor, phone: they all poll GET live).
//
//   GET    /api/prompter/lists             -> { lists: PromptListSummary[] }
//   GET    /api/prompter/lists/<id>        -> PromptList
//   POST   /api/prompter/lists             { id?, name, text } -> PromptList (saved)
//   DELETE /api/prompter/lists/<id>
//   GET    /api/prompter/live[?v=<n>]      -> { live: PrompterLive | null, engine } ({ v } alone when nothing changed)
//   POST   /api/prompter/live/start        { name, text } -> { live, mic }: a new session (ends a running one)
//   POST   /api/prompter/live/mic          -> { mic }: this device's mic feeds the session from now on
//   POST   /api/prompter/live/feed         { mic, partial?, finals?, level? } (409: another device has the mic)
//   POST   /api/prompter/live/mark         { id, done }: tick or untick by hand
//   POST   /api/prompter/live/stop
//   GET    /api/prompter/sessions          -> { sessions }: saved transcripts, newest first
//   GET    /api/prompter/sessions/<id>     -> { id, name, text, list }
//   POST   /api/prompter/after             { points, transcript } -> { id }; GET /api/prompter/after/<id> -> AfterJob
//
// Data: data/prompter/lists/<id>.json, data/prompter/sessions/<id>.txt (the transcript, "[mm:ss] phrase" lines)
// and <id>.json (name, points, times). The newest MAX_SESSIONS are kept.

const DIR = join(DATA_DIR, 'prompter');
const LISTS = join(DIR, 'lists');
const SESSIONS = join(DIR, 'sessions');
const MAX_LISTS = 200;
const MAX_SESSIONS = 30;
const MAX_TEXT = 20_000; // a list's text
const MAX_TRANSCRIPT = 400_000; // AFTER: characters, about 7 hours of talk
const MAX_BODY = 64 * 1024;
const LOOP_MS = 400; // how often the loop looks for new words (a call starts only when there are some)
const MIC_STALE_MS = 6000; // no feed this long: the mic shows as off
const IDLE_END_MS = 30 * 60_000; // no feed this long: the session ends
const MAX_SESSION_MS = 6 * 3600_000;

// Swapped by tests/prompter.ts (a fake decider, a fake clock).
export const engine = { decider: prompterDecider as () => PrompterDecider, now: Date.now };

type Live = {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number | null;
  listText: string;
  cue: Cue;
  heard: Heard;
  mic: string; // the token of the device whose mic feeds it
  micSeen: number;
  level: number;
  v: number;
  timer: NodeJS.Timeout | null;
};

let live: Live | null = null;
let after: (AfterJob & { at: number }) | null = null;

const newId = () => {
  const d = new Date(engine.now());
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(2).toString('hex')}`;
};
const validId = (id: string) => /^[0-9a-z-]{4,40}$/.test(id);
const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

// ------------------------------------------------------------ lists

export function readList(id: string): PromptList | null {
  if (!validId(id)) return null;
  try {
    return JSON.parse(readFileSync(join(LISTS, `${id}.json`), 'utf8')) as PromptList;
  } catch {
    return null;
  }
}

export function listLists(): PromptListSummary[] {
  if (!existsSync(LISTS)) return [];
  return readdirSync(LISTS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readList(f.slice(0, -5)))
    .filter((l): l is PromptList => l !== null)
    .sort((a, b) => b.updated - a.updated)
    .map((l) => ({ id: l.id, name: l.name, points: parsePoints(l.text).length, updated: l.updated }));
}

export function saveList(b: { id?: unknown; name?: unknown; text?: unknown }): PromptList {
  const text = String(b.text ?? '').slice(0, MAX_TEXT);
  if (!parsePoints(text).length) throw new Error('The list has no points: write one point per line.');
  const name = clean(b.name, 80) || parsePoints(text)[0].text.slice(0, 40);
  const id = typeof b.id === 'string' && readList(b.id) ? b.id : randomBytes(4).toString('hex');
  if (id !== b.id && listLists().length >= MAX_LISTS) throw new Error(`At most ${MAX_LISTS} lists. Delete one first.`);
  mkdirSync(LISTS, { recursive: true });
  const l: PromptList = { id, name, text, updated: engine.now() };
  writeAtomic(join(LISTS, `${id}.json`), JSON.stringify(l, null, 1));
  return l;
}

// ------------------------------------------------------------ the live session

const stamp = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
};

function sessionMeta(l: Live): object {
  return { id: l.id, name: l.name, startedAt: l.startedAt, endedAt: l.endedAt, words: l.heard.words, list: l.listText, points: l.cue.points };
}

function saveSession(l: Live): void {
  try {
    mkdirSync(SESSIONS, { recursive: true });
    writeAtomic(join(SESSIONS, `${l.id}.json`), JSON.stringify(sessionMeta(l), null, 1));
  } catch (e) {
    console.warn('prompter: could not save the session:', e);
  }
}

function pruneSessions(): void {
  if (!existsSync(SESSIONS)) return;
  const ids = readdirSync(SESSIONS).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort().reverse();
  for (const id of ids.slice(MAX_SESSIONS)) {
    rmSync(join(SESSIONS, `${id}.json`), { force: true });
    rmSync(join(SESSIONS, `${id}.txt`), { force: true });
  }
}

const changed = () => {
  if (live) live.v++;
};

export function liveState(): PrompterLive | null {
  const l = live;
  if (!l) return null;
  const now = engine.now();
  const d = engine.decider();
  return {
    id: l.id,
    name: l.name,
    startedAt: l.startedAt,
    endedAt: l.endedAt,
    points: l.cue.points,
    heard: l.heard.tail(),
    words: l.heard.words,
    mic: !l.endedAt && now - l.micSeen < MIC_STALE_MS ? 'on' : 'off',
    level: l.level,
    engine: { ready: d.ready, label: d.label, note: d.note },
    calls: l.cue.calls,
    callMs: l.cue.callMs,
    error: l.cue.error,
    v: l.v,
  };
}

export function startLive(nameIn: unknown, textIn: unknown): { live: PrompterLive; mic: string } {
  const text = String(textIn ?? '').slice(0, MAX_TEXT);
  const points = parsePoints(text);
  if (!points.length) throw new Error('The list has no points: write one point per line.');
  if (live && !live.endedAt) stopLive();
  const now = engine.now();
  const l: Live = {
    id: newId(), name: clean(nameIn, 80) || 'Recording', startedAt: now, endedAt: null, listText: text,
    cue: new Cue(points, now, changed), heard: new Heard(), mic: randomBytes(12).toString('hex'), micSeen: 0, level: 0, v: 1, timer: null,
  };
  live = l;
  saveSession(l);
  pruneSessions();
  l.timer = setInterval(() => loop(l), LOOP_MS);
  l.timer.unref();
  return { live: liveState()!, mic: l.mic };
}

function loop(l: Live): void {
  const now = engine.now();
  if (now - Math.max(l.micSeen, l.startedAt) > IDLE_END_MS || now - l.startedAt > MAX_SESSION_MS) return void stopLive();
  const d = engine.decider();
  if (l.cue.step(l.heard, d.decide, now)) changed();
}

export function stopLive(): boolean {
  const l = live;
  if (!l || l.endedAt) return false;
  if (l.timer) clearInterval(l.timer);
  l.timer = null;
  l.endedAt = engine.now();
  l.level = 0;
  l.v++;
  saveSession(l);
  return true;
}

export function claimMic(): string | null {
  if (!live || live.endedAt) return null;
  live.mic = randomBytes(12).toString('hex');
  live.micSeen = engine.now();
  live.v++;
  return live.mic;
}

// Words from the device with the mic. Finals also go to the transcript file.
export function feed(b: { mic?: unknown; partial?: unknown; finals?: unknown; level?: unknown }): 'ok' | 'gone' | 'taken' {
  const l = live;
  if (!l || l.endedAt) return 'gone';
  if (b.mic !== l.mic) return 'taken';
  const now = engine.now();
  const wasOff = now - l.micSeen >= MIC_STALE_MS;
  l.micSeen = now;
  const before = l.heard.version;
  const finals = Array.isArray(b.finals) ? b.finals.slice(0, 20).map((f) => clean(f, 4000)).filter(Boolean) : [];
  for (const f of finals) {
    l.heard.add(f, true, now);
    try {
      mkdirSync(SESSIONS, { recursive: true });
      appendFileSync(join(SESSIONS, `${l.id}.txt`), `[${stamp(now - l.startedAt)}] ${f}\n`);
    } catch {
      /* the live session goes on without its file */
    }
  }
  if (typeof b.partial === 'string') l.heard.add(clean(b.partial, 2000), false, now);
  const level = Math.max(0, Math.min(1, Number(b.level) || 0));
  if (l.heard.version !== before || wasOff || Math.abs(level - l.level) > 0.05) {
    l.level = level;
    l.v++;
  }
  return 'ok';
}

export function mark(id: unknown, done: unknown): boolean {
  if (!live || typeof id !== 'string') return false;
  const ok = live.cue.mark(id, done === true, engine.now());
  if (ok && live.endedAt) saveSession(live);
  return ok;
}

// ------------------------------------------------------------ saved sessions

export function listSessions(): { id: string; name: string; startedAt: number; endedAt: number | null; words: number }[] {
  if (!existsSync(SESSIONS)) return [];
  return readdirSync(SESSIONS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readSession(f.slice(0, -5)))
    .filter((s) => s !== null)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(({ id, name, startedAt, endedAt, words }) => ({ id, name, startedAt, endedAt, words }));
}

export function readSession(id: string): { id: string; name: string; startedAt: number; endedAt: number | null; words: number; list: string; text: string } | null {
  if (!validId(id)) return null;
  try {
    const m = JSON.parse(readFileSync(join(SESSIONS, `${id}.json`), 'utf8'));
    const file = join(SESSIONS, `${id}.txt`);
    const text = existsSync(file) && statSync(file).size < MAX_TRANSCRIPT * 2 ? readFileSync(file, 'utf8') : '';
    const words = live?.id === id ? live.heard.words : Number(m.words) || 0;
    return { id, name: String(m.name ?? ''), startedAt: Number(m.startedAt) || 0, endedAt: m.endedAt ?? null, words, list: String(m.list ?? ''), text };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ AFTER

export function startAfter(pointsText: unknown, transcript: unknown): string {
  if (after?.state === 'running') throw new Error('A check is running. Wait for it to finish.');
  const points = parsePoints(String(pointsText ?? '').slice(0, MAX_TEXT));
  const text = String(transcript ?? '');
  if (!points.length) throw new Error('The list has no points: write one point per line.');
  if (!text.trim()) throw new Error('Paste or load the transcript first.');
  if (text.length > MAX_TRANSCRIPT) throw new Error('The transcript is too long.');
  const d = engine.decider();
  if (!d.decide) throw new Error(d.note);
  const job: AfterJob & { at: number } = {
    id: randomBytes(6).toString('hex'), state: 'running', done: 0, total: 1, by: d.label, error: '', at: engine.now(),
    points: points.map((p) => ({ ...p, covered: false, quote: '', at: '' })),
  };
  after = job;
  checkAfter(text, points, d.decide, (done, total) => Object.assign(job, { done, total }))
    .then((res) => Object.assign(job, { state: 'done', points: res, done: job.total }))
    .catch((e: unknown) => Object.assign(job, { state: 'error', error: e instanceof Error ? e.message : String(e) }));
  return job.id;
}

// ------------------------------------------------------------ HTTP (server/index.ts)

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

// JSON only: a plain form on another site cannot send this content type.
function body(req: IncomingMessage, max = MAX_BODY): Promise<Record<string, unknown>> {
  return new Promise((ok, no) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      req.resume();
      return no(new Error('Send JSON.'));
    }
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        no(new Error('Too big.'));
      } else parts.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
        ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        no(new Error('Bad JSON.'));
      }
    });
    req.on('error', no);
  });
}

export async function handlePrompter(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname.replace(/\/+$/, '');
  const post = req.method === 'POST';
  const err = (e: unknown, status = 400) => json(res, { error: e instanceof Error ? e.message : String(e) }, status);
  try {
    if (path === '/api/prompter/live' && req.method === 'GET') {
      const v = Number(url.searchParams.get('v') ?? NaN);
      if (live && v === live.v) return json(res, { v });
      const d = engine.decider();
      return json(res, { live: liveState(), engine: { ready: d.ready, label: d.label, note: d.note }, now: engine.now() });
    }
    if (path === '/api/prompter/live/feed' && post) {
      const r = feed(await body(req));
      if (r === 'taken') return json(res, { error: 'Another device has the mic now.' }, 409);
      if (r === 'gone') return json(res, { error: 'The session has ended.' }, 410);
      return json(res, { ok: true });
    }
    if (path === '/api/prompter/live/start' && post) {
      const b = await body(req);
      return json(res, startLive(b.name, b.text));
    }
    if (path === '/api/prompter/live/mic' && post) {
      const mic = claimMic();
      return mic ? json(res, { mic }) : json(res, { error: 'No session is running.' }, 410);
    }
    if (path === '/api/prompter/live/mark' && post) {
      const b = await body(req);
      mark(b.id, b.done);
      return json(res, { live: liveState() });
    }
    if (path === '/api/prompter/live/stop' && post) {
      stopLive();
      return json(res, { live: liveState() });
    }
    if (path === '/api/prompter/lists') {
      if (req.method === 'GET') return json(res, { lists: listLists() });
      if (post) return json(res, saveList(await body(req)));
    }
    const lm = /^\/api\/prompter\/lists\/([^/]+)$/.exec(path);
    if (lm) {
      const l = readList(lm[1]);
      if (!l) return json(res, { error: 'not found' }, 404);
      if (req.method === 'GET') return json(res, l);
      if (req.method === 'DELETE') {
        rmSync(join(LISTS, `${l.id}.json`), { force: true });
        return json(res, { ok: true });
      }
    }
    if (path === '/api/prompter/sessions' && req.method === 'GET') return json(res, { sessions: listSessions() });
    const sm = /^\/api\/prompter\/sessions\/([^/]+)$/.exec(path);
    if (sm && req.method === 'GET') {
      const s = readSession(sm[1]);
      return s ? json(res, s) : json(res, { error: 'not found' }, 404);
    }
    if (path === '/api/prompter/after' && post) {
      const b = await body(req, MAX_TRANSCRIPT * 4 + MAX_TEXT * 4);
      return json(res, { id: startAfter(b.points, b.transcript) });
    }
    const am = /^\/api\/prompter\/after\/([0-9a-f]+)$/.exec(path);
    if (am && req.method === 'GET') {
      if (!after || after.id !== am[1]) return json(res, { error: 'not found' }, 404);
      const { at: _at, ...job } = after;
      return json(res, job);
    }
  } catch (e) {
    return err(e);
  }
  return json(res, { error: 'not found' }, 404);
}

// Tests: forget the live session and the AFTER job.
export function resetPrompter(): void {
  if (live?.timer) clearInterval(live.timer);
  live = null;
  after = null;
}
