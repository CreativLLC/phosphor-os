#!/usr/bin/env node
// Hermes chats (server/hermestab.ts) run Nous Research's Hermes Agent, which does not read Claude Code's settings.
// Hermes runs this script before every tool call (a `pre_tool_call` shell hook). It does three things:
// - the same PreToolUse hooks Claude Code has (for example a block on writes to a production org), through the
//   mapping agy-guards.mjs uses for Gemini;
// - the chat's mode, which the app writes to data/hermes-modes.json: PLAN ONLY blocks every tool that changes
//   something, ASK FIRST sends each one to the chat for an OK first;
// - the guards themselves are off limits to commands and file writes.
// Docs: docs/HERMES.md.
//
//   node scripts/hermes-guards.mjs install    add the hook to ~/.hermes/config.yaml and Hermes's hook allowlist
//   node scripts/hermes-guards.mjs remove     take both out again
//   node scripts/hermes-guards.mjs status     say whether it is in place
//   node scripts/hermes-guards.mjs hook       what Hermes runs (stdin: the tool call; stdout: the decision)
//
// The hook is installed with fail_closed: a guard that fails, times out or prints no JSON blocks the tool.

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHooks, matches, runHook, TAMPER as AGY_TAMPER } from './agy-guards.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const home = () => process.env.HOME || homedir();
const hermesHome = () => process.env.HERMES_HOME || join(home(), '.hermes');
export const configFile = () => join(hermesHome(), 'config.yaml');
export const allowFile = () => join(hermesHome(), 'shell-hooks-allowlist.json');
export const modesFile = () => process.env.PHOSPHOR_HERMES_MODES || join(dirname(SCRIPT), '..', 'data', 'hermes-modes.json');
const BEGIN = '# >>> phosphor-guards (Phosphor-OS scripts/hermes-guards.mjs; remove with: node scripts/hermes-guards.mjs remove)';
const END = '# <<< phosphor-guards';
const TIMEOUT_S = 60;

// Hermes's tools as Claude Code's tools. Commands and code are Bash. Files keep Claude's names. Tools that only read
// Hermes's own state are not checked. Every other tool (web, browser, helpers, connectors, any tool Hermes adds later)
// is checked as a command AND as a web address with all its text, as for Gemini.
const COMMANDS = { terminal: 'command', execute_code: 'code' };
const LOCAL = new Set(['todo_list', 'memory', 'session_search', 'skills_list', 'skill_view', 'clarify', 'vision_analyze', 'kanban_show', 'kanban_list', 'kanban_attachments']);
// What changes something (blocked in PLAN ONLY, asked about in ASK FIRST). Reading tools and web search are not.
const READS = new Set([...LOCAL, 'read_file', 'search_files', 'web_search', 'web_extract']);

// Hermes's own settings, its hook allowlist, this script and the chat modes, on top of what agy-guards protects.
export const TAMPER = new RegExp(`${AGY_TAMPER.source}|\\.hermes/(config\\.ya?ml|shell-hooks-allowlist\\.json|\\.env)|hermes-guards|hermes-modes`, 'i');

const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

// Hermes's tool call -> the Claude Code calls to check: [tool_name, tool_input][]
export function asClaude(name, args = {}) {
  const all = strings(args).join('\n');
  if (COMMANDS[name]) return [['Bash', { command: typeof args[COMMANDS[name]] === 'string' ? args[COMMANDS[name]] : all }]];
  if (name === 'write_file') return [['Write', { file_path: String(args.path ?? ''), content: String(args.content ?? '') }]];
  if (name === 'patch') return [['Edit', { file_path: String(args.path ?? ''), old_string: String(args.old_string ?? ''), new_string: all }]];
  if (name === 'read_file') return [['Read', { file_path: String(args.path ?? '') }]];
  if (LOCAL.has(name)) return [];
  return [['Bash', { command: all }], ['WebFetch', { url: all, prompt: '' }]];
}

export function tampers(name, args = {}) {
  if (READS.has(name)) return false;
  return TAMPER.test(strings(args).join('\n'));
}

// What the OK card shows (Hermes shows only this text for a hook's request): the command, code, file or all the text.
function summary(args) {
  const pick = ['command', 'code', 'path', 'url', 'query'].map((k) => args[k]).find((v) => typeof v === 'string');
  const s = (pick ?? strings(args).join(' ')).replace(/\s+/g, ' ').trim();
  return s.length > 300 ? s.slice(0, 299) + '…' : s;
}

// The chat's mode, by Hermes session id (written by server/hermestab.ts). None: Hermes's own rules only.
function modeOf(session) {
  try {
    return JSON.parse(readFileSync(modesFile(), 'utf8'))?.[session] ?? '';
  } catch {
    return '';
  }
}

