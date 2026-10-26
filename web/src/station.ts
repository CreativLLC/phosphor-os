import './station.css';
import {
  STATION_KINDS,
  kindLabel,
  type StationDay,
  type StationDiscoverResponse,
  type StationEntry,
  type StationFound,
  type StationResponse,
  type StationSaveRequest,
  type StationState,
} from '../../shared/station.ts';
import type { UnraidResponse } from '../../shared/unraid.ts';
import { open as openProgram, showTab, webState } from './browser.ts';
import { addLauncherCommands } from './launcher.ts';
import { shellApi } from './shellapi.ts';
import { demoStation, demoUnraid } from './stationdemo.ts';
import { store } from './store.ts';
import { button, confirmBox, el, timeAgo, toast } from './ui.ts';
import { mountUnraid, type UnraidPanel } from './unraid.ts';

// STATION: the owner's self-hosted services (Nextcloud, Plex, the *arr apps, the server itself...) in one
// screen: a lamp per service (UP / SLOW / DOWN), response time, last seen and a sparkline of recent checks;
// OPEN, EDIT, REMOVE; DISCOVER looks for apps on one host of the owner's own network. A drawer like HISTORY.
// Data: server/station.ts (data/station.json). Checks run on the server once a minute, and only while this
// drawer is on screen somewhere: the drawer asks every POLL_MS; nothing is asked or drawn while it is closed
// (except the badge on the STATION button, from the list read on load and when the window comes back). Each tile
// also has a 24-hour uptime strip. Above the tiles, the Unraid panel (unraid.ts) if the server is connected.
// OPEN: in the desktop app inside the app (a saved site with the same address, else a WEB tab); elsewhere a
// new browser tab. Desktop app only: SKIN puts the Retro look on that app's pages (shell/skins.mjs); this file
// tells the shell which addresses get which skin, and the theme, whenever either changes.

const POLL_MS = 15_000;
const SOON_MS = 1500; // a check round is running: ask again soon
const PEEK_MS = 60_000; // window focus re-reads the list (skins, launcher) at most this often
const HOST_KEY = 'phosphor.station.host';

const STATE_LABEL: Record<StationState, string> = { up: 'UP', slow: 'SLOW', down: 'DOWN', unknown: '----' };

type Tile = { root: HTMLElement; lamp: HTMLElement; ms: HTMLElement; spark: HTMLCanvasElement; day: HTMLCanvasElement; up: HTMLElement; note: HTMLElement; meta: HTMLElement };

let drawer: HTMLElement;
let openBtn: HTMLElement | null = null;
let summary: HTMLElement;
let grid: HTMLElement;
let disc: HTMLElement;
let discInput: HTMLInputElement;
let discBtn: HTMLButtonElement;
let discList: HTMLElement;
let discNote: HTMLElement;
let checkBtn: HTMLButtonElement;

let data: StationResponse | null = null;
let unraid: UnraidPanel;
let unraidData: UnraidResponse | null = null;
let badge: HTMLElement | null = null;
let error = '';
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;
let peekAt = 0;
let gridKey = '';
let found: StationDiscoverResponse | null = null;
const tiles = new Map<string, Tile>();

