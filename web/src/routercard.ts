import type { DelegateCount, RouterResponse, TabState } from '../../shared/protocol.ts';
import { demoRouter } from './demo.ts';
import { store, watchActive } from './store.ts';
import { el } from './ui.ts';

// ROUTER card in the mission panel (server/delegate.ts, docs/ROUTER-PLAN.md): the jobs this chat handed to the local
// model (ask_local) and the Claude tokens that kept off, the same for every chat, and which worker runs each thread of
// a project lead. Hidden when no local model is set up. The totals come from GET /api/router, asked again when the
// chat changes, when its own count moves, and when the page comes back into view.

const kTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const calls = (n: number) => `${n} ${n === 1 ? 'CALL' : 'CALLS'}`;
const tip = (c: DelegateCount, who: string) =>
  `${who}: ${c.calls} jobs for the local model${c.failed ? ` (${c.failed} failed: Claude did those itself)` : ''}. About ${kTok(c.keptOff)} tokens of file text it read that Claude never saw (about 4 characters a token, less the answers Claude read; a file Claude reads itself later comes off again). The local model read ${kTok(c.inTokens)} and wrote ${kTok(c.outTokens)} tokens.`;

// Who runs a chat, from its model: Claude families by name, a picture model, anything else is a local model.
function worker(t: TabState): string {
  if (t.info.auto) return 'AUTO';
  const m = t.info.model.toLowerCase();
  return m.match(/haiku|sonnet|opus|fable|mythos|image/)?.[0].toUpperCase() ?? (m === 'default' ? 'SONNET' : m ? 'LOCAL' : 'SAME');
}

function row(label: string): { row: HTMLElement; val: HTMLElement } {
  const r = el('div', 'ms-row');
  const val = el('span', 'ms-v');
  r.append(el('span', 'ms-k', label), val);
  return { row: r, val };
}

export function routerCard(): HTMLElement {
  const sec = el('section', 'ms-sec ms-router');
  const h = el('h3', 'ms-h');
  const extra = el('span', 'ms-h-extra');
  h.append(el('span', 'ms-h-label', 'ROUTER'), extra);
  // This chat in one line that may wrap; the rows under it stay short enough for a phone.
  const chat = el('p', 'ms-router-chat');
  const all = row('TOTAL');
  const work = row('LOCAL READ / WROTE');
  const threads = row('THREADS');
  sec.append(h, chat, all.row, work.row, threads.row);
  sec.hidden = true;

  let status: RouterResponse | null = null;
  let seen = ''; // the chat count last asked about

  const render = () => {
    const tab = store.current();
    sec.hidden = !status?.on || !tab;
    if (sec.hidden || !status || !tab) return;
    const c = tab.stats.delegate;
    extra.textContent = (c?.worker ?? status.total.worker ?? 'LOCAL MODEL').toUpperCase();
    const own = worker(tab) === 'LOCAL'; // the chat itself runs on the local model
    chat.textContent = c?.calls ? `THIS CHAT: LOCAL ${calls(c.calls)} · ~${kTok(c.keptOff)} TOKENS KEPT OFF CLAUDE` : own ? 'THIS CHAT RUNS ON THE LOCAL MODEL' : 'THIS CHAT: NO LOCAL CALLS YET';
    chat.title = c?.calls ? tip(c, 'This chat') : own ? '' : 'This chat has not handed a job to the local model yet. Claude decides when it pays.';
    chat.classList.toggle('used', !!c?.calls);
    all.val.textContent = status.total.calls ? `${calls(status.total.calls)} · ~${kTok(status.total.keptOff)} KEPT OFF` : 'NONE YET';
    all.row.title = status.total.calls ? tip(status.total, `All chats since ${new Date(status.since).toLocaleDateString()}`) : '';
    work.row.hidden = !c?.calls;
    if (c?.calls) work.val.textContent = `${kTok(c.inTokens)} / ${kTok(c.outTokens)}`;
    work.row.title = 'Tokens the local model read and wrote for this chat (its own counts).';
    // A project lead: who runs each of its threads.
    const p = tab.meta.project;
    const counts = new Map<string, number>();
    if (p?.main) for (const t of store.tabs.values()) if (t.meta.project?.id === p.id && !t.meta.project.main) counts.set(worker(t), (counts.get(worker(t)) ?? 0) + 1);
    threads.row.hidden = !counts.size;
    threads.val.textContent = [...counts].map(([w, n]) => `${n} ${w}`).join(' · ');
  };

  const load = async () => {
    try {
      if (store.demo) status = demoRouter();
      else {
        const r = await fetch('/api/router', { cache: 'no-store' });
        if (r.ok) status = (await r.json()) as RouterResponse;
      }
    } catch {
      /* server not reachable: keep what is on screen */
    }
    render();
  };

  watchActive(['stats', 'info', 'meta'], (tab) => {
    const c = tab?.stats.delegate;
    const key = `${tab?.meta.id}:${c?.calls ?? 0}:${c?.keptOff ?? 0}`;
    if (tab && key !== seen) {
      seen = key;
      void load();
    } else render();
  });
  // A thread's model or a new thread changes the THREADS row.
  store.on((c) => {
    if (c.kind === 'tabs' || (c.kind === 'patch' && c.key === 'info' && c.tab !== store.active)) render();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void load();
  });
  setTimeout(() => void load(), 0); // main.ts decides demo mode after the panels are mounted
  return sec;
}
