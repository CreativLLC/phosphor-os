import { cacheOf, compressButton, contextGauge, watchCache } from './context.ts';
import type { Mission, TabState } from '../../shared/protocol.ts';
import { routerCard } from './routercard.ts';
import { store, watchActive } from './store.ts';
import { button, el, folderName, shortPath } from './ui.ts';
import { usageGauge, usagePanel } from './usage.ts';

// HUD (owner: HUD team).
// mountProgress: the segmented progress bar between the chat log and the message box.
// mountMission: the MISSION readout in the right column (task, now, steps, stats).
// Data: tab.mission (Claude's update_mission tool or its TodoWrite list), tab.activity,
// tab.stats, tab.meta, tab.agents, tab.info. Percent = completed steps / total steps.
// Everything is built once and then updated in place; the turn timer is the only thing
// that ticks, once a second, and only while Claude is working.

const BAR_SEGS = 25; // 4% per segment
const CTX_SEGS = 20;
const NARROW = '(max-width: 820px)';

const MODE_LABELS: Record<string, string> = {
  default: 'ASK FIRST',
  acceptEdits: 'AUTO-EDIT',
  plan: 'PLAN ONLY',
  auto: 'AUTO',
};

type Progress = {
  total: number;
  done: number;
  pct: number;
  cur: number; // index of the current step (in progress, else first not done), -1 when all done
  working: boolean; // a step is marked in_progress
};

function progressOf(m: Mission | null | undefined): Progress | null {
  const steps = m?.steps ?? [];
  if (!steps.length) return null;
  const done = steps.filter((s) => s.status === 'completed').length;
  const inProg = steps.findIndex((s) => s.status === 'in_progress');
  const cur = inProg >= 0 ? inProg : steps.findIndex((s) => s.status !== 'completed');
  let pct = Math.round((done / steps.length) * 100);
  if (done < steps.length) pct = Math.min(pct, 99);
  return { total: steps.length, done, pct, cur, working: inProg >= 0 };
}

// What the user is being asked, for the attention state.
function waitingFor(tab: TabState): string {
  for (let i = tab.items.length - 1; i >= 0; i--) {
    const it = tab.items[i];
    if (it.kind === 'perm' && it.status === 'pending') return it.title;
    if (it.kind === 'ask' && it.status === 'pending') return it.questions[0]?.question || 'Claude has a question for you.';
  }
  return 'Check the chat.';
}

// mm:ss, or h:mm:ss past an hour.
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function kTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// A row of LED segments. set(on, cur): `on` lit, then `cur` pulsing (the step in progress).
type SegBar = { root: HTMLElement; set(on: number, cur?: number): void };

function segBar(n: number, cls: string): SegBar {
  const root = el('div', `seg-bar ${cls}`);
  const segs: HTMLElement[] = [];
  for (let i = 0; i < n; i++) {
    const s = el('i', 'seg');
    s.style.setProperty('--i', String(i));
    segs.push(s);
  }
  root.append(...segs);
  return {
    root,
    set(on, cur = 0) {
      segs.forEach((s, i) => {
        s.classList.toggle('on', i < on);
        s.classList.toggle('cur', i >= on && i < on + cur);
      });
    },
  };
}

// Lit and pulsing segment counts for a step list.
function fill(p: Progress, n: number): [number, number] {
  const on = Math.round((p.done / p.total) * n);
  if (!p.working) return [on, 0];
  const next = Math.round(((p.done + 1) / p.total) * n);
  return [on, Math.max(1, next - on)];
}

// Show the MISSION view; on a folded phone, slide the right panel in.
function openMissionPanel(): void {
  const tabBtn = document.querySelector<HTMLButtonElement>('.panel-switch button[data-view="mission"]');
  if (tabBtn && !tabBtn.classList.contains('on')) tabBtn.click();
  if (matchMedia(NARROW).matches) document.body.classList.add('show-right');
}

// ---------------------------------------------------------------- progress bar

