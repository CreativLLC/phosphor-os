// RUN on a code block: open a new terminal window on this PC that shows the command, runs it, and stays open for
// more (as if the owner had pasted it and pressed Enter). Linux, macOS and Windows; the choices of terminal and
// script are in shared/runcmd.mjs (pure, tested for all three). Nothing the page sends is ever put into a shell
// string: it travels in an environment variable (Linux) or in a private script file.

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { availableKinds, checkRun, launchPlan } from '../shared/runcmd.mjs';

const PREFIX = 'phosphor-run-';
const DAY = 24 * 60 * 60 * 1000;

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// find(name) -> full path | null. Linux and macOS: the PATH. Windows: a few known places (Windows Terminal and
// wsl.exe are App Execution Aliases that stat() cannot see, so those folders are listed instead).
export function makeFind(platform, env = process.env) {
  if (platform !== 'win32') {
    return (name) => {
      for (const dir of [...(env.PATH ?? '').split(delimiter), '/usr/bin', '/usr/local/bin']) {
        if (!dir) continue;
        try {
          accessSync(join(dir, name), constants.X_OK);
          return join(dir, name);
        } catch {}
      }
      return null;
    };
  }
  const listed = (dir, file) => {
    try {
      return readdirSync(dir).some((f) => f.toLowerCase() === file) ? join(dir, file) : null;
    } catch {
      return null;
    }
  };
  const system = join(env.SystemRoot ?? 'C:\\Windows', 'System32');
  return (name) => {
    if (name === 'wt') {
      for (const dir of [...(env.Path ?? env.PATH ?? '').split(delimiter), join(env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps')]) {
        const f = dir && listed(dir, 'wt.exe');
        if (f) return f;
      }
      return null;
    }
    if (name === 'wsl') return listed(system, 'wsl.exe');
    if (name === 'git-bash') {
      for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
        const f = root && join(root, 'Git', 'bin', 'bash.exe');
        if (f && existsSync(f)) return f;
      }
      return null;
    }
    return null; // powershell and cmd: the bare names find themselves
  };
}

// The kinds of command this PC can run in a terminal window (see availableKinds).
export function runKinds(opts = {}) {
  const platform = opts.platform ?? process.platform;
  return availableKinds(platform, opts.find ?? makeFind(platform));
}

// Script folders left behind (a script that could not remove itself) are cleared after a day.
function sweep() {
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(PREFIX)) continue;
      const p = join(tmpdir(), name);
      if (Date.now() - statSync(p).mtimeMs > DAY) rmSync(p, { recursive: true, force: true });
    }
  } catch {}
}

// Resolves { ok: true } once the terminal has started, or { ok: false, error }.
export function runInTerminal(cmd, cwd, kind, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const find = opts.find ?? makeFind(platform);
  const fail = (error) => ({ ok: false, error });
  const req = checkRun(cmd, cwd, platform, isDir, homedir());
  if (!req) return Promise.resolve(fail('Not a command I can run.'));
  if (!availableKinds(platform, find).includes(kind)) return Promise.resolve(fail('No terminal on this PC can run that kind of command.'));
  let dir = '';
  const clean = () => dir && rmSync(dir, { recursive: true, force: true });
  let plan;
  try {
    if (platform !== 'linux') {
      sweep();
      dir = mkdtempSync(join(opts.tmp ?? tmpdir(), PREFIX)); // private to this user (mode 700)
    }
    plan = launchPlan(platform, kind, req, dir, find);
    if (!plan) {
      clean();
      return Promise.resolve(fail('No terminal on this PC can run that kind of command.'));
    }
    for (const f of plan.files) writeFileSync(join(dir, f.name), f.content, { mode: f.mode });
  } catch (err) {
    clean();
    return Promise.resolve(fail(`Could not prepare the terminal: ${err.message}`));
  }
  return new Promise((resolve) => {
    const bad = (err) => {
      clean();
      resolve(fail(`Could not start the terminal: ${err.message}`));
    };
    let child;
    try {
      child = spawn(plan.file, plan.args, {
        env: { ...process.env, ...plan.env },
        cwd: plan.cwd,
        detached: true,
        stdio: 'ignore',
      });
    } catch (err) {
      return bad(err);
    }
    child.once('error', bad);
    if (plan.waitExit) {
      child.once('close', (code) => (code === 0 ? resolve({ ok: true }) : bad(new Error(`${plan.file} exited with ${code}`))));
    } else {
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true });
      });
    }
  });
}
