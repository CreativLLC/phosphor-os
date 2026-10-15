import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { DocEditor, LoadResult } from './docs-editor.ts';
import type { DocConflict, DocEntry, DocFile, DocStat, DocsHit, DocsInfo, DocsList, DocsSearch, TrashItem } from '../../shared/docs.ts';
import './docs.css';
import './md.ts'; // its DOMPurify hook: links in the print copy open in a new tab
import { store } from './store.ts';
import { button, confirmBox, el, shortPath, timeAgo, toast } from './ui.ts';

// DOCS: the document program. A full view over the chat (full screen on phones): the docs folder's files on
// the left, the document on the right. Markdown files show in DOC view: a normal document editor (bold, lists,
// checkboxes, links; docs-editor.ts, loaded on first use) that saves plain Markdown, keeping untouched parts of
// the file byte for byte (mdkeep.ts). SOURCE shows the raw text (a plain textarea), as do .txt files and files
// the editor cannot carry exactly. The textarea always holds the file text: the DOC view writes into it.
// Files live in the docs folder on the PC (server/docs.ts; PHOSPHOR_DOCS_DIR in .env). Saving is automatic
// (after a pause in typing) and conflict-checked: if the file changed on disk meanwhile (Nextcloud synced an
// edit from the phone, another program), both versions show and the owner keeps one. DELETE moves to TRASH.
// Keys while open: Ctrl+S save now, Ctrl+F find and replace, Ctrl+P print, Esc closes the innermost panel
// (in the editor it first leaves the editor; Esc again closes DOCS).
// Speed: SOURCE is a plain textarea (smooth with 1 MB); DOC view writes Markdown and counts after typing pauses;
// big files open in SOURCE; nothing runs while DOCS is closed. No polling: the open file is checked on disk when
// the window gets the focus back.

export type DocsCommand = { id: string; label: string; hint?: string; keywords?: string[]; run(): void };
type Opts = {
  insertIntoChat: (text: string) => void;
  showChat?: () => void; // desktop app: back to CHAT from a site
  addCommands?: (cmds: DocsCommand[]) => void; // the launcher's
  removeCommands?: (ids: string[]) => void;
};
type Dir = { status: 'loading' } | { status: 'ok'; list: DocsList } | { status: 'error'; error: string };
type View = 'doc' | 'source';
type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error' | 'readonly';
type Doc = Pick<DocFile, 'eol' | 'bom' | 'encoding' | 'readonly'> & { path: string; etag: string | null; saved: string; size: number; md: boolean; state: SaveState };
type Template = { id: string; label: string; name: () => string; text: () => string };

const VIEW_KEY = 'phosphor.docs.view';
const RECENT_KEY = 'phosphor.docs.recent';
const MAX_RECENT = 8;
const NARROW = '(max-width: 700px)';
const MAX_MATCHES = 5000;
const BIG_FOR_DOC = 300_000; // chars: bigger files open in SOURCE (faster)
const STATE_LABEL: Record<SaveState, string> = { saved: 'SAVED', dirty: 'UNSAVED', saving: 'SAVING', conflict: 'CONFLICT', error: 'NOT SAVED', readonly: 'READ ONLY' };

let opts: Opts = { insertIntoChat: () => {} };
let topBtn: HTMLElement | null = null;
let isOpen = false;
let info: DocsInfo | null = null;
const dirs = new Map<string, Dir>();
const expanded = new Set<string>();
let dirGen = 0;
let selected: string | null = null;
let doc: Doc | null = null;
let view: View = loadView();
let mode: 'tree' | 'search' | 'trash' = 'tree';
let searchRes: DocsSearch | null = null;
let searchBusy = false;
let trashItems: TrashItem[] | null = null;
let openToken = 0;
let editGen = 0;
let saving: Promise<void> | null = null;
let saveTimer: number | undefined;
let maxTimer: number | undefined;
let countTimer: number | undefined;
let searchTimer: number | undefined;
let retryTimer: number | undefined;
let lastCheck = 0;
let pendingBack = 0;
let oldTitle = '';
const toggles = new Set<() => void>();

// DOM (made on first open)
let rootEl: HTMLElement | null = null;
let nameEl: HTMLElement;
let stateEl: HTMLElement;
let viewBtns: Record<View, HTMLButtonElement>;
let rootNameEl: HTMLElement;
let rootPathEl: HTMLElement;
let searchIn: HTMLInputElement;
let listEl: HTMLElement;
let selEl: HTMLElement;
let renameBtn: HTMLButtonElement;
let deleteBtn: HTMLButtonElement;
let trashBtn: HTMLButtonElement;
let noteEl: HTMLElement;
let panes: HTMLElement;
let ed: HTMLTextAreaElement;
let richHost: HTMLElement;
// DOC view (docs-editor.ts). richText: the text it shows (null = not loaded for this file). richDirty: it has
// edits the textarea does not have yet (fileText() writes them). richOff: why this file shows in SOURCE only.
let rich: DocEditor | null = null;
let richLoad: Promise<DocEditor | null> | null = null;
let richText: string | null = null;
let richDirty = false;
let richOff = '';
let richKept: Extract<LoadResult, { ok: true }> | null = null;
let richShown: Promise<void> = Promise.resolve();
let hitEl: HTMLElement;
let emptyEl: HTMLElement;
let countsEl: HTMLElement;
let fmtEl: HTMLElement;
let conflictEl: HTMLElement;
let printEl: HTMLElement;
let mirror: HTMLElement | null = null;
// find
let findBar: HTMLElement;
let findIn: HTMLInputElement;
let replIn: HTMLInputElement;
let caseBtn: HTMLButtonElement;
let findCount: HTMLElement;
let matchCase = false;
let matches: number[] = [];
let matchesKey = '';
let cur = -1; // index into matches
let hitBox: { top: number; left: number; width: number; height: number } | null = null;

// ------------------------------------------------------------ public

export function mountDocs(btn: HTMLElement | null, o: Opts): void {
  opts = o;
  topBtn = btn;
  if (btn) btn.onclick = () => (isOpen ? closeDocs() : openDocs());
  // Going to a chat (tab bar, HISTORY, the launcher filling the message box) leaves DOCS.
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tab-label, .tab-add')) closeDocs();
  });
  document.getElementById('history')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.history-row')) closeDocs();
  });
  const input = document.getElementById('input');
  input?.addEventListener('input', () => {
    if (!isOpen) return;
    closeDocs();
    input.focus();
  });
  store.on((c) => {
    if (c.kind === 'active' && isOpen) closeDocs();
  });
  addEventListener('popstate', () => {
    if (pendingBack > 0) {
      pendingBack--;
      return;
    }
    if (isOpen && (history.state as { phosphorDocs?: boolean } | null)?.phosphorDocs !== true) closeDocs(true);
  });
  addEventListener('beforeprint', () => {
    if (isOpen && doc && !document.documentElement.classList.contains('docs-printing')) preparePrint();
  });
  addEventListener('afterprint', endPrint);
  addEventListener('beforeunload', (e) => {
    if (!doc || doc.readonly || !rootEl) return;
    if (fileText() === doc.saved && doc.state !== 'conflict') return;
    void save();
    e.preventDefault();
  });
  registerCommands();
}

export const isDocsOpen = (): boolean => isOpen;

// Runs whenever DOCS opens or closes (the program bar's DOCS button).
export function onDocsToggle(fn: () => void): void {
  toggles.add(fn);
}

export function openDocs(path?: string): void {
  build();
  if (!isOpen) {
    isOpen = true;
    rootEl!.hidden = false;
    document.body.classList.add('docs-open');
    topBtn?.classList.add('on');
    try {
      history.pushState({ phosphorDocs: true }, '');
    } catch {
      /* fine without the back button */
    }
    document.addEventListener('keydown', onKey, true);
    addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibility);
    for (const fn of toggles) fn();
    void loadInfo();
    refreshTree();
    if (doc) {
      renderDoc();
      void checkDisk(true);
    }
  }
  if (path) void openDoc(path);
  else if (!doc && !emptyEl.dataset.path) {
    const last = recent()[0];
    if (last) void openDoc(last, undefined, true);
    else showEmpty();
  }
  if (!path) {
    setSide(!doc);
    if (doc && fine()) focusEditor();
    else rootEl!.focus({ preventScroll: true });
  }
}

