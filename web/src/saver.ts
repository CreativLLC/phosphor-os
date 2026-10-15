import '@fontsource/vt323';
import './theme.css';
import './themes/lcars.css';
import './saver.css';
import { crewAnim, type CrewKind } from './sprites/crew.ts';
import { TICK_MS, type Anim, type Grid } from './sprites/engine.ts';
import { operatorAnim } from './sprites/operator.ts';

// THE SCREENSAVER of the whole computer. A page of its own (built by vite.saver.config.ts into web/dist/saver/),
// opened full screen on every monitor by the shell plugin os/omarchy/screensaver/ after the PC has been idle for
// 5 minutes. It needs no server and shows nothing personal: the same flight over a vector grid under the stars,
// the pixel crew asleep on the deck, a big clock, a status line. The plugin ends it on any key, mouse or scroll
// (the compositor's idle signal); the page also ends itself on its own input, so it can never stay stuck.
// Colors: the launcher passes the theme in the URL hash (#t=amber|green|lcars, or #c=ph,bright,dim,bg,hot for any other
// Omarchy theme); tokens and sprite colors are the app's own (theme.css, themes/lcars.css).
// Speed rules: one canvas; at most 30 frames a second (a timer, then one animation frame); nothing at all
// while the page is hidden; reduced motion = a still scene redrawn once a second. Static parts (sky, sun,
// vertical grid lines) and the text are drawn once into off-screen canvases and copied each frame.

const FRAME_MS = 1000 / 30;
const SLOW_MS = 1000;
const MAX_PIXELS = 2.6e6; // canvas size cap; bigger screens are scaled up by the browser

const html = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- Shown state ----------

let box: HTMLDivElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let loopTimer = 0;
let raf = 0;
let lastFrame = 0;
let due = 0; // when the next frame is due; steps of exactly 1/30 s, so jitter never adds up to more than 30 a second
let lastSec = -1;

let W = 0;
let H = 0;
let S = 1; // canvas pixels per CSS pixel
let hy = 0; // horizon
let cx = 0;
let opK = 4; // operator: canvas pixels per sprite cell
let crewK = 3;
let bigPx = 100;
let textY = 0;
let flight = 0; // grid scroll, 0..1

type Pal = { ph: string; bright: string; dim: string; bg: string; hot: string; font: string; glow: boolean; spr: number[][] };
let pal: Pal | null = null;
let sky: HTMLCanvasElement | null = null;
let text: HTMLCanvasElement | null = null;
const sprites = new Map<Grid, HTMLCanvasElement>();

type Star = { x: number; y: number; z: number };
let stars: Star[] = [];

type Actor = { anim: Anim; x: number; v: number; depth: number; phase: number; start: number };
let crew: Actor[] = [];
const STATUS = 'STANDBY';

// ---------- Colors (theme tokens only) ----------

let probe: CanvasRenderingContext2D | null = null;
function rgba(css: string): number[] {
  probe ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  if (!probe) return [255, 176, 0, 255];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  return [...probe.getImageData(0, 0, 1, 1).data];
}

// The theme comes in the URL hash from the launcher: t=amber|green|lcars (the pack's themes), or c=ph,bright,dim,bg,hot
// (six-digit hex, no #) for any other Omarchy theme, drawn on the amber tokens.
function applyTheme(): void {
  const q = new URLSearchParams(location.hash.slice(1));
  const t = q.get('t');
  const id = t === 'green' || t === 'lcars' ? t : 'amber';
  html.dataset.theme = id;
  html.dataset.phosphor = id === 'green' ? 'green' : 'amber';
  html.dataset.crt = id === 'lcars' ? 'off' : 'low';
  const c = (q.get('c') ?? '').split(',');
  if (id === 'amber' && !t && c.length === 5 && c.every((h) => /^[0-9a-f]{6}$/i.test(h))) {
    const [ph, bright, dim, bg, hot] = c.map((h) => `#${h}`);
    for (const [k, v] of Object.entries({ '--ph': ph, '--ph-bright': bright, '--ph-dim': dim, '--bg': bg, '--bg-hot': hot })) html.style.setProperty(k, v);
  }
}


