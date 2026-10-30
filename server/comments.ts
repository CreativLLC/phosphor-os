import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { delimiter, join } from 'node:path';
import type { CleanupModel, CleanupModels } from '../shared/cleanup.ts';
import {
  answeredIds, checkDraft, commentUrl, COMMENTS_EVERY_MIN, COMMENTS_EVERY_RANGE, COMMENTS_QUOTA_STOP, DRAFT_RULES, inboxOrder, REPLY_MAX_CHARS,
  type ChannelStats, type CommentFilter, type CommentItem, type CommentsList, type CommentsStatus, type CommentVideo, type CommentView, type VideoStats,
} from '../shared/comments.ts';
import { cleanupModels } from './cleanup.ts';
import { config, DATA_DIR } from './config.ts';
import { alertOwner } from './push.ts';
import { YouTube, YouTubeError } from './youtube.ts';

// COMMENTS (docs/COMMENTS.md): the YouTube comments inbox. The server checks the channel's comments on a timer,
// keeps them in data/comments/store.json, alerts the owner about new ones (ALERTS push + a desktop note), drafts
// replies with the cheap model path (the CLEAN UP models: the local model when it is in memory, else Haiku), and posts
// a reply only when the owner presses SEND on that one reply.
//
// Quota (10,000 units a day): a check is commentThreads.list (1 unit per 100 threads), paged only until a thread it
// has seen before; every 6 hours a deeper check pages further (new replies on old threads). comments.list (1) only
// for threads with more replies than the check brought; videos.list (1 per 50 new videos). Stats: 3 units, cached 30
// min. A reply: 50 units. Checks pause above COMMENTS_QUOTA_STOP units in a day.

const FULL_EVERY_MS = 6 * 3600_000;
const STATS_FRESH_MS = 30 * 60_000;
const CHECK_GAP_MS = 20_000; // CHECK NOW at most this often
const PAGES_QUICK = 10;
const PAGES_FULL = 20;
const REPLY_THREADS_MAX = 30; // threads whose missing replies one check fetches
const VOICE_MAX_CHARS = 9000; // per voice file

type Marks = { read?: boolean; hidden?: boolean };
type Store = {
  channel: { id: string; title: string; uploads: string } | null;
  comments: Record<string, CommentItem>;
  videos: Record<string, CommentVideo>;
  marks: Record<string, Marks>;
  drafts: Record<string, string>;
  lastCheck: number;
  lastFull: number;
  lastError: string;
  stats: ChannelStats | null;
  settings: { everyMin: number; alerts: boolean };
};

const emptyStore = (): Store => ({
  channel: null, comments: {}, videos: {}, marks: {}, drafts: {}, lastCheck: 0, lastFull: 0, lastError: '', stats: null,
  settings: { everyMin: COMMENTS_EVERY_MIN, alerts: true },
});

// ---- YouTube's JSON (only the fields used) ----

type YtComment = {
  id: string;
  snippet: {
    authorDisplayName?: string; authorProfileImageUrl?: string; authorChannelId?: { value?: string };
    textDisplay?: string; textOriginal?: string; publishedAt?: string; updatedAt?: string; likeCount?: number; parentId?: string; videoId?: string;
  };
};
type YtThread = { id: string; snippet: { videoId?: string; totalReplyCount?: number; topLevelComment: YtComment }; replies?: { comments?: YtComment[] } };
type Page<T> = { items?: T[]; nextPageToken?: string };