export function closeDocs(fromPop = false): void {
  if (!isOpen || !rootEl) return;
  if (doc && !doc.readonly && doc.state !== 'conflict' && fileText() !== doc.saved) void save();
  isOpen = false;
  closeFind(false);
  rootEl.hidden = true;
  document.body.classList.remove('docs-open');
  topBtn?.classList.remove('on');
  document.removeEventListener('keydown', onKey, true);
  removeEventListener('focus', onWindowFocus);
  document.removeEventListener('visibilitychange', onVisibility);
  clearTimeout(countTimer);
  clearTimeout(searchTimer);
  if (!fromPop && (history.state as { phosphorDocs?: boolean } | null)?.phosphorDocs) {
    pendingBack++;
    history.back();
  }
  for (const fn of toggles) fn();
}

// NEW DOCUMENT (launcher): open DOCS with the new-document box.
export function newDocument(): void {
  openDocs();
  void newDocBox();
}

// ------------------------------------------------------------ DOM

const fine = () => matchMedia('(pointer: fine)').matches;
const narrow = () => matchMedia(NARROW).matches;

function build(): void {
  if (rootEl) return;
  const root = el('section', 'docs');
  rootEl = root;
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute('aria-label', 'DOCS');

  // Top bar
  const bar = el('div', 'dc-bar');
  const filesBtn = button('FILES', () => setSide(!root.classList.contains('dc-show-side')), 'dc-files-btn');
  filesBtn.title = 'Show the file list';
  const title = el('div', 'dc-title');
  nameEl = el('span', 'dc-name');
  stateEl = el('span', 'dc-state');
  stateEl.setAttribute('role', 'status');
  title.append(nameEl, stateEl);
  const seg = el('div', 'dc-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'View');
  viewBtns = {
    doc: button('DOC', () => setView('doc'), 'dc-v-doc'),
    source: button('SOURCE', () => setView('source'), 'dc-v-source'),
  };
  viewBtns.doc.title = 'Edit it as a document: bold, lists, checkboxes, links';
  viewBtns.source.title = 'The Markdown text itself';
  seg.append(viewBtns.doc, viewBtns.source);
  const findBtn = button('FIND', () => openFind(), 'dc-find-btn');
  findBtn.title = 'Find and replace (Ctrl+F)';
  const printBtn = button('PRINT', printDoc, 'dc-print-btn');
  printBtn.title = 'Print, or save as PDF (Ctrl+P)';
  const askBtn = button('ASK CLAUDE', () => void askClaude(), 'dc-ask-btn');
  askBtn.title = 'Put this document in your message to Claude. Nothing is sent.';
  const closeBtn = button('CLOSE', () => closeDocs(), 'dc-close');
  closeBtn.title = 'Close DOCS (saves first)';
  const tools = el('div', 'dc-tools');
  tools.append(seg, findBtn, printBtn, askBtn);
  bar.append(el('span', 'dc-tag', 'DOCS'), filesBtn, title, tools, closeBtn);

  // File list
  const side = el('aside', 'dc-side');
  const head = el('div', 'dc-side-head');
  const rootBox = el('div', 'dc-root');
  rootNameEl = el('div', 'dc-root-name', 'DOCS FOLDER');
  rootPathEl = el('div', 'dc-root-path');
  rootBox.append(rootNameEl, rootPathEl);
  const btns = el('div', 'dc-side-btns');
  const newBtn = button('NEW', () => void newDocBox(), 'dc-new');
  newBtn.title = 'New document: note, letter, list or blank';
  const folderBtn = button('FOLDER', () => void newFolderBox(), 'dc-newfolder');
  folderBtn.title = 'New folder';
  const refreshBtn = button('REFRESH', () => {
    void loadInfo();
    refreshTree();
  });
  refreshBtn.title = 'Reload the list';
  btns.append(newBtn, folderBtn, refreshBtn);
  searchIn = el('input', 'dc-search');
  searchIn.type = 'search';
  searchIn.placeholder = 'Search names and text';
  searchIn.spellcheck = false;
  searchIn.setAttribute('aria-label', 'Search documents');
  searchIn.setAttribute('enterkeyhint', 'search');
  head.append(rootBox, btns, searchIn);
  listEl = el('div', 'dc-list');
  listEl.setAttribute('role', 'list');
  const foot = el('div', 'dc-side-foot');
  selEl = el('div', 'dc-sel');
  renameBtn = button('RENAME', () => void renameBox(), 'dc-rename');
  renameBtn.title = 'Rename or move (type a folder path to move)';
  deleteBtn = button('DELETE', () => void deleteSelected(), 'dc-delete');
  deleteBtn.title = 'Move to TRASH (you can put it back)';
  trashBtn = button('TRASH', () => void showTrash(), 'dc-trash');
  trashBtn.title = 'Deleted items: put them back';
  foot.append(selEl, renameBtn, deleteBtn, trashBtn);
  side.append(head, listEl, foot);

  // Editor
  const main = el('div', 'dc-main');
  noteEl = el('div', 'dc-note');
  noteEl.hidden = true;
  findBar = buildFind();
  panes = el('div', 'dc-panes');
  ed = el('textarea', 'dc-ed');
  ed.spellcheck = true;
  ed.setAttribute('autocapitalize', 'sentences');
  ed.setAttribute('aria-label', 'Document text');
  richHost = el('div', 'dc-rich-host');
  hitEl = el('div', 'dc-hit');
  hitEl.hidden = true;
  panes.append(ed, richHost, hitEl);
  emptyEl = el('div', 'dc-empty');
  const status = el('div', 'dc-status');
  countsEl = el('span', 'dc-counts');
  fmtEl = el('span', 'dc-fmt');
  status.append(countsEl, fmtEl);
  conflictEl = el('div', 'dc-conflict');
  conflictEl.hidden = true;
  conflictEl.setAttribute('role', 'alertdialog');
  main.append(noteEl, findBar, panes, emptyEl, status, conflictEl);

  const body = el('div', 'dc-body');
  body.append(side, main);
  root.append(bar, body);
  document.body.append(root);
  printEl = el('div', 'docs-print');
  document.body.append(printEl);
  setView(view);

  ed.addEventListener('input', edited);
  ed.addEventListener('scroll', onEdScroll, { passive: true });
  searchIn.addEventListener('input', () => queueSearch(150));
  searchIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      queueSearch(0);
    }
  });
  listEl.addEventListener('click', onListClick);
}

function setSide(show: boolean): void {
  rootEl?.classList.toggle('dc-show-side', show);
}

// ------------------------------------------------------------ server

