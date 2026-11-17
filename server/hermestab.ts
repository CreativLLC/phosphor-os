import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isHermesModel, type Item, type ModelChoice, type PatchKey, type TabState } from '../shared/protocol.ts';
import { DATA_DIR, localModel } from './config.ts';
import { painter } from './imagegen.ts';
import type { StoredUpload } from './uploads.ts';

// Hermes chats (owner's ask 2026-11-17: "use Hermes from Phosphor OS"). A tab whose model is "hermes:<name>" talks to
// Nous Research's Hermes Agent, running on a model of this PC's llama.cpp router. One `hermes acp` process per open
// chat speaks the Agent Client Protocol (JSON-RPC over stdin/stdout): a session per chat, one prompt per message,
// its updates become the same chat items as Claude's (the reply streams in, each tool call is a tool line).
// Hermes keeps the conversation (~/.hermes/state.db, session/load after a restart); the app keeps the chat as shown in
// data/hermes-chats/<session>.json. Hermes can run commands in every mode, so a chat starts only with the
// Phosphor-OS guards in place (scripts/hermes-guards.mjs: Claude Code's PreToolUse hooks, PLAN ONLY and ASK FIRST).
// Checked with Hermes Agent 0.23.2 (2026-11-17). Docs: docs/HERMES.md.

const exec = promisify(execFile);
const TIMEOUT_S = 1800; // one message at most 30 minutes
const ATTACHED = 'Attached files (saved on this PC; open them with your file tools):';
const DESCRIPTION = 'Hermes Agent (Nous Research) on this local model: browser, commands and files, under the same guards as Claude.';
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];
export const GUARDS_SCRIPT = fileURLToPath(new URL('../scripts/hermes-guards.mjs', import.meta.url));
const SESSION = /^[\w-]{8,100}$/; // a Hermes session id ("local-<hex>"): also a file name in data/hermes-chats
const PLAN = '[Note from the Phosphor-OS app: this chat is in PLAN ONLY mode. Do not change anything: tools that change files, run commands or use the browser are blocked. Reply with a plan the user can approve.]';
export const HERMES_MCP = "This chat is with Hermes: its connectors (MCP servers) are Hermes's own, in ~/.hermes/config.yaml.";

// The router's models (not ones on their own server, such as Strata: Hermes's config points at the router only).
export function hermesModels(): ModelChoice[] {
  if (!localModel || !existsSync(HermesChat.bin)) return [];
  return localModel.models.filter((m) => !localModel!.urls[m.name]).map((m) => ({ value: `hermes:${m.name}`, label: `Hermes · ${m.label.replace(/\s*\(local\)$/, '')}`, description: DESCRIPTION, efforts: [] }));
}

// The guards: '' = in place, else why not. Asked before every message, so installing them needs no restart.
export async function hermesGuards(): Promise<string> {
  try {
    const out = (await exec(process.execPath, [GUARDS_SCRIPT, 'status'], { timeout: 20_000 })).stdout.trim();
    return out.startsWith('Installed') ? '' : `the Phosphor-OS guards for Hermes are ${out.replace(/^Not in place:\s*/, '').replace(/\.$/, '')}`;
  } catch (e) {
    return `the Phosphor-OS guards for Hermes could not be checked (${firstLine(e)})`;
  }
}
const NO_GUARDS = (why: string) => `Hermes did not start: ${why}. Hermes can run commands in every mode, so it runs only under the guards. Run \`node scripts/hermes-guards.mjs install\` in the Phosphor-OS folder (docs/HERMES.md), then send again.`;

// An error from Hermes, in plain words.
export function problem(text: string): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? text).trim();
  if (/ENOENT/.test(text)) return `Hermes Agent is not installed at ${HermesChat.bin}. Install it (docs/HERMES.md), then send again.`;
  if (/timeout|timed out/i.test(text)) return `Hermes took longer than ${TIMEOUT_S / 60} minutes and was stopped.`;
  if (/ECONNREFUSED|server isn't running|connection error/i.test(text)) return 'Hermes could not reach the local model server. Check that it runs (`systemctl --user status phosphor-local-model.service`), then send again.';
  return `Hermes stopped with an error: ${line.slice(0, 300)}`;
}

// ------------------------------------------------------------ ACP over stdio

