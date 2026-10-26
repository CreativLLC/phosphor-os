import { tool } from '@anthropic-ai/claude-agent-sdk';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { DelegateCount, Effort, RouterResponse } from '../shared/protocol.ts';
import { clampEffort } from '../shared/router.ts';
import { DATA_DIR, localModel } from './config.ts';
import { painter } from './imagegen.ts';
import { LOCAL_RELAY_PORT } from './localrelay.ts';

// ROUTER (owner's ask 2026-10-25, docs/ROUTER-PLAN.md): the cloud chat stays the orchestrator and hands work to
// cheaper workers. ask_local: one job for the local model; the server reads the files itself, so their text never
// passes through Claude, which gets only the short answer. start_thread's worker: a thread chat on the local model or
// a cheaper Claude. The ledger counts what the local model did and the Claude tokens that kept off (data/router.json).
// A cheap cloud worker (OpenRouter or similar) would be a second runner beside runLocal, picked the same way.

type Local = NonNullable<typeof localModel>;
type Fetch = typeof fetch;

// On when a local model is set up, unless PHOSPHOR_ROUTER=off.
export const routerOn = (): boolean => !!localModel && process.env.PHOSPHOR_ROUTER !== 'off';

// Main-chat tools of this module, run without asking (read-only, inside the chat's folders); subagents are refused.
export const DELEGATE_TOOLS = ['mcp__phosphor__ask_local'];

// Appended to the system prompt of cloud chats when the router is on.
export const DELEGATE_HELP = `\n\nThis PC has a free local model, reached with the ask_local tool: it does one job and returns a short answer. Files you pass by path are read by the app and go only to that model; they never enter your context. Hand off when that saves tokens: summarizing or searching big files and logs (a few hundred lines or more), extracting or comparing across several files, sorting or labeling lists, first drafts you will edit. Do it yourself when the file is small, for exact counts, sums or math (a command such as grep -c does those right; the local model guesses), final decisions, security questions, exact code edits, or anything you cannot check. It is weaker than you: check what matters before you rely on it (a Grep or a short Read of the part it names). If it says DOWN or BUSY, do the job yourself.`;

// ---------------------------------------------------------------- files

export const CAPS = { files: 20, fileBytes: 4 << 20, totalChars: 240_000 };
// Never handed to a model: keys, logins, password stores (a .env example is fine), and any file with a private key in it.
const SECRET = /(^|[\\/])([^\\/]*\.env(?!\.(example|sample|template)$)(\.[^\\/]*)?|\.envrc|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials|\.?credentials\.json|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|[^\\/]*\.(pem|key|p12|pfx|kdbx|keystore|jks))$|(^|[\\/])\.(ssh|gnupg|aws|docker|kube)[\\/]/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const CHARS_PER_TOKEN = 4; // Claude tokens, estimated (plain text runs 3.5 to 4.5)
export const tokensOf = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

// real: the file's real path (the ledger's key); text: what the model gets, cut to the job's room when too long.
export type JobFile = { path: string; real: string; text: string; size: number; cut: boolean };