class ApiError extends Error {
  status: number;
  body: Record<string, unknown> | null;
  constructor(status: number, message: string, body: Record<string, unknown> | null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function api<T>(action: string, params?: Record<string, string>, body?: unknown): Promise<T> {
  const url = `/api/docs/${action}${params ? `?${new URLSearchParams(params)}` : ''}`;
  let r: Response;
  try {
    r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'No connection to the PC.', null);
  }
  let data: Record<string, unknown> | null = null;
  try {
    data = await r.json();
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new ApiError(r.status, r.status === 401 ? 'Login needed. Reload the page.' : String(data?.error ?? `Error ${r.status}`), data);
  return data as T;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function loadInfo(): Promise<void> {
  try {
    info = await api<DocsInfo>('info');
  } catch (e) {
    rootPathEl.textContent = `Can't reach the docs folder: ${errText(e)}`;
    return;
  }
  rootNameEl.textContent = (info.root.split(/[\\/]/).filter(Boolean).pop() || info.root).toUpperCase();
  rootPathEl.textContent = info.root;
  const where = `Docs folder: ${info.root}${info.fromEnv ? '' : ' (the default)'}\nChange it: PHOSPHOR_DOCS_DIR in the app's .env file, then restart the app.`;
  rootNameEl.parentElement!.title = where;
  if (!info.exists) dirs.set('', { status: 'ok', list: { path: '', entries: [], total: 0, missing: true } });
  if (!doc) showEmpty();
  renderList();
}

// ------------------------------------------------------------ file list

function loadDir(path: string, quiet = false): Promise<void> {
  const gen = dirGen;
  if (!quiet || !dirs.has(path)) dirs.set(path, { status: 'loading' });
  return api<DocsList>('list', { path })
    .then((list): Dir => ({ status: 'ok', list }))
    .catch((e): Dir => ({ status: 'error', error: errText(e) }))
    .then((d) => {
      if (gen !== dirGen) return;
      if (quiet && d.status === 'error' && dirs.get(path)?.status === 'ok') return;
      if (d.status === 'error' && path && (d.error === 'Not found.' || d.error.includes('gone'))) {
        expanded.delete(path);
        dirs.delete(path);
      } else dirs.set(path, d);
      renderList();
    });
}

// Folders on screen now: the root and open folders whose parents are open.
function openDirs(): string[] {
  const out = [''];
  const walk = (path: string) => {
    const d = dirs.get(path);
    if (d?.status !== 'ok') return;
    for (const e of d.list.entries) {
      if (e.kind === 'dir' && expanded.has(e.path)) {
        out.push(e.path);
        walk(e.path);
      }
    }
  };
  walk('');
  return out;
}

// Reload what is on screen without flashing; forget the rest.
function refreshTree(): void {
  const keep = openDirs();
  for (const p of [...dirs.keys()]) if (!keep.includes(p)) dirs.delete(p);
  dirGen++;
  for (const p of keep) void loadDir(p, true);
  if (mode === 'trash') void loadTrash();
}

function renderList(): void {
  if (!rootEl || !isOpen) return;
  updateFoot();
  if (mode === 'search') return renderSearch();
  if (mode === 'trash') return renderTrash();
  const frag = document.createDocumentFragment();
  if (info && !info.exists) {
    frag.append(el('div', 'dc-msg', "This folder is not there yet. It is made when you save your first document. Press NEW."));
  } else renderDir(frag, '', 0);
  const keep = listEl.scrollTop;
  listEl.replaceChildren(frag);
  listEl.scrollTop = keep;
}

function renderDir(into: DocumentFragment | HTMLElement, path: string, depth: number): void {
  const d = dirs.get(path);
  if (!d) {
    void loadDir(path);
    into.append(note('LOADING', depth, 'dc-loading'));
    return;
  }
  if (d.status === 'loading') return void into.append(note('LOADING', depth, 'dc-loading'));
  if (d.status === 'error') return void into.append(note(`CAN'T OPEN: ${d.error}`, depth, 'dc-err'));
  if (!d.list.entries.length) return void into.append(note(depth ? '(empty)' : 'No documents yet. Press NEW.', depth));
  for (const e of d.list.entries) {
    into.append(row(e, depth));
    if (e.kind === 'dir' && expanded.has(e.path)) renderDir(into, e.path, depth + 1);
  }
  if (d.list.total > d.list.entries.length) into.append(note(`Showing the first ${d.list.entries.length} of ${d.list.total}.`, depth));
}

function row(e: DocEntry, depth: number): HTMLElement {
  const isDir = e.kind === 'dir';
  const r = el('button', 'dc-row');
  r.type = 'button';
  r.dataset.path = e.path;
  r.dataset.kind = e.kind;
  r.style.setProperty('--d', String(depth));
  if (isDir) r.setAttribute('aria-expanded', String(expanded.has(e.path)));
  r.classList.toggle('dc-isdir', isDir);
  r.classList.toggle('dc-other', e.kind === 'other');
  r.classList.toggle('sel', selected === e.path);
  r.classList.toggle('on', doc?.path === e.path);
  const glyph = isDir ? (expanded.has(e.path) ? '[-]' : '[+]') : e.kind === 'other' ? ' - ' : ' · ';
  r.append(el('span', 'dc-glyph', glyph), el('span', 'dc-nm', e.name));
  if (e.readonly) r.append(el('span', 'dc-ro', 'READ ONLY'));
  else if (!isDir) r.append(el('span', 'dc-size', fmtSize(e.size)));
  const lines = [e.path];
  if (!isDir) lines.push(`${fmtSize(e.size)} · changed ${timeAgo(e.mtime)}`);
  if (e.kind === 'other') lines.push("Not plain text: open it in Nextcloud or with the PC's own program.");
  if (e.readonly) lines.push('Read-only in DOCS (PHOSPHOR_DOCS_READONLY in .env).');
  r.title = lines.join('\n');
  return r;
}

function note(text: string, depth: number, cls = ''): HTMLElement {
  const n = el('div', `dc-note-row ${cls}`, text);
  n.style.setProperty('--d', String(depth));
  return n;
}

function onListClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const restore = t.closest<HTMLElement>('[data-restore]');
  if (restore) return void restoreItem(restore.dataset.restore!);
  if (t.closest('.dc-back')) return backToTree();
  const r = t.closest<HTMLElement>('.dc-row');
  if (!r) return;
  const path = r.dataset.path!;
  const kind = r.dataset.kind;
  selected = path;
  if (r.dataset.line) {
    void openDoc(path, { line: Number(r.dataset.line), q: searchRes?.q ?? '' });
    return;
  }
  if (kind === 'dir') {
    if (mode !== 'tree') {
      revealPath(`${path}/x`);
      backToTree();
      return;
    }
    if (expanded.has(path)) expanded.delete(path);
    else expanded.add(path);
    renderList();
    return;
  }
  if (kind === 'other') {
    showCannot(path, "Not a plain text file. Open it in Nextcloud or with the PC's own program.");
    renderList();
    return;
  }
  void openDoc(path);
}

// Open the folders down to a file so it shows in the tree.
function revealPath(path: string): void {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
}

function updateFoot(): void {
  const target = selected ?? doc?.path ?? null;
  selEl.textContent = target ? nameOf(target) : 'NOTHING PICKED';
  selEl.title = target ?? '';
  renameBtn.disabled = !target || mode === 'trash';
  deleteBtn.disabled = !target || mode === 'trash';
  trashBtn.classList.toggle('on', mode === 'trash');
}

// ------------------------------------------------------------ search

function queueSearch(ms: number): void {
  clearTimeout(searchTimer);
  const q = searchIn.value.trim();
  if (q.length < 2) {
    if (mode === 'search') backToTree();
    return;
  }
  searchTimer = window.setTimeout(() => void runSearch(q), ms);
}

async function runSearch(q: string): Promise<void> {
  mode = 'search';
  searchBusy = true;
  if (!searchRes || searchRes.q !== q) renderList();
  try {
    const r = await api<DocsSearch>('search', { q });
    if (searchIn.value.trim() !== q || mode !== 'search') return;
    searchRes = r;
  } catch (e) {
    searchRes = { q, results: [], truncated: false, ms: 0 };
    toast(`Search failed: ${errText(e)}`);
  } finally {
    searchBusy = false;
  }
  renderList();
}

function renderSearch(): void {
  const frag = document.createDocumentFragment();
  const head = el('div', 'dc-list-head');
  head.append(el('span', '', 'SEARCH'), button('BACK', () => {}, 'dc-back'));
  frag.append(head);
  const r = searchRes;
  if (searchBusy && (!r || r.q !== searchIn.value.trim())) frag.append(el('div', 'dc-msg dc-loading', 'SEARCHING'));
  else if (r && !r.results.length) frag.append(el('div', 'dc-msg', `Nothing has "${r.q}".`));
  else if (r) {
    for (const h of r.results) frag.append(hitRow(h));
    if (r.truncated) frag.append(el('div', 'dc-msg', 'Stopped early (big folder). Type more words to narrow it.'));
  }
  listEl.replaceChildren(frag);
}

function hitRow(h: DocsHit): HTMLElement {
  const r = el('button', 'dc-row dc-hitrow');
  r.type = 'button';
  r.dataset.path = h.path;
  r.dataset.kind = h.kind;
  if (h.line) r.dataset.line = String(h.line);
  r.classList.toggle('dc-isdir', h.kind === 'dir');
  r.classList.toggle('dc-other', h.kind === 'other');
  const top = el('span', 'dc-hit-top');
  top.append(el('span', 'dc-glyph', h.kind === 'dir' ? '[+]' : h.line ? ' > ' : ' · '), el('span', 'dc-nm', h.name));
  const where = h.path.includes('/') ? h.path.slice(0, h.path.lastIndexOf('/')) : 'TOP FOLDER';
  r.append(top, el('span', 'dc-hit-where', h.line ? `LINE ${h.line} · ${where}` : where));
  if (h.snippet) r.append(el('span', 'dc-snip', h.snippet));
  r.title = h.path;
  return r;
}

function backToTree(): void {
  mode = 'tree';
  searchRes = null;
  trashItems = null;
  if (searchIn.value) searchIn.value = '';
  renderList();
}

// ------------------------------------------------------------ trash

// TRASH button: show the trash, or go back when it is already on screen.
async function showTrash(): Promise<void> {
  if (mode === 'trash' && trashItems) return backToTree();
  mode = 'trash';
  trashItems = null;
  renderList();
  await loadTrash();
}

async function loadTrash(): Promise<void> {
  try {
    trashItems = await api<TrashItem[]>('trash');
  } catch (e) {
    trashItems = [];
    toast(`Can't read the trash: ${errText(e)}`);
  }
  renderList();
}

function renderTrash(): void {
  const frag = document.createDocumentFragment();
  const head = el('div', 'dc-list-head');
  head.append(el('span', '', 'TRASH'), button('BACK', () => {}, 'dc-back'));
  frag.append(head);
  if (!trashItems) frag.append(el('div', 'dc-msg dc-loading', 'LOADING'));
  else if (!trashItems.length) frag.append(el('div', 'dc-msg', 'The trash is empty.'));
  else {
    for (const t of trashItems) {
      const r = el('div', 'dc-trow');
      const txt = el('div', 'dc-ttext');
      txt.append(el('span', 'dc-nm', `${t.dir ? '[DIR] ' : ''}${t.name}`), el('span', 'dc-hit-where', `${t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : 'TOP FOLDER'} · ${timeAgo(t.when).toUpperCase()}`));
      const b = button('RESTORE', () => {}, 'dc-restore');
      b.dataset.restore = t.id;
      b.title = `Put it back at ${t.path}`;
      r.append(txt, b);
      frag.append(r);
    }
    frag.append(el('div', 'dc-msg', 'Items stay here until you clear them out of the .retro-trash folder yourself.'));
  }
  listEl.replaceChildren(frag);
}

async function restoreItem(id: string): Promise<void> {
  try {
    const r = await api<{ path: string }>('restore', undefined, { id });
    toast(`Put back: ${r.path}`);
    revealPath(r.path);
    selected = r.path;
    trashItems = (trashItems ?? []).filter((t) => t.id !== id);
    refreshTree();
  } catch (e) {
    toast(errText(e), 6000);
  }
}

// ------------------------------------------------------------ open, edit

async function openDoc(path: string, at?: { line: number; q: string }, quiet = false): Promise<void> {
  if (doc?.path === path) {
    setSide(false);
    if (at) gotoLine(at.line, at.q);
    return;
  }
  if (!(await leaveDoc())) return;
  const token = ++openToken;
  selected = path;
  emptyEl.dataset.path = path;
  try {
    const f = await api<DocFile>('read', { path });
    if (token !== openToken) return;
    loadIntoEditor(f);
    pushRecent(path);
    revealPath(path);
    renderList();
    if (at) gotoLine(at.line, at.q);
  } catch (e) {
    if (token !== openToken) return;
    if (e instanceof ApiError && e.status === 404) dropRecent(path);
    if (quiet) {
      delete emptyEl.dataset.path;
      showEmpty();
      return;
    }
    showCannot(path, errText(e));
    renderList();
  }
}

function loadIntoEditor(f: DocFile): void {
  closeFind(false);
  conflictEl.hidden = true;
  doc = { path: f.path, etag: f.etag, saved: f.text, eol: f.eol, bom: f.bom, encoding: f.encoding, size: f.size, readonly: f.readonly, md: isMd(f.path), state: f.readonly ? 'readonly' : 'saved' };
  ed.value = f.text;
  forgetRich();
  ed.readOnly = f.readonly;
  ed.scrollTop = 0;
  ed.setSelectionRange(0, 0);
  editGen++;
  setNote(f.readonly ? 'READ ONLY: this folder is protected (PHOSPHOR_DOCS_READONLY in .env).' : '');
  renderDoc();
  setSide(false);
  if (isOpen && fine()) focusEditor();
}

// Header, panes, counts and preview for the open document.
function renderDoc(): void {
  if (!rootEl) return;
  rootEl.classList.toggle('dc-has-doc', !!doc);
  if (!doc) return;
  delete emptyEl.dataset.path;
  nameEl.textContent = nameOf(doc.path);
  nameEl.title = doc.path;
  setState(doc.state);
  renderFmt();
  updateCounts();
  applyView();
}

function renderFmt(): void {
  if (!doc) return;
  const kept = effView() === 'doc' && richKept?.kept ? `${richKept.kept} KEPT AS WRITTEN` : '';
  fmtEl.textContent = [doc.md ? 'MARKDOWN' : 'TEXT', kept, doc.encoding === 'utf-16le' ? 'UTF-16' : 'UTF-8', doc.eol === 'crlf' ? 'CRLF' : 'LF'].filter(Boolean).join(' · ');
  fmtEl.title = kept ? `Grey boxes (${richKept!.why.join(', ')}) are kept exactly as written. Change them in SOURCE.` : '';
}

function setState(s: SaveState): void {
  if (!doc) return;
  doc.state = s;
  stateEl.textContent = STATE_LABEL[s];
  stateEl.className = `dc-state dc-st-${s}`;
}

function setNote(text: string): void {
  noteEl.hidden = !text;
  noteEl.textContent = text;
}

function showEmpty(): void {
  if (!rootEl || doc) return;
  rootEl.classList.remove('dc-has-doc');
  nameEl.textContent = '';
  nameEl.title = '';
  stateEl.textContent = '';
  stateEl.className = 'dc-state';
  setNote('');
  const box = el('div', 'dc-empty-box');
  box.append(el('div', 'dc-empty-big', 'NO DOCUMENT OPEN.'), el('div', '', 'Pick one from the list, or start a new one:'));
  const row = el('div', 'dc-empty-btns');
  for (const t of TEMPLATES) row.append(button(`NEW ${t.label}`, () => void newDocBox(t.id)));
  box.append(row);
  if (info) box.append(el('div', 'dc-empty-where', `Docs folder: ${info.root}${info.exists ? '' : ' (made when you save the first document)'}. Change it with PHOSPHOR_DOCS_DIR in the app's .env file.`));
  emptyEl.replaceChildren(box);
}

function showCannot(path: string, why: string): void {
  doc = null;
  closeFind(false);
  conflictEl.hidden = true;
  rootEl!.classList.remove('dc-has-doc');
  nameEl.textContent = nameOf(path);
  nameEl.title = path;
  stateEl.textContent = "CAN'T EDIT";
  stateEl.className = 'dc-state dc-st-error';
  setNote('');
  const box = el('div', 'dc-empty-box');
  box.append(el('div', 'dc-empty-big', `CAN'T EDIT ${nameOf(path).toUpperCase()}`), el('div', '', why));
  emptyEl.replaceChildren(box);
  emptyEl.dataset.path = path;
  setSide(false);
}

// The text changed (typed in SOURCE, or the DOC view changed: then the text is written when needed).
function edited(): void {
  const d = doc;
  if (!d || d.readonly) return;
  editGen++;
  if (hitBox) hideHit();
  if (d.state !== 'conflict' && d.state !== 'dirty') setState('dirty');
  if (d.state === 'conflict') return;
  // Bigger files wait longer: each save sends the whole file.
  const delay = 1200 + Math.min(6000, Math.floor(d.size / 200_000) * 1000);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), delay);
  if (maxTimer === undefined) maxTimer = window.setTimeout(() => void save(), 15000);
  const big = d.size > 200_000;
  clearTimeout(countTimer);
  countTimer = window.setTimeout(updateCounts, big ? 800 : 250);
}

