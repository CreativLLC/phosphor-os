// Model Lab MOCKUP data (docs/MODEL-LAB.md): sample tests, models and results, so the LAB screens can be seen
// and clicked before the real runner exists. Nothing here runs a model. The real lab reads data/lab/ instead.

export type AppId = 'claude' | 'agy' | 'codex' | 'opencode' | 'local';
export type State = 'running' | 'done' | 'failed' | 'limit';

export interface Model {
  id: string;
  name: string;
  app: AppId;
  old?: boolean; // an older model: in past tests, not in the NEW TEST list
}

export interface LabFile {
  name: string;
  kb: number;
}

export interface Result {
  model: string; // Model id
  state: State;
  startedAt: number;
  ms: number; // run time; for a running result, the time it will take (mockup)
  tokens: number;
  cost: number | null; // dollars; null = on a plan
  stars: number; // 0 = not rated yet
  note: string;
  reply: string;
  files: LabFile[];
  page: string; // the index.html it made (srcdoc), '' when it made no page
}

export interface Test {
  id: string;
  title: string;
  prompt: string;
  at: number;
  archived: boolean;
  blind: boolean;
  timeLimitMin: number;
  junkMb: number; // node_modules and build caches (REMOVE JUNK)
  results: Result[];
}

export const APPS: Record<AppId, { name: string; account: string }> = {
  claude: { name: 'Claude Code', account: 'Claude plan' },
  agy: { name: 'Antigravity', account: 'Google AI Pro' },
  codex: { name: 'Codex', account: 'ChatGPT' },
  opencode: { name: 'opencode', account: 'OpenCode Go' },
  local: { name: 'Claude Code', account: 'This PC' },
};

export const MODELS: Model[] = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', app: 'claude' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', app: 'claude' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', app: 'claude' },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', app: 'agy' },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', app: 'agy' },
  { id: 'agy-claude-opus-5-5', name: 'Claude Opus 5.5', app: 'agy' },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', app: 'codex' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', app: 'codex' },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', app: 'opencode' },
  { id: 'glm-5.3', name: 'GLM 5.3', app: 'opencode' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', app: 'opencode' },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', app: 'opencode' },
  { id: 'minimax-m3', name: 'MiniMax M3', app: 'opencode' },
  { id: 'grok-4.7', name: 'Grok 4.7', app: 'opencode' },
  { id: 'qwen3.6-35b', name: 'Qwen3.6 35B', app: 'local' },
  { id: 'gemma-4', name: 'Gemma 4', app: 'local' },
  { id: 'claude-opus-5', name: 'Claude Opus 5', app: 'claude', old: true },
  { id: 'kimi-k3', name: 'Kimi K3', app: 'opencode', old: true },
  { id: 'glm-5.2', name: 'GLM 5.2', app: 'opencode', old: true },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', app: 'codex', old: true },
];

export const modelById = (id: string): Model => MODELS.find((m) => m.id === id) ?? { id, name: id, app: 'opencode' };

// ------------------------------------------------------------ pages the "models" made

const PALETTES = [
  ['#101418', '#7CFC00', '#ff4d4d'],
  ['#1b1030', '#ff8de6', '#ffe14d'],
  ['#0c1a24', '#4dd2ff', '#ffb84d'],
  ['#14110b', '#e8d8a8', '#e0603c'],
  ['#0a0a0a', '#ffffff', '#33ccff'],
  ['#062014', '#5cff9d', '#ff5c8a'],
];

function snake(p: string[], speed: number, label: string): string {
  return `<body style="margin:0;background:${p[0]};display:grid;place-items:center;height:100vh;font:13px monospace;color:${p[1]}"><div style="text-align:center"><canvas id=c width=320 height=240 style="max-width:96vw;max-height:84vh;border:2px solid ${p[1]}"></canvas><div>${label}</div></div><script>
const c=document.getElementById('c'),x=c.getContext('2d'),S=16,W=20,H=15;let s=[[5,7],[4,7],[3,7]],d=[1,0],f=[12,7],n=0;
function step(){const h=s[0];const nx=Math.sign(f[0]-h[0]),ny=Math.sign(f[1]-h[1]);if(nx&&d[0]!==-nx)d=[nx,0];else if(ny&&d[1]!==-ny)d=[0,ny];
const q=[(h[0]+d[0]+W)%W,(h[1]+d[1]+H)%H];s.unshift(q);if(q[0]===f[0]&&q[1]===f[1]){n++;f=[Math.random()*W|0,Math.random()*H|0]}else s.pop();
x.fillStyle='${p[0]}';x.fillRect(0,0,320,240);x.fillStyle='${p[2]}';x.fillRect(f[0]*S+3,f[1]*S+3,S-6,S-6);x.fillStyle='${p[1]}';
for(const r of s)x.fillRect(r[0]*S+1,r[1]*S+1,S-2,S-2);x.fillText('SCORE '+n,6,14)}for(let i=0;i<40;i++)step();setInterval(step,${speed})</script></body>`;
}

