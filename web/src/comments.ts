import './comments.css';
import { REPLY_MAX_CHARS, type ChannelStats, type CommentFilter, type CommentsList, type CommentsStatus, type CommentView } from '../../shared/comments.ts';
import { demoCommentsApi } from './commentsdemo.ts';
import { closeDocs, isDocsOpen, onDocsToggle } from './docs.ts';
import { closeKeywords, isKeywordsOpen, onKeywordsToggle } from './keywords.ts';
import { closeLab, isLabOpen, onLabToggle } from './lab.ts';
import { closePrompter, isPrompterOpen, onPrompterToggle } from './prompter.ts';
import { showChat } from './programs.ts';
import { store } from './store.ts';
import { button, confirmBox, el, timeAgo, toast } from './ui.ts';

// COMMENTS (docs/COMMENTS.md): the YouTube comments inbox. The server checks the channel on a timer and keeps the
// comments; this screen lists them (unanswered first), drafts a reply in the owner's voice, and posts a reply only when
// SEND is pressed on that one reply (and confirmed). STATS: subscribers and the newest videos' numbers. SETUP: the
// Google sign-in, how often to check, alerts, quota used today.
// Open straight to it with ?comments (inbox), ?comments=stats or ?comments=setup. A tap on a COMMENTS alert opens it.

type View = 'inbox' | 'stats' | 'setup';

const REFRESH_MS = 30_000;

let rootEl: HTMLElement | null = null;
let topBtn: HTMLElement | null = null;
let isOpen = false;
let pendingBack = 0;
let view: View = 'inbox';
let filter: CommentFilter = 'unanswered';
let videoFilter = '';
const toggles = new Set<() => void>();

let nav: HTMLElement;
let inboxBox: HTMLElement;
let statsBox: HTMLElement;
let setupBox: HTMLElement;
let headInfo: HTMLElement;
let filterRow: HTMLElement;
let listEl: HTMLElement;
let checkBtn: HTMLButtonElement;

let data: CommentsList | null = null;
let listKey = '';
let refreshTimer = 0;
const openReply = new Set<string>(); // comments whose reply box is open
const busy = new Set<string>(); // drafting or sending

// ------------------------------------------------------------ public

export function mountComments(btn: HTMLElement | null): void {
  topBtn = btn;
  if (btn) btn.onclick = () => (isOpen ? closeComments() : openComments());
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tab-label, .tab-add')) closeComments();
  });
  document.getElementById('history')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.history-row')) closeComments();
  });
  // DOCS, LAB, KEYWORDS and PROMPTER each push their own back-button entry.
  onDocsToggle(() => isDocsOpen() && closeComments(true));
  onLabToggle(() => isLabOpen() && closeComments(true));
  onKeywordsToggle(() => isKeywordsOpen() && closeComments(true));
  onPrompterToggle(() => isPrompterOpen() && closeComments(true));
  addEventListener('popstate', () => {
    if (pendingBack > 0) {
      pendingBack--;
      return;
    }
    if (isOpen && (window.history.state as { phosphorComments?: boolean } | null)?.phosphorComments !== true) closeComments(true);
  });
  addEventListener('phosphor-open-comments', () => openComments('inbox')); // a tap on a COMMENTS alert (alerts.ts)
  const start = new URLSearchParams(location.search).get('comments');
  if (start !== null) openComments(start === 'stats' || start === 'setup' ? start : 'inbox');
}

export const isCommentsOpen = (): boolean => isOpen;

export function onCommentsToggle(fn: () => void): void {
  toggles.add(fn);
}

export function openComments(v?: View): void {
  build();
  if (v) view = v;
  if (!isOpen) {
    const fromOther = isDocsOpen() || isLabOpen() || isKeywordsOpen() || isPrompterOpen();
    if (isDocsOpen()) closeDocs(true);
    if (isLabOpen()) closeLab(true);
    if (isKeywordsOpen()) closeKeywords(true);
    if (isPrompterOpen()) closePrompter(true);
    showChat(); // the desktop app: a site in the web pane would sit on top
    isOpen = true;
    rootEl!.hidden = false;
    document.body.classList.add('comments-open');
    topBtn?.classList.add('on');
    try {
      if (fromOther) window.history.replaceState({ phosphorComments: true }, '');
      else window.history.pushState({ phosphorComments: true }, '');
    } catch {
      /* fine without the back button */
    }
    refreshTimer = window.setInterval(() => void refresh(), REFRESH_MS);
    for (const fn of toggles) fn();
  }
  void refresh().then(() => {
    // Not set up yet: SETUP is the only useful view.
    if (data && !data.status.signedIn && view === 'inbox' && !data.items.length) view = 'setup';
    showView();
  });
  showView();
}

