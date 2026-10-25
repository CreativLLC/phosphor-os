import { IMAGE_MODEL, type Agent, type CalendarEvent, type CalendarRangeResponse, type ClientEvent, type ImageItem, type Item, type Mission, type ServerEvent, type TabState, type TodayResponse } from '../../shared/protocol.ts';
import { TTL_1H } from '../../shared/cache.ts';
import { parseIdeas, type IdeasResponse } from '../../shared/ideas.ts';
import { apply, useDemo } from './net.ts';
import { setModels } from './pickers.ts';
import { store } from './store.ts';

// Demo mode: open /?demo=1 (still needs login). Fake tabs and a ticker that moves things,
// so the look, sprites and HUD can be built and checked without running Claude.

const CWD = '/home/user/workspace/projects/phosphor-os';
const now = Date.now();

const steps = (labels: string[], done: number): Mission['steps'] =>
  labels.map((label, i) => ({ label, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }));

const MISSION_STEPS = ['Read the current server code', 'Design the tab protocol', 'Build the tab manager', 'Load old chats from history', 'Wire the tab bar', 'Test with two tabs', 'Write the summary'];

function agent(id: string, name: string, description: string, status: Agent['status'], ago: number, extra: Partial<Agent> = {}): Agent {
  return { id, name, description, status, summary: '', lastTool: '', toolUses: 0, tokens: 0, startedAt: now - ago * 1000, ...extra };
}

const items: Item[] = [
  { id: 'd1', kind: 'user', text: 'Add tabs and chat history to the app. Keep it simple.' },
  {
    id: 'd2',
    kind: 'claude',
    text: "I'll split this into **three parts**:\n\n1. A tab manager on the server\n2. A history list from Claude Code's saved sessions\n3. The tab bar in the browser\n\n```ts\nexport class Tabs {\n  private tabs = new Map<string, Tab>();\n}\n```\n\nStarting with the server.",
  },
  { id: 'd3', kind: 'tool', name: 'Read', detail: 'server/index.ts' },
  { id: 'd4', kind: 'tool', name: 'Task', detail: 'Find where sessions are stored' },
  { id: 'd5', kind: 'tool', name: 'Edit', detail: 'server/tabs.ts', body: 'server/tabs.ts\n- const session = new ClaudeSession(broadcast);\n+ const tabs = new Tabs(broadcast);\n+ await tabs.restore();' },
  { id: 'd6', kind: 'tool', name: 'Bash', detail: 'npm run typecheck', body: 'npm run typecheck', error: true },
  { id: 'd7', kind: 'note', text: 'Done in 42s.' },
  { id: 'd8', kind: 'perm', tool: 'Bash', title: 'Claude wants to run: npm install marked', detail: 'npm install marked', status: 'pending' },
  {
    id: 'd9',
    kind: 'ask',
    status: 'pending',
    questions: [{ question: 'Amber or green?', header: 'Color', options: [{ label: 'Amber', description: 'Warm orange, like Alien' }, { label: 'Green', description: 'Classic terminal' }] }],
  },
  { id: 'd10', kind: 'claude', text: 'Writing the tab manager now' },
];

