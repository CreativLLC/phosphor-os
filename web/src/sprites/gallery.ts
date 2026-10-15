// Dev-only sprite review page: http://localhost:5173/sprites.html  (not part of the build)
// Shows every animation live, every frame side by side, and the agent cards at the three
// sidebar widths with fake agents in every state.

import '@fontsource/vt323';
import '../theme.css';
import '../agents.css';
import type { Agent, AgentStatus, TabState } from '../../../shared/protocol.ts';
import { mountAgents } from '../agents.ts';
import { store } from '../store.ts';
import { el } from '../ui.ts';
import { crewAnim, CREW_LOOKS, type CrewKind } from './crew.ts';
import { anim, Sprite, type Anim } from './engine.ts';
import { operatorAnim, type OperatorState } from './operator.ts';

const root = document.getElementById('gallery')!;
const params = new URLSearchParams(location.search);
const only = params.get('only'); // ?only=crew | crew:scout | operator | cards
const PX = Number(params.get('px') ?? 3); // frame scale
if (params.has('crt')) document.documentElement.dataset.crt = params.get('crt')!;

function setPhosphor(p: string) {
  document.documentElement.dataset.phosphor = p;
  window.dispatchEvent(new Event('themechange'));
}

const bar = el('div', 'g-bar');
for (const p of ['amber', 'green']) {
  const b = el('button', '', p.toUpperCase());
  b.onclick = () => setPhosphor(p);
  bar.append(b);
}
root.append(el('h1', '', 'SPRITE REVIEW'), bar);

function strip(label: string, a: Anim, scale: number): HTMLElement {
  const row = el('div', 'g-row');
  const live = new Sprite('g-live');
  live.canvas.style.setProperty('--px', String(scale + 1));
  live.play(a);
  const frames = el('div', 'g-frames');
  a.frames.forEach((g, i) => {
    const s = new Sprite('g-frame');
    s.canvas.style.setProperty('--px', String(scale));
    s.play(anim([g]));
    const cell = el('div', 'g-cell');
    cell.append(s.canvas, el('small', '', `${i}:${a.ends[i] - (a.ends[i - 1] ?? 0)}`));
    frames.append(cell);
  });
  row.append(el('div', 'g-label', label), live.canvas, frames);
  return row;
}

if (!only || only === 'operator') {
  const sec = el('section', 'g-sec');
  sec.append(el('h2', '', 'OPERATOR'));
  for (const s of ['idle', 'working', 'alert'] as OperatorState[]) sec.append(strip(s.toUpperCase(), operatorAnim(s), PX));
  root.append(sec);
}

if (!only || only === 'crew' || only.startsWith('crew:')) {
  const pick = only?.startsWith('crew:') ? only.slice(5) : '';
  const kinds: [CrewKind, number][] = [
    ['scout', 0],
    ['architect', 0],
    ['engineer', 0],
    ['librarian', 0],
    ...Array.from({ length: CREW_LOOKS }, (_, i) => ['crew', i] as [CrewKind, number]),
  ];
  for (const [kind, look] of kinds) {
    if (pick && pick !== kind && pick !== `${kind}${look}`) continue;
    const sec = el('section', 'g-sec');
    sec.append(el('h2', '', kind === 'crew' ? `CREW LOOK ${look}` : kind.toUpperCase()));
    for (const st of ['running', 'completed', 'failed', 'stopped'] as AgentStatus[]) sec.append(strip(st.toUpperCase(), crewAnim(kind, look, st), PX));
    root.append(sec);
  }
}

if (!only || only === 'cards') {
  const t = Date.now();
  const a = (id: string, name: string, status: AgentStatus, desc: string, extra: Partial<Agent> = {}): Agent => ({
    id,
    name,
    description: desc,
    status,
    summary: '',
    lastTool: '',
    toolUses: 0,
    tokens: 0,
    startedAt: t - 90_000,
    ...(status === 'running' ? {} : { endedAt: t - 10_000 }),
    ...extra,
  });
  const tab: TabState = {
    meta: { id: 'g1', title: 'Gallery', busy: true, attention: params.has('alert'), createdAt: t },
    info: { cwd: 'C:\\x', model: 'm', permissionMode: 'default', effort: '' },
    items: [],
    mission: null,
    agents: [
      a('1', 'Explore', 'running', 'Find where sessions are stored', { lastTool: 'Grep listSessions', toolUses: 7, tokens: 18200 }),
      a('2', 'Plan', 'running', 'Design the tab protocol for many tabs at once', { summary: 'Drafting the message shapes', toolUses: 3, tokens: 6400 }),
      a('3', 'general-purpose', 'completed', 'Check the old login code', { summary: 'Login code is fine.', toolUses: 9, tokens: 22000 }),
      a('4', 'claude-code-guide', 'running', 'Look up the hooks docs', { lastTool: 'WebFetch docs.claude.com', toolUses: 2, tokens: 3100 }),
      a('5', 'statusline-setup', 'failed', 'Fix the status line', { summary: 'Could not read settings.json', toolUses: 1, tokens: 900 }),
      a('6', 'scout', 'stopped', 'Map the wiki', { summary: 'Stopped by you', toolUses: 4, tokens: 5200 }),
      a('7', 'linter', 'completed', 'Tidy the index', { summary: 'All clean.', toolUses: 12, tokens: 40100, endedAt: t - 50_000 }),
    ],
    stats: { toolCalls: 23, filesChanged: [], turns: 3, turnStartedAt: t - 95_000, lastTurnMs: 42_000, contextTokens: 61_000, contextWindow: 200_000 },
    activity: 'Edit: server/tabs.ts',
  };
  if (params.has('many')) {
    for (let i = 0; i < 6; i++) tab.agents.push(a(`m${i}`, ['Explore', 'Plan', 'general-purpose'][i % 3], 'completed', `Old side task ${i}`, { summary: 'Done.', endedAt: t - 200_000 - i * 1000 }));
  }
  store.tabs.set('g1', tab);
  store.setActive('g1');
  const sec = el('section', 'g-sec');
  sec.append(el('h2', '', 'CARDS AT 250 / 210 / 340 PX'));
  const wrap = el('div', 'g-cards');
  for (const w of [250, 210, 340]) {
    const col = el('aside', 'g-col');
    col.style.width = `${w}px`;
    const inner = el('div');
    col.append(inner);
    wrap.append(col);
    mountAgents(inner);
  }
  sec.append(wrap);
  root.append(sec);
}
