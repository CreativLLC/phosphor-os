import './alerts.css';
import type { PushDevice, PushPrefs, PushStatusResponse } from '../../shared/protocol.ts';
import { send } from './net.ts';
import { store } from './store.ts';
import { button, el, timeAgo, toast } from './ui.ts';

// ALERTS: a buzz when Claude finishes a turn (DONE) or waits for you (NEEDS YOU).
// - Browsers with Web Push (the phone) subscribe; the PC sends the alert (server/push.ts) and the service worker
//   shows it (web/public/sw.js), even with the app closed.
// - Any open page in the background (hidden, or another window has focus) shows the alert itself, so the desktop
//   app (no push in Electron) gets it too. It uses the push's tag, so one alert per event, not two.
// - The page tells the server which tab it shows and whether you look at it: no push for a tab in front of you.
// SETTINGS > ALERTS is alertsSection(); main.ts calls initAlerts().

type Kind = 'done' | 'needs' | 'test';
type Local = { on: boolean; done: boolean; needs: boolean; quiet: PushPrefs['quiet']; id: string | null; endpoint: string | null };

const KEY = 'phosphor.alerts';
const LOOK_EVERY_MS = 20_000; // server forgets "looking" after 30 s
const DONE_DELAY_MS = 1500;
const GAP_MS: Record<Kind, number> = { done: 20_000, needs: 5_000, test: 0 };
const SAME_MS = 10_000; // same as sw.js
const BUZZ: Record<Kind, number[]> = { needs: [300, 120, 300, 120, 300], done: [180, 90, 180], test: [180, 90, 180] };
const TITLES: Record<Kind, string> = { done: 'CLAUDE: DONE', needs: 'CLAUDE NEEDS YOU', test: 'CLAUDE: TEST' };

let local = loadLocal();
let pushProblem = ''; // why push did not work on this device (alerts then show only while the page runs)
let redraw: (() => void) | undefined;

function loadLocal(): Local {
  let s: Partial<Local> = {};
  try {
    s = (JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Local>) ?? {};
  } catch {
    /* blocked or bad JSON */
  }
  return { on: s.on === true, done: s.done !== false, needs: s.needs !== false, quiet: s.quiet ?? null, id: s.id ?? null, endpoint: s.endpoint ?? null };
}

function setLocal(p: Partial<Local>): void {
  local = { ...local, ...p };
  try {
    localStorage.setItem(KEY, JSON.stringify(local));
  } catch {
    /* storage blocked: works until reload */
  }
}

const isShell = () => 'phosphorShell' in window || /Electron\//.test(navigator.userAgent);
const canNotify = () => isSecureContext && 'Notification' in window;
// Electron has no push service; its page alerts while the app runs (also from the tray).
const canPush = () => canNotify() && !isShell() && 'serviceWorker' in navigator && 'PushManager' in window;
const lookingNow = () => document.visibilityState === 'visible' && document.hasFocus();

function inQuiet(q: Local['quiet'], d = new Date()): boolean {
  if (!q) return false;
  const min = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const now = d.getHours() * 60 + d.getMinutes();
  const [from, to] = [min(q.from), min(q.to)];
  return from !== to && (from < to ? now >= from && now < to : now >= from || now < to);
}

function openTab(id: string): void {
  if (store.tabs.has(id)) store.setActive(id);
}

export function initAlerts(): void {
  // Opened from an alert (sw.js): start on that tab (store.ts reads this key at hello), then clean the address.
  const params = new URLSearchParams(location.search);
  const want = params.get('tab');
  if (want !== null) {
    try {
      if (/^[\w-]{1,64}$/.test(want)) localStorage.setItem('phosphor.activeTab', want);
    } catch {
      /* storage blocked */
    }
    params.delete('tab');
    const q = params.toString();
    history.replaceState(history.state, '', location.pathname + (q ? `?${q}` : '') + location.hash);
  }
  // Tap on an alert while the app is open: sw.js focuses this window and names the tab.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    const d = e.data as { t?: unknown; tab?: unknown } | null;
    if (d?.t === 'phosphor-open-tab' && typeof d.tab === 'string') openTab(d.tab);
  });
  watchPresence();
  watchTabs();
  if (local.on && local.id) void renew();
}

