// Pixel sprite engine. Owner: art team.
// Sprites are tiny text grids. Each character is one tone of the phosphor screen:
//   '.' transparent   '+' dim (--ph-dim)   '#' main (--ph)   '@' bright (--ph-bright)
//   'o' screen black (--bg), for eyes and mouths cut into a shape
//   'x' erase (makes lower layers transparent again)
//   'c' accent color (--accent): the one splash of color, used for the operator's face
// A theme may set --sprite-dim / --sprite / --sprite-bright / --sprite-face instead (themes.ts).
// The richer scene art (sprites/mascot.ts, troupe.ts, room.ts) also uses shading ramps, dark to light:
//   'k' outline   'z' 'Z' backdrop   '-' deep   'w' white-hot   'C' accent shade
//   '1' '2' '3' skin   '4' '5' '6' cloth   '7' '8' '9' metal
//   'r' 'y' fire   'b' 'B' sky   'n' 'N' wood   'g' 'G' leaf
// Each theme maps them with --sprite-<name> tokens (sprites/palette.css). Unset ones fall back to the
// phosphor tones above, so old sprites and a theme without the tokens still draw.
// Frames are drawn at 1 canvas pixel per grid cell and scaled up by CSS (image-rendering: pixelated).
// One shared clock drives every sprite at 8 frames a second. It sleeps when the page is hidden,
// skips sprites that are off screen, and shows a still frame when the user asks for reduced motion.

export type Part = readonly string[];
export type Layer = readonly [Part, number, number] | false | null | undefined;
export type Grid = { readonly w: number; readonly h: number; readonly px: Uint8Array };
export type Anim = {
  readonly frames: readonly Grid[];
  readonly ends: readonly number[]; // cumulative ticks: frame i shows while (t mod total) < ends[i]
  readonly total: number;
  readonly still: number; // frame shown with reduced motion
};

export const TICK_MS = 125;

// Ramp slots after the six base codes: [char, token name, fallback from the base tones].
type Rgba = number[];
type Base = { deep: Rgba; dim: Rgba; main: Rgba; bright: Rgba; bg: Rgba; face: Rgba };
const mix = (a: Rgba, b: Rgba, t: number): Rgba => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)).concat(255);
export const RAMPS: readonly (readonly [string, string, (b: Base) => Rgba])[] = [
  ['k', 'outline', (b) => mix(b.bg, b.deep, 0.35)],
  ['z', 'wall', (b) => mix(b.bg, b.dim, 0.12)],
  ['Z', 'wall-lit', (b) => mix(b.bg, b.dim, 0.24)],
  ['-', 'deep', (b) => b.deep],
  ['w', 'white', (b) => mix(b.bright, [255, 255, 255, 255], 0.5)],
  ['C', 'face-dim', (b) => mix(b.face, b.bg, 0.55)],
  ['1', 'skin-1', (b) => b.dim],
  ['2', 'skin-2', (b) => b.main],
  ['3', 'skin-3', (b) => b.bright],
  ['4', 'cloth-1', (b) => b.deep],
  ['5', 'cloth-2', (b) => b.dim],
  ['6', 'cloth-3', (b) => b.main],
  ['7', 'metal-1', (b) => b.deep],
  ['8', 'metal-2', (b) => b.dim],
  ['9', 'metal-3', (b) => b.main],
  ['r', 'fire-1', (b) => b.main],
  ['y', 'fire-2', (b) => b.bright],
  ['b', 'sky-1', (b) => b.dim],
  ['B', 'sky-2', (b) => b.main],
  ['n', 'wood-1', (b) => b.deep],
  ['N', 'wood-2', (b) => b.dim],
  ['g', 'leaf-1', (b) => b.dim],
  ['G', 'leaf-2', (b) => b.main],
];

const CODE: Record<string, number> = { '+': 1, '#': 2, '@': 3, o: 4, x: 5, c: 6, ...Object.fromEntries(RAMPS.map(([ch], i) => [ch, 7 + i])) };

