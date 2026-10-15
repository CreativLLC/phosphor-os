import './launcher.css';
import type { FilesFindResponse, HistoryEntry, SlashCommandInfo } from '../../shared/protocol.ts';
import { insertIntoChat } from './chat.ts';
import { openViewer } from './files.ts';
import { loadHistory, openHistoryEntry } from './history.ts';
import { openMcp } from './mcp.ts';
import { programList, showChat } from './programs.ts';
import { getSettings, setSetting, type Settings } from './settings.ts';
import { THEMES } from './themes.ts';
import { shellApi, type Game, type InstalledApp } from './shellapi.ts';
import { commands as slashCommands, setInput } from './slash.ts';
import { store } from './store.ts';
import { openNewTab } from './tabs.ts';
import { openUsage } from './usage.ts';
import { button, el, folderName, timeAgo, toast } from './ui.ts';

// LAUNCHER: one full-screen prompt for everything. Ctrl+K, the LAUNCH button (MENU > LAUNCH on phones), or the
// desktop app's 'launcher' command (Ctrl+Alt+Space on Windows, the Super key on Linux).
// Type to filter (fuzzy, best first). Up/Down, PageUp/PageDown move; Tab jumps to the next group; Enter or a
// tap runs; Esc closes. Prefixes: "run <name>" programs and games, "chat <name>", "open <file>", ">" commands
// only, "/" Claude Code's slash commands. Known commands never go to Claude: only the ASK CLAUDE row puts
// text in the message box, and nothing is ever sent from here.
// Groups: PROGRAMS (the program bar), INSTALLED and GAMES (desktop app only: shell/installed.mjs), CHATS,
// FILES (GET /api/files/find in the chat's folder), COMMANDS (app actions, other parts' commands, slash
// commands), ASK CLAUDE. Picks are remembered (localStorage) and rank higher.
// Speed: lists are cached in the page; opening draws from the cache at once and refreshes in the background.

export type LauncherCommand = { id: string; label: string; hint?: string; keywords?: string[]; run(): void };

type SectionId = 'recent' | 'programs' | 'installed' | 'games' | 'chats' | 'files' | 'commands' | 'ask';
type Mode = 'all' | 'run' | 'chat' | 'open' | 'cmd' | 'slash';
type Entry = {
  key: string; // stable: what "recent" remembers
  sec: SectionId;
  label: string;
  hint?: string;
  words?: string; // more text to match (keywords, folder)
  icon?: string;
  remember?: false;
  run: () => void;
};
type Shown = { entry: Entry; score: number };
type Section = { id: SectionId; rows: Shown[]; more: number; best: number; note?: string };

const TITLES: Record<SectionId, string> = {
  recent: 'RECENT',
  programs: 'PROGRAMS',
  installed: 'INSTALLED',
  games: 'GAMES',
  chats: 'CHATS',
  files: 'FILES',
  commands: 'COMMANDS',
  ask: 'ASK CLAUDE',
};
const MODE_SECTIONS: Record<Mode, SectionId[]> = {
  all: ['programs', 'installed', 'games', 'chats', 'files', 'commands'],
  run: ['programs', 'installed', 'games'],
  chat: ['chats'],
  open: ['files', 'commands'], // commands: only the ones that open something (STATION services, documents)
  cmd: ['commands'],
  slash: ['commands'],
};
// Rows per group while searching everything; a prefix (run, chat, ...) shows more.
const CAP: Record<SectionId, number> = { recent: 8, programs: 6, installed: 8, games: 6, chats: 6, files: 8, commands: 8, ask: 1 };
const CAP_ONE_GROUP = 60;
const RECENT_KEY = 'phosphor.launcher.recent';
const MAX_RECENT = 40;
const STALE_MS = 60 * 1000; // history and slash commands: ask again on open after this

let dlg: HTMLDialogElement | null = null;
let input: HTMLInputElement;
let mirror: { pre: Text; cur: HTMLElement; post: Text; ph: HTMLElement; box: HTMLElement };
let listEl: HTMLElement;
let chipsEl: HTMLElement;
let footEl: HTMLElement;
let launchBtn: HTMLElement | null = null;

let shown: Entry[] = []; // selectable rows, in screen order
let sectionStarts: number[] = [];
let pick = 0;
let lastQuery = '\u0000';

// Page caches (filled in the background; never waited on to open).
const extra = new Map<string, LauncherCommand>();
let installed: InstalledApp[] = [];
let games: Game[] = [];
let history: HistoryEntry[] = [];
let historyAt = 0;
let slash: { tab: string; list: SlashCommandInfo[] } = { tab: '', list: [] };
let files: { tab: string; q: string; results: FilesFindResponse['results']; truncated: boolean } = { tab: '', q: '', results: [], truncated: false };
let filesTimer: ReturnType<typeof setTimeout> | undefined;
let filesAbort: AbortController | null = null;
let filesWaiting = false;

