#!/usr/bin/env node
// Gemini chats run through Google's agy, which does not read Claude Code's settings. This makes agy obey the same
// PreToolUse hooks Claude Code has (for example a block on writes to a production org): agy calls this script before
// every tool step, it turns agy's tool call into the shape Claude Code's hooks read, runs the hooks Claude Code would
// run, and answers agy. Docs: docs/GEMINI-GUARDS.md.
//
//   node scripts/agy-guards.mjs install    add the "phosphor-guards" entry to agy's ~/.gemini/config/hooks.json
//   node scripts/agy-guards.mjs remove     take it out again (other entries stay as they are)
//   node scripts/agy-guards.mjs status     say whether it is in place
//   node scripts/agy-guards.mjs hook       what agy runs (stdin: agy's tool call; stdout: its decision)
//
// agy blocks the tool when this answers "deny", and also when it fails, times out or prints no JSON (checked with
// agy 1.4.12, 2026-10-30). "ask" means no objection: agy's own mode decides (it does not run a refused tool).
// So every error here ends in "deny": a guard that cannot run blocks instead of waving the tool through.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'phosphor-guards';
const SCRIPT = fileURLToPath(import.meta.url);
const home = () => process.env.HOME || homedir();
export const hooksFile = () => join(home(), '.gemini', 'config', 'hooks.json');
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(home(), '.claude');
const HOOK_TIMEOUT_S = 30; // one Claude hook, when it sets none (agy's own limit for this script: AGY_TIMEOUT_S)
const AGY_TIMEOUT_S = 60;

// agy's tools (agy 1.4.12) as Claude Code's tools. Commands are Bash. File tools keep Claude's names. Every other
// tool (web search, helpers, connectors, any tool agy adds later) is checked as a command AND as a web address with
// all its text, so a tool that can reach a server is never missed: a mention of a blocked server in it is a block.
const COMMANDS = new Set(['run_command', 'manage_task', 'send_command_input', 'shell_exec']);
const FILES = { read_file: 'Read', write_file: 'Write', edit_file: 'Edit' };
// Helpers are agy agents too: their own steps come through here (tested), so the task given to one is not checked.
const LOCAL = new Set(['list_dir', 'list_directory', 'grep_search', 'find_by_name', 'view_file', 'view_file_outline', 'ask_question', 'send_message', 'invoke_subagent', 'define_subagent', 'manage_subagents']);

// The guards themselves are off limits to commands and file writes: else a BYPASS run could switch them off first
// (agy's shared hooks file, a folder's own .agents/hooks.json, Claude Code's settings and hooks, this script).
const TAMPER = /\.gemini\/config|\.agents\/hooks\.json|\.claude\/(settings[\w.-]*\.json|hooks)|agy-guards/i;

const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

// agy's tool call -> the Claude Code calls to check: [tool_name, tool_input][]
export function asClaude(name, args = {}) {
  const all = strings(args).join('\n');
  if (COMMANDS.has(name)) return [['Bash', { command: typeof args.CommandLine === 'string' ? args.CommandLine : all }]];
  if (FILES[name]) {
    const input = { file_path: args.Path ?? args.AbsolutePath ?? args.TargetFile ?? '' };
    if (name === 'write_file') input.content = args.Content ?? '';
    if (name === 'edit_file') Object.assign(input, { old_string: args.Target ?? '', new_string: args.Replacement ?? '' });
    return [[FILES[name], input]];
  }
  if (LOCAL.has(name)) return [];
  return [['Bash', { command: all }], ['WebFetch', { url: all, prompt: '' }]];
}

export function tampers(name, args = {}) {
  if (COMMANDS.has(name)) return TAMPER.test(strings(args).join('\n'));
  if (name === 'write_file' || name === 'edit_file') return TAMPER.test(String(args.Path ?? args.AbsolutePath ?? args.TargetFile ?? ''));
  return false;
}

