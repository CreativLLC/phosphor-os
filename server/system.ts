import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, statfs } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cpus, freemem, hostname, totalmem, uptime } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { appFolder } from '../shared/names.mjs';
import type { SystemDisk, SystemResponse, SystemVolume } from '../shared/protocol.ts';

// SYS panel. GET /api/system -> SystemResponse, POST /api/system/volume { pct?, muted? } (shared/protocol.ts).
// Called only for authed requests. Nothing is read while nobody looks: the first GET starts the readers and they
// stop IDLE_MS after the last GET. A GET answers from the latest sample (on a cold start it waits at most WAIT_MS
// for the drives; on Windows not at all).
// Windows: sysmon.exe (shell/sysmon.cs: PDH counters and the DXGI card list, one JSON line every 2 s, exits when
// its input closes) and volume.exe (shell/volume.cs), both built by scripts/setup-shell.ps1. typeperf was not used:
// it fixes its counter list at start, so a game started later would never show in GPU use.
// Linux: /proc, /sys (amdgpu, hwmon) and wpctl (PipeWire). Without the helpers, or on other systems: CPU from
// os.cpus(), memory and the system drive only.

const SAMPLE_MS = 2000;
const IDLE_MS = 30_000;
const DISK_MS = 30_000;
const WAIT_MS = 50;
const HELPERS = process.env.PHOSPHOR_HELPER_DIR || join(appFolder(process.env.LOCALAPPDATA || ''), 'shell');
const WIN = process.platform === 'win32';
const LINUX = process.platform === 'linux';

type Gpu = NonNullable<SystemResponse['gpu']>;
type Net = NonNullable<SystemResponse['net']>;
type Mount = { name: string; label: string; path: string };

type Live = {
  cpu: number | null;
  cores: number[];
  cpuTemp: number | null;
  mem: { used: number; total: number } | null; // null: ask os at answer time
  gpu: Gpu | null;
  net: Net | null;
  volume: SystemVolume | null;
  disks: SystemDisk[];
  sampledAt: number;
};

const blank = (): Live => ({ cpu: null, cores: [], cpuTemp: null, mem: null, gpu: null, net: null, volume: null, disks: [], sampledAt: 0 });

let live = blank();
let note = '';
let running = false;
let lastAsk = 0;
let timers: ReturnType<typeof setInterval>[] = [];
let mounts: Mount[] = [];
let firstRead: Promise<void> | undefined;
let exitHook = false;

// ---------------------------------------------------------------- routes

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (c) => {
      text += c;
      if (text.length > 1024) req.destroy();
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

export async function handleSystem(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/api/system/volume') {
    // JSON only: a form on another local page cannot send it without the browser asking this server first.
    if (req.method !== 'POST' || !String(req.headers['content-type'] ?? '').includes('application/json')) return json(res, { error: 'POST JSON only.' }, 405);
    let b: { pct?: unknown; muted?: unknown } = {};
    try {
      b = JSON.parse(await body(req));
    } catch {
      /* empty or bad JSON */
    }
    const pct = b.pct;
    const muted = b.muted;
    const okPct = pct === undefined || (Number.isInteger(pct) && (pct as number) >= 0 && (pct as number) <= 100);
    const okMute = muted === undefined || typeof muted === 'boolean';
    if (!okPct || !okMute || (pct === undefined && muted === undefined)) return json(res, { error: 'Send pct (whole number 0 to 100) and/or muted (true or false).' }, 400);
    try {
      return json(res, await setVolume(pct as number | undefined, muted as boolean | undefined));
    } catch (e) {
      return json(res, { error: e instanceof Error ? e.message : String(e) }, 503);
    }
  }
  if (url.pathname !== '/api/system' || req.method !== 'GET') return json(res, { error: 'not found' }, 404);
  watch();
  if (firstRead) await Promise.race([firstRead, new Promise((r) => setTimeout(r, WAIT_MS))]);
  await scanModels();
  return json(res, snapshot());
}

// Local AI models in video memory: llama.cpp processes and the model file each was started with (--model / -m).
// Read from /proc, so no API key is needed; looked at every 15 s at most.
const LLAMA = /^llama-(server|cli|run|mtmd-cli)$/;
const models = { names: [] as string[], at: 0 };

