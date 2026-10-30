import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMENTS_QUOTA_DAY, quotaDay, type QuotaUse } from '../shared/comments.ts';

// COMMENTS (docs/COMMENTS.md): Google sign-in and the YouTube Data API v3 for one channel owner.
// - Sign-in: OAuth 2.0 for desktop apps, loopback redirect (http://127.0.0.1:<port>/api/comments/auth/callback),
//   PKCE S256, scope youtube.force-ssl (the narrowest that allows comments.insert; it also reads). The client id and
//   secret come from .env (a desktop client's secret is not really secret, Google says so; it still stays off the page).
// - The refresh token is kept in <dir>/token.json, mode 0600. It never goes to the page, a log or a chat. The access
//   token lives in memory only.
// - Every API call is written to <dir>/quota.jsonl ({at, m, u}) BEFORE it is sent (YouTube counts failed calls too), so
//   the server and the CLI both add to the same log. Today = the Pacific day (YouTube's quota day).

export const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/youtube/v3/';
const PENDING_MS = 15 * 60_000; // a started sign-in must finish within this
const TIMEOUT_MS = 20_000;

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly reason = '',
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
type Token = { refresh_token: string; scope: string; savedAt: number };

const b64url = (b: Buffer) => b.toString('base64url');

export class YouTube {
  readonly dir: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirect: string;
  private readonly f: Fetch;
  private readonly now: () => number;
  private access: { token: string; exp: number } | null = null;
  private pending = new Map<string, { verifier: string; at: number }>();
  needsSignIn = ''; // set when Google refused the saved sign-in

  constructor(o: { dir: string; clientId?: string; clientSecret?: string; redirect: string; fetch?: Fetch; now?: () => number }) {
    this.dir = o.dir;
    this.clientId = (o.clientId ?? '').trim();
    this.clientSecret = (o.clientSecret ?? '').trim();
    this.redirect = o.redirect;
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  private get tokenFile() {
    return join(this.dir, 'token.json');
  }
  private get quotaFile() {
    return join(this.dir, 'quota.jsonl');
  }

  configured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  signedIn(): boolean {
    return this.configured() && existsSync(this.tokenFile);
  }

  private readToken(): Token | null {
    try {
      const t = JSON.parse(readFileSync(this.tokenFile, 'utf8')) as Token;
      return typeof t.refresh_token === 'string' && t.refresh_token ? t : null;
    } catch {
      return null;
    }
  }

  private saveToken(t: Token): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.tokenFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    chmodSync(tmp, 0o600); // mode is ignored when the file already existed
    renameSync(tmp, this.tokenFile);
  }

  // ---- sign-in ----

