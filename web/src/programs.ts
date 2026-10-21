import { currentProgram, focusAddress, mountBrowser, open, refresh, saveSites, setBlocked, setState, webState } from './browser.ts';
import { closeDocs, isDocsOpen, onDocsToggle, openDocs } from './docs.ts';
import type { App, PhosphorShell, Site } from './shellapi.ts';
import { shellApi } from './shellapi.ts';
import { siteBox } from './sitebox.ts';
import { store, working } from './store.ts';
import { button, el, toast } from './ui.ts';

// Program bar (desktop app only): CHAT, the owner's apps, then saved sites. CHAT is the normal app.
// Apps are real programs on the PC (WEB = Firefox, DISCORD = the Discord app): a button brings that program to
// the front (Ctrl+Alt+R comes back). Sites show in the web pane (browser.ts).
// In a normal browser and on the phone nothing here runs.
// Keys: Ctrl+1..9 button N (1 CHAT, then apps, then sites); on a site Ctrl+L goes to the address.
// The shell sends the same keys when a site has the keyboard.

const MAX_SITES = 20; // same as shell/web.mjs

let nav: HTMLElement;
let api: PhosphorShell;
let chatBtn: HTMLButtonElement;
let docsBtn: HTMLButtonElement;
let addBtn: HTMLButtonElement;
let barKey = '';
const siteBtns = new Map<string, HTMLButtonElement>();

export function mountPrograms(navEl: HTMLElement, pane: HTMLElement): void {
  if (!shellApi) return;
  api = shellApi;
  nav = navEl;
  document.body.classList.add('has-shell');
  nav.hidden = false;

  chatBtn = button('CHAT', () => void open('chat'), 'prog prog-chat');
  chatBtn.prepend(el('span', 'prog-mark'));
  chatBtn.title = 'Chat with Claude (Ctrl+1)';
  // DOCS (docs.ts) sits next to CHAT; it has no Ctrl+number, so the others keep theirs.
  docsBtn = button('DOCS', () => (isDocsOpen() ? closeDocs() : openDocs()), 'prog prog-docs');
  docsBtn.title = 'Documents: notes, letters, lists';
  onDocsToggle(renderBar);
  // CHAT and sites leave DOCS (capture: before their own click). Apps don't: the page stays as it is behind them.
  nav.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('.prog');
    if (b && b !== docsBtn && !b.matches('.prog-app, .prog-add')) closeDocs();
  }, true);
  addBtn = button('+', () => void editSite(null), 'prog prog-add');
  addBtn.title = 'Add a site to this bar';

  mountBrowser(pane, api, { changed: renderBar, pin: (title, url) => void editSite(null, { name: title.slice(0, 24), url }) });
  renderBar();
  void refresh().then(renderBar);
  api.onChange(setState);
  api.onCommand(command);

  // Claude waits for your OK, or works, in a chat tab: show it on CHAT.
  const badge = () => {
    const tabs = [...store.tabs.values()];
    const attention = tabs.some((t) => t.meta.attention);
    chatBtn.classList.toggle('attention', attention);
    chatBtn.classList.toggle('busy', !attention && tabs.some(working));
  };
  store.on((c) => (c.kind === 'tabs' || (c.kind === 'patch' && c.key === 'agents')) && badge());
  badge();

  // Picking a chat (tab bar, + or HISTORY) goes back to CHAT.
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tab-label, .tab-add')) void open('chat');
  });
  document.getElementById('history')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.history-row')) void open('chat');
  });

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    const p = currentProgram();
    if (/^[1-9]$/.test(k)) pick(Number(k));
    else if (k === 'l' && p !== 'chat') focusAddress();
    else return;
    e.preventDefault();
  });

  watchOverlays();
}

// For the launcher: the bar's buttons in bar order (CHAT, apps, sites), each with what its button does.
// Empty outside the desktop app.
export type ProgramItem = { id: string; name: string; kind: 'chat' | 'app' | 'site'; run: () => void };
export function programList(): ProgramItem[] {
  if (!api) return [];
  const { apps, sites } = webState();
  return [
    { id: 'chat', name: 'Chat', kind: 'chat', run: () => void open('chat') },
    ...apps.map((a): ProgramItem => ({ id: a.id, name: a.name, kind: 'app', run: () => void launch(a) })),
    ...sites.map((s): ProgramItem => ({ id: s.id, name: s.name, kind: 'site', run: () => void open(s.id) })),
  ];
}

// Back to CHAT (the launcher picked a chat, a slash command or ASK CLAUDE). Nothing to do outside the desktop app.
export function showChat(): void {
  if (api && currentProgram() !== 'chat') void open('chat');
}

function command(c: string): void {
  if (c.startsWith('program:')) pick(Number(c.slice(8)));
  else if (c === 'focus-address') focusAddress();
  else if (c === 'docs') openDocs(); // the desktop app started with --docs ("Phosphor Docs" in the app menu)
  else if (c.startsWith('docs-open:')) openDocs(c.slice(10)); // --docs <file>: a file double-clicked on the PC
  else if (c.startsWith('docs-error:')) {
    openDocs();
    toast(c.slice(11), 8000);
  }
}

