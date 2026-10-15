import { createCipheriv, createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject, type webcrypto } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { PushDevice, PushPayload, PushPrefs, PushStatusResponse, ServerEvent } from '../shared/protocol.ts';
import { DATA_DIR } from './config.ts';

// ALERTS: Web Push to the phone (and any browser that subscribes) when a tab's turn ends (DONE) or Claude waits
// for you (NEEDS YOU), even with the app closed. node:crypto only, no web-push package:
//   RFC 8030 Web Push protocol (TTL, Urgency, Topic headers; 201 = accepted, 404/410 = subscription gone)
//   RFC 8291 message encryption (aes128gcm, RFC 8188), so the push service cannot read the message
//   RFC 8292 VAPID: an ES256 JWT that proves the message comes from this server's key
//
// Files: data/push-keys.json (VAPID key pair, made on first use; the private key never leaves this file),
//        data/push-subs.json (devices: endpoint, keys, label, prefs).
// Routes (login-only, index.ts): GET /api/push, POST /api/push/{subscribe,unsubscribe,prefs,test}.
// Trigger: index.ts passes every broadcast event to watchForPush(); a meta patch where busy goes true -> false is
// DONE, attention false -> true is NEEDS YOU. Not sent when a page is looking at that tab (notePresence).
//
// Safety: the server only POSTs to https endpoints on the big push services (PUSH_HOSTS), never to an address
// the page picks. Tests only: PHOSPHOR_PUSH_TEST_ORIGIN=http://127.0.0.1:<port> also allows that one loopback origin
// (a mock push service) and turns on POST /api/push/simulate. Never set it in .env or in production.

const KEYS_FILE = join(DATA_DIR, 'push-keys.json');
const SUBS_FILE = join(DATA_DIR, 'push-subs.json');

const PUSH_HOSTS = [
  /^([a-z0-9-]+\.)+push\.services\.mozilla\.com$/, // Firefox (autopush)
  /^fcm\.googleapis\.com$/, // Chrome, Android browsers
  /^([a-z0-9-]+\.)+notify\.windows\.com$/, // Edge (WNS)
  /^web\.push\.apple\.com$/, // Safari
];
const TEST_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(process.env.PHOSPHOR_PUSH_TEST_ORIGIN ?? '') ? process.env.PHOSPHOR_PUSH_TEST_ORIGIN! : '';
// RFC 8292 §2.1: a contact for the push service operator. Apple wants a mailto: or https: URL.
const CONTACT = process.env.PHOSPHOR_PUSH_CONTACT || 'mailto:phosphor-os@example.com';

const MAX_DEVICES = 20;
const SEND_TIMEOUT_MS = 10_000;
const LOOK_FRESH_MS = 30_000; // a page's "I'm looking" counts this long (the page repeats it every 20 s)
const DONE_DELAY_MS = 1500; // a queued message or background agent can start the next turn right away
const DONE_GAP_MS = 20_000; // at most one DONE per tab in this time
const NEEDS_GAP_MS = 5_000;
const TTL_S = 6 * 3600; // RFC 8030 §5.2: a phone offline longer than this does not get stale alerts
const RS = 4096; // RFC 8188 record size; one record holds the whole message (RFC 8291 §4)
const MAX_PLAINTEXT = 3993; // RFC 8291 §4: 4096 minus header (86), delimiter (1), tag (16)

type Sub = {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
  prefs: PushPrefs;
  createdAt: number;
  lastOkAt: number | null;
  lastError: string | null;
};

type Jwk = webcrypto.JsonWebKey;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');

// ---------------------------------------------------------------- RFC 8291 encryption

