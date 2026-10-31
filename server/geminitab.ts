import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EFFORTS, isGeminiModel, type Effort, type Item, type ModelChoice, type PatchKey, type TabState } from '../shared/protocol.ts';
import { clampEffort } from '../shared/router.ts';
import { DATA_DIR, geminiImage, imagesDir } from './config.ts';
import { fileName } from './imagegen.ts';
import { imageSize } from './imageopts.ts';
import type { StoredUpload } from './uploads.ts';

// Gemini chats (owner's ask 2026-10-25: "talk to Gemini through Phosphor OS"). A tab whose model is "gemini:<model>"
// talks to Gemini through Google's Antigravity CLI (`agy`), signed in with the owner's Google AI Pro account: no API
// key. Each message is one headless run in the tab's folder, `agy -p <message> --output-format stream-json`; every
// run after the first continues the same agy conversation (--conversation <id>). Its events become the same chat
// items as Claude's: the reply streams in, each tool step is a tool line, written files count as changed.
// A headless run cannot stop to ask: what its mode does not allow is refused and the run ends, with the refused
// actions in its result (denied_actions). So the mode picker maps to what agy may do without asking (agyArgs).
// agy keeps the conversation for the model; the app keeps the chat as shown in data/gemini-chats/<conversation>.json,
// so it comes back after a restart. Event names and modes checked with agy 1.4.7 (2026-10-25); commands under the
// guards, with agy 1.4.12 (2026-10-30).

const exec = promisify(execFile);
const TIMEOUT_S = 1800; // one run at most 30 minutes (agy's own default is no limit)
const ESCALATE_MS = 3000; // STOP: SIGINT, then SIGTERM, then SIGKILL this long apart
const ATTACHED = 'Attached files (saved on this PC; open them with your file tools):';
const DESCRIPTION = "Chat with Gemini (your Google AI Pro sign-in, through agy). Works in this chat's folder.";
const env = () => ({ ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }); // no self-update in the middle of a reply
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0];

// ------------------------------------------------------------ models and modes

// `agy models` lists each model once per thinking level ("gemini-4-argon-high<TAB>Gemini 4 Argon (High)"): one picker
// entry per model, with those levels. Gemini only: agy offers some Claude and GPT models too.
export function parseAgyModels(stdout: string): ModelChoice[] {
  const byBase = new Map<string, ModelChoice>();
  for (const line of stdout.split('\n')) {
    const [id, name] = line.split('\t').map((s) => s.trim());
    if (!id || !name || !/^gemini-[\w.-]+$/.test(id)) continue;
    const level = /-(low|medium|high|xhigh|max)$/.exec(id)?.[1] as Effort | undefined;
    const base = level ? id.slice(0, -level.length - 1) : id;
    const m = byBase.get(base) ?? { value: `gemini:${base}`, label: name.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, ''), description: DESCRIPTION, efforts: [] };
    if (level && !m.efforts.includes(level)) m.efforts.push(level);
    byBase.set(base, m);
  }
  return [...byBase.values()].map((m) => ({ ...m, efforts: EFFORTS.filter((e) => m.efforts.includes(e)) }));
}

let known: ModelChoice[] = []; // the last list: names and thinking levels

// The Gemini models agy offers this account, for the picker (asked once, next to Claude's list). None when agy is not
// installed, not signed in, or does not answer.
export async function geminiModels(): Promise<ModelChoice[]> {
  if (!existsSync(GeminiChat.bin)) return [];
  try {
    known = parseAgyModels((await exec(GeminiChat.bin, ['models'], { timeout: 20_000, env: env() })).stdout);
  } catch (e) {
    console.warn(`Gemini chat: agy did not list its models (signed in? run \`agy\` once in a terminal): ${firstLine(e)}`);
  }
  return known;
}

// The tab's thinking level, held to the levels the model has ('' or none = agy's default for it).
export function fitEffort(model: string, effort?: string): Effort | undefined {
  const levels = known.find((m) => m.value === model)?.efforts ?? ['low', 'medium', 'high'];
  return (clampEffort(effort ?? '', levels) || undefined) as Effort | undefined;
}

