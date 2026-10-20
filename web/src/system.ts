import type { LocalSpeed, LocalSpeedRun, SystemResponse, SystemVolume } from '../../shared/protocol.ts';
import { el } from './ui.ts';
import { segBar } from './usage.ts';

// SYS panel (right column, next to MISSION and FILES): clock, uptime, CPU / RAM / GPU / VRAM gauges with a
// sparkline each, network rates, drives and the PC's volume. Data: GET /api/system (server/system.ts), every
// 2 s, and only while something that shows it is on screen and the page is visible. The server reads the PC
// only while it is asked. Canvases are drawn only after a fresh reading, so nothing draws while hidden.
// sysSummary(): a one-line "CPU 12% RAM 41% GPU 3%" for the top bar or launcher (not placed anywhere yet).

const POLL_MS = 2000;
const SOON_MS = 700; // the server's readers were just started: ask again soon
const HISTORY = 60;
const SEGS = 20;
const HOT = 90;
const VOL_SEGS = 20;
const VOL_SEND_MS = 150;
const VOL_HOLD_MS = 2500; // after a local change, readings older than the change don't move the slider back

type Series = 'cpu' | 'mem' | 'gpu' | 'vram' | 'down' | 'up';

let data: SystemResponse | null = null;
let dataAt = 0; // when `data` arrived (uptime counts on from there)
let error = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let started = false;
let lastSample = 0;
const hist: Record<Series, number[]> = { cpu: [], mem: [], gpu: [], vram: [], down: [], up: [] };
const needs = new Set<() => boolean>(); // each viewer says whether it is on screen
const renders = new Set<() => void>();

// ---------------------------------------------------------------- numbers to text

const pctOf = (used: number | null | undefined, total: number | null | undefined) => (used != null && total ? Math.min(100, (used / total) * 100) : null);
const pctText = (p: number | null) => (p === null ? '--%' : `${Math.round(p)}%`);
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

// Binary units with the usual names, as Windows and Linux file managers show them.
function unitOf(n: number): number {
  let u = 0;
  while (n >= 1024 && u < UNITS.length - 1) {
    n /= 1024;
    u++;
  }
  return u;
}
const inUnit = (n: number, u: number) => {
  const v = n / 1024 ** u;
  return v >= 100 || u === 0 ? Math.round(v).toString() : v.toFixed(1);
};
const bytes = (n: number) => `${inUnit(n, unitOf(n))} ${UNITS[unitOf(n)]}`;
const pair = (used: number, total: number) => `${inUnit(used, unitOf(total))} / ${inUnit(total, unitOf(total))} ${UNITS[unitOf(total)]}`;
const rate = (n: number) => `${bytes(n)}/s`;
const temp = (c: number | null | undefined) => (c == null ? '--°' : `${Math.round(c)}°`);

// "11th Gen Intel(R) Core(TM) i5-11400" -> "Intel Core i5-11400"
const shortCpu = (s: string) =>
  s
    .replace(/\((R|TM)\)/gi, '')
    .replace(/\b(\d+(st|nd|rd|th) Gen|CPU|Processor)\b/gi, '')
    .replace(/@.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

// 273600 -> "3D 04:00:00"
function upText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  return d ? `${d}D ${hms}` : hms;
}