const tab1: TabState = {
  meta: { id: 'demo-1', title: 'Tabs and history', busy: true, attention: true, sessionId: 's1', createdAt: now - 600000 },
  info: { cwd: CWD, model: 'claude-opus-5-5', permissionMode: 'auto', effort: 'high' },
  items,
  mission: { title: 'Add tabs and chat history', summary: 'Adding tabs so you can run several chats at once, and a history list to reopen old ones.', steps: steps(MISSION_STEPS, 2), updatedAt: now },
  agents: [
    agent('a1', 'Explore', 'Find where sessions are stored', 'running', 95, { lastTool: 'Grep listSessions', summary: 'Searching the SDK types for session helpers', toolUses: 7, tokens: 18200 }),
    agent('a2', 'Plan', 'Design the tab protocol', 'completed', 300, { summary: 'Protocol drafted: one WebSocket, events carry a tab id.', toolUses: 4, tokens: 9100, endedAt: now - 120000 }),
    agent('a3', 'general-purpose', 'Check the old login code', 'failed', 400, { summary: 'Could not read data/secret', toolUses: 2, tokens: 3300, endedAt: now - 200000 }),
  ],
  stats: { toolCalls: 23, filesChanged: [`${CWD}/server/tabs.ts`, `${CWD}/server/tab.ts`, `${CWD}/web/src/tabs.ts`], turns: 3, turnStartedAt: now - 95000, lastTurnMs: 42000, contextTokens: 61000, contextWindow: 200000, cacheAt: now, cacheTtlMs: TTL_1H , connectors: [{ name: 'claude.ai Gmail', status: 'connected', calls: 4 }, { name: 'playwright', status: 'connected', calls: 2 }, { name: 'claude.ai Google Drive', status: 'connected', calls: 0 }, { name: 'claude.ai Notion', status: 'needs-auth', calls: 0 }] },
  activity: 'Edit: server/tabs.ts',
};

const tab2: TabState = {
  meta: { id: 'demo-2', title: 'Piano app bug', busy: false, attention: false, sessionId: 's2', createdAt: now - 3600000 },
  info: { cwd: '/home/user/workspace/projects/sample-app', model: 'claude-opus-5-5', permissionMode: 'default', effort: '' },
  items: [
    { id: 'e1', kind: 'user', text: 'Why does the metronome drift?' },
    { id: 'e2', kind: 'claude', text: 'It uses `setInterval`, which drifts. I switched it to the audio clock.' },
  ],
  mission: { title: 'Fix metronome drift', summary: 'Moved the metronome to the audio clock so it stays on time.', steps: steps(['Find the timer', 'Switch to audio clock', 'Test at 200 bpm'], 3), updatedAt: now },
  agents: [],
  stats: { toolCalls: 6, filesChanged: [], turns: 1, turnStartedAt: null, lastTurnMs: 31000, contextTokens: 22000, contextWindow: 200000, cacheAt: now - 22 * 60000, cacheTtlMs: TTL_1H },
  activity: '',
};

// The local image model: a picture being painted (its steps move with the ticker).
const painting: ImageItem = { id: 'p2', kind: 'image', status: 'painting', phase: 'Painting', step: 4, steps: 8, startedAt: now - 9000, prompt: 'a lighthouse at sunset', model: 'Qwen-Image 2.1 (local)', width: 1344, height: 768, seed: 42, fast: true };
// A project (a tab group): its lead chat and two threads.
function projectTabs(): TabState[] {
  const make = (id: string, title: string, main: boolean, busy: boolean, ago: number, reply: string): TabState => ({
    ...structuredClone(tab2),
    meta: { id, title, busy, attention: false, createdAt: now - ago, project: { id: 'demo-p', name: 'YT: Claude video', main, ...(main ? {} : { parent: 'demo-p1' }) } },
    items: reply ? [{ id: `${id}-r`, kind: 'claude', text: reply }] : [],
    mission: null,
    agents: [],
  });
  return [
    make('demo-p1', 'YT: Claude video', true, false, 900000, 'Started two threads: thumbnails and the outline.'),
    make('demo-p2', 'Thumbnails', false, true, 800000, ''),
    make('demo-p3', 'Outline', false, false, 700000, 'Outline done: 7 beats, 12 minutes.'),
  ];
}

const tab3: TabState = {
  meta: { id: 'demo-3', title: 'Lighthouse pictures', busy: true, attention: false, createdAt: now - 120000 },
  info: { cwd: CWD, model: IMAGE_MODEL, permissionMode: 'default', effort: '' },
  items: [
    { id: 'p1', kind: 'user', text: 'a lighthouse at sunset with a sign reading "PHOSPHOR" --wide --seed 42', paint: true },
    painting,
    { id: 'p3', kind: 'user', text: 'the same lighthouse in a storm --wide', paint: true },
    { id: 'p4', kind: 'image', status: 'queued', phase: 'Waiting for the GPU', prompt: 'the same lighthouse in a storm', model: 'Qwen-Image 2.1 (local)', width: 1344, height: 768, seed: 7, steps: 8, fast: true },
  ],
  mission: null,
  agents: [],
  stats: { toolCalls: 0, filesChanged: [], turns: 0, turnStartedAt: now - 9000, lastTurnMs: 0, contextTokens: 0, contextWindow: 0, cacheAt: null, cacheTtlMs: 0 },
  activity: 'Painting 4/8',
};