// "gemini-3.8-flash" -> its name in agy's list ("Gemini 3.8 Flash"), or the same made from the id.
function labelOf(base: string): string {
  return known.find((m) => m.value === `gemini:${base}`)?.label ?? base.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// The mode picker for a run that cannot stop to ask (agy's --mode; '' = agy's own default, which refuses commands):
// - ASK FIRST: agy's default, and Gemini is told to read and answer only (READ_ONLY). agy has no read-only mode, and its
//   plan mode answers even "pick a fruit" with a plan to review (tested 2026-10-25).
// - PLAN ONLY: plan mode. Gemini writes a plan in its own folder.
//   Both write files without asking in a headless run (default mode at once, plan mode once told "go ahead"; tested
//   2026-10-26), so these runs see the chat's folder read-only (readOnly), or a file write is the tripwire.
// - AUTO-EDIT: accept-edits. It may change files in the folder; commands are refused unless agy's own settings allow them.
// - AUTO and BYPASS run commands only when the guards are in place for the run (geminiGuards): agy then runs every tool
//   step past the same PreToolUse hooks as Claude Code (scripts/agy-guards.mjs, docs/GEMINI-GUARDS.md), such as a
//   block on writes to a production org. Without them both are AUTO-EDIT, as before.
//   - AUTO: accept-edits plus agy's terminal sandbox, where commands run without asking (proceed-in-sandbox): no
//     network, writes only in the folder and temp folders; a command that must leave the sandbox is refused. agy's own
//     auto mode (a reviewer for commands that leave the sandbox) said "unavailable (rollout flag off)" for this
//     account (2026-10-30, agy 1.4.12), and then runs in the default mode, so it is not used.
//   - BYPASS: --dangerously-skip-permissions, every step runs without asking, outside the sandbox. The guards still
//     run on every step (tested 2026-10-30).
const SANDBOX = JSON.stringify({ toolPermission: 'proceed-in-sandbox' });
export function agyArgs(mode: string, guarded: boolean): string[] {
  if (mode === 'plan') return ['--mode', 'plan'];
  if (mode === 'auto' && guarded) return ['--mode', 'accept-edits', '--sandbox', '--settings', SANDBOX];
  if (mode === 'bypassPermissions' && guarded) return ['--dangerously-skip-permissions'];
  return mode === 'acceptEdits' || mode === 'auto' || mode === 'bypassPermissions' ? ['--mode', 'accept-edits'] : [];
}
const READ_ONLY = '[Note from the Phosphor-OS app: this chat is in ASK FIRST mode. Do not create, change or delete any file and do not run commands: read and answer only. If the request needs changes, say what you would change; the user can allow changes by switching the chat to AUTO-EDIT.]';
export const noBypass = (why: string) => `BYPASS is not offered for this Gemini chat: ${why} This chat uses AUTO, which runs no commands until then.`;
// The MCP screen shows Claude Code's servers; agy has its own.
export const GEMINI_MCP = "This chat is with Gemini: its connectors (MCP servers) are agy's own. `agy mcp list` in a terminal shows them.";
const MODE_NAMES: Record<string, string> = { default: 'ASK FIRST', plan: 'PLAN ONLY', acceptEdits: 'AUTO-EDIT', auto: 'AUTO', bypassPermissions: 'BYPASS' };

// The guards for commands (scripts/agy-guards.mjs): its entry in agy's shared hooks file, pointing at this copy of the
// script, and the script answering a test call with Claude Code's command hooks found. '' = in place, else why not.
// Asked at the start of every run, so installing or removing them needs no restart.
export const GUARDS_SCRIPT = fileURLToPath(new URL('../scripts/agy-guards.mjs', import.meta.url));
const GUARDS_NAME = 'phosphor-guards';
const INSTALL = `run \`node scripts/agy-guards.mjs install\` in the Phosphor-OS folder (docs/GEMINI-GUARDS.md)`;
export async function geminiGuards(cwd: string): Promise<string> {
  let command: unknown;
  try {
    const entry = JSON.parse(readFileSync(GeminiChat.hooks, 'utf8'))?.[GUARDS_NAME];
    if (!entry) throw new Error('none');
    if (entry.enabled === false) return `the command guards are switched off in ${GeminiChat.hooks} ("enabled": false).`;
    command = entry.PreToolUse?.find((g: { matcher?: string }) => g.matcher === '*')?.hooks?.[0]?.command;
  } catch {
    return `the command guards are not set up for Gemini: ${INSTALL}.`;
  }
  if (typeof command !== 'string' || !command.includes(GUARDS_SCRIPT)) return `the command guards for Gemini point at another copy of Phosphor-OS: ${INSTALL}.`;
  const probe = JSON.stringify({ phosphorCheck: true, toolCall: { name: 'run_command', args: { CommandLine: 'true' } }, workspacePaths: [cwd] });
  const answer = await new Promise<string>((done) => {
    const child = execFile('/bin/sh', ['-c', command], { cwd: dirname(GeminiChat.hooks), timeout: 20_000, env: env() }, (e, out) => done(e ? '' : out));
    child.stdin?.on('error', () => {});
    child.stdin?.end(probe);
  });
  let a: { decision?: string; guards?: number; reason?: string } = {};
  try {
    a = JSON.parse(answer);
  } catch {
    return `the command guards for Gemini did not answer a test call: ${INSTALL}.`;
  }
  if (a.decision !== 'ask') return `the command guards for Gemini failed a test call (${(a.reason ?? a.decision ?? 'no answer').slice(0, 200)}).`;
  if (!a.guards) return 'Claude Code has no PreToolUse hooks for commands (Bash) to apply to Gemini.';
  return '';
}

// ASK FIRST and PLAN ONLY, when bubblewrap works: the run sees these folders read-only, and all else as it is (agy's own
// folder, its sign-in in the desktop keyring, the network). --die-with-parent: STOP ends bwrap, and agy with it.
// undefined = no bubblewrap here: GeminiChat.step stops the run at the first file write instead.
let boxCheck: [string, boolean] | undefined; // bubblewrap, and whether it works here (unprivileged namespaces may be off)
function readOnly(dirs: string[]): string[] | undefined {
  if (boxCheck?.[0] !== GeminiChat.bwrap) boxCheck = [GeminiChat.bwrap, !!GeminiChat.bwrap && spawnSync(GeminiChat.bwrap, ['--dev-bind', '/', '/', 'true']).status === 0];
  if (!boxCheck[1]) return undefined;
  const own = join(homedir(), '.gemini');
  return ['--dev-bind', '/', '/', ...dirs.flatMap((d) => ['--ro-bind', d, d]), '--bind-try', own, own, '--chdir', dirs[0], '--die-with-parent', '--'];
}

// ------------------------------------------------------------ what a run says

type Step = {
  step_index?: number;
  state?: string; // ACTIVE, DONE (others: a failed step)
  step_type?: string; // user_input, system_message, agent_response, tool, subagent (a helper started by a tool step)
  text_delta?: string;
  thinking_delta?: string;
  tool_name?: string;
  tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: string; error?: { message?: string } }; // error: a guard's block, for one
  subagent_info?: { subagents?: { type_name?: string; initial_prompt?: string }[] };
  error?: string;
};
type Denied = { action?: string; display_name?: string };
type Result = { conversation_id?: string; status?: string; response?: string; error?: string; denied_actions?: Denied[] };
type AgyEvent = { event?: string; conversation_id?: string; init?: { model?: string }; step_update?: Step; result?: Result; error?: { message?: string }; message?: string };