// Encrypts one push message for a subscription (its p256dh key and auth secret, both from the browser).
// `fixed` is for the RFC's test vector only: a known sender key and salt instead of fresh random ones.
export function encrypt(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, fixed?: { asPrivate: Buffer; salt: Buffer }): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('push message too long');
  // §3.1: a new ECDH key pair on P-256 for every message (as_private, as_public).
  const as = createECDH('prime256v1');
  if (fixed) as.setPrivateKey(fixed.asPrivate);
  else as.generateKeys();
  const asPublic = as.getPublicKey(); // uncompressed point, 65 octets starting 0x04
  const ecdhSecret = as.computeSecret(uaPublic); // throws on a key that is not on the curve
  // §3.3 + §3.4: IKM = HKDF(salt = auth_secret, IKM = ecdh_secret, info = key_info, L = 32).
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  // §3.4 (RFC 8188 §2.2, §2.3): CEK and NONCE from a random 16-octet salt.
  const salt = fixed?.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12));
  // §4: a single record: plaintext, then the last-record padding delimiter 0x02 (RFC 8188 §2), no padding.
  // One record means sequence number 0, so the nonce is used as is (no XOR).
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  // RFC 8188 §2.1 header: salt (16) | rs (uint32) | idlen (1) | keyid; RFC 8291 §4: keyid = as_public.
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RS, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}

// ---------------------------------------------------------------- RFC 8292 VAPID

let vapid: { priv: KeyObject; pub: Buffer } | undefined;

// The server's VAPID key pair (P-256). Made once and kept in data/push-keys.json.
export function vapidKeys(): { priv: KeyObject; pub: Buffer } {
  if (vapid) return vapid;
  let jwk: Jwk | undefined;
  try {
    jwk = (JSON.parse(readFileSync(KEYS_FILE, 'utf8')) as { privateKey?: Jwk }).privateKey;
  } catch {
    /* first use */
  }
  if (!jwk?.d) {
    jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
    // publicKey is there for people reading the file; the server always derives it from the private key.
    writeFileSync(KEYS_FILE, JSON.stringify({ publicKey: b64url(rawPublic(jwk)), privateKey: jwk }, null, 2), { mode: 0o600 });
  }
  const priv = createPrivateKey({ key: jwk, format: 'jwk' });
  vapid = { priv, pub: rawPublic(createPublicKey(priv).export({ format: 'jwk' })) };
  return vapid;
}

// Uncompressed point (0x04 | x | y), the form browsers take as applicationServerKey and RFC 8292 §3.2 sends as k.
function rawPublic(jwk: Jwk): Buffer {
  return Buffer.concat([Buffer.from([4]), fromB64url(jwk.x!), fromB64url(jwk.y!)]);
}

// RFC 8292 §2: JWT signed with ES256 (RFC 7518 §3.4: signature = r | s, 64 octets). aud = the push service's
// origin, exp at most 24 h ahead (we use 12 h), sub = contact.
export function vapidJwt(audience: string, priv: KeyObject, now = Date.now()): string {
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: CONTACT }));
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key: priv, dsaEncoding: 'ieee-p1363' });
  return `${head}.${claims}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- subscriptions

export function endpointOk(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (TEST_ORIGIN && u.origin === TEST_ORIGIN) return true;
  return u.protocol === 'https:' && u.port === '' && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

// The browser's keys: p256dh must be a point on P-256, auth 16 random octets (RFC 8291 §2, §3.2).
function keysOk(keys: unknown): keys is Sub['keys'] {
  const k = keys as Partial<Sub['keys']> | null;
  if (typeof k?.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 100 || k.auth.length > 40) return false;
  const pub = fromB64url(k.p256dh);
  if (pub.length !== 65 || pub[0] !== 4 || fromB64url(k.auth).length !== 16) return false;
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub); // throws when the point is not on the curve
    return true;
  } catch {
    return false;
  }
}

function service(endpoint: string): string {
  const host = new URL(endpoint).hostname;
  if (host.endsWith('mozilla.com')) return 'Mozilla';
  if (host.endsWith('googleapis.com')) return 'Google';
  if (host.endsWith('windows.com')) return 'Microsoft';
  if (host.endsWith('apple.com')) return 'Apple';
  return 'Test';
}

function labelFromUa(ua = ''): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

let subs: Sub[] | undefined;

function loadSubs(): Sub[] {
  if (subs) return subs;
  try {
    const saved = JSON.parse(readFileSync(SUBS_FILE, 'utf8')) as Sub[];
    subs = Array.isArray(saved) ? saved.filter((s) => endpointOk(s?.endpoint) && keysOk(s.keys)) : [];
  } catch {
    subs = [];
  }
  return subs;
}

function saveSubs(): void {
  const tmp = `${SUBS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(loadSubs(), null, 2), { mode: 0o600 });
  renameSync(tmp, SUBS_FILE);
}

