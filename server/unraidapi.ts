import http from 'node:http';
import https from 'node:https';
import { inspect } from 'node:util';
import type { UnraidAlert, UnraidContainer, UnraidDisk, UnraidNotices, UnraidParity, UnraidSummary, UnraidUps, UnraidVm } from '../shared/unraid.ts';

// STATION > Unraid, the talking part: the questions, one HTTP request, and turning Unraid's answers into the summary the
// page draws (shared/unraid.ts). No app config in here (server/unraid.ts owns that), so tests can import it on its own
// and hand it a fake `send`.
//
// Unraid's official GraphQL API: built in since Unraid 7.2 (Settings > Management Access > API Keys), before that through
// the Unraid Connect plugin. POST <server>/graphql with the header x-api-key. A key made with the VIEWER role can read
// everything except API keys and cannot change anything; and only `query` documents exist below, never `mutation`.
// Written against the generated schema of github.com/unraid/api (v4.15 to v4.37). Untested against a real server.

// ---------------------------------------------------------------- the questions (the one place they live)

// One short document per part, so that a part failing (a field an older Unraid lacks, a service that is off, a key that
// may not read it) loses only that part. A "Cannot query field" error names the fields to drop: they are cut out and the
// part is asked again (isSpinning, for one, only exists since API 4.25). You can paste any of these into Unraid's API
// sandbox (Settings > Management Access > Developer Options > GraphQL Sandbox).
// Not asked on purpose: vars.csrfToken, vars.regGuid, registration, apiKeys, connect, server.apikey, owner (secrets or
// personal details); logs; anything not on the page.
export const QUERIES = {
  system: `{
    info { time os { hostname release uptime } }
    vars { name version }
    display { unit hot max }
  }`,
  array: `{
    array {
      state
      capacity { kilobytes { used total } }
      parityCheckStatus { status running paused correcting progress errors date duration speed }
      parities { name device size temp numErrors status isSpinning rotational }
      disks { name device size temp numErrors status fsSize fsUsed isSpinning rotational }
      caches { name device size temp numErrors status fsSize fsUsed isSpinning rotational }
    }
  }`,
  parity: `{ parityHistory { date duration speed status errors } }`,
  disks: `{ disks { device smartStatus temperature isSpinning } }`,
  metrics: `{ metrics { cpu { percentTotal } memory { percentTotal used total } } }`,
  docker: `{ docker { containers { names state status autoStart } } }`,
  vms: `{ vms { domains { name state } } }`,
  notices: `{
    notifications {
      overview { unread { warning alert } }
      warningsAndAlerts { title subject importance timestamp }
    }
  }`,
  ups: `{ upsDevices { name model status battery { chargeLevel estimatedRuntime } power { loadPercentage } } }`,
} as const;

export type Part = keyof typeof QUERIES;
export const PARTS = Object.keys(QUERIES) as Part[];

// What a part is called when it did not answer. A UPS or VMs that are not there are not a problem: no label, no gap.
export const PART_LABEL: Record<Part, string> = {
  system: 'SYSTEM',
  array: 'ARRAY',
  parity: 'PARITY HISTORY',
  disks: 'SMART',
  metrics: 'CPU AND RAM',
  docker: 'DOCKER',
  vms: 'VMS',
  notices: 'NOTIFICATIONS',
  ups: '',
};

// ---- a tiny reader for the documents above ({ names and braces only), to cut fields out of them

export type Sel = { name: string; kids: Sel[] | null };

export function parseDoc(src: string): Sel[] {
  const toks = src.match(/[{}]|[A-Za-z_]\w*/g) ?? [];
  let i = toks[0] === '{' ? 1 : 0;
  const block = (): Sel[] => {
    const out: Sel[] = [];
    while (i < toks.length && toks[i] !== '}') {
      const name = toks[i++];
      if (toks[i] === '{') {
        i++;
        out.push({ name, kids: block() });
        i++; // the closing brace
      } else out.push({ name, kids: null });
    }
    return out;
  };
  return block();
}

// Without the fields in `drop`, at any depth; an object left with nothing in it goes too.
function prune(sels: Sel[], drop: ReadonlySet<string>): Sel[] {
  return sels.flatMap((s) => {
    if (drop.has(s.name)) return [];
    if (!s.kids) return [s];
    const kids = prune(s.kids, drop);
    return kids.length ? [{ name: s.name, kids }] : [];
  });
}

