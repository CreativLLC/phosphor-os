import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BootCheck, BootCheckResponse } from '../shared/protocol.ts';
import { config } from './config.ts';
import type { Tabs } from './tabs.ts';

// Real checks for the boot screen. GET /api/bootcheck -> BootCheckResponse (shared/protocol.ts). Authed requests only.
// Every check has its own short timeout and they run side by side, so the reply comes in well under 2 s even
// when a tool hangs. Cached 30 s: a reload, or the PC and the phone booting together, costs nothing.
// Only safe facts go to the page: states, a host name, free space. Never config contents.

const CACHE_MS = 30_000;
const TOOL_MS = 1500;
const MCP_MS = 1200;

let cached: BootCheckResponse | undefined;
let running: Promise<BootCheckResponse> | undefined;

export async function bootChecks(tabs: Tabs): Promise<BootCheckResponse> {
  if (cached && Date.now() - cached.checkedAt < CACHE_MS) return cached;
  running ??= runAll(tabs).finally(() => (running = undefined));
  return running;
}

async function runAll(tabs: Tabs): Promise<BootCheckResponse> {
  const t0 = Date.now();
  const all = await Promise.all([tailscale(), disk(), nextcloud(), mcp(tabs)]);
  cached = { checks: all.filter((c): c is BootCheck => c !== null), checkedAt: Date.now(), ms: Date.now() - t0 };
  return cached;
}

const check = (id: BootCheck['id'], label: string, state: BootCheck['state'], detail: string): BootCheck => ({ id, label, state, detail });

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

// Runs a program (never a shell). Resolves with its output, or the error code ('ENOENT', 'TIMEOUT', exit code).
function run(file: string, args: string[]): Promise<{ out: string; error?: string }> {
  return new Promise((done) => {
    execFile(file, args, { timeout: TOOL_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return done({ out: String(stdout) });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
      done({ out: String(stdout ?? ''), error: e.killed ? 'TIMEOUT' : String(e.code ?? 'FAIL') });
    });
  });
}

// ---------- Tailscale: is the phone's way in up, and what is this PC called on the tailnet ----------

async function tailscale(): Promise<BootCheck> {
  let r = await run('tailscale', ['status', '--json']);
  // Windows installs the CLI outside PATH for some setups (and a hidden server may have an old PATH).
  if (r.error === 'ENOENT' && process.platform === 'win32') {
    const exe = join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    if (existsSync(exe)) r = await run(exe, ['status', '--json']);
  }
  if (r.error === 'ENOENT') return check('tailscale', 'TAILSCALE', 'warn', 'NOT INSTALLED');
  if (r.error === 'TIMEOUT') return check('tailscale', 'TAILSCALE', 'warn', 'NO ANSWER');
  let s: { BackendState?: string; Self?: { DNSName?: string; HostName?: string; Online?: boolean } } = {};
  try {
    s = JSON.parse(r.out);
  } catch {
    return check('tailscale', 'TAILSCALE', 'warn', 'NOT RUNNING');
  }
  const name = (s.Self?.DNSName || s.Self?.HostName || '').split('.')[0].toUpperCase();
  if (s.BackendState === 'Running') return check('tailscale', 'TAILSCALE', s.Self?.Online === false ? 'warn' : 'ok', s.Self?.Online === false ? `${name} OFFLINE` : name || 'ONLINE');
  if (s.BackendState === 'NeedsLogin' || s.BackendState === 'NeedsMachineAuth') return check('tailscale', 'TAILSCALE', 'warn', 'LOGGED OUT');
  return check('tailscale', 'TAILSCALE', 'warn', 'OFF');
}

// ---------- Free space on the drive that holds the workspace ----------

function size(bytes: number): string {
  const gb = bytes / 1e9;
  return gb >= 1000 ? `${(gb / 1000).toFixed(1)} TB` : `${Math.floor(gb)} GB`;
}

async function disk(): Promise<BootCheck> {
  const s = await within(statfs(config.cwd), TOOL_MS, null);
  if (!s) return check('disk', 'WORKSPACE DISK', 'warn', 'NO ANSWER');
  const free = s.bavail * s.bsize;
  const share = s.blocks ? s.bavail / s.blocks : 1;
  const state = free < 2e9 ? 'fail' : free < 15e9 || share < 0.05 ? 'warn' : 'ok';
  return check('disk', 'WORKSPACE DISK', state, `${size(free)} FREE`);
}

// ---------- Nextcloud: the workspace only syncs while the desktop client runs ----------

// Sync folders from the client's own settings file. No file, or the workspace is not in one: no check.
function syncFolders(): string[] {
  const base = process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming') : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const file = join(base, 'Nextcloud', 'nextcloud.cfg');
  if (!existsSync(file)) return [];
  try {
    return [...readFileSync(file, 'utf8').matchAll(/^\d+\\Folders\\\d+\\localPath=(.+)$/gm)].map((m) => resolve(m[1].trim()));
  } catch {
    return [];
  }
}

function inside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    const s = resolve(p).replaceAll('\\', '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + '/');
}

async function clientRunning(): Promise<boolean | null> {
  if (process.platform === 'win32') {
    const r = await run('tasklist', ['/FI', 'IMAGENAME eq nextcloud.exe', '/NH', '/FO', 'CSV']);
    return r.error ? null : /"nextcloud\.exe"/i.test(r.out);
  }
  const r = await run('pgrep', ['-x', '-i', 'nextcloud']);
  if (!r.error) return true;
  return r.error === '1' ? false : null; // pgrep exits 1 when nothing matches
}

async function nextcloud(): Promise<BootCheck | null> {
  if (!syncFolders().some((f) => inside(config.cwd, f))) return null;
  const up = await clientRunning();
  if (up === null) return check('nextcloud', 'NEXTCLOUD SYNC', 'warn', 'CANNOT TELL');
  return up ? check('nextcloud', 'NEXTCLOUD SYNC', 'ok', 'CLIENT RUNNING') : check('nextcloud', 'NEXTCLOUD SYNC', 'warn', 'CLIENT NOT RUNNING');
}

// ---------- MCP servers: only from a Claude process that already runs (never starts one) ----------

async function mcp(tabs: Tabs): Promise<BootCheck | null> {
  const q = tabs.liveQuery();
  if (!q) return null;
  const list = await within(q.mcpServerStatus(), MCP_MS, null);
  if (!list) return null;
  // Same filter as the MCP screen (Tab.mcpServers): leave out this app's own mission tool.
  const servers = list.filter((s) => s.name !== 'phosphor' && s.source !== 'sdk');
  if (!servers.length) return check('mcp', 'MCP SERVERS', 'ok', 'NONE SET UP');
  const on = servers.filter((s) => s.status === 'connected').length;
  const failed = servers.filter((s) => s.status === 'failed').length;
  return check('mcp', 'MCP SERVERS', failed ? 'warn' : 'ok', `${on}/${servers.length} ON${failed ? `, ${failed} FAILED` : ''}`);
}
