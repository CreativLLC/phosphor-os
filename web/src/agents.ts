import type { Agent, AgentStatus, TabState } from '../../shared/protocol.ts';
import { send } from './net.ts';
import { Scene } from './scene.ts';
import { store, watchActive, working } from './store.ts';
import { mountIdeas } from './ideas.ts';
import { newProjectChat, showProjects } from './projects.ts';
import { mountToday } from './today.ts';
import { button, el, fmtDuration } from './ui.ts';
import { crewKind, nameHash } from './sprites/crew.ts';
import { Sprite } from './sprites/engine.ts';
import { TROUPE_LOOKS, troupeAnim } from './sprites/troupe.ts';

// Left sidebar (owner: art team): the operator card on top (a pixel scene, scene.ts, where the mascot acts out
// what Claude does and running helpers work beside it), then one compact row per subagent. Running crew first
// (oldest first, so rows don't jump), then crew that finished in the last RECENT_MS, newest first. Older finished
// crew leave the panel (owner's ask 2026-10-21: the chat already shows each helper's work), except a failed or
// stopped one: it stays until the next turn starts. Rows are keyed by tab + agent id and updated in place.

const RECENT_MS = 2 * 60_000;
const TAG: Record<AgentStatus, string> = { running: 'RUNNING', completed: 'DONE', failed: 'FAILED', stopped: 'STOPPED' };

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function setTitle(node: HTMLElement, text: string): void {
  if (node.title !== text) node.title = text;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`;
}

// How a project chat is doing, in one word (as the server's project tools say it).
function threadState(t: TabState): string {
  if (t.meta.attention) return 'NEEDS YOU';
  if (working(t)) return 'WORKING';
  return t.items.some((i) => i.kind === 'claude') ? 'IDLE' : 'NOT STARTED';
}

function heading(label: string): { el: HTMLElement; extra: HTMLElement } {
  const h = el('h2', 'crew-h');
  const extra = el('span', 'crew-h-extra');
  h.append(el('span', '', label), extra);
  return { el: h, extra };
}

// ---------- Main operator ----------

class OperatorCard {
  readonly el = el('section', 'op');
  private scene = new Scene();
  private name = el('span', 'op-name', 'CLAUDE');
  private tag = el('span', 'op-tag');
  private time = el('span', 'op-time');
  private line = el('div', 'op-line');
  // The chat's name, editable here; HISTORY shows the same name later.
  private title = el('input', 'op-title');
  private tab?: TabState;

  // The OPERATOR heading's right side: turn and tool counts, so the card stays short (the crew count is CREW's).
  private stats: HTMLElement;

  constructor(stats: HTMLElement) {
    this.stats = stats;
    const head = el('div', 'op-head');
    head.append(this.name, this.title, this.tag);
    const foot = el('div', 'op-foot');
    foot.append(this.line, this.time);
    this.title.maxLength = 60;
    this.title.placeholder = 'Name this chat';
    this.title.title = 'Chat name: click to rename, Enter to save';
    this.title.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.title.value = this.tab?.meta.title ?? '';
      if (e.key === 'Enter' || e.key === 'Escape') this.title.blur();
    };
    this.title.onchange = () => {
      const t = this.title.value.trim();
      if (this.tab && t && t !== this.tab.meta.title) send({ t: 'rename_tab', tab: this.tab.meta.id, title: t });
      else this.title.value = this.tab?.meta.title ?? '';
    };
    this.el.append(head, this.scene.el, foot);
    this.scene.onTimer = () => this.update(this.tab);
  }

  update(tab: TabState | undefined): void {
    this.tab = tab;
    const meta = tab?.meta;
    const state = meta?.attention ? 'alert' : meta?.busy ? 'working' : 'idle';
    this.scene.update(tab);
    this.el.dataset.state = state;
    setText(this.name, tab?.info.agent === 'gemini' ? 'GEMINI' : 'CLAUDE');
    this.title.disabled = !tab;
    if (document.activeElement !== this.title) this.title.value = meta?.title ?? '';
    setText(this.tag, !tab ? '[NO TAB]' : state === 'alert' ? '[NEEDS YOU]' : state === 'working' ? '[WORKING]' : '[STANDBY]');
    setText(this.stats, tab ? `TURN ${tab.stats.turns} · ${tab.stats.toolCalls} TOOLS` : '');
    const act = this.scene.activity;
    const line = !tab
      ? 'Open a tab to begin'
      : state === 'alert'
        ? 'Waiting for your answer'
        : tab.activity || (state === 'working' ? 'Thinking' : act === 'done' ? 'Done' : act === 'error' ? 'Stopped on an error' : 'Awaiting orders');
    setText(this.line, line);
    setTitle(this.line, line);
    this.tick();
  }

  tick(): void {
    const s = this.tab?.stats;
    const live = this.tab?.meta.busy && s?.turnStartedAt;
    setText(this.time, live ? `T+ ${fmtDuration(Date.now() - s.turnStartedAt!)}` : s?.lastTurnMs ? `LAST ${fmtDuration(s.lastTurnMs)}` : '');
  }
}

// ---------- Crew card ----------

// One compact row: the job and its time; below, type and status (tap for counts, model and the last line). The scene
// shows the helper itself.
class AgentCard {
  readonly el = el('article', 'agent');
  private name = el('div', 'agent-name');
  private time = el('div', 'agent-time');
  private type = el('span', 'agent-type');
  private tag = el('span', 'agent-tag');
  private tools = el('span', 'agent-stat');
  private tokens = el('span', 'agent-stat');
  private model = el('span', 'agent-stat');
  private line = el('div', 'agent-line');
  private face = new Sprite('sprite agent-face'); // the same character the scene shows for this helper
  private agent: Agent;

  constructor(a: Agent) {
    this.agent = a;
    const meta = el('div', 'agent-meta');
    meta.append(this.type, this.tag, this.tools, this.tokens, this.model);
    this.el.append(this.face.canvas, this.name, this.time, meta, this.line);
    // Tap (or Enter) to show the full job and status line.
    this.el.tabIndex = 0;
    this.el.onclick = () => this.el.classList.toggle('open');
    this.el.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.el.classList.toggle('open');
      }
    };
    // Entrance and status flashes play once; moving the row in the list must not replay them.
    this.el.classList.add('fresh');
    this.el.addEventListener('animationend', (e) => {
      if (e.target === this.el && !e.pseudoElement) this.el.classList.remove('fresh', 'flash');
    });
    this.update(a, true);
  }

  update(a: Agent, first = false): void {
    const prev = this.agent.status;
    this.agent = a;
    if (!first && prev !== a.status) {
      this.el.classList.remove('flash');
      void this.el.offsetWidth; // restart the animation
      this.el.classList.add('flash');
    }
    for (const s of Object.keys(TAG)) this.el.classList.toggle(`st-${s}`, s === a.status);
    if (first || prev !== a.status) this.face.play(troupeAnim(crewKind(a.name), nameHash(a.name) % TROUPE_LOOKS, a.status === 'running' ? 'work' : a.status));
    // Heading = the job Claude gave it ("Plan usage meter"); the agent type (mostly "general-purpose") goes below.
    setText(this.name, (a.description || a.name).toUpperCase());
    setText(this.type, a.name);
    setText(this.tag, TAG[a.status]);
    setText(this.tools, `${a.toolUses} TOOL${a.toolUses === 1 ? '' : 'S'}`);
    setText(this.tokens, `${fmtTokens(a.tokens)} TOK`);
    setText(this.model, modelLabel(a.model));
    setTitle(this.model, a.model ?? '');
    const line = a.summary || a.lastTool || (a.status === 'running' ? 'Starting up' : '');
    setText(this.line, line);
    setTitle(this.name, a.description);
    setTitle(this.line, line);
    this.tick();
  }

  tick(): void {
    const a = this.agent;
    setText(this.time, fmtDuration((a.status === 'running' ? Date.now() : (a.endedAt ?? Date.now())) - a.startedAt));
  }

  get running(): boolean {
    return this.agent.status === 'running';
  }

  dispose(): void {
    this.face.dispose();
    this.el.remove();
  }
}

// "claude-sonnet-5-5" -> "SONNET 5.5"; unknown until the agent's first reply.
function modelLabel(id?: string): string {
  if (!id) return 'MODEL …';
  const m = /claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  return (m ? `${m[1]} ${m[2]}.${m[3]}` : id.replace(/^claude-/, '')).toUpperCase();
}

// ---------- Mount ----------

export function mountAgents(root: HTMLElement): void {
  root.classList.add('crew');
  const opHead = heading('OPERATOR');
  const op = new OperatorCard(opHead.extra);
  const crewHead = heading('CREW');
  const list = el('div', 'crew-list');
  const empty = el('div', 'crew-empty');
  empty.append(el('div', 'crew-empty-title', 'NO CREW ON DUTY'), el('div', 'crew-empty-sub', 'Subagents report in here.'));
  const todayHead = heading('TODAY');
  const todayBox = el('section', 'today');
  const ideasHead = heading('IDEAS');
  const ideasBox = el('section', 'ideas');
  // THREADS: the open chat's project, the lead first, then its threads with how each is doing. A click opens it.
  const threadsHead = heading('THREADS');
  const threadList = el('div', 'thread-list');
  const threadsBox = el('section', 'threads');
  // + CHAT: one more chat in this project; ALL PROJECTS: the PROJECTS list (projects.ts).
  const threadTools = el('div', 'thread-tools');
  const addChat = button('+ CHAT', () => {
    const p = store.current()?.meta.project;
    if (p) newProjectChat(p);
  });
  addChat.title = 'A new chat in this project: same folder and shared memory';
  const allProjects = button('ALL PROJECTS', () => showProjects());
  allProjects.title = 'Every project, open or closed';
  threadTools.append(addChat, allProjects);
  threadsBox.append(threadsHead.el, threadList, threadTools);
  const renderThreads = () => {
    const p = store.current()?.meta.project;
    threadsBox.hidden = !p;
    if (!p) return threadList.replaceChildren();
    const members = [...store.tabs.values()]
      .filter((t) => t.meta.project?.id === p.id)
      .sort((a, b) => Number(!!b.meta.project?.main) - Number(!!a.meta.project?.main) || a.meta.createdAt - b.meta.createdAt);
    threadsHead.extra.textContent = p.name.toUpperCase();
    threadList.replaceChildren(
      ...members.map((t) => {
        const row = el('button', 'thread');
        row.type = 'button';
        const state = threadState(t);
        row.classList.toggle('on', t.meta.id === store.active);
        row.classList.add(`st-${state.toLowerCase().replace(/ /g, '-')}`);
        row.append(el('span', 'thread-name', `${t.meta.project?.main ? 'LEAD · ' : ''}${t.meta.title}`), el('span', 'thread-state', state));
        row.onclick = () => store.setActive(t.meta.id);
        return row;
      }),
      ...(members.length < 2 ? [el('div', 'thread-empty', 'No threads yet. Ask the lead to split the work, or start one with + CHAT.')] : []),
    );
  };
  store.on((c) => {
    if (c.kind === 'tabs' || c.kind === 'active' || c.kind === 'reset' || (c.kind === 'patch' && (c.key === 'meta' || c.key === 'agents')) || (c.kind === 'item' && c.op === 'add')) renderThreads();
  });
  root.replaceChildren(opHead.el, op.el, threadsBox, crewHead.el, list, empty, todayBox, ideasBox);
  renderThreads();
  mountToday(todayBox, todayHead);
  mountIdeas(ideasBox, ideasHead);

  const cards = new Map<string, AgentCard>();
  let current: TabState | undefined;
  let nextFold = Infinity; // when the next recent card folds away

  function render(tab: TabState | undefined): void {
    current = tab;
    const tabId = tab?.meta.id;
    op.update(tab);

    const now = Date.now();
    const agents = tab?.agents ?? [];
    const running = agents.filter((a) => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
    const finished = agents.filter((a) => a.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    const recent = finished.filter((a) => now - (a.endedAt ?? a.startedAt) < RECENT_MS);
    nextFold = Math.min(Infinity, ...recent.map((a) => (a.endedAt ?? a.startedAt) + RECENT_MS));
    const turn = tab?.stats.turnStartedAt;
    const failedThisTurn = (a: (typeof agents)[number]) => a.status !== 'completed' && (!turn || (a.endedAt ?? a.startedAt) >= turn);
    const shown = [...running, ...finished.filter((a) => recent.includes(a) || failedThisTurn(a))];

    const keys = shown.map((a) => `${tabId}:${a.id}`);
    const keep = new Set(keys);
    for (const [k, c] of cards) {
      if (!keep.has(k)) {
        c.dispose();
        cards.delete(k);
      }
    }
    shown.forEach((a, i) => {
      let c = cards.get(keys[i]);
      if (c) c.update(a);
      else cards.set(keys[i], (c = new AgentCard(a)));
      if (list.children[i] !== c.el) list.insertBefore(c.el, list.children[i] ?? null);
    });

    setText(crewHead.extra, running.length ? `${running.length} ACTIVE` : '');
    empty.hidden = shown.length > 0;
  }

  watchActive(['agents', 'meta', 'activity', 'stats', 'info'], render); // info: a chat with Gemini names it

  // Live clocks for running crew and the operator's turn timer; finished cards fold when their time is up.
  setInterval(() => {
    if (document.hidden) return;
    if (Date.now() >= nextFold) render(current);
    op.tick();
    for (const c of cards.values()) if (c.running) c.tick();
  }, 1000);
}
