import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { LabApp, LabModel, LabModelsResponse, LabResult } from '../shared/lab.ts';
import { DATA_DIR, geminiImage, localModel } from './config.ts';
import { LOCAL_RELAY_PORT } from './localrelay.ts';

// Model Lab runner (docs/MODEL-LAB.md): runs one model on one prompt in its maker's own app, headless, inside a
// bubblewrap box. The box sees a fresh empty HOME, the app's program files, its own sign-in and the result's
// files/ folder, nothing else: no SSH keys, no cloud logins, no other projects, no skills or memory. Each run gets its
// own systemd scope with a memory limit, so a big build cannot take the server down.

const exec = promisify(execFile);
const HOME = homedir();
const WORK = join(HOME, 'work'); // where files/ shows inside the box
export const LAB_DIR = process.env.PHOSPHOR_LAB_DIR || join(DATA_DIR, 'lab'); // tests point it elsewhere
const BOX_DIR = join(LAB_DIR, '.box');
const CATALOG = join(LAB_DIR, '.cache', 'models.json'); // models.dev catalog: opencode inside the box reads this
const CATALOG_URL = 'https://models.dev/api.json';
const MAX_RUNNING = 8;

// The lab's own Claude sign-in (`claude setup-token`). Its own name, and taken out of the environment, so the
// chats and their tools never see it.
const claudeToken = process.env.PHOSPHOR_LAB_CLAUDE_TOKEN ?? '';
delete process.env.PHOSPHOR_LAB_CLAUDE_TOKEN;

export const APPS: Record<LabApp, { name: string; account: string; bin: string }> = {
  claude: { name: 'Claude Code', account: 'Claude plan', bin: 'claude' },
  codex: { name: 'Codex', account: 'ChatGPT', bin: 'codex' },
  opencode: { name: 'opencode', account: 'OpenCode Go', bin: 'opencode' },
  agy: { name: 'Antigravity', account: 'Google AI Pro', bin: geminiImage.bin }, // a path: ~/.local/bin is not on the server's PATH
  local: { name: 'Claude Code', account: 'This PC', bin: 'claude' },
};

// The current three, then older ones to test against (the owner, 2026-10-26: older models against local hardware).
// Their effort levels: Opus 4.5 has only low to high, Sonnet 4.5 none (the API refuses effort there). Sonnet 4.5
// retires on 2026-11-30: then take it out.
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODELS: [string, string, string[]][] = [
  ['claude-opus-5-5', 'Claude Opus 5.5', ALL_EFFORTS],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5', ALL_EFFORTS],
  ['claude-haiku-5-5', 'Claude Haiku 5.5', ALL_EFFORTS],
  ['claude-opus-5', 'Claude Opus 5', ALL_EFFORTS],
  ['claude-sonnet-5', 'Claude Sonnet 5', ALL_EFFORTS],
  ['claude-opus-4-5', 'Claude Opus 4.5', ['low', 'medium', 'high']],
  ['claude-sonnet-4-5', 'Claude Sonnet 4.5', []],
];

// ------------------------------------------------------------ small file helpers (shared with lab.ts)

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

// ------------------------------------------------------------ the apps

type Bin = { path: string; root: string; version: string };
const bins = new Map<string, Promise<Bin | null>>();

// Where an app's program is, what to show the box so it can start, and its version (for result.json).
function findBin(name: string): Promise<Bin | null> {
  let p = bins.get(name);
  if (!p) {
    p = (async () => {
      let path = name.includes('/') && existsSync(name) ? name : '';
      for (const [cmd, args] of name.includes('/') ? [] : ([['mise', ['which', name]], ['which', [name]]] as const)) {
        try {
          path = (await exec(cmd, [...args], { timeout: 20000 })).stdout.trim();
        } catch {
          /* next way */
        }
        if (path) break;
      }
      if (!path) return null;
      const real = realpathSync(path);
      const mise = real.match(/^(.*\/mise)\/installs\//); // a mise install needs its whole tree (shims, node_modules)
      let version = '';
      try {
        version = (await exec(path, ['--version'], { timeout: 30000 })).stdout.trim().split('\n')[0];
      } catch {
        /* unknown */
      }
      return { path, root: mise ? mise[1] : dirname(real), version };
    })();
    bins.set(name, p);
    void p.then((b) => b || bins.delete(name)); // not installed: look again next time
  }
  return p;
}

const hasBox = () => existsSync('/usr/bin/bwrap');

// Node.js for the box (models build web projects with npm): its folder goes on PATH, its install tree is shown.
async function tools(): Promise<{ path: string; roots: string[] }> {
  const node = await findBin('node');
  return node ? { path: `${dirname(node.path)}:/usr/bin:/bin`, roots: [node.root] } : { path: '/usr/bin:/bin', roots: [] };
}

type CatalogModel = { name?: string; reasoning_options?: { type?: string; values?: string[] }[] };
async function catalog(): Promise<Record<string, { name?: string; models?: Record<string, CatalogModel> }>> {
  const old = existsSync(CATALOG) ? Date.now() - statSync(CATALOG).mtimeMs : Infinity;
  if (old > 6 * 3600_000) {
    try {
      const r = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        mkdirSync(dirname(CATALOG), { recursive: true });
        writeFileSync(`${CATALOG}.tmp`, Buffer.from(await r.arrayBuffer()));
        renameSync(`${CATALOG}.tmp`, CATALOG);
      }
    } catch {
      /* keep the old one */
    }
  }
  return readJson(CATALOG) ?? {};
}