// Read the files of a job: relative paths start at the chat's folder; each must be inside one of `roots` after
// following links, a regular text file, and not look like a secret. Files share `room` characters in order; a
// file that does not fit is cut, and the ones after it are left out.
export function readJobFiles(paths: string[], cwd: string, roots: string[], room = CAPS.totalChars): { files: JobFile[]; problems: string[] } {
  const real = roots.flatMap((r) => {
    try {
      return [realpathSync(r)];
    } catch {
      return [];
    }
  });
  const inside = (p: string) => real.some((r) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
  const shown = (p: string) => (p.startsWith(cwd + sep) ? relative(cwd, p) : p);
  const files: JobFile[] = [];
  const problems: string[] = [];
  let left = room;
  for (const raw of paths.slice(0, CAPS.files)) {
    const abs = resolve(cwd, raw);
    let p: string;
    try {
      p = realpathSync(abs);
    } catch {
      problems.push(`${raw} (not found)`);
      continue;
    }
    if (!inside(p)) problems.push(`${raw} (outside this chat's folders)`);
    else if (SECRET.test(abs) || SECRET.test(p)) problems.push(`${raw} (looks like a secret file)`);
    else if (!statSync(p, { throwIfNoEntry: false })?.isFile()) problems.push(`${raw} (not a file)`);
    else if (left <= 0) problems.push(`${raw} (no room left in this job: ask about it in another one)`);
    else {
      // A file this user may not read, or one that changes meanwhile, is left out; the other files still go.
      let size: number;
      let buf: Buffer;
      try {
        size = statSync(p).size;
        buf = Buffer.alloc(Math.min(size, CAPS.fileBytes, left * 4));
        const fd = openSync(p, 'r');
        try {
          buf = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
        } finally {
          closeSync(fd);
        }
      } catch {
        problems.push(`${raw} (could not be read)`);
        continue;
      }
      const text = buf.toString('utf8');
      const bad = (text.match(/�/g)?.length ?? 0) > text.length / 100;
      if (buf.includes(0) || bad) {
        problems.push(`${raw} (not a text file)`);
        continue;
      }
      if (PRIVATE_KEY.test(text)) {
        problems.push(`${raw} (looks like a secret file)`);
        continue;
      }
      const cut = text.length > left || buf.length < size;
      const kept = text.slice(0, left);
      left -= kept.length;
      files.push({ path: shown(abs), real: p, text: kept, size, cut });
    }
  }
  if (paths.length > CAPS.files) problems.push(`${paths.length - CAPS.files} more files (at most ${CAPS.files} per job)`);
  return { files, problems };
}

// ---------------------------------------------------------------- one job at a time

export class Busy extends Error {}

// Local jobs run one at a time (one model, one GPU). A few may wait; more, or a long wait, is BUSY.
export class JobQueue {
  private running = false;
  private waiting: { go: () => void }[] = [];

  constructor(private maxWaiting = 3) {}

  get size(): { running: boolean; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  async run<T>(fn: () => Promise<T>, waitMs: number, signal?: AbortSignal): Promise<T> {
    if (this.running) await this.turn(waitMs, signal);
    else this.running = true;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next.go();
      else this.running = false;
    }
  }

  private turn(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(new Busy(`${this.waiting.length + 1} local jobs are already queued`));
    return new Promise((resolve, reject) => {
      const me = {
        go: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', stop);
          resolve();
        },
      };
      const leave = (e: Error) => {
        this.waiting = this.waiting.filter((w) => w !== me);
        signal?.removeEventListener('abort', stop);
        reject(e);
      };
      const stop = () => leave(new Error('stopped'));
      const timer = setTimeout(() => leave(new Busy(`other local jobs took longer than ${Math.round(waitMs / 1000)} s`)), waitMs);
      signal?.addEventListener('abort', stop, { once: true });
      this.waiting.push(me);
    });
  }
}

// ---------------------------------------------------------------- which model

// value: the picker value of a configured model (a thread can run on it); context: its window in tokens.
export type Pick = { ok: true; name: string; label: string; value?: string; context: number } | { ok: false; why: 'DOWN' | 'BUSY'; text: string };

type ModelRow = { id?: string; status?: { value?: string } };