// ---------------------------------------------------------------- presence (server skips the push)

function watchPresence(): void {
  let sent = { tab: null as string | null, looking: false, at: 0 };
  let beat: ReturnType<typeof setTimeout> | undefined;
  const update = (force = false) => {
    clearTimeout(beat);
    if (store.demo || !store.connected || !store.active) return; // no tab yet (before hello): nothing to look at
    const now = { tab: store.active, looking: lookingNow() };
    const stale = now.looking && Date.now() - sent.at >= LOOK_EVERY_MS - 1000;
    if (force || stale || now.tab !== sent.tab || now.looking !== sent.looking) {
      send({ t: 'presence', ...now });
      sent = { ...now, at: Date.now() };
    }
    // Repeat while you look, so a phone that sleeps without a word stops counting as looking.
    // Counted from the last message, so an event in between never stretches the gap past the server's 30 s.
    if (now.looking) beat = setTimeout(() => update(), Math.max(1000, LOOK_EVERY_MS - (Date.now() - sent.at)));
  };
  for (const ev of ['focus', 'blur', 'pageshow']) window.addEventListener(ev, () => update());
  document.addEventListener('visibilitychange', () => update());
  store.on((c) => {
    if (c.kind === 'active') update();
    else if (c.kind === 'connection' && store.connected) {
      // A new socket knows nothing yet. On the first connect the tab is picked at hello ('active' sends then).
      sent = { tab: null, looking: false, at: 0 };
      if (store.active) update(true);
    }
  });
}

// ---------------------------------------------------------------- alerts shown by this page

function watchTabs(): void {
  const prev = new Map<string, { busy: boolean; attention: boolean }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let primed = false; // the first tab list is the state on connect, not a change
  store.on((c) => {
    if (c.kind !== 'tabs') return;
    for (const t of store.tabs.values()) {
      const id = t.meta.id;
      const p = prev.get(id);
      if (primed && t.meta.attention && !p?.attention) void pageAlert('needs', id);
      if (primed && p?.busy && !t.meta.busy) {
        // A queued message or background agent can start the next turn right away: wait a moment.
        clearTimeout(timers.get(id));
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            if (store.tabs.get(id)?.meta.busy === false) void pageAlert('done', id);
          }, DONE_DELAY_MS),
        );
      }
      prev.set(id, { busy: t.meta.busy, attention: t.meta.attention });
    }
    for (const id of [...prev.keys()]) if (!store.tabs.has(id)) prev.delete(id);
    primed = true;
  });
}

const lastShown = new Map<string, number>();

async function pageAlert(kind: 'done' | 'needs', tab: string): Promise<void> {
  if (store.demo || !local.on || !canNotify() || Notification.permission !== 'granted') return;
  if (!(kind === 'done' ? local.done : local.needs) || lookingNow() || inQuiet(local.quiet)) return;
  const key = `${kind}:${tab}`;
  if (Date.now() - (lastShown.get(key) ?? 0) < GAP_MS[kind]) return;
  lastShown.set(key, Date.now());
  const t = (store.tabs.get(tab)?.meta.title ?? '').replace(/\s+/g, ' ').trim();
  await show(kind, tab, t.length > 40 ? `${t.slice(0, 39)}…` : t).catch(() => {});
}

