// RUN on a code block in a chat: which blocks get the button on which OS, and how the desktop app opens a
// terminal window that runs the command and stays open. Pure (no fs, no processes): the page imports it for the
// languages, shell/term.mjs for the launch (tests/runcmd.ts tries all three platforms).
// platform is process.platform: 'linux', 'darwin' or 'win32'. kind is what runs the command:
// 'bash' (everywhere), 'powershell' and 'cmd' (Windows only).

export const MAX_CMD = 20 * 1024;

const BASH_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'shell-session']);
const TRANSCRIPT_LANGS = new Set(['console', 'shell-session']); // prompt lines are the commands, the rest is output
const POWERSHELL_LANGS = new Set(['powershell', 'ps1', 'pwsh']);
const CMD_LANGS = new Set(['cmd', 'bat']);

// Terminals on Linux, in the order of the Hyprland safety-net key (os/hyprland/phosphor-os.lua); `lead` is how each
// takes "run this program": xdg-terminal-exec picks the owner's terminal (xdg-terminals.list).
const LINUX_TERMINALS = [
  ['xdg-terminal-exec', ['--']],
  ['foot', ['--']],
  ['alacritty', ['-e']],
  ['kitty', ['--']],
  ['ghostty', ['-e']],
  ['gnome-terminal', ['--']],
  ['konsole', ['-e']],
  ['xterm', ['-e']],
];

// The language of a code block from its class ("language-bash"), lower-case, or ''.
export function codeLang(className) {
  return /(?:^|\s)language-([^\s]+)/.exec(className)?.[1]?.toLowerCase() ?? '';
}

// What runs a block of this language on this OS: 'bash', 'powershell', 'cmd', or null (no RUN button).
export function langKind(lang, platform) {
  if (BASH_LANGS.has(lang)) return 'bash';
  if (platform !== 'win32') return null;
  if (POWERSHELL_LANGS.has(lang)) return 'powershell';
  if (CMD_LANGS.has(lang)) return 'cmd';
  return null;
}

// { kind, cmd } for a block, or null when it has no command (other language, no language, only output).
export function runnableCommand(lang, text, platform) {
  const kind = langKind(lang, platform);
  if (!kind) return null;
  const body = text.replace(/\n+$/, '');
  const cmd = TRANSCRIPT_LANGS.has(lang) ? fromTranscript(body) : body;
  return cmd.trim() ? { kind, cmd } : null;
}

// Prompt lines ('$ ' or '# ') without the prompt; lines without one are output and dropped. A line that ends in a
// backslash carries on in the next line, which stays (a leading '> ' secondary prompt removed).
function fromTranscript(body) {
  const out = [];
  let carry = false;
  for (const line of body.split('\n')) {
    const m = /^[$#] (.*)$/.exec(line);
    if (m) {
      out.push(m[1]);
      carry = m[1].endsWith('\\');
    } else if (carry) {
      const rest = line.replace(/^> ?/, '');
      out.push(rest);
      carry = rest.endsWith('\\');
    }
  }
  return out.join('\n');
}

// An absolute path on this OS. (Folders from the chat are the server's: only the desktop app's own PC counts.)
export function isAbsPath(p, platform) {
  return typeof p === 'string' && (platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|\\\\[^\\])/.test(p) : p.startsWith('/'));
}

// The request as the desktop app accepts it: { cmd, cwd } or null. A cwd that is not an existing absolute folder
// becomes `home`. isDir(path) says whether a folder exists.
export function checkRun(cmd, cwd, platform, isDir, home) {
  if (typeof cmd !== 'string' || !cmd.trim() || cmd.includes('\0') || new TextEncoder().encode(cmd).length > MAX_CMD) return null;
  return { cmd, cwd: isAbsPath(cwd, platform) && isDir(cwd) ? cwd : home };
}

// The terminal for Linux, from find(name) -> path | null.
export function linuxTerminal(find) {
  for (const [name, lead] of LINUX_TERMINALS) {
    const file = find(name);
    if (file) return { file, lead };
  }
  return null;
}

// Which kinds can run here: ['bash'], or on Windows ['powershell', 'cmd'] plus 'bash' when Git Bash or WSL is found.
export function availableKinds(platform, find) {
  if (platform === 'darwin') return ['bash'];
  if (platform === 'linux') return linuxTerminal(find) ? ['bash'] : [];
  return ['powershell', 'cmd', ...(find('git-bash') || find('wsl') ? ['bash'] : [])];
}

// Linux: nothing is written to disk. The command comes in an environment variable and bash evals it from there;
// the variable is gone before the new shell starts.
const LINUX_SCRIPT = [
  'cmd=$PHOSPHOR_RUN_CMD; unset PHOSPHOR_RUN_CMD',
  "printf '\\033[2m$ %s\\033[0m\\n' \"$cmd\"",
  'eval "$cmd"',
  'exec bash -i',
].join('\n');

