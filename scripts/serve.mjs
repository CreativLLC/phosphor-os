// Runs the app server and keeps it running. This replaces `tsx watch` for the live server: tsx watch restarted
// the server on file events and on any input to its window, and every restart cut off the Claude replies in
// progress (owner saw "paused" turns, 2026-10-11).
//
// - Starts `node --import tsx server/index.ts`: a plain run, no file watcher.
// - Crash: starts it again after 2 s (up to 30 s if it keeps crashing). Logged with the exit code.
// - Restart on purpose: write a reason into data/restart-request (scripts/apply-when-idle.mjs does, after
//   copying an update in, once no tab is busy). The server is stopped and started again within a second.
// - One supervisor at a time (data/serve.lock holds its pid); a second one exits at once.
// - Log: data/server.log: the supervisor's timed lines (start, stop, crash, restart and why) and the server's
//   own output. It moves to server.log.old at 5 MB.
//
// Usage: node scripts/serve.mjs     Start it hidden and detached (shell/main.mjs and `npm start` do).
// Linux: the systemd user service phosphor-os-server (scripts/setup-linux.sh) runs it instead.

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { uptime } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const LOG = join(DATA, 'server.log');
const LOCK = join(DATA, 'serve.lock');
const REQUEST = join(DATA, 'restart-request');
const LOG_MAX = 5 * 1024 * 1024;
const STABLE_MS = 60_000; // up this long: a later crash starts over at the short wait
const TSX = pathToFileURL(createRequire(join(ROOT, 'package.json')).resolve('tsx')).href;

function log(line) {
  try {
    if (existsSync(LOG) && statSync(LOG).size > LOG_MAX) renameSync(LOG, `${LOG}.old`);
    appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* the log is only a help */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// When this PC started (ms), to the nearest minute: a lock from an earlier boot is always stale.
const BOOT = Math.round((Date.now() - uptime() * 1000) / 60_000) * 60_000;

// Both Windows and Linux hand out the same pids again after a reboot, so an old lock can name some other live
// process. That stopped the server from starting after a restart (2026-10-12: the lock named pid 9872, some
// other program had that pid at boot, and the supervisor quietly exited). So the lock holds the boot time too,
// and the pid only counts if it is a Node process (Windows) or runs this script (Linux).
function isSupervisor(pid, boot) {
  if (!alive(pid)) return false;
  if (!boot || Math.abs(boot - BOOT) > 120_000) return false; // from an earlier boot, or an old-style lock
  try {
    if (process.platform === 'win32') {
      const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      return /^"node\.exe"/i.test(row.trim());
    }
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('serve.mjs');
  } catch {
    return false;
  }
}

mkdirSync(DATA, { recursive: true });

// One supervisor only.
try {
  const raw = readFileSync(LOCK, 'utf8').trim();
  const lock = raw.startsWith('{') ? JSON.parse(raw) : { pid: Number(raw) };
  if (lock.pid && lock.pid !== process.pid && isSupervisor(lock.pid, lock.boot)) {
    log(`another supervisor is running (pid ${lock.pid}); this one exits`);
    process.exit(0);
  }
} catch {
  /* no lock yet, or unreadable: take it */
}
writeFileSync(LOCK, JSON.stringify({ pid: process.pid, boot: BOOT }));
rmSync(REQUEST, { force: true }); // an old request is done by this start

let child = null;
let startedAt = 0;
let wait = 2000;
let restarting = '';
let stopping = false;

function start() {
  startedAt = Date.now();
  log('server starting');
  // The server writes straight into the log file (not through a pipe here) and is detached (on Windows a
  // plain child is closed with its parent), so it keeps running even if this supervisor is closed.
  const out = openSync(LOG, 'a');
  child = spawn(process.execPath, ['--import', TSX, 'server/index.ts'], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  closeSync(out);
  log(`server started (pid ${child.pid})`);
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    if (restarting) {
      log(`server stopped for a restart: ${restarting}`);
      restarting = '';
      start();
      return;
    }
    const up = Date.now() - startedAt;
    if (up > STABLE_MS) wait = 2000;
    log(`server stopped on its own after ${Math.round(up / 1000)} s (exit code ${code ?? signal}); starting again in ${wait / 1000} s`);
    setTimeout(start, wait);
    wait = Math.min(wait * 2, 30_000);
  });
}

// Restart requests: a file with the reason in it.
setInterval(() => {
  if (!existsSync(REQUEST) || restarting) return;
  let why = 'requested';
  try {
    why = readFileSync(REQUEST, 'utf8').trim() || why;
  } catch {
    /* use the default */
  }
  rmSync(REQUEST, { force: true });
  if (!child) return; // between crash restarts: the next start loads the new code anyway
  restarting = why.slice(0, 300);
  child.kill();
}, 1000);

function shutdown(why) {
  stopping = true;
  log(`supervisor stopping (${why})`);
  child?.kill();
  try {
    if (readFileSync(LOCK, 'utf8').includes(`"pid":${process.pid},`)) rmSync(LOCK, { force: true });
  } catch {
    /* already gone */
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

log(`supervisor started (pid ${process.pid})`);
start();