export function toItem(c: YtComment, threadId: string, videoId: string, channelId: string): CommentItem {
  const s = c.snippet;
  const at = Date.parse(s.publishedAt ?? '') || 0;
  const author = s.authorChannelId?.value ?? '';
  return {
    id: c.id, threadId, videoId, author: s.authorDisplayName ?? '', authorChannelId: author, avatar: s.authorProfileImageUrl ?? '',
    text: s.textDisplay ?? s.textOriginal ?? '', at, edited: Date.parse(s.updatedAt ?? '') || at, likes: s.likeCount ?? 0,
    isReply: !!s.parentId, own: !!channelId && author === channelId,
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export type CommentsOpts = {
  dir: string;
  yt: YouTube;
  models?: CleanupModels;
  alert?: (title: string, body: string) => void;
  voice?: () => string; // the owner's voice guide for drafts
  never?: string[]; // words a draft must not hold
  readOnly?: boolean; // the CLI: never writes the store (the server owns it)
  now?: () => number;
};

export class Comments {
  readonly yt: YouTube;
  private readonly o: CommentsOpts;
  private s: Store;
  private checking = false;
  private lastCheckAsk = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextAt = 0;
  private sentSeen = 0; // bytes of sent.jsonl already merged

  constructor(o: CommentsOpts) {
    this.o = o;
    this.yt = o.yt;
    this.s = this.load();
    this.mergeSent();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
  private get file() {
    return join(this.o.dir, 'store.json');
  }
  private get sentFile() {
    return join(this.o.dir, 'sent.jsonl');
  }

  private load(): Store {
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Store>;
      const base = emptyStore();
      return { ...base, ...saved, settings: { ...base.settings, ...saved.settings } };
    } catch {
      return emptyStore();
    }
  }

  // The CLI reads the newest store each time.
  reload(): void {
    this.s = this.load();
    this.sentSeen = 0;
    this.mergeSent();
  }

  private save(): void {
    if (this.o.readOnly) return;
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.s), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  // Replies sent from the CLI land in sent.jsonl (an append is safe next to the running server); the server takes
  // them in here so the thread shows as answered before the next check.
  private mergeSent(): void {
    let text = '';
    try {
      text = readFileSync(this.sentFile, 'utf8');
    } catch {
      return;
    }
    if (text.length <= this.sentSeen) return;
    let changed = false;
    for (const line of text.slice(this.sentSeen).split('\n')) {
      if (!line) continue;
      try {
        const c = JSON.parse(line) as CommentItem;
        if (c?.id && !this.s.comments[c.id]) {
          this.s.comments[c.id] = c;
          changed = true;
        }
      } catch {
        /* a torn line */
      }
    }
    this.sentSeen = text.length;
    if (changed) this.save();
  }

  // ---- status and the list ----

  status(): CommentsStatus {
    const all = Object.values(this.s.comments);
    const answered = answeredIds(all);
    const counts = { unanswered: 0, unread: 0, all: 0, hidden: 0 };
    for (const c of all) {
      const m = this.s.marks[c.id] ?? {};
      if (m.hidden) {
        counts.hidden++;
        continue;
      }
      counts.all++;
      if (c.own) continue;
      if (!answered.has(c.id)) counts.unanswered++;
      if (!m.read && !answered.has(c.id)) counts.unread++;
    }
    return {
      configured: this.yt.configured(),
      signedIn: this.yt.signedIn(),
      needsSignIn: this.yt.needsSignIn,
      channel: this.s.channel ? { id: this.s.channel.id, title: this.s.channel.title } : null,
      lastCheck: this.s.lastCheck,
      nextCheck: this.nextAt,
      checking: this.checking,
      lastError: this.s.lastError,
      everyMin: this.s.settings.everyMin,
      alerts: this.s.settings.alerts,
      quota: this.yt.quota(),
      counts,
    };
  }

  list(filter: CommentFilter = 'unanswered', video = ''): CommentsList {
    this.mergeSent();
    const all = Object.values(this.s.comments);
    const answered = answeredIds(all);
    const items: CommentView[] = [];
    for (const c of all) {
      if (video && c.videoId !== video) continue;
      const m = this.s.marks[c.id] ?? {};
      const hidden = !!m.hidden;
      const done = answered.has(c.id);
      if (filter === 'hidden' ? !hidden : hidden) continue;
      if (filter === 'unanswered' && (c.own || done)) continue;
      items.push({ ...c, answered: done, read: !!m.read || c.own, hidden, draft: this.s.drafts[c.id] ?? '', url: commentUrl(c.videoId, c.id) });
    }
    items.sort(inboxOrder);
    const videos: Record<string, CommentVideo> = {};
    for (const v of Object.values(this.s.videos)) videos[v.id] = v;
    return { status: this.status(), items, videos };
  }

  get(id: string): CommentItem | null {
    return this.s.comments[id] ?? null;
  }

  mark(ids: string[], p: Marks): void {
    for (const id of ids) {
      if (!this.s.comments[id]) continue;
      const m = { ...this.s.marks[id] };
      if (typeof p.read === 'boolean') m.read = p.read;
      if (typeof p.hidden === 'boolean') m.hidden = p.hidden;
      if (m.read || m.hidden) this.s.marks[id] = { ...(m.read ? { read: true } : {}), ...(m.hidden ? { hidden: true } : {}) };
      else delete this.s.marks[id];
    }
    this.save();
  }

  setSettings(p: { everyMin?: unknown; alerts?: unknown }): void {
    const [lo, hi] = COMMENTS_EVERY_RANGE;
    if (typeof p.everyMin === 'number' && Number.isFinite(p.everyMin)) this.s.settings.everyMin = Math.round(Math.min(hi, Math.max(lo, p.everyMin)));
    if (typeof p.alerts === 'boolean') this.s.settings.alerts = p.alerts;
    this.save();
    if (this.timer !== undefined) this.schedule();
  }

  // ---- checking YouTube ----

  private async channel(): Promise<NonNullable<Store['channel']>> {
    if (this.s.channel) return this.s.channel;
    type Ch = { id: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } };
    const r = await this.yt.call<Page<Ch>>('channels.list', 1, 'channels', { part: 'snippet,contentDetails', mine: true });
    const ch = r.items?.[0];
    if (!ch) throw new YouTubeError('This Google account has no YouTube channel. Sign in with the account that owns the channel.');
    this.s.channel = { id: ch.id, title: ch.snippet?.title ?? '', uploads: ch.contentDetails?.relatedPlaylists?.uploads ?? '' };
    return this.s.channel;
  }

  // One check. Returns the comments by others that were new. full: page deeper (also done every 6 hours).
  async check(full = false): Promise<CommentItem[]> {
    if (this.checking) return [];
    this.checking = true;
    const units0 = this.yt.quota().units;
    const added: CommentItem[] = [];
    try {
      if (units0 >= COMMENTS_QUOTA_STOP) throw new YouTubeError(`Checks paused: ${units0} quota units used today (stop at ${COMMENTS_QUOTA_STOP}). They start again after midnight Pacific.`);
      const ch = await this.channel();
      const first = this.s.lastCheck === 0;
      const deep = full || first || this.now() - this.s.lastFull > FULL_EVERY_MS;
      const before = new Set(Object.keys(this.s.comments));
      const replyCount = new Map<string, number>();
      for (const c of Object.values(this.s.comments)) if (c.isReply) replyCount.set(c.threadId, (replyCount.get(c.threadId) ?? 0) + 1);
      const missing: string[] = [];
      let pageToken = '';
      for (let page = 0; page < (deep ? PAGES_FULL : PAGES_QUICK); page++) {
        const r = await this.yt.call<Page<YtThread>>('commentThreads.list', 1, 'commentThreads', {
          part: 'snippet,replies', allThreadsRelatedToChannelId: ch.id, maxResults: 100, order: 'time', textFormat: 'plainText', ...(pageToken ? { pageToken } : {}),
        });
        let seen = false;
        for (const t of r.items ?? []) {
          const vid = t.snippet.videoId;
          if (!vid) continue; // not on a video
          if (before.has(t.snippet.topLevelComment.id)) seen = true;
          this.put(toItem(t.snippet.topLevelComment, t.id, vid, ch.id));
          let have = replyCount.get(t.id) ?? 0;
          for (const c of t.replies?.comments ?? []) {
            if (!this.s.comments[c.id]) have++;
            this.put(toItem(c, t.id, vid, ch.id));
          }
          replyCount.set(t.id, have);
          if ((t.snippet.totalReplyCount ?? 0) > have) missing.push(t.id);
        }
        pageToken = r.nextPageToken ?? '';
        if (!pageToken || (seen && !deep)) break;
      }
      for (const threadId of missing.slice(0, REPLY_THREADS_MAX)) await this.fetchReplies(threadId, ch.id);
      await this.fetchVideos();
      for (const c of Object.values(this.s.comments)) if (!before.has(c.id) && !c.own) added.push(c);
      this.s.lastCheck = this.now();
      if (deep) this.s.lastFull = this.now();
      this.s.lastError = '';
      if (!first && added.length && this.s.settings.alerts) this.alertNew(added);
      return added;
    } catch (e) {
      this.s.lastError = e instanceof Error ? e.message : String(e);
      return [];
    } finally {
      this.checking = false;
      this.save();
      const q = this.yt.quota();
      console.log(`[comments] check: ${added.length} new, ${q.units - units0} quota units (today ${q.units}/${q.limit})${this.s.lastError ? `, error: ${this.s.lastError}` : ''}`);
    }
  }

  private put(c: CommentItem): void {
    this.s.comments[c.id] = c;
  }

  private async fetchReplies(threadId: string, channelId: string): Promise<void> {
    const top = this.s.comments[threadId];
    if (!top) return;
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const r = await this.yt.call<Page<YtComment>>('comments.list', 1, 'comments', { part: 'snippet', parentId: threadId, maxResults: 100, textFormat: 'plainText', ...(pageToken ? { pageToken } : {}) });
      for (const c of r.items ?? []) this.put(toItem(c, threadId, top.videoId, channelId));
      pageToken = r.nextPageToken ?? '';
      if (!pageToken) break;
    }
  }

  private async fetchVideos(): Promise<void> {
    const want = [...new Set(Object.values(this.s.comments).map((c) => c.videoId))].filter((id) => !this.s.videos[id]);
    for (let i = 0; i < want.length; i += 50) {
      type V = { id: string; snippet?: { title?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }> } };
      const r = await this.yt.call<Page<V>>('videos.list', 1, 'videos', { part: 'snippet', id: want.slice(i, i + 50).join(','), maxResults: 50 });
      for (const v of r.items ?? []) this.s.videos[v.id] = { id: v.id, title: v.snippet?.title ?? v.id, thumb: thumbOf(v.snippet?.thumbnails), at: Date.parse(v.snippet?.publishedAt ?? '') || 0 };
      // Deleted or private videos answer nothing: remember them so they are not asked for again.
      for (const id of want.slice(i, i + 50)) this.s.videos[id] ??= { id, title: '(video not available)', thumb: '', at: 0 };
    }
  }

  private alertNew(added: CommentItem[]): void {
    const c = [...added].sort((a, b) => b.at - a.at)[0];
    const title = added.length === 1 ? 'YOUTUBE: NEW COMMENT' : `YOUTUBE: ${added.length} NEW COMMENTS`;
    const body = clip(`${c.author}: ${oneLine(c.text)}`, 80);
    try {
      (this.o.alert ?? alertOwner)(title, body);
    } catch {
      /* alerts must never break a check */
    }
  }

  // ---- the timer ----

  start(): void {
    this.o.yt.pruneQuota();
    this.schedule(60_000); // a minute after the server starts
  }

  private schedule(ms?: number): void {
    clearTimeout(this.timer);
    if (!this.yt.signedIn()) {
      this.nextAt = 0;
      this.timer = setTimeout(() => this.schedule(), 5 * 60_000); // signed in later: picked up here or by finishAuth
      this.timer.unref?.();
      return;
    }
    const wait = ms ?? this.s.settings.everyMin * 60_000;
    this.nextAt = this.now() + wait;
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule());
    }, wait);
    this.timer.unref?.();
  }

  async checkNow(): Promise<CommentsStatus> {
    if (this.now() - this.lastCheckAsk < CHECK_GAP_MS) throw new YouTubeError('Checked a moment ago. Wait a few seconds.', 429);
    this.lastCheckAsk = this.now();
    await this.check();
    if (this.timer !== undefined) this.schedule();
    return this.status();
  }

  afterSignIn(): void {
    this.s.channel = null; // maybe another account
    this.s.lastError = '';
    this.save();
    if (this.timer !== undefined) this.schedule(2000);
  }

  // ---- stats ----

  async stats(fresh = false): Promise<ChannelStats> {
    const s = this.s.stats;
    if (s && (this.now() - s.at < (fresh ? 60_000 : STATS_FRESH_MS))) return s;
    const ch = await this.channel();
    type C = { statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; viewCount?: string; videoCount?: string } };
    const c = (await this.yt.call<Page<C>>('channels.list', 1, 'channels', { part: 'statistics', id: ch.id })).items?.[0]?.statistics ?? {};
    const videos: VideoStats[] = [];
    if (ch.uploads) {
      type P = { contentDetails?: { videoId?: string } };
      const ids = ((await this.yt.call<Page<P>>('playlistItems.list', 1, 'playlistItems', { part: 'contentDetails', playlistId: ch.uploads, maxResults: 10 })).items ?? [])
        .map((p) => p.contentDetails?.videoId)
        .filter((id): id is string => !!id);
      if (ids.length) {
        type V = { id: string; snippet?: { title?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }> }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } };
        const r = await this.yt.call<Page<V>>('videos.list', 1, 'videos', { part: 'snippet,statistics', id: ids.join(',') });
        for (const v of r.items ?? []) {
          const at = Date.parse(v.snippet?.publishedAt ?? '') || 0;
          videos.push({ id: v.id, title: v.snippet?.title ?? v.id, thumb: thumbOf(v.snippet?.thumbnails), at, views: Number(v.statistics?.viewCount ?? 0), likes: Number(v.statistics?.likeCount ?? 0), comments: Number(v.statistics?.commentCount ?? 0) });
          this.s.videos[v.id] = { id: v.id, title: v.snippet?.title ?? v.id, thumb: thumbOf(v.snippet?.thumbnails), at };
        }
        videos.sort((a, b) => b.at - a.at);
      }
    }
    this.s.stats = { at: this.now(), subscribers: c.hiddenSubscriberCount ? null : Number(c.subscriberCount ?? 0), views: Number(c.viewCount ?? 0), videoCount: Number(c.videoCount ?? 0), videos };
    this.save();
    return this.s.stats;
  }

  // ---- drafts ----

  // A drafted reply in the owner's voice, saved as the draft (unless readOnly). Throws when no model gave a usable one.
  async draft(id: string): Promise<{ text: string; by: string }> {
    const c = this.s.comments[id];
    if (!c) throw new YouTubeError('No such comment.', 404);
    const video = this.s.videos[c.videoId];
    const thread = Object.values(this.s.comments).filter((x) => x.threadId === c.threadId && x.at <= c.at).sort((a, b) => a.at - b.at).slice(-6);
    const lines = thread.map((x) => `- ${x.own ? '(you, the channel)' : x.author}: ${clip(oneLine(x.text), 400)}`);
    let mark = 'COMMENT';
    while (c.text.includes(mark)) mark += '_';
    const user = [
      `Video: ${video?.title ?? 'unknown'}`,
      thread.length > 1 ? `The thread so far, oldest first:\n${lines.join('\n')}` : '',
      `Write the channel's reply to this comment by ${c.author}:\n<<<${mark}\n${clip(c.text, 2000)}\n${mark}>>>`,
      'Reply with the reply text only.',
    ].filter(Boolean).join('\n\n');
    const voice = this.o.voice?.() ?? '';
    const system = voice ? `${DRAFT_RULES}\n\nThe owner's voice guide (how they write; the rules above win over it):\n\n${voice}` : DRAFT_RULES;
    const models = this.o.models ?? cleanupModels;
    const local = await models.local().catch(() => null);
    const tries: [CleanupModel | null, number][] = [[local, 25_000], [models.haiku, 60_000]];
    const never = this.o.never ?? [];
    for (const [m, timeoutMs] of tries) {
      if (!m) continue;
      try {
        let text = checkDraft(await m.ask({ system, user, maxTokens: 400, timeoutMs }), never);
        if (!text) continue;
        if (c.isReply && c.author.startsWith('@') && !text.startsWith(c.author)) text = `${c.author} ${text}`;
        if (!this.o.readOnly) {
          this.s.drafts[id] = text;
          this.save();
        }
        return { text, by: m.by };
      } catch {
        /* this model failed: the next one */
      }
    }
    throw new YouTubeError('No draft this time (the models failed or broke a rule). Try again or write it yourself.', 502);
  }

  saveDraft(id: string, text: string): void {
    if (!this.s.comments[id]) throw new YouTubeError('No such comment.', 404);
    const t = text.slice(0, REPLY_MAX_CHARS);
    if (t.trim()) this.s.drafts[id] = t;
    else delete this.s.drafts[id];
    this.save();
  }

  // ---- posting ----

  // Posts ONE reply in the comment's thread (YouTube has one level of replies: a reply to a reply goes to the top
  // comment). Only called for an explicit SEND (screen) or --send with a typed yes (CLI).
  async reply(id: string, text: string): Promise<CommentItem> {
    const c = this.s.comments[id];
    if (!c) throw new YouTubeError('No such comment.', 404);
    const body = text.replace(/\r\n?/g, '\n').trim();
    if (!body) throw new YouTubeError('The reply is empty.', 400);
    if (body.length > REPLY_MAX_CHARS) throw new YouTubeError(`At most ${REPLY_MAX_CHARS} characters.`, 400);
    const ch = await this.channel();
    const r = await this.yt.call<YtComment>('comments.insert', 50, 'comments', { part: 'snippet' }, { snippet: { parentId: c.threadId, textOriginal: body } });
    const item = toItem({ ...r, snippet: { ...r.snippet, parentId: r.snippet?.parentId ?? c.threadId } }, c.threadId, c.videoId, ch.id);
    item.own = true;
    item.text ||= body;
    item.at ||= this.now();
    try {
      mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
      appendFileSync(this.sentFile, `${JSON.stringify(item)}\n`, { mode: 0o600 });
    } catch {
      /* the next check brings it anyway */
    }
    if (!this.o.readOnly) {
      this.put(item);
      delete this.s.drafts[id];
      this.s.marks[id] = { ...this.s.marks[id], read: true };
      this.save();
    }
    return item;
  }
}

