// Apply staged server edits only when no tab is busy, then restart the server (scripts/serve.mjs reads
// data/restart-request), so the restart never cuts off a reply in progress.
//
// Usage: node scripts/apply-when-idle.mjs <stagedDir>
//   <stagedDir> mirrors the project: <stagedDir>/server/tab.ts -> server/tab.ts, etc.
// Start it detached (it must outlive the Claude turn that started it), e.g. from PowerShell:
//   Start-Process node -ArgumentList 'scripts/apply-when-idle.mjs','<stagedDir>' -WindowStyle Hidden
// or on Linux: setsid -f node scripts/apply-when-idle.mjs <stagedDir> >/dev/null 2>&1
// Log: data/apply-when-idle.log

import { appendFileSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFileValue } from '../shared/names.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staged = resolve(process.argv[2] ?? '');
const LOG = join(ROOT, 'data', 'apply-when-idle.log');
const IDLE_MS = 5000; // all tabs idle this long before applying
const GIVE_UP_MS = 60 * 60 * 1000;
const log = (msg) => appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);

if (!existsSync(staged) || !statSync(staged).isDirectory()) {
  log(`no staged folder: ${staged}`);
  process.exit(1);
}

const WebSocket = createRequire(join(ROOT, 'package.json'))('ws');
const env = readFileSync(join(ROOT, '.env'), 'utf8');
const password = envFileValue(env, 'PASSWORD');
const port = envFileValue(env, 'PORT').match(/^\d+$/)?.[0] ?? '7337';
const base = `http://127.0.0.1:${port}`;

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));
}

function apply() {
  const list = files(staged).map((f) => relative(staged, f));
  // Copy everything first in one quick pass, then one restart.
  for (const rel of list) cpSync(join(staged, rel), join(ROOT, rel));
  rmSync(staged, { recursive: true, force: true });
  writeFileSync(join(ROOT, 'data', 'restart-request'), `update applied: ${list.join(', ')}`);
  log(`applied ${list.length} file(s): ${list.join(', ')}`);
  process.exit(0);
}

const login = await fetch(`${base}/login`, {
  method: 'POST',
  body: `password=${encodeURIComponent(password)}`,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  redirect: 'manual',
});
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) {
  log('login failed; not applying');
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'http://localhost', cookie } });
const tabs = new Map(); // tab id -> busy or waiting for the user
let idleSince = null;
const started = Date.now();

const check = () => {
  const anyBusy = [...tabs.values()].some(Boolean);
  if (anyBusy) idleSince = null;
  else idleSince ??= Date.now();
  if (idleSince && Date.now() - idleSince >= IDLE_MS) apply();
  if (Date.now() - started > GIVE_UP_MS) {
    log('gave up after an hour of busy tabs; not applied');
    process.exit(1);
  }
};

ws.on('message', (raw) => {
  const ev = JSON.parse(String(raw));
  if (ev.t === 'hello') for (const t of ev.tabs) tabs.set(t.meta.id, t.meta.busy || t.meta.attention);
  if (ev.t === 'tab') tabs.set(ev.tab.meta.id, ev.tab.meta.busy || ev.tab.meta.attention);
  if (ev.t === 'tab_closed') tabs.delete(ev.tab);
  if (ev.t === 'patch' && ev.key === 'meta') tabs.set(ev.tab, ev.value.busy || ev.value.attention);
});
ws.on('error', (e) => {
  log(`socket error: ${e.message}`);
  process.exit(1);
});
log(`waiting for idle to apply ${staged}`);
setInterval(check, 1000);