async function show(kind: Kind, tab: string, body: string): Promise<void> {
  const tag = tab ? `phosphor-${tab}` : 'phosphor-test';
  const data = { tab, k: kind, at: Date.now(), src: 'page' };
  const reg = !isShell() && 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  if (reg?.active) {
    // Through the service worker (Android allows no other way), so a tap goes to sw.js like a push does.
    // The push for this same moment may already be showing: then this page stays quiet.
    const shown = await reg.getNotifications({ tag }).catch(() => [] as Notification[]);
    const twin = shown.some((n) => (n.data as typeof data | null)?.src === 'push' && n.data.k === kind && Date.now() - (n.data.at ?? 0) < SAME_MS);
    if (twin) return;
    await reg.showNotification(TITLES[kind], { body, tag, icon: '/icons/icon-192.png', data, renotify: true, vibrate: BUZZ[kind] } as NotificationOptions);
    return;
  }
  const n = new Notification(TITLES[kind], { body, tag, icon: '/icons/icon-192.png', data });
  n.onclick = () => {
    window.focus();
    n.close();
    if (tab) openTab(tab);
  };
}

// ---------------------------------------------------------------- push subscription

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new HttpError(r.status === 404 && !data.error ? 'The server update has not loaded yet.' : (data.error ?? `HTTP ${r.status}`), r.status);
  return data;
}

function inTime<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(what)), ms))]);
}

const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

// Subscribe this browser (or send its renewed address) and tell the server. renew: never re-add a removed device.
async function subscribe(renew = false): Promise<void> {
  const reg = await inTime(navigator.serviceWorker.ready, 5000, 'The service worker is not running.');
  const { publicKey } = await api<PushStatusResponse>('/api/push');
  const key = b64urlBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => false); // made for another server key
    sub = null;
  }
  sub ??= await inTime(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }), 20_000, 'The push service did not answer.');
  const { id } = await api<{ id: string }>('/api/push/subscribe', { subscription: sub.toJSON(), id: local.id, renew, prefs: { done: local.done, needs: local.needs, quiet: local.quiet } });
  setLocal({ id, endpoint: sub.endpoint });
}

// On load: the browser may have renewed or dropped its push address since last time.
async function renew(): Promise<void> {
  if (!canPush() || Notification.permission !== 'granted') return;
  try {
    const reg = await inTime(navigator.serviceWorker.ready, 5000, 'no worker');
    const sub = await reg.pushManager.getSubscription();
    if (sub && sub.endpoint === local.endpoint) return;
    await subscribe(true);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404 && /removed/.test(e.message)) setLocal({ on: false, id: null, endpoint: null });
  }
}

async function dropBrowserSub(): Promise<void> {
  if (!canPush()) return;
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  await sub?.unsubscribe().catch(() => false);
}

async function turnOn(): Promise<void> {
  if (!canNotify()) return redraw?.();
  // Ask inside the tap: browsers (Firefox above all) only show the question for a direct tap.
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') {
    setLocal({ on: false });
    pushProblem = '';
    return redraw?.();
  }
  setLocal({ on: true });
  pushProblem = '';
  if (canPush()) {
    note('Turning on…');
    try {
      await subscribe();
    } catch (e) {
      pushProblem = e instanceof Error ? e.message : String(e);
    }
  }
  redraw?.();
  void loadDevices();
}

async function turnOff(): Promise<void> {
  const id = local.id;
  setLocal({ on: false, id: null, endpoint: null });
  pushProblem = '';
  redraw?.();
  if (id) await api('/api/push/unsubscribe', { id }).catch(() => {});
  await dropBrowserSub();
  void loadDevices();
}

function savePrefs(): void {
  redraw?.();
  if (local.id) void api('/api/push/prefs', { id: local.id, done: local.done, needs: local.needs, quiet: local.quiet }).catch((e: Error) => toast(`Alerts: ${e.message}`));
}

async function test(): Promise<void> {
  if (!local.on) return toast('Turn alerts ON first.');
  if (local.id) {
    try {
      await api('/api/push/test', { id: local.id });
      toast('Test sent. It buzzes in a few seconds, even with the app closed.');
    } catch (e) {
      toast(`Test failed: ${e instanceof Error ? e.message : e}`, 7000);
    }
    return;
  }
  // No push on this device: show one here.
  if (canNotify() && Notification.permission === 'granted') await show('test', '', 'Alerts work on this device.').catch((e: Error) => toast(`Test failed: ${e.message}`));
}

// ---------------------------------------------------------------- SETTINGS > ALERTS