function onRichChange(): void {
  richDirty = true;
  edited();
}

// The file text as it is now: DOC view edits are written into the textarea first.
function fileText(): string {
  if (richDirty && rich) {
    const t = rich.text();
    if (t !== ed.value) ed.value = t;
    richText = t;
    richDirty = false;
  }
  return ed.value;
}

function updateCounts(): void {
  if (!doc) return;
  const t = fileText();
  let words = 0;
  let inWord = false;
  let lines = t.length ? 1 : 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    const space = c === 32 || c === 10 || c === 9 || c === 13 || c === 160 || c === 0x3000;
    if (c === 10) lines++;
    if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  countsEl.textContent = `${words.toLocaleString()} WORDS · ${lines.toLocaleString()} LINES · ${t.length.toLocaleString()} CHARS`;
}

// ------------------------------------------------------------ save, conflict

// Saves the open document if it changed; resolves when the disk has it (or it could not).
function save(): Promise<void> {
  if (saving) return saving.then(() => save());
  clearTimeout(saveTimer);
  clearTimeout(maxTimer);
  clearTimeout(retryTimer);
  maxTimer = undefined;
  const d = doc;
  if (!d || d.readonly || d.state === 'conflict') return Promise.resolve();
  const text = fileText();
  if (text === d.saved && d.etag !== null) {
    if (d.state !== 'saved') setState('saved');
    return Promise.resolve();
  }
  setState('saving');
  saving = (async () => {
    try {
      const r = await api<DocStat>('write', undefined, { path: d.path, text, etag: d.etag, eol: d.eol, bom: d.bom, encoding: d.encoding });
      d.etag = r.etag;
      d.saved = text;
      d.size = r.size;
      if (doc === d) setState(fileText() === text ? 'saved' : 'dirty');
      if (doc === d && d.state === 'dirty') saveTimer = window.setTimeout(() => void save(), 1200);
    } catch (e) {
      if (doc !== d) return;
      if (e instanceof ApiError && e.status === 409 && e.body?.conflict) showConflict(d, e.body as unknown as DocConflict);
      else {
        setState('error');
        stateEl.title = errText(e);
        if (!(e instanceof ApiError && (e.status === 403 || e.status === 413))) retryTimer = window.setTimeout(() => void save(), 5000);
        else toast(errText(e), 6000);
      }
    } finally {
      saving = null;
    }
  })();
  return saving;
}