const ACTIVITIES = ['Read: server/index.ts', 'Grep: listSessions', 'Edit: server/tabs.ts', 'Bash: npm run typecheck', 'Writing a reply', 'Thinking'];
const TOOLS = ['Read server/tab.ts', 'Grep getSessionMessages', 'Glob **/*.jsonl', 'Read sdk.d.ts'];
const NAMES = ['Explore', 'general-purpose', 'Plan', 'claude-code-guide', 'scout'];

export function startDemo(): void {
  setModels([
    { value: 'default', label: 'Opus 5.5', description: 'Most capable', resolved: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', label: 'Sonnet 5.5', description: 'Fast and capable', resolved: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high'] },
    { value: 'haiku', label: 'Haiku 4.5', description: 'Fastest', resolved: 'claude-haiku-4-5-20251001', efforts: [] },
    { value: IMAGE_MODEL, label: 'Qwen-Image 2.1 (local)', description: "Makes pictures on this PC. Your message is the picture's description.", efforts: [] },
  ]);
  useDemo(onClientEvent);
  apply({ t: 'hello', tabs: [structuredClone(tab1), structuredClone(tab2), structuredClone(tab3), ...projectTabs()] });
  apply({ t: 'sdk_update', state: { installed: '0.3.296', pending: '0.3.301', claude: '2.1.301', bigger: null, running: false, failed: false } });

  let tick = 0;
  let done = 2;
  let nextAgent = 4;
  setInterval(() => {
    tick++;
    if (store.tabs.has('demo-3')) {
      const step = (tick % 8) + 1;
      emit({ t: 'update', tab: 'demo-3', item: { ...painting, step } });
      emit({ t: 'patch', tab: 'demo-3', key: 'activity', value: `Painting ${step}/8` });
    }
    const t = 'demo-1';
    if (!store.tabs.has(t)) return;
    emit({ t: 'patch', tab: t, key: 'activity', value: ACTIVITIES[tick % ACTIVITIES.length] });
    // Every 8 ticks: waiting for you (4 ticks), working (3 ticks), idle (1 tick).
    const phase = tick % 8;
    const meta = cur(t).meta;
    const want = { attention: phase < 4, busy: phase !== 7 };
    if (meta.attention !== want.attention || meta.busy !== want.busy) emit({ t: 'patch', tab: t, key: 'meta', value: { ...meta, ...want } });
    emit({ t: 'delta', tab: t, id: 'd10', text: tick % 10 === 0 ? '\n\n' : ' and more text' });

    const agents = structuredClone(cur(t).agents);
    for (const a of agents.filter((x) => x.status === 'running')) {
      a.toolUses++;
      a.tokens += 900;
      a.lastTool = TOOLS[(tick + a.toolUses) % TOOLS.length];
      if (a.toolUses > 12) {
        const roll = Math.random();
        a.status = roll < 0.7 ? 'completed' : roll < 0.85 ? 'failed' : 'stopped';
        a.endedAt = Date.now();
        a.summary = a.status === 'completed' ? 'Found it. Report sent back.' : a.status === 'stopped' ? 'Stopped by Claude' : 'Gave up: file locked';
      }
    }
    if (tick % 7 === 0 && agents.filter((x) => x.status === 'running').length < 3) {
      const name = NAMES[nextAgent % NAMES.length];
      agents.push(agent(`a${nextAgent}`, name, `Side task number ${nextAgent}`, 'running', 0, { startedAt: Date.now() }));
      nextAgent++;
    }
    emit({ t: 'patch', tab: t, key: 'agents', value: agents.slice(-6) });

    if (tick % 5 === 0) {
      done = (done + 1) % (MISSION_STEPS.length + 1);
      emit({ t: 'patch', tab: t, key: 'mission', value: { ...cur(t).mission!, steps: steps(MISSION_STEPS, done), updatedAt: Date.now() } });
      const stats = { ...cur(t).stats, toolCalls: cur(t).stats.toolCalls + 1, contextTokens: Math.min(cur(t).stats.contextTokens + 4000, 190000) };
      emit({ t: 'patch', tab: t, key: 'stats', value: stats });
    }
  }, 1500);
}