// agy's tool names, short like Claude's tool lines (others keep agy's name).
const TOOLS: Record<string, string> = { read_file: 'Read', write_file: 'Write', edit_file: 'Edit', run_command: 'Run', list_dir: 'List', grep_search: 'Grep', find_by_name: 'Find', search_web: 'WebSearch', read_url: 'WebFetch', invoke_subagent: 'Agent', generate_image: 'Picture' };
const EDITS = new Set(['write_file', 'edit_file']);

// A tool step's one-line detail: its command, path, search, address or helper.
function detailOf(p: Record<string, unknown>): string {
  const pick = ['CommandLine', 'Path', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath', 'Query', 'Pattern', 'Url', 'Prompt', 'Role'].map((k) => p[k]).find((v) => typeof v === 'string');
  const s = (typeof pick === 'string' ? pick : Object.keys(p).length ? JSON.stringify(p) : '').replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}

// What agy refused (the "permission" names of its allow rules), in plain words.
const ACTIONS: Record<string, string> = { command: 'run a command', unsandboxed: 'run a command outside its sandbox', write_file: 'change a file', read_file: 'read a file outside this folder', read_url: 'open a web page', execute_url: 'open a web page', mcp: 'use a connector' };

export function deniedNote(denied: Denied[], mode: string, guards: string): string {
  const what = [...new Set(denied.map((d) => ACTIONS[d.action ?? ''] ?? `use ${d.display_name || d.action || 'a tool'}`))].join(', ');
  const said = `Gemini wanted to ${what}, which ${MODE_NAMES[mode] ?? 'this mode'} does not allow, so it stopped there.`;
  if (guards) return `${said} AUTO-EDIT lets it change files in this folder. Gemini runs no commands yet: ${guards}`;
  if (mode === 'auto') return `${said} AUTO runs commands only inside agy's sandbox (no network, writes in this folder and temp folders). BYPASS runs them outside it. Both keep Claude Code's command guards.`;
  return `${said} AUTO-EDIT lets it change files in this folder, AUTO also runs commands in agy's sandbox, BYPASS runs anything. Claude Code's command guards apply to Gemini in each.`;
}

// An error from agy, in plain words.
export function problem(text: string): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? text).replace(/^\s*(error|AGY_ERROR):\s*/i, '').trim();
  if (/authentication required|not (signed|logged) in|interactive login/i.test(text)) return 'Gemini is not signed in: run `agy` once in a terminal, sign in with your Google account, then send again.';
  if (/ENOENT/.test(text)) return `The Antigravity CLI (agy) is not installed at ${GeminiChat.bin}. Install it and run \`agy\` once in a terminal to sign in.`;
  if (/^interrupted$/i.test(line)) return 'Stopped.';
  if (/timeout|timed out|deadline exceeded/i.test(text)) return `Gemini took longer than ${TIMEOUT_S / 60} minutes and was stopped.`;
  return `Gemini stopped with an error: ${line.slice(0, 300)}`;
}