// ------------------------------------------------------------ public

// Other parts add their own commands (the lead wires them in). Same id again replaces the old one.
export function addLauncherCommands(cmds: LauncherCommand[]): void {
  for (const c of cmds) if (c && typeof c.id === 'string' && typeof c.run === 'function') extra.set(c.id, c);
  if (isOpen()) update(true);
}

// Take back commands added before (a recent document left the list). Unknown ids are ignored.
export function removeLauncherCommands(ids: string[]): void {
  for (const id of ids) extra.delete(id);
  if (isOpen()) update(true);
}

export function openLauncher(): void {
  build();
  const d = dlg!;
  if (d.open) {
    focusInput();
    input.select();
    return;
  }
  input.value = '';
  lastQuery = '\u0000';
  update(false);
  d.showModal();
  // A phone keyboard would cover half the list: on touch, typing starts with a tap on the prompt.
  if (matchMedia('(pointer: fine)').matches) focusInput();
  else listEl.focus({ preventScroll: true });
  syncMirror();
  window.addEventListener('keydown', onKey, true);
  launchBtn?.classList.add('on');
  void refreshData();
}

export function closeLauncher(): void {
  if (!dlg?.open) return;
  dlg.close();
  stopListening();
}

// Right away, not on the dialog's 'close' event: that comes later, maybe after the launcher opened again.
function stopListening(): void {
  window.removeEventListener('keydown', onKey, true);
  filesAbort?.abort();
  clearTimeout(filesTimer);
  launchBtn?.classList.remove('on');
}

// Ctrl+K, the LAUNCH button and the desktop app's command. Call once from main.ts.
export function mountLauncher(btn: HTMLElement | null): void {
  launchBtn = btn;
  if (btn) btn.onclick = () => (isOpen() ? closeLauncher() : openLauncher());
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key.toLowerCase() !== 'k' || !e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.isComposing || isOpen()) return;
      if (document.querySelector('dialog[open]')) return; // a box is asking something first (like Ctrl+1..9)
      e.preventDefault();
      openLauncher();
    },
    true,
  );
  // The shell sends 'launcher' for its own hotkey: open, or close when it is already open in front of you.
  shellApi?.onCommand((c) => {
    if (c === 'docs' && isOpen()) closeLauncher(); // DOCS asked for from outside: nothing in front of it
    if (c !== 'launcher') return;
    if (isOpen() && document.hasFocus()) closeLauncher();
    else openLauncher();
  });
  // First lists in the background, so the first open is already full.
  if (shellApi?.installed) setTimeout(() => void refreshShell(), 4000);
}

const isOpen = () => !!dlg?.open;

// ------------------------------------------------------------ DOM

function build(): void {
  if (dlg) return;
  dlg = el('dialog', 'launcher');
  dlg.setAttribute('aria-label', 'Launcher');
  const inner = el('div', 'ln-inner');

  const bar = el('div', 'ln-bar');
  chipsEl = el('div', 'ln-chips');
  const close = button('CLOSE', closeLauncher, 'ln-close');
  close.title = 'Close (Esc)';
  bar.append(el('span', 'ln-tag', 'LAUNCH'), chipsEl, close);

  const prompt = el('label', 'ln-prompt');
  const field = el('span', 'ln-field');
  const box = el('span', 'ln-mirror');
  box.setAttribute('aria-hidden', 'true');
  const pre = document.createTextNode('');
  const cur = el('span', 'ln-cur');
  const post = document.createTextNode('');
  const ph = el('span', 'ln-ph');
  ph.append(el('span', 'ln-ph-long', 'TYPE A NAME, A FILE, A COMMAND OR A QUESTION'), el('span', 'ln-ph-short', 'SEARCH OR ASK'));
  box.append(pre, cur, post, ph);
  mirror = { pre, cur, post, ph, box };
  input = el('input', 'ln-input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('enterkeyhint', 'go');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'ln-list');
  input.setAttribute('aria-label', 'Search programs, chats, files and commands');
  field.append(box, input);
  prompt.append(el('span', 'ln-ps', '>'), field);

  listEl = el('div', 'ln-list');
  listEl.id = 'ln-list';
  listEl.tabIndex = -1;
  listEl.setAttribute('role', 'listbox');

  footEl = el('div', 'ln-foot');
  inner.append(bar, prompt, listEl, footEl);
  dlg.append(inner);
  document.body.append(dlg);

  input.addEventListener('input', () => {
    update(false);
    syncMirror();
  });
  for (const ev of ['keyup', 'select', 'pointerup', 'focus', 'blur']) input.addEventListener(ev, syncMirror);
  input.addEventListener('scroll', syncMirror);
  // Hover picks (only a real mouse move: a scroll under a still pointer does not), click or tap runs.
  listEl.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const i = rowIndex(e.target);
    if (i !== null && i !== pick) select(i, false);
  });
  listEl.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-prefix]');
    if (chip) return setQuery(chip.dataset.prefix!);
    const i = rowIndex(e.target);
    if (i !== null) run(i);
  });
  chipsEl.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-prefix]');
    if (chip) setQuery(chip.dataset.prefix!);
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault(); // Esc is handled in onKey; this is the browser's own close request
    closeLauncher();
  });
  dlg.addEventListener('close', () => {
    if (!dlg!.open) stopListening(); // closed some other way
  });
  // A tap on the empty screen around the list closes, like the other overlays.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeLauncher();
  });
}