const toDevice = (s: Sub): PushDevice => ({ id: s.id, label: s.label, service: service(s.endpoint), prefs: s.prefs, createdAt: s.createdAt, lastOkAt: s.lastOkAt, lastError: s.lastError });

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanQuiet(q: unknown): PushPrefs['quiet'] | undefined {
  if (q === null) return null;
  const v = q as { from?: unknown; to?: unknown } | undefined;
  return typeof v?.from === 'string' && typeof v.to === 'string' && HHMM.test(v.from) && HHMM.test(v.to) ? { from: v.from, to: v.to } : undefined;
}

export function inQuiet(q: PushPrefs['quiet'], d = new Date()): boolean {
  if (!q) return false;
  const min = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const now = d.getHours() * 60 + d.getMinutes();
  const from = min(q.from);
  const to = min(q.to);
  if (from === to) return false;
  return from < to ? now >= from && now < to : now >= from || now < to; // e.g. 22:00 to 07:00 wraps midnight
}

// ---------------------------------------------------------------- sending

// RFC 8030 §5.4: Topic is at most 32 chars of the base64url alphabet. A newer alert for the same tab replaces one
// the push service still holds (phone offline), so the phone gets the latest state, not a pile.
const topicFor = (tab: string) => b64url(createHash('sha256').update(tab).digest()).slice(0, 22);

