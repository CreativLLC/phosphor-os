import type { UsageResponse, UsageShare, UsageWindow } from '../../shared/protocol.ts';
import { store } from './store.ts';
import { button, el } from './ui.ts';

// PLAN USAGE: how much of the claude.ai plan this account has used (every device and app), from GET /api/usage.
// usageGauge: "5H ▮▮▯▯▯ 29%" left of CTX in the progress row; it shows the week instead once the week is
// at 80% or more and higher than the 5-hour window. Tap: the USAGE drawer (mountUsage) with every window and
// what used it on this PC. Refresh: every 5 minutes while the page is visible, on coming back into view, and
// after Claude finishes a turn. The server caches 60 s, so Claude is never asked more than once a minute.

const SEGS = 5;
const BAR_SEGS = 20;
const HOT = 80;
const EVERY_MS = 5 * 60_000;
const AFTER_TURN_MS = 3000;
// GAME MODE (gamemode.ts): check six times less often, and not after each turn.
const gaming = () => document.documentElement.dataset.game === 'on';
const every = () => (gaming() ? 6 : 1) * EVERY_MS;

const TRAITS: Record<string, string> = {
  long_context: 'Long chats (big context)',
  cache_miss: 'Whole chat re-read (cache missed)',
  subagent_heavy: 'Work done by agents',
  high_parallel: 'Many things at once',
  cron: 'Scheduled or repeating tasks',
};
const KINDS: Record<UsageShare['kind'], string> = { trait: '', agent: 'Agent', skill: 'Skill', plugin: 'Plugin', mcp: 'MCP' };

let data: UsageResponse | null = null;
let fetchedAt = 0;
let loading = false;
let queued: boolean | null = null; // a check asked for while one was running (true = with details)
let timer: ReturnType<typeof setTimeout> | undefined;
let drawer: HTMLElement | undefined;
let body: HTMLElement;
const renders = new Set<() => void>();

const show = () => renders.forEach((r) => r());
const pctOf = (w: UsageWindow) => Math.min(100, Math.round(w.pct));

// ---------------------------------------------------------------- times (owner's local time)