const show = (sels: Sel[]): string => (sels.length ? `{ ${sels.map((s) => (s.kids ? `${s.name} ${show(s.kids)}` : s.name)).join(' ')} }` : '');

// The document for a part without the fields this Unraid turned out not to have ('' if nothing is left).
export const queryFor = (part: Part, drop: ReadonlySet<string> = new Set()): string => show(prune(parseDoc(QUERIES[part]), drop));

// ---------------------------------------------------------------- the link: address and key

// The server's address and the API key. The key lives in a private field and is read only to build request headers;
// printing, logging or JSON-ing a Link shows nothing.
export class Link {
  readonly #key: string;
  constructor(
    readonly url: URL,
    key: string,
    readonly selfSigned = false,
  ) {
    this.#key = key;
  }
  headers(): Record<string, string> {
    return { 'x-api-key': this.#key, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'PhosphorOS-Station/1', Connection: 'close' };
  }
  // Text that came from outside, with the key cut out in case a server echoes it back.
  scrub(text: string): string {
    return this.#key.length >= 4 ? text.split(this.#key).join('***') : text;
  }
  toJSON(): string {
    return 'Unraid link';
  }
  [inspect.custom](): string {
    return '[Unraid link]';
  }
}

// What the owner typed ("192.168.1.10", "tower.local", "https://tower.local:8443", "http://tower/graphql") -> the
// address the questions go to, or null. No path = /graphql; a path that already ends in /graphql stays; another path
// (a reverse proxy folder) gets /graphql added.
export function graphqlUrl(text: string): URL | null {
  let s = String(text ?? '').trim();
  if (!s || s.length > 2048) return null;
  if (!/^[a-z][\w+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password) return null;
  u.hash = '';
  u.search = '';
  const path = u.pathname.replace(/\/+$/, '');
  u.pathname = /\/graphql$/i.test(path) ? path : `${path}/graphql`;
  return u;
}

// ---------------------------------------------------------------- one request

export type Reply = { status: number; body: string };
export type Send = (query: string) => Promise<Reply>;

// A network failure, named by its code only: Node's own messages carry the address.
export class NetError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const MAX_BODY = 4 * 1024 * 1024;
const CERT_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ERR_TLS_CERT_ALTNAME_INVALID/;

export function netNote(e: unknown): string {
  const code = e instanceof NetError ? e.code : '';
  if (CERT_CODES.test(code)) return 'Its certificate is not trusted by this PC. If it is your own server, add PHOSPHOR_UNRAID_SELF_SIGNED=1 to .env.';
  if (code === 'TIMEOUT') return 'No answer in time. Is the server on?';
  if (code === 'ECONNREFUSED') return 'Nothing answers at that address (connection refused). Is the address right?';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'That name was not found. Try the server\'s number address.';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN') return 'That server cannot be reached from this PC. Is it on?';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'The connection was cut.';
  if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') return 'It does not speak HTTPS on that port. Try http://.';
  if (code === 'TOO_BIG') return 'The answer was far too big to be Unraid\'s.';
  return `The request failed (${code || 'unknown'}).`;
}

// POST one document to the link's address. Redirects are never followed (the key would go along), a slow server is cut
// off after timeoutMs, and the answer is capped.
export function httpSend(link: Link, timeoutMs = 10_000): Send {
  return (query) =>
    new Promise<Reply>((resolve, reject) => {
      const mod = link.url.protocol === 'https:' ? https : http;
      let done = false;
      const end = (f: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        f();
      };
      const body = JSON.stringify({ query });
      const headers = { ...link.headers(), 'Content-Length': String(Buffer.byteLength(body)) };
      const req = mod.request(link.url, { method: 'POST', agent: false, headers, rejectUnauthorized: !link.selfSigned }, (res) => {
        const chunks: Buffer[] = [];
        let got = 0;
        res.on('data', (c: Buffer) => {
          got += c.length;
          if (got > MAX_BODY) {
            req.destroy();
            end(() => reject(new NetError('TOO_BIG')));
          } else chunks.push(c);
        });
        res.on('end', () => end(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })));
        res.on('error', (e: NodeJS.ErrnoException) => end(() => reject(new NetError(e.code ?? 'ERROR'))));
      });
      const timer = setTimeout(() => {
        req.destroy();
        end(() => reject(new NetError('TIMEOUT')));
      }, timeoutMs);
      req.on('error', (e: NodeJS.ErrnoException) => end(() => reject(new NetError(e.code ?? 'ERROR'))));
      req.end(body);
    });
}

