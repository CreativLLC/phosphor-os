// The guards for Claude Code and Codex in a LAB box (scripts/hook-bridge.mjs, server/labrun.ts labBridge,
// docs/GEMINI-GUARDS.md): Claude-shaped hook input in, exit code out, against made-up hooks in a temp folder (the
// owner's own hooks are never read or run). A hook that blocks, passes, crashes, runs too long or prints broken JSON.
//   npx tsx tests/hook-bridge.ts

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PHOSPHOR_PASSWORD ||= 'test'; // server/config.ts would otherwise make a password and write it to .env
const tmp = mkdtempSync(join(tmpdir(), 'phosphor-bridge-'));
const BRIDGE = join(import.meta.dirname, '..', 'scripts', 'hook-bridge.mjs');
let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};

// Made-up hooks, as Claude Code's own hooks are: a command that reads the hook input on stdin.
const hook = (name: string, body: string) => {
  const f = join(tmp, `${name}.mjs`);
  writeFileSync(f, `import { appendFileSync } from 'node:fs'; let raw = ''; process.stdin.on('data', (c) => (raw += c)); process.stdin.on('end', () => { const d = JSON.parse(raw); const cmd = String(d.tool_input?.command ?? ''); ${body} });\n`);
  return `node '${f}'`;
};
const seenLog = join(tmp, 'seen.log');
const hooks = {
  prod: hook('prod', "if (d.tool_name === 'Bash' && /sf project deploy/.test(cmd)) { console.error('BLOCKED: prod write'); process.exit(2); }"),
  json: hook('json', "if (/forbidden-json/.test(cmd)) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'BLOCKED: json says no' } }));"),
  old: hook('old', "if (/forbidden-old/.test(cmd)) process.stdout.write(JSON.stringify({ decision: 'block', reason: 'BLOCKED: old shape' }));"),
  crash: hook('crash', "if (/crash-me/.test(cmd)) process.exit(1);"),
  throws: hook('throws', "if (/throw-me/.test(cmd)) throw new Error('boom');"),
  slow: hook('slow', "if (/slow-me/.test(cmd)) setTimeout(() => {}, 60000); else process.exit(0);"),
  broken: hook('broken', "if (/broken-json/.test(cmd)) process.stdout.write('{\"hookSpecificOutput\": {\"permis');"),
  text: hook('text', "if (/plain-text/.test(cmd)) console.log('just some words');"),
  seen: hook('seen', `appendFileSync('${seenLog}', JSON.stringify(d) + '\\n');`),
  readOnly: hook('readonly', "console.error('BLOCKED: ran on a Read'); process.exit(2);"),
};
const group = (matcher: string, command: string, timeout?: number) => ({ matcher, hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] });
const settings = (name: string, groups: unknown[]) => {
  const f = join(tmp, `${name}.json`);
  writeFileSync(f, JSON.stringify({ theme: 'dark', hooks: { PreToolUse: groups } }));
  return f;
};
const standard = settings('standard', [
  group('Bash', hooks.prod),
  group('Bash', hooks.json),
  group('Bash', hooks.old),
  group('Bash', hooks.crash),
  group('Bash', hooks.throws),
  group('Bash', hooks.slow, 1),
  group('Bash', hooks.broken),
  group('Bash|PowerShell|WebFetch', hooks.text),
  group('Write', hooks.readOnly),
]);

const run = (input: unknown, file = standard, raw?: string) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [BRIDGE, file], { input: raw ?? JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t0 };
};
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ session_id: 's1', cwd: tmp, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...extra });
const blocks = (what: string, input: unknown, reason: RegExp, file = standard) => {
  const r = run(input, file);
  check(what, r.code === 2 && reason.test(r.err) && r.out === '', JSON.stringify(r));
};
const passes = (what: string, input: unknown, file = standard) => {
  const r = run(input, file);
  check(what, r.code === 0 && r.err === '' && r.out === '', JSON.stringify(r));
};

// ---- the hooks' own answers
passes('a plain command passes (no output, exit 0)', bash('echo hello'));
blocks("a hook that exits 2: blocked, with the hook's own words", bash('sf project deploy start'), /^BLOCKED: prod write\n?$/);
blocks('a hook that answers JSON (permissionDecision deny): blocked', bash('echo forbidden-json'), /json says no/);
blocks('a hook that answers the old JSON (decision block): blocked', bash('echo forbidden-old'), /old shape/);
passes('plain text on stdout with exit 0 is no decision (as in Claude Code)', bash('echo plain-text'));