// Minutes rounded: the server says 8:59:59.8, people read 9:00.
const roundMin = (ms: number) => Math.round(ms / 60_000) * 60_000;
const clockAt = (ms: number) => new Date(roundMin(ms)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// "Mon 2:00 AM", "12:20 PM" today, "Nov 5, 1:00 AM" past a week.
function whenAt(ms: number): string {
  const d = new Date(roundMin(ms));
  if (d.toDateString() === new Date().toDateString()) return clockAt(ms);
  if (ms - Date.now() < 6 * 86_400_000) return `${d.toLocaleDateString([], { weekday: 'short' })} ${clockAt(ms)}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${clockAt(ms)}`;
}

// 8040000 -> "2h 14m"; past a day "3d 4h".
function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

// "Resets in 2h 14m (12:20 PM)", or day first for the long windows: "Resets Mon 2:00 AM (in 15h 38m)".
function resetLine(at: number | null, dayFirst = false): string {
  if (!at) return 'Reset time not known';
  const left = at - Date.now();
  if (left <= 0) return 'Resets now; the numbers update on the next check';
  return dayFirst ? `Resets ${whenAt(at)} (in ${span(left)})` : `Resets in ${span(left)} (${whenAt(at)})`;
}

// ---------------------------------------------------------------- loading

async function load(details: boolean, fresh = false): Promise<void> {
  if (store.demo) return;
  if (loading) {
    queued = !!queued || details;
    return;
  }
  loading = true;
  try {
    const r = await fetch(`/api/usage${details ? `?details=1${fresh ? '&fresh=1' : ''}` : ''}`);
    if (r.ok) {
      const next = (await r.json()) as UsageResponse;
      data = { ...next, stats: next.stats !== undefined ? next.stats : data?.stats }; // a gauge-only check keeps the last stats
    } else if (r.status === 404) data = { available: false, plan: null, fiveHour: null, week: null, models: [], extra: null, checkedAt: 0, error: 'The app server has no usage meter yet. It comes with the next server update.' };
  } catch {
    /* app server not reachable: keep the last numbers */
  }
  loading = false;
  fetchedAt = Date.now();
  show();
  schedule();
  if (queued !== null) {
    const d = queued;
    queued = null;
    void load(d);
  }
}

// Next check in 5 minutes, only while the page is visible (no checks in the background).
function schedule(): void {
  clearTimeout(timer);
  if (document.hidden) return;
  timer = setTimeout(() => void load(isOpen()), Math.max(0, fetchedAt + every() - Date.now()));
}

const isOpen = () => !!drawer && !drawer.hidden;

// ---------------------------------------------------------------- gauge (progress row)

// The window to show in the small gauge: the 5 hours, or the week when that is the one about to run out.
function gaugeWindow(u: UsageResponse): { key: string; name: string; w: UsageWindow } | null {
  const five = u.fiveHour;
  const week = u.week;
  if (week && pctOf(week) >= HOT && (!five || week.pct > five.pct)) return { key: 'WK', name: 'this week (all models)', w: week };
  if (five) return { key: '5H', name: '5-hour window', w: five };
  if (week) return { key: 'WK', name: 'this week (all models)', w: week };
  return null;
}

export function usageGauge(progressRoot: HTMLElement): HTMLElement {
  const g = el('button', 'pg-use');
  g.type = 'button';
  const key = el('span', 'pg-use-k', '5H');
  const segs = el('span', 'pg-use-bar');
  const cells = Array.from({ length: SEGS }, () => el('i'));
  segs.append(...cells);
  const label = el('span', 'pg-use-pct');
  g.append(key, segs, label);
  g.hidden = true;
  g.onclick = (e) => {
    e.stopPropagation(); // the progress row itself opens the mission panel
    openUsage();
  };
  renders.add(() => {
    // Hidden until the first answer; then "--" when the numbers are not available.
    g.hidden = !data;
    progressRoot.classList.toggle('has-use', !!data);
    if (!data) return;
    const pick = data.available ? gaugeWindow(data) : null;
    g.classList.toggle('na', !pick);
    if (!pick) {
      key.textContent = '5H';
      cells.forEach((c) => c.classList.remove('on'));
      label.textContent = '--';
      g.classList.remove('hot');
      g.title = `Plan usage not available. ${data.error ?? ''} Tap for details.`.replace(/\s+/g, ' ');
      return;
    }
    const p = pctOf(pick.w);
    key.textContent = pick.key;
    const lit = Math.round((p / 100) * SEGS);
    cells.forEach((c, i) => c.classList.toggle('on', i < lit));
    label.textContent = `${p}%`;
    g.classList.toggle('hot', p >= HOT);
    const week = data.week && pick.key === '5H' ? ` This week: ${pctOf(data.week)}%.` : '';
    g.title = `Plan usage, ${pick.name}: ${p}% used. ${resetLine(pick.w.resetsAt)}.${week} Tap for details.`;
  });
  return g;
}

// ---------------------------------------------------------------- mission panel box

// PLAN USAGE at the top of the mission panel (the right panel; the phone's sidebar on its side):
// the 5-hour window and the week at a glance, with their reset times. Tap: the USAGE drawer.
export function usagePanel(): HTMLElement {
  const sec = el('section', 'ms-sec use-panel');
  sec.hidden = true;
  sec.tabIndex = 0;
  sec.setAttribute('role', 'button');
  sec.title = 'Plan usage for your whole account. Tap for details.';
  sec.onclick = openUsage;
  sec.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openUsage();
    }
  };
  const extra = el('span', 'ms-h-extra');
  const h = el('h3', 'ms-h');
  h.append(el('span', 'ms-h-label', 'PLAN USAGE'), extra);
  const lines = el('div', 'use-lines');
  sec.append(h, lines);
  const line = (label: string, w: UsageWindow, dayFirst: boolean) => {
    const p = pctOf(w);
    const top = el('div', `use-pl${p >= HOT ? ' hot' : ''}`);
    top.append(el('span', 'use-pl-k', label), segBar(p, 12), el('span', 'use-pl-pct', `${p}%`));
    return [top, el('div', 'use-pl-when', resetLine(w.resetsAt, dayFirst))];
  };
  renders.add(() => {
    sec.hidden = !data;
    if (!data) return;
    extra.textContent = data.plan ? data.plan.toUpperCase() : '';
    if (!data.available || (!data.fiveHour && !data.week)) {
      lines.replaceChildren(el('div', 'use-pl-when', 'Not available. Tap for details.'));
      return;
    }
    lines.replaceChildren(...(data.fiveHour ? line('5-HOUR', data.fiveHour, false) : []), ...(data.week ? line('WEEK', data.week, true) : []));
  });
  return sec;
}