// The whole palette by code: base tones as given (rgba arrays), ramps from `token(name)` or their fallback.
export function buildPalette(base: Omit<Base, 'deep'>, token: (name: string) => Rgba | null): Rgba[] {
  const b: Base = { ...base, deep: mix(base.dim, base.bg, 0.5) };
  const bg = [...b.bg.slice(0, 3), 255]; // knock-outs are always solid
  return [[0, 0, 0, 0], b.dim, b.main, b.bright, bg, [0, 0, 0, 0], b.face, ...RAMPS.map(([, name, fall]) => token(name) ?? fall(b))];
}

// part`...` or part('...'): one row per line, surrounding spaces ignored.
export function part(src: string | TemplateStringsArray): Part {
  const text = typeof src === 'string' ? src : src.join('');
  const rows = text
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (import.meta.env?.DEV && rows.some((r) => r.length !== rows[0].length)) console.warn('sprite part has uneven rows:\n' + rows.join('\n'));
  return rows;
}

export function mirror(p: Part): Part {
  return p.map((r) => [...r].reverse().join(''));
}

// Stack layers onto an empty w x h grid. Later layers paint over earlier ones.
export function frame(w: number, h: number, layers: readonly Layer[]): Grid {
  const px = new Uint8Array(w * h);
  for (const l of layers) {
    if (!l) continue;
    const [p, x0, y0] = l;
    for (let y = 0; y < p.length; y++) {
      const yy = y0 + y;
      if (yy < 0 || yy >= h) continue;
      const row = p[y];
      for (let x = 0; x < row.length; x++) {
        const c = CODE[row[x]];
        if (!c) continue;
        const xx = x0 + x;
        if (xx < 0 || xx >= w) continue;
        px[yy * w + xx] = c === 5 ? 0 : c;
      }
    }
  }
  return { w, h, px };
}

// hold: ticks per frame (one number for all, or one per frame).
export function anim(frames: Grid[], hold: number | number[] = 1, still = 0): Anim {
  const ends: number[] = [];
  let total = 0;
  frames.forEach((_, i) => {
    total += Math.max(1, Array.isArray(hold) ? (hold[i] ?? 1) : hold);
    ends.push(total);
  });
  return { frames, ends, total, still };
}

// ---------- Palette (read from the theme tokens) ----------

let palette: number[][] = [];
let paletteKey = '';
let images = new WeakMap<Grid, ImageData>();
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

// Returns true when the colors changed.
function readPalette(): boolean {
  const cs = getComputedStyle(document.documentElement);
  const tok = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  // A theme can give the crew its own colors (--sprite-*); the phosphor themes use the screen colors.
  const list = [tok('--sprite-dim', tok('--ph-dim', '#a87400')), tok('--sprite', tok('--ph', '#ffb000')), tok('--sprite-bright', tok('--ph-bright', '#ffd27a')), tok('--bg', '#0b0700'), tok('--sprite-face', tok('--accent', '#3fe0ff'))];
  const ramps = RAMPS.map(([, name]) => cs.getPropertyValue(`--sprite-${name}`).trim());
  const key = [...list, ...ramps].join('|');
  if (key === paletteKey) return false;
  paletteKey = key;
  const [dim, main, bright, bg, face] = list.map(rgba);
  palette = buildPalette({ dim, main, bright, bg, face }, (name) => {
    const v = ramps[RAMPS.findIndex((r) => r[1] === name)];
    return v ? rgba(v) : null;
  });
  images = new WeakMap();
  return true;
}

function image(g: Grid): ImageData {
  let img = images.get(g);
  if (!img) {
    img = new ImageData(g.w, g.h);
    const d = img.data;
    for (let i = 0; i < g.px.length; i++) {
      const c = palette[g.px[i]];
      d[i * 4] = c[0];
      d[i * 4 + 1] = c[1];
      d[i * 4 + 2] = c[2];
      d[i * 4 + 3] = c[3];
    }
    images.set(g, img);
  }
  return img;
}