async function scanModels(): Promise<void> {
  if (process.platform !== 'linux' || Date.now() - models.at < 15_000) return;
  models.at = Date.now();
  const names: string[] = [];
  for (const pid of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(pid)) continue;
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
    if (!LLAMA.test(basename(argv[0] ?? ''))) continue;
    const i = argv.findIndex((a) => a === '--model' || a === '-m');
    const file = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--model='))?.slice(8);
    if (file) names.push(basename(file).replace(/\.gguf$/i, ''));
  }
  models.names = [...new Set(names)];
}

function snapshot(): SystemResponse {
  const info = cpuInfo();
  const total = totalmem();
  return {
    os: process.platform,
    host: hostname(),
    uptime: Math.round(uptime()),
    sampledAt: live.sampledAt,
    cpu: { name: info.name, threads: info.threads, pct: live.cpu, cores: live.cores, tempC: live.cpuTemp },
    mem: live.mem ?? { used: total - freemem(), total },
    gpu: live.gpu,
    ...(models.names.length ? { gpuModels: models.names } : {}),
    disks: live.disks,
    net: live.net,
    volume: live.volume,
    ...(note ? { note } : {}),
  };
}

let cpuCache: { name: string; threads: number } | undefined;
function cpuInfo(): { name: string; threads: number } {
  if (!cpuCache) {
    const list = cpus();
    cpuCache = { name: (list[0]?.model ?? '').replace(/\s+/g, ' ').trim(), threads: list.length };
  }
  return cpuCache;
}

// ---------------------------------------------------------------- start and stop with the viewers

function watch(): void {
  lastAsk = Date.now();
  if (running) return;
  running = true;
  note = '';
  if (!exitHook) {
    exitHook = true;
    process.once('exit', stop);
  }
  timers.push(setInterval(() => Date.now() - lastAsk > IDLE_MS && stop(), 5000).unref());
  if (WIN && existsSync(join(HELPERS, 'sysmon.exe'))) {
    // Starting a program blocks Node for a moment (0.5 s on its first run, while antivirus checks it), so start it
    // after this answer has gone out. Its first line takes longer than WAIT_MS anyway: no waiting here.
    setImmediate(() => running && !helper && startHelper());
  } else {
    if (WIN) note = 'GPU, network, other drives and volume need the helpers: run scripts\\setup-shell.ps1 once.';
    const tick = LINUX ? linuxTick : fallbackTick;
    void tick();
    timers.push(setInterval(() => void tick(), SAMPLE_MS).unref());
    mounts = LINUX ? [] : [{ name: (process.env.SystemDrive || 'C:').toUpperCase(), label: '', path: WIN ? `${process.env.SystemDrive || 'C:'}\\` : '/' }];
    firstRead = LINUX ? linuxMounts().then(refreshDisks) : refreshDisks();
  }
  timers.push(setInterval(() => void refreshDisks(), DISK_MS).unref());
}

function stop(): void {
  running = false;
  for (const t of timers) clearInterval(t);
  timers = [];
  clearTimeout(retry);
  const h = helper;
  helper = undefined;
  if (h) {
    h.stdin?.end();
    h.kill();
  }
  live = blank();
  firstRead = undefined;
  prevStat = undefined;
  prevNet = undefined;
  netSeen.clear();
}

async function refreshDisks(): Promise<void> {
  const out: SystemDisk[] = [];
  for (const m of mounts) {
    try {
      const s = await statfs(m.path);
      out.push({ name: m.name, label: m.label, total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize });
    } catch {
      /* gone or not readable: leave it out */
    }
  }
  if (running) live.disks = out;
}

// ---------------------------------------------------------------- shared helpers

const clampPct = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n * 10) / 10)) : null);

export type CpuTimes = { busy: number; all: number };

export function cpuPct(a: CpuTimes | undefined, b: CpuTimes | undefined): number | null {
  if (!a || !b || b.all - a.all <= 0) return null;
  return clampPct(((b.busy - a.busy) / (b.all - a.all)) * 100);
}