// ---------------------------------------------------------------- drawer

export function mountUsage(drawerEl: HTMLElement): void {
  drawer = drawerEl;
  const head = el('div', 'drawer-head');
  const tools = el('div', 'use-head-tools');
  tools.append(button('REFRESH', () => void load(true, true)), button('CLOSE', closeUsage));
  head.append(el('h2', '', 'PLAN USAGE'), tools);
  body = el('div', 'use-body');
  drawer.replaceChildren(head, body);
  drawer.tabIndex = -1; // takes focus when opened
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && !document.querySelector('dialog[open]')) closeUsage();
  });
  // Only one drawer at a time: HISTORY or MCP opening (button or /mcp) closes this one.
  const others = ['history', 'mcp'].map((id) => document.getElementById(id)).filter((d) => d !== null);
  const mo = new MutationObserver(() => {
    if (others.some((d) => !d.hidden)) closeUsage();
  });
  for (const d of others) mo.observe(d, { attributes: true, attributeFilter: ['hidden'] });
  renders.add(() => {
    if (isOpen()) renderDrawer();
  });

  // Visible again after a while: check now if the last check is old, else pick up the 5-minute rhythm.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else if (Date.now() - fetchedAt >= every()) void load(isOpen());
    else schedule();
  });

  // A turn ended in any tab (busy -> idle): check a moment later. Cheap: the server answers from its cache.
  const wasBusy = new Map<string, boolean>();
  let afterTurn: ReturnType<typeof setTimeout> | undefined;
  store.on((c) => {
    if (c.kind !== 'patch' || c.key !== 'meta') return;
    const busy = !!store.tabs.get(c.tab)?.meta.busy;
    if (wasBusy.get(c.tab) && !busy && !document.hidden && !gaming()) {
      clearTimeout(afterTurn);
      afterTurn = setTimeout(() => void load(isOpen()), AFTER_TURN_MS);
    }
    wasBusy.set(c.tab, busy);
  });

  // First check once the page is set up (demo mode is decided after the mounts).
  setTimeout(() => void load(false), 0);
}

export function openUsage(): void {
  if (!drawer) return;
  for (const id of ['history', 'mcp']) {
    const d = document.getElementById(id);
    if (d) d.hidden = true;
  }
  drawer.hidden = false;
  drawer.focus();
  renderDrawer();
  void load(true);
}

function closeUsage(): void {
  if (drawer) drawer.hidden = true;
}

// LED bar like the mission panel's (mission.css .seg-bar). Also used by the SYS panel (system.ts).
export function segBar(pct: number, n = BAR_SEGS): HTMLElement {
  const root = el('div', 'seg-bar use-bar');
  const on = Math.round((Math.min(100, pct) / 100) * n);
  for (let i = 0; i < n; i++) {
    const s = el('i', i < on ? 'seg on' : 'seg');
    s.style.setProperty('--i', String(i));
    root.append(s);
  }
  return root;
}

// "LABEL --------- 29%" heading, as in the mission panel (mission.css .ms-h).
function heading(label: string, extra = ''): HTMLElement {
  const h = el('h3', 'ms-h');
  h.append(el('span', 'ms-h-label', label), el('span', 'ms-h-extra', extra));
  return h;
}