function cur(id: string): TabState {
  return store.tabs.get(id)!;
}

function emit(ev: ServerEvent): void {
  apply(ev);
}

function onClientEvent(ev: ClientEvent): void {
  const id = () => Math.random().toString(36).slice(2);
  if (ev.t === 'send' && cur(ev.tab).info.model === IMAGE_MODEL) {
    emit({ t: 'item', tab: ev.tab, item: { id: id(), kind: 'user', text: ev.text, paint: true } });
    emit({ t: 'item', tab: ev.tab, item: { id: id(), kind: 'image', status: 'failed', error: 'Demo mode: no image engine here.', prompt: ev.text, model: 'Qwen-Image 2.1 (local)', width: 1024, height: 1024, seed: 1, steps: 30 } });
  } else if (ev.t === 'send') {
    emit({ t: 'item', tab: ev.tab, item: { id: id(), kind: 'user', text: ev.text, ...(cur(ev.tab).info.auto ? { route: { model: 'Sonnet 5.5', effort: 'medium', reason: 'small single-file edit' } } : {}) } });
    emit({ t: 'item', tab: ev.tab, item: { id: id(), kind: 'claude', text: 'Demo mode: no real Claude here.' } });
  } else if (ev.t === 'perm') {
    const item = cur(ev.tab).items.find((i) => i.id === ev.id);
    if (item?.kind === 'perm') emit({ t: 'update', tab: ev.tab, item: { ...item, status: ev.allow ? 'allowed' : 'denied' } });
  } else if (ev.t === 'ask') {
    const item = cur(ev.tab).items.find((i) => i.id === ev.id);
    if (item?.kind === 'ask') emit({ t: 'update', tab: ev.tab, item: { ...item, status: ev.answers ? 'answered' : 'cancelled', answers: ev.answers ?? undefined } });
  } else if (ev.t === 'stop') {
    emit({ t: 'patch', tab: ev.tab, key: 'meta', value: { ...cur(ev.tab).meta, busy: false } });
  } else if (ev.t === 'close_tab') {
    emit({ t: 'tab_closed', tab: ev.tab });
  } else if (ev.t === 'new_tab') {
    const tab: TabState = { ...structuredClone(tab2), meta: { ...tab2.meta, id: id(), title: 'New chat' }, items: [], mission: null };
    emit({ t: 'tab', tab, req: ev.req });
  } else if (ev.t === 'model') {
    emit({ t: 'patch', tab: ev.tab, key: 'info', value: ev.model === 'auto' ? { ...cur(ev.tab).info, auto: true } : { ...cur(ev.tab).info, model: ev.model, auto: false } });
  } else if (ev.t === 'effort') {
    emit({ t: 'patch', tab: ev.tab, key: 'info', value: { ...cur(ev.tab).info, effort: ev.effort, auto: false } });
  } else if (ev.t === 'mode') {
    emit({ t: 'patch', tab: ev.tab, key: 'info', value: { ...cur(ev.tab).info, permissionMode: ev.mode } });
  } else if (ev.t === 'rename_tab') {
    emit({ t: 'patch', tab: ev.tab, key: 'meta', value: { ...cur(ev.tab).meta, title: ev.title } });
  }
}

