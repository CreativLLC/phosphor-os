import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { loginLocked, makeCookie, noteLogin } from './auth.ts';
import { DATA_DIR } from './config.ts';

// Fingerprint login (passkeys / WebAuthn). A passkey belongs to one address: one made on the phone at
// https://<pc>.<tailnet>.ts.net works there; the PC at http://localhost has its own.
// Routes (all under /api/passkey/):
//   POST status            -> { count } passkeys for this address (public: the login page asks)
// All are POST because browsers send the Origin header (the page's address) only then.
//   POST register/options  (logged in) -> options for the browser
//   POST register/verify   (logged in) -> saves the new passkey
//   POST login/options     (public)    -> options for the browser
//   POST login/verify      (public)    -> sets the login cookie

type Stored = { id: string; publicKey: string; counter: number; transports?: string[]; rpID: string; createdAt: number };

const FILE = join(DATA_DIR, 'passkeys.json');
const load = (): Stored[] => {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Stored[]) : [];
  } catch {
    return [];
  }
};
const save = (list: Stored[]) => writeFileSync(FILE, JSON.stringify(list, null, 2));

// One person uses this app, so one pending challenge per kind is enough.
const pending: Partial<Record<'reg' | 'auth', { challenge: string; rpID: string; origin: string; expires: number }>> = {};
const USER_ID = new TextEncoder().encode('retro-claude-owner'); // named before the rename; keeps saved passkeys valid

// The page's own address decides the passkey's scope. Only localhost or a Tailscale name.
function site(req: IncomingMessage): { rpID: string; origin: string } | undefined {
  try {
    const u = new URL(req.headers.origin ?? '');
    if (u.hostname === 'localhost' || u.hostname.endsWith('.ts.net')) return { rpID: u.hostname, origin: u.origin };
  } catch {
    /* no or bad Origin */
  }
  return undefined;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const json = (res: ServerResponse, data: unknown, status = 200, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(data));
};

export async function handlePasskeys(req: IncomingMessage, res: ServerResponse, url: URL, authed: boolean): Promise<void> {
  const action = url.pathname.slice('/api/passkey/'.length);
  const where = site(req);
  if (!where) return json(res, { error: 'Fingerprint login works on localhost or the Tailscale address only.' }, 400);
  const mine = load().filter((p) => p.rpID === where.rpID);

  if (req.method !== 'POST') return json(res, { error: 'not found' }, 404);
  if (action === 'status') return json(res, { count: mine.length });

  if (action === 'register/options' || action === 'register/verify') {
    if (!authed) return json(res, { error: 'login needed' }, 401);
    if (action === 'register/options') {
      const options = await generateRegistrationOptions({
        rpName: 'Phosphor-OS',
        rpID: where.rpID,
        userName: 'owner',
        userDisplayName: 'Phosphor-OS owner',
        userID: USER_ID,
        attestationType: 'none',
        excludeCredentials: mine.map((p) => ({ id: p.id, transports: p.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      });
      pending.reg = { challenge: options.challenge, ...where, expires: Date.now() + 120_000 };
      return json(res, options);
    }
    const p = pending.reg;
    pending.reg = undefined;
    if (!p || p.expires < Date.now() || p.rpID !== where.rpID) return json(res, { error: 'That took too long. Try again.' }, 400);
    try {
      const r = await verifyRegistrationResponse({
        response: (await readJson(req)) as Parameters<typeof verifyRegistrationResponse>[0]['response'],
        expectedChallenge: p.challenge,
        expectedOrigin: p.origin,
        expectedRPID: p.rpID,
        requireUserVerification: true,
      });
      if (!r.verified) return json(res, { error: 'The phone did not confirm it.' }, 400);
      const c = r.registrationInfo.credential;
      const all = load();
      all.push({ id: c.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter, transports: c.transports, rpID: p.rpID, createdAt: Date.now() });
      save(all);
      return json(res, { ok: true });
    } catch (e) {
      return json(res, { error: e instanceof Error ? e.message : 'Could not add it.' }, 400);
    }
  }

  if (action === 'login/options') {
    if (!mine.length) return json(res, { error: 'No fingerprint login set up for this address yet.' }, 400);
    const options = await generateAuthenticationOptions({
      rpID: where.rpID,
      allowCredentials: mine.map((p) => ({ id: p.id, transports: p.transports })),
      userVerification: 'required',
    });
    pending.auth = { challenge: options.challenge, ...where, expires: Date.now() + 120_000 };
    return json(res, options);
  }

  if (action === 'login/verify') {
    if (loginLocked()) return json(res, { error: 'Too many tries. Wait a minute.' }, 429);
    const p = pending.auth;
    pending.auth = undefined;
    if (!p || p.expires < Date.now() || p.rpID !== where.rpID) return json(res, { error: 'That took too long. Try again.' }, 400);
    try {
      const response = (await readJson(req)) as Parameters<typeof verifyAuthenticationResponse>[0]['response'];
      const all = load();
      const cred = all.find((x) => x.id === response.id && x.rpID === p.rpID);
      if (!cred) {
        noteLogin(false);
        return json(res, { error: 'Unknown fingerprint login.' }, 403);
      }
      const r = await verifyAuthenticationResponse({
        response,
        expectedChallenge: p.challenge,
        expectedOrigin: p.origin,
        expectedRPID: p.rpID,
        credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')), counter: cred.counter, transports: cred.transports },
        requireUserVerification: true,
      });
      noteLogin(r.verified);
      if (!r.verified) return json(res, { error: 'Not confirmed.' }, 403);
      cred.counter = r.authenticationInfo.newCounter;
      save(all);
      return json(res, { ok: true }, 200, { 'Set-Cookie': makeCookie() });
    } catch (e) {
      noteLogin(false);
      return json(res, { error: e instanceof Error ? e.message : 'Login failed.' }, 400);
    }
  }

  return json(res, { error: 'not found' }, 404);
}