// Before opening another document: the open one must be on disk (or the owner says leave it).
async function leaveDoc(): Promise<boolean> {
  const d = doc;
  if (!d || d.readonly) return true;
  await save();
  if (doc !== d) return true;
  if (d.state === 'conflict') {
    toast('Pick which version to keep first.');
    return false;
  }
  if (d.state === 'error') return confirmBox('NOT SAVED', `${nameOf(d.path)} could not be saved (${stateEl.title}). Leave it anyway? The last changes would be lost.`, 'LEAVE IT');
  return true;
}

function showConflict(d: Doc, c: DocConflict): void {
  setState('conflict');
  closeFind(false);
  const disk = c.conflict;
  const mine = fileText();
  const box = el('div', 'dc-c-box');
  const head = el('div', 'dc-c-head');
  head.append(
    el('div', 'dc-c-title', 'CONFLICT'),
    el(
      'div',
      'dc-c-text',
      disk.missing
        ? 'This document was moved or deleted on disk while you edited it.'
        : `This document changed on disk while you edited it (another device, Nextcloud or a program), ${timeAgo(disk.mtime)}. Pick the version to keep.`,
    ),
  );
  const cols = el('div', 'dc-c-cols');
  const mineLines = mine.split('\n');
  const diskText = !disk.missing ? disk.text : undefined;
  const diskLines = diskText?.split('\n') ?? [];
  const inDisk = new Set(diskLines);
  const inMine = new Set(mineLines);
  cols.append(column('YOURS (NOT SAVED)', mineLines, inDisk));
  if (disk.missing) cols.append(el('div', 'dc-c-col dc-c-gone', 'NOTHING ON DISK.\nThe file is gone from its folder.'));
  else if (diskText === undefined) cols.append(el('div', 'dc-c-col dc-c-gone', `ON DISK: ${fmtSize(disk.size)}, not text DOCS can show.`));
  else cols.append(column(`ON DISK (${timeAgo(disk.mtime).toUpperCase()})`, diskLines, inMine));
  const btns = el('div', 'dc-c-btns');
  const mineBtn = button('KEEP MINE', () => {
    d.etag = disk.missing ? null : disk.etag;
    conflictEl.hidden = true;
    setState('dirty');
    void save();
    focusEditor();
  }, 'primary');
  mineBtn.title = disk.missing ? 'Save your version at the same place again' : 'Save your version over the one on disk';
  btns.append(mineBtn);
  if (!disk.missing) {
    const diskBtn = button('KEEP DISK VERSION', () => void keepDisk(d, disk.etag, diskText));
    diskBtn.title = 'Drop your changes and load the version on disk';
    const both = button('KEEP BOTH', () => void keepBoth(d, mine, disk.etag, diskText));
    both.title = 'Save your version as a copy next to it, then load the version on disk';
    btns.append(diskBtn, both);
  } else {
    const drop = button('DROP MINE', () => {
      conflictEl.hidden = true;
      doc = null;
      showEmpty();
      renderList();
    });
    drop.title = 'Close it without saving';
    btns.append(drop);
  }
  box.append(head, cols, btns);
  conflictEl.replaceChildren(box);
  conflictEl.hidden = false;
  mineBtn.focus({ preventScroll: true });
}

// One side of the conflict: lines the other side lacks are marked. Big files: plain text, no marks.
function column(title: string, lines: string[], other: Set<string>): HTMLElement {
  const col = el('div', 'dc-c-col');
  col.append(el('div', 'dc-c-label', title));
  const body = el('div', 'dc-c-body');
  if (lines.length > 4000) body.append(el('div', 'dc-c-line', lines.join('\n')));
  else {
    const frag = document.createDocumentFragment();
    for (const l of lines) {
      const line = el('div', `dc-c-line${other.has(l) ? '' : ' dc-c-diff'}`, l || ' ');
      frag.append(line);
    }
    body.append(frag);
  }
  col.append(body);
  return col;
}

async function keepDisk(d: Doc, etag: string, text: string | undefined): Promise<void> {
  if (doc !== d) return;
  conflictEl.hidden = true;
  if (text === undefined) {
    doc = null;
    await openDoc(d.path);
    return;
  }
  d.etag = etag;
  d.saved = text;
  ed.value = text;
  forgetRich();
  editGen++;
  setState('saved');
  renderDoc();
  toast('Loaded the version on disk.');
}

async function keepBoth(d: Doc, mine: string, etag: string, text: string | undefined): Promise<void> {
  const dot = d.path.lastIndexOf('.');
  const base = dot > d.path.lastIndexOf('/') ? d.path.slice(0, dot) : d.path;
  const ext = dot > d.path.lastIndexOf('/') ? d.path.slice(dot) : '';
  const now = new Date();
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  for (let n = 1; n < 10; n++) {
    const path = `${base} (mine ${stamp}${n > 1 ? ` ${n}` : ''})${ext}`;
    try {
      await api('create', undefined, { path, kind: 'file', text: mine });
      toast(`Your version is saved as ${nameOf(path)}.`, 6000);
      refreshTree();
      await keepDisk(d, etag, text);
      return;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) return void toast(`Could not save a copy: ${errText(e)}`, 6000);
    }
  }
}

// The window is back in front: was the open file changed on disk meanwhile? Unchanged here: reload it
// quietly. Changed here too: save, which shows the conflict.
function onWindowFocus(): void {
  void checkDisk(false);
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    if (doc && !doc.readonly && fileText() !== doc.saved) void save();
  } else void checkDisk(false);
}

async function checkDisk(force: boolean): Promise<void> {
  const d = doc;
  if (!isOpen || !d || d.etag === null || saving || d.state === 'conflict' || document.hidden) return;
  if (!force && Date.now() - lastCheck < 2000) return;
  lastCheck = Date.now();
  let s: DocStat | null = null;
  try {
    s = await api<DocStat>('stat', { path: d.path });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) return;
  }
  if (doc !== d || saving || (d.state as SaveState) === 'conflict') return; // it may have changed while waiting
  if (s && s.etag === d.etag) return;
  if (!d.readonly && fileText() !== d.saved) return void save();
  if (!s) {
    setNote('This document is gone from its folder on disk (moved or deleted). Type to save it there again.');
    d.etag = null;
    return;
  }
  try {
    const f = await api<DocFile>('read', { path: d.path });
    if (doc !== d || fileText() !== d.saved) return;
    const top = ed.scrollTop;
    const caret = ed.selectionStart;
    loadIntoEditor(f);
    ed.scrollTop = top;
    ed.setSelectionRange(Math.min(caret, f.text.length), Math.min(caret, f.text.length));
    setNote('CHANGED ON DISK. RELOADED.');
    window.setTimeout(() => noteEl.textContent === 'CHANGED ON DISK. RELOADED.' && setNote(''), 5000);
  } catch {
    /* keep what is on screen */
  }
}

// ------------------------------------------------------------ view: DOC or SOURCE

function loadView(): View {
  try {
    if (localStorage.getItem(VIEW_KEY) === 'source') return 'source';
  } catch {
    /* storage blocked */
  }
  return 'doc';
}

// remember = false: a passing switch (find and replace needs SOURCE), not the owner's choice.
function setView(v: View, remember = true): void {
  if (remember) {
    view = v;
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* fine */
    }
  }
  if (v === 'source') fileText();
  shownView = v;
  applyView();
  if (rootEl && !rootEl.hidden && doc && fine()) focusEditor();
}

let shownView: View = view;

// The view on screen: DOC only for Markdown files the editor can carry.
function effView(): View {
  if (!doc) return shownView;
  return doc.md && !richOff ? shownView : 'source';
}

