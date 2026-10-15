import type { ClientEvent, ServerEvent } from '../../shared/protocol.ts';
import { store } from './store.ts';
import { toast } from './ui.ts';

let ws: WebSocket | undefined;
let retryMs = 500;
let retryTimer = 0;
let hiddenAt = 0;
// Relink timing after the page comes back (phone screen on), sent once to data/voice-diag.log to see where time goes.
let woke: { at: number; hiddenMs: number; was: string } | null = null;
const myReqs = new Set<string>();
let demoHandler: ((ev: ClientEvent) => void) | undefined;

// After this long in the background (phone screen off), the old socket may be dead without knowing it:
// open a fresh one when the page comes back, and swap it in once it works (no OFFLINE flash).
const STALE_AFTER_MS = 15_000;

export function connect(): void {
  clearTimeout(retryTimer);
  const old = ws;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    retryMs = 500;
    if (old && old !== sock) {
      old.onclose = null;
      old.close();
    }
    store.connected = true;
    store.emit({ kind: 'connection' });
    if (woke) {
      const w = woke;
      woke = null;
      void fetch('/api/voice/diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: 'relink', hiddenMs: w.hiddenMs, was: w.was, openMs: Date.now() - w.at }),
      }).catch(() => {});
    }
  };
  sock.onmessage = (e) => {
    if (ws === sock) apply(JSON.parse(e.data) as ServerEvent);
  };
  sock.onclose = () => {
    if (ws !== sock) return; // a newer socket took over
    store.connected = false;
    store.emit({ kind: 'connection' });
    // If the login cookie expired, go to the login page instead of retrying forever.
    fetch('/', { redirect: 'manual' })
      .then((r) => {
        if (r.type === 'opaqueredirect') location.href = '/login.html';
      })
      .catch(() => {});
    retryTimer = window.setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 10000);
  };
}

// Phone back from the background, or network back: reconnect now instead of after the retry wait
// (which grows to 10 s while the screen is off).
function wake(): void {
  if (demoHandler || document.hidden) return;
  const hiddenMs = hiddenAt ? Date.now() - hiddenAt : 0;
  const stale = hiddenMs > STALE_AFTER_MS;
  hiddenAt = 0;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN && !stale) return;
  woke = { at: Date.now(), hiddenMs, was: ws?.readyState === WebSocket.OPEN ? 'stale' : 'closed' };
  retryMs = 500;
  connect();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else wake();
});
window.addEventListener('online', wake);
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    hiddenAt ||= 1; // restored from the back/forward cache: the socket is surely stale
    wake();
  }
});

export function send(ev: ClientEvent): void {
  if (demoHandler) return demoHandler(ev);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
  else toast('Not connected. Retrying…');
}

// New tab / open old chat: switch to the tab when the server answers this request.
export function newReq(): string {
  const req = Math.random().toString(36).slice(2);
  myReqs.add(req);
  return req;
}

export function useDemo(handler: (ev: ClientEvent) => void): void {
  demoHandler = handler;
}

export function apply(ev: ServerEvent): void {
  switch (ev.t) {
    case 'hello': {
      store.tabs = new Map(ev.tabs.map((t) => [t.meta.id, t]));
      const want = store.active && store.tabs.has(store.active) ? store.active : store.savedActive();
      store.active = null;
      store.emit({ kind: 'tabs' });
      store.setActive(want && store.tabs.has(want) ? want : (ev.tabs[0]?.meta.id ?? null));
      return;
    }
    case 'tab': {
      store.tabs.set(ev.tab.meta.id, ev.tab);
      store.emit({ kind: 'tabs' });
      store.emit({ kind: 'reset', tab: ev.tab.meta.id });
      if (ev.req && myReqs.delete(ev.req)) store.setActive(ev.tab.meta.id);
      return;
    }
    case 'tab_closed': {
      const ids = [...store.tabs.keys()];
      const idx = ids.indexOf(ev.tab);
      store.tabs.delete(ev.tab);
      store.emit({ kind: 'tabs' });
      if (store.active === ev.tab) {
        const rest = [...store.tabs.keys()];
        store.setActive(rest[Math.min(idx, rest.length - 1)] ?? null);
      }
      return;
    }
    case 'item': {
      const tab = store.tabs.get(ev.tab);
      if (!tab) return;
      tab.items.push(ev.item);
      store.emit({ kind: 'item', tab: ev.tab, item: ev.item, op: 'add' });
      return;
    }
    case 'update': {
      const tab = store.tabs.get(ev.tab);
      if (!tab) return;
      const i = tab.items.findIndex((x) => x.id === ev.item.id);
      if (i >= 0) tab.items[i] = ev.item;
      store.emit({ kind: 'item', tab: ev.tab, item: ev.item, op: 'update' });
      return;
    }
    case 'delta': {
      const item = store.tabs.get(ev.tab)?.items.find((x) => x.id === ev.id);
      if (item?.kind !== 'claude') return;
      item.text += ev.text;
      store.emit({ kind: 'delta', tab: ev.tab, id: ev.id, text: ev.text });
      return;
    }
    case 'patch': {
      const tab = store.tabs.get(ev.tab);
      if (!tab) return;
      (tab as Record<string, unknown>)[ev.key] = ev.value;
      store.emit({ kind: 'patch', tab: ev.tab, key: ev.key });
      if (ev.key === 'meta') store.emit({ kind: 'tabs' });
      return;
    }
    case 'toast':
      toast(ev.text);
      return;
    case 'sdk_update':
      store.emit({ kind: 'sdk_update', state: ev.state });
      return;
    case 'undo_result':
      store.emit({ kind: 'undo', result: ev });
      return;
  }
}