function focusInput(): void {
  input.focus({ preventScroll: true });
}

function rowIndex(t: EventTarget | null): number | null {
  const r = (t as HTMLElement | null)?.closest?.<HTMLElement>('.ln-row');
  return r?.dataset.i ? Number(r.dataset.i) : null;
}

function setQuery(text: string): void {
  input.value = text;
  focusInput();
  input.setSelectionRange(text.length, text.length);
  update(false);
  syncMirror();
}

// The prompt draws its own text with a block cursor (steps() blink); the real input lies on top, see-through.
function syncMirror(): void {
  if (!dlg) return;
  const v = input.value;
  const focused = document.activeElement === input;
  const at = focused ? (input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd) ?? v.length : v.length;
  mirror.pre.data = v.slice(0, at);
  const ch = v.charAt(at);
  mirror.cur.textContent = ch || ' ';
  mirror.cur.dataset.ch = ch || ' ';
  mirror.post.data = v.slice(at + 1);
  mirror.ph.hidden = v.length > 0;
  mirror.cur.classList.toggle('idle', !focused);
  // Same scroll as the input, plus enough to keep the block cursor in view at the end of a long line.
  const box = mirror.box;
  box.scrollLeft = input.scrollLeft;
  const over = mirror.cur.offsetLeft + mirror.cur.offsetWidth - (box.scrollLeft + box.clientWidth);
  if (over > 0) box.scrollLeft += over;
}

// ------------------------------------------------------------ keys