// The adapter that moved the most bytes is the one people mean by "the network" (not VPNs or virtual switches).
const netSeen = new Map<string, number>();
function pickNet(rates: Net[], weight: (n: Net) => number): Net | null {
  let best: Net | null = null;
  for (const r of rates) {
    netSeen.set(r.name, (netSeen.get(r.name) ?? 0) + weight(r));
    if (!best || netSeen.get(r.name)! > netSeen.get(best.name)!) best = r;
  }
  return best ? { name: best.name, rx: Math.max(0, Math.round(best.rx)), tx: Math.max(0, Math.round(best.tx)) } : null;
}

// ---------------------------------------------------------------- Windows: sysmon.exe

type HelperInfo = { t: 'info'; adapters?: { luid: string; name: string; vram: number; software: boolean }[]; drives?: { root: string; label: string }[] };
type HelperSample = { t: 'sample'; cpu?: number; cores?: number[]; gpu3d?: Record<string, number>; vram?: Record<string, number>; net?: [string, number, number][]; vol?: [number, number] };

let helper: ChildProcess | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let backoff = 1000;
let card: { luid: string; name: string; vram: number } | null = null;

function startHelper(): void {
  const child = spawn(join(HELPERS, 'sysmon.exe'), ['watch', String(SAMPLE_MS)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  helper = child;
  child.stdin?.on('error', () => {});
  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (helper === child) onHelperLine(line);
  });
  // It died (or never started): try again later, waiting longer each time, as long as someone is watching.
  const ended = () => {
    if (helper !== child) return;
    helper = undefined;
    if (!running) return;
    retry = setTimeout(() => running && !helper && startHelper(), backoff);
    backoff = Math.min(backoff * 2, 60_000);
  };
  child.on('error', ended);
  child.on('close', ended);
}

function onHelperLine(line: string): void {
  let m: HelperInfo | HelperSample;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.t === 'info') {
    // The card with the most video memory: the discrete one when there is also a CPU graphics chip.
    card = (m.adapters ?? []).filter((a) => !a.software).sort((a, b) => b.vram - a.vram)[0] ?? null;
    mounts = (m.drives ?? []).map((d) => ({ name: d.root.replace(/\\$/, ''), label: d.label, path: d.root }));
    void refreshDisks();
    return;
  }
  if (m.t !== 'sample') return;
  backoff = 1000;
  live.cpu = clampPct(m.cpu);
  live.cores = (m.cores ?? []).map((c) => clampPct(c) ?? 0);
  if (card) {
    const luid = card.luid.toLowerCase();
    const used = m.vram?.[luid];
    live.gpu = { name: card.name, pct: clampPct(m.gpu3d?.[luid] ?? null), vramUsed: typeof used === 'number' ? used : null, vramTotal: card.vram || null, tempC: null, hotspotC: null };
  }
  live.net = pickNet((m.net ?? []).map(([name, rx, tx]) => ({ name, rx, tx })), (n) => ((n.rx + n.tx) * SAMPLE_MS) / 1000);
  live.volume = m.vol ? { pct: m.vol[0], muted: m.vol[1] === 1 } : null;
  live.sampledAt = Date.now();
}

// ---------------------------------------------------------------- elsewhere: os.cpus()

let prevStat: { total: CpuTimes; cores: CpuTimes[] } | undefined;

function osTimes(): { total: CpuTimes; cores: CpuTimes[] } {
  const cores = cpus().map(({ times: t }) => {
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    return { busy: all - t.idle, all };
  });
  const total = cores.reduce((s, c) => ({ busy: s.busy + c.busy, all: s.all + c.all }), { busy: 0, all: 0 });
  return { total, cores };
}

async function fallbackTick(): Promise<void> {
  const now = osTimes();
  if (prevStat) {
    live.cpu = cpuPct(prevStat.total, now.total);
    live.cores = now.cores.map((c, i) => cpuPct(prevStat!.cores[i], c) ?? 0);
    live.sampledAt = Date.now();
  }
  prevStat = now;
}

// ---------------------------------------------------------------- Linux: /proc, /sys, wpctl
// Parsers are exported for the fixture tests (sys-tests); LinuxReader takes a root folder for the same reason.

