import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { VideoEngine, VideoJob } from './imagegen.ts';
import { imageSize, parseImageOptions, type ImageOptions } from './imageopts.ts';

// The local video model (scripts/setup-video-model.sh, docs/VIDEO-MODEL.md) on the image model's engine:
//   Wan 2.2 TI2V 5B makes a clip from words, or from an attached photo (its first frame), at 24 fps;
//   Wan 2.1 VACE 1.3B changes an attached clip at 16 fps: the clip's outlines (ffmpeg's edge filter) guide the new
//   clip and its first frame is the reference for the look of the people and things in it.
// The engine writes WebM; ffmpeg turns it into an H.264 MP4, which every browser and phone plays.

const sh = promisify(execFile);

export const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
export const STEPS = 20; // default
export const BEST_STEPS = 40; // --best
const CFG = 5;
const FPS = 24; // Wan 2.2 5B
const EDIT_FPS = 16; // Wan 2.1
const FRAMES = 49; // about 2 s at 24 fps
const LONG_FRAMES = 97; // --long: about 4 s
const MAX_FRAMES = 121; // 5 s at 24 fps: the 5B model's longest
const EDIT_MAX_FRAMES = 81; // 5 s at 16 fps
const MAX_SIDE = 1280;
// Sizes: about 0.4 megapixel (480p) by default, 0.9 (720p, the 5B model's own size) with --hd. Sides divisible by 32.
const SHAPES: Record<string, [number, number]> = { wide: [832, 480], tall: [480, 832], square: [640, 640] };
const HD_SHAPES: Record<string, [number, number]> = { wide: [1280, 704], tall: [704, 1280], square: [960, 960] };
// The Wan models' own negative prompt (their makers' default, in Chinese as trained): over-saturated, static, blurry,
// subtitles, worst quality, JPEG artifacts, extra fingers, bad hands and faces, deformed limbs, cluttered background...
const NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';

export type VideoOptions = ImageOptions & { frames: number; framesSet: boolean };

// The image words (--wide --tall --square --size --hd --best --steps --seed), with video sizes, plus
// --long (about 4 s) and --frames N (rounded to 4n+1, the models' frame grid).
export function parseVideoOptions(text: string, rand: () => number = Math.random): VideoOptions {
  let frames: number | null = null;
  let long = false;
  const notes: string[] = [];
  const rest = text
    .replace(/(^|\s)--long(?=\s|$)/gi, () => {
      long = true;
      return ' ';
    })
    .replace(/(^|\s)--frames(?:\s+(\S+))?(?=\s|$)/gi, (_m, _s, v?: string) => {
      if (v && /^\d+$/.test(v)) frames = Number(v);
      else notes.push(`--frames wants a whole number (got "${v ?? ''}").`);
      return ' ';
    });
  const o = parseImageOptions(rest, rand);
  const hd = o.hd;
  const shape = /(^|\s)--(wide|tall|square)(?=\s|$)/i.exec(rest)?.[2]?.toLowerCase();
  const sized = /(^|\s)--size\s+\d+x\d+/i.test(rest);
  if (!sized) [o.width, o.height] = (hd ? HD_SHAPES : SHAPES)[shape ?? 'wide'];
  else [o.width, o.height] = fitVideo(o.width, o.height);
  // parseImageOptions' size notes speak of picture sizes; ours replace them.
  o.notes = o.notes.filter((n) => !n.startsWith('Size set to'));
  if (sized) notes.push(`Clip size: ${o.width}x${o.height} (sides up to ${MAX_SIDE}, divisible by 32).`);
  if (!o.stepsSet) o.steps = o.fast ? STEPS : BEST_STEPS;
  const want = frames ?? (long ? LONG_FRAMES : FRAMES);
  return { ...o, notes: [...o.notes, ...notes], frames: grid(want, MAX_FRAMES), framesSet: frames !== null || long };
}

// Frame counts the Wan models take: 4n+1, at least 5.
const grid = (n: number, max: number) => Math.min(max - ((max - 1) % 4), Math.max(5, Math.round((n - 1) / 4) * 4 + 1));

function fitVideo(w: number, h: number): [number, number] {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const side = (x: number) => Math.min(MAX_SIDE, Math.max(256, Math.round((x * k) / 32) * 32));
  return [side(w), side(h)];
}

