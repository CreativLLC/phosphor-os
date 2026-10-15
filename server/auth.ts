import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { DATA_DIR, ROOT, config } from './config.ts';

const COOKIE = 'rcs';
// 400 days is the longest a browser keeps a cookie. Every page load renews it, so a device that
// uses the app stays logged in. (The owner's phone is already locked by fingerprint.)
const MAX_AGE_S = 400 * 24 * 3600;

const secretFile = join(DATA_DIR, 'secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'));
const secret = readFileSync(secretFile, 'utf8').trim();
// Changing the password changes the key, so it logs out every other device.
let key = secret + config.password;

const sha = (s: string) => createHash('sha256').update(s).digest();
const sign = (s: string) => createHmac('sha256', key).update(s).digest('base64url');

export function checkPassword(given: string): boolean {
  return timingSafeEqual(sha(given), sha(config.password!));
}

export function makeCookie(): string {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE_S);
  // Lax, not Strict: a home-screen app opening is a "from another app" visit, and Strict cookies are not
  // sent on those, so the phone asked for the password every time. Lax still blocks other sites' POSTs;
  // the WebSocket also checks Origin.
  return `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}`;
}

export function isAuthed(req: IncomingMessage): boolean {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return false;
  const [exp, mac] = m[1].split('.');
  if (!exp || !mac || Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(mac);
  return got.length === want.length && timingSafeEqual(got, want);
}

// New password: saved to .env, takes effect at once. Returns an error message, or '' when done.
export function setPassword(next: string): string {
  if (next.length < 4 || next.length > 200) return 'Use 4 to 200 characters.';
  if (/["\\\r\n]/.test(next)) return 'Quotes, backslashes and line breaks are not allowed.';
  const envFile = join(ROOT, '.env');
  const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split(/\r?\n/) : [];
  const line = `PHOSPHOR_PASSWORD="${next}"`;
  // RETRO_PASSWORD: the name before the rename. Its line goes too, so no old password stays in the file.
  const old = (l: string) => /^\s*(PHOSPHOR|RETRO)_PASSWORD\s*=/.test(l);
  let i = lines.findIndex(old);
  if (i >= 0) lines[i] = line;
  else {
    lines.unshift(line);
    i = 0;
  }
  for (let j = lines.length - 1; j > i; j--) if (old(lines[j])) lines.splice(j, 1);
  writeFileSync(envFile, lines.join('\n').replace(/\n*$/, '\n'));
  config.password = next;
  key = secret + next;
  return '';
}

// Slow down password guessing: one failure locks login for a growing time.
let failures = 0;
let lockedUntil = 0;
export function loginLocked(): boolean {
  return Date.now() < lockedUntil;
}
export function noteLogin(ok: boolean): void {
  if (ok) {
    failures = 0;
    return;
  }
  failures++;
  lockedUntil = Date.now() + Math.min(2 ** failures, 300) * 1000;
}