function applyView(): void {
  if (!rootEl) return;
  const v = effView();
  rootEl.dataset.view = v;
  for (const [k, b] of Object.entries(viewBtns) as [View, HTMLButtonElement][]) {
    b.classList.toggle('on', k === v);
    b.setAttribute('aria-pressed', String(k === v));
  }
  const noDoc = !!doc && (!doc.md || !!richOff);
  viewBtns.doc.disabled = noDoc;
  viewBtns.doc.title = !doc?.md && doc ? 'Plain text file: SOURCE only' : richOff ? `SOURCE only: this file ${richOff}.` : 'Edit it as a document: bold, lists, checkboxes, links';
  if (v === 'doc') hideHit();
  if (v === 'doc' && doc) richShown = showRich();
  renderFmt();
}

function forgetRich(): void {
  richText = null;
  richDirty = false;
  richOff = '';
  richKept = null;
  shownView = view;
}

function focusEditor(): void {
  if (effView() === 'doc') void richShown.then(() => effView() === 'doc' && rich?.focus());
  else ed.focus({ preventScroll: true });
}

// The editor's code loads the first time it is needed (its own file, so the app starts as fast as before).
function getRich(): Promise<DocEditor | null> {
  richLoad ??= import('./docs-editor.ts')
    .then(({ createDocEditor }) => {
      sessionStorage.removeItem('phosphor.docsReload');
      rich = createDocEditor({
        onChange: onRichChange,
        askLink: (cur) => textBox('LINK', 'ADDRESS', cur || 'https://', 'OK', 'Leave only https:// to remove the link. Ctrl+click a link to open it.').then((v) => (v === null ? null : v === 'https://' ? '' : v)),
        openSource: () => setView('source', false),
      });
      richHost.replaceChildren(rich.el);
      return rich;
    })
    .catch((e) => {
      richLoad = null;
      // The page is older than the last build (the app was updated while open): its editor file has a new name.
      // Reload once to get the new page, unless that would lose unsaved typing.
      const stale = /dynamically imported module|importing a module script failed/i.test(errText(e));
      const unsaved = doc?.state === 'dirty' || doc?.state === 'saving';
      if (stale && !unsaved && sessionStorage.getItem('phosphor.docsReload') !== '1') {
        sessionStorage.setItem('phosphor.docsReload', '1');
        location.reload();
        return null;
      }
      toast(`The document editor did not load: ${errText(e)}. ${stale ? 'The app was updated: press F5. ' : ''}Showing SOURCE.`, 6000);
      return null;
    });
  return richLoad;
}

// Load the file into DOC view if it is not showing it yet; files it cannot carry go to SOURCE with a note.
async function showRich(): Promise<void> {
  const d = doc;
  if (!d) return;
  const r = await getRich();
  if (doc !== d || effView() !== 'doc') return;
  if (!r) {
    shownView = 'source';
    return applyView();
  }
  if (richDirty || richText === ed.value) return;
  const text = ed.value;
  const res: LoadResult = text.length > BIG_FOR_DOC ? { ok: false, why: 'is big (SOURCE is faster)' } : r.load(text);
  if (!res.ok) {
    richOff = res.why;
    setNote(`SOURCE: this file ${res.why}. The document view would change it, so it opens as text.`);
    return applyView();
  }
  richText = text;
  richKept = res;
  r.setEditable(!d.readonly);
  renderFmt();
}

// Like md.ts, but single line breaks stay breaks (as in note apps: letters and addresses print right),
// and task boxes show as [ ] / [X] (input tags are not allowed through).
function renderDocMarkdown(text: string): string {
  const html = (marked.parse(text, { async: false, gfm: true, breaks: true }) as string).replace(/<input\b[^>]*>/g, (tag) =>
    /type="checkbox"/.test(tag) ? `<span class="dc-box">${/\bchecked\b/.test(tag) ? '[X]' : '[ ]'}</span>` : '',
  );
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'video', 'audio'] });
}

function onEdScroll(): void {
  if (hitBox) placeHit();
}

// ------------------------------------------------------------ find and replace

function buildFind(): HTMLElement {
  const bar = el('div', 'dc-find');
  bar.hidden = true;
  bar.setAttribute('role', 'search');
  findIn = el('input', 'dc-find-in');
  findIn.type = 'text';
  findIn.placeholder = 'Find';
  findIn.spellcheck = false;
  findIn.setAttribute('aria-label', 'Find');
  findIn.setAttribute('enterkeyhint', 'next');
  replIn = el('input', 'dc-repl-in');
  replIn.type = 'text';
  replIn.placeholder = 'Replace with';
  replIn.spellcheck = false;
  replIn.setAttribute('aria-label', 'Replace with');
  findCount = el('span', 'dc-count');
  findCount.setAttribute('aria-live', 'polite');
  caseBtn = button('CASE', () => {
    matchCase = !matchCase;
    caseBtn.classList.toggle('on', matchCase);
    caseBtn.setAttribute('aria-pressed', String(matchCase));
    refind(true);
  }, 'dc-case');
  caseBtn.title = 'Match upper and lower case';
  caseBtn.setAttribute('aria-pressed', 'false');
  const prev = button('PREV', () => step(-1));
  prev.title = 'Previous (Shift+Enter)';
  const next = button('NEXT', () => step(1));
  next.title = 'Next (Enter)';
  const one = button('REPLACE', replaceOne);
  const all = button('ALL', replaceAll);
  all.title = 'Replace all';
  const done = button('CLOSE', () => closeFind(true), 'dc-find-close');
  done.title = 'Close (Esc)';
  const r1 = el('div', 'dc-find-row');
  r1.append(findIn, findCount, prev, next, caseBtn);
  const r2 = el('div', 'dc-find-row');
  r2.append(replIn, one, all, done);
  bar.append(r1, r2);
  let t: number | undefined;
  findIn.addEventListener('input', () => {
    clearTimeout(t);
    t = window.setTimeout(() => refind(true), ed.textLength > 200_000 ? 300 : 80);
  });
  findIn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  });
  replIn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    replaceOne();
  });
  return bar;
}

function openFind(): void {
  if (!doc) return void toast('Open a document first.');
  if (effView() === 'doc') setView('source', false); // find and replace works on the text
  findBar.hidden = false;
  const sel = ed.value.slice(ed.selectionStart, ed.selectionEnd);
  if (sel && !sel.includes('\n') && sel.length < 200) findIn.value = sel;
  findIn.focus();
  findIn.select();
  refind(false);
}

function closeFind(focusEditor: boolean): void {
  if (!findBar || findBar.hidden) return;
  findBar.hidden = true;
  hideHit();
  if (focusEditor && doc) {
    const s = cur >= 0 ? matches[cur] : -1;
    ed.focus({ preventScroll: true });
    if (s >= 0) ed.setSelectionRange(s, s + findIn.value.length);
  }
}

function computeMatches(): void {
  const q = findIn.value;
  const key = `${editGen}|${matchCase}|${q}`;
  if (key === matchesKey) return;
  matchesKey = key;
  matches = [];
  if (!q) return;
  const hay = matchCase ? ed.value : ed.value.toLowerCase();
  const needle = matchCase ? q : q.toLowerCase();
  for (let i = hay.indexOf(needle); i >= 0 && matches.length < MAX_MATCHES; i = hay.indexOf(needle, i + needle.length)) matches.push(i);
}

// The query changed: go to the first match at or after the cursor.
function refind(jump: boolean): void {
  computeMatches();
  const from = ed.selectionStart;
  cur = matches.length ? Math.max(0, matches.findIndex((m) => m >= from)) : -1;
  if (cur < 0 && matches.length) cur = 0;
  showCount();
  if (jump && cur >= 0) gotoMatch();
  else if (!matches.length) hideHit();
}

function step(dir: 1 | -1): void {
  computeMatches();
  if (!matches.length) {
    showCount();
    return;
  }
  if (cur < 0) cur = 0;
  else cur = (cur + dir + matches.length) % matches.length;
  showCount();
  gotoMatch();
}

function showCount(): void {
  const q = findIn.value;
  findCount.textContent = !q ? '' : matches.length ? `${cur + 1} OF ${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''}` : 'NONE';
}

function gotoMatch(): void {
  const s = matches[cur];
  const len = findIn.value.length;
  ed.setSelectionRange(s, s + len);
  showRange(s, s + len);
}