// ------------------------------------------------------------ effort

// The effort scale, lowest first ('none' = no thinking at all is never picked). A model that lacks the asked level
// gets the nearest one it has, the higher one on a tie; the result says which level it really ran at.
const SCALE = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_EFFORTS = ALL_EFFORTS; // claude --effort; the local relay turns them into a local model's own
const onScale = (xs: unknown[]) => [...new Set(xs.map(String).filter((x) => SCALE.includes(x)))].sort((a, b) => SCALE.indexOf(a) - SCALE.indexOf(b));

export function nearestEffort(asked: string, has: string[]): string {
  const at = SCALE.indexOf(asked);
  if (at < 0 || !has.length) return 'default';
  let best = 'default';
  let dist = Infinity;
  for (const h of has) {
    const i = SCALE.indexOf(h);
    const d = Math.abs(i - at);
    if (i >= 0 && (d < dist || (d === dist && i > SCALE.indexOf(best)))) [best, dist] = [h, d];
  }
  return best;
}

// agy's Google sign-in: one item in the desktop keyring. Read only to hand it to the box (plan) or to see it is there.
async function agySignIn(): Promise<string> {
  try {
    return (await exec('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'], { timeout: 15000, maxBuffer: 1 << 20 })).stdout;
  } catch {
    return '';
  }
}

let modelCache: { at: number; data: LabModelsResponse } | null = null;