// ---------- Sprites and the shared clock ----------

const sprites = new Set<Sprite>();
const byCanvas = new WeakMap<Element, Sprite>();
const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
// GAME MODE stops the clock too (gamemode.ts calls repaintAll when it changes).
const still = () => !!reduced?.matches || document.documentElement.dataset.game === 'on';
let timer = 0;
let raf = 0;

const now = () => Math.floor(performance.now() / TICK_MS);

const seen =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          const s = byCanvas.get(e.target);
          if (!s) continue;
          s.onScreen = e.isIntersecting;
          if (s.onScreen) s.paint();
        }
        wake();
      })
    : null;

export class Sprite {
  readonly canvas: HTMLCanvasElement;
  onScreen = true;
  private ctx: CanvasRenderingContext2D | null;
  private current?: Anim;
  private start = 0;
  private shown: Grid | null = null;

  constructor(cls = 'sprite') {
    this.canvas = document.createElement('canvas');
    this.canvas.className = cls;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d');
    sprites.add(this);
    byCanvas.set(this.canvas, this);
    seen?.observe(this.canvas);
  }

  // Switch animation. The same Anim object again is a no-op, so callers can call this on every update.
  play(a: Anim): void {
    if (a === this.current) return;
    this.current = a;
    this.start = now();
    const g = a.frames[0];
    if (this.canvas.width !== g.w || this.canvas.height !== g.h) {
      this.canvas.width = g.w;
      this.canvas.height = g.h;
      this.canvas.style.setProperty('--sw', String(g.w));
      this.canvas.style.setProperty('--sh', String(g.h));
      this.shown = null;
    }
    this.paint();
    wake();
  }

  paint(force = false): void {
    const a = this.current;
    if (!a || !this.ctx) return;
    let g: Grid;
    if (still() || a.frames.length === 1) g = a.frames[a.still] ?? a.frames[0];
    else {
      const t = (((now() - this.start) % a.total) + a.total) % a.total;
      let i = 0;
      while (t >= a.ends[i]) i++;
      g = a.frames[i];
    }
    if (g === this.shown && !force) return;
    if (!paletteKey) readPalette();
    this.ctx.putImageData(image(g), 0, 0);
    this.shown = g;
  }

  get moving(): boolean {
    return !!this.current && this.current.frames.length > 1;
  }

  dispose(): void {
    sprites.delete(this);
    seen?.unobserve(this.canvas);
  }
}

function animating(): boolean {
  if (still() || document.hidden) return false;
  for (const s of sprites) if (s.onScreen && s.moving) return true;
  return false;
}

// Wait until the next tick boundary, then draw inside one animation frame.
function wake(): void {
  if (timer || raf || !animating()) return;
  const wait = TICK_MS - (performance.now() % TICK_MS) + 1;
  timer = window.setTimeout(() => {
    timer = 0;
    raf = requestAnimationFrame(step);
  }, wait);
}

function step(): void {
  raf = 0;
  for (const s of sprites) if (s.onScreen) s.paint();
  wake();
}

export function repaintAll(): void {
  readPalette();
  for (const s of sprites) s.paint(true);
  wake();
}

function themeMaybeChanged(): void {
  if (readPalette()) for (const s of sprites) s.paint(true);
}

if (typeof window !== 'undefined') {
  window.addEventListener('themechange', () => {
    themeMaybeChanged();
    // Some palettes settle a frame later (class swaps, transitions): check again.
    requestAnimationFrame(themeMaybeChanged);
  });
  // Belt and braces: also notice a palette flip that forgot to fire the event.
  new MutationObserver(() => requestAnimationFrame(themeMaybeChanged)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-phosphor', 'data-theme', 'class', 'style'],
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      for (const s of sprites) s.paint();
      wake();
    }
  });
  reduced?.addEventListener('change', () => {
    for (const s of sprites) s.paint(true);
    wake();
  });
}
