#!/usr/bin/env node
// The owner's Claude Code PreToolUse hooks, for the CLIs that call hooks natively in Claude Code's shape (Claude
// Code itself and Codex) inside a LAB run's box (server/labrun.ts, docs/GEMINI-GUARDS.md). The CLI calls this for
// every tool step with the hook input on stdin; this runs the hooks listed in a settings file the app wrote for that
// run (only its PreToolUse part, copied from the owner's settings at the start of the run) and answers the CLI:
//
//   node hook-bridge.mjs <settings file>      exit 0 and no output: no objection. Exit 2 and the reason on stderr: block.
//
// Why a bridge and not the hooks themselves: a hook that crashes, times out or cannot start is no block to Claude
// Code (it carries on). Here every failure is a block: bad input, an unreadable settings file, a hook that exits with
// anything but 0 or 2, one that runs too long, one that prints broken JSON. The app's hook command also ends in
// `|| exit 2`, so a bridge that cannot start at all (no node, a missing file) blocks too.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { matches, runHook } from './agy-guards.mjs';

// The guards are off limits to the run's own commands and file writes (else it could switch them off first): this
// script and its folder, the hook settings and hooks of Claude Code, Codex, opencode and agy.
export const TAMPER = /\/opt\/phosphor|hook-bridge|agy-guards|\.claude\/(settings[\w.-]*\.json|hooks)|\.codex\/(hooks\.json|config\.toml)|\.config\/opencode|\.opencode\/plugin|\.agents\/hooks\.json|\.gemini\/config/i;
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

// What to look at for tamper: a command in full, a file tool's path (not what it writes: a page about hooks is fine).
// Codex's apply_patch holds the paths inside its patch text, so it is read in full.
const WHOLE = new Set(['Bash', 'PowerShell', 'apply_patch']);
const PATHS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export function tampers(tool, input) {
  if (WHOLE.has(tool)) return TAMPER.test(strings(input).join('\n'));
  if (PATHS.has(tool)) return TAMPER.test(String(input?.file_path ?? input?.notebook_path ?? input?.path ?? ''));
  return false;
}

// The PreToolUse hooks of a settings file; a missing or broken file throws (= block).
export function hooksOf(file) {
  if (!existsSync(file)) throw new Error(`no hooks file ${file}`);
  const groups = JSON.parse(readFileSync(file, 'utf8'))?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) throw new Error(`${file} has no hooks.PreToolUse list`);
  return groups.flatMap((g) => (g.hooks ?? []).filter((h) => (h.type ?? 'command') === 'command' && h.command).map((h) => ({ matcher: g.matcher ?? '', command: h.command, timeout: h.timeout })));
}

// One hook input -> { block } with the reason, or {}.
export async function check(input, file) {
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string') throw new Error('the hook input has no tool_name');
  const tool = input.tool_name;
  if (tampers(tool, input.tool_input)) return { block: 'Blocked by the Phosphor-OS LAB guards: a run may not touch its own guards (hook settings, hooks, the guard scripts).' };
  const blocked = (await Promise.all(hooksOf(file).filter((h) => matches(h.matcher, tool)).map((h) => runHook(h, input, input.cwd)))).filter((r) => r.block).map((r) => r.block);
  return blocked.length ? { block: blocked.join('\n') } : {};
}

async function main() {
  let answer;
  try {
    let raw = '';
    for await (const c of process.stdin) raw += c;
    answer = await check(JSON.parse(raw), process.argv[2] ?? '');
  } catch (e) {
    answer = { block: `Blocked: the Phosphor-OS LAB guards could not check this step (${e instanceof Error ? e.message : e}).` };
  }
  if (answer.block) {
    process.stderr.write(answer.block.trim() + '\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) void main();
