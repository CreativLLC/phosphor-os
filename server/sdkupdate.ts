import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { SdkUpdate, ServerEvent } from '../shared/protocol.ts';
import { classify, cmpVer, dayKey, nightDue, parseVer } from '../shared/sdkversion.ts';
import { DATA_DIR, ROOT } from './config.ts';
import type { Tabs } from './tabs.ts';

// Update check and one-click update for @anthropic-ai/claude-agent-sdk (new Claude Code features and models only
// arrive with it). Hourly look at the npm registry, one bell notice per version, an UPDATE chip in the page
// (web/src/sdkupdate.ts), the update itself in scripts/update-sdk.sh, and a try at 04:00 when nothing is busy.

const PKG = '@anthropic-ai/claude-agent-sdk';
const LATEST_URL = `https://registry.npmjs.org/${PKG}/latest`;
const STATE_FILE = join(DATA_DIR, 'sdk-update.json');
const LOG = join(DATA_DIR, 'update.log');
const HOUR = 3_600_000;

// Remembered between restarts: the version last seen installed (for the "updated" notice), the versions already
// announced, the version whose update failed (not retried at night), the last night a nightly try was made.
type Memory = { seen: string; notified: string; notifiedBigger: string; failed: string; nightTried: string };

let tabs: Tabs;
let emit: (ev: ServerEvent) => void;
let mem: Memory = { seen: '', notified: '', notifiedBigger: '', failed: '', nightTried: '' };
let running = false;
let found: { pending: string | null; claude: string | null; bigger: string | null } = { pending: null, claude: null, bigger: null };
let last = '';

const log = (msg: string) => appendFileSync(LOG, `${new Date().toISOString()} server: ${msg}\n`);

function saveMemory(): void {
  writeFileSync(STATE_FILE, JSON.stringify(mem));
}

function readPkg(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// What is installed right now (read from disk: after an update it is the new version even before the restart).
function installed(): { version: string; claude: string | null } {
  const p = readPkg(join(ROOT, 'node_modules', PKG, 'package.json'));
  return { version: String(p.version ?? ''), claude: typeof p.claudeCodeVersion === 'string' ? p.claudeCodeVersion : null };
}

const wantedRange = () => String((readPkg(join(ROOT, 'package.json')).dependencies as Record<string, string> | undefined)?.[PKG] ?? '');

export function updateState(): SdkUpdate {
  return { installed: installed().version, pending: found.pending, claude: found.claude, bigger: found.bigger, running, failed: !!found.pending && mem.failed === found.pending };
}

function publish(): void {
  const s = updateState();
  const key = JSON.stringify(s);
  if (key === last) return;
  last = key;
  emit({ t: 'sdk_update', state: s });
}

// Desktop notification (the bell). With `update`, it carries an "Update now" button: clicking prints "update".
function notify(title: string, body: string, update = false): void {
  const uid = process.getuid?.();
  const env = { ...process.env };
  if (!env.DBUS_SESSION_BUS_ADDRESS && uid !== undefined && existsSync(`/run/user/${uid}/bus`)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
  const args = ['--app-name', 'Phosphor-OS', ...(update ? ['--action=update=Update now', '--wait'] : []), title, body];
  try {
    const p = spawn('notify-send', args, { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 24 * HOUR });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => {}); // no notify-send: the chip still works
    p.on('close', () => {
      if (update && out.trim() === 'update') void start(false, 'bell').then((r) => r.error && notify('Update waits', r.error));
    });
    p.unref();
  } catch {
    /* silent */
  }
}

function busyWhy(): string {
  const n = tabs.list().filter((t) => t.meta.busy || t.meta.attention || t.agents.some((a) => a.status === 'running')).length;
  return n ? `${n} chat${n > 1 ? 's are' : ' is'} busy or waiting for you. The restart would cut ${n > 1 ? 'them' : 'it'} off.` : '';
}

// Look at the registry (no npm process). Failures are silent: the next hour tries again.
export async function checkNow(): Promise<void> {
  try {
    const r = await fetch(LATEST_URL, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
    if (!r.ok) return;
    const latest = (await r.json()) as { version?: string; claudeCodeVersion?: string };
    const now = installed();
    const { pending, bigger } = classify(wantedRange(), now.version, String(latest.version));
    found = { pending, bigger, claude: pending && typeof latest.claudeCodeVersion === 'string' ? latest.claudeCodeVersion : null };
    if (pending && mem.notified !== pending) {
      mem.notified = pending;
      saveMemory();
      notify(`Claude Code ${found.claude ?? pending} is ready`, 'Click to update. The app restarts after (chats come back).', true);
    } else if (bigger && mem.notifiedBigger !== bigger) {
      mem.notifiedBigger = bigger;
      saveMemory();
      notify(`Claude Code ${bigger} is out`, 'A bigger update needs a code check first. It is not installed by the button.');
    }
    publish();
  } catch {
    /* offline or registry down */
  }
}

// Run scripts/update-sdk.sh. Refuses while a chat is busy or waiting, unless `force`.
export async function start(force: boolean, why: string): Promise<{ ok?: true; error?: string; busy?: boolean }> {
  if (running) return { error: 'An update is already running.' };
  const version = found.pending;
  if (!version) return { error: 'No update is waiting.' };
  const busy = busyWhy();
  if (busy && !force) return { error: busy, busy: true };
  running = true;
  log(`start ${version} (${why}${force ? ', forced' : ''})`);
  publish();
  const p = spawn('bash', [join(ROOT, 'scripts', 'update-sdk.sh'), version], { cwd: ROOT, stdio: 'ignore', detached: true });
  const done = (code: number | null) => {
    running = false;
    if (code === 0) mem.failed = '';
    else mem.failed = version;
    saveMemory();
    log(`script ended with code ${code}`);
    void checkNow().then(publish); // success: nothing pending any more, though the restart is a few seconds away
    publish();
  };
  p.on('error', () => done(-1));
  p.on('exit', done);
  p.unref();
  return { ok: true };
}

function afterRestart(): void {
  try {
    mem = { ...mem, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    /* first run */
  }
  const now = installed();
  const was = parseVer(mem.seen);
  const is = parseVer(now.version);
  if (was && is && cmpVer(is, was) > 0) notify(`Claude Code updated to ${now.claude ?? now.version}`, 'The app restarted. Your chats are back.');
  if (mem.seen !== now.version) {
    mem.seen = now.version;
    saveMemory();
  }
}

export function startUpdates(t: Tabs, send: (ev: ServerEvent) => void): void {
  tabs = t;
  emit = send;
  afterRestart();
  setTimeout(() => void checkNow(), 30_000).unref();
  setInterval(() => void checkNow(), HOUR).unref();
  // 04:00 local: update if one is waiting and nothing is busy; otherwise try again the next night.
  setInterval(() => {
    const now = new Date();
    if (!found.pending || running || mem.failed === found.pending || !nightDue(now, mem.nightTried)) return;
    mem.nightTried = dayKey(now);
    saveMemory();
    void start(false, 'night').then((r) => r.error && log(`night: skipped (${r.error})`));
  }, 60_000).unref();
}

// GET /api/update: the state. POST /api/update[?force=1]: start. JSON content type only (a form on another page cannot send it).
export async function handleUpdate(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const send = (data: unknown, status = 200) => void res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
  if (req.method !== 'POST') return send(updateState());
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) return send({ error: 'POST JSON only.' }, 415);
  const r = await start(url.searchParams.get('force') === '1', 'button');
  send(r, r.ok ? 200 : r.busy ? 409 : 400);
}
