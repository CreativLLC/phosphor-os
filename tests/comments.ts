// COMMENTS (server/comments.ts, server/youtube.ts, shared/comments.ts): who answered what, the quota day, draft checks,
// the Google sign-in (PKCE, state), a check against a fake YouTube (paging stops at seen threads, missing replies,
// video titles, alerts), replies, and the endpoint's guards. No network: a fake fetch plays Google; temp folders only.
//   npx tsx tests/comments.ts

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answeredIds, checkDraft, noLongDashes, quotaDay, type CommentItem } from '../shared/comments.ts';
import { Comments, handleComments, handleCommentsCallback } from '../server/comments.ts';
import { YouTube, YT_SCOPE } from '../server/youtube.ts';

let pass = 0;
let fail = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${g}\n  want ${w}`);
  }
};

// ---- pure parts ----

const item = (id: string, threadId: string, at: number, own = false): CommentItem => ({
  id, threadId, videoId: 'v1', author: own ? 'Me' : `@u${id}`, authorChannelId: own ? 'CH' : `U${id}`, avatar: '', text: id, at, edited: at, likes: 0, isReply: id !== threadId, own,
});
const ans = answeredIds([item('t1', 't1', 1), item('r1', 't1', 2, true), item('r2', 't1', 3), item('t2', 't2', 5)]);
eq('answered: before the channel reply', ans.has('t1'), true);
eq('answered: a newer comment after it is open again', ans.has('r2'), false);
eq('answered: a thread with no channel reply', ans.has('t2'), false);
eq('answered: own comments never count', ans.has('r1'), false);

eq('quota day: Pacific midnight (07:59 UTC is still yesterday in summer)', quotaDay(Date.UTC(2026, 6, 2, 6, 59)), '2026-07-01');
eq('quota day: after Pacific midnight', quotaDay(Date.UTC(2026, 6, 2, 7, 1)), '2026-07-02');

eq('dashes: em dash becomes a comma', noLongDashes('Thanks — that helps'), 'Thanks, that helps');
eq('dashes: en dash range becomes a hyphen', noLongDashes('5–10 minutes'), '5-10 minutes');
eq('draft: quotes and label off, dashes out', checkDraft('Reply: "Glad it helped — more soon"', []), 'Glad it helped, more soon');
eq('draft: never words refuse it', checkDraft('My Employer says hi', ['employer']), null);
eq('draft: empty refused', checkDraft('  ', []), null);
eq('draft: too long refused', checkDraft('x'.repeat(700), []), null);

// ---- a fake Google ----

const dir = mkdtempSync(join(tmpdir(), 'comments-test-'));
const calls: string[] = [];
let threadsPages: Record<string, unknown>[] = [];
let tokenAnswer: { status: number; body: Record<string, unknown> } = { status: 200, body: { access_token: 'AT', expires_in: 3600, refresh_token: 'RT-secret', scope: YT_SCOPE } };
let lastTokenBody = new URLSearchParams();
let inserted: unknown = null;
const yc = (id: string, author: string, text: string, at: string, parentId?: string, channel = `U-${author}`) => ({
  id, snippet: { authorDisplayName: author, authorChannelId: { value: channel }, textDisplay: text, publishedAt: at, updatedAt: at, likeCount: 2, ...(parentId ? { parentId } : {}) },
});
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(input));
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.href === 'https://oauth2.googleapis.com/token') {
    lastTokenBody = new URLSearchParams(String(init?.body));
    calls.push(`token:${lastTokenBody.get('grant_type')}`);
    return reply(tokenAnswer.status, tokenAnswer.body);
  }
  if (u.href === 'https://oauth2.googleapis.com/revoke') return reply(200, {});
  const m = u.pathname.replace('/youtube/v3/', '');
  calls.push(`${m}${u.searchParams.get('pageToken') ? `#${u.searchParams.get('pageToken')}` : ''}${u.searchParams.get('parentId') ? `@${u.searchParams.get('parentId')}` : ''}`);
  if ((init?.headers as Record<string, string>)?.authorization !== 'Bearer AT') return reply(401, { error: { message: 'no' } });
  if (m === 'channels' && u.searchParams.get('mine')) return reply(200, { items: [{ id: 'CH', snippet: { title: 'My Channel' }, contentDetails: { relatedPlaylists: { uploads: 'UU' } } }] });
  if (m === 'channels') return reply(200, { items: [{ statistics: { subscriberCount: '123', viewCount: '4567', videoCount: '3' } }] });
  if (m === 'commentThreads') {
    const p = threadsPages[Number(u.searchParams.get('pageToken') ?? 0)];
    return reply(200, p);
  }
  if (m === 'comments' && init?.method === 'POST') {
    inserted = JSON.parse(String(init.body));
    return reply(200, { id: 'NEW', snippet: { ...yc('NEW', 'Me', 'thanks!', '2026-10-29T10:00:00Z', 't1', 'CH').snippet } });
  }
  if (m === 'comments') return reply(200, { items: [yc('t1.r1', '@bob', 'one', '2026-10-28T01:00:00Z', 't1'), yc('t1.r2', '@cat', 'two', '2026-10-28T02:00:00Z', 't1'), yc('t1.r3', '@dan', 'three', '2026-10-28T03:00:00Z', 't1')] });
  if (m === 'videos') return reply(200, { items: [{ id: 'v1', snippet: { title: 'Video One', publishedAt: '2026-10-01T00:00:00Z', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/v1/mqdefault.jpg' } } }, statistics: { viewCount: '10', likeCount: '2', commentCount: '4' } }] });
  if (m === 'playlistItems') return reply(200, { items: [{ contentDetails: { videoId: 'v1' } }] });
  return reply(404, { error: { message: 'unknown' } });
}) as typeof fetch;

let clock = Date.UTC(2026, 9, 29, 18);
const yt = new YouTube({ dir, clientId: 'cid', clientSecret: 'csecret', redirect: 'http://127.0.0.1:7337/api/comments/auth/callback', fetch: fakeFetch, now: () => clock });

// sign-in
const authUrl = new URL(yt.startAuth());
const state = authUrl.searchParams.get('state')!;
eq('auth: scope is force-ssl only', authUrl.searchParams.get('scope'), YT_SCOPE);
eq('auth: PKCE S256, offline, loopback redirect', [authUrl.searchParams.get('code_challenge_method'), authUrl.searchParams.get('access_type'), authUrl.searchParams.get('redirect_uri')], ['S256', 'offline', 'http://127.0.0.1:7337/api/comments/auth/callback']);
let threw = '';
try {
  await yt.finishAuth(new URLSearchParams({ code: 'C', state: 'forged' }));
} catch (e) {
  threw = (e as Error).message;
}
eq('auth: a state it did not start is refused', /not started here/.test(threw), true);
await yt.finishAuth(new URLSearchParams({ code: 'C', state, scope: YT_SCOPE }));
eq('auth: the verifier matches the challenge', createHash('sha256').update(lastTokenBody.get('code_verifier')!).digest('base64url'), authUrl.searchParams.get('code_challenge'));
eq('auth: refresh token saved, file mode 0600', [yt.signedIn(), (statSync(join(dir, 'token.json')).mode & 0o777).toString(8)], [true, '600']);
threw = '';
try {
  await yt.finishAuth(new URLSearchParams({ code: 'C', state }));
} catch (e) {
  threw = (e as Error).message;
}
eq('auth: a state works once', /not started here/.test(threw), true);

// ---- a check ----

const alerts: string[] = [];
const models = {
  local: async () => null,
  haiku: { by: 'Haiku', ask: async (a: { user: string; system: string }) => (a.system.includes('VOICE GUIDE') && a.user.includes('Video One') ? 'Thanks — glad it helped!' : 'wrong prompt') },
};
const c = new Comments({ dir, yt, models, alert: (t, b) => alerts.push(`${t} | ${b}`), voice: () => 'VOICE GUIDE', never: ['employer'], now: () => clock });

// Page 0: t2 (new) and t1 (3 replies, only 1 sent along). Page 1: t0.
threadsPages = [
  { items: [
    { id: 't2', snippet: { videoId: 'v1', totalReplyCount: 0, topLevelComment: yc('t2', '@amy', 'Second!', '2026-10-28T05:00:00Z') } },
    { id: 't1', snippet: { videoId: 'v1', totalReplyCount: 3, topLevelComment: yc('t1', '@zed', 'How much VRAM?', '2026-10-28T00:00:00Z') }, replies: { comments: [yc('t1.r1', '@bob', 'one', '2026-10-28T01:00:00Z', 't1')] } },
  ], nextPageToken: '1' },
  { items: [{ id: 't0', snippet: { videoId: 'v1', totalReplyCount: 0, topLevelComment: yc('t0', '@old', 'First', '2026-10-27T00:00:00Z') } }] },
];
calls.length = 0;
const first = await c.check();
eq('check 1: channel, both pages, missing replies, video titles', calls, ['channels', 'commentThreads', 'commentThreads#1', 'comments@t1', 'videos']);
eq('check 1: all comments stored', c.list('all').items.map((x) => x.id).sort(), ['t0', 't1', 't1.r1', 't1.r2', 't1.r3', 't2']);
eq('check 1: no alert on the very first check', [first.length, alerts.length], [6, 0]);
eq('check 1: video title and link', [c.list().videos.v1?.title, c.list().items[0].url.includes('lc=')], ['Video One', true]);

// Next check: a new thread on top, then t2 (seen): stops after page 0.
clock += 15 * 60_000;
const t2 = (threadsPages[0] as { items: unknown[] }).items[0];
threadsPages = [{ items: [
  { id: 't3', snippet: { videoId: 'v1', totalReplyCount: 0, topLevelComment: yc('t3', '@new', 'Great video, what GPU?', '2026-10-29T17:00:00Z') } },
  t2,
], nextPageToken: '1' }, threadsPages[1]];
calls.length = 0;
const second = await c.check();
eq('check 2: stops at a thread it has seen (1 page)', calls.filter((x) => x.startsWith('commentThreads')), ['commentThreads']);
eq('check 2: one new, one alert', [second.map((x) => x.id), alerts.length, alerts[0]?.startsWith('YOUTUBE: NEW COMMENT | @new: Great video')], [['t3'], 1, true]);
eq('quota: logged per method', c.status().quota.calls['commentThreads.list'], 3);

// unanswered first, newest first
eq('inbox: unanswered, newest first', c.list('unanswered').items.map((x) => x.id), ['t3', 't2', 't1.r3', 't1.r2', 't1.r1', 't1', 't0']);

// mark + hide
c.mark(['t0'], { hidden: true });
c.mark(['t2'], { read: true });
eq('mark: hidden leaves the inbox, shows under hidden', [c.list('unanswered').items.some((x) => x.id === 't0'), c.list('hidden').items.map((x) => x.id)], [false, ['t0']]);
eq('mark: read', c.list('all').items.find((x) => x.id === 't2')?.read, true);

// draft
const d = await c.draft('t1');
eq('draft: voice guide in the prompt, dashes out, saved', [d.text, d.by, c.list().items.find((x) => x.id === 't1')?.draft], ['Thanks, glad it helped!', 'Haiku', 'Thanks, glad it helped!']);
const dr = await c.draft('t1.r2');
eq('draft: a reply to a reply starts with the @handle', dr.text.startsWith('@cat '), true);

// reply
const r = await c.reply('t1.r2', 'Twenty gigs!');
eq('reply: posted to the top comment of the thread', inserted, { snippet: { parentId: 't1', textOriginal: 'Twenty gigs!' } });
eq('reply: the whole thread before the reply is answered', c.list('unanswered').items.map((x) => x.id).filter((x) => x.startsWith('t1')), []);
eq('reply: own reply is stored, draft cleared', [r.own, c.list('all').items.find((x) => x.id === 't1.r2')?.draft], [true, '']);
eq('reply: 50 quota units', c.status().quota.calls['comments.insert'], 50);
eq('reply: sent log for the CLI', existsSync(join(dir, 'sent.jsonl')), true);

// stats
const st = await c.stats();
eq('stats: subscribers and per-video numbers', [st.subscribers, st.videos.map((v) => [v.id, v.views, v.likes, v.comments])], [123, [['v1', 10, 2, 4]]]);

// the store keeps no token
eq('store: no token in store.json', readFileSync(join(dir, 'store.json'), 'utf8').includes('RT-secret'), false);
eq('status: no token in the status', JSON.stringify(c.status()).includes('RT-secret'), false);

// ---- endpoints ----

const srv = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  void (url.pathname === '/api/comments/auth/callback' ? handleCommentsCallback(req, res, url, c) : handleComments(req, res, url, c));
});
await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
const port = (srv.address() as { port: number }).port;
const api = async (path: string, body?: unknown, type = 'application/json') => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
  const text = await r.text();
  return [r.status, text] as const;
};
eq('api: list answers', (await api('/api/comments?filter=all'))[0], 200);
eq('api: status has no token', (await api('/api/comments/status'))[1].includes('RT-secret'), false);
eq('api: POST must be JSON', (await api('/api/comments/mark', { ids: ['t1'] }, 'text/plain'))[0], 415);
eq('api: draft of an unknown comment = 404', (await api('/api/comments/draft', { id: 'nope' }))[0], 404);
eq('api: reply needs text', (await api('/api/comments/reply', { id: 't1' }))[0], 400);
eq('api: a bad id = 404', (await api('/api/comments/reply', { id: '../../x', text: 'hi' }))[0], 404);
eq('api: callback with a forged state = 400, nothing saved', (await api('/api/comments/auth/callback?code=x&state=forged'))[0], 400);
eq('api: settings clamp the interval', JSON.parse((await api('/api/comments/settings', { everyMin: 1 }))[1]).everyMin, 5);

// an expired sign-in (Testing mode, 7 days): invalid_grant asks for a new sign-in
tokenAnswer = { status: 400, body: { error: 'invalid_grant' } };
clock += 2 * 3600_000; // the access token ran out
eq('expired sign-in: the check reports it', /Sign in again/.test((await c.check(), c.status().lastError)), true);
eq('expired sign-in: token file gone, signed out', [existsSync(join(dir, 'token.json')), c.status().signedIn], [false, false]);
eq('api: check while signed out = 409', (await api('/api/comments/check', {}))[0], 409);
srv.close();

// not configured
const bare = new YouTube({ dir: mkdtempSync(join(tmpdir(), 'comments-bare-')), redirect: 'http://127.0.0.1:1/cb', fetch: fakeFetch });
threw = '';
try {
  bare.startAuth();
} catch (e) {
  threw = (e as Error).message;
}
eq('not configured: sign-in asks for the client id first', [bare.configured(), /client id/.test(threw)], [false, true]);
rmSync(bare.dir, { recursive: true, force: true });
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
