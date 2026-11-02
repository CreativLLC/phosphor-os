// opencode in a LAB box (server/labrun.ts, docs/GEMINI-GUARDS.md): an opencode plugin that runs every tool step past the
// owner's Claude Code PreToolUse hooks, through scripts/hook-bridge.mjs. opencode has no hooks of Claude Code's kind,
// so this turns its tool call into the input those hooks read and throws (= the tool does not run) when the bridge
// blocks. Fails closed: a bridge that cannot start, crashes or runs too long is a block too.
import { spawn } from 'node:child_process';

const BRIDGE = '/opt/phosphor/hook-bridge.mjs';
const HOOKS = '/opt/phosphor/hooks.json';
const LIMIT_MS = 120_000; // the bridge stops each hook by its own timeout, well before this

// opencode's tools as Claude Code's tools. Commands are Bash, file tools keep Claude's names, web pages are WebFetch.
// Tools that only look at the folder are not checked. Every other tool (connectors, anything added later) is checked as
// a command AND as a web address with all its text, so a tool that can reach a server is not missed.
const LOCAL = new Set(['read', 'glob', 'grep', 'list', 'todowrite', 'todoread', 'skill', 'question']);
const FILES = { write: 'Write', edit: 'Edit', patch: 'apply_patch', multiedit: 'MultiEdit' };
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

export function asClaude(tool, input = {}) {
  const all = strings(input).join('\n');
  if (tool === 'bash' || tool === 'shell') return [['Bash', { command: typeof input.command === 'string' ? input.command : all }]];
  if (tool === 'webfetch') return [['WebFetch', { url: typeof input.url === 'string' ? input.url : all, prompt: '' }]];
  if (FILES[tool]) {
    const file = input.filePath ?? input.path ?? input.file_path ?? '';
    return [[FILES[tool], tool === 'patch' ? { command: all } : { file_path: String(file), ...input }]];
  }
  if (LOCAL.has(tool)) return [];
  return [['Bash', { command: all }], ['WebFetch', { url: all, prompt: '' }]];
}

const bridge = (payload) =>
  new Promise((done) => {
    let err = '';
    const child = spawn('node', [BRIDGE, HOOKS], { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => (child.kill('SIGKILL'), done('the guards took too long')), LIMIT_MS);
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => (clearTimeout(timer), done(`the guards could not start: ${e.message}`)));
    child.on('close', (code) => (clearTimeout(timer), done(code === 0 ? '' : err.trim() || `the guards failed (exit ${code})`)));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });

export async function check(tool, input, ctx = {}) {
  for (const [name, args] of asClaude(tool, input)) {
    const why = await bridge({ session_id: ctx.sessionID ?? '', cwd: process.cwd(), hook_event_name: 'PreToolUse', tool_name: name, tool_input: args });
    if (why) throw new Error(why);
  }
}

export default {
  id: 'phosphor.guards',
  async setup(ctx) {
    await ctx.tool.hook('execute.before', (e) => check(e.tool, e.input, e));
  },
};
