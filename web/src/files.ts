import type { FileEntry, FileReadResponse, FilesListResponse, TabState } from '../../shared/protocol.ts';
import { shellApi } from './shellapi.ts';
import { store, watchActive } from './store.ts';
import { button, el, folderName, shortPath, toast } from './ui.ts';

// Right panel FILES view: browse the active tab's folder, read-only.
// Tree loads folders lazily; files open in a big overlay viewer.
// Server API: /api/files/list|read|raw (server/files.ts).

type Opts = { insertIntoChat: (text: string) => void };
type ListResp = FilesListResponse & { total?: number };
type Dir = { status: 'loading' } | { status: 'ok'; entries: FileEntry[]; total: number } | { status: 'error'; error: string };

// Per-tab memory (this page session only).
type TabFx = {
  id: string;
  cwd: string;
  gen: number; // bumps on refresh, so late answers from before it are dropped
  dirs: Map<string, Dir>;
  expanded: Set<string>;
  changedOpen: boolean;
  showAllChanged: boolean;
  stale: boolean; // something changed while the panel was hidden
};

const CHANGED_SHOWN = 8;
const LRM = String.fromCharCode(0x200e);
const WIN_LIKE = true; // compare paths without case, as Windows does

let opts: Opts;
let root: HTMLElement;
const perTab = new Map<string, TabFx>();
let fx: TabFx | null = null;
let tab: TabState | undefined;
let changedKey = '';
let lastTurnStart: number | null = null;
let renderQueued = false;
let refreshing = 0;

export function mountFiles(rootEl: HTMLElement, o: Opts): void {
  root = rootEl;
  opts = o;
  root.classList.add('fx');

  watchActive(['info', 'stats'], (t) => {
    tab = t;
    const id = t?.meta.id ?? null;
    const cwd = t?.info.cwd ?? '';
    if (id !== fx?.id || cwd !== fx?.cwd) {
      fx = id ? getFx(id, cwd) : null;
      changedKey = changedKeyOf(t);
      lastTurnStart = t?.stats.turnStartedAt ?? null;
      if (fx?.dirs.size) quietRefresh(); // back on a tab seen before: its folders may have changed meanwhile
      render();
      return;
    }
    // Same tab: stats or info changed.
    const key = changedKeyOf(t);
    if (key !== changedKey) {
      const before = new Set(changedKey ? changedKey.split('\n') : []);
      changedKey = key;
      reloadParentsOf(t!.stats.filesChanged.filter((p) => !before.has(p)));
      render();
    }
    const turnStart = t?.stats.turnStartedAt ?? null;
    if (lastTurnStart !== null && turnStart === null) quietRefresh(); // a turn just ended: Bash may have made files
    lastTurnStart = turnStart;
    viewerStatsChanged();
  });

  // Forget closed tabs.
  store.on((c) => {
    if (c.kind !== 'tabs') return;
    for (const id of perTab.keys()) if (!store.tabs.has(id)) perTab.delete(id);
  });

  // The panel starts hidden behind MISSION. Load when it is first shown.
  new MutationObserver(() => {
    if (root.hidden) return;
    if (fx?.stale) quietRefresh();
    render();
  }).observe(root, { attributes: true, attributeFilter: ['hidden'] });
}

function getFx(id: string, cwd: string): TabFx {
  let f = perTab.get(id);
  if (!f || f.cwd !== cwd) {
    f = { id, cwd, gen: 0, dirs: new Map(), expanded: new Set(), changedOpen: true, showAllChanged: false, stale: false };
    perTab.set(id, f);
  }
  return f;
}

const changedKeyOf = (t: TabState | undefined) => (t?.stats.filesChanged ?? []).join('\n');
const visible = () => !root.hidden;

// ---- paths ----

const fold = (p: string) => (WIN_LIKE ? p.toLowerCase() : p);