// One Hermes pre_tool_call -> the answer ({} = no objection).
export async function decide(call) {
  const name = call?.tool_name ?? '';
  const args = call?.tool_input ?? {};
  const cwd = call?.cwd ?? '';
  if (!name) return {};
  if (tampers(name, args)) return { decision: 'block', reason: 'Blocked by the Phosphor-OS guards: Hermes may not touch the safety guards (its own settings, hook list, Claude Code settings and hooks).' };
  const checks = asClaude(name, args);
  const hooks = checks.length ? claudeHooks(cwd) : [];
  const count = call.phosphorCheck ? { guards: hooks.filter((h) => matches(h.matcher, 'Bash')).length } : {};
  const runs = checks.flatMap(([tool, input]) =>
    hooks.filter((h) => matches(h.matcher, tool)).map((h) => runHook(h, { session_id: call.session_id ?? '', transcript_path: '', cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }, cwd)),
  );
  const blocked = (await Promise.all(runs)).filter((r) => r.block).map((r) => r.block);
  if (blocked.length) return { decision: 'block', reason: blocked.join('\n'), ...count };
  if (READS.has(name)) return count;
  const mode = modeOf(call.session_id ?? '');
  if (mode === 'plan') return { decision: 'block', reason: 'This chat is in PLAN ONLY mode: nothing may be changed or run. Write the plan as your reply instead.', ...count };
  if (mode === 'default') return { action: 'approve', message: `${name}: ${summary(args)}`, ...count };
  return count;
}

// ---- install / remove / status

// Node as found on PATH (a version manager's stable link), not the exact version an update removes.
const nodeBin = () => (process.env.PATH ?? '').split(':').map((d) => join(d, 'node')).find(sameNode) ?? process.execPath;
function sameNode(f) {
  try {
    return existsSync(f) && realpathSync(f) === realpathSync(process.execPath);
  } catch {
    return false;
  }
}
export const command = (node = nodeBin(), script = SCRIPT) => `'${node}' '${script}' hook`;
const block = (cmd) => [BEGIN, 'hooks:', '  pre_tool_call:', `    - command: "${cmd}"`, `      timeout: ${TIMEOUT_S}`, '      fail_closed: true', END].join('\n');
const strip = (text) => text.replace(new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`), '\n');
const write = (file, text) => {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
};
const readAllow = () => (existsSync(allowFile()) ? JSON.parse(readFileSync(allowFile(), 'utf8')) : {});

// '' = in place (config block with this script, and approved), else why not.
export function installed() {
  const text = existsSync(configFile()) ? readFileSync(configFile(), 'utf8') : '';
  if (!text.includes(BEGIN)) return 'not installed';
  if (!text.includes(SCRIPT)) return 'installed for another copy of Phosphor-OS';
  const ok = (readAllow().approvals ?? []).some((a) => a.event === 'pre_tool_call' && a.command?.includes(SCRIPT));
  return ok ? '' : `not in Hermes's hook allowlist (${allowFile()})`;
}

async function main(cmd) {
  if (cmd === 'hook') {
    let raw = '';
    for await (const c of process.stdin) raw += c;
    let answer;
    try {
      answer = await decide(JSON.parse(raw));
    } catch (e) {
      answer = { decision: 'block', reason: `Blocked: the Phosphor-OS guards could not check this step (${e instanceof Error ? e.message : e}).` };
    }
    process.stdout.write(JSON.stringify(answer));
    return;
  }
  if (cmd === 'install') {
    if (SCRIPT.includes("'") || SCRIPT.includes('"') || nodeBin().includes("'")) throw new Error('a path holds a quote mark');
    if (!existsSync(configFile())) throw new Error(`no Hermes config at ${configFile()}: install Hermes first`);
    const text = strip(readFileSync(configFile(), 'utf8'));
    if (/^hooks:/m.test(text)) throw new Error(`${configFile()} has its own "hooks:" section: add the hook there by hand (docs/HERMES.md)`);
    write(configFile(), `${text.replace(/\n*$/, '\n\n')}${block(command())}\n`);
    const allow = readAllow();
    allow.approvals = [...(allow.approvals ?? []).filter((a) => !a.command?.includes(SCRIPT)), { event: 'pre_tool_call', command: command() }];
    write(allowFile(), JSON.stringify(allow, null, 2) + '\n');
    console.log(`Installed: the Phosphor-OS guards run before every Hermes tool call (${configFile()}).`);
  } else if (cmd === 'remove') {
    if (existsSync(configFile())) write(configFile(), strip(readFileSync(configFile(), 'utf8')));
    if (existsSync(allowFile())) {
      const allow = readAllow();
      allow.approvals = (allow.approvals ?? []).filter((a) => !a.command?.includes(SCRIPT));
      write(allowFile(), JSON.stringify(allow, null, 2) + '\n');
    }
    console.log('Removed. Phosphor-OS will not start Hermes chats until the guards are back.');
  } else if (cmd === 'status') {
    const why = installed();
    console.log(why ? `Not in place: ${why}.` : `Installed: ${command()}`);
  } else {
    console.log('Usage: node scripts/hermes-guards.mjs install | remove | status');
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT)) {
  main(process.argv[2]).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    if (process.argv[2] === 'hook') process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Blocked: the Phosphor-OS guards failed.' }));
    process.exitCode = 1;
  });
}