function hexagon(p: string[], balls: number, spin: number): string {
  return `<body style="margin:0;background:${p[0]};height:100vh;display:grid;place-items:center"><canvas id=c width=300 height=300 style="max-width:96vw;max-height:96vh"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d'),R=120;let a=0;const b=[];for(let i=0;i<${balls};i++)b.push({x:150+(i*17)%60-30,y:110+(i*11)%40,vx:(i%3)-1,vy:0});
function f(){a+=${spin};x.fillStyle='${p[0]}';x.fillRect(0,0,300,300);x.strokeStyle='${p[1]}';x.lineWidth=3;x.beginPath();
for(let i=0;i<=6;i++){const t=a+i*Math.PI/3;x.lineTo(150+R*Math.cos(t),150+R*Math.sin(t))}x.stroke();
for(const o of b){o.vy+=.25;o.x+=o.vx;o.y+=o.vy;const dx=o.x-150,dy=o.y-150,dd=Math.hypot(dx,dy);if(dd>R*.86-8){const nx=dx/dd,ny=dy/dd,v=o.vx*nx+o.vy*ny;o.vx-=1.9*v*nx;o.vy-=1.9*v*ny;o.vx+=-ny*${spin}*40;o.vy+=nx*${spin}*40;o.x=150+nx*(R*.86-8);o.y=150+ny*(R*.86-8)}
x.fillStyle='${p[2]}';x.beginPath();x.arc(o.x,o.y,8,0,7);x.fill()}requestAnimationFrame(f)}f()</script></body>`;
}

function landing(p: string[], name: string, line: string): string {
  return `<body style="margin:0;font-family:system-ui,sans-serif;background:${p[0]};color:${p[1]}"><nav style="display:flex;justify-content:space-between;padding:14px 22px;font-weight:700"><span>${name}</span><span style="opacity:.7;font-weight:400">Menu&nbsp;&nbsp;Prices&nbsp;&nbsp;Login</span></nav>
<section style="padding:40px 22px 24px"><h1 style="font-size:34px;margin:0 0 10px;line-height:1.05">${line}</h1><p style="opacity:.75;margin:0 0 18px">Order ahead, skip the line, and earn a free cup every week.</p><a style="background:${p[2]};color:${p[0]};padding:10px 18px;border-radius:24px;text-decoration:none;font-weight:700">Get the app</a></section>
<section style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:10px 22px">${['Fast', 'Fresh', 'Free refills'].map((t) => `<div style="border:1px solid ${p[1]}40;border-radius:12px;padding:12px"><b>${t}</b><br><small style="opacity:.7">Short text about it.</small></div>`).join('')}</section></body>`;
}

function starfield(p: string[], n: number, speed: number): string {
  return `<body style="margin:0;background:${p[0]};overflow:hidden"><canvas id=c></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');let W,H;function z(){W=c.width=innerWidth;H=c.height=innerHeight}z();onresize=z;
const s=[];for(let i=0;i<${n};i++)s.push({x:Math.random()*2-1,y:Math.random()*2-1,z:Math.random()});
function f(){x.fillStyle='${p[0]}';x.fillRect(0,0,W,H);x.fillStyle='${p[1]}';for(const o of s){o.z-=${speed};if(o.z<=0.01){o.z=1;o.x=Math.random()*2-1;o.y=Math.random()*2-1}
const k=1/o.z,px=W/2+o.x*k*W/4,py=H/2+o.y*k*H/4,r=Math.max(.5,2.2*(1-o.z));x.fillRect(px,py,r,r)}requestAnimationFrame(f)}f()</script></body>`;
}