export async function labModels(): Promise<LabModelsResponse> {
  if (modelCache && Date.now() - modelCache.at < 5 * 60_000) return modelCache.data;
  const models: LabModel[] = [];
  const notes: string[] = [];
  const add = (app: LabApp, id: string, name: string, efforts: string[]) =>
    models.push({ id: `${app}:${id}`, name, app, appName: APPS[app].name, account: APPS[app].account, efforts });
  if (!hasBox()) notes.push('bubblewrap (bwrap) is not installed, so no model can run safely. Install it, then reload.');

  const claude = await findBin('claude');
  if (!claude) notes.push('Claude Code is not installed.');
  else if (!claudeToken) notes.push('Claude: run `claude setup-token`, put the token in .env as PHOSPHOR_LAB_CLAUDE_TOKEN, restart.');
  else for (const [id, name, efforts] of CLAUDE_MODELS) add('claude', id, name, efforts);

  const codexAuth = join(process.env.CODEX_HOME || join(HOME, '.codex'), 'auth.json');
  if (!(await findBin('codex'))) notes.push('Codex is not installed.');
  else if (!existsSync(codexAuth)) notes.push('Codex: run `codex login` (or `codex login --device-auth` from a phone).');
  else {
    type C = { models?: { slug?: string; display_name?: string; visibility?: string; supported_reasoning_levels?: (string | { effort?: string })[] }[] };
    const list = readJson<C>(join(dirname(codexAuth), 'models_cache.json'))?.models ?? [];
    for (const m of list)
      if (m.slug && m.visibility === 'list') add('codex', m.slug, m.display_name || m.slug, onScale((m.supported_reasoning_levels ?? []).map((x) => (typeof x === 'string' ? x : x?.effort))));
    if (!list.length) add('codex', 'default', 'GPT (Codex default)', []);
  }

  if (!(await findBin('opencode'))) notes.push('opencode is not installed.');
  else {
    const cat = await catalog();
    let lines: string[] = [];
    try {
      lines = (await exec('opencode', ['models'], { timeout: 45000 })).stdout.split('\n');
    } catch {
      notes.push('opencode did not answer with its model list.');
    }
    const ids = lines.map((l) => l.trim()).filter((l) => /^(opencode-go|openrouter)\/\S+$/.test(l));
    for (const id of ids) {
      const [prov, ...rest] = id.split('/');
      const c = cat[prov]?.models?.[rest.join('/')];
      add('opencode', id, c?.name ?? rest.join('/'), onScale(c?.reasoning_options?.find((o) => o.type === 'effort')?.values ?? [])); // run as <model>#<level>
    }
    if (!ids.length && lines.length) notes.push('opencode: no OpenCode Go models. Run `opencode auth login opencode-go`.');
  }

  // agy lists each model once per effort ("gemini-4-argon-high"); the lab shows one entry and passes --effort.
  const agy = await findBin(APPS.agy.bin);
  if (!agy) notes.push('Antigravity (agy, for Gemini on a Google AI Pro plan) is not installed.');
  else if (!(await agySignIn())) notes.push('Antigravity (Gemini): run `agy` once in a terminal and sign in with Google.');
  else {
    let lines: string[] = [];
    try {
      lines = (await exec(agy.path, ['models'], { timeout: 45000, env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } })).stdout.split('\n');
    } catch {
      notes.push('Antigravity did not answer with its model list.');
    }
    const byBase = new Map<string, { name: string; efforts: string[] }>();
    for (const line of lines) {
      const [id, name] = line.split('\t').map((s) => s.trim());
      if (!id || !name || !/^[\w.-]+$/.test(id)) continue;
      const m = id.match(/^(.+)-(low|medium|high|xhigh|max)$/);
      const base = m ? m[1] : id;
      const e = byBase.get(base) ?? { name: name.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, ''), efforts: [] };
      if (m) e.efforts.push(m[2]);
      byBase.set(base, e);
    }
    for (const [id, e] of byBase) add('agy', id, e.name, onScale(e.efforts));
  }

  for (const m of localModel?.models ?? []) add('local', m.name, m.label.replace(/\s*\(local\)\s*$/i, ''), CLAUDE_EFFORTS);

  const data = { models, notes };
  modelCache = { at: Date.now(), data };
  return data;
}

// ------------------------------------------------------------ the box

// The host's /bin, /lib, /lib64, /sbin: the same symlinks (merged /usr) or the real folders.
function systemDirs(): string[] {
  const a: string[] = [];
  for (const d of ['/bin', '/lib', '/lib64', '/sbin']) {
    try {
      const s = lstatSync(d);
      if (s.isSymbolicLink()) a.push('--symlink', readlinkSync(d), d);
      else a.push('--ro-bind', d, d);
    } catch {
      /* not on this system */
    }
  }
  return a;
}

type BoxSpec = { env: Record<string, string>; bind?: [string, string][]; ro?: [string, string][] };