// Scroll the editor to a range and box it. The textarea neither shows nor scrolls to its selection while
// the keyboard is elsewhere (the find box), so a hidden copy of the text measures where the range sits.
function showRange(start: number, end: number): void {
  const box = measure(start, end);
  if (!box) return;
  const want = box.top - ed.clientHeight / 3;
  if (box.top < ed.scrollTop + 8 || box.top + box.height > ed.scrollTop + ed.clientHeight - 8) ed.scrollTop = Math.max(0, want);
  hitBox = box;
  placeHit();
}

function measure(start: number, end: number): { top: number; left: number; width: number; height: number } | null {
  if (!ed.clientWidth) return null;
  if (!mirror) {
    mirror = el('div', 'dc-mirror');
    mirror.setAttribute('aria-hidden', 'true');
    panes.append(mirror);
  }
  const cs = getComputedStyle(ed);
  const m = mirror.style;
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'lineHeight', 'tabSize', 'textTransform', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'] as const) {
    m[p] = cs[p];
  }
  m.width = `${ed.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`;
  const text = ed.value;
  mirror.textContent = text.slice(0, start);
  const mark = el('span', '', text.slice(start, end) || ' ');
  mirror.append(mark);
  const box = { top: mark.offsetTop, left: mark.offsetLeft, width: Math.max(mark.offsetWidth, 4), height: mark.offsetHeight };
  mirror.textContent = '';
  return box;
}

function placeHit(): void {
  if (!hitBox) return;
  const top = ed.offsetTop + hitBox.top - ed.scrollTop;
  const visible = top >= ed.offsetTop - 2 && top + hitBox.height <= ed.offsetTop + ed.clientHeight + 2;
  hitEl.hidden = !visible;
  hitEl.style.transform = `translate(${ed.offsetLeft + hitBox.left - ed.scrollLeft}px, ${top}px)`;
  hitEl.style.width = `${hitBox.width}px`;
  hitEl.style.height = `${hitBox.height}px`;
}

function hideHit(): void {
  hitBox = null;
  if (hitEl) hitEl.hidden = true;
}

// Typed text goes through insertText where the browser has it, so Ctrl+Z can undo a replace.
function replaceRange(start: number, end: number, text: string): void {
  ed.focus({ preventScroll: true });
  ed.setSelectionRange(start, end);
  let done = false;
  try {
    done = document.execCommand('insertText', false, text);
  } catch {
    done = false;
  }
  if (!done) {
    ed.setRangeText(text, start, end, 'end');
    edited();
  }
}

function replaceOne(): void {
  if (!doc || doc.readonly) return;
  computeMatches();
  if (cur < 0 || !matches.length) return void showCount();
  const s = matches[cur];
  const q = findIn.value;
  const top = ed.scrollTop;
  replaceRange(s, s + q.length, replIn.value);
  ed.scrollTop = top;
  computeMatches();
  const after = s + replIn.value.length;
  cur = matches.findIndex((m) => m >= after);
  if (cur < 0) cur = matches.length ? 0 : -1;
  showCount();
  if (cur >= 0) gotoMatch();
  else hideHit();
  replIn.focus();
}

function replaceAll(): void {
  if (!doc || doc.readonly) return;
  computeMatches();
  const n = matches.length;
  if (!n) return void showCount();
  const q = findIn.value;
  const text = ed.value;
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += text.slice(last, m) + replIn.value;
    last = m + q.length;
  }
  out += text.slice(last);
  const top = ed.scrollTop;
  replaceRange(0, text.length, out);
  ed.scrollTop = top;
  hideHit();
  refind(false);
  toast(`Replaced ${n}${n >= MAX_MATCHES ? ' (the first ' + MAX_MATCHES + ')' : ''}.`);
  replIn.focus();
}

// Search results: open at a line, the hit boxed.
function gotoLine(line: number, q: string): void {
  let at = 0;
  for (let n = 1; n < line && at >= 0; n++) at = ed.value.indexOf('\n', at) + 1;
  if (at < 0) return;
  const end = ed.value.indexOf('\n', at);
  const lineText = ed.value.slice(at, end < 0 ? undefined : end);
  const i = q ? lineText.toLowerCase().indexOf(q.toLowerCase()) : -1;
  const s = at + Math.max(0, i);
  const e = i >= 0 ? s + q.length : s;
  if (effView() === 'doc') {
    // DOC view: the hit in the block that holds that line; else SOURCE at the line.
    void richShown.then(() => {
      if (effView() === 'doc' && rich && !richDirty && richText === ed.value && rich.goto(at, i >= 0 ? q : '')) return;
      setView('source', false);
      gotoLine(line, q);
    });
    return;
  }
  requestAnimationFrame(() => {
    ed.focus({ preventScroll: true });
    ed.setSelectionRange(s, e);
    showRange(s, e);
  });
}

// ------------------------------------------------------------ new, rename, delete

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const longDay = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

// "|" marks where the cursor goes.
const TEMPLATES: Template[] = [
  { id: 'note', label: 'NOTE', name: () => `Note ${isoDay()}`, text: () => `# Note\n\n${longDay()}\n\n|\n` },
  {
    id: 'letter',
    label: 'LETTER',
    name: () => `Letter ${isoDay()}`,
    text: () => `Your name\nYour street\nYour town and postcode\n\n${longDay()}\n\nTheir name\nTheir street\nTheir town and postcode\n\nDear |,\n\n\n\nKind regards,\n\nYour name\n`,
  },
  { id: 'list', label: 'LIST', name: () => `List ${isoDay()}`, text: () => `# List\n\n- [ ] |\n- [ ] \n- [ ] \n` },
  { id: 'blank', label: 'BLANK', name: () => 'Untitled', text: () => '|' },
];

// The folder new things go in: the picked folder, else the picked or open file's folder, else the top.
function targetFolder(): string {
  const p = selected ?? doc?.path ?? '';
  if (!p) return '';
  const d = findEntry(p);
  if (d?.kind === 'dir') return p;
  return parentOf(p);
}

function findEntry(path: string): DocEntry | undefined {
  const d = dirs.get(parentOf(path));
  return d?.status === 'ok' ? d.list.entries.find((e) => e.path === path) : undefined;
}

type Field = { input: HTMLInputElement; extra?: HTMLElement };

// A themed box with one text field. Resolves the typed text, or null for CANCEL / Esc.
function textBox(title: string, label: string, value: string, okLabel: string, hint: string, extra?: (f: Field) => HTMLElement, selectTo?: number): Promise<string | null> {
  return new Promise((resolve) => {
    const d = el('dialog', 'dc-dlg');
    const form = el('form', 'dc-dlg-form');
    form.method = 'dialog';
    const input = el('input', 'dc-dlg-in');
    input.type = 'text';
    input.value = value;
    input.spellcheck = false;
    input.setAttribute('aria-label', label);
    const lab = el('label', 'dc-dlg-label');
    lab.append(el('span', '', label), input);
    const field: Field = { input };
    const parts: HTMLElement[] = [];
    if (extra) parts.push(extra(field));
    parts.push(lab);
    if (hint) parts.push(el('div', 'dc-dlg-hint', hint));
    const row = el('div', 'buttons');
    const ok = el('button', 'primary', okLabel);
    ok.type = 'submit';
    row.append(ok, button('CANCEL', () => done(null)));
    form.append(...parts, row);
    d.append(el('h2', '', title), form);
    let settled = false;
    const done = (v: string | null) => {
      if (settled) return;
      settled = true;
      d.close();
      d.remove();
      resolve(v);
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (v) done(v);
    });
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    document.body.append(d);
    d.showModal();
    input.focus();
    input.setSelectionRange(0, selectTo ?? input.value.length);
  });
}

