import { LAB_MAX_MODELS, promptLibrary, type LabApp, type LabEffort, type LabModel, type LabNewTest, type LabResultFull, type LabTestFull, type LabVersion } from '../../shared/lab.ts';

// Fake data for LAB in demo mode (/?demo=1): no real API call is made and no model runs. The tests live in memory. A
// result added to a test (or followed up) goes WAITING, RUNNING, DONE in a few seconds, so the cards can be watched
// filling in. The coffee shop test has a result with one FOLLOW UP and the version kept before it.

const now = Date.now();
const DAY = 86_400_000;

const APP: Record<LabApp, [string, string]> = {
  claude: ['Claude Code', 'Claude plan'],
  agy: ['Antigravity', 'Google AI Pro'],
  codex: ['Codex', 'ChatGPT'],
  opencode: ['opencode', 'OpenCode Go'],
  local: ['Claude Code', 'This PC'],
};
const model = (app: LabApp, id: string, name: string): LabModel => ({ id: `${app}:${id}`, name, app, appName: APP[app][0], account: APP[app][1], efforts: ['low', 'medium', 'high'] });
const MODELS: LabModel[] = [
  model('claude', 'claude-opus-5-5', 'Claude Opus 5.5'),
  model('claude', 'claude-sonnet-5-5', 'Claude Sonnet 5.5'),
  model('claude', 'claude-haiku-5-5', 'Claude Haiku 5.5'),
  model('agy', 'gemini-4-argon', 'Gemini 4 Argon'),
  model('agy', 'gemini-3.8-flash', 'Gemini 3.8 Flash'),
  model('codex', 'gpt-6-luna', 'GPT-6 Luna'),
  model('codex', 'gpt-5.6-terra', 'GPT-5.6 Terra'),
  model('opencode', 'opencode-go/kimi-k3.1-pro', 'Kimi K3.1 Pro'),
  model('opencode', 'opencode-go/glm-5.3', 'GLM 5.3'),
  model('opencode', 'opencode-go/deepseek-v4-pro', 'DeepSeek V4 Pro'),
  model('opencode', 'opencode-go/qwen3.8-max', 'Qwen3.8 Max'),
  model('opencode', 'opencode-go/minimax-m3', 'MiniMax M3'),
  model('local', 'qwen3.6-35b', 'Qwen3.6 35B'),
  model('local', 'gemma-4', 'Gemma 4'),
];
const byId = (id: string) => MODELS.find((m) => m.id === id) ?? MODELS[0];
const dirOf = (m: LabModel) => `${m.id.slice(m.id.indexOf(':') + 1).split('/').pop()}--${m.app}`;

const SNAKE = 'Make a retro snake game in one HTML file. Arrow keys steer, a score counts the apples, and a game over screen shows when the snake hits itself. Keep it under 150 lines.';
const BALLS = 'Write a page where 20 balls bounce inside a spinning hexagon, with gravity and friction. The balls must never leave the hexagon.';
const COFFEE = 'Design a landing page for a small coffee shop called Maple & Bean.\n\nIt needs a hero with the shop name and a button to order ahead, three short cards (fresh beans, fast pickup, free refills), a menu with prices, opening hours and a map placeholder.\n\nMake it warm and readable on a phone. No libraries.';

