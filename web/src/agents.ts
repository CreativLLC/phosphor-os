import type { Agent, AgentStatus, TabState } from '../../shared/protocol.ts';
import { CREW_LOOKS, crewAnim, crewKind, nameHash } from './sprites/crew.ts';
import { Sprite } from './sprites/engine.ts';
import { operatorAnim, type OperatorState } from './sprites/operator.ts';
import { send } from './net.ts';
import { watchActive } from './store.ts';
import { mountToday } from './today.ts';
import { button, el, fmtDuration } from './ui.ts';

// Left sidebar (owner: art team): the main operator card on top, then one animated card per
// subagent. Running crew first (oldest first, so cards don't jump), then crew that finished in the
// last RECENT_MS, newest first. Older finished crew fold into one "N DONE" line (owner's ask
// 2026-10-11: only active crew on screen); tapping it shows them again. Nothing is deleted.
// Cards are keyed by tab + agent id and updated in place; canvases are never rebuilt.

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

function heading(label: string): { el: HTMLElement; extra: HTMLElement } {
  const h = el('h2', 'crew-h');
  const extra = el('span', 'crew-h-extra');
  h.append(el('span', '', label), extra);
  return { el: h, extra };
}

// ---------- Main operator ----------

class OperatorCard {
  readonly el = el('section', 'op');
  private sprite = new Sprite('sprite');
  private name = el('div', 'op-name', 'CLAUDE');
  private tag = el('div', 'op-tag');
  private time = el('div', 'op-stat');
  private tools = el('div', 'op-stat');
  private crew = el('div', 'op-stat');
  private turns = el('div', 'op-stat');
  private line = el('div', 'op-line');
  // The chat's name, editable here; HISTORY shows the same name later.
  private title = el('input', 'op-title');
  private tab?: TabState;

  constructor() {
    const head = el('div', 'op-head');
    head.append(this.name, this.tag);
    const info = el('div', 'op-info');
    info.append(this.time, this.tools, this.crew, this.turns);
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
    this.el.append(head, this.title, this.sprite.canvas, info, this.line);
  }

  update(tab: TabState | undefined): void {
    this.tab = tab;
    const meta = tab?.meta;
    const state: OperatorState = meta?.attention ? 'alert' : meta?.busy ? 'working' : 'idle';
    this.sprite.play(operatorAnim(state));
    this.el.dataset.state = state;
    this.title.disabled = !tab;
    if (document.activeElement !== this.title) this.title.value = meta?.title ?? '';
    setText(this.tag, !tab ? '[NO TAB]' : state === 'alert' ? '[NEEDS YOU]' : state === 'working' ? '[WORKING]' : '[STANDBY]');
    const agents = tab?.agents ?? [];
    setText(this.tools, `TOOLS ${tab?.stats.toolCalls ?? 0}`);
    setText(this.crew, `CREW ${agents.filter((a) => a.status === 'running').length}/${agents.length}`);
    setText(this.turns, `TURN ${tab?.stats.turns ?? 0}`);
    const line = !tab
      ? 'Open a tab to begin'
      : state === 'alert'
        ? 'Waiting for your answer'
        : tab.activity || (state === 'working' ? 'Thinking' : 'Awaiting orders');
    setText(this.line, line);
    setTitle(this.line, line);
    this.tick();
  }

  tick(): void {
    const s = this.tab?.stats;
    const live = this.tab?.meta.busy && s?.turnStartedAt;
    setText(this.time, live ? `T+ ${fmtDuration(Date.now() - s.turnStartedAt!)}` : s?.lastTurnMs ? `LAST ${fmtDuration(s.lastTurnMs)}` : 'T+ 0s');
  }
}

// ---------- Crew card ----------

class AgentCard {
  readonly el = el('article', 'agent');
  private sprite = new Sprite('sprite');
  private name = el('div', 'agent-name');
  private tag = el('div', 'agent-tag');
  private time = el('div', 'agent-stat');
  private tools = el('div', 'agent-stat');
  private tokens = el('div', 'agent-stat');
  private model = el('div', 'agent-stat');
  private desc = el('div', 'agent-desc');
  private line = el('div', 'agent-line');
  private kind: ReturnType<typeof crewKind>;
  private look: number;
  private agent: Agent;