function pixelCat(p: string[], ears: number): string {
  const px = [
    '..X.....X..'.replace(/X/g, ears ? 'X' : '.'),
    '.XXX...XXX.',
    '.XXXXXXXXX.',
    'XXOXXXXXOXX',
    'XXXXXNXXXXX',
    'XXXXXXXXXXX',
    '.XXXXXXXXX.',
    '..XX...XX..',
  ];
  let r = '';
  px.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== '.') r += `<rect x="${x}" y="${y}" width="1" height="1" fill="${ch === 'O' ? p[2] : ch === 'N' ? p[2] : p[1]}"/>`;
  }));
  return `<body style="margin:0;background:${p[0]};height:100vh;display:grid;place-items:center"><svg viewBox="-1 -1 13 10" style="width:70vmin;shape-rendering:crispEdges">${r}</svg></body>`;
}

function ticTacToe(p: string[], moves: string): string {
  const cells = [...moves].map((m) => `<div style="display:grid;place-items:center;border:2px solid ${p[1]}55;font:700 44px system-ui;color:${m === 'X' ? p[1] : p[2]}">${m === '.' ? '' : m}</div>`).join('');
  return `<body style="margin:0;background:${p[0]};color:${p[1]};font-family:system-ui;height:100vh;display:grid;place-items:center"><div style="text-align:center"><div style="display:grid;grid-template-columns:repeat(3,72px);grid-template-rows:repeat(3,72px)">${cells}</div><p>Your turn (X)</p></div></body>`;
}

// ------------------------------------------------------------ sample tests

// Fixed seed: the same sample data on every load.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86400000;
const PAGE_FILES = (kb: number): LabFile[] => [{ name: 'index.html', kb }];

type Spec = {
  id: string;
  title: string;
  prompt: string;
  daysAgo: number;
  models: string[];
  page?: (i: number, p: string[]) => string;
  replies?: string[];
  stars: number[]; // one per model, 0 = not rated
  archived?: boolean;
  junkMb?: number;
  files?: LabFile[];
  states?: Partial<Record<number, State>>;
};