type Seed = { title: string; prompt: string; ago: number; archived?: boolean; blind?: boolean; effort?: LabEffort; runs: [string, number, Partial<LabResultFull>?][]; says: string[] };
const SEEDS: Seed[] = [
  {
    title: 'Retro snake game',
    prompt: SNAKE,
    ago: 2,
    effort: 'high',
    runs: [['claude:claude-opus-5-5', 5, { rank: 1 }], ['claude:claude-sonnet-5-5', 4, { rank: 2 }], ['opencode:opencode-go/kimi-k3.1-pro', 4, { rank: 3, note: 'Speeds up nicely' }], ['codex:gpt-6-luna', 3, { rank: 4 }], ['agy:gemini-4-argon', 0, { state: 'failed', error: 'The app stopped with code 1.', reply: '', files: [], tokens: 800 }]],
    says: ['Done. One index.html with a canvas: arrow keys steer, apples count up in the corner, and a game over screen has a restart key.', 'I made index.html. The snake speeds up every five apples and the walls wrap around.', 'Built it as a single file, no libraries. Press any arrow key to start.', 'The page is ready: a grid, a score and a game over message. About 120 lines.'],
  },
  { title: 'Bouncing balls in a hexagon', prompt: BALLS, ago: 3, blind: true, runs: [['claude:claude-opus-5-5', 5], ['opencode:opencode-go/deepseek-v4-pro', 3], ['opencode:opencode-go/glm-5.3', 0]], says: ['Twenty balls fall under gravity and bounce off the six walls of a hexagon that turns slowly. Friction slows each bounce a little.', 'Done: index.html with a canvas. The balls are pushed back inside whenever a wall would let them out.', 'The hexagon spins at a steady rate and the balls keep their speed after each bounce.'] },
  { title: 'Coffee shop landing page', prompt: COFFEE, ago: 6, effort: 'medium', runs: [['claude:claude-sonnet-5-5', 4], ['opencode:opencode-go/qwen3.8-max', 4], ['agy:gemini-3.8-flash', 3], ['opencode:opencode-go/minimax-m3', 2]], says: ['The page has a warm hero, three cards, a menu table with prices and opening hours. It reads well at phone width.', 'Done. A cream and brown theme, a big ORDER AHEAD button and the menu in two columns on wide screens.', 'I used system fonts and CSS grid. The map is a gray box with a pin icon.', 'Done: a hero with the shop name, three cards and a menu with prices.'] },
  { title: 'Snake game, older models', prompt: SNAKE, ago: 14, runs: [['claude:claude-haiku-5-5', 3], ['codex:gpt-5.6-terra', 4], ['agy:gemini-3.8-flash', 2]], says: ['Here is a snake game in one file with arrow key steering and a score.', 'The game is in index.html. It restarts when you press Enter.', 'A small snake game: the grid is 20 by 20 and the score shows at the top.'] },
  { title: 'Retro snake game', prompt: SNAKE, ago: 27, archived: true, runs: [['claude:claude-sonnet-5-5', 3], ['opencode:opencode-go/glm-5.3', 3]], says: ['A snake game with a score. The snake grows when it eats.', 'Done: index.html with the game loop and a game over screen.'] },
  { title: 'Pixel cat', prompt: 'Draw a pixel art cat with SVG, 11 by 8 squares, in two colors.', ago: 38, archived: true, runs: [['claude:claude-opus-5-5', 4], ['codex:gpt-6-luna', 5]], says: ['The cat is an SVG with 11 by 8 squares: orange body, dark eyes, two ears.', 'Built the cat with rect elements in a single SVG. The page centers it.'] },
];