// One push to one device. Returns the push service's HTTP status (0 = no answer). Never throws.
async function deliver(sub: Sub, payload: PushPayload): Promise<{ status: number; error?: string }> {
  if (!endpointOk(sub.endpoint)) return { status: 0, error: 'Endpoint not allowed.' };
  let status = 0;
  let error: string | undefined;
  try {
    const k = vapidKeys();
    const body = encrypt(Buffer.from(JSON.stringify(payload)), fromB64url(sub.keys.p256dh), fromB64url(sub.keys.auth));
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(TTL_S), // RFC 8030 §5.2
        Urgency: 'high', // §5.3: wake the phone now
        Topic: topicFor(payload.tab || 'test'), // §5.4
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm', // RFC 8291 §4: exactly this one coding
        Authorization: `vapid t=${vapidJwt(new URL(sub.endpoint).origin, k.priv)}, k=${b64url(k.pub)}`, // RFC 8292 §3
      },
      body: new Uint8Array(body),
      redirect: 'error', // never follow a push service anywhere else
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text().catch(() => '');
    if (status < 200 || status > 299) error = `Push service said ${status}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
  } catch (e) {
    error = e instanceof Error && e.name === 'TimeoutError' ? 'The push service did not answer.' : `Could not reach the push service (${e instanceof Error ? e.message : e}).`;
  }
  const list = loadSubs();
  if (status === 404 || status === 410) {
    // RFC 8030 §7.3: the subscription is gone (app uninstalled, alerts turned off in the browser). Forget it.
    const i = list.indexOf(sub);
    if (i >= 0) list.splice(i, 1);
  } else if (error) {
    sub.lastError = error;
  } else {
    sub.lastOkAt = Date.now();
    sub.lastError = null;
  }
  try {
    saveSubs();
  } catch {
    /* disk full or locked: the next save writes it */
  }
  if (error) console.warn(`[push] ${sub.label}: ${error}`);
  return { status, error };
}

// ---------------------------------------------------------------- when to alert

type Presence = { tab: string | null; looking: boolean; at: number };
const presence = new Map<WebSocket, Presence>();

// A page tells us which tab it shows and whether you are looking at it (index.ts, ClientEvent 'presence').
export function notePresence(ws: WebSocket, ev: { tab: unknown; looking: unknown }): void {
  if (!presence.has(ws)) ws.once('close', () => presence.delete(ws));
  presence.set(ws, { tab: typeof ev.tab === 'string' ? ev.tab.slice(0, 64) : null, looking: ev.looking === true, at: Date.now() });
}

// Someone has that tab in front of them right now: no buzz. A phone that went to sleep without saying so stops
// counting after LOOK_FRESH_MS, because its page stops repeating it.
function someoneLooking(tab: string): boolean {
  const now = Date.now();
  for (const [ws, p] of presence) if (p.looking && p.tab === tab && now - p.at < LOOK_FRESH_MS && ws.readyState === WebSocket.OPEN) return true;
  return false;
}

const lastSent = new Map<string, number>();

function notify(tab: string, kind: 'done' | 'needs', title: string): void {
  if (someoneLooking(tab)) return;
  const key = `${kind}:${tab}`;
  if (Date.now() - (lastSent.get(key) ?? 0) < (kind === 'done' ? DONE_GAP_MS : NEEDS_GAP_MS)) return;
  const to = loadSubs().filter((s) => (kind === 'done' ? s.prefs.done : s.prefs.needs) && !inQuiet(s.prefs.quiet));
  if (!to.length) return;
  lastSent.set(key, Date.now());
  const t = title.replace(/\s+/g, ' ').trim();
  const payload: PushPayload = { k: kind, tab, title: kind === 'done' ? 'CLAUDE: DONE' : 'CLAUDE NEEDS YOU', body: t.length > 40 ? `${t.slice(0, 39)}…` : t, at: Date.now() };
  void Promise.allSettled(to.map((s) => deliver(s, payload)));
}

const seen = new Map<string, { busy: boolean; attention: boolean; title: string }>();
const doneTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Called with every event the server broadcasts (index.ts). Cheap for everything but tab meta changes.
export function watchForPush(ev: ServerEvent): void {
  try {
    if (ev.t === 'tab_closed') {
      seen.delete(ev.tab);
      clearTimeout(doneTimers.get(ev.tab));
      doneTimers.delete(ev.tab);
      return;
    }
    if (ev.t !== 'patch' || ev.key !== 'meta') return;
    const m = ev.value;
    const prev = seen.get(m.id);
    seen.set(m.id, { busy: m.busy, attention: m.attention, title: m.title });
    if (m.attention && !prev?.attention) notify(m.id, 'needs', m.title);
    if (prev?.busy && !m.busy) {
      clearTimeout(doneTimers.get(m.id));
      doneTimers.set(
        m.id,
        setTimeout(() => {
          doneTimers.delete(m.id);
          const now = seen.get(m.id);
          if (now && !now.busy) notify(m.id, 'done', now.title);
        }, DONE_DELAY_MS),
      );
    }
  } catch (e) {
    console.warn('[push]', e); // alerts must never break the chat
  }
}

// ---------------------------------------------------------------- routes

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (c) => {
      text += c;
      if (text.length > 8192) req.destroy();
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const lastTest = new Map<string, number>();

export async function handlePush(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;
  if (path === '/api/push' && req.method === 'GET') {
    return json(res, { publicKey: b64url(vapidKeys().pub), devices: loadSubs().map(toDevice) } satisfies PushStatusResponse);
  }
  if (req.method !== 'POST') return json(res, { error: 'not found' }, 404);
  const b = await readJson(req);
  const list = loadSubs();
  const byId = (id: unknown) => list.find((s) => s.id === id);

  if (path === '/api/push/subscribe') {
    const sub = (b.subscription ?? {}) as { endpoint?: unknown; keys?: unknown };
    if (!endpointOk(sub.endpoint)) return json(res, { error: 'That push address is not allowed.' }, 400);
    if (!keysOk(sub.keys)) return json(res, { error: 'Bad subscription keys.' }, 400);
    const keys = { p256dh: sub.keys.p256dh, auth: sub.keys.auth };
    // A page renewing its own address after REMOVE on another device: stay removed.
    if (b.renew === true && !byId(b.id)) return json(res, { error: 'That device was removed.' }, 404);
    // Same device again (new keys, or the browser renewed its subscription): keep its id, name and prefs.
    let s = byId(b.id) ?? list.find((x) => x.endpoint === sub.endpoint);
    if (!s && typeof b.oldEndpoint === 'string') {
      s = list.find((x) => x.endpoint === b.oldEndpoint);
      if (!s) return json(res, { error: 'That device was removed.' }, 404); // renewal of a removed device: stay removed
    }
    if (!s) {
      if (list.length >= MAX_DEVICES) return json(res, { error: `At most ${MAX_DEVICES} devices. Remove one first.` }, 400);
      s = { id: randomBytes(9).toString('base64url'), endpoint: sub.endpoint, keys, label: labelFromUa(req.headers['user-agent']), prefs: { done: true, needs: true, quiet: null }, createdAt: Date.now(), lastOkAt: null, lastError: null };
      list.push(s);
    }
    s.endpoint = sub.endpoint;
    s.keys = keys;
    applyPrefs(s, (b.prefs ?? {}) as Record<string, unknown>);
    saveSubs();
    return json(res, { id: s.id });
  }

  if (path === '/api/push/unsubscribe') {
    const s = byId(b.id);
    if (s) {
      list.splice(list.indexOf(s), 1);
      saveSubs();
    }
    return json(res, { ok: true });
  }

  if (path === '/api/push/prefs') {
    const s = byId(b.id);
    if (!s) return json(res, { error: 'No such device.' }, 404);
    applyPrefs(s, b);
    if (typeof b.label === 'string' && b.label.trim()) s.label = b.label.replace(/\s+/g, ' ').trim().slice(0, 40);
    saveSubs();
    return json(res, { device: toDevice(s) });
  }

  if (path === '/api/push/test') {
    const s = byId(b.id);
    if (!s) return json(res, { error: 'No such device.' }, 404);
    if (Date.now() - (lastTest.get(s.id) ?? 0) < 3000) return json(res, { error: 'Wait a few seconds.' }, 429);
    lastTest.set(s.id, Date.now());
    const r = await deliver(s, { k: 'test', tab: '', title: 'CLAUDE: TEST', body: 'Alerts work on this device.', at: Date.now() });
    return json(res, { ok: !r.error, status: r.status, ...(r.error ? { error: r.error } : {}) });
  }

  // Tests only (PHOSPHOR_PUSH_TEST_ORIGIN set): play a tab's busy -> idle or attention change through watchForPush.
  if (path === '/api/push/simulate' && TEST_ORIGIN) {
    const tab = String(b.tab ?? '').slice(0, 64);
    const meta = { id: tab, title: String(b.title ?? 'Test tab'), busy: false, attention: false, createdAt: 0 };
    if (b.kind === 'done') {
      watchForPush({ t: 'patch', tab, key: 'meta', value: { ...meta, busy: true } });
      watchForPush({ t: 'patch', tab, key: 'meta', value: meta });
    } else {
      watchForPush({ t: 'patch', tab, key: 'meta', value: { ...meta, busy: true } });
      watchForPush({ t: 'patch', tab, key: 'meta', value: { ...meta, busy: true, attention: true } });
      watchForPush({ t: 'patch', tab, key: 'meta', value: { ...meta, busy: true } }); // answered
    }
    return json(res, { ok: true });
  }

  return json(res, { error: 'not found' }, 404);
}

function applyPrefs(s: Sub, p: Record<string, unknown>): void {
  if (typeof p.done === 'boolean') s.prefs.done = p.done;
  if (typeof p.needs === 'boolean') s.prefs.needs = p.needs;
  const q = cleanQuiet(p.quiet);
  if (q !== undefined) s.prefs.quiet = q;
}