const SPECS: Spec[] = [
  {
    id: 't14',
    title: 'Retro snake game',
    prompt: 'Make a snake game in one HTML file. Arrow keys to move, a score in the corner, and a retro arcade look. No libraries.',
    daysAgo: 0,
    models: ['claude-opus-5-5', 'gemini-4-argon', 'gpt-6-luna', 'kimi-k3.1-pro', 'glm-5.3', 'qwen3.6-35b'],
    page: (i, p) => snake(p, [110, 140, 90, 120, 160, 200][i], ['ARROWS TO PLAY', 'PRESS START', 'HIGH SCORE 120', 'SNAKE 1986', 'GAME READY', 'snake'][i]),
    replies: ['I made index.html: a snake game with a score, speed-up every 5 apples and a scanline effect.', 'Done. Open index.html. Space pauses; the snake wraps around the edges.', 'index.html is ready. I added a high-score that is kept in localStorage.', 'Created index.html with a neon arcade style and sound effects you can turn off.', 'The game is in index.html.', 'I wrote index.html.'],
    stars: [5, 4, 4, 5, 0, 0],
    states: { 5: 'running' },
  },
  {
    id: 't13',
    title: 'Balls in a spinning hexagon',
    prompt: 'Write one HTML file: 6 balls bounce inside a spinning hexagon, with gravity and friction. The balls must never leave the hexagon.',
    daysAgo: 4,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'gemini-4-argon', 'gpt-6-luna', 'deepseek-v4-pro'],
    page: (i, p) => hexagon(p, [6, 6, 5, 6, 4][i], [0.01, 0.014, 0.02, 0.008, 0.03][i]),
    replies: ['index.html: the walls push the balls along as they spin, so the balls ride the edges.', 'Built it with simple circle checks against each wall.', 'Done. Balls lose 2% speed on each bounce.', 'index.html is ready. The hexagon turns at 30 degrees a second.', 'Here is the file.'],
    stars: [5, 4, 3, 4, 2],
  },
  {
    id: 't12',
    title: 'Coffee app landing page',
    prompt: 'Make a landing page for a made-up coffee app called Brewly. One HTML file, mobile-first, a clear button to get the app.',
    daysAgo: 12,
    models: ['claude-opus-5-5', 'gemini-4-argon', 'kimi-k3.1-pro', 'grok-4.7'],
    page: (i, p) => landing(p, 'Brewly', ['Better mornings, one tap away', 'Your coffee is ready when you are', 'Skip the line. Keep the vibe.', 'Coffee. Faster.'][i]),
    replies: ['index.html with a hero, three features and a footer. Colors pass contrast checks.', 'Done: a warm, simple page.', 'I made index.html and kept it under 6 KB.', 'Landing page is in index.html.'],
    stars: [4, 5, 4, 3],
  },
  {
    id: 't11',
    title: 'CPU cache for a 10-year-old',
    prompt: 'Explain how a CPU cache works to a 10-year-old. Under 120 words.',
    daysAgo: 26,
    models: ['claude-sonnet-5-5', 'gemini-3.8-flash', 'gpt-5.6-terra', 'qwen3.8-max', 'gemma-4'],
    replies: [
      'Think of your brain doing homework. Your books are on a shelf across the room (that is the memory). Walking there every time is slow. So you keep the books you use most on your desk (that is the cache). Most of the time, what you need is already on the desk, so you finish much faster.',
      'A CPU is like a chef. The fridge is far away, so the chef keeps the most used things on the counter. That counter is the cache: small, but very close.',
      'Imagine a library. The cache is the small cart of books next to you. You check the cart first, because it is faster than walking to the shelves.',
      'The cache is a tiny, super-fast memory next to the processor. It keeps copies of data the processor used recently, because it will probably need them again soon.',
      'A cache stores data so the CPU can get it fast.',
    ],
    stars: [5, 4, 5, 3, 2],
    files: [{ name: 'answer.md', kb: 1 }],
  },
  {
    id: 't10',
    title: 'Fix the date bug',
    prompt: 'This function says Feb 29 2027 is a valid date. Fix it and add tests.\n\nfunction isValid(y, m, d) { return d >= 1 && d <= [31,29,31,30,31,30,31,31,30,31,30,31][m - 1]; }',
    daysAgo: 39,
    models: ['claude-opus-5-5', 'gpt-6-luna', 'kimi-k3.1-pro', 'deepseek-v4-pro'],
    replies: [
      'The table always allows 29 days in February. I check for a leap year:\n\nconst leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;\n\nand use 28 or 29 from it. Added 9 tests in date.test.js; all pass.',
      'Fixed: February now uses leap-year rules. Tests in date.test.js (6 pass).',
      'Leap years fixed, plus a check that m is 1-12. 8 tests, all pass.',
      'Changed February to 28 + leap(y). Tests added.',
    ],
    stars: [5, 4, 5, 3],
    files: [{ name: 'date.js', kb: 1 }, { name: 'date.test.js', kb: 2 }, { name: 'package.json', kb: 1 }],
    junkMb: 182,
  },
  {
    id: 't9',
    title: 'Four lines about rain',
    prompt: 'Write a four-line poem about rain on a tin roof. No rhyme.',
    daysAgo: 55,
    models: ['claude-opus-5-5', 'claude-haiku-5-5', 'gemini-4-argon', 'gpt-6-luna', 'kimi-k3.1-pro', 'minimax-m3'],
    replies: [
      'The roof keeps count of every drop,\na thousand small hands asking in.\nI lie awake and do not answer.\nBy morning, the tin has learned to sing.',
      'Tin roof, soft drums.\nThe night is busy.\nI am not.\nSleep comes in on the water.',
      'Rain writes on the roof\nin a language of nails and pennies.\nThe house listens.\nSo do I.',
      'A steady applause on the metal\nfor nothing in particular.\nThe gutter takes its bow.\nI pull the blanket higher.',
      'Every drop a small knock,\nno one at the door.\nThe tin roof talks all night\nto the dark field.',
      'Rain on tin is loud and calm,\nit fills the room with sound,\nI listen as it falls,\nand then I fall asleep.',
    ],
    stars: [5, 4, 4, 4, 5, 2],
    files: [{ name: 'answer.md', kb: 1 }],
  },
  {
    id: 't8',
    title: 'Starfield screensaver',
    prompt: 'Make a starfield screensaver in one HTML file, like the old Windows one. It must fill the screen.',
    daysAgo: 83,
    models: ['claude-sonnet-5-5', 'gemini-3.8-flash', 'glm-5.3', 'qwen3.6-35b'],
    page: (i, p) => starfield(p, [400, 250, 300, 150][i], [0.006, 0.01, 0.008, 0.004][i]),
    replies: ['index.html: 400 stars, they speed up when you move the mouse.', 'Starfield in index.html.', 'Done, full screen, no libraries.', 'I made index.html.'],
    stars: [5, 3, 4, 3],
  },
  {
    id: 't7',
    title: 'SQL: top customers',
    prompt: 'Tables: customers(id, name), orders(id, customer_id, total, created_at). Write SQL for the top 5 customers by total spend in 2026.',
    daysAgo: 104,
    models: ['claude-opus-5-5', 'gpt-5.6-terra', 'qwen3.8-max'],
    replies: [
      "SELECT c.id, c.name, SUM(o.total) AS spend\nFROM customers c\nJOIN orders o ON o.customer_id = c.id\nWHERE o.created_at >= '2026-01-01' AND o.created_at < '2027-01-01'\nGROUP BY c.id, c.name\nORDER BY spend DESC\nLIMIT 5;",
      "SELECT name, SUM(total) spend FROM customers JOIN orders ON orders.customer_id = customers.id WHERE YEAR(created_at) = 2026 GROUP BY name ORDER BY spend DESC LIMIT 5;",
      "SELECT c.name, SUM(o.total) FROM customers c, orders o WHERE c.id = o.customer_id AND o.created_at LIKE '2026%' GROUP BY c.name ORDER BY 2 DESC LIMIT 5;",
    ],
    stars: [5, 4, 2],
    files: [{ name: 'answer.md', kb: 1 }],
  },
  {
    id: 't6',
    title: 'Tic-tac-toe with an AI',
    prompt: 'Make tic-tac-toe in one HTML file where the computer never loses.',
    daysAgo: 143,
    models: ['claude-opus-5', 'gemini-4-argon', 'gpt-5.6-luna', 'kimi-k3'],
    page: (i, p) => ticTacToe(p, ['X.O.X...O', 'XO..X..O.', '.X..O..X.', 'O.X.X.O..'][i]),
    replies: ['Minimax in index.html; the computer never loses.', 'index.html, with an EASY / HARD switch.', 'Done.', 'index.html is ready.'],
    stars: [5, 4, 3, 4],
    states: { 2: 'limit' },
  },
  {
    id: 't5',
    title: 'Summarize an article',
    prompt: 'Summarize the attached article in 5 bullet points for a busy manager.',
    daysAgo: 188,
    models: ['claude-opus-5', 'gemini-3.8-flash', 'glm-5.2'],
    replies: ['- Sales grew 12%\n- Costs grew faster (18%)\n- Two new markets opened\n- Hiring is paused\n- The next report is in March', '- Revenue up\n- Costs up more\n- New markets\n- Hiring paused\n- Next update March', '- The company is growing\n- But spending a lot\n- More regions\n- Fewer new staff\n- More news soon'],
    stars: [5, 4, 3],
    files: [{ name: 'answer.md', kb: 1 }],
  },
  {
    id: 't4',
    title: 'Pixel-art cat in SVG',
    prompt: 'Draw a pixel-art cat face as an SVG in one HTML file. 11 by 8 pixels.',
    daysAgo: 258,
    models: ['claude-opus-5', 'gemini-4-argon', 'gpt-5.6-luna', 'kimi-k3', 'glm-5.2'],
    page: (i, p) => pixelCat(p, i % 2),
    replies: ['index.html with an 11x8 SVG cat.', 'Here is the cat.', 'Cat in index.html.', 'Done: a cat with green eyes.', 'index.html.'],
    stars: [4, 5, 3, 4, 2],
    states: { 4: 'failed' },
  },
  {
    id: 't3',
    title: 'Three days in Tokyo',
    prompt: 'Plan 3 days in Tokyo for a family with a 6-year-old. Short.',
    daysAgo: 314,
    models: ['claude-opus-5', 'gemini-3.8-flash', 'kimi-k3'],
    replies: ['Day 1: Ueno Zoo, then the park. Day 2: teamLab Planets, then Odaiba. Day 3: a Ghibli Museum morning, Kichijoji in the afternoon.', 'Day 1 Asakusa, Day 2 Disney, Day 3 Shibuya.', 'Day 1 zoo, Day 2 science museum, Day 3 Tokyo Tower.'],
    stars: [5, 3, 4],
    files: [{ name: 'answer.md', kb: 1 }],
    archived: true,
  },
  {
    id: 't2',
    title: 'Friendly email rewrite',
    prompt: 'Rewrite this email so it sounds friendly but firm: "Your invoice is late. Pay now."',
    daysAgo: 340,
    models: ['claude-opus-5', 'gpt-5.6-luna', 'glm-5.2'],
    replies: ['Hi Sam, a quick note: the invoice from March 3 is now past due. Could you send payment this week? Thanks so much!', 'Hello! Just a reminder that your invoice is overdue. Please pay at your earliest convenience.', 'Dear customer, your invoice is late. Please pay soon. Thank you.'],
    stars: [5, 3, 2],
    files: [{ name: 'answer.md', kb: 1 }],
    archived: true,
  },
  {
    id: 't1',
    title: 'Say hello (first test)',
    prompt: 'Say hello and tell me which model you are.',
    daysAgo: 362,
    models: ['claude-opus-5', 'gpt-5.6-luna', 'kimi-k3'],
    replies: ['Hello! I am Claude Opus 5.', 'Hi! I am a GPT model running in Codex.', 'Hello, I am Kimi.'],
    stars: [3, 3, 3],
    files: [{ name: 'answer.md', kb: 1 }],
    archived: true,
  },
];