export function sysSummaryText(): string {
  const d = data;
  const mem = d ? pctOf(d.mem.used, d.mem.total) : null;
  const parts = [`CPU ${pctText(d?.cpu.pct ?? null)}`, `RAM ${pctText(mem)}`];
  if (!d || d.gpu) parts.push(`GPU ${pctText(d?.gpu?.pct ?? null)}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------- polling

function init(): void {
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', sync);
}

const wanted = () => document.visibilityState === 'visible' && [...needs].some((f) => f());

function sync(): void {
  if (!wanted()) {
    clearTimeout(timer);
    timer = undefined;
  } else if (!timer && !inFlight) void poll();
}

async function poll(): Promise<void> {
  timer = undefined;
  inFlight = true;
  try {
    const r = await fetch('/api/system', { cache: 'no-store' });
    if (r.ok) {
      data = (await r.json()) as SystemResponse;
      dataAt = Date.now();
      error = '';
      remember(data);
    } else if (r.status === 404) error = 'This app server has no SYS readings yet. They come with the next server update.';
    else if (r.status === 401) error = 'Logged out. Reload the page to log in.';
    else error = `The app server answered ${r.status}.`;
  } catch {
    error = 'The PC cannot be reached.';
  }
  inFlight = false;
  renders.forEach((f) => f());
  if (wanted()) timer = setTimeout(() => void poll(), data && !data.sampledAt ? SOON_MS : POLL_MS);
}

// One point per server reading (a poll can come back with the same reading).
function remember(d: SystemResponse): void {
  if (!d.sampledAt || d.sampledAt === lastSample) return;
  lastSample = d.sampledAt;
  const add = (k: Series, v: number | null | undefined) => {
    hist[k].push(v ?? 0);
    if (hist[k].length > HISTORY) hist[k].shift();
  };
  add('cpu', d.cpu.pct);
  add('mem', pctOf(d.mem.used, d.mem.total));
  add('gpu', d.gpu?.pct);
  add('vram', pctOf(d.gpu?.vramUsed, d.gpu?.vramTotal));
  add('down', d.net?.rx);
  add('up', d.net?.tx);
}

// ---------------------------------------------------------------- drawing

// Bars, newest on the right. Colors come from CSS (the canvas's `color`), so every theme works.
function drawSpark(cv: HTMLCanvasElement, values: number[], max: number, slots = HISTORY): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth * dpr);
  const h = Math.round(cv.clientHeight * dpr);
  if (!w || !h) return;
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }
  const g = cv.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, w, h);
  g.fillStyle = getComputedStyle(cv).color;
  const slot = w / slots;
  const gap = slot >= 4 * dpr ? Math.round(dpr) : 0;
  const first = slots - values.length;
  values.forEach((v, i) => {
    const x = Math.round((first + i) * slot);
    const bw = Math.max(1, Math.round((first + i + 1) * slot) - x - gap);
    const bh = Math.round((Math.min(max, Math.max(0, v)) / max) * h);
    if (bh > 0) g.fillRect(x, h - bh, bw, bh);
  });
}

function light(bar: HTMLElement, pct: number | null): void {
  const segs = bar.children;
  const on = pct === null ? 0 : Math.round((Math.min(100, pct) / 100) * segs.length);
  for (let i = 0; i < segs.length; i++) segs[i].classList.toggle('on', i < on);
}

function heading(label: string): { root: HTMLElement; extra: HTMLElement } {
  const root = el('h3', 'ms-h');
  const extra = el('span', 'ms-h-extra');
  root.append(el('span', 'ms-h-label', label), extra);
  return { root, extra };
}

// "CPU [bar] 26%", a sparkline under the bar (with a side value, e.g. the temperature) and a detail line.
function gauge(key: string, series: Series | null) {
  const root = el('div', 'sys-g');
  const bar = segBar(0, SEGS);
  const val = el('span', 'sys-v', '--%');
  const detail = el('div', 'sys-d');
  root.append(el('span', 'sys-k', key), bar, val);
  const spark = series ? el('canvas', 'sys-spark') : null;
  const side = el('span', 'sys-side');
  if (spark) root.append(el('span'), spark, side);
  root.append(detail);
  return {
    root,
    set(pct: number | null, text: string, sideText = '', sideTitle = '') {
      light(bar, pct);
      val.textContent = pctText(pct);
      root.classList.toggle('hot', pct !== null && pct >= HOT);
      detail.textContent = text;
      detail.title = text;
      side.textContent = sideText;
      side.title = sideTitle;
      if (spark && series) drawSpark(spark, hist[series], 100);
    },
  };
}

// ---------------------------------------------------------------- the panel

export function mountSystem(root: HTMLElement): void {
  init();
  root.classList.add('sys');

  // Clock: the device's own time; uptime counts on between readings.
  const top = heading('SYSTEM');
  const time = el('span', 'sys-time');
  const ampm = el('span', 'sys-ampm');
  const clock = el('div', 'sys-clock');
  clock.append(time, ampm);
  const date = el('span', 'sys-date');
  const up = el('span', 'sys-up');
  const dateRow = el('div', 'sys-daterow');
  dateRow.append(date, up);
  const clockSec = el('section', 'ms-sec sys-sec');
  clockSec.append(top.root, clock, dateRow);
  const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  let tick: ReturnType<typeof setTimeout> | undefined;
  const showClock = () => {
    const now = new Date();
    const parts = timeFmt.formatToParts(now);
    time.textContent = parts
      .filter((p) => p.type !== 'dayPeriod')
      .map((p) => p.value)
      .join('')
      .trim();
    ampm.textContent = parts.find((p) => p.type === 'dayPeriod')?.value.toUpperCase() ?? '';
    date.textContent = dateFmt.format(now).toUpperCase();
    up.textContent = data ? `UP ${upText(data.uptime + (Date.now() - dataAt) / 1000)}` : '';
  };
  const runClock = (on: boolean) => {
    clearTimeout(tick);
    tick = undefined;
    if (!on) return;
    const step = () => {
      showClock();
      tick = setTimeout(step, 1000 - (Date.now() % 1000) + 5);
    };
    step();
  };

  const errLine = el('p', 'sys-error');
  errLine.hidden = true;

  // Load
  const loadH = heading('LOAD');
  const cpu = gauge('CPU', 'cpu');
  const cores = el('canvas', 'sys-cores');
  const coresRow = el('div', 'sys-g sys-cores-row');
  coresRow.append(el('span', 'sys-k', 'CORE'), cores);
  const ram = gauge('RAM', 'mem');
  const gpu = gauge('GPU', 'gpu');
  const vram = gauge('VRAM', 'vram');
  const gpuModel = el('div', 'sys-d sys-gpu-model');
  const speed = localSpeedBlock();
  const paint = el('div', 'sys-d sys-llm-1 sys-paint');
  paint.hidden = true;
  const loadSec = el('section', 'ms-sec sys-sec');
  loadSec.append(loadH.root, cpu.root, coresRow, ram.root, gpu.root, vram.root, gpuModel, speed.root, paint);

  // Network
  const netH = heading('NETWORK');
  const netRow = (key: string) => {
    const r = el('div', 'sys-g sys-net');
    const cv = el('canvas', 'sys-spark');
    const v = el('span', 'sys-v');
    r.append(el('span', 'sys-k', key), cv, v);
    return { r, cv, v };
  };
  const down = netRow('DOWN');
  const upR = netRow('UP');
  const netName = el('div', 'sys-d');
  upR.r.append(netName);
  const netSec = el('section', 'ms-sec sys-sec');
  netSec.append(netH.root, down.r, upR.r);

  // Drives: rebuilt only when the list changes.
  const diskH = heading('DRIVES');
  const diskList = el('div', 'sys-disks');
  const diskSec = el('section', 'ms-sec sys-sec');
  diskSec.append(diskH.root, diskList);
  let diskKey = '';
  let diskRows: { bar: HTMLElement; size: HTMLElement; pct: HTMLElement; row: HTMLElement }[] = [];

  // Volume
  const vol = volumeControl();

  const note = el('p', 'sys-note');
  note.hidden = true;
  root.replaceChildren(clockSec, errLine, loadSec, netSec, vol.section, diskSec, note);

  // On screen = this view picked, the right panel in view (phones slide it away), the chat app shown.
  let onScreen = false;
  const active = () => onScreen && !root.hidden;
  const update = () => {
    runClock(active() && document.visibilityState === 'visible');
    if (active()) render();
    sync();
  };
  new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    update();
  }).observe(root);
  new MutationObserver(update).observe(root, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', update);
  needs.add(active);

  function render(): void {
    const d = data;
    errLine.hidden = !error;
    errLine.textContent = error;
    showClock();
    top.extra.textContent = d?.host.toUpperCase() ?? '';
    if (!d) return;

    const c = d.cpu;
    const tempTitle = c.tempC === null && d.os === 'win32' ? 'Temperatures are not shown on Windows: reading them needs admin rights or LibreHardwareMonitor.' : 'Temperature';
    cpu.set(c.pct, shortCpu(c.name), temp(c.tempC), tempTitle);
    cores.title = `Each of the ${c.cores.length} threads`;
    drawSpark(cores, c.cores, 100, Math.max(1, c.cores.length));
    coresRow.hidden = !c.cores.length;
    const memPct = pctOf(d.mem.used, d.mem.total);
    ram.set(memPct, `${pair(d.mem.used, d.mem.total)} IN USE`);
    gpu.root.hidden = vram.root.hidden = !d.gpu;
    const loaded = d.gpuModels ?? [];
    gpuModel.hidden = !d.gpu || !loaded.length;
    gpuModel.textContent = `LOADED: ${loaded.join(', ')}`;
    gpuModel.title = 'Local AI model in video memory';
    speed.show(d.localSpeed);
    // The local image model at work: PAINTING 12/30 steps · 14 s (+ how many wait).
    const p = d.painting;
    paint.hidden = !p;
    if (p) {
      const head = p.phase === 'Painting' && p.steps ? `PAINTING ${p.step}/${p.steps} steps` : p.phase.toUpperCase();
      paint.textContent = `${head} · ${secs(p.ms)}${p.queued ? ` · ${p.queued} waiting` : ''}`;
      paint.title = `${p.model}: making a picture`;
    }
    if (d.gpu) {
      const g = d.gpu;
      const gTitle = g.tempC === null && d.os === 'win32' ? tempTitle : g.hotspotC !== null ? `Edge ${temp(g.tempC)}, hot spot ${temp(g.hotspotC)}` : 'Temperature';
      gpu.set(g.pct, g.name, temp(g.tempC), gTitle);
      vram.set(pctOf(g.vramUsed, g.vramTotal), g.vramUsed !== null && g.vramTotal ? `${pair(g.vramUsed, g.vramTotal)} VIDEO MEMORY` : 'VIDEO MEMORY --');
    }

    const peak = (k: Series) => Math.max(16 * 1024, ...hist[k]);
    down.v.textContent = d.net ? rate(d.net.rx) : '--';
    upR.v.textContent = d.net ? rate(d.net.tx) : '--';
    drawSpark(down.cv, hist.down, peak('down'));
    drawSpark(upR.cv, hist.up, peak('up'));
    down.cv.title = `Last 2 minutes, top of the chart: ${rate(peak('down'))}`;
    upR.cv.title = `Last 2 minutes, top of the chart: ${rate(peak('up'))}`;
    netName.textContent = d.net?.name ?? 'No network readings.';
    netName.title = netName.textContent;

    const key = d.disks.map((x) => `${x.name}|${x.label}`).join('\n');
    if (key !== diskKey) {
      diskKey = key;
      diskRows = d.disks.map((x) => {
        const row = el('div', 'sys-disk');
        const name = el('span', 'sys-disk-name', x.name);
        if (x.label) name.append(el('span', 'sys-disk-label', ` ${x.label.toUpperCase()}`));
        name.title = x.label ? `${x.name} ${x.label}` : x.name;
        const size = el('span', 'sys-disk-size');
        const bar = segBar(0, SEGS);
        const pct = el('span', 'sys-v');
        const line = el('div', 'sys-disk-top');
        line.append(name, size);
        row.append(line, bar, pct);
        return { row, bar, size, pct };
      });
      diskList.replaceChildren(...(diskRows.length ? diskRows.map((r) => r.row) : [el('div', 'sys-d', 'Reading the drives…')]));
    }
    d.disks.forEach((x, i) => {
      const r = diskRows[i];
      const p = pctOf(x.used, x.total);
      light(r.bar, p);
      r.pct.textContent = pctText(p);
      r.size.textContent = pair(x.used, x.total);
      r.row.classList.toggle('hot', p !== null && p >= HOT);
    });

    vol.show(d.volume);
    note.hidden = !d.note;
    note.textContent = d.note ?? '';
  }
  renders.add(() => active() && render());
}

// ---------------------------------------------------------------- local model speed

const tps = (v: number | null) => (v === null ? '--' : v < 10 ? v.toFixed(1) : String(Math.round(v)));
const toks = (v: number | null) => (v === null ? '--' : v >= 10_000 ? `${(v / 1000).toFixed(1)}K` : String(v));
function secs(ms: number | null): string {
  if (ms === null) return '--';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}
const PHASE: Record<NonNullable<LocalSpeedRun['phase']>, string> = { loading: 'LOADING MODEL', reading: 'READING PROMPT', thinking: 'THINKING', writing: 'WRITING' };
const ENDED: Record<LocalSpeedRun['outcome'], string> = { running: '', ok: 'LAST', error: 'LAST FAILED', cancelled: 'LAST STOPPED' };
const HELP =
  'Local model speed, measured in this app, in tokens per second. write: the answer. read: the prompt ' +
  '(~ = estimated from the time to the first token). Live counts are estimated from the stream; final counts come ' +
  'from the model server. RECENT: middle value of the last requests (first = time to the first token).';

// Under LOADED, only when a local model is set up: live while a request runs, the last one's numbers (dim) after.
function localSpeedBlock() {
  const root = el('div', 'sys-llm');
  const l1 = el('div', 'sys-d sys-llm-1');
  const l2 = el('div', 'sys-d');
  const l3 = el('div', 'sys-d');
  root.append(l1, l2, l3);
  const line = (e: HTMLElement, text: string) => {
    e.hidden = !text;
    e.textContent = text;
  };
  // "~640 read" beside a write speed, "~640 tok/s read" alone.
  const read = (r: { readTps: number | null; readExact?: boolean }, alone = false) => (r.readTps === null ? '' : `${r.readExact ? '' : '~'}${tps(r.readTps)}${alone ? ' tok/s' : ''} read`);
  return {
    root,
    show(s: LocalSpeed | undefined) {
      root.hidden = !s;
      if (!s) return;
      const run = s.live ?? s.last;
      root.classList.toggle('live', !!s.live);
      if (!run) {
        line(l1, 'LOCAL MODEL: NO REQUESTS YET');
        line(l2, '');
      } else if (s.live) {
        const ph = run.phase ?? 'reading';
        const head = ph === 'thinking' || ph === 'writing' ? `${PHASE[ph]} ${tps(run.nowTps)} tok/s · ${toks(run.outputTokens)} tok` : ph === 'reading' && run.inputTokens !== null ? `${PHASE[ph]} · ${toks(run.inputTokens)} tok` : PHASE[ph];
        line(l1, head);
        line(l2, `${run.model} · ${secs(run.totalMs)}`);
      } else {
        const parts = [run.writeTps === null ? '' : `${tps(run.writeTps)} tok/s write`, read(run, run.writeTps === null)].filter(Boolean);
        line(l1, run.outcome === 'ok' ? `LAST ${parts.join(' · ') || 'no speed (short answer)'}` : `${ENDED[run.outcome]} after ${secs(run.totalMs)}`);
        const detail = [run.firstTokenMs === null ? '' : `${secs(run.firstTokenMs)} first token`, run.outputTokens === null ? '' : `${toks(run.outputTokens)} tok`, run.outcome === 'ok' ? secs(run.totalMs) : ''];
        line(l2, detail.filter(Boolean).join(' · '));
      }
      const r = s.recent;
      line(l3, r && r.count > 1 ? `RECENT ${[r.writeTps === null ? '' : `${tps(r.writeTps)} tok/s write`, r.firstTokenMs === null ? '' : `${secs(r.firstTokenMs)} first`].filter(Boolean).join(' · ')}` : '');
      root.title = [run ? `Model: ${run.model}` : '', run?.inputTokens != null ? `Prompt: ${run.inputTokens} tokens read${run.cachedTokens ? `, ${run.cachedTokens} from cache` : ''}` : '', r && r.count > 1 ? `RECENT = middle of the last ${r.count}${r.readTps === null ? '' : `, ${read(r, true)}`}` : '', HELP].filter(Boolean).join('\n');
    },
  };
}

// ---------------------------------------------------------------- volume

function volumeControl() {
  const h = heading('VOLUME');
  const bar = segBar(0, VOL_SEGS);
  bar.classList.add('sys-vol-bar');
  bar.tabIndex = 0;
  bar.setAttribute('role', 'slider');
  bar.setAttribute('aria-label', 'PC volume');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const mute = el('button', 'sys-mute', 'MUTE');
  mute.type = 'button';
  const row = el('div', 'sys-vol');
  row.append(bar, mute);
  const msg = el('div', 'sys-d sys-vol-msg');
  msg.hidden = true;
  const section = el('section', 'ms-sec sys-sec');
  section.append(h.root, row, msg);

  let cur: SystemVolume | null = null;
  let heldUntil = 0;
  let changes = 0; // counts local changes, so an answer to an older one never overrides a newer one
  let pending: Partial<SystemVolume> = {};
  let sendTimer: ReturnType<typeof setTimeout> | undefined;

  const paint = (v: SystemVolume) => {
    light(bar, v.pct);
    bar.classList.toggle('muted', v.muted);
    bar.setAttribute('aria-valuenow', String(v.pct));
    bar.setAttribute('aria-valuetext', `${v.pct}%${v.muted ? ', muted' : ''}`);
    h.extra.textContent = v.muted ? `MUTED ${v.pct}%` : `${v.pct}%`;
    mute.textContent = v.muted ? 'MUTED' : 'MUTE';
    mute.classList.toggle('on', v.muted);
    mute.setAttribute('aria-pressed', String(v.muted));
  };

  const send = () => {
    sendTimer = undefined;
    const body = pending;
    const seq = changes;
    pending = {};
    fetch('/api/system/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as SystemVolume & { error?: string };
        if (!r.ok) throw new Error(j.error || `The app server answered ${r.status}.`);
        msg.hidden = true;
        if (seq === changes) {
          cur = { pct: j.pct, muted: j.muted };
          paint(cur);
        }
      })
      .catch((e: unknown) => {
        msg.textContent = e instanceof Error && e.message !== 'Failed to fetch' ? e.message : 'The PC cannot be reached.';
        msg.hidden = false;
        heldUntil = 0; // show the PC's real level again at the next reading
      });
  };

  const change = (next: Partial<SystemVolume>, now = false) => {
    if (!cur) return;
    cur = { ...cur, ...next };
    paint(cur);
    changes++;
    pending = { ...pending, ...next };
    heldUntil = Date.now() + VOL_HOLD_MS;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(send, now ? 0 : VOL_SEND_MS);
  };

  const atX = (x: number) => {
    const r = bar.getBoundingClientRect();
    if (r.width) change({ pct: Math.round(Math.min(1, Math.max(0, (x - r.left) / r.width)) * 100) });
  };
  let dragging = false;
  bar.onpointerdown = (e) => {
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    atX(e.clientX);
  };
  bar.onpointermove = (e) => dragging && atX(e.clientX);
  bar.onpointerup = bar.onpointercancel = () => (dragging = false);
  bar.onkeydown = (e) => {
    if (!cur) return;
    const step: Record<string, number> = { ArrowLeft: -2, ArrowDown: -2, ArrowRight: 2, ArrowUp: 2, PageDown: -10, PageUp: 10, Home: -100, End: 100 };
    if (!(e.key in step)) return;
    e.preventDefault();
    change({ pct: Math.min(100, Math.max(0, cur.pct + step[e.key])) });
  };
  mute.onclick = () => cur && change({ muted: !cur.muted }, true);

  return {
    section,
    show(v: SystemVolume | null) {
      row.hidden = !v;
      if (!v) {
        cur = null;
        h.extra.textContent = '';
        msg.textContent = 'No volume control on this PC.';
        msg.hidden = false;
        return;
      }
      if (Date.now() < heldUntil) return;
      if (msg.textContent === 'No volume control on this PC.') msg.hidden = true;
      cur = v;
      paint(v);
    },
  };
}

// ---------------------------------------------------------------- summary for the top bar or launcher

// A self-updating "CPU 12% RAM 41% GPU 3%". Asks the server only while it is on screen.
export function sysSummary(): HTMLElement {
  init();
  const s = el('span', 'sys-sum', sysSummaryText());
  s.title = 'Processor, memory and graphics card use';
  let onScreen = false;
  new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    sync();
  }).observe(s);
  needs.add(() => onScreen && s.isConnected);
  renders.add(() => (s.textContent = sysSummaryText()));
  return s;
}