// ---- fail closed
blocks('a hook that crashes (exit 1): blocked', bash('echo crash-me'), /failed \(exit 1\)/);
blocks('a hook that throws: blocked', bash('echo throw-me'), /failed \(exit 1\)/);
{
  const r = run(bash('echo slow-me'));
  check('a hook that runs past its timeout: blocked, and not waited for', r.code === 2 && /took longer than 1 s/.test(r.err) && r.ms < 20000, JSON.stringify(r));
}
blocks('a hook that prints broken JSON: blocked', bash('echo broken-json'), /broken JSON/);
blocks('a hook that cannot start: blocked', bash('echo hi'), /failed \(exit 127\)/, settings('nostart', [group('Bash', '/nonexistent/hook-script')]));
blocks('one hook passing does not outvote another that blocks', bash('echo hi && sf project deploy start'), /prod write/, settings('two', [group('Bash', hooks.seen), group('Bash', hooks.prod)]));
{
  const r = run(bash('echo forbidden-json && sf project deploy start && echo crash-me'));
  check('every blocking hook is reported', r.code === 2 && /prod write/.test(r.err) && /json says no/.test(r.err) && /failed/.test(r.err), JSON.stringify(r));
}

// ---- bad input, bad settings
blocks('input that is not JSON: blocked', null, /could not check/, standard);
check('input that is not JSON: exit 2', run(null, standard, 'not json').code === 2);
check('empty input: exit 2', run(null, standard, '').code === 2);
check('input without tool_name: exit 2', run({ cwd: tmp }).code === 2);
check('no settings file named: exit 2', spawnSync(process.execPath, [BRIDGE], { input: JSON.stringify(bash('echo hi')), encoding: 'utf8' }).status === 2);
blocks('a settings file that is missing: blocked', bash('echo hi'), /no hooks file/, join(tmp, 'nope.json'));
writeFileSync(join(tmp, 'bad.json'), '{ not json');
blocks('a settings file that is broken: blocked', bash('echo hi'), /could not check/, join(tmp, 'bad.json'));
writeFileSync(join(tmp, 'nohooks.json'), JSON.stringify({ theme: 'dark' }));
blocks('a settings file with no PreToolUse list: blocked', bash('echo hi'), /no hooks\.PreToolUse/, join(tmp, 'nohooks.json'));
passes('a settings file with an empty PreToolUse list: nothing to run, passes', bash('sf project deploy start'), settings('empty', []));
blocks('a matcher that is no regular expression: blocked', bash('echo hi'), /could not check/, settings('badmatcher', [group('(', hooks.seen)]));