let note: (text: string) => void = () => {};
let devices: PushDevice[] | null = null;
let devicesError = '';
let renderDevices: () => void = () => {};

async function loadDevices(): Promise<void> {
  try {
    devices = (await api<PushStatusResponse>('/api/push')).devices;
    devicesError = '';
    // Removed on another device (or the push service said this address is gone): this device is off for push.
    if (local.id && !devices.some((d) => d.id === local.id)) {
      setLocal({ on: false, id: null, endpoint: null });
      await dropBrowserSub();
      redraw?.();
    }
  } catch (e) {
    devicesError = e instanceof Error ? e.message : String(e);
  }
  renderDevices();
}

function blockedHelp(): string {
  const ua = navigator.userAgent;
  if (/Android/.test(ua) && /Firefox\//.test(ua)) {
    return 'BLOCKED by Firefox. Open this address in Firefox, tap the lock left of the address and set Notifications to Allow (or Firefox menu > Settings > Site permissions > Exceptions > this site). Also check Android Settings > Apps > Firefox > Notifications. Then tap ON.';
  }
  if (/Android/.test(ua)) return 'BLOCKED by the browser. Tap the lock left of the address > Permissions > Notifications > Allow. Then tap ON.';
  return 'BLOCKED by the browser. Click the lock left of the address, allow Notifications, then press ON.';
}

function statusText(): string {
  if (!isSecureContext) return 'Alerts need the https address (or localhost).';
  if (!('Notification' in window)) return 'This browser cannot show alerts.';
  if (Notification.permission === 'denied') return blockedHelp();
  if (!local.on) return Notification.permission === 'default' ? 'OFF. ON = a buzz when Claude is done or needs you. The browser asks first.' : 'OFF. ON = a buzz when Claude is done or needs you.';
  if (Notification.permission !== 'granted') return 'Not allowed yet. Press ON and pick Allow.';
  if (isShell()) return 'ON. Alerts show while the desktop app runs, also from the tray.';
  if (pushProblem) return `ON while the app is open. Push failed: ${pushProblem}`;
  if (canPush() && local.id) return 'ON. Buzzes even when the app is closed.';
  return 'ON while the app is open in the background. No push in this browser.';
}

