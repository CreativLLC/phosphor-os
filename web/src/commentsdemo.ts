import { answeredIds, commentUrl, inboxOrder, quotaDay, type ChannelStats, type CommentItem, type CommentsList, type CommentsStatus, type CommentVideo, type CommentView } from '../../shared/comments.ts';

// Fake data for COMMENTS in demo mode (/?demo=1): nothing goes to YouTube or a model. Names and words are made up.

const now = Date.now();
const H = 3600_000;

const videos: Record<string, CommentVideo> = {
  vidA: { id: 'vidA', title: 'I tried running a 35B model on a gaming PC', thumb: '', at: now - 5 * 24 * H },
  vidB: { id: 'vidB', title: 'Local AI vs cloud AI: one week', thumb: '', at: now - 12 * 24 * H },
  vidC: { id: 'vidC', title: 'Self-hosting my notes (Short)', thumb: '', at: now - 2 * 24 * H },
};

let n = 0;
const c = (videoId: string, author: string, text: string, hoursAgo: number, o: { thread?: string; own?: boolean; likes?: number } = {}): CommentItem => {
  const id = `demo${++n}`;
  return {
    id, threadId: o.thread ?? id, videoId, author, authorChannelId: o.own ? 'demo-channel' : `ch-${author}`, avatar: '', text, at: now - hoursAgo * H, edited: now - hoursAgo * H,
    likes: o.likes ?? 0, isReply: !!o.thread, own: !!o.own,
  };
};

const items: CommentItem[] = [];
const add = (x: CommentItem) => (items.push(x), x);
add(c('vidA', '@pixelfarmer', 'How many tokens a second did you get with the bigger model? Thinking of trying this on a 7800 XT.', 0.4, { likes: 3 }));
add(c('vidC', '@quietmaple', 'Which app is that for the notes? Looks clean.', 2));
const t3 = add(c('vidB', '@northbaydev', 'Great comparison. Did the cloud one ever just refuse to do something?', 7, { likes: 12 }));
add(c('vidB', 'Demo Channel', 'Once or twice, yeah. Mostly it was fine, the local one was the slow one.', 6, { thread: t3.id, own: true }));
add(c('vidB', '@northbaydev', 'Ha, fair. Thanks for answering!', 5, { thread: t3.id }));
add(c('vidA', '@lenamakes', 'The understated "not terrible" got me', 26, { likes: 40 }));
const t5 = add(c('vidA', '@tinkerhub', 'Did you try the same prompt twice? Curious how much the answers change.', 30));
add(c('vidA', 'Demo Channel', 'Not yet. That is a good one for the next video.', 29, { thread: t5.id, own: true }));
add(c('vidC', '@orbitlearning', 'First!', 40));

const marks = new Map<string, { read?: boolean; hidden?: boolean }>([[items[5].id, { read: true }], [items[8].id, { hidden: true }]]);
const drafts = new Map<string, string>([[items[0].id, 'About 40 tokens a second at the start, then it dropped to the low 30s as the chat got longer. A 7800 XT should be in the same ballpark, I think.']]);
let settings = { everyMin: 15, alerts: true };
let units = 37;

function views(): CommentView[] {
  const done = answeredIds(items);
  return items.map((x) => ({ ...x, answered: done.has(x.id), read: !!marks.get(x.id)?.read || x.own, hidden: !!marks.get(x.id)?.hidden, draft: drafts.get(x.id) ?? '', url: commentUrl(x.videoId, x.id) }));
}

function status(): CommentsStatus {
  const v = views();
  const open = v.filter((x) => !x.hidden);
  return {
    configured: true, signedIn: true, needsSignIn: '', channel: { id: 'demo-channel', title: 'Demo Channel' }, lastCheck: now - 6 * 60_000, nextCheck: Date.now() + 9 * 60_000,
    checking: false, lastError: '', everyMin: settings.everyMin, alerts: settings.alerts,
    quota: { day: quotaDay(Date.now()), units, calls: { 'commentThreads.list': units - 6, 'videos.list': 3, 'channels.list': 2, 'playlistItems.list': 1 }, limit: 10_000 },
    counts: {
      unanswered: open.filter((x) => !x.own && !x.answered).length,
      unread: open.filter((x) => !x.own && !x.read && !x.answered).length,
      all: open.length,
      hidden: v.length - open.length,
    },
  };
}

const DRAFTS = [
  'About 40 tokens a second at the start, then it dropped to the low 30s as the chat got longer. A 7800 XT should be in the same ballpark, I think.',
  'Thanks! That one is coming in a future video, so stay tuned.',
  'Ha, glad that landed.',
];

export function demoCommentsApi<T>(path: string, body?: unknown): Promise<T> {
  const reply = (v: unknown, ms = 150) => new Promise<T>((ok) => setTimeout(() => ok(v as T), ms));
  const b = (body ?? {}) as { id?: string; ids?: string[]; text?: string; read?: boolean; hidden?: boolean; everyMin?: number; alerts?: boolean };
  if (path.startsWith('?') || path === '') {
    const q = new URLSearchParams(path.slice(1));
    const f = q.get('filter') ?? 'unanswered';
    const video = q.get('video') ?? '';
    const list = views()
      .filter((x) => (!video || x.videoId === video) && (f === 'hidden' ? x.hidden : !x.hidden) && (f !== 'unanswered' || (!x.own && !x.answered)))
      .sort(inboxOrder);
    return reply({ status: status(), items: list, videos } satisfies CommentsList);
  }
  if (path === 'status' || path === 'check') {
    if (path === 'check') units++;
    return reply(status(), path === 'check' ? 900 : 150);
  }
  if (path === 'mark') {
    for (const id of b.ids ?? []) marks.set(id, { ...marks.get(id), ...(b.read === undefined ? {} : { read: b.read }), ...(b.hidden === undefined ? {} : { hidden: b.hidden }) });
    return reply({ ok: true });
  }
  if (path === 'draft') {
    const i = items.findIndex((x) => x.id === b.id);
    const text = DRAFTS[Math.max(0, i) % DRAFTS.length];
    drafts.set(String(b.id), text);
    return reply({ text, by: 'Haiku (demo)' }, 1200);
  }
  if (path === 'draft/save') {
    if (b.text?.trim()) drafts.set(String(b.id), b.text);
    else drafts.delete(String(b.id));
    return reply({ ok: true });
  }
  if (path === 'reply') {
    const to = items.find((x) => x.id === b.id);
    if (!to) return Promise.reject(new Error('No such comment.'));
    units += 50;
    drafts.delete(to.id);
    marks.set(to.id, { ...marks.get(to.id), read: true });
    const r = add(c(to.videoId, 'Demo Channel', String(b.text), 0, { thread: to.threadId, own: true }));
    return reply({ reply: r }, 700);
  }
  if (path.startsWith('stats')) {
    const s: ChannelStats = {
      at: Date.now() - 4 * 60_000, subscribers: 1234, views: 45_600, videoCount: 3,
      videos: Object.values(videos).sort((a, b) => b.at - a.at).map((v, i) => ({ ...v, views: [812, 3400, 9100][i], likes: [61, 240, 530][i], comments: items.filter((x) => x.videoId === v.id).length })),
    };
    return reply(s);
  }
  if (path === 'settings') {
    settings = { everyMin: b.everyMin ?? settings.everyMin, alerts: b.alerts ?? settings.alerts };
    return reply(status());
  }
  if (path === 'auth/start') return reply({ url: 'about:blank' });
  return Promise.reject(new Error('Not in the demo.'));
}
