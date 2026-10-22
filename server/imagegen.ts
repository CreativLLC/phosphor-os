import { execFile } from 'node:child_process';
import { createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ImageItem, Painting } from '../shared/protocol.ts';
import { DATA_DIR, imageModel, imagesDir } from './config.ts';
import { Gpu, type GpuUser } from './gpu.ts';
import { FAST_STEPS, type ImageOptions } from './imageopts.ts';
import { freeChatModels, setChatTurn } from './localrelay.ts';

// The local image model (scripts/setup-image-model.sh, docs/IMAGE-MODEL.md): a stable-diffusion.cpp server, started
// with its systemd user unit when a picture is asked for and stopped after a while idle (it holds about 18 GB of RAM
// and the card). One picture at a time; the GPU turns (server/gpu.ts) hand the card over between it and the chat
// models, never in the middle of a request.

export type Engine = {
  up(): Promise<boolean>; // answers on its port
  start(): Promise<void>;
  stop(): Promise<void>;
  fetch: typeof fetch;
  freeChat(): Promise<void>; // the chat models give the card back
};

export type PaintJob = {
  opts: ImageOptions;
  ref?: Buffer; // the picture to edit
  update: (fields: Partial<ImageItem>) => void;
  cancelled: () => boolean; // asked before it starts; a picture being painted cannot be stopped (the engine has no cancel for it)
};
export type PaintResult = { status: 'done'; file: string; path: string; ms: number } | { status: 'failed'; error: string } | { status: 'cancelled' };

const sh = promisify(execFile);

export class Painter {
  readonly gpu: Gpu;
  private queued = 0;
  private now: { phase: string; step: number; steps: number; startedAt: number } | null = null;
  private idleTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private engine: Engine,
    private cfg: { url: string; label: string; dir: string; idleMs: number; turbo: string; busyFile?: string; pollMs?: number; startWaitMs?: number },
  ) {
    this.gpu = new Gpu((to) => this.handOver(to));
  }

  // The card changes hands: to the image model, every chat model unloads; to the chats, the engine stops.
  private async handOver(to: GpuUser): Promise<void> {
    if (to === 'image') await this.engine.freeChat();
    else await this.engine.stop();
  }

  // SYS panel: what is being painted, or null.
  painting(): Painting | null {
    if (!this.now && !this.queued) return null;
    const n = this.now ?? { phase: 'Waiting for the GPU', step: 0, steps: 0, startedAt: Date.now() };
    return { model: this.cfg.label, phase: n.phase, step: n.step, steps: n.steps, ms: Date.now() - n.startedAt, queued: this.queued };
  }

  async paint(job: PaintJob): Promise<PaintResult> {
    clearTimeout(this.idleTimer);
    this.queued++;
    job.update({ status: 'queued', phase: 'Waiting for the GPU' });
    const release = await this.gpu.acquire('image');
    this.queued--;
    const startedAt = Date.now();
    try {
      if (job.cancelled()) return { status: 'cancelled' };
      const o = job.opts;
      const set = (phase: string, step = 0) => {
        this.now = { phase, step, steps: o.steps, startedAt };
        job.update({ status: 'painting', phase, step, startedAt });
      };
      if (!(await this.engine.up())) {
        set('Starting the image engine');
        await this.engine.start();
        if (!(await this.waitUp(this.cfg.startWaitMs ?? 300_000))) return { status: 'failed', error: 'The image engine did not start. Its log: journalctl --user -u phosphor-image' };
      }
      set('Reading the prompt');
      // scripts/local-model.sh unload waits while this file is there, instead of stopping the engine mid-picture.
      if (this.cfg.busyFile) writeFileSync(this.cfg.busyFile, String(process.pid));
      const png = await this.run(o, job.ref, (step) => set(step >= o.steps ? 'Finishing' : 'Painting', step));
      mkdirSync(this.cfg.dir, { recursive: true });
      const file = fileName(o.prompt, o.seed, new Date(startedAt));
      const path = join(this.cfg.dir, file);
      writeFileSync(path, png);
      return { status: 'done', file, path, ms: Date.now() - startedAt };
    } catch (e) {
      return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.now = null;
      if (this.cfg.busyFile) rmSync(this.cfg.busyFile, { force: true });
      release();
      this.idleSoon();
    }
  }

  private async waitUp(ms: number): Promise<boolean> {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (await this.engine.up()) return true;
      await sleep(this.cfg.pollMs ?? 2000);
    }
    return false;
  }

  // One job on the engine's own queue (POST /sdcpp/v1/img_gen), then its status until it ends.
  private async run(o: ImageOptions, ref: Buffer | undefined, step: (n: number) => void): Promise<Buffer> {
    // Turbo: the LoRA from the model's makers, without CFG, at its own 8-step schedule.
    const turbo = o.fast && !!this.cfg.turbo;
    const body = {
      prompt: o.prompt,
      width: o.width,
      height: o.height,
      seed: o.seed,
      batch_count: 1,
      ref_images: ref ? [ref.toString('base64')] : [],
      sample_params: {
        sample_method: 'euler',
        sample_steps: o.steps,
        ...(turbo && o.steps === FAST_STEPS ? { custom_sigmas: TURBO_SIGMAS } : {}),
        guidance: { txt_cfg: turbo ? 1 : CFG },
      },
      lora: turbo ? [{ path: this.cfg.turbo, multiplier: 1 }] : [],
      // The cheapest preview (a straight projection of the latents): the only way the engine reports its steps.
      preview: 'proj',
      preview_interval: 1,
      output_format: 'png',
    };
    const f = this.engine.fetch;
    const r = await f(new URL('/sdcpp/v1/img_gen', this.cfg.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const sub = (await r.json().catch(() => ({}))) as { id?: string; error?: { message?: string } | string };
    if (!r.ok || !sub.id) throw new Error(`The image engine refused the job: ${typeof sub.error === 'string' ? sub.error : (sub.error?.message ?? r.status)}`);
    for (const end = Date.now() + 30 * 60_000; Date.now() < end; ) {
      await sleep(this.cfg.pollMs ?? 700);
      const j = (await (await f(new URL(`/sdcpp/v1/jobs/${sub.id}`, this.cfg.url), { signal: AbortSignal.timeout(10_000) })).json()) as EngineJob;
      if (j.status === 'completed') {
        const b64 = j.result?.images?.[0]?.b64_json;
        if (!b64) throw new Error('The image engine finished without a picture.');
        return Buffer.from(b64, 'base64');
      }
      if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.error?.message || `The image engine says: ${j.status}`);
      if (j.status === 'generating' && j.preview?.step) step(j.preview.step);
    }
    throw new Error('The picture took over 30 minutes; gave up waiting.');
  }

  // Idle for a while: stop the engine (frees its RAM and the card). Takes the card's turn, so never mid-picture;
  // skipped when a chat has had the card since (its hand-over stopped the engine already).
  private idleSoon(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.queued) return;
      void this.gpu.acquireIfLast('image').then(async (release) => {
        if (!release) return;
        try {
          if (!this.queued) await this.engine.stop();
        } finally {
          release();
        }
      });
    }, this.cfg.idleMs);
    this.idleTimer.unref?.();
  }
}