function onKey(e: KeyboardEvent): void {
  if (!isOpen() || e.isComposing) return;
  // A box opened on top of the launcher has the keyboard: leave its keys alone.
  const other = (document.activeElement as HTMLElement | null)?.closest('dialog[open]');
  if (other && other !== dlg) return;
  const k = e.key;
  let handled = true;
  if (k === 'Escape') closeLauncher();
  else if (k === 'ArrowDown') move(1);
  else if (k === 'ArrowUp') move(-1);
  else if (k === 'PageDown') move(pageSize());
  else if (k === 'PageUp') move(-pageSize());
  else if (k === 'Tab') jumpSection(e.shiftKey ? -1 : 1);
  else if (k === 'Enter') run(pick);
  else if (k.toLowerCase() === 'k' && e.ctrlKey && !e.altKey && !e.shiftKey) closeLauncher();
  else {
    handled = false;
    // Typing while the list has the focus (after a tap): the letters go to the prompt.
    if (document.activeElement !== input && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) focusInput();
  }
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function move(by: number): void {
  if (!shown.length) return;
  let i = pick + by;
  if (Math.abs(by) === 1) i = (i + shown.length) % shown.length; // arrows wrap; pages stop at the ends
  else i = Math.max(0, Math.min(shown.length - 1, i));
  select(i, true);
}

function jumpSection(dir: 1 | -1): void {
  if (!sectionStarts.length) return;
  let s = sectionStarts.findLastIndex((start) => start <= pick);
  s = (s + dir + sectionStarts.length) % sectionStarts.length;
  select(sectionStarts[s], true);
}

function pageSize(): number {
  const row = listEl.querySelector<HTMLElement>('.ln-row');
  return row ? Math.max(1, Math.floor(listEl.clientHeight / row.offsetHeight) - 1) : 8;
}

function select(i: number, scroll: boolean): void {
  const old = listEl.querySelector('.ln-row.on');
  old?.classList.remove('on');
  old?.setAttribute('aria-selected', 'false');
  pick = i;
  const row = listEl.querySelector<HTMLElement>(`.ln-row[data-i="${i}"]`);
  if (!row) return input.removeAttribute('aria-activedescendant');
  row.classList.add('on');
  row.setAttribute('aria-selected', 'true');
  input.setAttribute('aria-activedescendant', row.id);
  if (scroll) {
    // The group's title stays in view when its first row is picked.
    const target = i === 0 ? listEl.firstElementChild : sectionStarts.includes(i) ? row.parentElement?.firstElementChild : row;
    (target as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    row.scrollIntoView({ block: 'nearest' });
  }
}

// ------------------------------------------------------------ run

function run(i: number): void {
  const e = shown[i];
  if (!e) return;
  if (e.remember !== false) remember(e.key);
  closeLauncher();
  // After the click that picked it has finished (main.ts closes MENU on clicks outside it).
  setTimeout(() => {
    try {
      e.run();
    } catch {
      toast(`Could not run ${e.label}.`);
    }
  }, 0);
}

// Text into the message box, never sent. Back on CHAT, with the phone's side panels out of the way.
function toChatBox(text: string, replace: boolean): void {
  showChat();
  document.body.classList.remove('show-left', 'show-right');
  if (replace) return setInput(text);
  insertIntoChat(text);
  document.getElementById('input')?.dispatchEvent(new Event('input')); // saves the draft, sizes the box
}

// ------------------------------------------------------------ data

async function refreshData(): Promise<void> {
  const jobs: Promise<unknown>[] = [refreshShell()];
  if (!store.demo && Date.now() - historyAt > STALE_MS) {
    jobs.push(
      loadHistory().then((h) => {
        history = h;
        historyAt = Date.now();
        if (isOpen()) update(true);
      }),
    );
  }
  const tab = store.active;
  if (tab && !store.demo) {
    jobs.push(
      slashCommands(tab)
        .then((list) => {
          slash = { tab, list };
          if (isOpen()) update(true);
        })
        .catch(() => {}),
    );
    // Warm the server's file index for this folder (an empty search builds it).
    jobs.push(fetch(`/api/files/find?tab=${encodeURIComponent(tab)}&q=`, { cache: 'no-store' }).catch(() => {}));
  }
  await Promise.all(jobs);
}

async function refreshShell(): Promise<void> {
  const api = shellApi;
  if (!api?.installed || !api.games) return;
  const [a, g] = await Promise.all([api.installed().catch(() => null), api.games().catch(() => null)]);
  if (a) installed = a;
  if (g) games = g;
  if (isOpen()) update(true);
}

function queueFiles(q: string): void {
  clearTimeout(filesTimer);
  const tab = store.active;
  if (!tab || store.demo || q.length < 2) {
    filesWaiting = false;
    return;
  }
  if (files.tab === tab && files.q === q) return;
  filesWaiting = true;
  filesTimer = setTimeout(async () => {
    filesAbort?.abort();
    const ac = (filesAbort = new AbortController());
    try {
      const r = await fetch(`/api/files/find?tab=${encodeURIComponent(tab)}&q=${encodeURIComponent(q)}`, { cache: 'no-store', signal: ac.signal });
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as FilesFindResponse;
      files = { tab, q, results: data.results ?? [], truncated: !!data.truncated };
    } catch {
      if (ac.signal.aborted) return;
      files = { tab, q, results: [], truncated: false };
    }
    filesWaiting = false;
    if (isOpen()) update(true);
  }, 140);
}

// ------------------------------------------------------------ entries

function entries(): Entry[] {
  const out: Entry[] = [];
  const shell = !!shellApi;

  programList().forEach((p, i) => {
    const kind = p.kind === 'chat' ? 'CHAT' : p.kind === 'app' ? 'APP' : 'SITE';
    out.push({ key: `prog:${p.id}`, sec: 'programs', label: p.name, hint: i < 9 ? `${kind} · CTRL+${i + 1}` : kind, words: kind, run: p.run });
  });

  if (shell && shellApi?.openInstalled) {
    const open = shellApi.openInstalled;
    for (const a of installed) {
      out.push({
        key: `inst:${a.id}`,
        sec: 'installed',
        label: a.name,
        hint: (a.hint || 'PROGRAM').toUpperCase(),
        words: a.words,
        icon: a.icon,
        run: () => void open(a.id).then((ok) => ok || toast(`Could not open ${a.name}.`)),
      });
    }
  }
  if (shell && shellApi?.openGame) {
    const open = shellApi.openGame;
    for (const g of games) {
      out.push({ key: `game:${g.id}`, sec: 'games', label: g.name, hint: g.hint || 'STEAM', words: 'game', run: () => void open(g.id).then((ok) => ok || toast(`Could not start ${g.name}.`)) });
    }
  }

  // Open tabs first, then saved chats. A chat is keyed by its session, so "recent" survives closing the tab.
  const openSessions = new Set<string>();
  for (const t of store.tabs.values()) {
    const m = t.meta;
    if (m.sessionId) openSessions.add(m.sessionId);
    const state = m.attention ? 'WAITING FOR YOU' : m.busy ? 'WORKING' : 'OPEN';
    out.push({
      key: m.sessionId ? `chat:${m.sessionId}` : `tab:${m.id}`,
      sec: 'chats',
      label: m.title,
      hint: `${folderName(t.info.cwd).toUpperCase()} · ${state}`,
      words: folderName(t.info.cwd),
      run: () => {
        store.setActive(m.id);
        showChat();
      },
    });
  }
  for (const s of history) {
    if (openSessions.has(s.sessionId) || (s.openTab && store.tabs.has(s.openTab))) continue;
    out.push({
      key: `chat:${s.sessionId}`,
      sec: 'chats',
      label: s.title,
      hint: `${folderName(s.cwd).toUpperCase()} · ${timeAgo(s.lastModified).toUpperCase()}`,
      words: folderName(s.cwd),
      run: () => {
        openHistoryEntry(s);
        showChat();
      },
    });
  }

  out.push(...appCommands());
  for (const c of extra.values()) {
    out.push({ key: `ext:${c.id}`, sec: 'commands', label: c.label, hint: c.hint?.toUpperCase(), words: c.keywords?.join(' '), run: () => c.run() });
  }
  if (slash.tab === store.active) {
    for (const c of slash.list) {
      out.push({
        key: `slash:${c.name}`,
        sec: 'commands',
        label: `/${c.name}`,
        hint: c.description,
        words: 'slash',
        run: () => toChatBox(`/${c.name} `, true),
      });
    }
  }
  return out;
}

function appCommands(): Entry[] {
  const s = getSettings();
  const out: Entry[] = [];
  const cmd = (id: string, label: string, hint: string, words: string, fn: () => void) => out.push({ key: `cmd:${id}`, sec: 'commands', label, hint, words, run: fn });
  const setting = <K extends keyof Settings>(key: K, value: Settings[K], label: string, what: string, words: string) =>
    cmd(`${key}-${String(value)}`, `${what}: ${label}`, s[key] === value ? 'ON NOW' : 'SETTING', `settings ${words}`, () => {
      setSetting(key, value);
      toast(`${what}: ${label}`);
    });

  const dialog = document.getElementById('newtab') as HTMLDialogElement | null;
  if (dialog) cmd('new-chat', 'NEW CHAT', 'PICK A FOLDER', 'tab new start', () => void openNewTab(dialog));
  cmd('history', 'HISTORY', 'SAVED CHATS', 'chats old reopen', () => {
    const d = document.getElementById('history');
    if (d?.hidden) document.getElementById('btn-history')?.click();
  });
  cmd('mcp', 'MCP SERVERS', 'TOOLS FROM OTHER APPS', 'mcp connectors', openMcp);
  cmd('usage', 'PLAN USAGE', '5-HOUR AND WEEKLY LIMITS', 'usage limits plan', openUsage);
  cmd('settings', 'SETTINGS', 'DISPLAY AND SOUND', 'options preferences', openSettings);
  for (const t of THEMES) setting('theme', t.id, t.label, 'THEME', `color theme look ${t.title.toLowerCase()}`);
  setting('crt', 'off', 'OFF', 'CRT', 'effects scanlines glow');
  setting('crt', 'low', 'LOW', 'CRT', 'effects scanlines glow');
  setting('crt', 'high', 'HIGH', 'CRT', 'effects scanlines glow');
  setting('size', 's', 'SMALL', 'TEXT SIZE', 'font');
  setting('size', 'm', 'MEDIUM', 'TEXT SIZE', 'font');
  setting('size', 'l', 'LARGE', 'TEXT SIZE', 'font');
  setting('sound', true, 'ON', 'SOUND', 'beeps audio');
  setting('sound', false, 'OFF', 'SOUND', 'beeps audio mute');
  const full = document.getElementById('btn-full');
  if (full && !full.hidden) cmd('fullscreen', document.fullscreenElement ? 'EXIT FULLSCREEN' : 'FULLSCREEN', 'F11', 'full screen', () => full.click());
  cmd('reload', 'RELOAD PAGE', 'F5', 'refresh', () => location.reload());
  return out;
}

// SETTINGS lives in MENU on phones: open MENU first, else the box has nowhere to show.
function openSettings(): void {
  const btn = document.querySelector<HTMLButtonElement>('#settings .settings-btn');
  const pop = document.querySelector<HTMLElement>('#settings .settings-pop');
  if (!btn || !pop?.hidden) return;
  if (getComputedStyle(document.querySelector('.top-tools')!).display === 'none') {
    document.body.classList.add('menu-open');
    document.getElementById('btn-menu')?.setAttribute('aria-expanded', 'true');
  }
  btn.click();
}

// ------------------------------------------------------------ matching

function parseQuery(raw: string): { mode: Mode; q: string } {
  const t = raw.trimStart();
  if (t.startsWith('>')) return { mode: 'cmd', q: t.slice(1).trim() };
  if (t.startsWith('/')) return { mode: 'slash', q: t.slice(1).trim() };
  const m = t.match(/^(run|chat|open)\s+(.*)$/is);
  if (m) return { mode: m[1].toLowerCase() as Mode, q: m[2].trim() };
  return { mode: 'all', q: t.trim() };
}

const isWordStart = (s: string, i: number) => i === 0 || !/[a-z0-9]/i.test(s[i - 1]) || (/[a-z]/.test(s[i - 1]) && /[A-Z]/.test(s[i]));

// One word against a text, best kind first: the text starts with it; a word starts with it; initials ("ff" for
// FINAL FANTASY, "vsc" for Visual Studio Code); inside a word; else the letters in order (better when they sit
// together or start words). -1 = no match. hits: matched positions, for underlining.
function matchWord(w: string, text: string, lower: string, hits?: number[]): number {
  const at = lower.indexOf(w);
  let wordAt = -1;
  for (let i = at; i >= 0; i = lower.indexOf(w, i + 1)) {
    if (isWordStart(text, i)) {
      wordAt = i;
      break;
    }
  }
  const tail = (lower.length - w.length) * 0.5; // shorter names first
  const span = (from: number) => {
    if (hits) for (let i = 0; i < w.length; i++) hits.push(from + i);
  };
  if (wordAt >= 0) {
    span(wordAt);
    return (wordAt === 0 ? 1400 : 1250) - wordAt * 2 - tail;
  }
  if (w.length >= 2) {
    const initials: number[] = [];
    let from = 0;
    for (const ch of w) {
      let i = lower.indexOf(ch, from);
      while (i >= 0 && !isWordStart(text, i)) i = lower.indexOf(ch, i + 1);
      if (i < 0) break;
      initials.push(i);
      from = i + 1;
    }
    if (initials.length === w.length) {
      hits?.push(...initials);
      return 1100 - initials[initials.length - 1] - tail;
    }
  }
  if (at >= 0) {
    span(at);
    return 1000 - at * 2 - tail;
  }
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of w) {
    // Take the next word start that has this letter if there is one before a plain hit would be needed.
    let i = lower.indexOf(ch, from);
    if (i < 0) return -1;
    if (i !== prev + 1) {
      for (let j = i; j >= 0; j = lower.indexOf(ch, j + 1)) {
        if (isWordStart(text, j)) {
          i = j;
          break;
        }
      }
    }
    score += i === prev + 1 ? 18 : isWordStart(text, i) ? 22 : 2;
    score -= Math.min(i - from, 12);
    hits?.push(i);
    prev = i;
    from = i + 1;
  }
  return score;
}

// Every word of the query must match. The label counts fully, extra words a bit less.
function scoreEntry(words: string[], e: Entry): number {
  const label = e.label;
  const lower = label.toLowerCase();
  const extra = e.words ?? '';
  const extraLower = extra.toLowerCase();
  let total = 0;
  for (const w of words) {
    const a = matchWord(w, label, lower);
    const b = extra ? matchWord(w, extra, extraLower) * 0.6 : -1;
    const s = Math.max(a, b);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

function hitsOf(words: string[], label: string): Set<number> {
  const lower = label.toLowerCase();
  const out = new Set<number>();
  for (const w of words) {
    const h: number[] = [];
    if (matchWord(w, label, lower, h) >= 0) h.forEach((i) => out.add(i));
  }
  return out;
}

// ------------------------------------------------------------ recent

type Recent = { k: string; n: number; t: number };

function recents(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((r) => r && typeof r.k === 'string') : [];
  } catch {
    return [];
  }
}

function remember(k: string): void {
  const list = recents();
  const old = list.find((r) => r.k === k);
  const next = [{ k, n: Math.min((old?.n ?? 0) + 1, 999), t: Date.now() }, ...list.filter((r) => r.k !== k)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: no memory, still works */
  }
}

function boostOf(r: Recent | undefined): number {
  if (!r) return 0;
  const days = (Date.now() - r.t) / 86400000;
  return Math.min(r.n, 10) * 8 + (days < 1 ? 40 : days < 7 ? 20 : 0);
}

// ------------------------------------------------------------ view

// Redraw. keep: the lists changed under an unchanged query, so the picked row stays picked.
function update(keep: boolean): void {
  const raw = input.value;
  const queryChanged = raw !== lastQuery;
  lastQuery = raw;
  const { mode, q } = parseQuery(raw);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryChanged) queueFiles(mode === 'all' || mode === 'open' ? q : '');
  const keepKey = keep && !queryChanged ? shown[pick]?.key : undefined;

  const all = entries();
  if ((mode === 'open' || mode === 'all') && q.length >= 2) all.push(...fileEntries(words));
  const rec = recents();
  const recMap = new Map(rec.map((r) => [r.k, r]));
  const allowed = new Set<SectionId>(MODE_SECTIONS[mode]);
  const sections: Section[] = [];
  const one = mode !== 'all';

  const group = (id: SectionId, list: Entry[], sortScore: boolean) => {
    const rows = list.map((entry) => ({ entry, score: words.length ? scoreEntry(words, entry) : 0 })).filter((r) => r.score >= 0);
    // The whole name typed out wins; a known command most ("new chat" beats a chat called "New chat").
    const exact = q.toLowerCase();
    for (const r of rows) r.score += boostOf(recMap.get(r.entry.key)) + (exact && r.entry.label.toLowerCase() === exact ? (id === 'commands' ? 100 : 50) : 0);
    if (sortScore) rows.sort((a, b) => b.score - a.score);
    const cap = one ? CAP_ONE_GROUP : CAP[id];
    if (rows.length) sections.push({ id, rows: rows.slice(0, cap), more: Math.max(0, rows.length - cap), best: rows[0]?.score ?? 0 });
  };

  if (mode === 'all' && !words.length) {
    // Empty prompt: recent picks, then the programs, then a few chats.
    const byKey = new Map(all.map((e) => [e.key, e]));
    const recent = rec.map((r) => byKey.get(r.k)).filter((e): e is Entry => !!e).slice(0, CAP.recent);
    const inRecent = new Set(recent.map((e) => e.key));
    if (recent.length) sections.push({ id: 'recent', rows: recent.map((entry) => ({ entry, score: 0 })), more: 0, best: 0 });
    group('programs', all.filter((e) => e.sec === 'programs' && !inRecent.has(e.key)), false);
    group('chats', all.filter((e) => e.sec === 'chats' && !inRecent.has(e.key)).slice(0, 5), false);
  } else {
    for (const id of MODE_SECTIONS[mode]) {
      let list = all.filter((e) => e.sec === id && allowed.has(e.sec));
      if (mode === 'slash') list = list.filter((e) => e.key.startsWith('slash:'));
      if (mode === 'open' && id === 'commands') list = list.filter((e) => /^ext:(station-open|doc)/.test(e.key));
      group(id, list, words.length > 0);
    }
    // Best group first; within the same score keep the usual order (sort is stable).
    if (words.length) sections.sort((a, b) => b.best - a.best);
  }

  // Messages for a prefix that found nothing, so Enter never falls through to Claude.
  let note = '';
  if (!sections.length) {
    if (mode === 'open') note = !q ? 'TYPE PART OF A FILE NAME.' : filesWaiting ? 'SEARCHING THE FOLDER…' : store.demo || !store.active ? 'FILES NEED A REAL CHAT TAB.' : `NO FILE NAME HAS "${q.toUpperCase()}".`;
    else if (mode === 'run') note = shellApi ? `NOTHING TO RUN CALLED "${q.toUpperCase()}".` : 'PROGRAMS AND GAMES NEED THE DESKTOP APP.';
    else if (mode === 'chat') note = q ? `NO CHAT MATCHES "${q.toUpperCase()}".` : 'NO CHATS YET.';
    else if (mode === 'cmd' || mode === 'slash') note = 'NO COMMAND MATCHES.';
    else if (!words.length) note = 'TYPE TO SEARCH.';
  }
  if (mode === 'all' && q) sections.push({ id: 'ask', rows: [{ entry: askEntry(q), score: 0 }], more: 0, best: -1 });

  render(sections, words, note, files.truncated && (mode === 'open' || mode === 'all') && words.length > 0);
  renderChips(mode);
  footEl.textContent = 'UP/DOWN MOVE · TAB NEXT GROUP · ENTER RUN · ESC CLOSE · ONLY ONE KIND: RUN NAME · CHAT NAME · OPEN FILE · >COMMAND';

  const keepAt = keepKey ? shown.findIndex((e) => e.key === keepKey) : -1;
  select(keepAt >= 0 ? keepAt : 0, true);
}

function askEntry(q: string): Entry {
  return { key: 'ask', sec: 'ask', label: `ASK CLAUDE: ${q}`, hint: 'PUTS IT IN THE MESSAGE BOX', remember: false, run: () => toChatBox(q, false) };
}

function fileEntries(words: string[]): Entry[] {
  const tab = store.active;
  if (!tab || files.tab !== tab) return [];
  const out: Entry[] = [];
  for (const f of files.results) {
    const slash = f.path.lastIndexOf('/');
    const dir = slash > 0 ? f.path.slice(0, slash) : '';
    const e: Entry = { key: `file:${f.path}`, sec: 'files', label: f.name, hint: dir || 'TOP FOLDER', words: f.path, remember: false, run: () => openViewer(tab, f.path) };
    // Results from the last search, still shown while a newer one runs, only if they fit what is typed now.
    if (!words.length || scoreEntry(words, e) >= 0) out.push(e);
  }
  return out;
}

function render(sections: Section[], words: string[], note: string, cut: boolean): void {
  shown = [];
  sectionStarts = [];
  const frag = document.createDocumentFragment();
  for (const s of sections) {
    const box = el('div', `ln-sec ln-sec-${s.id}`);
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', TITLES[s.id]);
    const head = el('div', 'ln-sec-head');
    head.append(el('span', 'ln-sec-title', TITLES[s.id]), el('span', 'ln-sec-line'));
    if (s.id !== 'ask' && s.id !== 'recent') head.append(el('span', 'ln-sec-count', String(s.rows.length + s.more)));
    box.append(head);
    sectionStarts.push(shown.length);
    for (const r of s.rows) box.append(rowEl(r.entry, shown.length, s.id === 'ask' ? [] : words, s.id === 'recent'));
    if (s.more) box.append(el('div', 'ln-more', `+${s.more} MORE. KEEP TYPING${moreHint(s.id)}.`));
    if (s.id === 'files' && cut) box.append(el('div', 'ln-more', 'BIG FOLDER: ONLY PART OF IT WAS SEARCHED.'));
    frag.append(box);
  }
  if (note) frag.append(el('div', 'ln-note', note));
  listEl.replaceChildren(frag);
}

function moreHint(id: SectionId): string {
  if (id === 'programs' || id === 'installed' || id === 'games') return ', OR START WITH RUN';
  if (id === 'chats') return ', OR START WITH CHAT';
  if (id === 'files') return ', OR START WITH OPEN';
  if (id === 'commands') return ', OR START WITH >';
  return '';
}

function rowEl(e: Entry, i: number, words: string[], recent: boolean): HTMLElement {
  shown.push(e);
  const row = el('div', 'ln-row');
  row.id = `ln-r-${i}`;
  row.dataset.i = String(i);
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', 'false');
  const ico = el('span', 'ln-ico');
  if (e.icon) {
    ico.classList.add('has-img');
    ico.style.setProperty('--ico', `url("${e.icon}")`);
    const img = el('img');
    img.src = e.icon;
    img.alt = '';
    img.decoding = 'async';
    ico.append(img);
  }
  const label = el('span', 'ln-label');
  const hits = words.length ? hitsOf(words, e.label) : null;
  if (hits?.size) {
    // Underline the letters that matched, in runs.
    let chunk = '';
    let on = false;
    const flush = () => {
      if (!chunk) return;
      label.append(on ? el('u', '', chunk) : document.createTextNode(chunk));
      chunk = '';
    };
    for (let k = 0; k < e.label.length; k++) {
      const h = hits.has(k);
      if (h !== on) {
        flush();
        on = h;
      }
      chunk += e.label[k];
    }
    flush();
  } else {
    label.textContent = e.label;
  }
  const hint = el('span', 'ln-hint', recent ? `${TITLES[e.sec]}${e.hint ? ` · ${e.hint}` : ''}` : (e.hint ?? ''));
  row.append(ico, label, hint);
  row.title = e.hint ? `${e.label}\n${e.hint}` : e.label;
  return row;
}

function renderChips(mode: Mode): void {
  const chips: [string, string, Mode][] = [];
  if (shellApi) chips.push(['RUN', 'run ', 'run']);
  chips.push(['CHAT', 'chat ', 'chat'], ['OPEN', 'open ', 'open'], ['COMMANDS', '>', 'cmd']);
  const key = chips.map((c) => c[0]).join() + mode;
  if (chipsEl.dataset.key === key) return;
  chipsEl.dataset.key = key;
  chipsEl.replaceChildren(
    ...chips.map(([label, prefix, m]) => {
      const b = el('button', 'ln-chip', label);
      b.type = 'button';
      b.tabIndex = -1;
      b.dataset.prefix = mode === m ? '' : prefix; // the chip that is on turns its prefix off
      b.classList.toggle('on', mode === m);
      b.title = mode === m ? 'Search everything' : `Only ${label.toLowerCase()}: type "${prefix.trim()}" first`;
      b.addEventListener('pointerdown', (ev) => ev.preventDefault()); // keeps the keyboard where it is
      return b;
    }),
  );
}