export function sampleTests(): Test[] {
  const r = rng(42);
  const now = Date.now();
  return SPECS.map((s) => {
    const at = now - s.daysAgo * DAY - Math.floor(r() * 6 * 3600000) - (s.daysAgo === 0 ? 0 : 3600000);
    const results = s.models.map((model, i): Result => {
      const state: State = s.states?.[i] ?? 'done';
      const p = PALETTES[(i + s.id.length) % PALETTES.length];
      const page = s.page && state === 'done' ? s.page(i, p) : '';
      const ms = Math.round((s.page ? 40 + r() * 200 : 8 + r() * 40) * 1000);
      return {
        model,
        state,
        startedAt: state === 'running' ? now - 15000 : at,
        ms: state === 'running' ? 45000 : ms,
        tokens: state === 'done' ? Math.round((s.page ? 6000 + r() * 30000 : 800 + r() * 4000) / 10) * 10 : state === 'running' ? 4200 : Math.round(r() * 2000),
        cost: null,
        stars: state === 'done' ? (s.stars[i] ?? 0) : 0,
        note: state === 'done' && s.stars[i] === 5 && i % 2 === 0 ? 'Best of the bunch.' : '',
        reply: state === 'failed' ? 'Stopped: the time limit (10 min) ran out.' : state === 'limit' ? 'Stopped: the plan limit was reached. It resets in 3h.' : state === 'running' ? '' : (s.replies?.[i] ?? ''),
        files: state === 'done' ? (s.files ?? PAGE_FILES(Math.round(3 + r() * 9))) : [],
        page,
      };
    });
    return { id: s.id, title: s.title, prompt: s.prompt, at, archived: !!s.archived, blind: false, timeLimitMin: 10, junkMb: s.junkMb ?? 0, results };
  });
}

// A finished result for a model in a test the owner starts in the mockup: a page or a short reply.
export function fakeFinish(res: Result, prompt: string, seed: number): void {
  const r = rng(seed);
  const p = PALETTES[seed % PALETTES.length];
  const wantsPage = /html|page|game|draw|svg|screensaver/i.test(prompt);
  res.state = 'done';
  res.tokens = Math.round((wantsPage ? 5000 + r() * 25000 : 600 + r() * 3000) / 10) * 10;
  if (wantsPage) {
    res.page = [snake(p, 120, 'MOCKUP PAGE'), hexagon(p, 5, 0.012), starfield(p, 300, 0.008), pixelCat(p, 1)][seed % 4];
    res.files = PAGE_FILES(Math.round(3 + r() * 8));
    res.reply = 'MOCKUP: a real model would make this page from your prompt. This one is sample art.';
  } else {
    res.files = [{ name: 'answer.md', kb: 1 }];
    res.reply = 'MOCKUP: the real reply from the model shows here. Nothing was sent to a model.';
  }
}
