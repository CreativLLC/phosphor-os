import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  isStationKind,
  type StationCheck,
  type StationDiscoverResponse,
  type StationEntry,
  type StationResponse,
  type StationService,
  type StationStatus,
} from '../shared/station.ts';
import { DATA_DIR } from './config.ts';
import { DISCOVER_PORTS, discoverHost, probe, resolveLanHost } from './lan.ts';
import { Health } from './stationhealth.ts';
import { handleUnraid } from './unraid.ts';

// STATION: the owner's self-hosted services (data/station.json), with health checks and DISCOVER.
// Routes (login-only; server/index.ts sends /api/station* here after the login check):
//   GET  /api/station            list + status. Counts as "STATION is on screen": while such GETs keep coming,
//                                every service is checked once a minute. Nothing is checked otherwise.
//   GET  /api/station?peek=1     the same list without counting as on screen (the page's skins and launcher).
//   POST /api/station/check      { id? } check one or all now
//   POST /api/station/save       StationSaveRequest -> add (no id) or change
//   POST /api/station/remove     { id }
//   POST /api/station/discover   { host } -> StationDiscoverResponse (own network only: server/lan.ts)
//   GET  /api/station/unraid     the Unraid server's health, if connected (server/unraid.ts)
// A check is one GET with a 3 s limit that stops at the response headers; same-host redirects are followed,
// other hosts never. "Self-signed" relaxes the certificate check for that service's checks only.
// With nobody looking, every service is still checked every 10 minutes (startStation), so each tile's 24-hour strip
// (server/stationhealth.ts, data/station-health.json) has something in it.

const FILE = join(DATA_DIR, 'station.json');
const SEEN_FILE = join(DATA_DIR, 'station-seen.json');
const health = new Health(join(DATA_DIR, 'station-health.json'));
const EVERY_MS = 60_000;
const IDLE_MS = 10 * 60_000; // checks when no screen has STATION open
const SLOW_MS = 2000; // a public app behind a redirect (two TLS handshakes) takes about 1.1 s
const TIMEOUT_MS = 3000;
const HISTORY = 40;
const CONCURRENCY = 6;
const MAX_SERVICES = 60;
const MANUAL_GAP_MS = 3000; // CHECK pressed again quickly: answer from the last round
const DISCOVER_WINDOW_MS = 5 * 60_000;
const DISCOVER_MAX = 8; // per window

let services: StationService[] = load();
const status = new Map<string, StationStatus>();
const seen: Record<string, number> = loadSeen();
let round: Promise<void> | null = null;
let roundAt = 0;
let manualAt = 0;
let discovering = false;
const discoverTimes: number[] = [];

// ---------------------------------------------------------------- data

function load(): StationService[] {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as { services?: unknown };
    return Array.isArray(raw.services) ? raw.services.map((s) => clean(s)).filter((s): s is StationService => !!s) : [];
  } catch {
    return [];
  }
}

