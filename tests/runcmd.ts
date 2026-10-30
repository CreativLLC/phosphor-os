// RUN on code blocks (shared/runcmd.mjs, shell/term.mjs): which blocks get the button on each OS, the prompt
// stripping, the launch plan for Linux, macOS and Windows, and the generated scripts (the bash ones are run for
// real). No Electron, no terminal window. Only Linux can open a real window; Mac and Windows plans are checked
// as data only.
//   npx tsx tests/runcmd.ts

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availableKinds, bashScript, checkRun, codeLang, isAbsPath, launchPlan, runnableCommand } from '../shared/runcmd.mjs';
import { makeFind, runInTerminal } from '../shell/term.mjs';

let pass = 0;
let fail = 0;
const ok = (what: string, cond: boolean, got?: unknown) => {
  if (cond) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${JSON.stringify(got)}`);
  }
};
const eq = (what: string, got: unknown, want: unknown) => ok(what, JSON.stringify(got) === JSON.stringify(want), got);

// Languages per OS
ok('codeLang reads language-xxx', codeLang('language-Bash') === 'bash' && codeLang('') === '' && codeLang('foo language-sh') === 'sh');
for (const p of ['linux', 'darwin', 'win32']) {
  for (const l of ['bash', 'sh', 'shell', 'zsh']) eq(`${p}: ${l} gets RUN`, runnableCommand(l, 'ls\n', p)?.kind, 'bash');
  for (const l of ['js', 'python', 'json', '', 'diff', 'yaml']) eq(`${p}: '${l}' gets no RUN`, runnableCommand(l, 'ls\n', p), null);
}
for (const l of ['powershell', 'ps1', 'pwsh']) {
  eq(`win32: ${l} is powershell`, runnableCommand(l, 'Get-Date\n', 'win32')?.kind, 'powershell');
  eq(`linux/mac: ${l} gets no RUN`, [runnableCommand(l, 'x', 'linux'), runnableCommand(l, 'x', 'darwin')], [null, null]);
}
for (const l of ['cmd', 'bat']) {
  eq(`win32: ${l} is cmd`, runnableCommand(l, 'dir\n', 'win32')?.kind, 'cmd');
  eq(`linux/mac: ${l} gets no RUN`, [runnableCommand(l, 'x', 'linux'), runnableCommand(l, 'x', 'darwin')], [null, null]);
}
eq('an empty block gets no RUN', runnableCommand('bash', '\n\n', 'linux'), null);

// Prompt stripping
eq('bash block is kept as is (trailing newline off)', runnableCommand('bash', '# comment\nls -la\n', 'linux')?.cmd, '# comment\nls -la');
eq('console: $ prompts stripped, output dropped', runnableCommand('console', '$ echo hi\nhi\n$ ls\na b\n', 'linux')?.cmd, 'echo hi\nls');
eq('shell-session: # prompt stripped', runnableCommand('shell-session', '# pacman -Syu\n:: Synchronizing\n', 'darwin')?.cmd, 'pacman -Syu');
eq('console: backslash continuation kept', runnableCommand('console', '$ docker run \\\n> -it \\\n  alpine\nUnable to find image\n$ ls\n', 'linux')?.cmd, 'docker run \\\n-it \\\n  alpine\nls');
eq('console with output only gets no RUN', runnableCommand('console', 'Hello\nworld\n', 'linux'), null);

// checkRun
const home = '/home/x';
const dirs = new Set(['/srv/app', 'C:\\Work']);
const isDir = (p: string) => dirs.has(p);
eq('checkRun keeps an existing absolute folder', checkRun('ls', '/srv/app', 'linux', isDir, home), { cmd: 'ls', cwd: '/srv/app' });
eq('checkRun: missing folder -> home', checkRun('ls', '/nope', 'linux', isDir, home)?.cwd, home);
eq('checkRun: relative folder -> home', checkRun('ls', 'app', 'linux', isDir, home)?.cwd, home);
eq('checkRun: Windows folder', checkRun('dir', 'C:\\Work', 'win32', isDir, 'C:\\Users\\x')?.cwd, 'C:\\Work');
ok('isAbsPath per OS', isAbsPath('C:\\a', 'win32') && !isAbsPath('/a', 'win32') && isAbsPath('/a', 'linux') && !isAbsPath('C:\\a', 'linux'));
eq('checkRun: not a string', checkRun(5, '/srv/app', 'linux', isDir, home), null);
eq('checkRun: empty', checkRun('  \n', '/srv/app', 'linux', isDir, home), null);
eq('checkRun: 20 KB is the limit', [checkRun('a'.repeat(20 * 1024), '/', 'linux', isDir, home) !== null, checkRun('a'.repeat(20 * 1024 + 1), '/', 'linux', isDir, home)], [true, null]);
eq('checkRun: NUL byte', checkRun('ls\0', '/srv/app', 'linux', isDir, home), null);

// Which kinds this PC can run
const have = (...names: string[]) => (n: string) => (names.includes(n) ? `/bin/${n}` : null);
eq('linux with a terminal', availableKinds('linux', have('foot')), ['bash']);
eq('linux without one', availableKinds('linux', have()), []);
eq('mac', availableKinds('darwin', have()), ['bash']);
eq('windows: no bash', availableKinds('win32', have()), ['powershell', 'cmd']);
eq('windows: Git Bash', availableKinds('win32', have('git-bash')), ['powershell', 'cmd', 'bash']);
eq('windows: WSL', availableKinds('win32', have('wsl')), ['powershell', 'cmd', 'bash']);

// Launch plans
const secret = `ls '$(touch /tmp/pwned)' "x" \`id\`; echo $HOME`;
const lin = launchPlan('linux', 'bash', { cmd: secret, cwd: '/srv/app' }, '', have('xdg-terminal-exec', 'foot'))!;
eq('linux: xdg-terminal-exec first', [lin.file, lin.args.slice(0, 3)], ['/bin/xdg-terminal-exec', ['--', 'bash', '-c']]);
ok('linux: the command is only in the environment', lin.env?.PHOSPHOR_RUN_CMD === secret && !lin.args.join('\n').includes('pwned') && lin.files.length === 0);
eq('linux: foot when it is alone', launchPlan('linux', 'bash', { cmd: 'x', cwd: '/' }, '', have('foot'))?.file, '/bin/foot');
eq('linux: alacritty takes -e', launchPlan('linux', 'bash', { cmd: 'x', cwd: '/' }, '', have('alacritty'))?.args.slice(0, 2), ['-e', 'bash']);
eq('linux: no terminal', launchPlan('linux', 'bash', { cmd: 'x', cwd: '/' }, '', have()), null);
eq('linux: powershell kind is refused', launchPlan('linux', 'powershell', { cmd: 'x', cwd: '/' }, '', have('foot')), null);

const mac = launchPlan('darwin', 'bash', { cmd: secret, cwd: "/Users/a b/it's" }, '/tmp/phosphor-run-1', have())!;
eq('mac: open -a Terminal <script>', [mac.file, mac.args, mac.waitExit], ['/usr/bin/open', ['-a', 'Terminal', '/tmp/phosphor-run-1/run.command'], true]);
eq('mac: script is 0700 and has the command and the folder', [mac.files[0].mode, mac.files[0].content.includes(secret), mac.files[0].content.includes("cd -- '/Users/a b/it'\\''s'")], [0o700, true, true]);
ok('mac: ends in the login shell', mac.files[0].content.includes('exec "${SHELL:-/bin/zsh}" -l'));

const wdir = 'C:\\Users\\a b\\AppData\\Local\\Temp\\phosphor-run-1';
const psPlan = launchPlan('win32', 'powershell', { cmd: 'Get-Date', cwd: "C:\\Work\\o'brien" }, wdir, have('wt'))!;
eq('win: powershell in Windows Terminal', [psPlan.file, psPlan.args.slice(0, 5)], ['/bin/wt', ['powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File']]);
eq('win: the .ps1 path', psPlan.args[5], `${wdir}\\run.ps1`);
ok('win: ps script quotes the folder, command is a file', psPlan.files[0].content.includes("'C:\\Work\\o''brien'") && !psPlan.files[0].content.includes('Get-Date') && psPlan.files[1].content.includes('Get-Date'));
const psStart = launchPlan('win32', 'powershell', { cmd: 'x', cwd: 'C:\\Work' }, wdir, have())!;
eq('win: no wt -> cmd /c start', [psStart.file, psStart.args.slice(0, 4)], ['cmd.exe', ['/c', 'start', '', 'powershell.exe']]);
const cmdPlan = launchPlan('win32', 'cmd', { cmd: 'dir\necho 100%', cwd: 'C:\\Work' }, wdir, have())!;
eq('win: cmd /k call', cmdPlan.args.slice(-4), ['cmd.exe', '/k', 'call', `${wdir}\\run.cmd`]);
ok('win: cmd wrapper and user file, CRLF', cmdPlan.files[0].content.includes('cd /d "C:\\Work"') && cmdPlan.files[1].content === 'dir\r\necho 100%');
const git = launchPlan('win32', 'bash', { cmd: 'ls', cwd: 'C:\\Work' }, wdir, have('git-bash'))!;
eq('win: Git Bash runs the script by its /c/ path', [git.file, git.args.slice(-3)], ['cmd.exe', ['--login', '-i', '/c/Users/a b/AppData/Local/Temp/phosphor-run-1/run.sh']]);
ok('win: Git Bash script goes to /c/Work', git.files[0].content.includes("cd -- '/c/Work'") && git.args.includes('/c/Users/a b/AppData/Local/Temp/phosphor-run-1/run.sh'));
const wsl = launchPlan('win32', 'bash', { cmd: 'ls', cwd: 'C:\\Work' }, wdir, have('wsl'))!;
ok('win: WSL runs bash on /mnt/c/ paths', wsl.args.includes('/mnt/c/Users/a b/AppData/Local/Temp/phosphor-run-1/run.sh') && wsl.args.includes('/bin/wsl') && wsl.args.includes('-e') && wsl.files[0].content.includes("cd -- '/mnt/c/Work'"), wsl.args);
eq('win: bash with neither Git Bash nor WSL', launchPlan('win32', 'bash', { cmd: 'ls', cwd: 'C:\\Work' }, wdir, have()), null);

// The bash scripts, for real (the macOS / Git Bash / WSL one, and the Linux one)
const tmp = mkdtempSync(join(tmpdir(), 'runcmd-test-'));
try {
  const work = join(tmp, "it's here");
  spawnSync('mkdir', ['-p', work]);
  const cmds = ['pwd', `printf '%s\\n' "$(echo "a 'b' \\$c")"`, 'cat <<EOF\ninside\nEOF', 'PHOSPHOR_EOF\necho after-fake-end', 'false; echo kept-going'];
  for (const c of cmds) {
    const dir = mkdtempSync(join(tmp, 'd-'));
    const file = join(dir, 'run.command');
    // The last line starts the owner's shell; a test replaces it with a plain exit.
    writeFileSync(file, bashScript(work, c, true).replace(/^exec .*$/m, 'echo END-OF-SCRIPT'), { mode: 0o700 });
    const r = spawnSync('bash', [file], { encoding: 'utf8' });
    const direct = spawnSync('bash', ['-c', c], { cwd: work, encoding: 'utf8' });
    ok(`script runs '${c.replace(/\n/g, ' | ')}'`, r.stdout.includes(direct.stdout) && r.stdout.includes('END-OF-SCRIPT') && r.stdout.includes(`$ ${c}`), r.stdout);
    ok('script removed itself and its folder', !existsSync(file) && !existsSync(dir));
  }
  // Linux: the real argument list, with the shell not interactive (stdin closed) so that it ends
  const lp = launchPlan('linux', 'bash', { cmd: secret.replace(/;.*/, '; echo done $PHOSPHOR_RUN_CMD.'), cwd: work }, '', have('foot'))!;
  const r = spawnSync('bash', lp.args.slice(2), { env: { ...process.env, ...lp.env }, cwd: work, encoding: 'utf8', input: '' });
  ok('linux script prints the command and runs it, variable gone', r.stdout.includes('$ ls ') && r.stdout.includes('done .') && !existsSync('/tmp/pwned'), r.stdout);
  rmSync('/tmp/pwned', { force: true });

  // term.mjs, without opening a window
  const bad = await runInTerminal('echo hi', '/', 'bash', { platform: 'linux', find: () => null });
  ok('no terminal: a clear error', !bad.ok && /No terminal/.test(bad.error ?? ''), bad);
  const wrong = await runInTerminal('echo hi', '/', 'powershell', { platform: 'linux', find: have('foot') });
  ok('wrong kind: refused', !wrong.ok, wrong);
  const big = await runInTerminal('x'.repeat(30000), '/', 'bash', { platform: 'linux', find: have('foot') });
  ok('too big: refused', !big.ok, big);
  const find = makeFind('linux');
  ok('makeFind finds sh and not nonsense', !!find('sh') && find('no-such-terminal-xyz') === null);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