// The model a local job runs on: the router model that holds the card now (loaded, loading, or sleeping after its
// idle time; waking it is quick), else the first router model in PHOSPHOR_LOCAL_MODELS. Never a model on its own
// server (Strata): asking for one swaps servers. BUSY when the image engine or such a server holds the card, since a
// router model would push it out.
export async function pickLocal(m: Local | undefined, f: Fetch = fetch, imageBusy: () => Promise<boolean> = () => painter?.holdsGpu() ?? Promise.resolve(false)): Promise<Pick> {
  if (!m) return { ok: false, why: 'DOWN', text: 'no local model is set up' };
  if (await imageBusy()) return { ok: false, why: 'BUSY', text: 'the image model has the GPU' };
  for (const [name, url] of Object.entries(m.urls)) {
    const h = await f(new URL('/health', url), { signal: AbortSignal.timeout(2000) })
      .then((r) => (r.ok ? (r.json() as Promise<{ loaded?: boolean }>) : undefined))
      .catch(() => undefined);
    if (h?.loaded) return { ok: false, why: 'BUSY', text: `${m.models.find((x) => x.name === name)?.label ?? name} has the GPU` };
  }
  let rows: ModelRow[];
  try {
    const r = await f(new URL('/v1/models', m.url), { headers: { authorization: `Bearer ${m.key}` }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(String(r.status));
    rows = ((await r.json()) as { data?: ModelRow[] }).data ?? [];
  } catch {
    return { ok: false, why: 'DOWN', text: 'the local model server does not answer' };
  }
  const own = (id: string) => !!m.urls[id];
  const held = ['loaded', 'loading', 'sleeping'].map((s) => rows.find((x) => x.id && !own(x.id) && x.status?.value === s)).find(Boolean)?.id;
  const first = m.models.find((x) => !own(x.name));
  const name = held ?? first?.name;
  if (!name) return { ok: false, why: 'DOWN', text: 'no local model runs on the model server' };
  const known = m.models.find((x) => x.name === name);
  return { ok: true, name, label: (known?.label ?? name).replace(/\s*\(local\)\s*$/i, ''), value: known?.value, context: m.contexts[name] ?? m.context };
}

// ---------------------------------------------------------------- one call

export type RunResult = { text: string; inTokens: number; outTokens: number; cut: boolean };

// One request to the local model through the relay (server/localrelay.ts), so it takes its GPU turn, gets the
// thinking level set, and shows in SYS like any local request. Streamed: the phase goes to the activity line, and the
// limits count from the first piece (a model load and a long prompt come before it).
export async function runLocal(o: {
  url: string;
  key: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  firstMs: number;
  totalMs: number;
  signal?: AbortSignal;
  phase?: (p: 'reading' | 'thinking' | 'writing') => void;
  fetch?: Fetch;
}): Promise<RunResult> {
  const abort = new AbortController();
  let why = '';
  const stop = (reason: string) => {
    why ||= reason;
    abort.abort();
  };
  const onAbort = () => stop('stopped');
  o.signal?.addEventListener('abort', onAbort, { once: true });
  if (o.signal?.aborted) stop('stopped');
  const first = setTimeout(() => stop(`no answer within ${Math.round(o.firstMs / 1000)} s`), o.firstMs);
  const total = setTimeout(() => stop(`not done within ${Math.round(o.totalMs / 1000)} s`), o.totalMs);
  let text = '';
  let inTokens = 0;
  let outTokens = 0;
  let stopReason = '';
  try {
    o.phase?.('reading');
    const r = await (o.fetch ?? fetch)(new URL('/v1/messages', o.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.key}` },
      body: JSON.stringify({
        model: o.model,
        max_tokens: o.maxTokens,
        stream: true,
        system: o.system,
        messages: [{ role: 'user', content: o.prompt }],
        // No thinking: on a 69K-token log even Qwen's low level thought through 1,900 tokens and never answered;
        // without it the same job answered right in 43 s.
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: abort.signal,
    });
    if (!r.ok || !r.body) {
      const body = await r.text().catch(() => '');
      let msg = body.slice(0, 200);
      try {
        msg = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* not JSON: the text itself */
      }
      throw new Error(`the local model refused (${r.status}${msg ? `: ${msg}` : ''})`);
    }
    const decoder = new TextDecoder();
    const blocks: string[] = [];
    let rest = '';
    let phase = '';
    const say = (p: 'thinking' | 'writing') => {
      if (phase !== p) o.phase?.((phase = p));
    };
    const event = (data: string) => {
      const e = JSON.parse(data) as {
        type?: string;
        index?: number;
        message?: { usage?: { input_tokens?: number } };
        content_block?: { type?: string };
        delta?: { type?: string; text?: string; stop_reason?: string };
        usage?: { input_tokens?: number; output_tokens?: number };
        error?: { message?: string };
      };
      clearTimeout(first);
      if (e.type === 'error') throw new Error(e.error?.message ?? 'the local model stopped with an error');
      if (e.type === 'message_start') inTokens = e.message?.usage?.input_tokens ?? inTokens;
      else if (e.type === 'content_block_start') blocks[e.index ?? 0] = e.content_block?.type ?? '';
      else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        text += e.delta.text ?? '';
        say('writing');
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') say('thinking');
      else if (e.type === 'message_delta') {
        stopReason = e.delta?.stop_reason ?? stopReason;
        outTokens = e.usage?.output_tokens ?? outTokens;
        inTokens = e.usage?.input_tokens || inTokens;
      }
    };
    for await (const chunk of r.body as AsyncIterable<Uint8Array>) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) if (line.startsWith('data:')) event(line.slice(5).trim());
    }
    if (rest.startsWith('data:')) event(rest.slice(5).trim());
  } catch (e) {
    if (why) throw new Error(why);
    throw e;
  } finally {
    clearTimeout(first);
    clearTimeout(total);
    o.signal?.removeEventListener('abort', onAbort);
  }
  if (why) throw new Error(why);
  // A model that writes its thinking into the text: keep only the answer.
  text = text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '').trim();
  return { text, inTokens, outTokens, cut: stopReason === 'max_tokens' };
}

// ---------------------------------------------------------------- ledger

const ZERO = (): DelegateCount => ({ calls: 0, failed: 0, inTokens: 0, outTokens: 0, keptOff: 0, ms: 0, at: 0 });
type Chat = DelegateCount & { files: Record<string, number> }; // real path -> Claude tokens counted as kept off
type Saved = { since: number; total: DelegateCount; chats: Record<string, Chat> };
const KEEP_CHATS = 300;

// What the local model did, per chat and in total, saved in data/router.json. keptOff: Claude tokens of file text the
// server read for the model and Claude never saw, minus the answers Claude read back. Each file counts once per chat,
// and comes off again when Claude reads it itself (Read), since then it saw it after all.
export class Ledger {
  private d: Saved;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private file: string,
    private now: () => number = Date.now,
  ) {
    this.d = { since: now(), total: ZERO(), chats: {} };
    try {
      if (existsSync(file)) this.d = { ...this.d, ...(JSON.parse(readFileSync(file, 'utf8')) as Saved) };
    } catch {
      /* unreadable: start again */
    }
  }

  forChat(id: string): DelegateCount | undefined {
    const c = this.d.chats[id];
    if (!c) return undefined;
    const { files: _f, ...count } = c;
    return count;
  }

  status(on: boolean): RouterResponse {
    return { on, total: { ...this.d.total }, since: this.d.since };
  }

  // A finished job: ok with its counts, or failed.
  job(chat: string, j: { ok: boolean; ms: number; worker: string; inTokens?: number; outTokens?: number; files?: { real: string; chars: number }[]; answerChars?: number }): DelegateCount {
    const c = (this.d.chats[chat] ??= { ...ZERO(), files: {} });
    const t = this.d.total;
    const at = this.now();
    for (const x of [c, t]) {
      x.calls++;
      if (!j.ok) x.failed++;
      x.inTokens += j.inTokens ?? 0;
      x.outTokens += j.outTokens ?? 0;
      x.ms += j.ms;
      x.at = at;
      x.worker = j.worker;
    }
    if (j.ok) {
      let fresh = 0;
      for (const f of j.files ?? []) {
        if (f.real in c.files) continue;
        c.files[f.real] = tokensOf(f.chars);
        fresh += c.files[f.real];
      }
      const kept = fresh ? Math.max(0, fresh - tokensOf(j.answerChars ?? 0)) : 0;
      c.keptOff += kept;
      t.keptOff += kept;
    }
    this.saveSoon();
    return this.forChat(chat)!;
  }

  // Claude (or one of its helpers) read a file itself: what was counted for it as kept off comes back off.
  sawFile(chat: string, path: string): DelegateCount | undefined {
    const c = this.d.chats[chat];
    if (!c) return undefined;
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      /* gone: the path as given */
    }
    const n = c.files[real];
    if (!n) return undefined;
    c.files[real] = 0;
    const back = Math.min(n, c.keptOff);
    c.keptOff -= back;
    this.d.total.keptOff = Math.max(0, this.d.total.keptOff - back);
    this.saveSoon();
    return this.forChat(chat);
  }

  // Written at most once a second; the newest chats are kept.
  private saveSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), 1000);
    this.timer.unref?.();
  }

  save(): void {
    const ids = Object.keys(this.d.chats).sort((a, b) => this.d.chats[b].at - this.d.chats[a].at);
    for (const id of ids.slice(KEEP_CHATS)) delete this.d.chats[id];
    try {
      writeFileSync(this.file, JSON.stringify(this.d));
    } catch (e) {
      console.warn('router: could not save the ledger:', e);
    }
  }
}

export const ledger = new Ledger(join(DATA_DIR, 'router.json'));

// ---------------------------------------------------------------- ask_local

// The chat a tool belongs to: its folders, its activity line, its counts.
export type DelegateChat = {
  id: string;
  cwd: string;
  roots: string[]; // folders its files may come from (the chat's folder and its extra ones)
  status: (text: string) => void;
  counted: (c: DelegateCount) => void;
};

export type Deps = {
  local: Local | undefined;
  fetch: Fetch;
  imageBusy?: () => Promise<boolean>;
  queue: JobQueue;
  ledger: Ledger;
  relay: string; // where the relay listens
  waitMs: number; // longest wait for the queue
  firstMs: number; // longest wait for the first piece of the answer (model load + reading the prompt)
  totalMs: number; // longest call, its wait in the queue included
};

const LIVE: Deps = {
  local: localModel,
  fetch: (...a) => fetch(...a),
  queue: new JobQueue(),
  ledger,
  relay: `http://127.0.0.1:${LOCAL_RELAY_PORT}`,
  waitMs: 180_000,
  firstMs: 180_000,
  totalMs: 240_000, // under 5 minutes: a chat's prompt cache can be that short, and Claude waits for the answer
};

const SYSTEM = (words: number) =>
  `You do one job for Claude, an AI assistant that hands you work so it does not have to read the files itself. Claude sees only your answer.
- Work only from the files and the task. Never invent facts; if the files do not answer the task, say so.
- Be exact: names, numbers, dates, paths and error text as written. Say which file a point comes from when there are several.
- Plain text, no preamble, no closing offer. At most ${words} words.`;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export function askLocalTool(chat: DelegateChat, deps: Deps = LIVE) {
  return tool(
    'ask_local',
    'Hand one job to the free local model on this PC: summarize, search, extract, classify, compare or draft. Files are read by the app, not by you: big files cost you only the short answer. One job at a time; it can take a minute. The local model is weaker than you: not for exact counts or math, and check what matters. DOWN or BUSY: do the job yourself.',
    {
      task: z.string().min(1).describe('The job, complete and specific: what to find, extract or write, and the form of the answer'),
      files: z.array(z.string()).max(CAPS.files).optional().describe('Paths, absolute or relative to the chat folder. The app reads them for the local model; you never see their text'),
      max_words: z.number().int().min(20).max(2000).optional().describe('Longest answer you want (default 300)'),
    },
    async (args, extra) => {
      const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
      const t0 = Date.now();
      let worker = 'local';
      const fail = (kind: string, text: string) => {
        chat.counted(deps.ledger.job(chat.id, { ok: false, ms: Date.now() - t0, worker }));
        return say(`LOCAL MODEL ${kind}: ${text}. Do the job yourself.`, true);
      };
      try {
        return await deps.queue.run(
          async () => {
            const pick = await pickLocal(deps.local, deps.fetch, deps.imageBusy);
            if (!pick.ok) return fail(pick.why, pick.text);
            worker = pick.label;
            const words = args.max_words ?? 300;
            const maxTokens = Math.min(8192, 2048 + words * 2); // room for a model that thinks anyway (Gemma)
            // Room for the files: the model's window less the answer and the prompt. Logs are dense: 1.6 characters a
            // token measured (112K characters = 69K tokens), so that is the rate assumed.
            const room = Math.max(8000, Math.min(CAPS.totalChars, Math.floor((pick.context - maxTokens - 2048) * 1.6)));
            const { files, problems } = readJobFiles(args.files ?? [], chat.cwd, chat.roots, room);
            if (args.files?.length && !files.length) return fail('FAILED', `no file could be read: ${problems.join('; ')}`);
            const parts = files.map((f) => `<file path="${f.path}"${f.cut ? ` note="cut: its first ${f.text.length} of ${f.size} characters"` : ''}>\n${f.text}\n</file>`);
            const prompt = [...parts, `Task: ${args.task}`].join('\n\n');
            const reading = `Local model: reading${files.length ? ` ${files.length} ${files.length === 1 ? 'file' : 'files'}` : ''}`;
            // The time limit counts from the call, the wait in the queue too: Claude waits on the whole call, and its
            // calls run side by side, so a wait plus a full run went past the prompt cache's life.
            const left = deps.totalMs - (Date.now() - t0);
            const r = await runLocal({
              url: deps.relay,
              key: deps.local!.key,
              model: pick.name,
              system: SYSTEM(words),
              prompt,
              maxTokens,
              firstMs: Math.min(deps.firstMs, left),
              totalMs: left,
              signal,
              fetch: deps.fetch,
              phase: (p) => chat.status(p === 'reading' ? reading : `Local model: ${p}`),
            });
            if (!r.text) return fail('FAILED', 'it gave an empty answer');
            const chars = files.reduce((n, f) => n + f.text.length, 0);
            const ms = Date.now() - t0;
            chat.counted(deps.ledger.job(chat.id, { ok: true, ms, worker, inTokens: r.inTokens, outTokens: r.outTokens, files: files.map((f) => ({ real: f.real, chars: f.text.length })), answerChars: r.text.length }));
            const head = [
              `[ask_local: ${pick.label}${files.length ? ` read ${files.length} ${files.length === 1 ? 'file' : 'files'} (about ${k(tokensOf(chars))} tokens you did not read)` : ''} in ${Math.round(ms / 1000)} s. Check what matters.]`,
              ...files.filter((f) => f.cut).map((f) => `[cut to fit: ${f.path}, its first ${f.text.length} of ${f.size} characters]`),
              ...(problems.length ? [`[not read: ${problems.join('; ')}]`] : []),
              ...(r.cut ? ['[the answer hit its length limit and may stop mid-way]'] : []),
            ];
            return say(`${head.join('\n')}\n\n${r.text}`);
          },
          deps.waitMs,
          signal,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return fail(e instanceof Busy ? 'BUSY' : msg === 'stopped' ? 'STOPPED' : /not done within|no answer within/.test(msg) ? 'TOO SLOW' : /fetch failed|ECONNREFUSED|not reachable/i.test(msg) ? 'DOWN' : 'FAILED', msg);
      } finally {
        chat.status('Thinking');
      }
    },
    { annotations: { readOnlyHint: true } },
  );
}

// ---------------------------------------------------------------- thread workers

export const THREAD_WORKERS = ['local', 'haiku', 'sonnet', 'opus'] as const;
export type ThreadWorker = (typeof THREAD_WORKERS)[number];
export type ThreadModel = { model?: string; effort?: Effort; auto: boolean };

// The worker choices start_thread offers, and when each fits (its parameter text).
export const threadWorkers = (): ThreadWorker[] => THREAD_WORKERS.filter((w) => w !== 'local' || routerOn());
export const WORKER_HELP = () =>
  `Who runs the thread; default: the same model as this lead. Pick the cheapest that can do the job well.${routerOn() ? ' local: free, on this PC, slower and weaker; for bulk routine work with clear steps you can check (summarize or sort many files, extract data, rename, reformat, first drafts); not for design, debugging or subtle code.' : ''} haiku: cheap and fast, for simple well-specified jobs. sonnet: most coding and writing. opus: hard design, debugging, high stakes.`;

// The model a new thread runs on. No worker: the lead's settings. local: the local model that holds the card (as
// ask_local picks it), at a medium thinking level; DOWN or BUSY is an error, so the lead can pick another worker.
// A Claude model: the lead's thinking level where that model has it. A chosen worker is fixed (AUTO off).
export async function threadModel(
  worker: ThreadWorker | undefined,
  lead: ThreadModel,
  deps: { efforts: (model: string) => Effort[] | undefined; pick?: () => Promise<Pick> },
): Promise<ThreadModel | { error: string }> {
  if (!worker) return lead;
  if (worker === 'local') {
    const p = await (deps.pick ?? (() => pickLocal(localModel)))();
    if (!p.ok) return { error: `LOCAL MODEL ${p.why}: ${p.text}. Pick another worker.` };
    // A model held but not in the picker cannot run a chat here, and another one would push it out (a swap).
    if (!p.value) return { error: `LOCAL MODEL BUSY: ${p.label} has the GPU and is not in the model picker. Pick another worker.` };
    return { model: p.value, effort: 'medium', auto: false };
  }
  const supported = deps.efforts(worker);
  const effort = lead.effort && supported ? clampEffort(lead.effort, supported) : '';
  return { model: worker, effort: (effort || undefined) as Effort | undefined, auto: false };
}