const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`; // bash single quotes

// A bash script file (macOS, Git Bash, WSL): goes to its own folder, deletes itself, goes to `cwd`, shows the
// command, runs it, then stays as a login shell. The command sits in a quoted here-document: text, never code of
// the script itself.
export function bashScript(cwd, cmd, mac) {
  let end = 'PHOSPHOR_EOF';
  while (cmd.split('\n').includes(end)) end += '_X';
  return [
    '#!/bin/bash',
    'rm -f -- "$0"; rmdir -- "$(dirname -- "$0")" 2>/dev/null',
    `cd -- ${sq(cwd)} 2>/dev/null || cd`,
    'cmd=$(cat <<\'' + end + "'",
    cmd,
    end,
    ')',
    "printf '\\033[2m$ %s\\033[0m\\n' \"$cmd\"",
    'eval "$cmd"',
    mac ? 'exec "${SHELL:-/bin/zsh}" -l' : 'exec bash --login -i',
    '',
  ].join('\n');
}

const psq = (s) => `'${s.replace(/['\u2018\u2019\u201A\u201B]/g, (c) => c + c)}'`; // PowerShell single quotes
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');

// PowerShell: the command is read from a file as text and run with Invoke-Expression, so a mistake in it shows in
// the window after the command is printed. The script removes its folder once it has read it.
function psScript(cwd) {
  return crlf(
    [
      '\uFEFF$d = $PSScriptRoot',
      "$c = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $d 'cmd.txt')",
      `Set-Location -LiteralPath ${psq(cwd)} -ErrorAction SilentlyContinue`,
      'Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue',
      "Write-Host ('> ' + $c.TrimEnd()) -ForegroundColor DarkGray",
      'Invoke-Expression $c',
      '',
    ].join('\n'),
  );
}

// cmd.exe: the command is a batch file the wrapper shows and calls. Batch rules apply (%% in loops, not %).
function cmdWrapper(cwd, dir) {
  return crlf(['@echo off', '@chcp 65001 >nul', `cd /d "${cwd.replace(/%/g, '%%')}"`, `type "${dir}\\user.cmd"`, 'echo.', `call "${dir}\\user.cmd"`, ''].join('\n'));
}

// C:\a\b to /c/a/b (Git Bash) or /mnt/c/a/b (WSL); null for a path that has no drive letter.
function unixPath(p, prefix) {
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p);
  return m ? `${prefix}/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`.replace(/\/$/, '') : null;
}

// How to open the terminal: { file, args, env?, cwd?, files, waitExit } or null when this OS has no way (no
// terminal, no bash on Windows). `req` is checkRun's answer; `dir` a new private folder for the script files
// (made by the caller; `files` are { name, content, mode } to write into it); find(name) -> path | null.
export function launchPlan(platform, kind, req, dir, find) {
  const { cmd, cwd } = req;
  if (platform === 'linux') {
    const t = kind === 'bash' && linuxTerminal(find);
    return t ? { file: t.file, args: [...t.lead, 'bash', '-c', LINUX_SCRIPT], env: { PHOSPHOR_RUN_CMD: cmd }, cwd, files: [], waitExit: false } : null;
  }
  if (platform === 'darwin') {
    if (kind !== 'bash') return null;
    const file = `${dir}/run.command`;
    // `open` returns at once; Terminal runs the script. Its exit code says whether Terminal could be asked.
    return { file: '/usr/bin/open', args: ['-a', 'Terminal', file], cwd: undefined, files: [{ name: 'run.command', content: bashScript(cwd, cmd, true), mode: 0o700 }], waitExit: true };
  }
  if (platform !== 'win32') return null;
  let inner;
  let files;
  if (kind === 'powershell') {
    inner = [find('powershell') || 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', `${dir}\\run.ps1`];
    files = [
      { name: 'run.ps1', content: psScript(cwd), mode: 0o600 },
      { name: 'cmd.txt', content: `\uFEFF${cmd}`, mode: 0o600 },
    ];
  } else if (kind === 'cmd') {
    inner = [find('cmd') || 'cmd.exe', '/k', 'call', `${dir}\\run.cmd`];
    files = [
      { name: 'run.cmd', content: cmdWrapper(cwd, dir), mode: 0o600 },
      { name: 'user.cmd', content: crlf(cmd), mode: 0o600 },
    ];
  } else if (kind === 'bash') {
    const git = find('git-bash');
    const wsl = git ? null : find('wsl');
    const prefix = git ? '' : '/mnt';
    const sdir = unixPath(dir, prefix);
    const scwd = unixPath(cwd, prefix);
    if ((!git && !wsl) || !sdir || !scwd) return null;
    inner = git ? [git, '--login', '-i', `${sdir}/run.sh`] : [wsl, '-e', 'bash', '--login', '-i', `${sdir}/run.sh`];
    files = [{ name: 'run.sh', content: bashScript(scwd, cmd, false), mode: 0o600 }];
  } else return null;
  // Windows Terminal when there is one, else a new console window through `start`.
  const wt = find('wt');
  const [file, args] = wt ? [wt, inner] : [find('cmd') || 'cmd.exe', ['/c', 'start', '', ...inner]];
  return { file, args, cwd: undefined, files, waitExit: false };
}