function readPal(): void {
  const cs = getComputedStyle(html);
  const tok = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const ph = tok('--ph', '#ffb000');
  const bright = tok('--ph-bright', '#ffd68a');
  const dim = tok('--ph-dim', '#b07c08');
  const bg = tok('--bg', '#0b0700');
  // Same sprite colors as sprites/engine.ts (a theme may give the crew its own).
  const spr = [tok('--sprite-dim', dim), tok('--sprite', ph), tok('--sprite-bright', bright), bg, tok('--sprite-face', tok('--accent', '#3fe0ff'))].map(rgba);
  spr[3][3] = 255;
  pal = {
    ph,
    bright,
    dim,
    bg,
    hot: tok('--bg-hot', bg),
    font: tok('--font', 'monospace'),
    glow: html.dataset.crt !== 'off',
    spr: [[0, 0, 0, 0], spr[0], spr[1], spr[2], spr[3], [0, 0, 0, 0], spr[4]],
  };
  sprites.clear();
}

function spriteImage(g: Grid): HTMLCanvasElement {
  let c = sprites.get(g);
  if (c) return c;
  c = Object.assign(document.createElement('canvas'), { width: g.w, height: g.h });
  const img = new ImageData(g.w, g.h);
  for (let i = 0; i < g.px.length; i++) img.data.set(pal!.spr[g.px[i]], i * 4);
  c.getContext('2d')!.putImageData(img, 0, 0);
  sprites.set(g, c);
  return c;
}

function frameOf(a: Anim, start: number, now: number): Grid {
  if (reduced.matches || a.frames.length === 1) return a.frames[a.still] ?? a.frames[0];
  const t = (((Math.floor(now / TICK_MS) - start) % a.total) + a.total) % a.total;
  let i = 0;
  while (t >= a.ends[i]) i++;
  return a.frames[i];
}

// ---------- What the ship is doing ----------

// Nothing to report here (no link to any app): the crew rests on the deck, the operator idles.
function setCrew(): void {
  const specs: CrewKind[] = ['scout', 'engineer', 'librarian'];
  const tick = Math.floor(performance.now() / TICK_MS);
  crew = specs.map((kind, i) => {
    const depth = 0.6 + ((i * 0.37) % 0.4);
    const dir = i % 2 ? -1 : 1;
    return {
      anim: crewAnim(kind, 0, 'stopped'),
      x: ((i + 0.5) / specs.length) * W,
      v: dir * (34 + ((i * 7) % 5) * 7) * depth,
      depth,
      phase: i * 1.7,
      start: tick - i * 3,
    };
  });
  crew.sort((a, b) => a.depth - b.depth);
}


// ---------- Layout and cached layers ----------

function layout(): void {
  const cw = innerWidth;
  const ch = innerHeight;
  S = Math.min(devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / Math.max(1, cw * ch)));
  W = Math.max(1, Math.round(cw * S));
  H = Math.max(1, Math.round(ch * S));
  const portrait = H > W * 1.1;
  hy = Math.round(H * 0.6);
  cx = W / 2;
  const unit = Math.min(W, H);
  opK = Math.max(2, Math.round(unit / (portrait ? 130 : 190)));
  crewK = Math.max(2, Math.round(unit / (portrait ? 120 : 150)));
  bigPx = Math.round(portrait ? W * 0.25 : Math.min(W * 0.16, H * 0.2));
  textY = Math.round(H * (portrait ? 0.24 : 0.19));
  const n = Math.round(Math.min(180, (W * hy) / (4000 * S * S)));
  stars = Array.from({ length: n }, () => newStar(Math.random()));
}

function newStar(z = 1): Star {
  return { x: Math.random() * 2 - 1, y: 0.03 + Math.random() * 0.97, z: Math.max(0.05, z) };
}