// Relative path inside the tab folder, or null when the file is outside it.
function relOf(abs: string, cwd: string): string | null {
  const s = shortPath(abs, cwd);
  return /^([a-z]:|\/)/i.test(s) ? null : s;
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function changedSets(): { files: Set<string>; dirs: Set<string> } {
  const files = new Set<string>();
  const dirs = new Set<string>();
  if (!tab || !fx) return { files, dirs };
  for (const abs of tab.stats.filesChanged) {
    const rel = relOf(abs, fx.cwd);
    if (rel === null) continue;
    files.add(fold(rel));
    for (let p = parentOf(rel); p; p = parentOf(p)) dirs.add(fold(p));
  }
  return { files, dirs };
}

function atRef(rel: string, dir = false): string {
  const p = dir ? `${rel}/` : rel;
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

function insert(rel: string, dir = false): void {
  opts.insertIntoChat(atRef(rel, dir));
  document.body.classList.remove('show-right'); // folded phone: show the message box
}

// ---- server ----

async function api<T>(action: 'list' | 'read', tabId: string, path: string): Promise<T> {
  const r = await fetch(`/api/files/${action}?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent(path)}`, { cache: 'no-store' });
  let body: { error?: string } | null = null;
  try {
    body = await r.json();
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new Error(r.status === 401 ? 'Login needed. Reload the page.' : (body?.error ?? `Error ${r.status}`));
  return body as T;
}

// Load one folder. quiet = keep showing the old list until the new one arrives.
function loadDir(f: TabFx, path: string, quiet = false): Promise<void> {
  if (store.demo) return Promise.resolve();
  const gen = f.gen;
  if (!quiet || !f.dirs.has(path)) f.dirs.set(path, { status: 'loading' });
  return api<ListResp>('list', f.id, path)
    .then((r): Dir => ({ status: 'ok', entries: r.entries, total: r.total ?? r.entries.length }))
    .catch((e): Dir => ({ status: 'error', error: e instanceof Error ? e.message : String(e) }))
    .then((d) => {
      if (f.gen !== gen || perTab.get(f.id) !== f) return;
      // A quiet reload that fails keeps the old list.
      if (quiet && d.status === 'error' && f.dirs.get(path)?.status === 'ok') return;
      f.dirs.set(path, d);
      if (f === fx) queueRender();
    });
}

// Folders that are open on screen right now (root plus expanded ones whose parents are open).
function openDirs(f: TabFx): string[] {
  const out = [''];
  const walk = (path: string) => {
    const d = f.dirs.get(path);
    if (d?.status !== 'ok') return;
    for (const e of d.entries) {
      if (e.dir && f.expanded.has(e.path)) {
        out.push(e.path);
        walk(e.path);
      }
    }
  };
  walk('');
  return out;
}

// Reload what is on screen without flashing; drop the rest of the cache.
function quietRefresh(): void {
  const f = fx;
  if (!f || store.demo) return;
  if (!visible()) {
    f.stale = true;
    return;
  }
  f.stale = false;
  const keep = openDirs(f);
  for (const p of [...f.dirs.keys()]) if (!keep.includes(p)) f.dirs.delete(p);
  f.gen++;
  refreshing++;
  updateRefreshBtn();
  Promise.all(keep.map((p) => loadDir(f, p, true))).finally(() => {
    refreshing--;
    updateRefreshBtn();
  });
}

// Claude wrote new files: reload their loaded parent folders.
function reloadParentsOf(absPaths: string[]): void {
  const f = fx;
  if (!f || store.demo || !absPaths.length) return;
  if (!visible()) {
    f.stale = true;
    return;
  }
  const dirs = new Set<string>();
  for (const abs of absPaths) {
    const rel = relOf(abs, f.cwd);
    if (rel === null) continue;
    for (let p = parentOf(rel); ; p = parentOf(p)) {
      if (f.dirs.get(p)?.status === 'ok') dirs.add(p);
      if (!p) break;
    }
  }
  for (const d of dirs) void loadDir(f, d, true);
}

// ---- panel ----

function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

let refreshBtn: HTMLButtonElement | null = null;
function updateRefreshBtn(): void {
  if (!refreshBtn) return;
  refreshBtn.classList.toggle('fx-busy', refreshing > 0);
  refreshBtn.textContent = refreshing > 0 ? 'LOADING' : 'REFRESH';
}

function render(): void {
  if (!visible()) return;
  const keepScroll = root.scrollTop;
  const focusPath = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.fx [data-path]')?.dataset.path;

  if (!tab || !fx) {
    root.replaceChildren(el('div', 'fx-msg', 'No chat tab open.'));
    return;
  }

  const head = el('div', 'fx-head');
  const title = el('div', 'fx-title');
  title.append(el('div', 'fx-folder', `[DIR] ${folderName(fx.cwd).toUpperCase()}`), el('div', 'fx-cwd', fx.cwd));
  title.title = fx.cwd;
  refreshBtn = button('REFRESH', () => {
    if (store.demo) return toast('Files need a real chat tab.');
    quietRefresh();
  }, 'fx-refresh');
  refreshBtn.title = 'Reload the folders shown';
  updateRefreshBtn();
  head.append(title, refreshBtn);

  const parts: HTMLElement[] = [head];
  const changed = renderChanged();
  if (changed) parts.push(changed);

  if (store.demo) {
    const m = el('div', 'fx-msg');
    m.append(el('div', 'fx-msg-big', 'FILES NEED A REAL CHAT TAB.'), el('div', '', 'Demo mode has no real folder to show. Open the app without ?demo=1 to browse files.'));
    parts.push(m);
  } else {
    const tree = el('div', 'fx-tree');
    tree.setAttribute('role', 'tree');
    tree.setAttribute('aria-label', `Files in ${folderName(fx.cwd)}`);
    if (changed) tree.append(el('div', 'fx-sec-label', 'ALL FILES'));
    const sets = changedSets();
    renderDir(tree, fx, '', 0, sets);
    parts.push(tree);
  }

  root.replaceChildren(...parts);
  root.scrollTop = keepScroll;
  if (focusPath !== undefined) root.querySelector<HTMLElement>(`[data-path="${CSS.escape(focusPath)}"] .fx-main`)?.focus({ preventScroll: true });
}

function renderChanged(): HTMLElement | null {
  if (!tab || !fx) return null;
  const list = [...tab.stats.filesChanged].reverse(); // newest first
  if (!list.length) return null;
  const f = fx;
  const sec = el('div', 'fx-changed');
  const headBtn = button(`${f.changedOpen ? '[-]' : '[+]'} CHANGED BY CLAUDE (${list.length})`, () => {
    f.changedOpen = !f.changedOpen;
    render();
  }, 'fx-sec-head');
  headBtn.setAttribute('aria-expanded', String(f.changedOpen));
  sec.append(headBtn);
  if (!f.changedOpen) return sec;

  const shown = f.showAllChanged ? list : list.slice(0, CHANGED_SHOWN);
  for (const abs of shown) {
    const rel = relOf(abs, f.cwd);
    const shownPath = rel ?? shortPath(abs, f.cwd);
    const slash = shownPath.lastIndexOf('/');
    const row = el('div', 'fx-row fx-chg' + (rel === null ? ' fx-outside' : ''));
    const main = el('button', 'fx-main');
    main.type = 'button';
    main.title = rel === null ? `${abs}\nOutside this tab's folder` : rel;
    // The folder part is cut from the left (CSS rtl); the LRM marks keep its slashes in place.
    const where = slash > 0 ? `${LRM}${shownPath.slice(0, slash + 1)}${LRM}` : '';
    main.append(el('span', 'fx-glyph', ' * '), el('span', 'fx-name', shownPath.slice(slash + 1)), el('span', 'fx-where', where));
    main.onclick = () => {
      if (store.demo) return toast('Files need a real chat tab.');
      if (rel === null) return toast("That file is outside this tab's folder.");
      openViewer(f.id, rel);
    };
    row.append(main);
    if (rel !== null) row.append(atButton(rel, false));
    row.oncontextmenu = (e) => rowMenu(e, abs, false);
    sec.append(row);
  }
  if (list.length > CHANGED_SHOWN) {
    sec.append(
      button(f.showAllChanged ? 'SHOW FEWER' : `SHOW ALL ${list.length}`, () => {
        f.showAllChanged = !f.showAllChanged;
        render();
      }, 'fx-more'),
    );
  }
  return sec;
}

// A path inside the tab's folder, made absolute with the folder's own separator (Windows or Linux).
function absOf(cwd: string, rel: string): string {
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/';
  return cwd.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
}

// Right-click (long-press on a phone) on a file or folder: show it in the system file manager (desktop app
// only), or copy its full path.
function rowMenu(e: MouseEvent, abs: string, dir: boolean): void {
  e.preventDefault();
  if (store.demo) return toast('Files need a real chat tab.');
  document.querySelector('.fx-menu')?.remove();
  const menu = el('div', 'fx-menu');
  menu.setAttribute('role', 'menu');
  const close = () => {
    menu.remove();
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', onKey, true);
  };
  const outside = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') close();
  };
  const item = (label: string, run: () => void) => {
    const b = button(label, () => {
      close();
      run();
    }, 'fx-menu-item');
    b.setAttribute('role', 'menuitem');
    menu.append(b);
  };
  if (shellApi?.showInFolder) {
    item(dir ? 'OPEN IN FILE MANAGER' : 'SHOW IN FILE MANAGER', () => {
      void shellApi!.showInFolder!(abs).then((ok) => ok || toast("Couldn't open the file manager."));
    });
  }
  item('COPY PATH', () => {
    void navigator.clipboard.writeText(abs).then(
      () => toast('Path copied.'),
      () => toast(abs, 8000), // no clipboard (plain http on a phone): show it to select by hand
    );
  });
  document.body.append(menu);
  // At the pointer, kept on screen.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 4)}px`;
  addEventListener('pointerdown', outside, true);
  addEventListener('keydown', onKey, true);
  (menu.firstElementChild as HTMLElement | null)?.focus();
}

function atButton(rel: string, dir: boolean): HTMLButtonElement {
  const b = button('@', () => insert(rel, dir), 'fx-at');
  b.tabIndex = -1; // keyboard users insert from the viewer; keeps Tab order short
  b.title = `Add ${atRef(rel, dir)} to your message`;
  b.setAttribute('aria-label', `Add ${rel} to your message`);
  return b;
}

function renderDir(into: HTMLElement, f: TabFx, path: string, depth: number, sets: { files: Set<string>; dirs: Set<string> }): void {
  const d = f.dirs.get(path);
  if (!d) {
    void loadDir(f, path);
    into.append(note('LOADING', depth, 'fx-loading'));
    return;
  }
  if (d.status === 'loading') {
    into.append(note('LOADING', depth, 'fx-loading'));
    return;
  }
  if (d.status === 'error') {
    into.append(note(`CAN'T OPEN: ${d.error}`, depth, 'fx-err'));
    return;
  }
  if (!d.entries.length) {
    into.append(note('(empty)', depth));
    return;
  }
  for (const e of d.entries) {
    const open = e.dir && f.expanded.has(e.path);
    const isChanged = e.dir ? sets.dirs.has(fold(e.path)) : sets.files.has(fold(e.path));
    const row = el('div', 'fx-row' + (e.dir ? ' fx-isdir' : '') + (isChanged ? ' fx-changed-mark' : '') + (e.name === 'node_modules' ? ' fx-heavy' : ''));
    row.dataset.path = e.path;
    row.style.setProperty('--d', String(depth));
    row.setAttribute('role', 'treeitem');
    if (e.dir) row.setAttribute('aria-expanded', String(open));

    const main = el('button', 'fx-main');
    main.type = 'button';
    main.title = e.path;
    const glyph = e.dir ? (open ? '[-]' : '[+]') : isChanged ? ' * ' : ' · ';
    main.append(el('span', 'fx-glyph', glyph), el('span', 'fx-name', e.name));
    if (!e.dir) main.append(el('span', 'fx-size', fmtSize(e.size, true)));
    else if (isChanged) main.append(el('span', 'fx-size', '*'));
    main.onclick = () => {
      if (!e.dir) return openViewer(f.id, e.path);
      if (f.expanded.has(e.path)) f.expanded.delete(e.path);
      else {
        f.expanded.add(e.path);
        if (f.dirs.get(e.path)?.status === 'error') f.dirs.delete(e.path);
      }
      render();
    };
    row.append(main, atButton(e.path, e.dir));
    row.oncontextmenu = (ev) => rowMenu(ev, absOf(f.cwd, e.path), e.dir);
    into.append(row);
    if (open) {
      const kids = el('div', 'fx-kids');
      kids.setAttribute('role', 'group');
      renderDir(kids, f, e.path, depth + 1, sets);
      into.append(kids);
    }
  }
  if (d.total > d.entries.length) into.append(note(`Showing the first ${d.entries.length} of ${d.total} items.`, depth));
}

function note(text: string, depth: number, cls = ''): HTMLElement {
  const n = el('div', `fx-note ${cls}`, text);
  n.style.setProperty('--d', String(depth));
  return n;
}

function fmtSize(n: number, short = false): string {
  if (n < 1024) return short ? `${n}B` : `${n} bytes`;
  const units = short ? ['K', 'M', 'G'] : ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = v < 10 ? v.toFixed(1) : String(Math.round(v));
  return short ? `${num}${units[i]}` : `${num} ${units[i]}`;
}

// ---- viewer (overlay on top of everything; full screen on phones) ----

type Viewer = {
  tabId: string;
  rel: string;
  overlay: HTMLDivElement;
  meta: HTMLDivElement;
  notice: HTMLDivElement;
  body: HTMLDivElement;
  data?: FileReadResponse;
  lastFocus: Element | null;
  statsKey: string;
  timer?: number;
  busy: boolean;
  wrapBtn: HTMLButtonElement;
};

let viewer: Viewer | null = null;
let wrap = loadWrap();
let pendingBack = 0;

function loadWrap(): boolean {
  try {
    return localStorage.getItem('phosphor.files.wrap') === '1';
  } catch {
    return false;
  }
}

function saveWrap(): void {
  try {
    localStorage.setItem('phosphor.files.wrap', wrap ? '1' : '0');
  } catch {
    /* storage blocked: fine */
  }
}

addEventListener('popstate', () => {
  if (pendingBack > 0) {
    pendingBack--;
    return;
  }
  if (viewer) closeViewer(true);
});

document.addEventListener(
  'keydown',
  (e) => {
    if (viewer && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeViewer();
    }
  },
  true,
);

export function openViewer(tabId: string, rel: string): void {
  if (viewer) closeViewer();
  const overlay = el('div', 'fx-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `File ${rel}`);
  const box = el('div', 'fx-viewer');

  const head = el('div', 'fx-v-head');
  const title = el('div', 'fx-v-title');
  const meta = el('div', 'fx-v-meta', 'LOADING');
  title.append(el('div', 'fx-v-path', rel), meta);

  const tools = el('div', 'fx-v-tools');
  const wrapBtn = button('WRAP', () => {
    wrap = !wrap;
    saveWrap();
    wrapBtn.classList.toggle('on', wrap);
    wrapBtn.setAttribute('aria-pressed', String(wrap));
    box.classList.toggle('fx-wrap', wrap);
  }, 'fx-v-wrap');
  wrapBtn.classList.toggle('on', wrap);
  wrapBtn.setAttribute('aria-pressed', String(wrap));
  wrapBtn.title = 'Wrap long lines';
  wrapBtn.hidden = true; // shown once the file turns out to be text
  const insertBtn = button('@ INSERT', () => {
    closeViewer(); // first, so the message box keeps the focus
    insert(rel);
  }, 'fx-v-insert');
  insertBtn.title = `Add ${atRef(rel)} to your message so Claude reads this file`;
  const closeBtn = button('CLOSE', () => closeViewer(), 'fx-v-close');
  tools.append(wrapBtn, insertBtn, closeBtn);
  head.append(title, tools);

  const notice = el('div', 'fx-v-notice');
  notice.hidden = true;
  const body = el('div', 'fx-v-body');
  body.tabIndex = 0; // arrow keys and Page Down scroll the text
  body.append(el('div', 'fx-v-empty fx-loading', 'LOADING'));
  box.classList.toggle('fx-wrap', wrap);
  box.append(head, notice, body);
  overlay.append(box);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeViewer();
  });
  document.body.append(overlay);

  viewer = { tabId, rel, overlay, meta, notice, body, lastFocus: document.activeElement, statsKey: viewerKey(), busy: false, wrapBtn };
  try {
    history.pushState({ fxViewer: true }, '');
  } catch {
    /* fine without back-button support */
  }
  body.focus({ preventScroll: true });
  void loadViewer(false);
}

function closeViewer(fromPop = false): void {
  const v = viewer;
  if (!v) return;
  viewer = null;
  clearTimeout(v.timer);
  v.overlay.remove();
  if (!fromPop && (history.state as { fxViewer?: boolean } | null)?.fxViewer) {
    pendingBack++;
    history.back();
  }
  // Give focus back to the row that opened it (the tree may have been redrawn meanwhile).
  const back = v.lastFocus instanceof HTMLElement && v.lastFocus.isConnected ? v.lastFocus : root.querySelector<HTMLElement>(`[data-path="${CSS.escape(v.rel)}"] > .fx-main`);
  back?.focus({ preventScroll: true });
}

async function loadViewer(quiet: boolean): Promise<void> {
  const v = viewer;
  if (!v || v.busy) return;
  v.busy = true;
  let data: FileReadResponse | null = null;
  let error = '';
  try {
    data = await api<FileReadResponse>('read', v.tabId, v.rel);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  v.busy = false;
  if (viewer !== v) return;
  if (!data) {
    if (quiet) return; // keep what is on screen
    v.meta.textContent = 'ERROR';
    v.body.replaceChildren(el('div', 'fx-v-empty fx-err', `CAN'T OPEN THIS FILE.\n${error}`));
    return;
  }
  if (quiet && v.data && sameContent(v.data, data)) return;
  const hadData = !!v.data;
  v.data = data;
  showData(v, data);
  if (quiet && hadData) flash(v, 'UPDATED BY CLAUDE. RELOADED.');
}

function sameContent(a: FileReadResponse, b: FileReadResponse): boolean {
  if (a.kind !== b.kind || a.size !== b.size) return false;
  return a.kind === 'text' && b.kind === 'text' ? a.text === b.text : a.kind !== 'text';
}

function showData(v: Viewer, data: FileReadResponse): void {
  const changed = changedSets().files.has(fold(v.rel));
  const sizeText = fmtSize(data.size);
  const top = v.body.scrollTop;
  const left = v.body.scrollLeft;
  v.notice.hidden = true;
  v.wrapBtn.hidden = data.kind !== 'text';

  if (data.kind === 'text') {
    const lines = data.text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    v.meta.textContent = [sizeText, `${lines.length} LINES`, changed ? '* CHANGED BY CLAUDE' : ''].filter(Boolean).join(' · ');
    if (data.truncated) {
      v.notice.hidden = false;
      v.notice.textContent = bigNote(data.size);
    }
    const code = el('div', 'fx-code');
    code.style.setProperty('--gw', `${String(lines.length).length}ch`);
    const frag = document.createDocumentFragment();
    lines.forEach((line, i) => {
      const row = el('div', 'fx-line');
      row.append(el('span', 'fx-ln', String(i + 1)), el('span', 'fx-lt', line));
      frag.append(row);
    });
    code.append(frag);
    v.body.replaceChildren(code);
  } else if (data.kind === 'image') {
    v.meta.textContent = [sizeText, 'IMAGE', changed ? '* CHANGED BY CLAUDE' : ''].filter(Boolean).join(' · ');
    const wrapEl = el('div', 'fx-v-img');
    const img = el('img');
    img.alt = v.rel;
    img.decoding = 'async';
    img.src = `${data.url}&v=${Date.now()}`; // fresh copy after Claude changes it
    img.onload = () => {
      if (viewer !== v) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      v.meta.textContent = `${sizeText} · ${w} x ${h} PX` + (changed ? ' · * CHANGED BY CLAUDE' : '');
      // Small pixel art: scale up by whole steps with sharp pixels.
      const zoom = Math.min(8, Math.floor((v.body.clientWidth - 40) / w), Math.floor((v.body.clientHeight - 40) / h));
      if (w <= 256 && h <= 256 && zoom >= 2) {
        img.classList.add('fx-pixel');
        img.style.width = `${w * zoom}px`;
        img.style.height = `${h * zoom}px`;
      }
    };
    img.onerror = () => wrapEl.replaceChildren(el('div', 'fx-v-empty fx-err', "CAN'T SHOW THIS IMAGE."));
    wrapEl.append(img);
    v.body.replaceChildren(wrapEl);
  } else {
    v.meta.textContent = [sizeText, 'BINARY', changed ? '* CHANGED BY CLAUDE' : ''].filter(Boolean).join(' · ');
    v.body.replaceChildren(el('div', 'fx-v-empty', `BINARY FILE. ${sizeText}.\nNothing to show as text.`));
  }
  v.body.scrollTop = top;
  v.body.scrollLeft = left;
}

const bigNote = (size: number) => `Big file (${fmtSize(size)}): showing the start only.`;

function flash(v: Viewer, text: string): void {
  v.notice.hidden = false;
  v.notice.textContent = text;
  v.notice.classList.add('fx-flash');
  setTimeout(() => {
    if (viewer !== v) return;
    v.notice.classList.remove('fx-flash');
    if (v.data?.kind === 'text' && v.data.truncated) v.notice.textContent = bigNote(v.data.size);
    else v.notice.hidden = true;
  }, 4000);
}

// While Claude works, stats change on every step. If the open file is one Claude changed, reload it quietly.
const viewerKey = () => (tab ? `${tab.stats.toolCalls}|${tab.stats.filesChanged.length}|${tab.stats.turnStartedAt}` : '');

function viewerStatsChanged(): void {
  const v = viewer;
  if (!v || !tab || tab.meta.id !== v.tabId) return;
  const key = viewerKey();
  if (key === v.statsKey) return;
  v.statsKey = key;
  if (!changedSets().files.has(fold(v.rel))) return;
  clearTimeout(v.timer);
  v.timer = window.setTimeout(() => void loadViewer(true), 700);
}
