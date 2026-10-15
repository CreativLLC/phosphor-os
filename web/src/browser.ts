import type { PhosphorShell, Site, WebAction, WebState, WebTab } from './shellapi.ts';
import { button, el, toast } from './ui.ts';

// The WEB browser and saved-site pane (desktop app only). The sites themselves are drawn by the desktop
// app (shell/web.mjs) ON TOP of this page, inside the empty "slot" under the toolbar. This file draws the
// toolbar and the WEB tab strip, and tells the shell where the slot is whenever that changes.
// Program = 'chat', 'web' or a saved site's id. programs.ts draws the bar and switches programs.

type Opts = { changed: () => void; pin: (title: string, url: string) => void };

let api: PhosphorShell;
let opts: Opts;
let state: WebState = { apps: [], sites: [], tabs: [] };
let program = 'chat';
let webTab: string | null = null; // the WEB tab on show
let lastIndex = 0; // its place in the strip, to pick a neighbor when it closes
let blocked = false; // a page overlay is open: no site may cover it
let sent = ''; // last show() sent: "tab x y w h", '' = none shown
let editing = false; // the address was typed into and not sent yet

let pane: HTMLElement;
let addr: HTMLInputElement;
let backBtn: HTMLButtonElement;
let fwdBtn: HTMLButtonElement;
let reloadBtn: HTMLButtonElement;
let homeBtn: HTMLButtonElement;
let pinBtn: HTMLButtonElement;
let outBtn: HTMLButtonElement;
let strip: HTMLElement;
let addTabBtn: HTMLButtonElement;
let slot: HTMLElement;
let empty: HTMLElement;
let stripIds: string | null = null; // tab ids in the strip now
let stripOn: string | null = null; // tab scrolled into view last
const tabEls = new Map<string, { box: HTMLElement; title: HTMLElement; sound: HTMLElement }>();

export const currentProgram = (): string => program;
export const webState = (): WebState => state;

export function mountBrowser(root: HTMLElement, shell: PhosphorShell, o: Opts): void {
  api = shell;
  opts = o;
  pane = root;
  backBtn = button('BACK', () => act('back'));
  backBtn.title = 'Back (Alt+Left)';
  fwdBtn = button('FWD', () => act('forward'));
  fwdBtn.title = 'Forward (Alt+Right)';
  reloadBtn = button('RELOAD', () => act(current()?.loading ? 'stop' : 'reload'), 'web-reload');
  homeBtn = button('HOME', () => act('home'));
  homeBtn.title = "Back to this site's own address";
  addr = el('input', 'web-addr');
  addr.type = 'text';
  addr.placeholder = 'Address or search words';
  addr.spellcheck = false;
  addr.autocomplete = 'off';
  addr.setAttribute('aria-label', 'Address');
  addr.title = 'Address or search words, then Enter (Ctrl+L)';
  pinBtn = button('PIN', () => {
    const t = current();
    if (t?.url) opts.pin(t.title, t.url);
  });
  pinBtn.title = 'Add this page to the program bar';
  outBtn = button('OPEN OUTSIDE', () => act('outside'));
  outBtn.title = 'Open this page in your normal browser';
  const bar = el('div', 'web-bar');
  bar.append(backBtn, fwdBtn, reloadBtn, homeBtn, addr, pinBtn, outBtn);

  strip = el('div', 'web-tabs');
  addTabBtn = button('+', () => void newTab(), 'tab-add');
  addTabBtn.title = 'New tab (Ctrl+T)';
  slot = el('div', 'web-slot');
  empty = el('div', 'web-empty');
  slot.append(empty);
  pane.replaceChildren(bar, strip, slot);

  addr.addEventListener('input', () => (editing = true));
  addr.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void go(addr.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      editing = false;
      addr.value = current()?.url ?? '';
      addr.select();
    }
  });

  // The slot moves or changes size: tell the shell. No polling.
  new ResizeObserver(() => place()).observe(slot);
  addEventListener('resize', () => place());
  // A site may still cover the page from before a reload.
  api.show(null, null);
}

export async function refresh(): Promise<void> {
  const s = await api.state();
  if (s) state = { ...s, apps: s.apps ?? [] };
}

// A push from the shell: titles, addresses, loading, tabs opened or closed.
export function setState(s: WebState): void {
  state = { ...s, apps: s.apps ?? [] };
  if (isSite(program) && !s.sites.some((x) => x.id === program)) return void open('chat');
  render();
  place();
  opts.changed();
}

export function setBlocked(b: boolean): void {
  if (b === blocked) return;
  blocked = b;
  place();
}

// Switch program. focus: give the keyboard to the site (or to the address, for an empty WEB tab).
export async function open(p: string, focus = true): Promise<void> {
  if (isSite(p) && !state.sites.some((s) => s.id === p)) return;
  program = p;
  editing = false;
  document.body.classList.toggle('prog-web', p !== 'chat');
  pane.hidden = p === 'chat';
  opts.changed();
  if (p === 'chat') return place();
  if (isSite(p) && !state.tabs.some((t) => t.owner === p)) {
    render(); // "CONNECTING" until the shell has made the site's tab
    const id = await api.site(p);
    await refresh();
    if (program !== p) return;
    if (!id) toast('Could not open that site. Close a few WEB tabs and try again.');
  }
  render();
  focusIn(focus);
}

export async function newTab(): Promise<void> {
  const id = await api.newTab('');
  if (!id) return void toast('Too many tabs. Close one first.');
  await refresh();
  webTab = id;
  await open('web');
}