type EngineJob = { status?: string; result?: { images?: { b64_json?: string }[] }; error?: { message?: string }; preview?: { step?: number } | null };

// Guidance for the full model (stable-diffusion.cpp's Qwen-Image 2.1 example uses 6; see docs/IMAGE-MODEL.md).
const CFG = 4;
// Qwen-Image 2.1 Turbo's fixed 8-step schedule (stable-diffusion.cpp's "qwen-image-2.1-turbo" sigmas).
const TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 2026-10-19_211502_a-lighthouse-at-sunset_42.png: sorts by time, says what it is.
export function fileName(prompt: string, seed: number, at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${stamp}_${words || 'picture'}_${seed}.png`;
}

// The real engine: its unit and port.
function systemEngine(url: string, unit: string): Engine {
  return {
    async up() {
      try {
        return (await fetch(new URL('/sdcpp/v1/capabilities', url), { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    },
    async start() {
      if (unit) await sh('systemctl', ['--user', 'start', unit]);
    },
    async stop() {
      if (unit) await sh('systemctl', ['--user', 'stop', unit]).catch(() => {});
    },
    fetch,
    freeChat: () => freeChatModels(),
  };
}

export const painter = imageModel ? new Painter(systemEngine(imageModel.url, imageModel.unit), { ...imageModel, busyFile: join(DATA_DIR, 'image-busy') }) : undefined;
// With an image model, chat requests through the relay take their turn on the card too.
if (painter) setChatTurn(() => painter.gpu.acquire('chat'));

// What the SYS panel shows: undefined without an image model.
export const painting = (): Painting | null | undefined => painter?.painting();

// GET /api/images/<file>: a saved picture (the chat shows it; SAVE downloads it). Names as fileName makes them only.
export function serveImage(res: ServerResponse, file: string): void {
  const path = /^[\w.-]+\.png$/.test(file) && !file.startsWith('.') ? join(imagesDir, file) : '';
  const size = path ? statSync(path, { throwIfNoEntry: false })?.size : undefined;
  if (!size) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': size,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  createReadStream(path).pipe(res);
}