function windowSection(label: string, w: UsageWindow, dayFirst: boolean, note?: string): HTMLElement {
  const p = pctOf(w);
  const sec = el('section', `use-sec${p >= HOT ? ' hot' : ''}`);
  sec.append(heading(label, `${p}% USED`), segBar(p), el('div', 'use-when', resetLine(w.resetsAt, dayFirst)));
  if (note) sec.append(el('div', 'use-when', note));
  return sec;
}

const money = (n: number, cur: string) => (cur === 'USD' ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${cur}`);
const num = (n: number) => n.toLocaleString();

function renderDrawer(): void {
  const u = data;
  const out: HTMLElement[] = [];
  if (!u) {
    body.replaceChildren(el('div', 'empty', loading ? 'Asking Claude…' : 'No numbers yet. Press REFRESH.'));
    return;
  }

  const top = el('div', 'use-plan');
  top.append(el('span', '', `PLAN: ${(u.plan ?? 'unknown').toUpperCase()}`), el('span', '', u.checkedAt ? `CHECKED ${clockAt(u.checkedAt)}` : ''));
  out.push(top);
  if (!u.available) out.push(el('p', 'use-error', `Usage not available. ${u.error ?? ''}`.trim()));
  else if (u.error) out.push(el('p', 'use-error', `Could not refresh, showing the last numbers. ${u.error}`));

  if (u.available) {
    out.push(el('p', 'use-note', 'Your whole account: this PC, the phone, claude.ai and any other device.'));
    if (u.fiveHour) out.push(windowSection('5-HOUR WINDOW', u.fiveHour, false));
    if (u.week) out.push(windowSection('WEEK, ALL MODELS', u.week, true));
    for (const m of u.models) out.push(windowSection(`WEEK, ${m.name.toUpperCase()} ONLY`, m, true));
    if (u.extra) {
      const x = u.extra;
      const sec = el('section', 'use-sec');
      const spent = x.used !== null ? (x.limit !== null ? `${money(x.used, x.currency)} of ${money(x.limit, x.currency)} spent this month.` : `${money(x.used, x.currency)} spent this month, no limit set.`) : 'Turned on.';
      sec.append(heading('EXTRA USAGE', x.pct !== null ? `${Math.round(x.pct)}% USED` : 'ON'));
      if (x.pct !== null) sec.append(segBar(x.pct));
      sec.append(el('div', 'use-when', `${spent} Paid use past the plan limits.`));
      out.push(sec);
    }
  }

  out.push(statsSection(u));
  body.replaceChildren(...out);
}

// Counts from Claude Code's saved chats on this PC (the /usage screen's "what's contributing").
function statsSection(u: UsageResponse): HTMLElement {
  const sec = el('section', 'use-sec');
  sec.append(heading('ON THIS PC'));
  const s = u.stats;
  if (s === undefined) {
    sec.append(el('div', 'empty', loading ? 'Counting…' : 'Press REFRESH to count.'));
    return sec;
  }
  if (!s) {
    sec.append(el('div', 'empty', 'Not available.'));
    return sec;
  }
  const t = el('div', 'use-table');
  const cell = (text: string, cls = '') => el('span', cls, text);
  t.append(cell(''), cell('24 H', 'th num'), cell('7 DAYS', 'th num'));
  t.append(cell('Requests to Claude'), cell(num(s.day.requests), 'num'), cell(num(s.week.requests), 'num'));
  t.append(cell('Chats'), cell(num(s.day.sessions), 'num'), cell(num(s.week.sessions), 'num'));
  sec.append(t);
  if (s.shares.length) {
    sec.append(el('div', 'use-sub', 'SHARE OF USE (rows can overlap)'));
    const sh = el('div', 'use-table');
    for (const r of s.shares) {
      const name = r.kind === 'trait' ? (TRAITS[r.name] ?? r.name.replaceAll('_', ' ')) : `${KINDS[r.kind]}: ${r.name}`;
      const n = cell(name, 'use-name');
      n.title = name;
      sh.append(n, cell(`${r.day}%`, 'num'), cell(`${r.week}%`, 'num'));
    }
    sec.append(sh);
  }
  sec.append(el('p', 'use-note', 'Counted from the chats saved on this PC. Use on the phone app, claude.ai or other computers is not in these counts.'));
  return sec;
}