// Demo links go to Google's day view (no account here).
const DEMO_NEW = 'https://calendar.google.com/calendar/r/eventedit?dates=';
const demoEdit = (start: string) => {
  const d = new Date(start);
  return `https://calendar.google.com/calendar/r/day/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};

// Sample TODAY panel: times are relative to the clock, so there is always something left today.
export function demoIdeas(): IdeasResponse {
  const file = '/home/user/workspace/parked.md';
  const md = [
    '## Parked',
    '- [ ] 2026-10-20 · sample-app · Dark mode for the settings page',
    '- [ ] 2026-10-21 · phosphor-os · Search old pictures and docs from HISTORY too, not only chats',
    '- [ ] 2026-10-21 · notes · Write a short guide for the backup script',
    '## Suggested',
    '- [ ] 2026-10-23 · routine · Weekly check that every project still builds',
  ].join('\n');
  return { file, found: true, ideas: parseIdeas(md) };
}

export function demoToday(): TodayResponse {
  const d = new Date();
  const at = (days: number, h: number, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h, m).toISOString();
  const ev = (start: string, end: string, title: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ start, end, allDay: false, title, location: '', description: '', calendar: 'demo', edit: demoEdit(start), ...extra });
  const h = d.getHours();
  return {
    configured: true,
    offline: false,
    updated: Date.now(),
    newUrl: DEMO_NEW,
    events: [
      ev(at(0, 0), at(1, 0), 'Dentist day off', { allDay: true }),
      ev(at(0, Math.max(h - 1, 0), 0), at(0, Math.min(h + 1, 23), 59), 'Design review', { location: 'Room 4', description: 'Walk through the new left column.\nBring the sprite sheet.' }),
      ev(at(0, Math.min(h + 2, 23), 0), at(0, 23, 59), 'Call with the plumber', { description: 'About the kitchen tap.' }),
      ev(at(1, 9, 30), at(1, 10), 'Standup', { location: 'Video call' }),
    ],
    reminders: [{ label: 'Check the oven', at: Date.now() + 12 * 60_000 }],
  };
}

// Sample month view: a repeating pattern over the kept span (31 days back, 92 ahead), two calendars, a busy day and a
// three-day trip, so cells, "+N more", markers and the agenda all have something to show.
export function demoMonth(from: number, to: number): CalendarRangeResponse {
  const t = new Date();
  const base = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const at = (day: number, h: number, m = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + day, h, m).toISOString();
  const ev = (start: string, end: string, title: string, calendar: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ start, end, allDay: false, title, location: '', description: '', calendar, edit: demoEdit(start), ...extra });
  const A = 'Demo work';
  const B = 'Demo home';
  const events: CalendarEvent[] = [];
  for (let d = -31; d <= 92; d++) {
    const wd = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d).getDay();
    if (wd >= 1 && wd <= 5) events.push(ev(at(d, 9, 30), at(d, 10), 'Standup', A, { location: 'Video call' }));
    if (wd === 3) events.push(ev(at(d, 12), at(d, 13), 'Lunch with Sam', B, { location: 'The corner cafe', description: 'Bring the book back.' }));
    if (wd === 5) events.push(ev(at(d, 16), at(d, 17), 'Demo day', A, { description: 'Show the new month view.\nKeep it short.' }));
    if (d % 9 === 0) events.push(ev(at(d, 0), at(d + 1, 0), 'Bins out', B, { allDay: true }));
    if (d % 11 === 4) events.push(ev(at(d, 18, 30), at(d, 20), 'Piano lesson', B));
  }
  events.push(ev(at(3, 0), at(6, 0), 'Weekend trip', B, { allDay: true, location: 'The coast' }));
  events.push(ev(at(2, 22), at(3, 1), 'Late deploy', A));
  for (const [i, title] of ['Planning', 'Design review', 'Budget call', 'Retro'].entries()) events.push(ev(at(2, 11 + i), at(2, 11 + i, 45), title, A));
  events.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  return {
    configured: true,
    offline: false,
    updated: Date.now(),
    calendars: [A, B],
    newUrl: DEMO_NEW,
    rangeFrom: new Date(base.getFullYear(), base.getMonth(), base.getDate() - 31).getTime(),
    rangeTo: new Date(base.getFullYear(), base.getMonth(), base.getDate() + 93).getTime(),
    events: events.filter((e) => new Date(e.start).getTime() < to && new Date(e.end).getTime() > from),
  };
}