export function mountProgress(root: HTMLElement): void {
  const pct = el('span', 'pg-pct');
  const bar = segBar(BAR_SEGS, 'pg-bar');
  bar.root.setAttribute('role', 'progressbar');
  bar.root.setAttribute('aria-valuemin', '0');
  bar.root.setAttribute('aria-valuemax', '100');
  const tag = el('span', 'pg-tag');
  const time = el('span', 'pg-time');
  const msg = el('span', 'pg-msg');
  const text = el('div', 'pg-text');
  text.append(tag, time, msg);
  // Turn timer, ticking only while Claude works.
  let tick = 0;
  const showTime = (since: number | null) => {
    time.textContent = since ? fmtClock(Date.now() - since) : '';
  };
  const box = el('div', 'pg');
  box.append(pct, bar.root, text, usageGauge(root), contextGauge(root));
  root.replaceChildren(box);
  root.dataset.state = 'off';

  const open = (e: Event) => {
    // main.ts closes the side panels on any click in #app; keep this one.
    e.stopPropagation();
    if (root.dataset.state !== 'off') openMissionPanel();
  };
  root.addEventListener('click', open);
  root.tabIndex = 0;
  root.setAttribute('role', 'button');
  root.title = 'Show task details';
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(e);
    }
  });

  const render = (tab: TabState | undefined) => {
    const p = progressOf(tab?.mission);
    const busy = !!tab?.meta.busy;
    // Helpers (subagents) can keep working after Claude's turn ends: then the row says CREW WORKING, not YOUR TURN.
    const crew = (tab?.agents ?? []).filter((a) => a.status === 'running');
    let state: string;
    if (!tab) state = 'off';
    else if (tab.meta.attention) state = 'attn';
    else if (!busy && crew.length) state = 'crew';
    else if (p && p.done === p.total) state = 'done';
    else if (p) state = busy ? 'steps' : 'paused';
    else state = busy ? 'busy' : 'standby';
    root.dataset.state = state;
    root.dataset.steps = p ? '1' : '0';
    // LIVE = Claude is working right now: the row lights up (see mission.css "LIVE").
    const live = (busy && state !== 'attn') || state === 'crew';
    root.classList.toggle('live', live);
    clearInterval(tick);
    const since = live ? (tab?.stats.turnStartedAt ?? null) : null;
    showTime(since);
    if (since) tick = window.setInterval(() => showTime(since), 1000);

    if (p) {
      const [on, cur] = fill(p, BAR_SEGS);
      bar.set(on, state === 'paused' ? 0 : cur);
      bar.root.setAttribute('aria-valuenow', String(p.pct));
      pct.textContent = `${p.pct}%`;
    } else {
      bar.set(0);
      bar.root.removeAttribute('aria-valuenow');
      pct.textContent = state === 'attn' ? '!!' : '';
    }

    const steps = tab?.mission?.steps ?? [];
    const stepLine = p && p.cur >= 0 ? steps[p.cur].label : '';
    const stepNo = p && p.cur >= 0 ? `${p.cur + 1}/${p.total}` : '';
    switch (state) {
      case 'attn':
        tag.textContent = 'AWAITING YOUR OK';
        msg.textContent = waitingFor(tab!);
        break;
      case 'done':
        tag.textContent = 'COMPLETE';
        msg.textContent = tab!.mission!.title;
        break;
      case 'steps':
        tag.textContent = `STEP ${stepNo}`;
        msg.textContent = stepLine;
        break;
      case 'crew':
        tag.textContent = `CREW WORKING (${crew.length})`;
        msg.textContent = crew[0].description;
        break;
      case 'paused':
        tag.textContent = `YOUR TURN ${stepNo}`;
        msg.textContent = stepLine;
        break;
      case 'busy':
        tag.textContent = /^thinking/i.test(tab!.activity) ? 'THINKING' : 'WORKING';
        msg.textContent = tab!.activity;
        break;
      case 'standby':
        tag.textContent = 'YOUR TURN';
        msg.textContent = '';
        break;
      default:
        tag.textContent = '';
        msg.textContent = '';
    }
    msg.hidden = !msg.textContent;
    root.setAttribute('aria-label', [pct.textContent, tag.textContent, msg.textContent].filter(Boolean).join(' '));
  };
  watchActive(['mission', 'meta', 'activity', 'agents'], render);
  onPrompt(render);
}

// Re-run render when a permission or question card appears or is answered on the active tab
// (the attention line quotes it).
function onPrompt(render: (tab: TabState | undefined) => void): void {
  store.on((c) => {
    if (c.kind === 'item' && c.tab === store.active && (c.item.kind === 'perm' || c.item.kind === 'ask')) render(store.current());
  });
}

// ---------------------------------------------------------------- mission panel

function head(label: string): { h: HTMLElement; extra: HTMLElement } {
  const h = el('h3', 'ms-h');
  const extra = el('span', 'ms-h-extra');
  h.append(el('span', 'ms-h-label', label), extra);
  return { h, extra };
}

function section(label: string, ...body: HTMLElement[]): { sec: HTMLElement; extra: HTMLElement } {
  const { h, extra } = head(label);
  const sec = el('section', 'ms-sec');
  sec.append(h, ...body);
  return { sec, extra };
}

// "LABEL ........ value" readout row.
function row(label: string, ...val: HTMLElement[]): { row: HTMLElement; key: HTMLElement; val: HTMLElement } {
  const r = el('div', 'ms-row');
  const key = el('span', 'ms-k', label);
  const v = el('span', 'ms-v');
  v.append(...val);
  r.append(key, v);
  return { row: r, key, val: v };
}