export function parseProcStat(text: string): { total: CpuTimes; cores: CpuTimes[] } | undefined {
  let total: CpuTimes | undefined;
  const cores: CpuTimes[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^cpu(\d*)\s+(.*)$/);
    if (!m) continue;
    // user nice system idle iowait irq softirq steal (guest time is already inside user and nice)
    const f = m[2].trim().split(/\s+/).slice(0, 8).map(Number);
    const all = f.reduce((s, n) => s + (n || 0), 0);
    const t = { busy: all - (f[3] || 0) - (f[4] || 0), all };
    if (m[1] === '') total = t;
    else cores[Number(m[1])] = t;
  }
  return total ? { total, cores: cores.filter(Boolean) } : undefined;
}

export function parseMeminfo(text: string): { used: number; total: number } | null {
  const kb = (key: string) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? NaN) * 1024;
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  return Number.isFinite(total) && Number.isFinite(avail) ? { used: total - avail, total } : null;
}

// Byte counters since boot per interface.
export function parseNetDev(text: string): Net[] {
  const out: Net[] = [];
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0 || line.includes('|')) continue;
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    if (f.length >= 9) out.push({ name: line.slice(0, i).trim(), rx: f[0], tx: f[8] });
  }
  return out;
}

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'bcachefs', 'jfs', 'reiserfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk']);

// Disks people care about: real file systems on a device, one line per device (btrfs subvolumes share one),
// without the small boot partitions.
export function parseMounts(text: string): { dev: string; mount: string }[] {
  const byDev = new Map<string, string>();
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  for (const line of text.split('\n')) {
    const [dev, rawMount, type] = line.split(' ');
    if (!dev || !rawMount || !REAL_FS.has(type) || !dev.startsWith('/dev/')) continue;
    const mount = unescape(rawMount);
    if (mount === '/boot' || mount.startsWith('/boot/') || mount === '/efi' || mount.startsWith('/efi/')) continue;
    const had = byDev.get(dev);
    if (had === undefined || mount.length < had.length) byDev.set(dev, mount);
  }
  return [...byDev].map(([dev, mount]) => ({ dev, mount }));
}

// "Volume: 0.40" or "Volume: 0.40 [MUTED]".
export function parseWpctl(text: string): SystemVolume | null {
  const m = text.match(/Volume:\s*([\d.]+)/);
  return m ? { pct: Math.round(Number(m[1]) * 100), muted: /\[MUTED\]/.test(text) } : null;
}

const VENDORS: Record<string, string> = { '1002': 'AMD', '10de': 'NVIDIA', '8086': 'Intel' };

// Graphics card name from the PCI id list (pci.ids): the board's own entry when listed, else the chip's
// marketing name in brackets ("Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]" -> "AMD Radeon RX 6800/6800 XT / 6900 XT").
export function pciName(ids: string, vendor: string, device: string, subVendor = '', subDevice = ''): string | null {
  const v = vendor.replace(/^0x/, '').toLowerCase();
  const d = device.replace(/^0x/, '').toLowerCase();
  const sv = subVendor.replace(/^0x/, '').toLowerCase();
  const sd = subDevice.replace(/^0x/, '').toLowerCase();
  const start = ids.search(new RegExp(`^${v}\\s`, 'm'));
  if (start < 0) return null;
  let chip = '';
  let board = '';
  let inChip = false;
  for (const line of ids.slice(start).split('\n').slice(1)) {
    if (!line.startsWith('\t')) {
      if (line && !line.startsWith('#')) break; // next vendor
      continue;
    }
    if (!line.startsWith('\t\t')) {
      if (inChip) break;
      inChip = line.slice(1, 5).toLowerCase() === d;
      if (inChip) chip = line.slice(5).trim();
    } else if (inChip && sv && line.slice(2, 11).toLowerCase() === `${sv} ${sd}`) board = line.slice(11).trim();
  }
  let name = board || chip.match(/\[(.+)\]/)?.[1] || chip;
  if (!name) return null;
  const brand = VENDORS[v];
  if (brand && !name.toLowerCase().includes(brand.toLowerCase())) name = `${brand} ${name}`;
  return name;
}