function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(SEEN_FILE, 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

// Atomic write: a crash mid-save keeps the old file.
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function save(): void {
  writeJson(FILE, { services });
}

// A service from the file or the page, checked field by field. null = unusable.
function clean(x: unknown, id?: string): StationService | null {
  if (!x || typeof x !== 'object') return null;
  const s = x as Record<string, unknown>;
  const name = typeof s.name === 'string' ? s.name.replace(/\s+/g, ' ').trim().slice(0, 32) : '';
  const url = webAddress(s.url);
  if (!name || !url) return null;
  return {
    id: id ?? (typeof s.id === 'string' && /^[\w-]{1,40}$/.test(s.id) ? s.id : randomUUID()),
    name,
    url,
    kind: isStationKind(s.kind) ? s.kind : 'generic',
    selfSigned: s.selfSigned === true,
    skin: s.skin !== false,
  };
}

// "nas.local:8080" or a full http(s) address -> a normalized http(s) URL, else null.
export function webAddress(v: unknown): string | null {
  let s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 2048) return null;
  if (!/^[a-z][\w+.-]*:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

const blankStatus = (): StationStatus => ({ state: 'unknown', ms: null, code: null, at: 0, lastUp: null, note: '', history: [] });

function statusOf(s: StationService): StationStatus {
  let st = status.get(s.id);
  if (!st) {
    st = { ...blankStatus(), lastUp: seen[s.id] ?? null };
    status.set(s.id, st);
  }
  return st;
}

function view(): StationResponse {
  const list: StationEntry[] = services.map((s) => ({ ...s, status: statusOf(s), day: health.day(s.id) }));
  return { services: list, checking: !!round, everyMs: EVERY_MS, slowMs: SLOW_MS };
}

// ---------------------------------------------------------------- checks

export async function checkOne(s: StationService): Promise<StationStatus> {
  const r = await probe(s.url, { timeoutMs: TIMEOUT_MS, insecure: s.selfSigned, readBody: 0, hops: 2 });
  const st = statusOf(s);
  const at = Date.now();
  let state: StationStatus['state'];
  let note = '';
  if (r.code === null) {
    state = 'down';
    note = r.error;
  } else if (r.code >= 500) {
    state = 'down';
    note = `It answered ${r.code}: the app behind the address may be stopped.`;
  } else {
    state = r.ms >= SLOW_MS ? 'slow' : 'up';
    if (state === 'slow') note = `Slow: ${r.ms} ms to answer.`;
    else if (r.offHost) note = `Sends you on to ${r.offHost}.`;
  }
  const check: StationCheck = { at, state, ms: r.code === null ? null : r.ms };
  const history = [...st.history, check].slice(-HISTORY);
  const lastUp = state === 'down' ? st.lastUp : at;
  const next: StationStatus = { state, ms: check.ms, code: r.code, at, lastUp, note, history };
  // The service may have been removed or changed while it was checked.
  if (services.some((x) => x.id === s.id && x.url === s.url)) {
    status.set(s.id, next);
    health.note(s.id, at, state, check.ms);
    if (lastUp) seen[s.id] = lastUp;
  }
  return next;
}

function runRound(only?: string): Promise<void> {
  if (round) return round;
  if (!only) roundAt = Date.now();
  const list = services.filter((s) => !only || s.id === only);
  round = (async () => {
    let i = 0;
    const worker = async () => {
      while (i < list.length) await checkOne(list[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
    for (const id of Object.keys(seen)) if (!services.some((s) => s.id === id)) delete seen[id];
    try {
      writeJson(SEEN_FILE, seen);
    } catch {
      /* "last seen" is a nicety */
    }
    health.save(new Set(services.map((s) => s.id)));
  })().finally(() => {
    round = null;
  });
  return round;
}

// Every 10 minutes, a round when no screen has asked for one lately (an open STATION runs its own every minute).
export function startStation(): void {
  setInterval(() => {
    if (services.length && !round && Date.now() - roundAt >= IDLE_MS - 1000) void runRound();
  }, 60_000).unref();
}

// ---------------------------------------------------------------- routes

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (c) => {
      text += c;
      if (text.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(text || '{}');
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

export async function handleStation(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  if (path === '/api/station/unraid') return handleUnraid(req, res, url);
  if (path === '/api/station' && req.method === 'GET') {
    // On screen somewhere: check when the last round is a minute old. The answer does not wait for it.
    if (!url.searchParams.has('peek') && services.length && !round && Date.now() - roundAt >= EVERY_MS) void runRound();
    return json(res, view());
  }
  // JSON only: a form on another page cannot send it without the browser asking this server first.
  if (req.method !== 'POST' || !String(req.headers['content-type'] ?? '').includes('application/json')) return json(res, { error: 'POST JSON only.' }, 405);
  const b = await body(req);

  if (path === '/api/station/check') {
    const id = typeof b.id === 'string' ? b.id : undefined;
    if (id && !services.some((s) => s.id === id)) return json(res, { ...view(), error: 'No such service.' }, 404);
    if (round) await round;
    else if (Date.now() - manualAt >= MANUAL_GAP_MS || id) {
      manualAt = Date.now();
      await runRound(id);
    }
    return json(res, view());
  }

  if (path === '/api/station/save') {
    const id = typeof b.id === 'string' && b.id ? b.id : undefined;
    const old = id ? services.find((s) => s.id === id) : undefined;
    if (id && !old) return json(res, { ...view(), error: 'That service was removed.' }, 404);
    if (!old && services.length >= MAX_SERVICES) return json(res, { ...view(), error: `STATION holds ${MAX_SERVICES} services. Remove one first.` }, 400);
    const s = clean(b, old?.id ?? randomUUID());
    if (!s) return json(res, { ...view(), error: 'Give it a name and a web address (http or https).' }, 400);
    services = old ? services.map((x) => (x.id === s.id ? s : x)) : [...services, s];
    // A new address starts a new history.
    if (old && old.url !== s.url) {
      status.delete(s.id);
      delete seen[s.id];
      health.forget(s.id);
    }
    save();
    await checkOne(s);
    return json(res, view());
  }

  if (path === '/api/station/remove') {
    const id = typeof b.id === 'string' ? b.id : '';
    services = services.filter((s) => s.id !== id);
    status.delete(id);
    delete seen[id];
    health.forget(id);
    save();
    return json(res, view());
  }

  if (path === '/api/station/discover') {
    if (discovering) return json(res, { error: 'A DISCOVER is already running. Wait for it.' }, 429);
    const now = Date.now();
    while (discoverTimes.length && now - discoverTimes[0] > DISCOVER_WINDOW_MS) discoverTimes.shift();
    if (discoverTimes.length >= DISCOVER_MAX) return json(res, { error: 'DISCOVER ran many times just now. Try again in a few minutes.' }, 429);
    const host = await resolveLanHost(String(b.host ?? ''));
    if ('error' in host) return json(res, { host: String(b.host ?? ''), addresses: [], results: [], scanned: 0, ms: 0, error: host.error } satisfies StationDiscoverResponse, 400);
    discoverTimes.push(now);
    discovering = true;
    try {
      const results = await discoverHost(host.host, host.addresses[0]);
      return json(res, { host: host.host, addresses: host.addresses, results, scanned: DISCOVER_PORTS.length, ms: Date.now() - now } satisfies StationDiscoverResponse);
    } finally {
      discovering = false;
    }
  }

  return json(res, { error: 'not found' }, 404);
}