// Sky glow, the sun on the horizon, the horizon line and the grid lines that run into the distance.
function renderSky(): void {
  if (!pal) return;
  sky ??= document.createElement('canvas');
  sky.width = W;
  sky.height = H;
  const g = sky.getContext('2d')!;
  g.fillStyle = pal.bg;
  g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(cx, hy, 0, cx, hy, Math.max(W, H) * 0.6);
  glow.addColorStop(0, pal.hot);
  glow.addColorStop(1, pal.bg);
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  // Sun: a half disc cut by gaps that widen toward the horizon.
  const R = Math.min(W, H) * 0.17;
  g.save();
  g.beginPath();
  g.arc(cx, hy, R, Math.PI, 0);
  g.closePath();
  g.clip();
  g.globalAlpha = 0.38;
  g.fillStyle = pal.dim;
  let y = hy - R;
  for (let i = 0; y < hy; i++) {
    const band = R * (0.16 - i * 0.012);
    const gap = R * (0.02 + i * 0.016);
    g.fillRect(cx - R, y, 2 * R, Math.max(1, band));
    y += Math.max(2, band) + gap;
  }
  g.restore();

  // Floor: grid lines of equal sideways spacing meet at the vanishing point.
  g.strokeStyle = pal.dim;
  g.lineWidth = Math.max(1, S);
  g.globalAlpha = 0.55;
  g.beginPath();
  const step = W * 0.085;
  for (let i = -16; i <= 16; i++) {
    const xb = cx + i * step;
    g.moveTo(cx + (xb - cx) / 40, hy + (H - hy) / 40);
    g.lineTo(cx + (xb - cx) * 1.3, H + (H - hy) * 0.3);
  }
  g.stroke();

  g.globalAlpha = 1;
  g.strokeStyle = pal.ph;
  g.lineWidth = Math.max(1, 2 * S);
  if (pal.glow) {
    g.shadowColor = pal.ph;
    g.shadowBlur = 10 * S;
  }
  g.beginPath();
  g.moveTo(0, hy);
  g.lineTo(W, hy);
  g.stroke();
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

// The clock block: time, date, status, hint. Redrawn once a second (blinking colon), copied every frame.
function renderText(now: Date): void {
  if (!pal) return;
  const small = Math.max(16 * S, Math.round(bigPx * 0.2));
  const h = Math.round(bigPx * 1.05 + small * 4.6);
  text ??= document.createElement('canvas');
  if (text.width !== W || text.height !== h) {
    text.width = W;
    text.height = h;
  }
  const g = text.getContext('2d')!;
  g.clearRect(0, 0, W, h);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  if (pal.glow) {
    g.shadowColor = pal.ph;
    g.shadowBlur = Math.round(bigPx * 0.07);
  }
  const blink = !reduced.matches && now.getSeconds() % 2 === 1;
  const parts = timeFmt.formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
  const ampm = parts.find((p) => p.type === 'dayPeriod')?.value.toUpperCase() ?? '';

  // Time: hour, colon and minutes drawn apart so the colon can blink without the digits moving.
  g.font = `${bigPx}px ${pal.font}`;
  g.fillStyle = pal.ph;
  const base = bigPx;
  const wH = g.measureText(hour).width;
  const wC = g.measureText(':').width;
  const wM = g.measureText(minute).width;
  let x = W / 2 - (wH + wC + wM) / 2;
  g.textAlign = 'left';
  g.fillText(hour, x, base);
  x += wH;
  g.globalAlpha = blink ? 0.25 : 1;
  g.fillText(':', x, base);
  g.globalAlpha = 1;
  x += wC;
  g.fillText(minute, x, base);
  if (ampm) {
    g.font = `${Math.round(bigPx * 0.26)}px ${pal.font}`;
    g.fillStyle = pal.dim;
    g.fillText(ampm, x + wM + bigPx * 0.06, base);
  }

  g.textAlign = 'center';
  g.font = `${small}px ${pal.font}`;
  g.fillStyle = pal.dim;
  let y = base + small * 1.5;
  g.fillText(dateFmt.format(now).replace(/,/g, '').toUpperCase(), W / 2, y);
  y += small * 1.45;
  g.fillStyle = pal.bright;
  g.fillText(STATUS, W / 2, y);
  y += small * 1.45;
  g.shadowBlur = 0;
  g.fillStyle = pal.dim;
  g.font = `${Math.round(small * 0.8)}px ${pal.font}`;
  g.fillText('PRESS ANY KEY', W / 2, y);
}

// ---------- Drawing ----------

function draw(nowMs: number): void {
  const g = ctx;
  if (!g || !pal || !sky || !text) return;
  g.drawImage(sky, 0, 0);

  // Stars stream out from the vanishing point; three brightness groups, one fill each.
  const groups: Star[][] = [[], [], []];
  for (const s of stars) groups[s.z > 0.66 ? 0 : s.z > 0.33 ? 1 : 2].push(s);
  g.fillStyle = pal.bright;
  groups.forEach((list, i) => {
    g.globalAlpha = [0.35, 0.6, 0.95][i];
    g.beginPath();
    for (const s of list) {
      const px = cx + (s.x / s.z) * W * 0.5;
      const py = hy - (s.y / s.z) * hy * 0.95;
      const r = Math.max(1, (1 - s.z) * 2.6 * S + S * 0.6);
      g.rect(px, py, r, r);
    }
    g.fill();
  });

  // Floor lines scroll toward you: depth z = 1 is the bottom edge, far lines crowd the horizon.
  g.strokeStyle = pal.dim;
  g.lineWidth = Math.max(1, S);
  for (let b = 0; b < 4; b++) {
    g.globalAlpha = [0.85, 0.6, 0.4, 0.22][b];
    g.beginPath();
    for (let n = 0; n < 28; n++) {
      const z = n + 1 - flight;
      if (z < 0.6 || Math.min(3, Math.floor(z / 4)) !== b) continue;
      const y = Math.round(hy + (H - hy) / z) + 0.5;
      if (y > H) continue;
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    g.stroke();
  }
  g.globalAlpha = 1;

  // Crew patrol the deck, farther ones smaller; they face the way they walk.
  g.imageSmoothingEnabled = false;
  const opH = 32 * opK;
  // Feet between a quarter and three quarters down the deck: far crew near the horizon, near crew in front.
  const floorTop = hy + (H - hy) * 0.22;
  const floorBottom = hy + (H - hy) * 0.72;
  for (const a of crew) {
    const k = Math.max(1, Math.round(crewK * a.depth));
    const img = spriteImage(frameOf(a.anim, a.start, nowMs));
    const w = img.width * k;
    const h = img.height * k;
    const bob = reduced.matches ? 0 : Math.sin(nowMs / 700 + a.phase) * k * 0.8;
    const y = Math.round(floorTop + (floorBottom - floorTop) * ((a.depth - 0.6) / 0.4) - h + bob);
    const x = Math.round(a.x - w / 2);
    if (a.v < 0) {
      g.save();
      g.translate(x + w, y);
      g.scale(-1, 1);
      g.drawImage(img, 0, 0, w, h);
      g.restore();
    } else g.drawImage(img, x, y, w, h);
  }

  // The operator at the console, front and center.
  const op = spriteImage(frameOf(operatorAnim('idle'), 0, nowMs));
  g.drawImage(op, Math.round(cx - (32 * opK) / 2), Math.round(H - opH - Math.max(8 * S, H * 0.025)), 32 * opK, opH);

  // Clock block, slowly wandering a little so nothing sits still on the screen for hours.
  const dx = Math.sin((nowMs / 47000) * Math.PI * 2) * W * 0.03;
  const dy = Math.sin((nowMs / 61000) * Math.PI * 2) * H * 0.015;
  g.drawImage(text, Math.round(dx), Math.round(textY - bigPx * 0.8 + dy));
}

function advance(dt: number): void {
  flight = (flight + dt * 0.9) % 1;
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    s.z -= dt * 0.085;
    const px = cx + (s.x / s.z) * W * 0.5;
    const py = hy - (s.y / s.z) * hy * 0.95;
    if (s.z <= 0.05 || px < -8 || px > W + 8 || py < -8) stars[i] = newStar();
  }
  for (const a of crew) {
    a.x += a.v * dt * S;
    const half = 12 * crewK;
    if (a.x > W + half) a.x = -half;
    else if (a.x < -half) a.x = W + half;
  }
}
function frame(nowMs: number): void {
  raf = 0;
  if (!box || document.hidden) return;
  const slow = reduced.matches;
  if (!slow && due && nowMs < due - 4) {
    raf = requestAnimationFrame(frame);
    return;
  }
  due = !slow && due && nowMs - due < 100 ? due + FRAME_MS : nowMs + FRAME_MS;
  const dt = lastFrame ? Math.min(0.1, (nowMs - lastFrame) / 1000) : 0;
  lastFrame = nowMs;
  const d = new Date();
  if (d.getSeconds() !== lastSec) {
    lastSec = d.getSeconds();
    renderText(d);
  }
  if (!slow) advance(dt);
  draw(nowMs);
  loop();
}

// A timer, then one animation frame: the page is not woken 144 times a second on a fast monitor.
function loop(): void {
  if (!box || document.hidden || loopTimer || raf) return;
  const slow = reduced.matches;
  const wait = slow ? SLOW_MS - (Date.now() % 1000) + 5 : Math.max(0, due - performance.now() - 4);
  loopTimer = window.setTimeout(() => {
    loopTimer = 0;
    raf = requestAnimationFrame(frame);
  }, wait);
}

function halt(): void {
  clearTimeout(loopTimer);
  cancelAnimationFrame(raf);
  loopTimer = 0;
  raf = 0;
  lastFrame = 0;
  due = 0;
}

function relayout(): void {
  if (!box) return;
  layout();
  const c = box.firstElementChild as HTMLCanvasElement;
  c.width = W;
  c.height = H;
  setCrew();
  renderSky();
  renderText(new Date());
  draw(performance.now());
}

// ---------- Wake ----------

const GRACE_MS = 3000; // the pointer is reported again when the window appears and goes full screen
const MOVE_PX = 4; // total pointer travel that counts as a real move
const shownAt = Date.now();
let travel = 0;

// Closing the window ends this page; launch.sh sees the window gone and closes the rest on the other monitors.
function wake(): void {
  window.close();
}

function onInput(e: Event): void {
  if (e.type === 'mousemove' || e.type === 'pointermove') {
    if (Date.now() - shownAt < GRACE_MS) return;
    const m = e as MouseEvent;
    travel += Math.abs(m.movementX) + Math.abs(m.movementY);
    if (travel < MOVE_PX) return;
  } else if (Date.now() - shownAt < 150) return;
  wake();
}

for (const t of ['keydown', 'mousedown', 'pointerdown', 'wheel', 'touchstart', 'mousemove']) window.addEventListener(t, onInput, { capture: true, passive: true });

// ---------- Show ----------

function show(): void {
  applyTheme();
  box = document.createElement('div');
  box.id = 'saver';
  const c = document.createElement('canvas');
  box.append(c);
  ctx = c.getContext('2d', { alpha: false });
  document.body.append(box);
  readPal();
  layout();
  c.width = W;
  c.height = H;
  setCrew();
  renderSky();
  renderText(new Date());
  window.addEventListener('resize', relayout);
  document.addEventListener('visibilitychange', () => (document.hidden ? halt() : loop()));
  reduced.addEventListener('change', () => {
    halt();
    loop();
  });
  // The pixel font may still be loading on a cold start.
  void document.fonts?.load(`${bigPx}px ${pal!.font}`).then(() => renderText(new Date()));
  if (!document.hidden) raf = requestAnimationFrame(frame);
}

show();