const lastError = (stderr: string) => {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.reverse().find((l) => /^(error|AGY_ERROR)\b/i.test(l)) ?? lines[0] ?? '';
};

// ------------------------------------------------------------ the chat

// What a Gemini chat needs from its tab (server/tab.ts keeps the tab's state and sends its events).
export type GeminiHost = {
  state: TabState;
  settings(): { model?: string; mode: string; effort?: string }; // the tab's picks, read at each run
  add(item: Item): void;
  update(id: string, fields: Record<string, unknown>): void;
  delta(id: string, text: string): void; // more text for a reply being written
  busy(on: boolean): void;
  activity(text: string): void;
  patch(key: PatchKey): void;
  persist(): void; // the conversation id changed: save the tab
};

// The chat as shown, in data/gemini-chats/<conversation>.json.
export type SavedGeminiChat = { conversation: string; title: string; cwd: string; model?: string; createdAt: number; updatedAt: number; files: string[]; items: Item[] };

// Every saved Gemini chat, for HISTORY.
export function savedGeminiChats(): SavedGeminiChat[] {
  let names: string[] = [];
  try {
    names = readdirSync(GeminiChat.dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((f) => {
    try {
      return [JSON.parse(readFileSync(join(GeminiChat.dir, f), 'utf8')) as SavedGeminiChat];
    } catch {
      return []; // damaged: left out
    }
  });
}

// What HISTORY's search looks through: your messages and Gemini's replies.
export const chatText = (c: SavedGeminiChat): string => c.items.map((i) => (i.kind === 'user' || i.kind === 'claude' ? i.text : '')).filter(Boolean).join('\n');

// An agy conversation id (a UUID): also a file name in data/gemini-chats and agy's --conversation.
const CONVERSATION = /^[\w-]{8,64}$/;

type Job = { text: string; files: StoredUpload[] };
type Run = {
  child: ChildProcess;
  text: string;
  mode: string; // as run: BYPASS without the guards runs as AUTO
  guards?: string; // '' = the command guards were in place, else why not (checked for AUTO and BYPASS only)
  who: string; // the reply's speaker label
  asked?: string; // the conversation it was asked to continue
  started: number;
  timer: ReturnType<typeof setTimeout>;
  stopped: boolean;
  timedOut: boolean;
  tripwire: boolean; // ASK FIRST or PLAN ONLY without bubblewrap: a file write stops the run
  tripped?: string; // the file Gemini wrote anyway (the run was stopped there)
  reply?: { id: string; step?: number }; // the reply being written
  tools: Map<number, string>; // step index -> tool line id
  picture: boolean; // the picture tool ran
  command?: boolean; // agy answered a slash command itself (/quota: a table, shown as it is)
  result?: Result;
  error?: string; // an error event, or the process could not start
  plain: string; // output that is not an event (the answer to an agy slash command such as /quota)
  stderr: string;
};

export class GeminiChat {
  // agy (PHOSPHOR_AGY, default ~/.local/bin/agy), its own folder per conversation, and where chats are saved. Tests
  // point them elsewhere.
  static bin = geminiImage.bin;
  static brain = join(homedir(), '.gemini', 'antigravity-cli', 'brain');
  static dir = join(DATA_DIR, 'gemini-chats');
  static bwrap = 'bwrap'; // bubblewrap, for the read-only runs ('' = none)
  static hooks = join(homedir(), '.gemini', 'config', 'hooks.json'); // agy's shared hooks file (the guards)

  conversation?: string;
  private items: Item[] = []; // this chat's own items (the tab also shows pictures from the image models)
  model?: string; // the last Gemini model it ran on (saved with the chat)
  private queue: Job[] = [];
  private run?: Run;
  private starting = false; // the guards are being checked for the next run
  private stops = 0; // STOP presses, so a STOP during that check drops the run
  private gone = false;

  constructor(
    private host: GeminiHost,
    conversation?: string,
  ) {
    this.conversation = conversation && CONVERSATION.test(conversation) ? conversation : undefined; // it comes from the page too
  }

  // A message is shown at once and runs after the one before it (each message is its own agy run).
  send(text: string, files: StoredUpload[]): void {
    const attachments = files.map(({ path: _p, ...a }) => a);
    this.push({ id: randomUUID(), kind: 'user', text, ...(attachments.length ? { attachments } : {}) });
    this.queue.push({ text, files });
    this.host.busy(true);
    if (!this.run && !this.starting) void this.next();
  }

  // STOP: messages still waiting are dropped; the run gets SIGINT (agy ends at once, like Ctrl+C), then SIGTERM and
  // SIGKILL if it is still there seconds later. Only this run's own process, by its PID.
  stop(): void {
    this.stops++;
    const dropped = this.queue.splice(0).length;
    if (dropped && !this.gone) this.note(dropped === 1 ? 'Stopped before it was sent.' : `Stopped: ${dropped} messages were not sent.`);
    const run = this.run;
    if (!run) return;
    run.stopped = true;
    const kill = (signal: NodeJS.Signals) => run.child.exitCode === null && run.child.signalCode === null && run.child.kill(signal);
    kill('SIGINT');
    setTimeout(() => kill('SIGTERM'), ESCALATE_MS).unref();
    setTimeout(() => kill('SIGKILL'), 2 * ESCALATE_MS).unref();
  }

  // The tab closed: its name goes with the saved chat, a run ends.
  close(): void {
    this.save();
    this.gone = true;
    this.stop();
  }

  // A chat from before a restart, or reopened: its items, model and counts from the saved file.
  load(): Item[] {
    const saved = this.read();
    if (!saved) return [];
    this.items = saved.items;
    this.model = saved.model;
    const s = this.host.state.stats;
    s.turns = saved.items.filter((i) => i.kind === 'user').length;
    s.toolCalls = saved.items.filter((i) => i.kind === 'tool').length;
    s.filesChanged = [...saved.files];
    return [...this.items];
  }

  private read(): SavedGeminiChat | null {
    if (!this.conversation) return null;
    try {
      return JSON.parse(readFileSync(join(GeminiChat.dir, `${this.conversation}.json`), 'utf8')) as SavedGeminiChat;
    } catch {
      return null;
    }
  }

  private save(): void {
    if (!this.conversation || this.gone) return;
    const s = this.host.state;
    const file = join(GeminiChat.dir, `${this.conversation}.json`);
    const data: SavedGeminiChat = { conversation: this.conversation, title: s.meta.title, cwd: s.info.cwd, model: this.model, createdAt: s.meta.createdAt, updatedAt: Date.now(), files: s.stats.filesChanged, items: this.items };
    try {
      mkdirSync(GeminiChat.dir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(data));
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      console.warn(`Gemini chat: could not save ${file}: ${firstLine(e)}`);
    }
  }

  private push(item: Item): void {
    this.items.push(item);
    this.host.add(item);
  }

  // Saved with the chat, so a restart keeps why a reply is short or missing.
  private note(text: string): void {
    this.push({ id: randomUUID(), kind: 'note', text });
  }

  private async next(): Promise<void> {
    const job = this.queue.shift();
    if (!job || this.gone) return this.host.busy(false);
    const { model, mode: picked, effort } = this.host.settings();
    const cwd = this.host.state.info.cwd;
    let guards: string | undefined; // checked for the modes that run commands
    if (picked === 'auto' || picked === 'bypassPermissions') {
      const stops = this.stops;
      this.starting = true;
      this.host.activity('Checking the command guards');
      guards = await geminiGuards(cwd).catch((e) => `the command guards could not be checked (${firstLine(e)}).`);
      this.starting = false;
      if (this.gone) return;
      if (this.stops !== stops) {
        this.note('Stopped.'); // STOP while checking: this message is not sent
        return this.next();
      }
    }
    const mode = picked === 'bypassPermissions' && guards ? 'auto' : picked; // no BYPASS without the guards
    if (isGeminiModel(model)) this.model = model;
    const base = this.model?.slice('gemini:'.length);
    const level = this.model ? fitEffort(this.model, effort) : undefined;
    const agy = agyArgs(mode, guards === '');
    const command = job.text.startsWith('/'); // an agy slash command (/quota, a skill): agy only sees it at the start
    const prompt = [agy.length || command ? '' : READ_ONLY, job.text, job.files.length ? `${ATTACHED}\n${job.files.map((f) => `- ${f.path}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    const args = ['-p', prompt.startsWith('-') ? ` ${prompt}` : prompt, '--output-format', 'stream-json', '--print-timeout', `${TIMEOUT_S}s`, ...agy];
    if (base) args.push('--model', base);
    if (level) args.push('--effort', level);
    if (this.conversation) args.push('--conversation', this.conversation);
    const dirs = [...new Set(job.files.map((f) => dirname(f.path)))];
    for (const dir of dirs) args.push('--add-dir', dir);

    const ro = !agy.length || mode === 'plan'; // ASK FIRST, PLAN ONLY
    const box = ro && existsSync(GeminiChat.bin) ? readOnly([cwd, ...dirs]) : undefined; // no agy: the plain "not installed" note
    const child = spawn(box ? GeminiChat.bwrap : GeminiChat.bin, box ? [...box, GeminiChat.bin, ...args] : args, { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    const run: Run = {
      child,
      text: job.text,
      mode,
      guards,
      who: base ? labelOf(base) : 'Gemini',
      asked: this.conversation,
      started: Date.now(),
      timer: setTimeout(() => ((run.timedOut = true), this.stop()), (TIMEOUT_S + 60) * 1000), // agy's own limit did not end it
      stopped: false,
      timedOut: false,
      tripwire: ro && !box,
      tools: new Map(),
      picture: false,
      plain: '',
      stderr: '',
    };
    this.run = run;
    this.host.activity('Starting Gemini');
    child.on('error', (e) => (run.error = e.message));
    child.stderr!.on('data', (d) => (run.stderr = (run.stderr + d).slice(-8000)));
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (l) => this.line(run, l));
    void Promise.all([new Promise((r) => lines.once('close', r)), new Promise<number | null>((r) => child.once('close', r))]).then(([, code]) => this.finish(run, code));
  }

  private line(run: Run, line: string): void {
    let e: AgyEvent;
    try {
      e = JSON.parse(line);
      if (!e || typeof e !== 'object') throw new Error('not an event');
    } catch {
      run.plain += `${line}\n`;
      return;
    }
    if (this.gone) return;
    if (e.event === 'init') {
      this.adopt(e.conversation_id);
      if (e.init?.model) run.who = labelOf(e.init.model);
      this.host.activity('Thinking');
    } else if (e.event === 'step_update' && e.step_update) this.step(run, e.step_update);
    else if (e.event === 'result' && e.result) run.result = e.result;
    else if (e.event === 'command_result') run.command = true;
    else if (e.event === 'error') run.error = e.error?.message ?? e.message ?? 'error';
  }

  // The conversation agy runs this chat in: saved with the tab, so the next message (and a restart) continues it.
  private adopt(id?: string): void {
    if (!id || id === this.conversation || !CONVERSATION.test(id)) return;
    this.conversation = id;
    this.host.persist();
  }

  private step(run: Run, s: Step): void {
    if (s.step_type === 'agent_response') {
      const text = s.text_delta ?? '';
      let reply = run.reply && run.reply.step === s.step_index ? run.reply : undefined;
      // A new reply starts with its first words (a step that only picks tools has none).
      if (!reply && text.trim()) {
        reply = run.reply = { id: randomUUID(), step: s.step_index };
        this.push({ id: reply.id, kind: 'claude', text: '', at: Date.now(), who: run.who });
        this.host.activity('Writing a reply');
      }
      if (reply && text) this.host.delta(reply.id, text);
      else if (s.thinking_delta) this.host.activity('Thinking');
      return;
    }
    if (s.step_type !== 'tool' && s.step_type !== 'subagent') return;
    const name = s.tool_name ?? s.tool_info?.name ?? 'tool';
    const p = s.tool_info?.parameters ?? {};
    const path = typeof p.Path === 'string' ? p.Path : '';
    const notes = path.startsWith(`${GeminiChat.brain}/`); // agy's own notes (a plan) in its folder, not in the chat's folder
    const label = TOOLS[name] ?? name;
    const write = EDITS.has(name) && !!path && !notes; // a file in the chat's folder (or elsewhere), not agy's notes
    const changed = () => {
      const files = this.host.state.stats.filesChanged;
      if (!files.includes(path)) files.push(path);
      this.host.patch('stats');
    };
    let id = run.tools.get(s.step_index ?? -1);
    if (!id) {
      id = randomUUID();
      run.tools.set(s.step_index ?? -1, id);
      this.host.state.stats.toolCalls++;
      // Pictures: the picture tool, or (seen 2026-10-25) a helper of type "image-generator" that saves into this
      // conversation's folder.
      if (/image/i.test(`${name} ${p.TypeName ?? ''}`)) run.picture = true;
      const detail = notes ? `${basename(path)} (Gemini's notes)` : detailOf(p);
      this.push({ id, kind: 'tool', name: label, detail });
      this.host.patch('stats');
      this.host.activity(`${label}: ${detail.slice(0, 80)}`);
      if (write && run.tripwire && !run.tripped) {
        run.tripped = path; // no more steps after this one; the file may be written already
        changed();
        this.stop();
      }
    }
    if (s.state === 'ACTIVE') return;
    if (write && s.state === 'DONE' && !s.error) changed(); // not a write the read-only folder refused
    const out = s.tool_info?.output ?? s.tool_info?.error?.message ?? s.subagent_info?.subagents?.map((a) => a.initial_prompt).filter(Boolean).join('\n\n') ?? ''; // a helper: its task
    let body = typeof p.CommandLine === 'string' ? [p.CommandLine, out].filter(Boolean).join('\n\n') : out;
    if (notes && /\.md$/i.test(path)) {
      try {
        body = readFileSync(path, 'utf8').slice(0, 40000); // the plan, readable in the chat (its link opens nothing here)
      } catch {
        /* moved or deleted: the line only */
      }
    }
    this.host.update(id, { ...(s.state !== 'DONE' || s.error ? { error: true } : {}), ...(body ? { body } : {}) });
    this.host.activity('Thinking');
  }

  private async finish(run: Run, code: number | null): Promise<void> {
    clearTimeout(run.timer);
    if (this.gone) return;
    const r = run.result;
    this.adopt(r?.conversation_id);
    // No reply streamed: the result's text, or plain output (agy answers some slash commands, like /quota, as text).
    const text = run.reply || run.stopped ? '' : (r?.response ?? '').trim() || (r ? '' : run.plain.trim());
    if (text) this.push({ id: randomUUID(), kind: 'claude', text: run.command ? `\`\`\`\n${text}\n\`\`\`` : text, at: Date.now(), who: run.who });
    if (run.picture && this.conversation) await this.pictures(run).catch((e) => this.note(`Gemini made a picture, but it could not be shown: ${firstLine(e)}`));
    const fail = r ? (r.status === 'SUCCESS' ? '' : r.error || r.status || 'error') : code === 0 ? '' : run.error || lastError(run.stderr) || `agy ended with code ${code}`;
    if (run.timedOut) this.note(problem('timeout'));
    else if (run.tripped) this.note(`Gemini changed ${run.tripped}, which ${MODE_NAMES[run.mode] ?? 'ASK FIRST'} does not allow, so it was stopped there. Check that file. To let Gemini change files, pick AUTO-EDIT.`);
    else if (run.stopped) this.note('Stopped.');
    else if (fail) this.note(problem(fail));
    if (run.asked && this.conversation !== run.asked) this.note('agy could not find the earlier conversation, so this message started a new one: Gemini does not remember the messages above.');
    if (r?.denied_actions?.length) this.note(deniedNote(r.denied_actions, run.mode, run.guards ?? (await geminiGuards(this.host.state.info.cwd).catch(() => 'the command guards could not be checked.'))));
    const s = this.host.state.stats;
    s.turns++;
    s.lastTurnMs = Date.now() - run.started;
    this.host.patch('stats');
    this.run = undefined;
    this.save();
    void this.next();
  }

  // Pictures Gemini made this turn (its picture tool saves them in its own folder): copied as PNG to the pictures
  // folder (served at /api/images/) and shown in the chat.
  private async pictures(run: Run): Promise<void> {
    const dir = join(GeminiChat.brain, this.conversation!);
    const made = readdirSync(dir)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => join(dir, f))
      .filter((f) => statSync(f).mtimeMs >= run.started);
    mkdirSync(imagesDir, { recursive: true });
    for (const [i, file] of made.entries()) {
      const png = (await exec('magick', [file, 'png:-'], { encoding: 'buffer', maxBuffer: 64 << 20 })).stdout as unknown as Buffer;
      const name = fileName(run.text, i + 1, new Date());
      const path = join(imagesDir, name);
      writeFileSync(path, png);
      const [width, height] = imageSize(png) ?? [1024, 1024];
      this.push({ id: randomUUID(), kind: 'image', status: 'done', prompt: run.text, model: run.who, width, height, seed: 0, steps: 0, file: name, path, ms: Date.now() - run.started });
    }
  }
}