async function newDocBox(templateId = 'note'): Promise<void> {
  build();
  if (!isOpen) openDocs();
  let tpl = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
  const folder = targetFolder();
  let typed = false;
  const name = await textBox(
    'NEW DOCUMENT',
    'NAME',
    tpl.name(),
    'MAKE IT',
    `In: ${folder || 'the top of the docs folder'}. Ends in .md unless you type .txt. Type a folder too to make one (work/report).`,
    (f) => {
      const row = el('div', 'dc-tpls');
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Template');
      const btns = TEMPLATES.map((t) => {
        const b = button(t.label, () => {
          tpl = t;
          for (const x of btns) x.classList.toggle('on', x === b);
          if (!typed) f.input.value = t.name();
          f.input.focus();
          f.input.select();
        });
        b.classList.toggle('on', t === tpl);
        return b;
      });
      row.append(...btns);
      f.input.addEventListener('input', () => (typed = true));
      return row;
    },
  );
  if (!name) return;
  let base = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!/\.(md|markdown|txt|text)$/i.test(base)) base += '.md';
  const raw = tpl.text();
  const caret = Math.max(0, raw.indexOf('|'));
  const text = raw.replace('|', '');
  const join = (n: string) => (folder ? `${folder}/${n}` : n);
  for (let n = 1; n < 10; n++) {
    const path = join(n === 1 ? base : base.replace(/(\.[^.]+)$/, ` ${n}$1`));
    try {
      await api('create', undefined, { path, kind: 'file', text });
      if (!info?.exists) void loadInfo();
      revealPath(path);
      refreshTree();
      await openDoc(path);
      if (doc?.path === path) {
        if (effView() === 'doc') void richShown.then(() => rich?.goto(caret >= text.trimEnd().length ? -1 : caret, ''));
        else {
          ed.focus();
          ed.setSelectionRange(caret, caret);
        }
      }
      return;
    } catch (e) {
      // The made-up name is taken: try "Note 2026-10-12 2". A name the owner typed: say so.
      if (e instanceof ApiError && e.status === 409 && !typed) continue;
      toast(errText(e), 6000);
      return;
    }
  }
}

async function newFolderBox(): Promise<void> {
  const folder = targetFolder();
  const name = await textBox('NEW FOLDER', 'NAME', '', 'MAKE IT', `In: ${folder || 'the top of the docs folder'}.`);
  if (!name) return;
  const path = folder ? `${folder}/${name}` : name;
  try {
    await api('create', undefined, { path, kind: 'folder' });
    if (!info?.exists) void loadInfo();
    revealPath(`${path}/x`);
    selected = path;
    refreshTree();
  } catch (e) {
    toast(errText(e), 6000);
  }
}

async function renameBox(): Promise<void> {
  const from = selected ?? doc?.path;
  if (!from) return;
  const dot = from.lastIndexOf('.');
  const selectTo = dot > from.lastIndexOf('/') ? dot : from.length;
  const to = await textBox('RENAME OR MOVE', 'NEW NAME', from, 'RENAME', 'Change the folder part to move it (new folders are made).', undefined, selectTo);
  if (!to || to === from) return;
  const dest = to.replace(/\\/g, '/').replace(/^\/+/, '');
  const isOpenDoc = doc && (doc.path === from || doc.path.startsWith(`${from}/`));
  if (isOpenDoc) await save();
  try {
    const r = await api<{ path: string }>('move', undefined, { from, to: dest });
    if (doc && isOpenDoc) {
      doc.path = r.path + doc.path.slice(from.length);
      doc.md = isMd(doc.path);
      renderDoc();
    }
    renamePrefix(from, r.path);
    selected = r.path;
    revealPath(r.path);
    refreshTree();
    toast(`Now: ${r.path}`);
  } catch (e) {
    toast(errText(e), 6000);
  }
}

async function deleteSelected(): Promise<void> {
  const path = selected ?? doc?.path;
  if (!path) return;
  const ok = await confirmBox('MOVE TO TRASH', `${nameOf(path)} goes to the docs TRASH. You can put it back from there.`, 'MOVE TO TRASH');
  if (!ok) return;
  const hitsDoc = doc && (doc.path === path || doc.path.startsWith(`${path}/`));
  if (hitsDoc) await save();
  try {
    await api('delete', undefined, { path });
    if (hitsDoc) {
      doc = null;
      showEmpty();
    }
    dropRecentPrefix(path);
    selected = null;
    refreshTree();
    toast(`${nameOf(path)} is in TRASH.`);
  } catch (e) {
    toast(errText(e), 6000);
  }
}

// ------------------------------------------------------------ print, ask

function printDoc(): void {
  if (!doc) return void toast('Open a document to print it.');
  preparePrint();
  window.print();
}

// The print copy: just the document, black on white (docs.css @media print).
function preparePrint(): void {
  if (!doc) return;
  const text = fileText();
  if (doc.md) {
    const art = el('article', 'dp-md');
    art.innerHTML = renderDocMarkdown(text);
    printEl.replaceChildren(art);
  } else printEl.replaceChildren(el('pre', 'dp-plain', text));
  document.documentElement.classList.add('docs-printing');
  oldTitle = document.title;
  document.title = nameOf(doc.path).replace(/\.[^.]+$/, ''); // the PDF's file name and the page header
}

function endPrint(): void {
  if (!document.documentElement.classList.contains('docs-printing')) return;
  document.documentElement.classList.remove('docs-printing');
  printEl.replaceChildren();
  if (oldTitle) document.title = oldTitle;
}

// The document's path in the message box (same @path style as the file explorer), cursor after it. Never sends.
async function askClaude(): Promise<void> {
  if (!doc || !info) return void toast('Open a document first.');
  await save();
  const abs = info.root.replace(/[\\/]+$/, '') + info.sep + doc.path.split('/').join(info.sep);
  const cwd = store.current()?.info.cwd;
  const p = cwd ? shortPath(abs, cwd) : abs.replaceAll('\\', '/');
  const ref = /\s/.test(p) ? `@"${p}"` : `@${p}`;
  closeDocs();
  opts.showChat?.();
  document.body.classList.remove('show-left', 'show-right');
  opts.insertIntoChat(ref);
  document.getElementById('input')?.dispatchEvent(new Event('input')); // saves the draft, sizes the box
}

// ------------------------------------------------------------ keys

function onKey(e: KeyboardEvent): void {
  if (!isOpen || e.isComposing) return;
  if (document.querySelector('dialog[open]')) return; // a box has the keyboard
  const k = e.key.toLowerCase();
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
  let handled = true;
  if (mod && k === 's') {
    if (doc && !doc.readonly) {
      void save().then(() => doc?.state === 'saved' && toast('Saved.', 1500));
    }
  } else if (mod && k === 'f') openFind();
  else if (mod && k === 'p') printDoc();
  else if (k === 'escape') handled = onEscape(e);
  else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

// Esc closes the innermost thing; in the editor it first leaves the editor, so a stray Esc never closes DOCS.
function onEscape(e: KeyboardEvent): boolean {
  if (!conflictEl.hidden) return true;
  if (!findBar.hidden) {
    closeFind(true);
    return true;
  }
  if (mode !== 'tree' && (e.target === searchIn || listEl.contains(e.target as Node) || narrow())) {
    backToTree();
    return true;
  }
  if (e.target === ed || rich?.isIn(e.target as Node)) {
    (e.target as HTMLElement).blur();
    rootEl!.focus({ preventScroll: true });
    return true;
  }
  if (e.target === searchIn && searchIn.value) {
    backToTree();
    return true;
  }
  if (narrow() && rootEl!.classList.contains('dc-show-side') && doc) {
    setSide(false);
    return true;
  }
  closeDocs();
  return true;
}

// ------------------------------------------------------------ recent + launcher

function recent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    /* fine */
  }
  syncRecentCommands();
}

const pushRecent = (path: string) => saveRecent([path, ...recent().filter((p) => p !== path)]);
const dropRecent = (path: string) => saveRecent(recent().filter((p) => p !== path));
const dropRecentPrefix = (path: string) => saveRecent(recent().filter((p) => p !== path && !p.startsWith(`${path}/`)));
const renamePrefix = (from: string, to: string) => saveRecent(recent().map((p) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)));

function registerCommands(): void {
  opts.addCommands?.([
    { id: 'docs', label: 'DOCS', hint: 'Documents: notes, letters, lists', keywords: ['documents', 'notes', 'write', 'text', 'editor', 'markdown', 'files'], run: () => openDocs() },
    { id: 'docs-new', label: 'NEW DOCUMENT', hint: 'Note, letter, list or blank', keywords: ['docs', 'write', 'note', 'letter', 'list', 'create'], run: newDocument },
  ]);
  syncRecentCommands();
}

let recentIds: string[] = [];
function syncRecentCommands(): void {
  if (!opts.addCommands) return;
  const list = recent();
  const ids = list.map((p) => `docs-recent:${p}`);
  const gone = recentIds.filter((id) => !ids.includes(id));
  if (gone.length) opts.removeCommands?.(gone);
  recentIds = ids;
  opts.addCommands(
    list.map((p) => ({
      id: `docs-recent:${p}`,
      label: nameOf(p),
      hint: `DOC · ${parentOf(p) || 'DOCS FOLDER'}`,
      keywords: ['docs', 'document', p],
      run: () => openDocs(p),
    })),
  );
}

// ------------------------------------------------------------ helpers

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

const isMd = (path: string) => /\.(md|markdown|mdown)$/i.test(path);

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