// An attached photo or clip: the clip keeps its shape at the default (or --hd) size's area.
export function keepShape(w: number, h: number, hd: boolean): [number, number] {
  const [a, b] = (hd ? HD_SHAPES : SHAPES).wide;
  const k = Math.sqrt((a * b) / (w * h));
  return fitVideo(w * k, h * k);
}

const body = (o: VideoOptions, fps: number, extra: Record<string, unknown>, flowShift?: number) => ({
  prompt: o.prompt,
  negative_prompt: NEGATIVE,
  width: o.width,
  height: o.height,
  seed: o.seed,
  video_frames: o.frames,
  fps,
  sample_params: { sample_method: 'euler', sample_steps: o.steps, ...(flowShift ? { flow_shift: flowShift } : {}), guidance: { txt_cfg: CFG } },
  // No tiled VAE decode: it crashed the engine (SIGSEGV, 2026-11-17). Whole, 25 frames at 832x480 peaked at 14.7 GB.
  output_format: 'webm',
  ...extra,
});

// Words, or words and a photo (its first frame): Wan 2.2 5B. The photo's shape is kept unless the words set one.
export function makeJob(engine: VideoEngine, o: VideoOptions, photo?: Buffer): VideoJob {
  if (photo && !o.shaped) {
    const s = imageSize(photo);
    if (s) [o.width, o.height] = keepShape(s[0], s[1], o.hd);
  }
  // Flow shift 3: stable-diffusion.cpp's Wan 2.2 5B examples.
  return { engine, body: body(o, FPS, photo ? { init_image: photo.toString('base64') } : {}, 3), finish: toMp4 };
}

// Words and a clip: Wan 2.1 VACE. Up to 5 s of the clip (81 frames at 16 fps) at the clip's shape; its outlines
// guide the motion and layout, its first frame the look.
export async function editJob(engine: VideoEngine, o: VideoOptions, clip: string): Promise<{ job: VideoJob; notes: string[] }> {
  const notes: string[] = [];
  const probe = await sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', clip]).catch(() => null);
  if (!probe) throw new Error('ffprobe could not read the clip.');
  const info = JSON.parse(probe.stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
  const w = info.streams?.[0]?.width;
  const h = info.streams?.[0]?.height;
  if (!w || !h) throw new Error('No video track found in the clip.');
  if (!o.shaped) [o.width, o.height] = keepShape(w, h, o.hd);
  const seconds = Number(info.format?.duration) || 0;
  if (seconds > EDIT_MAX_FRAMES / EDIT_FPS + 0.1) notes.push(`Only the first ${Math.round(EDIT_MAX_FRAMES / EDIT_FPS)} seconds of the clip are used.`);
  const dir = mkdtempSync(join(tmpdir(), 'phosphor-vace-'));
  try {
    const fit = `fps=${EDIT_FPS},scale=${o.width}:${o.height}:force_original_aspect_ratio=increase,crop=${o.width}:${o.height}`;
    await sh('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `${fit},edgedetect=low=0.1:high=0.3`, '-frames:v', String(EDIT_MAX_FRAMES), join(dir, 'e%04d.png')]);
    await sh('ffmpeg', ['-v', 'error', '-i', clip, '-vf', fit, '-frames:v', '1', join(dir, 'first.png')]);
    const edges = readdirSync(dir).filter((f) => f.startsWith('e')).sort();
    if (edges.length < 5) throw new Error('The clip is too short (under a third of a second).');
    o.frames = grid(o.framesSet ? Math.min(o.frames, edges.length) : edges.length, Math.min(EDIT_MAX_FRAMES, edges.length));
    const control = edges.slice(0, o.frames).map((f) => readFileSync(join(dir, f)).toString('base64'));
    const first = readFileSync(join(dir, 'first.png')).toString('base64');
    return { job: { engine, body: body(o, EDIT_FPS, { init_image: first, control_frames: control, vace_strength: 1 }), finish: toMp4 }, notes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The engine's WebM as an H.264 MP4 (plays everywhere, also on iPhones); the WebM itself if ffmpeg fails.
async function toMp4(webm: Buffer): Promise<{ data: Buffer; ext: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'phosphor-clip-'));
  try {
    writeFileSync(join(dir, 'in.webm'), webm);
    await sh('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, 'in.webm'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', join(dir, 'out.mp4')]);
    return { data: readFileSync(join(dir, 'out.mp4')), ext: 'mp4' };
  } catch {
    return { data: webm, ext: 'webm' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const isClip = (name: string) => VIDEO_EXT.test(extname(name));