// 1 = CHAT, then the apps, then the saved sites, in bar order.
function pick(n: number): void {
  if (n === 1 || n - 2 >= webState().apps.length) closeDocs(); // CHAT or a site
  if (n === 1) return void open('chat');
  const { apps, sites } = webState();
  const app = apps[n - 2];
  if (app) return void launch(app);
  const site = sites[n - 2 - apps.length];
  if (site) void open(site.id);
}

// Bring the real program to the front (or start it). This page stays as it is behind it.
async function launch(a: App): Promise<void> {
  const r = await api.launch(a.id);
  if (r === 'failed') toast(`Could not open ${a.name}.`);
}

// App and site buttons are remade only when the lists change (a redraw under the mouse can eat a click).
function renderBar(): void {
  const { apps, sites, tabs } = webState();
  const key = JSON.stringify([apps, sites]);
  if (key !== barKey) {
    barKey = key;
    siteBtns.clear();
    const keyHint = (i: number) => (i < 8 ? ` (Ctrl+${i + 2})` : '');
    const appBtns = apps.map((a, i) => {
      const b = button(a.name, () => void launch(a), 'prog prog-app');
      b.title = `${a.name}: switch to the program on this PC${keyHint(i)}\nCtrl+Alt+R comes back here. Right-click to rename or remove.`;
      b.oncontextmenu = (e) => {
        e.preventDefault();
        void editApp(a);
      };
      return b;
    });
    const btns = sites.map((s, i) => {
      const b = button(s.name, () => void open(s.id), 'prog prog-site');
      b.title = `${s.name}\n${s.url}\nRight-click to edit${keyHint(apps.length + i)}`;
      b.oncontextmenu = (e) => {
        e.preventDefault();
        void editSite(s);
      };
      siteBtns.set(s.id, b);
      return b;
    });
    addBtn.disabled = sites.length >= MAX_SITES;
    nav.replaceChildren(chatBtn, docsBtn, ...appBtns, ...btns, addBtn);
  }
  const p = currentProgram();
  chatBtn.classList.toggle('on', p === 'chat' && !isDocsOpen());
  docsBtn.classList.toggle('on', isDocsOpen());
  for (const [id, b] of siteBtns) {
    b.classList.toggle('on', p === id);
    b.classList.toggle('audible', tabs.some((t) => t.owner === id && t.audible));
  }
}

// Rename or remove an app button. (Which program it opens is set in the desktop app; its tray menu brings
// removed Web and Discord buttons back.)
async function editApp(a: App): Promise<void> {
  const r = await siteBox('EDIT BUTTON', { name: a.name, url: '' }, true, true);
  if (!r) return;
  const apps = webState().apps;
  api.setApps(r === 'remove' ? apps.filter((x) => x.id !== a.id) : apps.map((x) => (x.id === a.id ? { ...x, name: r.name } : x)));
}

// Add (site null), change or remove a saved site. PIN passes the page's title and address to start from.
async function editSite(site: Site | null, start?: { name: string; url: string }): Promise<void> {
  if (!site && webState().sites.length >= MAX_SITES) return void toast(`The bar holds ${MAX_SITES} sites. Remove one first.`);
  const heading = site ? 'EDIT SITE' : start ? 'PIN THIS PAGE' : 'ADD A SITE';
  const r = await siteBox(heading, site ?? start ?? { name: '', url: '' }, !!site);
  if (!r) return;
  const sites = webState().sites; // may have changed while the box was open
  if (r === 'remove') saveSites(sites.filter((s) => s.id !== site!.id));
  else if (site) saveSites(sites.map((s) => (s.id === site.id ? { ...s, ...r } : s)));
  else saveSites([...sites, { id: `site-${Math.random().toString(36).slice(2, 10)}`, ...r }]);
}

// Sites are drawn above the page, so they would hide any page overlay. While one is open, the site hides.
// Watches only these targets: the chat streams into the page, so a whole-page observer would fire constantly.
function watchOverlays(): void {
  const drawers = ['history', 'mcp', 'usage', 'station'].map((id) => document.getElementById(id)).filter((d) => d !== null);
  const settings = document.getElementById('settings');
  const isOpen = () =>
    document.body.classList.contains('menu-open') ||
    document.body.classList.contains('docs-open') ||
    drawers.some((d) => !d.hidden) ||
    !!document.querySelector('dialog[open], .settings-pop:not([hidden]), body > .fx-overlay');
  const watchDialogs = () => {
    for (const d of document.querySelectorAll('dialog')) mo.observe(d, { attributes: true, attributeFilter: ['open'] });
  };
  const mo = new MutationObserver((records) => {
    if (records.some((r) => r.type === 'childList')) watchDialogs(); // a box was added (confirmBox, site box)
    setBlocked(isOpen());
  });
  mo.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true });
  for (const d of drawers) mo.observe(d, { attributes: true, attributeFilter: ['hidden'] });
  if (settings) mo.observe(settings, { attributes: true, attributeFilter: ['hidden'], subtree: true });
  watchDialogs();
  setBlocked(isOpen());
}