export function closeComments(fromPop = false): void {
  if (!isOpen || !rootEl) return;
  isOpen = false;
  rootEl.hidden = true;
  document.body.classList.remove('comments-open');
  topBtn?.classList.remove('on');
  clearInterval(refreshTimer);
  if (!fromPop && (window.history.state as { phosphorComments?: boolean } | null)?.phosphorComments) {
    pendingBack++;
    window.history.back();
  }
  for (const fn of toggles) fn();
}

export const commentsCommands = [
  { id: 'comments', label: 'COMMENTS', hint: 'YouTube comments: unanswered first, draft and send replies', keywords: ['youtube', 'comments', 'reply', 'inbox', 'channel', 'viewers'], run: () => openComments('inbox') },
  { id: 'comments-stats', label: 'COMMENTS STATS', hint: 'Subscribers and the newest videos: views, likes, comments', keywords: ['youtube', 'stats', 'views', 'subscribers'], run: () => openComments('stats') },
];

// ------------------------------------------------------------ server

const isDemo = () => store.demo || new URLSearchParams(location.search).has('demo');

async function api<T>(path: string, body?: unknown): Promise<T> {
  if (isDemo()) return demoCommentsApi<T>(path, body);
  const r = await fetch(`/api/comments${path ? `/${path}` : ''}`.replace('/?', '?'), {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(d.error ?? `The server said ${r.status}.`);
  return d;
}

const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 6000);

const fmtNum = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '-';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};