export function mountStation(drawerEl: HTMLElement, btn: HTMLElement | null): void {
  drawer = drawerEl;
  openBtn = btn;
  drawer.classList.add('station');
  drawer.tabIndex = -1;

  const head = el('div', 'drawer-head');
  const tools = el('div', 'st-head-tools');
  checkBtn = button('CHECK', () => void checkNow());
  checkBtn.title = 'Check every service now';
  const discToggle = button('DISCOVER', () => toggleDiscover());
  discToggle.title = 'Look for apps on a server of your own network';
  const add = button('ADD', () => void editService(null));
  add.title = 'Add a service by hand';
  tools.append(checkBtn, discToggle, add, button('CLOSE', closeStation));
  head.append(el('h2', '', 'STATION'), tools);

  summary = el('p', 'st-sub');
  disc = buildDiscover();
  disc.hidden = true;
  grid = el('div', 'st-grid');
  unraid = mountUnraid();
  const body = el('div', 'st-body');
  body.append(disc, unraid.root, grid);
  drawer.replaceChildren(head, summary, body);

  if (btn) {
    btn.onclick = () => (drawer.hidden ? openStation() : closeStation());
    badge = el('span', 'st-badge');
    badge.hidden = true;
    btn.append(badge);
  }
  // One drawer at a time.
  for (const id of ['btn-history', 'btn-mcp']) document.getElementById(id)?.addEventListener('click', closeStation);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden && !document.querySelector('dialog[open]')) closeStation();
  });
  document.addEventListener('visibilitychange', sync);
  // Skins follow the app's theme (and CRT level).
  window.addEventListener('themechange', syncSkins);
  // Another device may have changed the list: read it again when this window comes back (not more than once a minute).
  window.addEventListener('focus', () => {
    if (drawer.hidden && Date.now() - peekAt > PEEK_MS) void peek();
  });

  addLauncherCommands([
    { id: 'station', label: 'STATION', hint: 'YOUR SERVERS AND APPS', keywords: ['homelab', 'server', 'services', 'health', 'status', 'nas'], run: openStation },
    {
      id: 'station-discover',
      label: 'DISCOVER SERVICES',
      hint: 'STATION',
      keywords: ['station', 'scan', 'find', 'homelab', 'server', 'apps'],
      run: () => {
        openStation();
        toggleDiscover(true);
      },
    },
  ]);
  // The list, once, for the skins and the launcher. Does not start any checks.
  setTimeout(() => void peek(), 0);
}

export function openStation(): void {
  for (const id of ['history', 'mcp', 'usage']) {
    const d = document.getElementById(id);
    if (d) d.hidden = true;
  }
  drawer.hidden = false;
  openBtn?.classList.add('on');
  drawer.focus();
  render();
  sync();
}

export function closeStation(): void {
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  openBtn?.classList.remove('on');
  sync();
}

// ---------------------------------------------------------------- server

const wanted = () => !drawer.hidden && document.visibilityState === 'visible';

function sync(): void {
  if (!wanted()) {
    clearTimeout(timer);
    timer = undefined;
  } else if (!timer && !inFlight) void poll();
}

async function poll(): Promise<void> {
  timer = undefined;
  inFlight = true;
  await load('');
  inFlight = false;
  if (wanted()) timer = setTimeout(() => void poll(), data?.checking || unraidData?.checking ? SOON_MS : POLL_MS);
}

async function peek(): Promise<void> {
  peekAt = Date.now();
  await load('?peek=1');
}

// Demo mode (?demo=1) draws made-up services and a made-up Unraid and asks the server nothing.
const isDemo = () => store.demo || new URLSearchParams(location.search).has('demo');

// The services and the Unraid panel's data, together. ?peek=1 does not count as "STATION is on screen" for the checks.
async function load(query: string): Promise<void> {
  if (isDemo()) {
    data = demoStation();
    unraidData = demoUnraid();
    error = '';
    afterList();
    render();
    return;
  }
  await Promise.all([take(fetch(`/api/station${query}`, { cache: 'no-store' })), takeUnraid(fetch(`/api/station/unraid${query}`, { cache: 'no-store' }))]);
}

// The Unraid answer, if this server has one (an older one answers 404: no panel).
async function takeUnraid(req: Promise<Response>): Promise<void> {
  try {
    const r = await req;
    const j = (await r.json().catch(() => null)) as UnraidResponse | null;
    if (j && typeof j.configured === 'boolean') unraidData = j;
  } catch {
    /* take() says the PC cannot be reached */
  }
  showBadge();
  render();
}