  constructor(a: Agent) {
    this.agent = a;
    this.kind = crewKind(a.name);
    this.look = nameHash(a.name) % CREW_LOOKS;
    this.el.dataset.kind = this.kind;
    const info = el('div', 'agent-info');
    info.append(this.tag, this.time, this.tools, this.tokens, this.model);
    this.el.append(this.name, this.sprite.canvas, info, this.desc, this.line);
    // Tap (or Enter) to show the full description and status line.
    this.el.tabIndex = 0;
    this.el.onclick = () => this.el.classList.toggle('open');
    this.el.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.el.classList.toggle('open');
      }
    };
    // Entrance and status flashes play once; moving the card in the list must not replay them.
    this.el.classList.add('fresh');
    this.el.addEventListener('animationend', (e) => {
      if (e.target === this.el && !e.pseudoElement) this.el.classList.remove('fresh', 'flash');
    });
    this.update(a, true);
  }

  update(a: Agent, first = false): void {
    const prev = this.agent.status;
    this.agent = a;
    this.sprite.play(crewAnim(this.kind, this.look, a.status));
    if (!first && prev !== a.status) {
      this.el.classList.remove('flash');
      void this.el.offsetWidth; // restart the animation
      this.el.classList.add('flash');
    }
    for (const s of Object.keys(TAG)) this.el.classList.toggle(`st-${s}`, s === a.status);
    // Heading = the job Claude gave it ("Plan usage meter"); the agent type (mostly "general-purpose") goes below.
    setText(this.name, (a.description || a.name).toUpperCase());
    setText(this.tag, `[${TAG[a.status]}]`);
    setText(this.tools, `${a.toolUses} TOOL${a.toolUses === 1 ? '' : 'S'}`);
    setText(this.tokens, `${fmtTokens(a.tokens)} TOK`);
    setText(this.model, modelLabel(a.model));
    setTitle(this.model, a.model ?? '');
    setText(this.desc, a.description ? `Type: ${a.name}` : '');
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
    this.sprite.dispose();
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
  const op = new OperatorCard();
  const crewHead = heading('CREW');
  const list = el('div', 'crew-list');
  const empty = el('div', 'crew-empty');
  empty.append(el('div', 'crew-empty-title', 'NO CREW ON DUTY'), el('div', 'crew-empty-sub', 'Subagents report in here.'));
  let expanded = false;
  let tabId: string | undefined;
  const more = button('', () => {
    expanded = !expanded;
    render(current);
  }, 'crew-more');
  const todayHead = heading('TODAY');
  const todayBox = el('section', 'today');
  root.replaceChildren(opHead.el, op.el, crewHead.el, list, empty, more, todayBox);
  mountToday(todayBox, todayHead);

  const cards = new Map<string, AgentCard>();
  let current: TabState | undefined;
  let nextFold = Infinity; // when the next recent card folds away

  function render(tab: TabState | undefined): void {
    current = tab;
    if (tab?.meta.id !== tabId) {
      tabId = tab?.meta.id;
      expanded = false;
    }
    op.update(tab);

    const now = Date.now();
    const agents = tab?.agents ?? [];
    const running = agents.filter((a) => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt);
    const finished = agents.filter((a) => a.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    const recent = finished.filter((a) => now - (a.endedAt ?? a.startedAt) < RECENT_MS);
    nextFold = Math.min(Infinity, ...recent.map((a) => (a.endedAt ?? a.startedAt) + RECENT_MS));
    const shownDone = expanded ? finished : recent;
    const shown = [...running, ...shownDone];

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

    setText(crewHead.extra, agents.length ? `${running.length} ACTIVE / ${agents.length}` : '');
    empty.hidden = shown.length > 0;
    const folded = finished.length - recent.length;
    more.hidden = folded === 0;
    setText(more, expanded ? 'HIDE DONE' : `▸ ${folded} DONE`);
  }

  watchActive(['agents', 'meta', 'activity', 'stats'], render);

  // Live clocks for running crew and the operator's turn timer; finished cards fold when their time is up.
  setInterval(() => {
    if (document.hidden) return;
    if (Date.now() >= nextFold) render(current);
    op.tick();
    for (const c of cards.values()) if (c.running) c.tick();
  }, 1000);
}