// Claude Code's PreToolUse hooks, from the settings files it reads (managed, user, project, local).
export function claudeHooks(cwd) {
  const files = ['/etc/claude-code/managed-settings.json', join(claudeDir(), 'settings.json'), ...(cwd ? [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')] : [])];
  const out = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const groups = JSON.parse(readFileSync(f, 'utf8'))?.hooks?.PreToolUse ?? []; // a broken file throws: deny
    for (const g of groups) for (const h of g.hooks ?? []) if ((h.type ?? 'command') === 'command' && h.command) out.push({ matcher: g.matcher ?? '', command: h.command, timeout: h.timeout });
  }
  return out;
}

export const matches = (matcher, tool) => !matcher || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(tool);

function runHook(hook, input, cwd) {
  return new Promise((done) => {
    const child = spawn('/bin/sh', ['-c', hook.command], { cwd: cwd && existsSync(cwd) ? cwd : home(), env: { ...process.env, CLAUDE_PROJECT_DIR: cwd || '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => (child.kill('SIGKILL'), done({ block: `a guard took longer than ${hook.timeout ?? HOOK_TIMEOUT_S} s` })), (hook.timeout ?? HOOK_TIMEOUT_S) * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => (clearTimeout(timer), done({ block: `a guard could not start: ${e.message}` })));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 2) return done({ block: err.trim() || 'blocked by a guard' });
      if (code !== 0) return done({ block: `a guard failed (exit ${code}): ${err.trim().slice(0, 300)}` });
      try {
        const j = out.trim() ? JSON.parse(out) : {};
        if (j.decision === 'block' || j.hookSpecificOutput?.permissionDecision === 'deny') return done({ block: j.reason || j.hookSpecificOutput?.permissionDecisionReason || 'blocked by a guard' });
      } catch {
        /* plain text on stdout: Claude Code shows it, it is no decision */
      }
      done({});
    });
    child.stdin.on('error', () => {}); // a hook that exits without reading
    child.stdin.end(JSON.stringify(input));
  });
}

// One agy PreToolUse call -> agy's answer.
export async function decide(call) {
  const name = call?.toolCall?.name ?? '';
  const args = call?.toolCall?.args ?? {};
  const cwd = call?.workspacePaths?.[0] ?? '';
  if (tampers(name, args)) return { decision: 'deny', reason: 'Blocked by the Phosphor-OS guards: Gemini may not touch the safety guards (agy hooks, Claude Code settings and hooks).' };
  const checks = asClaude(name, args);
  if (!checks.length) return { decision: 'ask' };
  const hooks = claudeHooks(cwd);
  // The app's test call before a run (server/geminitab.ts, geminiGuards): also how many command hooks apply. agy never sends it.
  const count = call.phosphorCheck ? { guards: hooks.filter((h) => matches(h.matcher, 'Bash')).length } : {};
  const runs = checks.flatMap(([tool, input]) =>
    hooks.filter((h) => matches(h.matcher, tool)).map((h) => runHook(h, { session_id: call.conversationId ?? '', transcript_path: call.transcriptPath ?? '', cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }, cwd)),
  );
  const blocked = (await Promise.all(runs)).filter((r) => r.block).map((r) => r.block);
  return blocked.length ? { decision: 'deny', reason: blocked.join('\n'), ...count } : { decision: 'ask', ...count };
}

// ---- install / remove / status (agy's shared hooks file; other entries are kept as they are)

const readHooks = () => (existsSync(hooksFile()) ? JSON.parse(readFileSync(hooksFile(), 'utf8')) : {});
const writeHooks = (data) => {
  mkdirSync(dirname(hooksFile()), { recursive: true });
  writeFileSync(hooksFile() + '.tmp', JSON.stringify(data, null, 2) + '\n');
  renameSync(hooksFile() + '.tmp', hooksFile());
};
// Node as found on PATH (a version manager's stable link such as .../node/24/bin/node), not the exact version
// process.execPath names, which an update removes: a hook that cannot start blocks every Gemini tool step.
const nodeBin = () => (process.env.PATH ?? '').split(':').map((d) => join(d, 'node')).find((f) => d0(f)) ?? process.execPath;
const d0 = (f) => {
  try {
    return existsSync(f) && realpathSync(f) === realpathSync(process.execPath);
  } catch {
    return false;
  }
};
export const entry = (node = nodeBin(), script = SCRIPT) => ({
  PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `'${node}' '${script}' hook`, timeout: AGY_TIMEOUT_S }] }],
});

async function main(cmd) {
  if (cmd === 'hook') {
    let raw = '';
    for await (const c of process.stdin) raw += c;
    let answer;
    try {
      answer = await decide(JSON.parse(raw));
    } catch (e) {
      answer = { decision: 'deny', reason: `Blocked: the Phosphor-OS guards could not check this step (${e instanceof Error ? e.message : e}).` };
    }
    process.stdout.write(JSON.stringify(answer));
    return;
  }
  if (cmd === 'install') {
    if (SCRIPT.includes("'") || nodeBin().includes("'")) throw new Error('a path holds a quote mark');
    writeHooks({ ...readHooks(), [NAME]: entry() });
    console.log(`Installed: "${NAME}" in ${hooksFile()}. Gemini chats can run commands in AUTO and BYPASS once the server sees it (next message).`);
  } else if (cmd === 'remove') {
    const data = readHooks();
    if (!(NAME in data)) return console.log(`Not installed: ${hooksFile()} has no "${NAME}".`);
    delete data[NAME];
    writeHooks(data);
    console.log(`Removed "${NAME}" from ${hooksFile()}. Gemini chats run no commands again.`);
  } else if (cmd === 'status') {
    const e = readHooks()[NAME];
    console.log(e ? `Installed in ${hooksFile()}: ${e.PreToolUse?.[0]?.hooks?.[0]?.command}` : `Not installed (${hooksFile()}).`);
  } else {
    console.log('Usage: node scripts/agy-guards.mjs install | remove | status');
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT)) {
  main(process.argv[2]).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    if (process.argv[2] === 'hook') process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'Blocked: the Phosphor-OS guards failed.' }));
    process.exitCode = 1;
  });
}