export function closeTab(id = webTab): void {
  const tabs = webTabs();
  const i = tabs.findIndex((t) => t.id === id);
  if (!id || i < 0) return;
  api.act(id, 'close');
  state = { ...state, tabs: state.tabs.filter((t) => t.id !== id) };
  if (webTab === id) {
    const rest = webTabs();
    webTab = rest[Math.min(i, rest.length - 1)]?.id ?? null;
    editing = false;
  }
  if (program !== 'web') return;
  render();
  focusIn(true);
}

// A site opened a link in a new tab, or a tab was clicked.
export async function showTab(id: string): Promise<void> {
  if (!state.tabs.some((t) => t.id === id)) await refresh();
  webTab = id;
  await open('web');
}

export function focusAddress(): void {
  if (program === 'chat') return;
  window.focus(); // the keyboard may be in a site
  addr.focus();
  addr.select();
}

export function saveSites(sites: Site[]): void {
  api.setSites(sites);
  state = { ...state, sites };
  if (isSite(program) && !sites.some((s) => s.id === program)) return void open('chat');
  render();
  opts.changed();
}

// ------------------------------------------------------------ inside

const isSite = (p: string) => p !== 'chat' && p !== 'web';
const webTabs = () => state.tabs.filter((t) => t.owner === 'web');

function current(): WebTab | undefined {
  if (program === 'web') return state.tabs.find((t) => t.id === webTab && t.owner === 'web');
  if (isSite(program)) return state.tabs.find((t) => t.owner === program);
  return undefined;
}

function act(a: WebAction): void {
  const t = current();
  if (t) api.act(t.id, a);
}

function tabTitle(t: WebTab): string {
  if (t.title) return t.title;
  try {
    return new URL(t.url).host || 'NEW TAB';
  } catch {
    return 'NEW TAB';
  }
}

// Enter in the address: go there in this tab, or in a new WEB tab when there is none.
async function go(text: string): Promise<void> {
  if (!text.trim()) return;
  let id = current()?.id;
  if (!id) {
    if (program !== 'web') return;
    id = (await api.newTab('')) ?? undefined;
    if (!id) return void toast('Too many tabs. Close one first.');
    webTab = id;
  }
  editing = false;
  api.navigate(id, text);
  await refresh();
  addr.blur();
  render();
  focusIn(true);
}

// Site shown: it gets the keyboard. Empty WEB tab: the address does.
function focusIn(focus: boolean): void {
  if (current()?.url) return place(focus);
  place();
  if (focus && program === 'web') focusAddress();
}

function render(): void {
  if (program === 'chat') return;
  const web = program === 'web';
  if (web && !webTabs().some((t) => t.id === webTab)) {
    const tabs = webTabs();
    webTab = tabs[Math.min(lastIndex, tabs.length - 1)]?.id ?? null;
  }
  const t = current();
  backBtn.disabled = !t?.canBack;
  fwdBtn.disabled = !t?.canForward;
  reloadBtn.textContent = t?.loading ? 'STOP' : 'RELOAD';
  reloadBtn.title = t?.loading ? 'Stop loading' : 'Reload (Ctrl+R)';
  reloadBtn.disabled = !t?.url;
  homeBtn.hidden = web;
  pinBtn.hidden = !web;
  pinBtn.disabled = !t?.url;
  outBtn.disabled = !t?.url;
  if (!editing) addr.value = t?.url ?? '';
  strip.hidden = !web;
  if (web) renderStrip();
  empty.hidden = !!t?.url;
  empty.textContent = web ? 'TYPE AN ADDRESS OR SEARCH WORDS ABOVE, THEN PRESS ENTER.\nCTRL+T NEW TAB · CTRL+L ADDRESS · CTRL+1 CHAT' : 'CONNECTING…';
}

// Tabs are kept and updated in place, so a click is never lost to a redraw while pages load.
function renderStrip(): void {
  const tabs = webTabs();
  const ids = tabs.map((t) => t.id).join(' ');
  if (ids !== stripIds) {
    stripIds = ids;
    for (const id of tabEls.keys()) if (!tabs.some((t) => t.id === id)) tabEls.delete(id);
    strip.replaceChildren(...tabs.map((t) => tabEl(t.id).box), addTabBtn);
  }
  tabs.forEach((t, i) => {
    const e = tabEl(t.id);
    e.box.classList.toggle('on', t.id === webTab);
    e.box.classList.toggle('loading', t.loading);
    e.title.textContent = tabTitle(t);
    e.box.title = `${t.title}\n${t.url}`.trim();
    e.sound.hidden = !t.audible;
    if (t.id === webTab) lastIndex = i;
  });
  if (stripOn !== webTab) strip.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  stripOn = webTab;
}

function tabEl(id: string) {
  let e = tabEls.get(id);
  if (e) return e;
  const box = el('div', 'tab web-tab');
  const label = el('button', 'tab-label');
  label.type = 'button';
  const sound = el('span', 'web-sound', '♪');
  sound.title = 'Playing sound';
  const title = el('span', 'tab-title');
  label.append(el('span', 'tab-dot'), sound, title);
  label.onclick = () => void showTab(id);
  label.onauxclick = (ev) => ev.button === 1 && closeTab(id);
  const close = button('×', () => closeTab(id), 'tab-close');
  close.title = 'Close tab (Ctrl+W)';
  box.append(label, close);
  e = { box, title, sound };
  tabEls.set(id, e);
  return e;
}

// Tell the shell where the site goes, only when the tab or the slot actually changed.
function place(focus = false): void {
  const t = program === 'chat' || blocked ? undefined : current();
  const r = t?.url ? slot.getBoundingClientRect() : null;
  if (!t || !r || r.width < 1 || r.height < 1) {
    if (sent) api.show(null, null);
    sent = '';
    return;
  }
  const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  const key = `${t.id} ${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
  if (key === sent && !focus) return;
  api.show(t.id, rect, focus);
  sent = key;
}