function result(m: LabModel, at: number, i: number, stars: number, says: string, over: Partial<LabResultFull> = {}): LabResultFull {
  const ms = (140 + ((i * 53) % 170)) * 1000;
  return {
    dir: dirOf(m), model: m.id, modelName: m.name, app: m.app, appName: m.appName, appVersion: '1.0.0', account: m.account,
    state: 'done', startedAt: at, endedAt: at + ms, tokens: 9000 + ((i * 7919) % 60) * 1000, value: m.app === 'opencode' ? null : 0.08 + i * 0.05, stars, rank: 0, timeUp: false, effort: 'default', note: '', error: '', followUps: [],
    reply: says, files: [{ path: 'index.html', bytes: 4200 + i * 700 }], page: '', build: '', canBuild: false, ...over,
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'test';
const stamp = (at: number) => new Date(at).toISOString().slice(0, 10);

function build(id: string, f: Pick<LabTestFull, 'title' | 'prompt' | 'at' | 'archived' | 'blind' | 'timeLimitMin' | 'effort' | 'results'>): LabTestFull {
  return { id, revealed: false, ...f, folder: `data/lab/${f.archived ? 'archive' : 'tests'}/${id.slice(0, 4)}/${id}`, view: `/lab/v/demo/${id}/` };
}

const tests: LabTestFull[] = SEEDS.map((s) => {
  const at = now - s.ago * DAY;
  const id = `${stamp(at)}-${slug(s.title)}`;
  const results = s.runs.map(([m, stars, over], i) => result(byId(m), at, i, stars, s.says[i % s.says.length], { effort: s.effort ?? 'default', ...over }));
  return build(id, { title: s.title, prompt: s.prompt, at, archived: !!s.archived, blind: !!s.blind, timeLimitMin: 30, effort: s.effort ?? 'default', results });
});

// Versions kept before a follow-up or RUN AGAIN, per result (the server keeps them in versions/<n>/).
const versions = new Map<LabResultFull, LabVersion[]>();
function keepVersion(r: LabResultFull): number {
  const list = versions.get(r) ?? [];
  const { files: _f, build: _b, canBuild: _c, ...was } = structuredClone(r);
  list.push({ ...was, n: list.length + 1 });
  versions.set(r, list);
  return list.length;
}

// Its output changes: it leaves the ranking and the ones below move up (as the server does).
function unrank(t: LabTestFull, r: LabResultFull): void {
  for (const x of t.results) if (r.rank && x.rank > r.rank) x.rank--;
  Object.assign(r, { stars: 0, rank: 0 });
}

// The coffee page from MiniMax M3 left things out, so the owner followed it up once: version 1 is its first page.
const coffee = tests.find((t) => t.title === 'Coffee shop landing page')!;
const minimax = coffee.results[3];
const v1 = keepVersion(minimax);
Object.assign(minimax, {
  stars: 0,
  startedAt: coffee.at + 3_600_000,
  endedAt: coffee.at + 3_668_000,
  tokens: 18_400,
  reply: 'Added the opening hours under the menu and a map box with a pin. ORDER AHEAD is full width and easy to tap on a phone. The rest is as it was.',
  followUps: [{ text: 'You left out the opening hours and the map. Add both, and make the ORDER AHEAD button easy to tap on a phone.', at: coffee.at + 3_590_000, version: v1 }],
});

// A new result: WAITING, then RUNNING, then DONE with a short reply a few seconds later.
function launch(t: LabTestFull, m: LabModel): LabResultFull {
  const says = `Done. ${m.name} made the page for "${t.title}": it runs as it is, with no libraries.`;
  const r = result(m, 0, t.results.length, 0, '', { state: 'queued', startedAt: 0, endedAt: 0, tokens: 0, value: null, effort: '', files: [] });
  setTimeout(() => Object.assign(r, { state: 'running', startedAt: Date.now() }), 1200);
  setTimeout(() => Object.assign(r, { state: 'done', endedAt: Date.now(), tokens: 21_000 + t.results.length * 3300, effort: t.effort, reply: says, files: [{ path: 'index.html', bytes: 5100 }] }), 6500);
  return r;
}

export function demoLabApi<T>(path: string, method: string, body: unknown = {}): Promise<T> {
  const reply = (v: unknown) => new Promise<T>((ok) => setTimeout(() => ok(structuredClone(v) as T), 120));
  const no = (msg: string) => Promise.reject(new Error(msg));
  const b = body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const [route, query = ''] = path.split('?');
  const parts = route.split('/').map(decodeURIComponent);
  if (parts[0] === 'models') return reply({ models: MODELS, notes: [] });
  if (parts[0] === 'prompts') return reply({ prompts: promptLibrary(tests) });
  if (parts[0] === 'storage') return reply({ tests: tests.filter((t) => !t.archived).length, archived: tests.filter((t) => t.archived).length, bytes: 41_000_000, junkBytes: 12_000_000 });
  if (parts[0] === 'junk') return reply({ removed: 0 });
  if (parts[0] !== 'tests') return no('Not found.');
  if (parts.length === 1) {
    if (method === 'GET') return reply({ tests: tests.filter((t) => t.archived === new URLSearchParams(query).has('archived')).sort((a, c) => c.at - a.at) });
    const n = b as LabNewTest;
    const at = Date.now();
    const t = build(`${stamp(at)}-${slug(n.title || n.prompt.split('\n')[0])}`, { title: n.title || n.prompt.split('\n')[0].slice(0, 60), prompt: n.prompt.trim(), at, archived: false, blind: n.blind, timeLimitMin: n.timeLimitMin, effort: n.effort ?? 'default', results: [] });
    t.results = n.models.map((id) => launch(t, byId(id)));
    tests.push(t);
    return reply({ id: t.id });
  }
  const t = tests.find((x) => x.id === parts[1]);
  if (!t) return no('No such test.');
  const r = t.results.find((x) => x.dir === parts[3]);
  if (parts.length === 2) {
    if (method === 'DELETE') return (tests.splice(tests.indexOf(t), 1), reply({ ok: true }));
    if (method === 'PATCH') {
      if (typeof b.blind === 'boolean') t.blind = b.blind;
      if (typeof b.revealed === 'boolean') t.revealed = b.revealed;
      if (Array.isArray(b.ranking)) for (const x of t.results) x.rank = b.ranking.indexOf(x.dir) + 1;
      return reply({ ok: true });
    }
    return reply(t);
  }
  if (parts[2] === 'models') {
    const ids: string[] = b.models ?? [];
    const twice = ids.filter((id) => t.results.some((x) => x.model === id));
    if (twice.length) return no(`Already in this test: ${twice.map((id) => byId(id).name).join(', ')}.`);
    if (t.results.length + ids.length > LAB_MAX_MODELS) return no(`A test holds ${LAB_MAX_MODELS} models at most (this one has ${t.results.length}).`);
    const added = ids.map((id) => launch(t, byId(id)));
    t.results.push(...added);
    return reply({ added: added.map((x) => x.dir) });
  }
  if (parts[2] === 'results' && r) {
    if (parts[4] === 'log') return reply({ log: '{"type":"demo","note":"This is demo data: no model ran."}', stderr: '', build: '' });
    if (parts[4] === 'versions') return reply({ versions: versions.get(r) ?? [] });
    if ((parts[4] === 'again' || parts[4] === 'followup') && (r.state === 'queued' || r.state === 'running')) return no('It is still running.');
    if (parts[4] === 'again') {
      const version = keepVersion(r);
      unrank(t, r);
      Object.assign(r, { state: 'done', error: '', reply: 'Done on the second try.', note: '', followUps: [] });
      return reply({ version });
    }
    if (parts[4] === 'followup') {
      const text = String(b.text ?? '').trim();
      if (!text) return no('Write what it should do first.');
      const version = keepVersion(r);
      unrank(t, r);
      Object.assign(r, { state: 'queued', startedAt: 0, endedAt: 0, tokens: 0, value: null, effort: '', error: '', reply: '', followUps: [...r.followUps, { text, at: Date.now(), version }] });
      setTimeout(() => Object.assign(r, { state: 'running', startedAt: Date.now() }), 1200);
      setTimeout(() => Object.assign(r, { state: 'done', endedAt: Date.now(), tokens: 12_600, effort: t.effort, reply: 'Done. I changed the page as you asked and kept the rest as it was.' }), 9000);
      return reply({ version });
    }
    if (typeof b.stars === 'number') r.stars = b.stars;
    if (typeof b.note === 'string') r.note = b.note;
    return reply({ ok: true });
  }
  if (parts[2] === 'archive' || parts[2] === 'restore') t.archived = parts[2] === 'archive';
  if (parts[2] === 'stop') for (const x of t.results) if (x.state === 'queued' || x.state === 'running') x.state = 'stopped';
  return reply({ ok: true, removed: 0 });
}
