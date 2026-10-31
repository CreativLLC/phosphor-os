// The guards for Gemini's commands (scripts/agy-guards.mjs, docs/GEMINI-GUARDS.md): agy-shaped tool calls in, the
// decision agy gets out, against made-up Claude Code hooks in a temp folder (the owner's own hooks are never read:
// CLAUDE_CONFIG_DIR and HOME point at the temp folder). Also install / remove / status on a temp agy hooks file.
//   npx tsx tests/agy-guards.ts

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'phosphor-gemguard-'));
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'agy-guards.mjs');
const claude = join(tmp, 'claude');
const ws = join(tmp, 'ws');
mkdirSync(claude);
mkdirSync(join(ws, '.claude'), { recursive: true });
const env = { ...process.env, HOME: tmp, CLAUDE_CONFIG_DIR: claude };

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};

// Made-up guards in the shape of Claude Code hooks: exit 2 + stderr, or JSON on stdout.
const hook = (name: string, body: string) => {
  const f = join(tmp, `${name}.mjs`);
  writeFileSync(f, `import { appendFileSync } from 'node:fs'; let raw = ''; process.stdin.on('data', (c) => (raw += c)); process.stdin.on('end', () => { const d = JSON.parse(raw); const cmd = String(d.tool_input?.command ?? ''); const url = String(d.tool_input?.url ?? ''); ${body} });\n`);
  return `node '${f}'`;
};
const prod = hook('prod', "if (d.tool_name === 'Bash' && /\\bsf\\b.*\\bdeploy\\b/.test(cmd) && !/--target-org\\s+[\\w-]*sandbox/.test(cmd)) { console.error('BLOCKED: prod write'); process.exit(2); }");
const server = hook('server', "if (/10\\.99\\.0\\.7/.test(d.tool_name === 'WebFetch' ? url : /\\b(curl|ssh)\\b/.test(cmd) ? cmd : '')) { console.error('BLOCKED: media server'); process.exit(2); }");
const json = hook('json', "if (/forbidden-json/.test(cmd)) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'BLOCKED: json says no' } }));");
const seen = hook('seen', `appendFileSync('${join(tmp, 'seen.log')}', JSON.stringify(d) + '\\n');`);
const settings = (hooks: unknown) => writeFileSync(join(claude, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: hooks } }));
const standard = [
  { matcher: 'Bash', hooks: [{ type: 'command', command: prod }] },
  { matcher: 'Bash|PowerShell|WebFetch', hooks: [{ type: 'command', command: server }] },
  { matcher: 'Bash', hooks: [{ type: 'command', command: json }] },
];
settings(standard);

const ask = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const r = spawnSync(process.execPath, [SCRIPT, 'hook'], { input: JSON.stringify({ conversationId: 'c1', workspacePaths: [ws], lastUserInput: 'please', stepIdx: 3, toolCall: { name, args }, ...extra }), env, encoding: 'utf8' });
  try {
    return JSON.parse(r.stdout) as { decision: string; reason?: string; guards?: number };
  } catch {
    return { decision: `no JSON (exit ${r.status}): ${r.stdout}${r.stderr}` };
  }
};
const denied = (what: string, d: { decision: string; reason?: string }, reason: RegExp) => check(what, d.decision === 'deny' && reason.test(d.reason ?? ''), JSON.stringify(d));
const passed = (what: string, d: { decision: string }) => check(what, d.decision === 'ask', JSON.stringify(d)); // "ask" = no objection: agy's mode decides

// ---- commands
denied('run_command: a prod write is blocked, with the hook\'s own words', ask('run_command', { CommandLine: 'sf project deploy start --target-org live-prod', WaitMsBeforeAsync: 5000 }), /^BLOCKED: prod write$/);
passed('run_command: the same deploy to a sandbox passes', ask('run_command', { CommandLine: 'sf project deploy start --target-org dev-sandbox' }));
denied('run_command: the media server address with curl is blocked', ask('run_command', { CommandLine: 'curl http://10.99.0.7:8080/' }), /media server/);
passed('run_command: a plain command passes', ask('run_command', { CommandLine: 'ls -la' }));
denied('run_command: a hook that answers in JSON (permissionDecision deny) blocks too', ask('run_command', { CommandLine: 'echo forbidden-json' }), /json says no/);
denied('manage_task: input typed into a running command is checked as a command', ask('manage_task', { Action: 'send_input', Input: 'sf project deploy start' }), /prod write/);
denied('both guards at once: both reasons', ask('run_command', { CommandLine: 'sf project deploy start; curl 10.99.0.7' }), /prod write[\s\S]*media server/);

// ---- web and other tools: checked as a web address (and a command) with all their text
denied('read_url_content: the address is blocked', ask('read_url_content', { Url: 'http://10.99.0.7/' }), /media server/);
denied('execute_url: the address is blocked', ask('execute_url', { Url: 'https://10.99.0.7/admin' }), /media server/);
denied('a tool agy may add later (browser): the address in any argument is blocked', ask('open_browser_url', { Url: 'http://10.99.0.7:8080/', Extra: { deep: ['x'] } }), /media server/);
passed('read_url_content: another site passes', ask('read_url_content', { Url: 'https://example.com/' }));
passed('search_web passes', ask('search_web', { query: 'weather' }));