const link = (text: string, href: string, cls = 'cmt-link'): HTMLAnchorElement => {
  const a = el('a', cls, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
};

// ------------------------------------------------------------ frame

function build(): void {
  if (rootEl) return;
  const root = el('section', 'cmt');
  rootEl = root;
  root.hidden = true;
  root.setAttribute('aria-label', 'COMMENTS');
  const bar = el('div', 'cmt-bar');
  nav = el('nav', 'cmt-nav');
  for (const [label, v] of [['INBOX', 'inbox'], ['STATS', 'stats'], ['SETUP', 'setup']] as const) {
    const b = button(label, () => {
      view = v;
      showView();
    });
    b.dataset.v = v;
    nav.append(b);
  }
  headInfo = el('span', 'cmt-head');
  checkBtn = button('CHECK NOW', () => void checkNow());
  checkBtn.title = 'Ask YouTube for new comments now (1 quota unit or a few)';
  bar.append(el('span', 'cmt-tag', 'COMMENTS'), nav, headInfo, checkBtn);

  const main = el('div', 'cmt-main');
  inboxBox = el('div', 'cmt-view');
  filterRow = el('div', 'cmt-row cmt-filters');
  listEl = el('div', 'cmt-list');
  inboxBox.append(filterRow, listEl);
  statsBox = el('div', 'cmt-view');
  setupBox = el('div', 'cmt-view');
  main.append(inboxBox, statsBox, setupBox);
  root.append(bar, main);
  document.body.append(root);
}

function showView(): void {
  for (const b of nav.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.v === view);
  inboxBox.hidden = view !== 'inbox';
  statsBox.hidden = view !== 'stats';
  setupBox.hidden = view !== 'setup';
  if (view === 'stats') void loadStats();
  if (view === 'setup') renderSetup();
}

async function refresh(): Promise<void> {
  if (!isOpen) return;
  try {
    const q = new URLSearchParams({ filter, ...(videoFilter ? { video: videoFilter } : {}) });
    data = await api<CommentsList>(`?${q}`);
    renderHead();
    renderInbox();
    if (view === 'setup') renderSetup();
  } catch (e) {
    listEl.replaceChildren(el('p', 'cmt-err', e instanceof Error ? e.message : String(e)));
  }
}

function renderHead(): void {
  const s = data?.status;
  if (!s) return;
  const parts = [s.channel?.title ?? '', s.checking ? 'CHECKING…' : s.lastCheck ? `CHECKED ${timeAgo(s.lastCheck).toUpperCase()}` : 'NEVER CHECKED'];
  headInfo.textContent = parts.filter(Boolean).join(' · ');
  headInfo.title = s.lastError;
  headInfo.classList.toggle('cmt-err', !!s.lastError || !!s.needsSignIn);
  checkBtn.disabled = !s.signedIn || s.checking;
}

async function checkNow(): Promise<void> {
  checkBtn.disabled = true;
  headInfo.textContent = 'CHECKING…';
  try {
    const s = await api<CommentsStatus>('check', {});
    if (s.lastError) toast(s.lastError, 6000);
  } catch (e) {
    fail(e);
  }
  listKey = '';
  await refresh();
}

// ------------------------------------------------------------ inbox

function renderInbox(): void {
  if (!data) return;
  const s = data.status;
  const fbtn = (label: string, f: CommentFilter, n: number) => {
    const b = button(n ? `${label} ${n}` : label, () => {
      filter = f;
      listKey = '';
      void refresh();
    });
    b.classList.toggle('on', filter === f);
    return b;
  };
  const pick = el('select', 'cmt-video');
  pick.setAttribute('aria-label', 'Video');
  pick.append(new Option('ALL VIDEOS', ''));
  for (const v of Object.values(data.videos).sort((a, b) => b.at - a.at)) pick.append(new Option(v.title, v.id, false, v.id === videoFilter));
  pick.value = videoFilter;
  pick.onchange = () => {
    videoFilter = pick.value;
    listKey = '';
    void refresh();
  };
  const unread = data.items.filter((x) => !x.read && !x.own).map((x) => x.id);
  const allRead = button('MARK ALL READ', () => void mark(unread, { read: true }));
  allRead.disabled = !unread.length;
  filterRow.replaceChildren(fbtn('UNANSWERED', 'unanswered', s.counts.unanswered), fbtn('ALL', 'all', 0), fbtn('HIDDEN', 'hidden', s.counts.hidden), pick, allRead);

  // Redraw only when the list changed, so an open reply box and what is typed in it stay.
  const key = JSON.stringify([filter, videoFilter, data.items.map((x) => [x.id, x.read, x.hidden, x.answered, x.likes, x.text]), !s.signedIn]);
  if (key === listKey) return;
  listKey = key;
  if (!data.items.length) {
    const why = !s.configured ? 'NOT SET UP YET. SEE SETUP.' : !s.signedIn ? 'NOT SIGNED IN. SEE SETUP.' : filter === 'unanswered' ? 'NOTHING WAITS FOR AN ANSWER.' : 'NO COMMENTS HERE.';
    return void listEl.replaceChildren(el('p', 'cmt-empty', why));
  }
  listEl.replaceChildren(...data.items.map(card));
}

function card(c: CommentView): HTMLElement {
  const v = data?.videos[c.videoId];
  const box = el('article', `cmt-card${c.read ? '' : ' cmt-new'}${c.own ? ' cmt-own' : ''}${c.answered ? ' cmt-done' : ''}`);
  box.dataset.id = c.id;

  const vid = el('a', 'cmt-vid');
  vid.href = `https://www.youtube.com/watch?v=${encodeURIComponent(c.videoId)}`;
  vid.target = '_blank';
  vid.rel = 'noopener noreferrer';
  if (v?.thumb) {
    const img = el('img', 'cmt-thumb');
    img.src = v.thumb;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    vid.append(img);
  } else vid.append(el('span', 'cmt-thumb cmt-nothumb', '▶'));
  vid.append(el('span', 'cmt-vtitle', v?.title ?? c.videoId));

  const head = el('div', 'cmt-meta');
  head.append(el('b', 'cmt-author', c.author || '(no name)'), el('span', 'cmt-dim', timeAgo(c.at)));
  if (c.edited > c.at + 60_000) head.append(el('span', 'cmt-dim', 'EDITED'));
  if (c.likes) head.append(el('span', 'cmt-dim', `♥ ${c.likes}`));
  if (c.isReply) head.append(el('span', 'cmt-pill', 'REPLY'));
  if (c.own) head.append(el('span', 'cmt-pill', 'YOU'));
  else if (c.answered) head.append(el('span', 'cmt-pill cmt-pill-done', 'ANSWERED'));
  else head.append(el('span', 'cmt-pill cmt-pill-open', 'UNANSWERED'));
  if (!c.read && !c.own) head.append(el('span', 'cmt-pill cmt-pill-new', 'NEW'));

  const text = el('p', 'cmt-text', c.text);
  const acts = el('div', 'cmt-acts');
  acts.append(link('OPEN ON YOUTUBE', c.url, 'cmt-link cmt-btnlink'));
  if (!c.own) {
    acts.append(button(c.read ? 'UNREAD' : 'READ', () => void mark([c.id], { read: !c.read })));
    acts.append(button(c.hidden ? 'UNHIDE' : 'HIDE', () => void mark([c.id], { hidden: !c.hidden })));
    const rb = button('REPLY', () => {
      openReply.add(c.id);
      body.append(replyBox(c));
      rb.remove();
      if (!c.read) void mark([c.id], { read: true }, false);
    }, 'primary');
    if (!openReply.has(c.id) && !c.draft) acts.append(rb);
  }

  const body = el('div', 'cmt-body');
  body.append(head, text, acts);
  if (!c.own && (openReply.has(c.id) || c.draft)) body.append(replyBox(c));
  box.append(vid, body);
  return box;
}

function replyBox(c: CommentView): HTMLElement {
  const box = el('div', 'cmt-reply');
  const ta = el('textarea', 'cmt-input');
  ta.rows = 3;
  ta.maxLength = REPLY_MAX_CHARS;
  ta.placeholder = 'Your reply. DRAFT writes one in your voice; edit it here.';
  ta.value = c.draft;
  ta.setAttribute('aria-label', `Reply to ${c.author}`);
  const count = el('span', 'cmt-dim cmt-count');
  const by = el('span', 'cmt-dim');
  const upd = () => {
    count.textContent = `${ta.value.length}`;
    sendBtn.disabled = !ta.value.trim() || busy.has(c.id);
  };
  let saved = c.draft;
  const save = () => {
    if (ta.value === saved) return;
    saved = ta.value;
    void api('draft/save', { id: c.id, text: ta.value }).catch(() => {});
  };
  ta.oninput = upd;
  ta.onblur = save;
  ta.onkeydown = (e) => e.stopPropagation();
  const draftBtn = button(c.draft ? 'DRAFT AGAIN' : 'DRAFT', async () => {
    if (ta.value.trim() && ta.value !== saved && !(await confirmBox('REPLACE YOUR TEXT?', 'DRAFT writes a new reply over what is in the box.', 'REPLACE'))) return;
    busy.add(c.id);
    draftBtn.disabled = true;
    draftBtn.textContent = 'DRAFTING…';
    upd();
    try {
      const d = await api<{ text: string; by: string }>('draft', { id: c.id });
      ta.value = d.text;
      saved = d.text;
      by.textContent = `DRAFT BY ${d.by.toUpperCase()}. CHECK IT BEFORE YOU SEND.`;
      ta.focus();
    } catch (e) {
      fail(e);
    }
    busy.delete(c.id);
    draftBtn.disabled = false;
    draftBtn.textContent = 'DRAFT AGAIN';
    upd();
  });
  draftBtn.title = 'A short reply in your voice (local model or Haiku). Nothing is sent.';
  const sendBtn = button('SEND', () => void send(c, ta, sendBtn), 'primary');
  sendBtn.title = 'Post this one reply on YouTube (asks first)';
  const close = button('CLOSE', () => {
    save();
    openReply.delete(c.id);
    listKey = '';
    renderInbox();
  });
  const row = el('div', 'cmt-row');
  row.append(draftBtn, sendBtn, close, count, by);
  box.append(ta, row);
  upd();
  return box;
}

async function send(c: CommentView, ta: HTMLTextAreaElement, btn: HTMLButtonElement): Promise<void> {
  const text = ta.value.trim();
  if (!text) return;
  const dash = /[—–]/.test(text) ? ' It has a long dash (— or –) in it.' : '';
  const ok = await confirmBox('POST THIS REPLY ON YOUTUBE?', `To ${c.author}: "${text.length > 300 ? `${text.slice(0, 299)}…` : text}"${dash} It shows on YouTube right away.`, 'SEND');
  if (!ok) return;
  busy.add(c.id);
  btn.disabled = true;
  btn.textContent = 'SENDING…';
  try {
    await api('reply', { id: c.id, text });
    toast('Reply posted on YouTube.', 3000);
    openReply.delete(c.id);
    listKey = '';
    await refresh();
  } catch (e) {
    fail(e);
    btn.textContent = 'SEND';
  }
  busy.delete(c.id);
  btn.disabled = false;
}

async function mark(ids: string[], p: { read?: boolean; hidden?: boolean }, redraw = true): Promise<void> {
  if (!ids.length) return;
  try {
    await api('mark', { ids, ...p });
    if (redraw) await refresh();
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------ stats

async function loadStats(fresh = false): Promise<void> {
  if (!data?.status.signedIn && !isDemo()) return void statsBox.replaceChildren(el('p', 'cmt-empty', 'SIGN IN FIRST (SETUP).'));
  if (!statsBox.childElementCount || fresh) statsBox.replaceChildren(el('p', 'cmt-empty', 'LOADING…'));
  try {
    renderStats(await api<ChannelStats>(`stats${fresh ? '?fresh=1' : ''}`));
  } catch (e) {
    statsBox.replaceChildren(el('p', 'cmt-err', e instanceof Error ? e.message : String(e)));
  }
}

function renderStats(s: ChannelStats): void {
  const tiles = el('div', 'cmt-tiles');
  const tile = (label: string, value: string) => {
    const t = el('div', 'cmt-tile');
    t.append(el('b', '', value), el('span', '', label));
    return t;
  };
  tiles.append(tile('SUBSCRIBERS', s.subscribers === null ? 'HIDDEN' : fmtNum(s.subscribers)), tile('VIEWS', fmtNum(s.views)), tile('VIDEOS', fmtNum(s.videoCount)));
  const wrap = el('div', 'cmt-table-wrap');
  const t = el('table', 'cmt-table');
  const h = el('tr');
  for (const [label, cls] of [['VIDEO', ''], ['VIEWS', 'cmt-num'], ['LIKES', 'cmt-num'], ['COMMENTS', 'cmt-num'], ['OUT', 'cmt-num']]) h.append(el('th', cls, label));
  const thead = el('thead');
  thead.append(h);
  const tb = el('tbody');
  for (const v of s.videos) {
    const tr = el('tr');
    const title = el('td', 'cmt-stitle');
    title.append(link(v.title, `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`));
    const cell = (text: string, l: string) => {
      const c = el('td', 'cmt-num', text);
      c.dataset.l = l;
      return c;
    };
    const comments = cell(fmtNum(v.comments), 'COMMENTS');
    comments.classList.add('cmt-click');
    comments.title = 'Show this video\'s comments';
    comments.onclick = () => {
      videoFilter = v.id;
      filter = 'all';
      view = 'inbox';
      listKey = '';
      showView();
      void refresh();
    };
    tr.append(title, cell(fmtNum(v.views), 'VIEWS'), cell(fmtNum(v.likes), 'LIKES'), comments, cell(v.at ? timeAgo(v.at) : '-', 'OUT'));
    tb.append(tr);
  }
  t.append(thead, tb);
  wrap.append(t);
  const row = el('div', 'cmt-row');
  row.append(el('span', 'cmt-dim', `NUMBERS FROM ${timeAgo(s.at).toUpperCase()}. 3 QUOTA UNITS A REFRESH.`), button('REFRESH', () => void loadStats(true)));
  statsBox.replaceChildren(tiles, row, wrap, el('p', 'cmt-note', 'Watch time, impressions and traffic sources need the YouTube Analytics API (a second sign-in scope). Not in this version.'));
}

// ------------------------------------------------------------ setup

function renderSetup(): void {
  const s = data?.status;
  if (!s) return void setupBox.replaceChildren(el('p', 'cmt-empty', 'LOADING…'));
  const parts: HTMLElement[] = [];
  const sec = (title: string, ...kids: (Node | string)[]) => {
    const b = el('section', 'cmt-sec');
    b.append(el('h3', '', title), ...kids);
    parts.push(b);
  };

  if (!s.configured) {
    sec('1. GOOGLE CLIENT', el('p', 'cmt-note', 'Add PHOSPHOR_YOUTUBE_CLIENT_ID and PHOSPHOR_YOUTUBE_CLIENT_SECRET to .env, then restart the server. The steps are in docs/COMMENTS.md (Google Cloud project, YouTube Data API, consent screen, a Desktop app client).'));
  } else {
    const lines = el('div', 'cmt-lines');
    lines.append(
      el('div', s.signedIn ? 'cmt-ok' : 'cmt-err', s.signedIn ? `SIGNED IN${s.channel ? `: ${s.channel.title}` : ''}` : 'NOT SIGNED IN'),
      ...(s.needsSignIn ? [el('div', 'cmt-err', s.needsSignIn)] : []),
      ...(s.lastError ? [el('div', 'cmt-err', `LAST CHECK: ${s.lastError}`)] : []),
    );
    const signIn = button(s.signedIn ? 'SIGN IN AGAIN' : 'SIGN IN WITH GOOGLE', () => void startSignIn(), 'primary');
    const signOut = button('SIGN OUT', async () => {
      if (!(await confirmBox('SIGN OUT OF YOUTUBE?', 'Checks and replies stop until you sign in again. The comments already here stay.', 'SIGN OUT'))) return;
      try {
        await api('auth/signout', {});
        await refresh();
        renderSetup();
      } catch (e) {
        fail(e);
      }
    });
    signOut.hidden = !s.signedIn;
    const row = el('div', 'cmt-row');
    row.append(signIn, signOut);
    const paste = el('input', 'cmt-paste');
    paste.placeholder = 'http://127.0.0.1:…/api/comments/auth/callback?state=…&code=…';
    paste.setAttribute('aria-label', 'Address the sign-in ended on');
    paste.onkeydown = (e) => e.stopPropagation();
    const finish = button('FINISH', async () => {
      try {
        await api('auth/finish', { url: paste.value });
        toast('Signed in. The first check runs in a moment.', 4000);
        await refresh();
        renderSetup();
      } catch (e) {
        fail(e);
      }
    });
    const prow = el('div', 'cmt-row');
    prow.append(paste, finish);
    sec(
      'SIGN-IN',
      lines,
      row,
      el('p', 'cmt-note', 'Do the sign-in on this PC: Google sends the browser back to 127.0.0.1, which only this PC can open. Google may warn that the app is not verified: it is your own app, pick Advanced, then Go to it. On a phone the last page will not load; copy its address and paste it here:'),
      prow,
    );
  }

  const every = el('select', 'cmt-every');
  every.setAttribute('aria-label', 'Check every');
  for (const m of [5, 10, 15, 30, 60, 120, 240]) every.append(new Option(m < 60 ? `${m} MIN` : `${m / 60} H`, String(m), false, m === s.everyMin));
  if (![5, 10, 15, 30, 60, 120, 240].includes(s.everyMin)) every.append(new Option(`${s.everyMin} MIN`, String(s.everyMin), true, true));
  every.onchange = () => void setSettings({ everyMin: Number(every.value) });
  const alertsOn = button('ON', () => void setSettings({ alerts: true }));
  const alertsOff = button('OFF', () => void setSettings({ alerts: false }));
  alertsOn.classList.toggle('on', s.alerts);
  alertsOff.classList.toggle('on', !s.alerts);
  const seg = el('div', 'seg');
  seg.append(alertsOn, alertsOff);
  const r1 = el('div', 'cmt-row');
  r1.append(el('span', 'cmt-label', 'CHECK EVERY'), every);
  const r2 = el('div', 'cmt-row');
  r2.append(el('span', 'cmt-label', 'ALERT ON NEW'), seg);
  const next = s.nextCheck ? ` Next check in ${Math.max(1, Math.round((s.nextCheck - Date.now()) / 60_000))} min.` : '';
  sec('CHECKS', r1, r2, el('p', 'cmt-note', `Alerts go to this PC's desktop and to phones with ALERTS on (SETTINGS > ALERTS, COMMENTS).${next}`));

  const q = s.quota;
  const qlist = el('ul', 'cmt-quota');
  for (const [m, u] of Object.entries(q.calls).sort((a, b) => b[1] - a[1])) qlist.append(el('li', '', `${m}: ${u}`));
  sec(
    'QUOTA TODAY',
    el('p', '', `${q.units} OF ${q.limit} UNITS (${q.day}, PACIFIC DAY)`),
    qlist,
    el('p', 'cmt-note', `A check costs 1 unit per 100 comment threads (more only when many are new), a reply 50. Checks pause at 8,000 so replies still go.`),
  );
  setupBox.replaceChildren(...parts);
}

// Google's page opens in a new tab (the desktop app hands it to the normal browser). The answer comes back to the
// server, which then checks right away; this screen shows it at its next refresh.
async function startSignIn(): Promise<void> {
  try {
    const { url } = await api<{ url: string }>('auth/start');
    if (isDemo()) return void toast('Demo: no sign-in.');
    const w = window.open(url, '_blank');
    if (w) w.opener = null;
    else location.href = url;
  } catch (e) {
    fail(e);
  }
}

async function setSettings(p: { everyMin?: number; alerts?: boolean }): Promise<void> {
  try {
    const s = await api<CommentsStatus>('settings', p);
    if (data) data.status = s;
    renderSetup();
  } catch (e) {
    fail(e);
  }
}
