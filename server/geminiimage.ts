import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { geminiImage, imagesDir } from './config.ts';
import { fileName, type PaintJob, type PaintResult } from './imagegen.ts';

// Gemini pictures (docs/IMAGE-MODEL.md, "Gemini"): Google's picture tool through its Antigravity CLI (`agy`), signed
// in with the user's Google AI Pro or Ultra account, so no API key and no cost per picture. Each picture is one
// `agy -p` run in an empty folder (with the attached picture as ref-1.png); the agent answers with the path of the
// picture it saved in its own folder (~/.gemini/antigravity-cli/brain/<chat>/), which is cut to the asked size and
// saved with the other pictures. It runs in Google's cloud: no GPU turn. One picture at a time per server.
// Each tab keeps its own Gemini chat (--conversation), so a follow-up ("the same picture, but...") changes the last
// one. The agent can hand the picture to a helper and end its turn before the picture exists, and the end of the run
// stops the helper (2026-10-22): so it is asked to wait, and once more in the same chat when no picture came back.

const sh = promisify(execFile);
const BRAIN = join(homedir(), '.gemini', 'antigravity-cli', 'brain');
const PICTURE = /\/[^\s"'\\]*\/\.gemini\/antigravity-cli\/brain\/[^\s"'\\]+\.(?:png|jpe?g|webp)/gi;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
function shape(w: number, h: number): string {
  const g = gcd(w, h);
  const ratio = `${w / g}:${h / g}`;
  return w === h ? `square (${ratio})` : w > h ? `landscape, aspect ratio ${ratio}` : `portrait, aspect ratio ${ratio}`;
}

// The words for the agent: one picture, the size, the user's own description, then only the file's path back.
export function geminiAsk(prompt: string, width: number, height: number, edit: boolean, previous = false): string {
  return [
    'Make exactly one picture with your image generation tool, and nothing else.',
    edit ? 'Give the tool the file ref-1.png in this folder as the picture to change or to follow: the request below says which.' : '',
    previous
      ? 'last.png in this folder is the last picture made in this chat. If the request changes that picture ("the same, but...", "make him...", "now at night"), give last.png to the tool as the picture to change and keep everything the request does not mention exactly as it is. If the request is a new picture, do not use last.png.'
      : '',
    `The picture is ${shape(width, height)}.`,
    `What to make: ${prompt}`,
    'Call the tool yourself and wait for its result in this turn; do not start background work.',
    'Do not run shell commands and do not write any other files.',
    'When the picture is done, reply with only the full path of the picture file.',
  ]
    .filter(Boolean)
    .join('\n');
}

// The picture the agent saved: the path in its answer first, then any its tools reported. Only files in its own folder.
export function pictureFrom(stdout: string, exists: (f: string) => boolean = existsSync): { file?: string; answer?: string; chat?: string } {
  let answer: string | undefined;
  let chat: string | undefined;
  for (const line of stdout.split('\n')) {
    try {
      const e = JSON.parse(line) as { event?: string; result?: { response?: string; status?: string; conversation_id?: string } };
      if (e.event === 'result') {
        answer = e.result?.response ?? `(status ${e.result?.status ?? 'unknown'})`;
        if (/^[\w-]{8,64}$/.test(e.result?.conversation_id ?? '')) chat = e.result!.conversation_id;
      }
    } catch {
      /* not a JSON line */
    }
  }
  const found = [...(answer ?? '').matchAll(PICTURE), ...stdout.matchAll(PICTURE)].map((m) => m[0]).filter((f) => f.startsWith(BRAIN) && exists(f));
  return { file: found[0], answer, chat };
}

const RETRY = 'No picture file came back. Make the picture now with your image generation tool, call it yourself and wait for its result in this turn. Then reply with only the full path of the picture file.';

export class GeminiPainter {
  private turn: Promise<unknown> = Promise.resolve();
  private chats = new Map<string, string>(); // tab -> Gemini chat id (in memory: a restart starts fresh chats)

  constructor(private model: string) {}

  paint(job: PaintJob): Promise<PaintResult> {
    job.update({ status: 'queued', phase: 'Waiting for the last Gemini picture' });
    const run = this.turn.then(() => this.run(job));
    this.turn = run.catch(() => {});
    return run;
  }

  private async run(job: PaintJob): Promise<PaintResult> {
    if (job.cancelled()) return { status: 'cancelled' };
    const o = job.opts;
    const startedAt = Date.now();
    job.update({ status: 'painting', phase: 'Gemini is painting', step: 0, startedAt });
    const dir = mkdtempSync(join(tmpdir(), 'phosphor-gemini-'));
    try {
      if (job.ref) writeFileSync(join(dir, 'ref-1.png'), job.ref);
      if (job.previous) writeFileSync(join(dir, 'last.png'), job.previous);
      const agy = async (ask: string, chat?: string) => {
        const { stdout } = await sh(geminiImage.bin, ['-p', ask, '--model', this.model, '--mode', 'accept-edits', '--output-format', 'stream-json', '--print-timeout', '600s', ...(chat ? ['--conversation', chat] : [])], {
          cwd: dir,
          env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, // no self-update in the middle of a picture
          timeout: 660_000,
          maxBuffer: 64 << 20,
        });
        return pictureFrom(stdout);
      };
      let got = await agy(geminiAsk(o.prompt, o.width, o.height, !!job.ref, !!job.previous), job.thread ? this.chats.get(job.thread) : undefined);
      if (!got.file && got.chat) {
        job.update({ phase: 'Gemini is painting (asked again)' });
        got = { ...(await agy(RETRY, got.chat)), chat: got.chat };
      }
      if (got.chat && job.thread) this.chats.set(job.thread, got.chat);
      const { file, answer } = got;
      if (!file) return { status: 'failed', error: `Gemini made no picture${answer ? `: ${answer.trim().slice(0, 300)}` : '.'}` };
      const { stdout: png } = await sh('magick', [file, '-resize', `${o.width}x${o.height}^`, '-gravity', 'center', '-extent', `${o.width}x${o.height}`, 'png:-'], { encoding: 'buffer', maxBuffer: 64 << 20 });
      mkdirSync(imagesDir, { recursive: true });
      const name = fileName(o.prompt, o.seed, new Date(startedAt));
      const path = join(imagesDir, name);
      writeFileSync(path, png as unknown as Buffer);
      return { status: 'done', file: name, path, ms: Date.now() - startedAt };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'failed', error: /ENOENT/.test(msg) ? `Antigravity CLI is not installed (${geminiImage.bin}).` : `Gemini failed: ${msg.split('\n')[0].slice(0, 300)}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
