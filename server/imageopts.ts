// Words in an image prompt that set the picture's shape and settings (docs/IMAGE-MODEL.md). They can stand anywhere
// in the text and are taken out of the prompt; anything else that starts with "--" stays in it.
//   --wide 16:9   --tall 9:16   --square 1:1 (default)   --size WxH
//   --hd  twice the pixels per side (2K, the model's own size; about 6x slower)
//   --best  the full model, 30 steps (about 5x slower than the default 8-step Turbo)   --steps N   --seed N
// fast: Turbo (the default; --best turns it off). stepsSet: --steps was given.
// shaped: the text set the shape or size (an edit otherwise keeps the attached picture's shape).
export type ImageOptions = { prompt: string; width: number; height: number; seed: number; steps: number; stepsSet: boolean; fast: boolean; hd: boolean; shaped: boolean; notes: string[] };

// Sizes of about one megapixel, sides divisible by 32 (the engine needs 16; the model was shown multiples of 32).
const SHAPES: Record<string, [number, number]> = { square: [1024, 1024], wide: [1344, 768], tall: [768, 1344] };
export const STEPS = 30; // the full model (--best); the model card says 40, 30 looked the same here and is faster
export const FAST_STEPS = 8; // Turbo's fixed schedule
const MAX_SIDE = 2752; // the model's largest trained side (16:9 at 2K)

export function parseImageOptions(text: string, rand: () => number = Math.random): ImageOptions {
  const notes: string[] = [];
  let shape: string | null = null;
  let size: [number, number] | null = null;
  let hd = false;
  let best = false;
  let steps: number | null = null;
  let seed: number | null = null;
  const words = text.split(/(\s+)/); // keeps the spaces, so the prompt's own line breaks stay
  const keep: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const m = /^--([a-z]+)$/i.exec(w);
    if (!m) {
      keep.push(w);
      continue;
    }
    const name = m[1].toLowerCase();
    // The value after an option: the next word that is not a space.
    const value = (): string | undefined => {
      const v = words[i + 2];
      if (v === undefined || !v) return undefined;
      i += 2;
      return v;
    };
    if (name in SHAPES) shape = name;
    else if (name === 'hd') hd = true;
    else if (name === 'best') best = true;
    else if (name === 'steps' || name === 'seed' || name === 'size') {
      const v = value();
      if (name === 'size') {
        const s = /^(\d+)x(\d+)$/i.exec(v ?? '');
        if (s) size = [Number(s[1]), Number(s[2])];
        else notes.push(`--size wants WIDTHxHEIGHT, like 1280x720 (got "${v ?? ''}").`);
      } else if (v !== undefined && /^\d+$/.test(v)) {
        if (name === 'steps') steps = Number(v);
        else seed = Number(v);
      } else notes.push(`--${name} wants a whole number (got "${v ?? ''}").`);
    } else keep.push(w);
  }
  let [width, height] = size ?? SHAPES[shape ?? 'square'];
  if (hd) [width, height] = [width * 2, height * 2];
  const fit = fitSize(width, height);
  if (fit[0] !== width || fit[1] !== height) notes.push(`Size set to ${fit[0]}x${fit[1]} (sides 256 to ${MAX_SIDE}, divisible by 32).`);
  [width, height] = fit;
  if (steps !== null && (steps < 1 || steps > 100)) {
    notes.push('--steps is 1 to 100.');
    steps = Math.min(100, Math.max(1, steps));
  }
  if (seed !== null && seed > 2 ** 31 - 1) {
    notes.push('--seed is 0 to 2147483647.');
    seed = 2 ** 31 - 1;
  }
  return {
    prompt: keep.join('').replace(/[ \t]{2,}/g, ' ').trim(),
    width,
    height,
    seed: seed ?? Math.floor(rand() * 2 ** 31),
    steps: steps ?? (best ? STEPS : FAST_STEPS),
    stepsSet: steps !== null,
    fast: !best,
    hd,
    shaped: !!(size || shape),
    notes,
  };
}

// Sides divisible by 32, between 256 and MAX_SIDE, the shape kept as well as it can.
export function fitSize(w: number, h: number): [number, number] {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const side = (x: number) => Math.min(MAX_SIDE, Math.max(256, Math.round((x * scale) / 32) * 32));
  return [side(w), side(h)];
}

// An attached picture to edit: the result keeps its shape at about one megapixel (or 4 with --hd).
export function editSize(w: number, h: number, hd: boolean): [number, number] {
  const target = (hd ? 4 : 1) * 1024 * 1024;
  const k = Math.sqrt(target / (w * h));
  return fitSize(w * k, h * k);
}

// Width and height from a PNG, JPEG, GIF or WebP file's header; undefined for anything else.
export function imageSize(b: Buffer): [number, number] | undefined {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (kind === 'VP8L') {
      const v = b.readUInt32LE(21);
      return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1];
    }
    if (kind === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
    return undefined;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the segments to the first start-of-frame (SOF0-SOF15, not DHT/JPG/DAC).
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + len;
    }
  }
  return undefined;
}