function thumbOf(t: Record<string, { url?: string }> | undefined): string {
  return t?.medium?.url ?? t?.default?.url ?? t?.high?.url ?? '';
}

// ---- the server's one inbox ----

const voiceFiles = () => (process.env.PHOSPHOR_COMMENTS_VOICE ?? '').split(delimiter).map((p) => p.trim()).filter(Boolean);

export function readVoice(): string {
  const parts: string[] = [];
  for (const f of voiceFiles()) {
    try {
      parts.push(readFileSync(f, 'utf8').slice(0, VOICE_MAX_CHARS));
    } catch {
      /* a moved file: drafts still work without it */
    }
  }
  return parts.join('\n\n---\n\n');
}

export const COMMENTS_DIR = join(DATA_DIR, 'comments');

let app: Comments | null = null;
export function commentsApp(readOnly = false): Comments {
  app ??= new Comments({
    dir: COMMENTS_DIR,
    yt: new YouTube({
      dir: COMMENTS_DIR,
      clientId: process.env.PHOSPHOR_YOUTUBE_CLIENT_ID,
      clientSecret: process.env.PHOSPHOR_YOUTUBE_CLIENT_SECRET,
      redirect: `http://127.0.0.1:${config.port}/api/comments/auth/callback`,
    }),
    voice: readVoice,
    never: (process.env.PHOSPHOR_COMMENTS_NEVER ?? '').split(',').map((w) => w.trim()).filter(Boolean),
    readOnly,
  });
  return app;
}