// ---------------------------------------------------------------- asking one part

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object' && !Array.isArray(x)) : []);
const text = (v: unknown, max = 80): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
// Numbers come as numbers or, for Unraid's BigInt and a few sizes, as digit strings.
const num = (v: unknown): number | null => {
  const x = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
};
const when = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

export type PartOutcome =
  | { ok: true; data: Rec }
  // down, auth, wrong, limit: the link itself is the problem (stop asking). forbidden, missing, error: this part only.
  | { ok: false; why: 'down' | 'auth' | 'wrong' | 'limit' | 'forbidden' | 'missing' | 'error'; note: string };

const fail = (why: Exclude<PartOutcome, { ok: true }>['why'], note: string): PartOutcome => ({ ok: false, why, note });

const AUTH_NOTE = 'Unraid refused the API key. Make a new one (VIEWER role) and put it in .env.';

type GqlError = { message: string; code: string };
const errorsOf = (json: Rec): GqlError[] =>
  recs(json.errors).map((e) => ({ message: text(e.message, 300), code: text(rec(e.extensions).code, 60) }));
const isAuth = (e: GqlError) => e.code === 'UNAUTHENTICATED' || /unauthori[sz]ed|unauthenticated|invalid api key|api key.*(missing|required|invalid)|no api key/i.test(e.message);
const isForbidden = (e: GqlError) => e.code === 'FORBIDDEN' || /forbidden|permission|not allowed|access denied/i.test(e.message);

// Ask one part. `drop` holds the fields this Unraid does not have (kept between polls by the caller; grows here).
export async function askPart(part: Part, send: Send, drop: Set<string>, scrub: (s: string) => string = (s) => s): Promise<PartOutcome> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const query = queryFor(part, drop);
    if (!query) return fail('missing', 'This Unraid does not offer it.');
    let reply: Reply;
    try {
      reply = await send(query);
    } catch (e) {
      return fail('down', netNote(e));
    }
    const { status } = reply;
    if (status === 401 || status === 403) return fail('auth', AUTH_NOTE);
    if (status === 429) return fail('limit', 'Unraid asked us to slow down. Trying again later.');
    if (status >= 300 && status < 400) return fail('wrong', 'That address sends you somewhere else. Use the address where Unraid itself answers, like https://tower.local.');
    if (status === 404) return fail('wrong', 'Nothing at /graphql there. Unraid 7.2 or newer has the API built in; older 7.x needs the Unraid Connect plugin.');
    let json: Rec;
    try {
      json = rec(JSON.parse(reply.body));
    } catch {
      return status >= 500 ? fail('error', `Unraid answered ${status}.`) : fail('wrong', 'That address does not answer like Unraid\'s API (not JSON). Is it the server\'s own address?');
    }
    const errors = errorsOf(json);
    // A field this Unraid does not have: cut it out and ask again.
    const unknown = errors.flatMap((e) => /Cannot query field "(\w+)" on type "\w+"/.exec(e.message)?.[1] ?? []).filter((f) => !drop.has(f));
    if (unknown.length) {
      for (const f of unknown) drop.add(f);
      continue;
    }
    // Some data with a few field errors (a temperature that is not a number) is still an answer.
    const data = rec(json.data);
    if (Object.values(data).some((v) => v !== null && v !== undefined)) return { ok: true, data };
    if (errors.some(isAuth)) return fail('auth', AUTH_NOTE);
    if (errors.some(isForbidden)) return fail('forbidden', 'This key may not read it.');
    return fail('error', errors[0] ? scrub(errors[0].message).slice(0, 100) : `Unraid sent nothing (${status}).`);
  }
  return fail('error', 'Unraid kept refusing the question.');
}