// ---- matchers, and what the hooks are given
passes('a hook for Bash does not run for Read', { ...bash('x'), tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
blocks('a hook for Write runs for Write', { ...bash('x'), tool_name: 'Write', tool_input: { file_path: '/tmp/page.html', content: 'hi' } }, /ran on a Read/);
passes('a hook for Bash only does not run for PowerShell; Bash|PowerShell|WebFetch does', { ...bash('echo crash-me'), tool_name: 'PowerShell' });
{
  writeFileSync(seenLog, '');
  const input = bash('echo hello', { permission_mode: 'bypassPermissions', tool_use_id: 'toolu_1' });
  run(input, settings('seen', [group('*', hooks.seen)]));
  const seen = JSON.parse(readFileSync(seenLog, 'utf8').trim());
  check('the hook gets the CLI\'s own input unchanged', JSON.stringify(seen) === JSON.stringify(input), JSON.stringify(seen));
}

// ---- the guards guard themselves
const tamper = (what: string, input: unknown) => blocks(what, input, /may not touch its own guards/, settings('empty2', []));
tamper('a command naming Claude Code\'s settings: blocked', bash('echo {} > ~/.claude/settings.json'));
tamper('a command naming a project settings.local.json: blocked', bash('echo \'{"disableAllHooks":true}\' > .claude/settings.local.json'));
tamper('a command naming the guard folder: blocked', bash('cat /opt/phosphor/hooks.json'));
tamper('a command naming the bridge: blocked', bash('rm hook-bridge.mjs'));
tamper('a command naming Codex\'s hooks: blocked', bash('rm .codex/hooks.json'));
tamper('a command naming opencode\'s config folder: blocked', bash('echo x > ~/.config/opencode/plugins/a.js'));
tamper('Write to a hooks folder: blocked', { ...bash('x'), tool_name: 'Write', tool_input: { file_path: '/home/u/.claude/hooks/a.js', content: 'x' } });
tamper('Edit of the settings: blocked', { ...bash('x'), tool_name: 'Edit', tool_input: { file_path: '/home/u/work/.claude/settings.json', old_string: 'a', new_string: 'b' } });
tamper('apply_patch (Codex) naming its hooks: blocked', { ...bash('x'), tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: .codex/hooks.json\n+{}\n*** End Patch' } });
passes('a page that talks about hooks is fine to write', { ...bash('x'), tool_name: 'Write', tool_input: { file_path: '/home/u/work/index.html', content: 'edit .claude/settings.json to add hooks' } }, settings('empty3', []));
passes('a plain command passes the tamper check', bash('npm run build'), settings('empty4', []));

// ---- labBridge (what the app wires into a run): the hooks from Claude Code's settings, copied for the box
{
  const claude = join(tmp, 'claude');
  mkdirSync(claude);
  process.env.CLAUDE_CONFIG_DIR = claude;
  const { labBridge } = await import('../server/labrun.ts');
  const home = join(tmp, 'boxhome');
  mkdirSync(home);
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(' '));
  const none = labBridge(home, 'claude');
  console.warn = warn;
  const managed = existsSync('/etc/claude-code/managed-settings.json'); // a managed file on this PC would add hooks of its own
  check('no hooks in Claude Code\'s settings: no bridge, and the log says so', managed || (none === null && warns.length === 1 && /no command guards/.test(warns[0])), JSON.stringify({ none, warns }));
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [group('Bash', hooks.prod), group('Bash', hooks.slow, 100)] } }));
  const b = labBridge(home, 'codex');
  check('hooks in the settings: a bridge', !!b, 'null');
  if (b) {
    const hookCmd = b.hook.hooks?.[0];
    check('the group matches every tool and ends in || exit 2', b.hook.matcher === '*' && /hook-bridge\.mjs \/opt\/phosphor\/hooks\.json \|\| exit 2$/.test(hookCmd?.command ?? ''), JSON.stringify(b.hook));
    check('its timeout is longer than the slowest hook (100 s)', (hookCmd?.timeout ?? 0) > 100, String(hookCmd?.timeout));
    const into = (dest: string) => b.ro.find(([, d]) => d === dest)?.[0];
    check('the box gets the bridge and the guard script it imports, read-only', into('/opt/phosphor/hook-bridge.mjs') === BRIDGE && !!into('/opt/phosphor/agy-guards.mjs'), JSON.stringify(b.ro));
    const copy = into('/opt/phosphor/hooks.json');
    const groups = copy ? JSON.parse(readFileSync(copy, 'utf8')).hooks.PreToolUse : [];
    check('the box gets a copy of only the PreToolUse hooks', groups.length === 2 && !JSON.stringify(groups).includes('theme'), JSON.stringify(groups));
    check('the hook scripts the commands name come along', b.ro.some(([s, d]) => s === join(tmp, 'prod.mjs') && d === s), JSON.stringify(b.ro));
    // The same bridge, from the copy, with the box's paths mapped back: what the agent would run.
    if (copy) {
      const r = spawnSync('/bin/sh', ['-c', (hookCmd?.command ?? '').replace('/opt/phosphor/hook-bridge.mjs', BRIDGE).replace('/opt/phosphor/hooks.json', copy)], { input: JSON.stringify(bash('sf project deploy start')), encoding: 'utf8' });
      check('the command as the agent runs it blocks a prod write', r.status === 2 && /prod write/.test(r.stderr), JSON.stringify(r));
    }
    // A bridge that cannot start (no such file, as when node is missing) must block, not pass.
    const dead = spawnSync('/bin/sh', ['-c', (hookCmd?.command ?? '').replace('/opt/phosphor/hook-bridge.mjs', join(tmp, 'gone.mjs'))], { input: JSON.stringify(bash('echo hi')), encoding: 'utf8' });
    check('a bridge that cannot start blocks (exit 2)', dead.status === 2, JSON.stringify(dead));
    const noNode = spawnSync('/bin/sh', ['-c', hookCmd?.command ?? ''], { input: '{}', env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    check('no node in the box: blocks (exit 2)', noNode.status === 2, JSON.stringify(noNode));
  }
}

// ---- opencode's plugin (scripts/opencode-guards.mjs): its tools as Claude Code's, and a bridge that is not there blocks
{
  const plugin = await import('../scripts/opencode-guards.mjs');
  const same = (what: string, got: unknown, want: unknown) => check(what, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  same('opencode shell = Bash with the command', plugin.asClaude('shell', { command: 'ls -la' }), [['Bash', { command: 'ls -la' }]]);
  same('opencode webfetch = WebFetch with the address', plugin.asClaude('webfetch', { url: 'https://example.com/' }), [['WebFetch', { url: 'https://example.com/', prompt: '' }]]);
  same('opencode write = Write with the path', plugin.asClaude('write', { filePath: '/w/a.html', content: 'x' }), [['Write', { file_path: '/w/a.html', filePath: '/w/a.html', content: 'x' }]]);
  same('opencode read is not checked', plugin.asClaude('read', { filePath: '/w/a.html' }), []);
  same('an opencode tool nobody listed is checked as a command and an address, with all its text', plugin.asClaude('some_connector', { q: 'a', n: { r: 'b' } }), [['Bash', { command: 'a\nb' }], ['WebFetch', { url: 'a\nb', prompt: '' }]]);
  let hooked: ((e: unknown) => Promise<void>) | undefined;
  await plugin.default.setup({ tool: { hook: async (name: string, fn: (e: unknown) => Promise<void>) => name === 'execute.before' && (hooked = fn) } });
  check('the plugin hooks execute.before', typeof hooked === 'function');
  await hooked?.({ tool: 'read', input: { filePath: '/w/a.html' } });
  check('a tool that is not checked runs without the bridge', true);
  let thrown = '';
  await hooked?.({ tool: 'shell', input: { command: 'echo hi' } }).catch((e: Error) => (thrown = e.message));
  check('with no bridge in the box (it is only at /opt/phosphor there), a command is blocked', thrown !== '', 'it passed');
}

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