function boxArgs(home: string, work: string, roots: string[], spec: BoxSpec, cwd = WORK): string[] {
  const a = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--clearenv', '--ro-bind', '/usr', '/usr', ...systemDirs(), '--ro-bind', '/etc', '/etc'];
  if (existsSync('/run/systemd/resolve')) a.push('--ro-bind', '/run/systemd/resolve', '/run/systemd/resolve'); // DNS
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', home, HOME);
  for (const r of new Set(roots)) if (!r.startsWith('/usr/')) a.push('--ro-bind', r, r);
  a.push('--bind', work, WORK, '--chdir', cwd);
  for (const [s, d] of spec.bind ?? []) a.push('--bind', s, d);
  for (const [s, d] of spec.ro ?? []) a.push('--ro-bind', s, d);
  const env = { HOME, USER: userInfo().username, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', ...spec.env };
  for (const [k, v] of Object.entries(env)) a.push('--setenv', k, v);
  return a;
}

// ------------------------------------------------------------ what each app prints

type Live = { tokens: number; value: number | null; reply: string; error: string; limit: boolean; seen: Map<string, number> };
type Parse = (e: Record<string, any>, l: Live) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

const isLimit = (s: string) => /usage limit|rate limit|quota|limit (reached|exceeded)|too many requests/i.test(s);
const claudeTokens = (u: Record<string, number> | undefined) => (u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0);

const parseClaude: Parse = (e, l) => {
  if (e.type === 'assistant' && e.message?.id && e.message.usage) {
    l.seen.set(e.message.id, claudeTokens(e.message.usage)); // one API call can show more than once
    l.tokens = [...l.seen.values()].reduce((a, b) => a + b, 0);
  }
  if (e.type === 'result') {
    l.reply = String(e.result ?? '');
    l.tokens = Math.max(l.tokens, claudeTokens(e.usage));
    if (typeof e.total_cost_usd === 'number') l.value = e.total_cost_usd;
    if (e.is_error) {
      l.error = l.reply || String(e.subtype ?? 'error');
      l.limit = isLimit(l.error);
    }
  }
};

const parseCodex: Parse = (e, l) => {
  if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') l.reply = e.item.text;
  if (e.type === 'turn.completed' && e.usage) l.tokens += (e.usage.input_tokens ?? 0) + (e.usage.output_tokens ?? 0);
  if (e.type === 'error' || e.type === 'turn.failed') {
    l.error = String(e.message ?? e.error?.message ?? 'error');
    l.limit = isLimit(l.error);
  }
};

// opencode: text parts belong to messages; the reply is the text of the last message that has any.
const parseOpencode = (texts: Map<string, Map<string, string>>): Parse => (e, l) => {
  const p = e.part ?? {};
  if (e.type === 'text' && typeof p.text === 'string') {
    const m = texts.get(p.messageID) ?? new Map<string, string>();
    m.set(p.id, p.text);
    texts.delete(p.messageID);
    texts.set(p.messageID, m); // newest last
    l.reply = [...[...texts.values()].at(-1)!.values()].join('\n\n');
  }
  if (e.type === 'step_finish' && p.tokens) {
    const t = p.tokens;
    l.tokens += (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    if (typeof p.cost === 'number') l.value = (l.value ?? 0) + p.cost;
  }
  if (e.type === 'error') {
    l.error = String(e.error?.message ?? e.error?.type ?? 'error');
    l.limit = isLimit(`${l.error} ${e.error?.type ?? ''}`);
  }
};

// agy: the "result" event at the end has the reply, the status and the tokens.
const parseAgy: Parse = (e, l) => {
  if (e.event === 'result' && e.result) {
    l.reply = String(e.result.response ?? '');
    if (typeof e.result.usage?.total_tokens === 'number') l.tokens = e.result.usage.total_tokens;
    if (e.result.status && e.result.status !== 'SUCCESS') {
      l.error = l.reply.trim() || `Antigravity stopped: ${e.result.status}`;
      l.limit = isLimit(l.error);
    }
  }
  if (e.event === 'error') {
    l.error = String(e.error?.message ?? e.message ?? 'error');
    l.limit = isLimit(l.error);
  }
};

type Plan = { cmd: string[]; spec: BoxSpec; stdin: string; parse: Parse; roots: string[]; effort: string };

// Gemini in the box obeys the owner's Claude Code PreToolUse hooks (such as a block on writes to a production org), as
// Gemini chats do (scripts/agy-guards.mjs, docs/GEMINI-GUARDS.md): agy's hooks file and the hooks part of Claude
// Code's settings go in the box's home, read-only, with the guard script and the hook scripts they name. A hook that
// cannot run in the box blocks every tool step of that run: agy treats a failed hook as a block.
const GUARDS_SCRIPT = fileURLToPath(new URL('../scripts/agy-guards.mjs', import.meta.url));
export function labGuards(home: string): [string, string][] {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
  const groups = ['/etc/claude-code/managed-settings.json', join(claudeDir, 'settings.json')].flatMap((f) => readJson<{ hooks?: { PreToolUse?: { hooks?: { command?: string }[] }[] } }>(f)?.hooks?.PreToolUse ?? []);
  if (!groups.length) return [];
  const settings = join(home, '.claude', 'settings.json');
  const hooks = join(home, '.gemini', 'config', 'hooks.json');
  for (const f of [settings, hooks]) mkdirSync(dirname(f), { recursive: true });
  writeJson(settings, { hooks: { PreToolUse: groups } });
  writeJson(hooks, { 'phosphor-guards': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node /opt/phosphor/agy-guards.mjs hook', timeout: 60 }] }] } });
  const named = groups.flatMap((g) => g.hooks ?? []).flatMap((h) => String(h.command ?? '').match(/(?:~|\$\{?HOME\}?)?\/[\w.@%+\/-]+/g) ?? []);
  const files = [...new Set(named.map((f) => f.replace(/^(~|\$\{?HOME\}?)\//, `${HOME}/`)))].filter((f) => !/^\/(usr|etc)\//.test(f) && existsSync(f) && statSync(f).isFile());
  return [[settings, join(HOME, '.claude', 'settings.json')], [hooks, join(HOME, '.gemini', 'config', 'hooks.json')], [GUARDS_SCRIPT, '/opt/phosphor/agy-guards.mjs'], ...files.map((f): [string, string] => [f, f])];
}

async function plan(app: LabApp, model: string, prompt: string, home: string, asked: string): Promise<Plan> {
  const b = await findBin(APPS[app].bin);
  if (!b) throw new Error(`${APPS[app].name} is not installed.`);
  const roots = [b.root];
  const effort = nearestEffort(asked, (await labModels()).models.find((m) => m.id === `${app}:${model}`)?.efforts ?? []);
  const level = effort === 'default' ? [] : ['--effort', effort]; // claude and agy
  const quiet = { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CONFIG_DIR: join(HOME, '.claude') };
  const claudeCmd = (m: string) => [b.path, '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--model', m, ...level];
  if (app === 'claude') {
    if (!claudeToken) throw new Error('The lab has no Claude sign-in (PHOSPHOR_LAB_CLAUDE_TOKEN).');
    return { cmd: claudeCmd(model), spec: { env: { ...quiet, CLAUDE_CODE_OAUTH_TOKEN: claudeToken } }, stdin: prompt, parse: parseClaude, roots, effort };
  }
  if (app === 'agy') {
    // Its Google sign-in lives in the desktop keyring, which holds every other saved password too, so the box never
    // reaches it: the box starts its own D-Bus and an empty keyring, and only the one sign-in item comes in, on stdin.
    const token = await agySignIn();
    if (!token) throw new Error('Antigravity is not signed in: run `agy` once in a terminal and sign in with Google.');
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'antigravity-cli', 'settings.json'), JSON.stringify({ trustedWorkspaces: [WORK] }) + '\n');
    const sh = [
      'eval "$(printf lab-box | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"',
      // The keyring takes its D-Bus name a moment after it answers. A secret-tool call before that starts a second,
      // locked keyring with a password prompt the box cannot show (2026-10-24 and 10-26, with several models running).
      'i=0; until dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2>/dev/null | grep -q true; do i=$((i+1)); [ $i -gt 100 ] && { echo "the keyring in the box did not start" >&2; exit 3; }; sleep 0.05; done',
      `secret-tool store --label="Password for 'antigravity' on 'gemini'" service gemini username antigravity || exit 3`,
      'm="$1"; p="$2"; shift 2',
      'exec /opt/agy/agy -p "$p" --model "$m" --output-format stream-json --dangerously-skip-permissions "$@" </dev/null',
    ].join('\n');
    const text = prompt.startsWith('-') ? ` ${prompt}` : prompt; // never read as a flag
    const t = await tools();
    const spec: BoxSpec = { env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true', PATH: `/opt/agy:${t.path}` }, ro: [[realpathSync(b.path), '/opt/agy/agy'], ...labGuards(home)] };
    return { cmd: ['dbus-run-session', '--', '/bin/sh', '-c', sh, 'sh', model, text, ...level], spec, stdin: token, parse: parseAgy, roots: [], effort }; // only the one program file, not its folder
  }
  if (app === 'local') {
    const m = localModel?.models.find((x) => x.name === model);
    if (!localModel || !m) throw new Error('This local model is not set up any more.');
    const env = {
      ...quiet,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${LOCAL_RELAY_PORT}`, // the relay loads the model and shares the GPU
      ANTHROPIC_AUTH_TOKEN: localModel.key,
      ANTHROPIC_DEFAULT_OPUS_MODEL: m.name,
      ANTHROPIC_DEFAULT_SONNET_MODEL: m.name,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: m.name,
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(localModel.contexts[m.name] ?? localModel.context),
    };
    return { cmd: claudeCmd(m.name), spec: { env }, stdin: prompt, parse: (e, l) => (parseClaude(e, l), (l.value = null)), roots, effort };
  }
  if (app === 'codex') {
    const auth = join(process.env.CODEX_HOME || join(HOME, '.codex'), 'auth.json');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const cmd = [b.path, 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', WORK];
    if (model !== 'default') cmd.push('-m', model);
    if (effort !== 'default') cmd.push('-c', `model_reasoning_effort=${effort}`);
    cmd.push('-'); // the prompt comes on stdin
    // auth.json is bound, not copied: a token refresh in the box writes back to the one file.
    return { cmd, spec: { env: { CODEX_HOME: join(HOME, '.codex') }, bind: [[auth, join(HOME, '.codex', 'auth.json')]] }, stdin: prompt, parse: parseCodex, roots, effort };
  }
  // opencode: its sign-in is in its own database, so the box gets only the one it needs, imported on stdin.
  await catalog();
  const creds = JSON.parse((await exec('opencode', ['auth', 'export'], { timeout: 30000, maxBuffer: 1 << 20 })).stdout) as { integrationID?: string }[];
  const provider = model.split('/')[0];
  const mine = creds.filter((c) => c.integrationID === provider);
  if (!mine.length) throw new Error(`opencode has no sign-in for ${provider}.`);
  const env = {
    OPENCODE_MODELS_PATH: '/opt/lab/models.json',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', // no CLAUDE.md or skills from Claude Code
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
  const text = prompt.startsWith('-') ? ` ${prompt}` : prompt; // never read as a flag
  const sh = '"$0" auth import --standalone >/dev/null 2>&1 || exit 3; exec "$0" run --standalone --format json --auto -m "$1" "$2" </dev/null';
  const variant = effort === 'default' ? model : `${model}#${effort}`; // opencode's effort: the model's variant
  return { cmd: ['/bin/sh', '-c', sh, b.path, variant, text], spec: { env, ro: [[CATALOG, '/opt/lab/models.json']] }, stdin: JSON.stringify(mine), parse: parseOpencode(new Map()), roots, effort };
}

// ------------------------------------------------------------ runs

export type Job = { testDir: string; dir: string; prompt: string; timeLimitMin: number; effort: string };
type Running = { child: ChildProcess | null; live: Live; stop: 'time' | 'owner' | '' };

const running = new Map<string, Running>(); // key: <test dir>/<result dir>
const waiting: Job[] = [];
let localBusy = false;

const resultFile = (j: Job) => join(j.testDir, j.dir, 'result.json');
const keyOf = (j: Job) => join(j.testDir, j.dir);

// Live numbers for a result that is running (lab.ts shows them before result.json has them).
export function liveOf(testDir: string, dir: string): { tokens: number } | null {
  const r = running.get(join(testDir, dir));
  return r ? { tokens: r.live.tokens } : null;
}

export function queueRun(job: Job): void {
  waiting.push(job);
  pump();
}

// Starts what may start: at most MAX_RUNNING at once. A local model runs alone. The cloud models think elsewhere,
// but their installs, builds and browsers run in boxes on this PC, and a local engine needs most of its RAM: on
// 2026-10-24 Strata died 10 times when the RAM ran out during a 7-model test. So a local model starts only when no
// other run, queued cloud run or page build is left, and the cloud runs that come in meanwhile wait for it.
function pump(): void {
  const jobs = waiting
    .splice(0)
    .map((job) => ({ job, r: readJson<LabResult>(resultFile(job)) }))
    .filter((x): x is { job: Job; r: LabResult } => x.r?.state === 'queued');
  const go = startable(
    jobs.map((x) => x.r.app),
    { running: running.size, localBusy, building: building.size },
  );
  jobs.forEach((x, i) => (go[i] ? void start(x.job, x.r) : waiting.push(x.job)));
}

// pump()'s rule for the queue (in order), on its own so tests/lab-queue.ts can check it.
export function startable(apps: LabApp[], now: { running: number; localBusy: boolean; building: number }): boolean[] {
  let { running: n, localBusy: local } = now;
  return apps.map((app, i) => {
    const cloudLeft = n > (local ? 1 : 0) || now.building > 0 || apps.some((a, j) => j !== i && a !== 'local');
    const go = n < MAX_RUNNING && !local && (app !== 'local' || !cloudLeft);
    if (go) {
      n++;
      if (app === 'local') local = true;
    }
    return go;
  });
}

export function stopRuns(testDir: string): void {
  for (const j of waiting.filter((x) => x.testDir === testDir)) {
    const r = readJson<LabResult>(resultFile(j));
    if (r?.state === 'queued') writeJson(resultFile(j), { ...r, state: 'stopped', error: 'Stopped before it started.' });
  }
  for (const [k, run] of running) if (k.startsWith(testDir + '/')) kill(run, 'owner');
}

function kill(run: Running, why: 'time' | 'owner'): void {
  run.stop ||= why;
  const pid = run.child?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM'); // its own process group: systemd-run became bwrap, which takes the app with it
  } catch {
    /* gone */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }, 5000).unref();
}

async function start(job: Job, r: LabResult): Promise<void> {
  const key = keyOf(job);
  const live: Live = { tokens: 0, value: null, reply: '', error: '', limit: false, seen: new Map() };
  const run: Running = { child: null, live, stop: '' };
  running.set(key, run);
  if (r.app === 'local') localBusy = true;
  const home = join(BOX_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const resultDir = join(job.testDir, job.dir);
  const files = join(resultDir, 'files');
  const startedAt = Date.now();
  let exitCode: number | null = null;
  let stderr = '';
  try {
    mkdirSync(home, { recursive: true });
    mkdirSync(files, { recursive: true });
    const model = r.model.slice(r.model.indexOf(':') + 1);
    const p = await plan(r.app, model, job.prompt, home, job.effort);
    const t = await tools();
    p.spec.env.PATH ??= t.path;
    p.roots.push(...t.roots);
    const b = await findBin(APPS[r.app].bin);
    writeJson(resultFile(job), { ...r, state: 'running', startedAt, appVersion: b?.version ?? '', effort: p.effort });
    if (!hasBox()) throw new Error('bubblewrap (bwrap) is not installed.');
    const box = ['bwrap', ...boxArgs(home, files, p.roots, p.spec), ...p.cmd];
    const scoped = existsSync('/usr/bin/systemd-run');
    const [cmd, ...args] = scoped ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=4G', '--', ...box] : box;
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    run.child = child;
    const timer = setTimeout(() => kill(run, 'time'), job.timeLimitMin * 60_000);
    const log = createWriteStream(join(resultDir, 'log.jsonl'));
    child.stdin.on('error', () => {});
    child.stdin.end(p.stdin);
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-20000)));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      log.write(line + '\n');
      try {
        p.parse(JSON.parse(line), live);
      } catch {
        /* not JSON: kept in the log only */
      }
    });
    exitCode = await new Promise<number | null>((res) => {
      child.on('error', (e) => {
        stderr += `\n${e.message}`;
        res(-1);
      });
      child.on('close', (code) => res(code));
    });
    clearTimeout(timer);
    await new Promise<void>((res) => log.end(res));
  } catch (e) {
    live.error = e instanceof Error ? e.message : String(e);
  }
  const endedAt = Date.now();
  const lastErr = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
  let state: LabResult['state'] = 'done';
  let error = live.error;
  const timeUp = run.stop === 'time';
  if (timeUp) {
    // Same limit for every model: what it made by then is its result. Nothing made = failed.
    if (listFiles(files).length) error = '';
    else {
      state = 'failed';
      error = `Stopped: the time limit (${job.timeLimitMin} min) ran out before it made anything.`;
    }
  } else if (run.stop === 'owner') {
    state = 'stopped';
    error = 'Stopped by you.';
  } else if (live.limit) state = 'limit';
  else if (error || (exitCode !== 0 && !live.reply.trim())) {
    state = 'failed';
    error ||= lastErr || `The app stopped with code ${exitCode}.`;
  }
  if (stderr.trim()) writeFileSync(join(resultDir, 'stderr.txt'), stderr);
  writeFileSync(join(resultDir, 'reply.md'), live.reply);
  const now = readJson<LabResult>(resultFile(job)) ?? r; // stars or a note may have come in meanwhile
  writeJson(resultFile(job), { ...now, state, timeUp, startedAt, endedAt, tokens: live.tokens, value: live.value, error });
  rmSync(home, { recursive: true, force: true });
  running.delete(key);
  if (r.app === 'local') localBusy = false;
  if (state === 'done') {
    const site = pickPage(files, listFiles(files));
    if (!site.page && site.buildDir !== null) void buildPage(resultDir, site.buildDir); // before pump(): a local model waits for it
  }
  pump();
}

// ------------------------------------------------------------ the page to show, and building it

// Build junk: big, made again by one install or build. Never listed, REMOVE JUNK deletes it.
export const JUNK = new Set(['node_modules', '.cache', '__pycache__', '.venv', 'venv', '.pnpm-store', '.parcel-cache', '.turbo', '.next', '.nuxt', '.svelte-kit']);

// The files a model made (junk folders and symlinks left out: a link could point anywhere on the PC).
export function listFiles(root: string): { path: string; bytes: number }[] {
  const files: { path: string; bytes: number }[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || files.length >= 400) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (JUNK.has(n) || n === '.git') continue;
      const p = join(dir, n);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p, `${rel}${n}/`, depth + 1);
      else if (st.isFile()) files.push({ path: `${rel}${n}`, bytes: st.size });
    }
  };
  walk(root, '', 0);
  return files;
}