const num = (s: string | null) => (s === null || s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

export class LinuxReader {
  found = false;
  gpuDir = '';
  gpuName = '';
  cpuTemp = '';
  gpuTemp = '';
  gpuHot = '';

  constructor(private root = '/') {}

  private p(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  private async text(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8');
    } catch {
      return null;
    }
  }

  private async list(dir: string): Promise<string[]> {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }

  // temp*_label -> temp*_input file, for one hwmon folder.
  private async temps(dir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const f of await this.list(dir)) {
      const m = f.match(/^(temp\d+)_label$/);
      const label = m && (await this.text(join(dir, f)));
      if (m && label) out.set(label.trim(), join(dir, `${m[1]}_input`));
    }
    return out;
  }

  // Once per start: which graphics card and which temperature files to read.
  async discover(): Promise<void> {
    this.found = true;
    let best = -1;
    for (const c of await this.list(this.p('sys/class/drm'))) {
      if (!/^card\d+$/.test(c)) continue;
      const dev = this.p('sys/class/drm', c, 'device');
      const vendor = (await this.text(join(dev, 'vendor')))?.trim();
      if (!vendor) continue;
      const vram = num(await this.text(join(dev, 'mem_info_vram_total'))) ?? 0;
      if (vram <= best) continue;
      best = vram;
      this.gpuDir = dev;
      const product = (await this.text(join(dev, 'product_name')))?.trim();
      const ids = (await this.text(this.p('usr/share/hwdata/pci.ids'))) ?? (await this.text(this.p('usr/share/misc/pci.ids'))) ?? '';
      const read = async (f: string) => (await this.text(join(dev, f)))?.trim() ?? '';
      this.gpuName = product || pciName(ids, vendor, await read('device'), await read('subsystem_vendor'), await read('subsystem_device')) || `${VENDORS[vendor.replace(/^0x/, '')] ?? 'Unknown'} graphics`;
      this.gpuTemp = '';
      this.gpuHot = '';
      for (const h of await this.list(join(dev, 'hwmon'))) {
        const t = await this.temps(join(dev, 'hwmon', h));
        this.gpuTemp = t.get('edge') ?? this.gpuTemp;
        this.gpuHot = t.get('junction') ?? this.gpuHot;
      }
    }
    // CPU package temperature: k10temp / zenpower (AMD) or coretemp (Intel).
    const wanted: Record<string, string[]> = { k10temp: ['Tctl', 'Tdie'], zenpower: ['Tdie', 'Tctl'], coretemp: ['Package id 0'] };
    for (const h of await this.list(this.p('sys/class/hwmon'))) {
      const dir = this.p('sys/class/hwmon', h);
      const name = (await this.text(join(dir, 'name')))?.trim() ?? '';
      if (!wanted[name]) continue;
      const t = await this.temps(dir);
      const file = wanted[name].map((l) => t.get(l)).find(Boolean) ?? join(dir, 'temp1_input');
      if (await this.text(file)) {
        this.cpuTemp = file;
        break;
      }
    }
  }

  async read(): Promise<{ stat: ReturnType<typeof parseProcStat>; mem: { used: number; total: number } | null; net: Net[]; gpuPct: number | null; vramUsed: number | null; vramTotal: number | null; cpuTemp: number | null; gpuTemp: number | null; gpuHot: number | null }> {
    const milli = async (f: string) => {
      const n = f ? num(await this.text(f)) : null;
      return n === null ? null : Math.round(n / 1000);
    };
    const g = (f: string) => (this.gpuDir ? this.text(join(this.gpuDir, f)) : Promise.resolve(null));
    const net: Net[] = [];
    for (const n of parseNetDev((await this.text(this.p('proc/net/dev'))) ?? '')) {
      // Virtual adapters (VPNs, containers, bridges) live under /sys/devices/virtual/net.
      if (n.name !== 'lo' && !existsSync(this.p('sys/devices/virtual/net', n.name))) net.push(n);
    }
    return {
      stat: parseProcStat((await this.text(this.p('proc/stat'))) ?? ''),
      mem: parseMeminfo((await this.text(this.p('proc/meminfo'))) ?? ''),
      net,
      gpuPct: num(await g('gpu_busy_percent')),
      vramUsed: num(await g('mem_info_vram_used')),
      vramTotal: num(await g('mem_info_vram_total')),
      cpuTemp: await milli(this.cpuTemp),
      gpuTemp: await milli(this.gpuTemp),
      gpuHot: await milli(this.gpuHot),
    };
  }

  async mounts(): Promise<Mount[]> {
    return parseMounts((await this.text(this.p('proc/mounts'))) ?? '').map(({ dev, mount }) => ({ name: mount, label: basename(dev), path: mount }));
  }
}