async function post(path: string, body: unknown): Promise<boolean> {
  if (isDemo()) {
    toast('Demo mode: nothing is saved.');
    return false;
  }
  return take(fetch(`/api/station/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

// Any answer with the list in it: keep it, redraw, tell the shell and the launcher. False on an error.
async function take(req: Promise<Response>): Promise<boolean> {
  try {
    const r = await req;
    const j = (await r.json().catch(() => null)) as StationResponse | null;
    if (j && Array.isArray(j.services)) {
      data = j;
      error = '';
      afterList();
    } else if (r.status === 404) error = 'This app server has no STATION yet. It comes with the next server update.';
    else if (r.status === 401) error = 'Logged out. Reload the page to log in.';
    if (j?.error) {
      toast(j.error, 6000);
      render();
      return false;
    }
    if (!r.ok && !j) error = `The app server answered ${r.status}.`;
  } catch {
    error = 'The PC cannot be reached.';
  }
  render();
  return !error;
}

async function checkNow(): Promise<void> {
  checkBtn.disabled = true;
  checkBtn.textContent = 'CHECKING…';
  await post('check', {});
  checkBtn.disabled = false;
  checkBtn.textContent = 'CHECK';
}

// A number on the STATION button when something needs a look: services DOWN, Unraid alerts and warnings, or an
// Unraid that does not answer. Drawn from what the page last read, also with the drawer closed.
function showBadge(): void {
  if (!badge) return;
  const down = data?.services.filter((s) => s.status.state === 'down').length ?? 0;
  const u = unraidData;
  const n = down + (u?.configured ? u.alerts.length + (u.state === 'ok' || u.state === 'loading' ? 0 : 1) : 0);
  badge.hidden = n === 0;
  badge.textContent = String(n);
  badge.title = n ? `${down ? `${down} service${down === 1 ? '' : 's'} down. ` : ''}${u?.configured && u.alerts.length ? `${u.alerts.length} Unraid alert${u.alerts.length === 1 ? '' : 's'}.` : ''}${u?.configured && u.state !== 'ok' && u.state !== 'loading' ? ' Unraid does not answer.' : ''}`.trim() : '';
}

// ---------------------------------------------------------------- skins and launcher

let skinsSent = '';

function afterList(): void {
  showBadge();
  syncSkins();
  const list = data?.services ?? [];
  const cmds = list.map((s) => ({
    id: `station-open:${s.id}`,
    label: `OPEN ${s.name.toUpperCase()}`,
    hint: `${hostOf(s.url)} · ${STATE_LABEL[s.status.state] === '----' ? 'STATION' : STATE_LABEL[s.status.state]}`,
    keywords: ['station', s.name, kindLabel(s.kind).toLowerCase(), hostOf(s.url)],
    run: () => {
      const now = data?.services.find((x) => x.id === s.id);
      if (now) void openService(now);
      else toast(`${s.name} was removed from STATION.`);
    },
  }));
  // A removed service keeps its launcher row until reload (the launcher has no remove); it then says so.
  addLauncherCommands(cmds);
}

function themeId(): string {
  const d = document.documentElement.dataset;
  return d.theme || d.phosphor || 'amber';
}

function syncSkins(): void {
  if (!shellApi?.setSkins || !data) return;
  const sites: { origin: string; kind: string }[] = [];
  for (const s of data.services) {
    if (!s.skin) continue;
    try {
      sites.push({ origin: new URL(s.url).origin, kind: s.kind });
    } catch {
      /* bad address: no skin */
    }
  }
  const cfg = { theme: themeId(), crt: document.documentElement.dataset.crt || 'off', sites };
  const key = JSON.stringify(cfg);
  if (key === skinsSent) return;
  skinsSent = key;
  shellApi.setSkins(cfg);
}

// ---------------------------------------------------------------- open

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const sameOrigin = (a: string, origin: string) => {
  try {
    return new URL(a).origin === origin;
  } catch {
    return false;
  }
};

async function openService(s: StationEntry): Promise<void> {
  closeStation();
  if (!shellApi) return void window.open(s.url, '_blank', 'noopener,noreferrer');
  // The app's panes refuse certificates this PC does not trust; the normal browser lets you decide.
  if (s.selfSigned) {
    window.open(s.url, '_blank');
    return void toast(`${s.name}: opened in your normal browser (self-signed certificate).`);
  }
  const origin = new URL(s.url).origin;
  const st = webState();
  const site = st.sites.find((x) => sameOrigin(x.url, origin));
  if (site) return void openProgram(site.id);
  const tab = st.tabs.find((t) => t.owner === 'web' && sameOrigin(t.url, origin));
  if (tab) return void showTab(tab.id);
  const id = await shellApi.newTab(s.url);
  if (!id) return void toast('Too many tabs. Close one first.');
  await showTab(id);
}

// ---------------------------------------------------------------- drawing

function render(): void {
  if (!drawer || drawer.hidden) return;
  const list = data?.services ?? [];
  const n = (st: StationState) => list.filter((s) => s.status.state === st).length;
  if (error && !data) summary.textContent = error;
  else if (!list.length) summary.textContent = data ? 'Your self-hosted apps, checked once a minute while this is open.' : 'Loading…';
  else {
    const u = unraidData;
    const unraidWord = !u?.configured ? '' : u.state !== 'ok' && u.state !== 'loading' ? 'UNRAID NOT ANSWERING' : u.alerts.length ? `UNRAID ${u.alerts.length} ALERT${u.alerts.length === 1 ? '' : 'S'}` : u.state === 'ok' ? 'UNRAID OK' : '';
    const parts = [`${list.length} SERVICE${list.length === 1 ? '' : 'S'}`, `${n('up')} UP`, n('slow') && `${n('slow')} SLOW`, n('down') && `${n('down')} DOWN`, unraidWord, data?.checking ? 'CHECKING…' : 'CHECKS EVERY MINUTE WHILE OPEN'];
    summary.textContent = parts.filter(Boolean).join(' · ');
    if (error) summary.textContent += ` · ${error}`;
  }
  summary.classList.toggle('st-alert', n('down') > 0 || !!unraidData?.alerts.some((a) => a.level === 'alert') || (!!unraidData?.configured && unraidData.state !== 'ok' && unraidData.state !== 'loading'));
  unraid.set(unraidData);

  // Tiles are made again only when the list itself changes; status updates go in place (no lost clicks).
  const key = JSON.stringify(list.map(({ status: _s, day: _d, ...rest }) => rest));
  if (key !== gridKey) {
    gridKey = key;
    tiles.clear();
    if (!list.length && data) {
      const empty = el('div', 'st-empty');
      empty.append(
        el('p', '', 'NO SERVICES YET.'),
        el('p', '', 'Press DISCOVER to look for apps on one of your servers, or ADD to type an address.'),
      );
      grid.replaceChildren(empty);
    } else {
      grid.replaceChildren(...list.map((s) => tile(s).root));
    }
  }
  for (const s of list) update(s);
  if (found) renderFound();
}

function tile(s: StationEntry): Tile {
  const root = el('article', 'st-tile');
  const lamp = el('span', 'st-lamp');
  const name = el('span', 'st-name', s.name);
  name.title = s.name;
  const ms = el('span', 'st-ms');
  const top = el('div', 'st-top');
  top.append(lamp, name, ms);
  const meta = el('div', 'st-meta');
  const spark = el('canvas', 'st-spark');
  spark.setAttribute('aria-hidden', 'true');
  const day = el('canvas', 'st-day');
  day.setAttribute('aria-hidden', 'true');
  const up = el('div', 'st-uptime');
  const note = el('div', 'st-note');
  const btns = el('div', 'st-btns');
  const open = button('OPEN', () => void openService(data?.services.find((x) => x.id === s.id) ?? s));
  open.title = shellApi ? (s.selfSigned ? 'Open in your normal browser' : 'Open inside Phosphor-OS') : 'Open in a new tab';
  btns.append(open, button('EDIT', () => void editService(s)), button('REMOVE', () => void removeService(s)));
  const foot = el('div', 'st-foot');
  foot.append(note, btns);
  root.append(top, meta, spark, day, up, foot);
  const t = { root, lamp, ms, spark, day, up, note, meta };
  tiles.set(s.id, t);
  return t;
}

function update(s: StationEntry): void {
  const t = tiles.get(s.id);
  if (!t) return;
  const st = s.status;
  t.root.className = `st-tile st-${st.state}`;
  t.lamp.textContent = STATE_LABEL[st.state];
  t.lamp.title = st.state === 'unknown' ? 'Not checked yet' : `${STATE_LABEL[st.state]}${st.code ? ` (HTTP ${st.code})` : ''}`;
  t.ms.textContent = st.ms === null ? '' : `${st.ms} MS`;
  const tags = [hostOf(s.url), kindLabel(s.kind)];
  if (s.selfSigned) tags.push('SELF-SIGNED');
  if (shellApi && s.skin) tags.push('SKIN');
  t.meta.textContent = tags.join(' · ');
  t.meta.title = s.url;
  const when = st.at ? `CHECKED ${timeAgo(st.at).toUpperCase()}` : 'NOT CHECKED YET';
  const seen = st.state === 'down' ? (st.lastUp ? `LAST SEEN ${timeAgo(st.lastUp).toUpperCase()}` : 'NEVER SEEN UP') : '';
  t.note.textContent = [st.note, seen, when].filter(Boolean).join(' · ');
  t.note.title = t.note.textContent;
  drawSpark(t.spark, s);
  drawDay(t.day, s.day);
  t.up.textContent = s.day.checks ? `24H ${s.day.upPct}% UP${s.day.avgMs !== null ? ` · AVERAGE ${s.day.avgMs} MS` : ''}` : '24H: NO CHECKS YET';
  t.up.title = s.day.checks ? `${s.day.checks} check${s.day.checks === 1 ? '' : 's'} in the last 24 hours. Each block is 15 minutes; the newest is on the right.` : 'Checks run every 10 minutes, and every minute while STATION is open.';
}

// One bar per check, newest on the right: height = response time; DOWN = a full bar in the alert color.
// Colors come from CSS (station.css), so every theme works. Drawn only after new data, never in a loop.
function drawSpark(cv: HTMLCanvasElement, s: StationEntry): void {
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
  const css = getComputedStyle(cv);
  const colors: Record<StationState, string> = {
    up: css.color,
    slow: css.getPropertyValue('--st-slow').trim() || css.color,
    down: css.getPropertyValue('--st-down').trim() || css.color,
    unknown: css.color,
  };
  const slots = 40;
  const hist = s.status.history.slice(-slots);
  const max = Math.max(data?.slowMs ?? 2000, ...hist.map((c) => c.ms ?? 0));
  const slot = w / slots;
  const gap = slot >= 4 * dpr ? Math.round(dpr) : 0;
  const first = slots - hist.length;
  hist.forEach((c, i) => {
    const x = Math.round((first + i) * slot);
    const bw = Math.max(1, Math.round((first + i + 1) * slot) - x - gap);
    const bh = c.state === 'down' ? h : Math.max(Math.round(2 * dpr), Math.round(((c.ms ?? 0) / max) * h));
    g.fillStyle = colors[c.state];
    g.fillRect(x, h - bh, bw, bh);
  });
}

// The last 24 hours, one block per 15 minutes, newest on the right: a low dim block = all answered, a taller brighter
// one = slow, a full block with a bright top = some checks failed, a full bright block = all failed, a thin line = no
// check then (server/stationhealth.ts).
function drawDay(cv: HTMLCanvasElement, day: StationDay): void {
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
  const css = getComputedStyle(cv);
  const dim = css.color;
  const slow = css.getPropertyValue('--st-slow').trim() || dim;
  const down = css.getPropertyValue('--st-down').trim() || dim;
  const line = css.getPropertyValue('--line').trim() || dim;
  const n = day.cells.length || 1;
  const slot = w / n;
  const gap = slot >= 3 * dpr ? Math.max(1, Math.round(dpr)) : 0;
  const thin = Math.max(1, Math.round(dpr));
  for (let i = 0; i < day.cells.length; i++) {
    const x = Math.round(i * slot);
    const bw = Math.max(1, Math.round((i + 1) * slot) - x - gap);
    switch (day.cells[i]) {
      case 'u': // answered: a low block, so that trouble stands out
        g.fillStyle = dim;
        g.fillRect(x, Math.floor(h * 0.4), bw, h);
        break;
      case 's':
        g.fillStyle = slow;
        g.fillRect(x, Math.floor(h * 0.2), bw, h);
        break;
      case 'p':
        g.fillStyle = down;
        g.fillRect(x, 0, bw, Math.ceil(h * 0.6));
        g.fillStyle = dim;
        g.fillRect(x, Math.ceil(h * 0.6), bw, h);
        break;
      case 'd':
        g.fillStyle = down;
        g.fillRect(x, 0, bw, h);
        break;
      default:
        g.fillStyle = line;
        g.fillRect(x, h - thin, bw, thin);
    }
  }
}

// ---------------------------------------------------------------- add, edit, remove

async function removeService(s: StationEntry): Promise<void> {
  if (!(await confirmBox('REMOVE SERVICE', `Remove ${s.name} from STATION? Nothing on the server changes.`, 'REMOVE'))) return;
  await post('remove', { id: s.id });
}

type Fields = { name: string; url: string; kind: string; selfSigned: boolean; skin: boolean };

async function editService(s: StationEntry | null, start?: Partial<Fields>): Promise<boolean> {
  const r = await serviceBox(s ? 'EDIT SERVICE' : 'ADD A SERVICE', { name: '', url: '', kind: 'generic', selfSigned: false, skin: true, ...start, ...(s ?? {}) }, !!s);
  if (!r) return false;
  if (r === 'remove') {
    await post('remove', { id: s!.id });
    return false;
  }
  const req: StationSaveRequest = { ...r, ...(s ? { id: s.id } : {}) };
  return post('save', req);
}

function serviceBox(heading: string, v: Fields, canRemove: boolean): Promise<Fields | 'remove' | null> {
  return new Promise((resolve) => {
    const d = el('dialog', 'site-box station-box');
    const form = el('form', 'site-form');
    const name = field('NAME', v.name, 'Nextcloud');
    name.input.maxLength = 32;
    const url = field('ADDRESS', v.url, '192.168.1.10:8080 or https://cloud.example.com');
    url.input.spellcheck = false;
    const kindRow = el('label', 'site-field');
    const kind = el('select');
    for (const k of STATION_KINDS) {
      const o = el('option', '', k.label);
      o.value = k.id;
      kind.append(o);
    }
    kind.value = v.kind;
    kindRow.append(el('span', '', 'KIND'), kind);
    const selfSigned = toggle('SELF-SIGNED', v.selfSigned, 'For the health check only: accept a certificate this PC does not trust (your own server).');
    const skin = toggle('SKIN', v.skin, shellApi ? 'Show this app in the Retro look inside this app.' : 'Desktop app only: shows this app in the Retro look.');
    const err = el('p', 'site-err');
    err.hidden = true;
    form.append(name.row, url.row, kindRow, selfSigned.row, skin.row, err);

    const done = (r: Fields | 'remove' | null) => {
      d.close();
      d.remove();
      resolve(r);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const n = name.input.value.trim();
      const u = url.input.value.trim();
      const fail = (text: string, input: HTMLElement) => {
        err.textContent = text;
        err.hidden = false;
        input.focus();
      };
      if (!n) return fail('Give it a name.', name.input);
      if (!webAddress(u)) return fail('Type a web address, like 192.168.1.10:8080.', url.input);
      done({ name: n, url: u, kind: kind.value, selfSigned: selfSigned.on(), skin: skin.on() });
    };
    const save = button('SAVE', () => {}, 'primary');
    save.type = 'submit';
    const row = el('div', 'buttons');
    if (canRemove) row.append(button('REMOVE', () => done('remove'), 'site-remove'));
    row.append(save, button('CANCEL', () => done(null)));
    form.append(row);
    d.append(el('h2', '', heading), form);
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    document.body.append(d);
    d.showModal();
    (v.name ? name.input : url.input).select();
  });
}

// Same rule as the server (server/station.ts webAddress): http(s) only; no scheme = http.
function webAddress(text: string): string | null {
  const s = /^[a-z][\w+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && u.hostname && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

function field(label: string, value: string, example: string) {
  const row = el('label', 'site-field');
  const input = el('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = example;
  input.autocomplete = 'off';
  row.append(el('span', '', label), input);
  return { row, input };
}

// OFF / ON pair (settings.css .seg).
function toggle(label: string, on: boolean, help: string) {
  const row = el('div', 'site-field st-toggle');
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', label);
  let value = on;
  const off = button('OFF', () => set(false));
  const yes = button('ON', () => set(true));
  const set = (v: boolean) => {
    value = v;
    off.classList.toggle('on', !v);
    yes.classList.toggle('on', v);
    off.setAttribute('aria-pressed', String(!v));
    yes.setAttribute('aria-pressed', String(v));
  };
  set(on);
  seg.append(off, yes);
  row.append(el('span', '', label), seg, el('small', 'st-help', help));
  return { row, on: () => value };
}

// ---------------------------------------------------------------- DISCOVER

function buildDiscover(): HTMLElement {
  const box = el('section', 'st-discover');
  const form = el('form', 'st-disc-form');
  discInput = el('input', 'st-disc-host');
  discInput.type = 'text';
  discInput.placeholder = 'Server address, like 192.168.1.10 or nas.local';
  discInput.spellcheck = false;
  discInput.autocomplete = 'off';
  discInput.setAttribute('aria-label', 'Server to look at');
  try {
    discInput.value = localStorage.getItem(HOST_KEY) ?? '';
  } catch {
    /* storage blocked */
  }
  discBtn = button('SCAN', () => {}, 'primary');
  discBtn.type = 'submit';
  form.append(discInput, discBtn);
  form.onsubmit = (e) => {
    e.preventDefault();
    void scan();
  };
  discNote = el('p', 'st-disc-note', 'Looks at about 40 ports common for self-hosted apps and reads each page title. Only your own network: LAN, tailnet or this PC.');
  discList = el('div', 'st-disc-list');
  box.append(el('h3', 'st-h', 'DISCOVER'), form, discNote, discList);
  return box;
}

function toggleDiscover(show = disc.hidden): void {
  disc.hidden = !show;
  if (show) discInput.focus();
}

async function scan(): Promise<void> {
  const host = discInput.value.trim();
  if (!host) return discInput.focus();
  try {
    localStorage.setItem(HOST_KEY, host);
  } catch {
    /* storage blocked */
  }
  discBtn.disabled = true;
  discBtn.textContent = 'SCANNING…';
  discNote.textContent = `Looking at ${host}…`;
  discList.replaceChildren();
  found = null;
  try {
    const r = await fetch('/api/station/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host }) });
    const j = (await r.json().catch(() => null)) as (StationDiscoverResponse & { error?: string }) | null;
    if (!j || j.error || !Array.isArray(j.results)) discNote.textContent = j?.error ?? `The app server answered ${r.status}.`;
    else {
      found = j;
      const at = j.addresses[0] && j.addresses[0] !== j.host ? ` (${j.addresses[0]})` : '';
      discNote.textContent = `${j.host}${at}: ${j.results.length} web app${j.results.length === 1 ? '' : 's'} on ${j.scanned} ports looked at, in ${(j.ms / 1000).toFixed(1)} s.`;
      renderFound();
    }
  } catch {
    discNote.textContent = 'The PC cannot be reached.';
  }
  discBtn.disabled = false;
  discBtn.textContent = 'SCAN';
}

function renderFound(): void {
  if (!found) return;
  const have = data?.services ?? [];
  const rows = found.results.map((f) => {
    const r = el('div', 'st-found');
    const port = el('span', 'st-port', `:${f.port}`);
    const app = el('span', 'st-app', f.app.toUpperCase());
    app.title = f.sure ? 'Named from its page' : 'A guess from the port number';
    const where = el('span', 'st-where', f.url + (f.title && f.title !== f.app ? `  "${f.title}"` : ''));
    where.title = f.url;
    const added = have.some((s) => sameOrigin(s.url, new URL(f.url).origin));
    const act = added ? el('span', 'st-added', 'ADDED') : button('ADD', () => void addFound(f));
    r.append(port, app, where, act);
    return r;
  });
  if (!rows.length) rows.push(el('div', 'st-empty', 'NO WEB APPS ANSWERED ON THE USUAL PORTS.'));
  discList.replaceChildren(...rows);
}

async function addFound(f: StationFound): Promise<void> {
  const name = f.app.replace(/\?$/, '').replace(/ or .*$/, '').slice(0, 32);
  await editService(null, { name, url: f.url, kind: f.kind, selfSigned: f.selfSigned, skin: true });
}