export function alertsSection(): HTMLElement {
  const box = el('div', 'set-alerts');
  const status = el('div', 'alerts-note');
  note = (text) => (status.textContent = text);

  const onBtn = button('ON', () => void turnOn());
  const offBtn = button('OFF', () => void turnOff());
  const testBtn = button('TEST', () => void test());
  testBtn.title = 'Send a test alert to this device';
  const power = el('div', 'seg');
  power.append(onBtn, offBtn, testBtn);

  const doneBtn = button('DONE', () => {
    setLocal({ done: !local.done });
    savePrefs();
  });
  doneBtn.title = 'When Claude finishes a turn';
  const needsBtn = button('NEEDS YOU', () => {
    setLocal({ needs: !local.needs });
    savePrefs();
  });
  needsBtn.title = 'When Claude asks a question or waits for your OK';
  const when = el('div', 'seg alerts-when');
  when.append(doneBtn, needsBtn);

  const from = timeInput('22:00', 'Quiet from');
  const to = timeInput('07:00', 'Quiet until');
  const quietOff = button('OFF', () => {
    setLocal({ quiet: null });
    savePrefs();
  });
  const quietOn = button('ON', () => {
    setLocal({ quiet: { from: from.value || '22:00', to: to.value || '07:00' } });
    savePrefs();
  });
  for (const input of [from, to]) {
    input.onchange = () => {
      if (!local.quiet || !/^\d\d:\d\d$/.test(from.value) || !/^\d\d:\d\d$/.test(to.value)) return;
      setLocal({ quiet: { from: from.value, to: to.value } });
      savePrefs();
    };
  }
  const quietTimes = el('div', 'alerts-quiet');
  quietTimes.append(from, el('span', '', 'TO'), to);
  const quiet = el('div', 'seg');
  quiet.append(quietOff, quietOn);
  const options = el('div', 'alerts-options');
  options.append(el('div', 'set-label', 'ALERT WHEN'), when, el('div', 'set-label', 'QUIET HOURS'), quiet, quietTimes);

  const list = el('div', 'alerts-devices');
  list.hidden = true;
  const devBtn = button('DEVICES ▸', () => {
    list.hidden = !list.hidden;
    devBtn.textContent = list.hidden ? 'DEVICES ▸' : 'DEVICES ▾';
    if (!list.hidden) void loadDevices();
  }, 'alerts-devbtn');
  devBtn.title = 'Every phone and browser that gets push alerts';

  renderDevices = () => {
    if (list.hidden) return;
    if (devicesError) return list.replaceChildren(el('div', 'alerts-note', devicesError));
    if (!devices) return list.replaceChildren(el('div', 'alerts-note', 'Loading…'));
    if (!devices.length) return list.replaceChildren(el('div', 'alerts-note', 'No device gets push alerts yet.'));
    list.replaceChildren(...devices.map(deviceRow));
  };

  const mark = (b: HTMLButtonElement, on: boolean) => {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  };
  redraw = () => {
    const on = local.on && canNotify() && Notification.permission === 'granted';
    mark(onBtn, on);
    mark(offBtn, !on);
    testBtn.disabled = !on;
    mark(doneBtn, local.done);
    mark(needsBtn, local.needs);
    mark(quietOff, !local.quiet);
    mark(quietOn, !!local.quiet);
    if (local.quiet) {
      from.value = local.quiet.from;
      to.value = local.quiet.to;
    }
    quietTimes.hidden = !local.quiet;
    options.hidden = !on;
    status.textContent = statusText();
    status.classList.toggle('alerts-warn', canNotify() && Notification.permission === 'denied');
    renderDevices();
  };
  redraw();

  // The SETTINGS box is built once; refresh when it opens (permission may have changed in the browser meanwhile).
  new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    redraw?.();
    if (!list.hidden || local.id) void loadDevices();
  }).observe(box);

  box.append(el('div', 'set-label', 'ALERTS ON THIS DEVICE'), power, status, options, devBtn, list);
  return box;
}

function timeInput(value: string, label: string): HTMLInputElement {
  const i = el('input', 'alerts-time');
  i.type = 'time';
  i.value = value;
  i.setAttribute('aria-label', label);
  return i;
}

function deviceRow(d: PushDevice): HTMLElement {
  const row = el('div', 'alerts-dev');
  const mine = d.id === local.id;
  const what = [d.prefs.done && 'DONE', d.prefs.needs && 'NEEDS YOU'].filter(Boolean).join(', ') || 'NOTHING';
  const health = d.lastError ? `Problem: ${d.lastError}` : d.lastOkAt ? `Last alert ${timeAgo(d.lastOkAt)}` : `Added ${timeAgo(d.createdAt)}`;
  const info = el('div', 'alerts-dev-info');
  info.append(el('div', 'alerts-dev-name', `${d.label.toUpperCase()}${mine ? ' (THIS)' : ''}`), el('div', 'alerts-dev-meta', `${what}${d.prefs.quiet ? `, QUIET ${d.prefs.quiet.from}-${d.prefs.quiet.to}` : ''}. ${health}`));
  const rename = button('RENAME', () => {
    const label = prompt('Name this device', d.label);
    if (!label?.trim()) return;
    void api('/api/push/prefs', { id: d.id, label: label.trim() })
      .then(() => loadDevices())
      .catch((e: Error) => toast(`Alerts: ${e.message}`));
  });
  const remove = button('REMOVE', () => {
    if (mine) return void turnOff();
    void api('/api/push/unsubscribe', { id: d.id }).then(() => loadDevices());
  });
  remove.title = mine ? 'Stop push alerts on this device' : 'Stop push alerts on that device';
  const btns = el('div', 'alerts-dev-btns');
  btns.append(rename, remove);
  row.append(info, btns);
  return row;
}