// ---------------------------------------------------------------- Unraid's answers -> the summary

const HOT_C = 45; // Unraid's own defaults for hard disks (Settings > Display Settings), used when its display settings did not come
const MAX_C = 55;
const SSD_EXTRA_C = 15; // Unraid's API does not give the SSD limits (60 and 70 by default): the hard disk ones plus this
const DAY_MS = 86_400_000;

const BAD_STATUS: Record<string, string> = {
  DISK_DSBL: 'DISABLED',
  DISK_NP_DSBL: 'DISABLED',
  DISK_DSBL_NEW: 'DISABLED',
  DISK_INVALID: 'INVALID',
  DISK_WRONG: 'WRONG DISK',
  DISK_NP_MISSING: 'MISSING',
};

type Smart = { smart: 'ok' | 'unknown'; tempC: number | null; spin: 'up' | 'down' | null };
const dev = (v: unknown): string => text(v, 40).replace(/^\/dev\//, '');
const spinOf = (v: unknown): 'up' | 'down' | null => (typeof v === 'boolean' ? (v ? 'up' : 'down') : null);

function diskOf(d: Rec, role: UnraidDisk['role'], smart: Map<string, Smart>): UnraidDisk | null {
  const name = text(d.name, 24);
  const raw = typeof d.status === 'string' ? d.status : 'DISK_OK';
  if (!name || raw === 'DISK_NP') return null; // an empty slot
  const device = dev(d.device);
  const sm = smart.get(device);
  const t = num(d.temp);
  const fs = role === 'parity' ? null : num(d.fsSize);
  const bad = BAD_STATUS[raw];
  return {
    name,
    device,
    role,
    ssd: d.rotational === false || device.startsWith('nvme'),
    tempC: t !== null && t > 0 ? t : (sm?.tempC ?? null),
    sizeKb: num(d.size),
    usedKb: fs !== null && fs > 0 ? num(d.fsUsed) : null,
    fsKb: fs !== null && fs > 0 ? fs : null,
    errors: Math.max(0, num(d.numErrors) ?? 0),
    smart: sm?.smart ?? 'unknown',
    spin: spinOf(d.isSpinning) ?? sm?.spin ?? null,
    status: bad ? 'bad' : raw === 'DISK_NEW' ? 'new' : 'ok',
    statusText: bad ?? '',
  };
}

function parityOf(status: Rec, history: Rec[]): UnraidParity {
  const paused = status.paused === true;
  const running = status.running === true || paused || status.status === 'RUNNING' || status.status === 'PAUSED';
  const pct = num(status.progress);
  const lastOf = (e: Rec): UnraidParity['last'] => {
    const errors = num(e.errors);
    const s = text(e.status, 20);
    const result = s === 'COMPLETED' ? ((errors ?? 0) > 0 ? 'errors' : 'ok') : s === 'CANCELLED' ? 'cancelled' : s === 'FAILED' ? 'failed' : null;
    return result ? { at: when(e.date), result, errors, durationSec: num(e.duration), speed: text(e.speed, 20) } : null;
  };
  // The newest finished check. Its list is not promised to be in any order.
  const done = [...history, ...(running ? [] : [status])].map(lastOf).filter((x): x is NonNullable<UnraidParity['last']> => !!x);
  done.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return {
    running,
    paused,
    correcting: status.correcting === true,
    progress: pct === null ? null : Math.min(100, Math.max(0, pct)),
    speed: text(status.speed, 20),
    errors: num(status.errors),
    last: done[0] ?? null,
  };
}

const CONTAINER_STATE: Record<string, UnraidContainer['state']> = { RUNNING: 'running', PAUSED: 'paused' };
const VM_STATE: Record<string, UnraidVm['state']> = { RUNNING: 'running', IDLE: 'running', PAUSED: 'paused', PMSUSPENDED: 'paused', CRASHED: 'crashed' };

// The summary from whatever parts answered (a part that did not is absent). Never throws on odd answers: a field that
// is missing or the wrong kind is simply not there.
export function parseUnraid(parts: Partial<Record<Part, Rec>>, now = Date.now()): UnraidSummary {
  const sys = parts.system ?? {};
  const info = rec(sys.info);
  const os = rec(info.os);
  const vars = rec(sys.vars);
  const display = rec(sys.display);
  const boot = when(os.uptime);
  const at = when(info.time) ?? now;
  const celsius = display.unit !== 'FAHRENHEIT';
  const hot = num(display.hot);
  const max = num(display.max);

  const smart = new Map<string, Smart>();
  for (const d of recs(parts.disks?.disks)) {
    const t = num(d.temperature);
    smart.set(dev(d.device), { smart: d.smartStatus === 'OK' ? 'ok' : 'unknown', tempC: t !== null && t > 0 ? t : null, spin: spinOf(d.isSpinning) });
  }

  const arr = parts.array ? rec(parts.array.array) : null;
  const slots = (key: string, role: UnraidDisk['role']) => recs(arr?.[key]).map((d) => diskOf(d, role, smart)).filter((d): d is UnraidDisk => !!d);
  const cap = rec(rec(arr?.capacity).kilobytes);
  const state = text(arr?.state, 40);

  const metrics = rec(parts.metrics?.metrics);
  const mem = rec(metrics.memory);
  const memPct = num(mem.percentTotal);
  const dockerRoot = parts.docker ? rec(parts.docker.docker) : null;
  const vmRoot = parts.vms ? rec(parts.vms.vms) : null;
  const notes = parts.notices ? rec(parts.notices.notifications) : null;
  const unread = rec(rec(notes?.overview).unread);

  return {
    host: text(vars.name, 40) || text(os.hostname, 40),
    version: text(vars.version, 20) || text(os.release, 20),
    uptimeSec: boot !== null && at > boot ? Math.round((at - boot) / 1000) : null,
    array: arr && state ? { state: state.replace(/_/g, ' '), started: state === 'STARTED', usedKb: num(cap.used), totalKb: num(cap.total) } : null,
    parity: arr ? parityOf(rec(arr.parityCheckStatus), recs(parts.parity?.parityHistory)) : null,
    disks: [...slots('parities', 'parity'), ...slots('disks', 'data')],
    pools: slots('caches', 'pool'),
    cpuPct: num(rec(metrics.cpu).percentTotal),
    mem: memPct === null ? null : { pct: memPct, usedBytes: num(mem.used), totalBytes: num(mem.total) },
    containers: dockerRoot
      ? recs(dockerRoot.containers)
          .map((c): UnraidContainer => ({
            name: text(Array.isArray(c.names) ? c.names[0] : c.names, 60).replace(/^\//, ''),
            state: CONTAINER_STATE[text(c.state, 20)] ?? 'stopped',
            autoStart: c.autoStart === true,
            detail: text(c.status, 60),
            stoppedAt: null,
          }))
          .filter((c) => c.name)
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      : null,
    vms: vmRoot
      ? recs(vmRoot.domains ?? vmRoot.domain)
          .map((v): UnraidVm => ({ name: text(v.name, 60), state: VM_STATE[text(v.state, 20)] ?? 'stopped' }))
          .filter((v) => v.name)
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      : null,
    notices: notes ? noticesOf(unread, recs(notes.warningsAndAlerts)) : null,
    ups: recs(parts.ups?.upsDevices).map(upsOf),
    hotC: celsius && hot !== null && hot > 0 ? hot : HOT_C,
    maxC: celsius && max !== null && max > 0 ? max : MAX_C,
  };
}

function noticesOf(unread: Rec, list: Rec[]): UnraidNotices {
  return {
    warning: Math.max(0, num(unread.warning) ?? 0),
    alert: Math.max(0, num(unread.alert) ?? 0),
    latest: list.slice(0, 5).map((n) => ({
      level: n.importance === 'ALERT' ? 'alert' : 'warning',
      text: text(n.subject, 140) || text(n.title, 140),
      at: when(n.timestamp),
    })),
  };
}

function upsOf(u: Rec): UnraidUps {
  const status = text(u.status, 30);
  return {
    name: text(u.name, 40) || text(u.model, 40) || 'UPS',
    status,
    chargePct: num(rec(u.battery).chargeLevel),
    runtimeSec: num(rec(u.battery).estimatedRuntime),
    loadPct: num(rec(u.power).loadPercentage),
    onBattery: /on\s*batt|low\s*batt/i.test(status),
  };
}

// ---------------------------------------------------------------- alerts

// What deserves a row at the top of STATION. Hard disks warn at Unraid's own temperature limits (the summary's hotC and
// maxC); SSDs 15 degrees higher. A container counts as stopped when it is set to start with the array, or when the
// server saw it running and it stopped within a day (a container you stopped by hand therefore shows for a day).
export function unraidAlerts(s: UnraidSummary, now = Date.now()): UnraidAlert[] {
  const out: UnraidAlert[] = [];
  const add = (kind: UnraidAlert['kind'], about: string, level: UnraidAlert['level'], head: string, detail = '') => out.push({ id: `${kind}:${about}`, level, kind, text: head, detail });
  const pl = (n: number) => (n === 1 ? '' : 'S');

  if (s.array && !s.array.started) add('array-stopped', '', 'alert', 'ARRAY IS NOT STARTED', `Unraid says ${s.array.state}.`);

  for (const d of [...s.disks, ...s.pools]) {
    const label = d.name.toUpperCase();
    if (d.status === 'bad') add('disk-bad', d.name, 'alert', `${label} IS ${d.statusText}`, 'Unraid does not count on this disk any more.');
    if (d.errors > 0) add('disk-errors', d.name, 'alert', `${label} HAS ${d.errors} ERROR${pl(d.errors)}`, 'Unraid counted read or write errors on it.');
    // A spun-down disk shows its last temperature, which may be old: not judged.
    if (d.tempC !== null && d.spin !== 'down') {
      const warn = d.ssd ? s.hotC + SSD_EXTRA_C : s.hotC;
      const limit = d.ssd ? s.maxC + SSD_EXTRA_C : s.maxC;
      if (d.tempC >= limit) add('disk-hot', d.name, 'alert', `${label} IS ${d.tempC} C`, `At or over ${limit} C.`);
      else if (d.tempC >= warn) add('disk-hot', d.name, 'warn', `${label} IS ${d.tempC} C`, `Over ${warn} C.`);
    }
  }

  const p = s.parity;
  if (p?.running && (p.errors ?? 0) > 0) add('parity-errors', 'now', 'alert', `PARITY CHECK HAS FOUND ${p.errors} ERROR${pl(p.errors ?? 0)}`, p.correcting ? 'It is correcting parity.' : 'It is only checking: parity is not being fixed.');
  else if (p?.last?.result === 'errors') add('parity-errors', 'last', 'alert', `LAST PARITY CHECK FOUND ${p.last.errors} ERROR${pl(p.last.errors ?? 0)}`, 'See BACKUPS for the date.');
  else if (p?.last?.result === 'failed') add('parity-errors', 'last', 'alert', 'LAST PARITY CHECK FAILED', 'See BACKUPS for the date.');

  for (const c of s.containers ?? []) {
    if (c.state !== 'stopped') continue;
    const recent = c.stoppedAt !== null && now - c.stoppedAt < DAY_MS;
    if (c.autoStart || recent) add('container-stopped', c.name, 'warn', `${c.name.toUpperCase()} HAS STOPPED`, [c.autoStart ? 'Set to start with the array.' : '', c.detail].filter(Boolean).join(' '));
  }
  for (const v of s.vms ?? []) if (v.state === 'crashed') add('vm-crashed', v.name, 'warn', `VM ${v.name.toUpperCase()} HAS CRASHED`);
  for (const u of s.ups) if (u.onBattery) add('ups-battery', u.name, 'warn', `UPS IS ON BATTERY${u.chargePct !== null ? ` (${u.chargePct}%)` : ''}`, u.status);

  const n = s.notices;
  if (n && n.alert > 0) add('unread', 'alert', 'alert', `${n.alert} UNREAD UNRAID ALERT${pl(n.alert)}`, n.latest.find((x) => x.level === 'alert')?.text ?? '');
  if (n && n.warning > 0) add('unread', 'warning', 'warn', `${n.warning} UNREAD UNRAID WARNING${pl(n.warning)}`, n.latest.find((x) => x.level === 'warning')?.text ?? '');

  return out.sort((a, b) => Number(b.level === 'alert') - Number(a.level === 'alert'));
}