// Claude Code's connector states, as the panel words them ('' = known only from the saved chat).
const CONN_STATE: Record<string, string> = { connected: 'ON', failed: 'FAILED', 'needs-auth': 'SIGN IN', pending: 'STARTING', disabled: 'OFF', '': '' };

let showFiles = false;
let ticker = 0;

export function mountMission(root: HTMLElement): void {
  const noTab = el('div', 'ms-none', 'NO CHAT OPEN.');

  // TASK + SUMMARY
  const title = el('div', 'ms-title');
  const empty = el('div', 'ms-empty');
  empty.append(el('div', 'ms-empty-1', 'NO MISSION LOADED.'), el('div', 'ms-empty-2', 'Claude fills this in on bigger tasks.'));
  const task = section('TASK', title, empty);
  const summary = el('p', 'ms-sum');
  const sum = section('SUMMARY', summary);

  // NOW
  const alert = el('div', 'ms-alert', 'AWAITING YOUR OK');
  const nowText = el('span', 'ms-now-text');
  const cursor = el('span', 'ms-cursor');
  cursor.setAttribute('aria-hidden', 'true');
  const nowLine = el('div', 'ms-now');
  nowLine.append(nowText, cursor);
  const now = section('NOW', alert, nowLine);

  // STEPS
  const list = el('ol', 'ms-steps');
  const steps = section('STEPS', list);

  // CONNECTORS: the MCP servers this chat has, their state, and how often it used each (most used first).
  const connList = el('div', 'ms-stats ms-conn');
  const conn = section('CONNECTORS', connList);

  // STATS
  const timeVal = el('span', 'ms-time');
  const time = row('TURN TIME', timeVal);
  const turns = row('TURNS');
  const tools = row('TOOL CALLS');
  const filesCount = el('span');
  const filesBtn = button('', () => {
    showFiles = !showFiles;
    renderStats(store.current());
  }, 'ms-toggle');
  const files = row('FILES CHANGED', filesCount, filesBtn);
  const fileList = el('ul', 'ms-files');
  const ctxBar = segBar(CTX_SEGS, 'ms-ctx-bar');
  const ctxPct = el('span', 'ms-ctx-pct');
  const ctx = row('CONTEXT', ctxBar.root, ctxPct);
  ctx.row.classList.add('ms-ctx');
  const ctxSub = el('div', 'ms-sub');
  const ctxMore = el('div', 'ms-sub ms-ctx-more');
  ctxMore.append(ctxSub, compressButton());
  const cache = row('CACHE');
  cache.row.classList.add('ms-cache');
  const agents = row('AGENTS');
  const model = row('MODEL');
  const thinking = row('THINKING');
  const mode = row('MODE');
  const folder = row('FOLDER');
  const grid = el('div', 'ms-stats');
  grid.append(time.row, turns.row, tools.row, files.row, fileList, ctx.row, ctxMore, cache.row, agents.row, model.row, thinking.row, mode.row, folder.row);
  const stats = section('STATS', grid);

  const wrap = el('div', 'ms');
  wrap.append(usagePanel(), noTab, task.sec, sum.sec, now.sec, steps.sec, conn.sec, routerCard(), stats.sec);
  root.replaceChildren(wrap);

  const showTab = (tab: TabState | undefined) => {
    noTab.hidden = !!tab;
    for (const s of [task.sec, now.sec, stats.sec]) s.hidden = !tab;
  };

  // Task, summary, steps: only when the mission changes.
  watchActive(['mission'], (tab) => {
    showTab(tab);
    const m = tab?.mission;
    title.textContent = m?.title ?? '';
    title.hidden = !m?.title;
    empty.hidden = !!m;
    summary.textContent = m?.summary ?? '';
    sum.sec.hidden = !m?.summary;

    const p = progressOf(m);
    steps.sec.hidden = !p;
    if (!p || !m) {
      list.replaceChildren();
      return;
    }
    steps.extra.textContent = p.done === p.total ? `${p.total}/${p.total} DONE` : `${p.done}/${p.total}  ${p.pct}%`;
    list.replaceChildren(
      ...m.steps.map((s, i) => {
        const done = s.status === 'completed';
        const cur = i === p.cur && s.status === 'in_progress';
        const li = el('li', `ms-step ${done ? 'done' : cur ? 'cur' : 'todo'}`);
        li.append(el('span', 'mk', done ? '[x]' : cur ? '[>]' : '[ ]'), el('span', 'lb', s.label));
        return li;
      }),
    );
  });

  // NOW: what Claude is doing this second.
  const renderNow = (tab: TabState | undefined) => {
    if (!tab) return;
    const attn = tab.meta.attention;
    const busy = tab.meta.busy;
    alert.hidden = !attn;
    now.sec.dataset.state = attn ? 'attn' : busy ? 'busy' : 'idle';
    nowText.textContent = attn ? waitingFor(tab) : busy ? tab.activity || 'Working' : 'IDLE';
    cursor.hidden = !busy || attn;
  };
  watchActive(['activity', 'meta'], renderNow);
  onPrompt(renderNow);

  // STATS (and the live turn timer).
  const tick = () => {
    const tab = store.current();
    if (!tab) return;
    const s = tab.stats;
    const live = tab.meta.busy && s.turnStartedAt != null;
    timeVal.textContent = live ? clock(Date.now() - s.turnStartedAt!) : s.lastTurnMs ? clock(s.lastTurnMs) : '--:--';
  };

  function renderStats(tab: TabState | undefined): void {
    const live = !!tab && tab.meta.busy && tab.stats.turnStartedAt != null;
    if (live && !ticker) ticker = window.setInterval(tick, 1000);
    if (!live && ticker) {
      clearInterval(ticker);
      ticker = 0;
    }
    if (!tab) return;
    const s = tab.stats;

    time.key.textContent = live ? 'TURN TIME' : 'LAST TURN';
    time.row.classList.toggle('live', live);
    tick();
    turns.val.textContent = String(s.turns);
    tools.val.textContent = String(s.toolCalls);

    const n = s.filesChanged.length;
    filesCount.textContent = String(n);
    filesBtn.hidden = !n;
    filesBtn.textContent = showFiles ? '[HIDE]' : '[SHOW]';
    filesBtn.setAttribute('aria-expanded', String(showFiles));
    fileList.hidden = !n || !showFiles;
    if (n && showFiles) {
      fileList.replaceChildren(
        ...s.filesChanged.map((f) => {
          const rel = shortPath(f, tab.info.cwd);
          const cut = rel.lastIndexOf('/') + 1;
          const li = el('li');
          li.title = f;
          li.append(el('span', 'dir', rel.slice(0, cut)), el('span', 'base', rel.slice(cut)));
          return li;
        }),
      );
    } else fileList.replaceChildren();

    const win = s.contextWindow;
    const used = s.contextTokens;
    if (win > 0) {
      const pc = Math.min(100, Math.round((used / win) * 100));
      ctxBar.set(Math.round((pc / 100) * CTX_SEGS));
      ctxBar.root.hidden = false;
      ctxPct.textContent = `${pc}%`;
      ctxSub.textContent = `${kTokens(used)} OF ${kTokens(win)} TOKENS`;
      ctx.row.classList.toggle('hot', pc >= 80);
    } else {
      ctxBar.root.hidden = true;
      ctxPct.textContent = used ? `${kTokens(used)} TOKENS` : '--';
      ctxSub.textContent = '';
      ctx.row.classList.remove('hot');
    }
    ctxSub.hidden = !ctxSub.textContent;

    const running = tab.agents.filter((a) => a.status === 'running').length;
    const total = tab.agents.length;
    agents.val.textContent = total ? `${running} RUNNING / ${total}` : 'NONE';
    agents.row.classList.toggle('live', running > 0);

    model.val.textContent = tab.info.model || '--';
    thinking.val.textContent = (tab.info.effort || 'default').toUpperCase();
    mode.val.textContent = MODE_LABELS[tab.info.permissionMode] ?? (tab.info.permissionMode.toUpperCase() || '--');
    folder.val.textContent = folderName(tab.info.cwd);
    folder.val.title = tab.info.cwd;
  }

  watchActive(['stats', 'agents', 'info', 'meta'], renderStats);

  watchActive(['stats'], (tab) => {
    const list = [...(tab?.stats.connectors ?? [])].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
    conn.sec.hidden = !list.length;
    const used = list.filter((c) => c.calls).length;
    conn.extra.textContent = used ? `${used} USED` : 'NONE USED';
    connList.replaceChildren(
      ...list.map((c) => {
        const r = row(c.name.replace(/^claude\.ai /, ''));
        const state = CONN_STATE[c.status] ?? c.status.toUpperCase();
        r.val.textContent = [c.calls ? `${c.calls} ${c.calls === 1 ? 'CALL' : 'CALLS'}` : '', state].filter(Boolean).join(' · ');
        r.row.classList.toggle('used', c.calls > 0);
        r.row.classList.toggle('bad', c.status === 'failed' || c.status === 'needs-auth');
        r.row.title = `${c.name}: ${c.status || 'not started yet in this chat'}`;
        return r.row;
      }),
    );
  });
  watchCache((tab) => {
    const c = cacheOf(tab);
    cache.row.hidden = !c;
    cache.val.textContent = c?.line ?? '';
    cache.row.title = c?.tip ?? '';
    cache.row.classList.toggle('cold', c?.left === 0);
    cache.row.classList.toggle('ending', !!c?.ending);
  });
}

// 75000 -> "01:15"
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