// Which web page to show. A built one first (dist/, build/, out/), then any page that runs as it is. A page that
// only loads source (/src/main.tsx) needs `npm run build`: buildDir says where (null: nothing to build).
export function pickPage(root: string, files: { path: string }[]): { page: string; buildDir: string | null } {
  const paths = files.map((f) => f.path);
  const html = paths.filter((p) => /\.html?$/i.test(p) && !/(^|\/)(public|src)\//.test(p));
  const depth = (p: string) => p.split('/').length;
  const built = html.filter((p) => /(^|\/)(dist|build|out)\/index\.html$/i.test(p)).sort((a, b) => depth(a) - depth(b));
  const index = html.filter((p) => /(^|\/)index\.html$/i.test(p)).sort((a, b) => depth(a) - depth(b));
  const source = (p: string) => {
    try {
      return /<script[^>]+src=["'][^"']*\.(jsx|tsx|ts|mts|vue|svelte)["']|<script[^>]+src=["']\/src\//i.test(readFileSync(join(root, p), 'utf8'));
    } catch {
      return false;
    }
  };
  const ready = [...built, ...index.filter((p) => !source(p)), ...html.filter((p) => !source(p))];
  if (ready.length) return { page: ready[0], buildDir: null };
  for (const p of paths.filter((x) => /(^|\/)package\.json$/.test(x)).sort((a, b) => depth(a) - depth(b))) {
    if (readJson<{ scripts?: Record<string, string> }>(join(root, p))?.scripts?.build) return { page: '', buildDir: p.includes('/') ? dirname(p) : '' };
  }
  return { page: html[0] ?? '', buildDir: null };
}

export type BuildState = '' | 'building' | 'done' | 'failed';
const building = new Set<string>();

export function buildState(resultDir: string): BuildState {
  if (building.has(resultDir)) return 'building';
  const b = readJson<{ state?: BuildState }>(join(resultDir, 'build.json'))?.state ?? '';
  return b === 'building' ? 'failed' : b; // 'building' on disk but not here: the server restarted during it
}

// `npm install && npm run build` in the box, in the project's folder. Vite gets --base=./ so the built page works
// from its own folder (the lab serves it under /lab/v/...). Output in build.log.
export async function buildPage(resultDir: string, projectRel: string): Promise<void> {
  if (building.has(resultDir) || !hasBox()) return;
  building.add(resultDir);
  const files = join(resultDir, 'files');
  const home = join(BOX_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const at = Date.now();
  let ok = false;
  try {
    writeJson(join(resultDir, 'build.json'), { state: 'building', at });
    mkdirSync(home, { recursive: true });
    const script = readJson<{ scripts?: Record<string, string> }>(join(files, projectRel, 'package.json'))?.scripts?.build ?? '';
    const t = await tools();
    const sh = `npm install --no-audit --no-fund --loglevel=error && npm run build${/\bvite\b/.test(script) ? ' -- --base=./' : ''}`;
    const box = ['bwrap', ...boxArgs(home, files, t.roots, { env: { PATH: t.path, PUBLIC_URL: '.' } }, join(WORK, projectRel)), '/bin/sh', '-c', sh];
    const scoped = existsSync('/usr/bin/systemd-run');
    const [cmd, ...args] = scoped ? ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=4G', '--', ...box] : box;
    const log = createWriteStream(join(resultDir, 'build.log'));
    log.write(`$ ${sh}\n`);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }, 8 * 60_000);
    const code = await new Promise<number | null>((res) => {
      child.on('error', () => res(-1));
      child.on('close', (c) => res(c));
    });
    clearTimeout(timer);
    await new Promise<void>((res) => log.end(res));
    ok = code === 0 && !!pickPage(files, listFiles(files)).page;
  } catch {
    ok = false;
  }
  writeJson(join(resultDir, 'build.json'), { state: ok ? 'done' : 'failed', at, ms: Date.now() - at });
  rmSync(home, { recursive: true, force: true });
  building.delete(resultDir);
  pump();
}

// After a restart: runs that were going are gone (the server held their output). Say so in their result.json.
export function markStopped(testDirs: string[]): void {
  for (const t of testDirs) {
    const test = readJson<{ results?: { dir: string }[] }>(join(t, 'test.json'));
    for (const { dir } of test?.results ?? []) {
      const f = join(t, dir, 'result.json');
      const r = readJson<LabResult>(f);
      if (r && (r.state === 'running' || r.state === 'queued')) writeJson(f, { ...r, state: 'stopped', endedAt: r.endedAt || Date.now(), error: 'The server restarted during this run.' });
    }
  }
  rmSync(BOX_DIR, { recursive: true, force: true }); // homes of runs that never finished
}