// ---- files, local tools, helpers
passed('read_file passes (Claude Code hooks for Read would see it as Read)', ask('read_file', { Path: join(ws, 'a.txt') }));
passed('invoke_subagent passes: the helper\'s own steps come through the guards', ask('invoke_subagent', { Prompt: 'sf project deploy start', TypeName: 'self' }));
denied('write_file to agy\'s hooks file: blocked (a BYPASS run could switch the guards off)', ask('write_file', { Path: join(tmp, '.gemini', 'config', 'hooks.json'), Content: '{}' }), /may not touch the safety guards/);
denied('a command on Claude Code\'s settings: blocked', ask('run_command', { CommandLine: 'sed -i d ~/.claude/settings.json' }), /safety guards/);
denied('a command on the guard script: blocked', ask('run_command', { CommandLine: 'rm scripts/agy-guards.mjs' }), /safety guards/);
denied('write_file of a workspace hooks file for agy: blocked', ask('write_file', { Path: join(ws, '.agents', 'hooks.json'), Content: '{}' }), /safety guards/);

// ---- what the hook sees: Claude Code's shape
settings([{ matcher: '*', hooks: [{ type: 'command', command: seen }] }]);
ask('run_command', { CommandLine: 'echo one' });
ask('edit_file', { Path: join(ws, 'b.txt'), Target: 'old', Replacement: 'new' });
const lines = readFileSync(join(tmp, 'seen.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check("a hook gets Claude Code's PreToolUse input: Bash with the command, the folder, the event", lines[0].tool_name === 'Bash' && lines[0].tool_input.command === 'echo one' && lines[0].cwd === ws && lines[0].hook_event_name === 'PreToolUse' && lines[0].session_id === 'c1', JSON.stringify(lines[0]));
check('edit_file reaches a hook as Edit, with the path and both texts', lines[1].tool_name === 'Edit' && lines[1].tool_input.file_path === join(ws, 'b.txt') && lines[1].tool_input.old_string === 'old' && lines[1].tool_input.new_string === 'new', JSON.stringify(lines[1]));

// ---- matchers and the folder's own Claude Code settings
settings([{ matcher: 'Read', hooks: [{ type: 'command', command: prod }] }]);
passed('a hook for another tool (Read) is not run for a command', ask('run_command', { CommandLine: 'sf project deploy start' }));
writeFileSync(join(ws, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ command: prod }] }] } }));
denied("the chat folder's .claude/settings.json hooks run too (an empty matcher = every tool)", ask('run_command', { CommandLine: 'sf project deploy start' }), /prod write/);
rmSync(join(ws, '.claude', 'settings.json'));

// ---- a guard that cannot run blocks (fail closed)
settings([{ matcher: 'Bash', hooks: [{ type: 'command', command: hook('crash', 'process.exit(1);') }] }]);
denied('a hook that fails (exit 1): blocked', ask('run_command', { CommandLine: 'ls' }), /a guard failed \(exit 1\)/);
settings([{ matcher: 'Bash', hooks: [{ type: 'command', command: hook('slow', 'setTimeout(() => {}, 5000);'), timeout: 1 }] }]);
denied('a hook that takes too long: blocked', ask('run_command', { CommandLine: 'ls' }), /longer than 1 s/);
settings([{ matcher: 'Bash', hooks: [{ type: 'command', command: `node '${join(tmp, 'missing.mjs')}'` }] }]);
denied('a hook script that is gone: blocked', ask('run_command', { CommandLine: 'ls' }), /a guard failed/);
writeFileSync(join(claude, 'settings.json'), '{ not json');
denied("Claude Code's settings unreadable: blocked", ask('run_command', { CommandLine: 'ls' }), /could not check/);
const garbage = spawnSync(process.execPath, [SCRIPT, 'hook'], { input: 'not json', env, encoding: 'utf8' });
check('agy input that is not JSON: blocked', JSON.parse(garbage.stdout).decision === 'deny', garbage.stdout);

// ---- the app's test call: how many hooks apply to commands
settings(standard);
const probe = ask('run_command', { CommandLine: 'true' }, { phosphorCheck: true });
check("the app's test call: passes and counts the command hooks", probe.decision === 'ask' && probe.guards === 3, JSON.stringify(probe));
check('agy\'s own calls carry no count', ask('run_command', { CommandLine: 'true' }).guards === undefined);

// ---- install / remove / status: agy's shared hooks file, other entries kept
const hooksFile = join(tmp, '.gemini', 'config', 'hooks.json');
mkdirSync(join(tmp, '.gemini', 'config'), { recursive: true });
writeFileSync(hooksFile, JSON.stringify({ 'my-linter': { PostToolUse: [{ matcher: 'run_command', hooks: [{ command: 'true' }] }] } }));
const cli = (cmd: string) => spawnSync(process.execPath, [SCRIPT, cmd], { env, encoding: 'utf8' });
cli('install');
let file = JSON.parse(readFileSync(hooksFile, 'utf8'));
const command: string = file['phosphor-guards']?.PreToolUse?.[0]?.hooks?.[0]?.command ?? '';
check('install: a "phosphor-guards" entry for every tool, running this script; the owner\'s own entry kept', file['phosphor-guards']?.PreToolUse?.[0]?.matcher === '*' && command.includes(SCRIPT) && command.endsWith(' hook') && !!file['my-linter'], JSON.stringify(file));
check('install: again is the same (no second entry)', (cli('install'), Object.keys(JSON.parse(readFileSync(hooksFile, 'utf8'))).join()) === 'my-linter,phosphor-guards');
const viaAgy = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ workspacePaths: [ws], toolCall: { name: 'run_command', args: { CommandLine: 'sf project deploy start' } } }), env, encoding: 'utf8' });
check('the installed command, run the way agy runs it (sh -c), blocks', JSON.parse(viaAgy.stdout).decision === 'deny', viaAgy.stdout);
check('status: installed', /Installed in/.test(cli('status').stdout));
cli('remove');
file = JSON.parse(readFileSync(hooksFile, 'utf8'));
check('remove: only our entry goes', !file['phosphor-guards'] && !!file['my-linter'], JSON.stringify(file));
check('status: not installed', /Not installed/.test(cli('status').stdout));

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