export function startComments(): void {
  commentsApp().start();
}

// ---- HTTP (server/index.ts) ----

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 64 * 1024) req.destroy(new Error('too big'));
    });
    req.on('end', () => {
      try {
        const v = s ? JSON.parse(s) : {};
        ok(v && typeof v === 'object' ? v : {});
      } catch {
        no(new YouTubeError('bad JSON', 400));
      }
    });
    req.on('error', no);
  });
}

const fail = (res: ServerResponse, e: unknown) => {
  const status = e instanceof YouTubeError && e.status >= 400 && e.status < 600 ? e.status : 502;
  json(res, { error: e instanceof Error ? e.message : String(e) }, status);
};

const ID = /^[\w.-]{1,120}$/;

// Behind the login cookie (index.ts).
export async function handleComments(req: IncomingMessage, res: ServerResponse, url: URL, c: Comments = commentsApp()): Promise<void> {
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (req.method === 'GET') {
      if (path === '/api/comments') {
        const f = url.searchParams.get('filter');
        const video = url.searchParams.get('video') ?? '';
        return json(res, c.list(f === 'all' || f === 'hidden' ? f : 'unanswered', ID.test(video) ? video : ''));
      }
      if (path === '/api/comments/status') return json(res, c.status());
      if (path === '/api/comments/stats') {
        if (!c.yt.signedIn()) return json(res, { error: 'Not signed in to YouTube.' }, 409);
        return json(res, await c.stats(url.searchParams.has('fresh')));
      }
      if (path === '/api/comments/auth/start') return json(res, { url: c.yt.startAuth() });
      return json(res, { error: 'not found' }, 404);
    }
    if (req.method !== 'POST') return json(res, { error: 'not found' }, 404);
    // JSON only: a form on another page cannot send it.
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      req.resume();
      return json(res, { error: 'POST JSON only.' }, 415);
    }
    const b = await body(req);
    const id = typeof b.id === 'string' && ID.test(b.id) ? b.id : '';
    switch (path) {
      case '/api/comments/check':
        if (!c.yt.signedIn()) return json(res, { error: 'Not signed in to YouTube.' }, 409);
        return json(res, await c.checkNow());
      case '/api/comments/mark': {
        const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 2000) : [];
        c.mark(ids, { read: typeof b.read === 'boolean' ? b.read : undefined, hidden: typeof b.hidden === 'boolean' ? b.hidden : undefined });
        return json(res, { ok: true });
      }
      case '/api/comments/draft':
        if (!id || !c.get(id)) return json(res, { error: 'No such comment.' }, 404);
        return json(res, await c.draft(id));
      case '/api/comments/draft/save':
        if (!id || !c.get(id)) return json(res, { error: 'No such comment.' }, 404);
        c.saveDraft(id, typeof b.text === 'string' ? b.text : '');
        return json(res, { ok: true });
      case '/api/comments/reply':
        if (!id || !c.get(id)) return json(res, { error: 'No such comment.' }, 404);
        if (typeof b.text !== 'string') return json(res, { error: 'Send { id, text }.' }, 400);
        if (!c.yt.signedIn()) return json(res, { error: 'Not signed in to YouTube.' }, 409);
        return json(res, { reply: await c.reply(id, b.text) });
      case '/api/comments/settings':
        c.setSettings(b);
        return json(res, c.status());
      case '/api/comments/auth/finish': {
        let u: URL;
        try {
          u = new URL(String(b.url ?? '').trim());
        } catch {
          return json(res, { error: 'Paste the whole address from the browser bar.' }, 400);
        }
        await c.yt.finishAuth(u.searchParams);
        c.afterSignIn();
        return json(res, c.status());
      }
      case '/api/comments/auth/signout':
        await c.yt.signOut();
        return json(res, c.status());
    }
    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    return fail(res, e);
  }
}

// Google sends the browser here after the sign-in. No login cookie (the browser may be on 127.0.0.1 while the app
// runs on localhost): the one-time state that a logged-in page started is the guard. Answers a small page.
export async function handleCommentsCallback(_req: IncomingMessage, res: ServerResponse, url: URL, c: Comments = commentsApp()): Promise<void> {
  const page = (title: string, text: string, status: number): void =>
    void res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phosphor-OS: ${title}</title>` +
        `<body style="background:#0b0700;color:#ffb000;font:20px/1.4 ui-monospace,monospace;padding:24px"><h1 style="font-size:24px">${title}</h1><p>${text}</p>` +
        `<p><a style="color:#ffb000" href="/?comments">Back to COMMENTS</a></p></body>`,
    );
  if (!c.yt.hasPending(url.searchParams.get('state') ?? '')) return page('SIGN-IN NOT FOUND', 'This sign-in is old or was not started here. Press SIGN IN on the COMMENTS screen again.', 400);
  try {
    await c.yt.finishAuth(url.searchParams);
    c.afterSignIn();
    return page('SIGNED IN', 'YouTube is connected. You can close this tab and go back to COMMENTS.', 200);
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/[<>&]/g, '');
    return page('SIGN-IN FAILED', msg, 400);
  }
}