type Rpc = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: { code?: number; message?: string; data?: unknown } };

class Acp {
  private next = 1;
  private waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  stderr = '';
  exited = false;

  constructor(
    readonly child: ChildProcess,
    private onNote: (method: string, params: Record<string, any>) => void,
    private onRequest: (method: string, params: Record<string, any>) => Promise<unknown>,
  ) {
    child.stderr!.on('data', (d) => (this.stderr = (this.stderr + d).slice(-8000)));
    child.stdin!.on('error', () => {});
    createInterface({ input: child.stdout! }).on('line', (l) => this.line(l));
    const gone = (why: string) => {
      this.exited = true;
      for (const w of this.waiting.values()) w.no(new Error(why));
      this.waiting.clear();
    };
    child.on('error', (e) => gone(e.message));
    child.on('close', (code) => gone(this.lastError() || `Hermes ended with code ${code}`));
  }

  lastError(): string {
    const lines = this.stderr.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.reverse().find((l) => /error|exception|traceback/i.test(l)) ?? '';
  }

  call(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.exited) return Promise.reject(new Error(this.lastError() || 'Hermes is not running'));
    const id = this.next++;
    return new Promise((ok, no) => {
      this.waiting.set(id, { ok, no });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private send(m: Rpc): void {
    if (!this.exited) this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }

  private line(l: string): void {
    let m: Rpc;
    try {
      m = JSON.parse(l);
    } catch {
      return; // not JSON-RPC: Hermes logs to stderr, so nothing should land here
    }
    if (m.method && m.id !== undefined) {
      const id = m.id;
      this.onRequest(m.method, m.params ?? {}).then(
        (result) => this.send({ id, result }),
        (e) => this.send({ id, error: { code: -32601, message: firstLine(e) } }),
      );
    } else if (m.method) this.onNote(m.method, m.params ?? {});
    else if (typeof m.id === 'number') {
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.error) w?.no(new Error(m.error.message ?? 'error'));
      else w?.ok(m.result);
    }
  }
}

// ------------------------------------------------------------ the chat

// What a Hermes chat needs from its tab (server/tab.ts keeps the tab's state and sends its events).
export type HermesHost = {
  state: TabState;
  settings(): { model?: string; mode: string };
  add(item: Item): void;
  update(id: string, fields: Record<string, unknown>): void;
  delta(id: string, text: string): void;
  busy(on: boolean): void;
  activity(text: string): void;
  patch(key: PatchKey): void;
  persist(): void; // the session id changed: save the tab
  ask(tool: string, title: string, detail: string, signal: AbortSignal): Promise<boolean>; // a perm card in the chat
};

export type SavedHermesChat = { session: string; title: string; cwd: string; model?: string; createdAt: number; updatedAt: number; files: string[]; items: Item[] };

export function savedHermesChats(): SavedHermesChat[] {
  let names: string[] = [];
  try {
    names = readdirSync(HermesChat.dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((f) => {
    try {
      return [JSON.parse(readFileSync(join(HermesChat.dir, f), 'utf8')) as SavedHermesChat];
    } catch {
      return [];
    }
  });
}

export const hermesText = (c: SavedHermesChat): string => c.items.map((i) => (i.kind === 'user' || i.kind === 'claude' ? i.text : '')).filter(Boolean).join('\n');

// The chat's mode by Hermes session, for the guards (scripts/hermes-guards.mjs reads it before every tool call).
function setModeFor(session: string, mode: string | undefined): void {
  let all: Record<string, string> = {};
  try {
    all = JSON.parse(readFileSync(HermesChat.modes, 'utf8'));
  } catch {
    /* none yet */
  }
  if (mode) all[session] = mode;
  else delete all[session];
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(`${HermesChat.modes}.tmp`, JSON.stringify(all));
  renameSync(`${HermesChat.modes}.tmp`, HermesChat.modes);
}

// A tool call's title is "<tool>: <what>" ("terminal: echo hi"): the tool line's name and detail.
const TOOLS: Record<string, string> = { terminal: 'Run', execute_code: 'Code', read_file: 'Read', write_file: 'Write', patch: 'Edit', search_files: 'Grep', web_search: 'WebSearch', web_extract: 'WebFetch', browser_exec: 'Browser', browser_cdp: 'Browser', browser_dialog: 'Browser', delegate_task: 'Agent', vision_analyze: 'Look', todo_list: 'Todo', memory: 'Memory' };
export function toolLine(title: string): { name: string; tool: string; detail: string } {
  const at = title.indexOf(':');
  const tool = at > 0 ? title.slice(0, at).trim() : title.trim();
  const detail = (at > 0 ? title.slice(at + 1) : '').replace(/\s+/g, ' ').trim();
  return { name: TOOLS[tool] ?? tool, tool, detail: detail.length > 160 ? detail.slice(0, 159) + '…' : detail };
}
const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((c) => (c?.type === 'content' ? c.content?.text : c?.type === 'diff' ? `${c.path}\n\n${c.newText ?? ''}` : ''))
        .filter(Boolean)
        .join('\n\n')
        .slice(0, 40000)
    : '';

type Job = { text: string; files: StoredUpload[] };
type Run = {
  started: number;
  who: string;
  reply?: { id: string; msg?: string };
  tools: Map<string, { id: string; tool: string; path?: string }>;
  asks: AbortController;
  prompting: boolean; // the message is with Hermes (before it: starting, loading a session, which replays updates)
  stopped: boolean;
  timer: ReturnType<typeof setTimeout>;
};

export class HermesChat {
  static bin = process.env.PHOSPHOR_HERMES || join(homedir(), '.local', 'bin', 'hermes');
  static dir = join(DATA_DIR, 'hermes-chats');
  static modes = join(DATA_DIR, 'hermes-modes.json');

  conversation?: string; // the Hermes session id
  model?: string; // the last picker value it ran on (saved with the chat)
  private items: Item[] = [];
  private queue: Job[] = [];
  private acp?: Acp;
  private ready?: Promise<string>; // the session, once the process runs and has it
  private onModel?: string; // the model set in the running process
  private run?: Run;
  private working = false;
  private gone = false;

  constructor(
    private host: HermesHost,
    conversation?: string,
  ) {
    this.conversation = conversation && SESSION.test(conversation) ? conversation : undefined;
  }

  send(text: string, files: StoredUpload[]): void {
    const attachments = files.map(({ path: _p, ...a }) => a);
    this.push({ id: randomUUID(), kind: 'user', text, ...(attachments.length ? { attachments } : {}) });
    this.queue.push({ text, files });
    this.host.busy(true);
    if (!this.working) void this.next();
  }

  // STOP: waiting messages are dropped, the turn is cancelled (session/cancel), open OK cards are withdrawn.
  stop(): void {
    const dropped = this.queue.splice(0).length;
    if (dropped && !this.gone) this.note(dropped === 1 ? 'Stopped before it was sent.' : `Stopped: ${dropped} messages were not sent.`);
    const run = this.run;
    if (!run) return;
    run.stopped = true;
    run.asks.abort();
    if (this.conversation) this.acp?.notify('session/cancel', { sessionId: this.conversation });
  }

  // The tab closed: the chat is saved, the process ends (by its PID), its mode entry goes.
  close(): void {
    this.save();
    this.gone = true;
    this.stop();
    if (this.conversation) setModeFor(this.conversation, undefined);
    const child = this.acp?.child;
    if (child && child.exitCode === null) child.kill('SIGTERM');
    this.acp = undefined;
  }

  load(): Item[] {
    if (!this.conversation) return [];
    try {
      const saved = JSON.parse(readFileSync(join(HermesChat.dir, `${this.conversation}.json`), 'utf8')) as SavedHermesChat;
      this.items = saved.items;
      this.model = saved.model;
      const s = this.host.state.stats;
      s.turns = saved.items.filter((i) => i.kind === 'user').length;
      s.toolCalls = saved.items.filter((i) => i.kind === 'tool').length;
      s.filesChanged = [...saved.files];
      return [...this.items];
    } catch {
      return [];
    }
  }

  private save(): void {
    if (!this.conversation || this.gone) return;
    const s = this.host.state;
    const file = join(HermesChat.dir, `${this.conversation}.json`);
    const data: SavedHermesChat = { session: this.conversation, title: s.meta.title, cwd: s.info.cwd, model: this.model, createdAt: s.meta.createdAt, updatedAt: Date.now(), files: s.stats.filesChanged, items: this.items };
    try {
      mkdirSync(HermesChat.dir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(data));
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.warn(`Hermes chat: could not save ${file}: ${firstLine(e)}`);
    }
  }

  private push(item: Item): void {
    this.items.push(item);
    this.host.add(item);
  }

  private note(text: string): void {
    this.push({ id: randomUUID(), kind: 'note', text });
  }

  // The process and its session: started on the first message, again after it ended. A chat from before continues
  // its Hermes session (session/load); one Hermes cannot find starts a new session, and the chat says so.
  private session(): Promise<string> {
    if (this.ready && this.acp && !this.acp.exited) return this.ready;
    const cwd = this.host.state.info.cwd;
    const child = spawn(HermesChat.bin, ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const acp = (this.acp = new Acp(child, (m, p) => this.update(acp, m, p), (m, p) => this.request(m, p)));
    this.onModel = undefined;
    this.ready = (async () => {
      await acp.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      if (this.conversation) {
        try {
          await acp.call('session/load', { sessionId: this.conversation, cwd, mcpServers: [] });
          return this.conversation;
        } catch {
          this.note('Hermes could not find the earlier conversation, so this message starts a new one: Hermes does not remember the messages above.');
        }
      }
      const r = await acp.call('session/new', { cwd, mcpServers: [] });
      if (typeof r?.sessionId !== 'string' || !SESSION.test(r.sessionId)) throw new Error('Hermes gave no session id');
      this.conversation = r.sessionId;
      this.host.persist();
      return r.sessionId;
    })();
    this.ready.catch(() => (this.ready = undefined));
    return this.ready;
  }

  private async next(): Promise<void> {
    const job = this.queue.shift();
    if (!job || this.gone) {
      this.working = false;
      return this.host.busy(false);
    }
    this.working = true;
    const { model, mode } = this.host.settings();
    if (isHermesModel(model)) this.model = model;
    const run: Run = (this.run = { started: Date.now(), who: this.label(), tools: new Map(), asks: new AbortController(), prompting: false, stopped: false, timer: setTimeout(() => this.stop(), TIMEOUT_S * 1000) });
    const live = () => {
      if (run.stopped || this.gone) throw new Error('interrupted');
    };
    let release: (() => void) | undefined;
    try {
      this.host.activity('Checking the guards');
      const why = await hermesGuards();
      if (why) throw new Error(NO_GUARDS(why));
      live();
      this.host.activity('Starting Hermes');
      const session = await this.session();
      live();
      setModeFor(session, mode);
      await this.acp!.call('session/set_config_option', { sessionId: session, configId: 'edit_approval_policy', value: mode === 'default' || mode === 'plan' ? 'ask' : 'session' });
      const name = this.model?.slice('hermes:'.length);
      if (name && name !== this.onModel) {
        this.host.activity('Loading the model');
        await this.acp!.call('session/set_model', { sessionId: session, modelId: `custom:${name}` });
        this.onModel = name;
      }
      release = await painter?.gpu.acquire('chat'); // the image model waits, or gives the card back first
      live();
      run.prompting = true;
      this.host.activity('Thinking');
      const text = [mode === 'plan' ? PLAN : '', job.text, job.files.length ? `${ATTACHED}\n${job.files.map((f) => `- ${f.path}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
      const r = await this.acp!.call('session/prompt', { sessionId: session, prompt: [{ type: 'text', text }] });
      if (run.stopped || r?.stopReason === 'cancelled') this.note('Stopped.');
      else if (r?.stopReason === 'max_tokens') this.note('Hermes hit its reply length limit, so the reply may be cut short.');
      else if (r?.stopReason === 'refusal') this.note('Hermes refused this message.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!this.gone) this.note(run.stopped || msg === 'interrupted' ? 'Stopped.' : msg.startsWith('Hermes did not start') ? msg : problem(msg));
    } finally {
      clearTimeout(run.timer);
      release?.();
      run.asks.abort(); // a card still open: withdrawn
      this.run = undefined;
    }
    if (this.gone) return;
    const s = this.host.state.stats;
    s.turns++;
    s.lastTurnMs = Date.now() - run.started;
    this.host.patch('stats');
    this.save();
    void this.next();
  }

  private label(): string {
    const name = this.model?.slice('hermes:'.length);
    const local = localModel?.models.find((m) => m.name === name);
    return `Hermes${local ? ` · ${local.label.replace(/\s*\(local\)$/, '')}` : ''}`;
  }

  // session/update: replies, tool lines. Updates outside a turn (a loaded session replaying its history) are left out:
  // the chat shows its own saved copy.
  private update(acp: Acp, method: string, p: Record<string, any>): void {
    const run = this.run;
    if (method !== 'session/update' || !run?.prompting || acp !== this.acp || this.gone) return;
    const u = p.update ?? {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = typeof u.content?.text === 'string' ? u.content.text : '';
        if (!text) return;
        if (!run.reply || (u.messageId && run.reply.msg && u.messageId !== run.reply.msg)) {
          if (!text.trim()) return; // a reply starts with its first words
          run.reply = { id: randomUUID(), msg: u.messageId };
          this.push({ id: run.reply.id, kind: 'claude', text: '', at: Date.now(), who: run.who });
          this.host.activity('Writing a reply');
        }
        this.host.delta(run.reply.id, text);
        return;
      }
      case 'agent_thought_chunk':
        this.host.activity('Thinking');
        return;
      case 'tool_call': {
        if (typeof u.toolCallId !== 'string' || run.tools.has(u.toolCallId)) return;
        const line = toolLine(String(u.title ?? 'tool'));
        const id = randomUUID();
        const path = typeof u.rawInput?.path === 'string' ? u.rawInput.path : u.locations?.[0]?.path;
        run.tools.set(u.toolCallId, { id, tool: line.tool, path: u.kind === 'edit' ? path : undefined });
        run.reply = undefined; // words after a tool are a new reply
        this.host.state.stats.toolCalls++;
        this.push({ id, kind: 'tool', name: line.name, detail: line.detail, ...(textOf(u.content) ? { body: textOf(u.content) } : {}) });
        this.host.patch('stats');
        this.host.activity(`${line.name}: ${line.detail.slice(0, 80)}`);
        return;
      }
      case 'tool_call_update': {
        const t = run.tools.get(u.toolCallId); // not ours: an OK card's own status (perm-check, edit-approval)
        if (!t || (u.status !== 'completed' && u.status !== 'failed')) return;
        const body = textOf(u.content);
        this.host.update(t.id, { ...(u.status === 'failed' ? { error: true } : {}), ...(body ? { body } : {}) });
        if (u.status === 'completed' && t.path) {
          const files = this.host.state.stats.filesChanged;
          if (!files.includes(t.path)) files.push(t.path);
          this.host.patch('stats');
        }
        this.host.activity('Thinking');
        return;
      }
    }
  }

  // Requests from Hermes. Only session/request_permission is expected (no file or terminal access is offered).
  // BYPASS answers yes by itself; every other mode shows an OK card. The guards have already run by then.
  private async request(method: string, p: Record<string, any>): Promise<unknown> {
    if (method !== 'session/request_permission') throw new Error(`${method} is not offered`);
    const options: { optionId: string; kind: string }[] = p.options ?? [];
    const pick = (kind: string) => ({ outcome: { outcome: 'selected', optionId: options.find((o) => o.kind === kind)?.optionId ?? (kind === 'allow_once' ? 'allow_once' : 'deny') } });
    const run = this.run;
    if (!run?.prompting || run.stopped || this.gone) return { outcome: { outcome: 'cancelled' } };
    if (this.host.settings().mode === 'bypassPermissions') return pick('allow_once');
    const call = p.toolCall ?? {};
    const raw = call.rawInput ?? {};
    // A request from the guards (ASK FIRST) names a made-up target ("<terminal> (plugin approval rule)"): its own text
    // says what the step does.
    const what = String(call.title ?? 'a tool').replace(/^Approve edit:\s*/, 'Change ').replace(/:?\s*<[\w-]+> \(plugin approval rule\)\s*$/, '');
    const guarded = typeof raw.command === 'string' && /^<[\w-]+> \(plugin approval rule\)$/.test(raw.command);
    const detail = typeof raw.command === 'string' && !guarded ? raw.command : textOf(call.content) || (guarded ? what : JSON.stringify(raw).slice(0, 2000));
    const ok = await this.host.ask('Hermes', `Hermes wants to: ${what.slice(0, 160)}`, detail, run.asks.signal);
    return pick(ok ? 'allow_once' : 'reject_once');
  }
}