  // The Google address to open. The state and the PKCE verifier stay here until the answer comes back.
  startAuth(): string {
    if (!this.configured()) throw new YouTubeError('Add the Google client id and secret to .env first (docs/COMMENTS.md).');
    const t = this.now();
    for (const [k, v] of this.pending) if (t - v.at > PENDING_MS) this.pending.delete(k);
    while (this.pending.size >= 5) this.pending.delete(this.pending.keys().next().value!);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    this.pending.set(state, { verifier, at: t });
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirect,
      response_type: 'code',
      scope: YT_SCOPE,
      access_type: 'offline',
      prompt: 'consent', // always hand out a refresh token, also on a second sign-in
      include_granted_scopes: 'true',
      state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${q}`;
  }

  hasPending(state: string): boolean {
    const p = this.pending.get(state);
    return !!p && this.now() - p.at <= PENDING_MS;
  }

  // Google's answer (from the callback, or an address the owner pasted): swap the code for a refresh token.
  async finishAuth(params: URLSearchParams): Promise<void> {
    const state = params.get('state') ?? '';
    const p = this.pending.get(state);
    if (!p || this.now() - p.at > PENDING_MS) throw new YouTubeError('This sign-in is old or was not started here. Press SIGN IN again.', 400);
    this.pending.delete(state);
    const err = params.get('error');
    if (err) throw new YouTubeError(err === 'access_denied' ? 'The sign-in was cancelled.' : `Google said: ${err}`, 400);
    const code = params.get('code');
    if (!code) throw new YouTubeError('No code in that address.', 400);
    const granted = (params.get('scope') ?? YT_SCOPE).split(/\s+/);
    if (!granted.includes(YT_SCOPE)) throw new YouTubeError('YouTube access was not ticked on the Google screen. Sign in again and allow it.', 400);
    const r = await this.tokenCall({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: this.redirect });
    if (typeof r.refresh_token !== 'string') throw new YouTubeError('Google sent no refresh token. Sign in again.', 502);
    this.saveToken({ refresh_token: r.refresh_token, scope: String(r.scope ?? YT_SCOPE), savedAt: this.now() });
    this.access = typeof r.access_token === 'string' ? { token: r.access_token, exp: this.now() + (Number(r.expires_in) || 3600) * 1000 } : null;
    this.needsSignIn = '';
  }

  async signOut(): Promise<void> {
    const t = this.readToken();
    this.access = null;
    rmSync(this.tokenFile, { force: true });
    if (t) {
      await this.f(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.refresh_token }), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => {});
    }
  }

  private async tokenCall(body: Record<string, string>): Promise<Record<string, unknown>> {
    let r: Response;
    try {
      r = await this.f(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new YouTubeError('Could not reach Google.');
    }
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const code = String(j.error ?? '');
      // invalid_grant: revoked, expired (7 days in Testing mode) or unused for 6 months. Only a new sign-in helps.
      if (code === 'invalid_grant' && body.grant_type === 'refresh_token') {
        rmSync(this.tokenFile, { force: true });
        this.needsSignIn = 'Google ended the saved sign-in (revoked, or the app is still in Testing mode, where it lasts 7 days). Sign in again.';
        throw new YouTubeError(this.needsSignIn, 401, code);
      }
      throw new YouTubeError(`Google sign-in failed: ${code || r.status}${j.error_description ? ` (${String(j.error_description).slice(0, 120)})` : ''}`, r.status, code);
    }
    return j;
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.exp - 60_000 > this.now()) return this.access.token;
    const t = this.readToken();
    if (!this.configured() || !t) throw new YouTubeError(this.needsSignIn || 'Not signed in to YouTube.', 401);
    const r = await this.tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    if (typeof r.access_token !== 'string') throw new YouTubeError('Google sent no access token.', 502);
    this.access = { token: r.access_token, exp: this.now() + (Number(r.expires_in) || 3600) * 1000 };
    return this.access.token;
  }

  // ---- quota ----

  private noteQuota(m: string, u: number): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.quotaFile, `${JSON.stringify({ at: this.now(), m, u })}\n`);
    } catch {
      /* the count is a guide; a full disk must not stop a reply */
    }
  }

  quota(): QuotaUse {
    const day = quotaDay(this.now());
    const use: QuotaUse = { day, units: 0, calls: {}, limit: COMMENTS_QUOTA_DAY };
    let text = '';
    try {
      text = readFileSync(this.quotaFile, 'utf8');
    } catch {
      return use;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const x = JSON.parse(line) as { at: number; m: string; u: number };
        if (quotaDay(x.at) !== day) continue;
        use.units += x.u;
        use.calls[x.m] = (use.calls[x.m] ?? 0) + x.u;
      } catch {
        /* a torn line */
      }
    }
    return use;
  }

  // Keep 30 days of the log.
  pruneQuota(): void {
    try {
      const keep = readFileSync(this.quotaFile, 'utf8').split('\n').filter((l) => {
        try {
          return this.now() - (JSON.parse(l) as { at: number }).at < 30 * 86400_000;
        } catch {
          return false;
        }
      });
      writeFileSync(this.quotaFile, keep.map((l) => `${l}\n`).join(''));
    } catch {
      /* no log yet */
    }
  }

  // ---- API ----

  // One YouTube Data API call. cost: its quota units (docs: determine_quota_cost). method: e.g. 'commentThreads.list'.
  async call<T>(method: string, cost: number, path: string, params: Record<string, string | number | boolean>, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    this.noteQuota(method, cost);
    let r: Response;
    try {
      r = await this.f(`${API}${path}?${q}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new YouTubeError('Could not reach YouTube.');
    }
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
    if (!r.ok) {
      const reason = j.error?.errors?.[0]?.reason ?? '';
      if (r.status === 401) this.access = null;
      const msg =
        reason === 'quotaExceeded' ? 'The YouTube API quota for today is used up. It resets at midnight Pacific time.'
        : reason === 'commentsDisabled' ? 'Comments are turned off on that video.'
        : reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ? 'The sign-in does not allow this. Sign in again and allow YouTube access.'
        : `YouTube said ${r.status}${j.error?.message ? `: ${j.error.message.replace(/<[^>]+>/g, '').slice(0, 160)}` : ''}`;
      throw new YouTubeError(msg, r.status, reason);
    }
    return j as T;
  }
}