let linux: LinuxReader | undefined;
let prevNet: { at: number; net: Net[] } | undefined;
let linuxBusy = false;
let noWpctl = false;

async function linuxMounts(): Promise<void> {
  mounts = await (linux ??= new LinuxReader()).mounts();
}

async function linuxTick(): Promise<void> {
  if (linuxBusy) return;
  linuxBusy = true;
  try {
    const r = (linux ??= new LinuxReader());
    if (!r.found) await r.discover();
    const x = await r.read();
    if (!running) return;
    const at = Date.now();
    if (x.stat && prevStat) {
      live.cpu = cpuPct(prevStat.total, x.stat.total);
      live.cores = x.stat.cores.map((c, i) => cpuPct(prevStat!.cores[i], c) ?? 0);
    }
    if (x.stat) prevStat = x.stat;
    live.cpuTemp = x.cpuTemp;
    live.mem = x.mem;
    if (r.gpuDir) live.gpu = { name: r.gpuName, pct: clampPct(x.gpuPct), vramUsed: x.vramUsed, vramTotal: x.vramTotal, tempC: x.gpuTemp, hotspotC: x.gpuHot };
    if (prevNet) {
      const dt = (at - prevNet.at) / 1000;
      const rates = x.net.map((n) => {
        const was = prevNet!.net.find((p) => p.name === n.name);
        return { name: n.name, rx: was && dt > 0 ? (n.rx - was.rx) / dt : 0, tx: was && dt > 0 ? (n.tx - was.tx) / dt : 0 };
      });
      // Busiest since boot: the counters already add up everything.
      netSeen.clear();
      live.net = pickNet(rates, (n) => {
        const c = x.net.find((p) => p.name === n.name);
        return c ? c.rx + c.tx : 0;
      });
    }
    prevNet = { at, net: x.net };
    live.volume = noWpctl ? null : await wpctl(['get-volume', '@DEFAULT_AUDIO_SINK@']).then(parseWpctl, () => null);
    live.sampledAt = at;
  } finally {
    linuxBusy = false;
  }
}

function wpctl(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wpctl', args, { timeout: 3000 }, (err, out) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') noWpctl = true;
      if (err) reject(new Error('wpctl failed: is PipeWire running?'));
      else resolve(String(out));
    });
  });
}

// ---------------------------------------------------------------- volume

let volQueue: Promise<unknown> = Promise.resolve();

// One change at a time, in the order they came.
function setVolume(pct?: number, muted?: boolean): Promise<SystemVolume> {
  const run = volQueue.then(() => applyVolume(pct, muted));
  volQueue = run.catch(() => {});
  return run;
}

async function applyVolume(pct?: number, muted?: boolean): Promise<SystemVolume> {
  let v: SystemVolume | null = null;
  if (WIN) {
    const exe = join(HELPERS, 'volume.exe');
    if (!existsSync(exe)) throw new Error('Volume needs the helper: run scripts\\setup-shell.ps1 once.');
    const call = (args: string[]) =>
      new Promise<string>((resolve, reject) =>
        execFile(exe, args, { timeout: 5000, windowsHide: true }, (err, out) => (err ? reject(new Error('Windows did not change the volume (no playback device?).')) : resolve(String(out)))),
      );
    let out = '';
    if (pct !== undefined) out = await call(['set', String(pct)]);
    if (muted !== undefined) out = await call(['mute', muted ? '1' : '0']);
    const [p, m] = out.trim().split(/\s+/).map(Number);
    if (Number.isFinite(p)) v = { pct: p, muted: m === 1 };
  } else if (LINUX) {
    if (pct !== undefined) await wpctl(['set-volume', '@DEFAULT_AUDIO_SINK@', (pct / 100).toFixed(2)]);
    if (muted !== undefined) await wpctl(['set-mute', '@DEFAULT_AUDIO_SINK@', muted ? '1' : '0']);
    v = parseWpctl(await wpctl(['get-volume', '@DEFAULT_AUDIO_SINK@']));
  } else throw new Error('No volume control on this system.');
  if (!v) throw new Error('Could not read the volume back.');
  if (running) live.volume = v;
  return v;
}
