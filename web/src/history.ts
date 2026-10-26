import type { HistoryEntry, HistoryResponse, HistorySearchResponse } from '../../shared/protocol.ts';
import { newReq, send } from './net.ts';
import { store } from './store.ts';
import { button, el, folderName, timeAgo } from './ui.ts';

// ALL CHATS: also list Claude Code chats from outside this app (terminal, VS Code). Off by default.
const ALL_KEY = 'phosphor.history.all';

function showsAll(): boolean {
  try {
    return localStorage.getItem(ALL_KEY) === '1';
  } catch {
    return false;
  }
}

function saveShowsAll(on: boolean): void {
  try {
    localStorage.setItem(ALL_KEY, on ? '1' : '0');
  } catch {
    /* storage blocked: fine */
  }
}

// Drawer listing past chats of this app (ALL CHATS: every Claude Code chat). Tap one to open it in a tab.
// Typing filters by title and folder at once; chats whose text has the words follow, with a line of that text.
export function mountHistory(drawer: HTMLElement, openBtn: HTMLElement): void {
  const search = el('input', 'search');
  search.placeholder = 'Search chats';
  const list = el('div', 'history-list');
  const head = el('div', 'drawer-head');
  const tools = el('div', 'h-tools');
  const allBtn = button('ALL CHATS', () => void toggleAll());
  allBtn.title = 'Also show Claude chats from the terminal and VS Code';
  tools.append(allBtn, button('CLOSE', () => (drawer.hidden = true)));
  head.append(el('h2', '', 'CHAT HISTORY'), tools);
  drawer.replaceChildren(head, search, list);

  let all: HistoryEntry[] = [];
  let hits = new Map<string, string>(); // sessionId -> snippet, for the words in `hitsFor`
  let hitsFor = '';
  let asked = 0; // newest text search; older answers are dropped
  let timer: ReturnType<typeof setTimeout> | undefined;

  const showAllState = () => {
    allBtn.classList.toggle('on', showsAll());
    allBtn.setAttribute('aria-pressed', String(showsAll()));
  };

  const render = () => {
    const q = search.value.trim().toLowerCase();
    const byTitle = all.filter((s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
    // Text hits from a search one keystroke behind still fit while the words only grew or shrank; they are
    // kept until the new answer lands, so rows do not blink out and back.
    const useHits = !!q && !!hitsFor && (q.startsWith(hitsFor) || hitsFor.startsWith(q));
    const shown = new Set(byTitle.map((s) => s.sessionId));
    const byText = useHits ? all.filter((s) => !shown.has(s.sessionId) && hits.has(s.sessionId)) : [];
    const words = q.split(/\s+/).filter(Boolean);
    list.replaceChildren(
      ...[...byTitle, ...byText].map((s) => {
        const row = el('button', 'history-row');
        row.type = 'button';
        row.append(el('span', 'h-title', s.title), el('span', 'h-meta', `${s.agent === 'gemini' ? 'GEMINI · ' : ''}${folderName(s.cwd)} · ${timeAgo(s.lastModified)}${s.openTab ? ' · OPEN' : ''}`));
        const snip = useHits ? hits.get(s.sessionId) : undefined;
        if (snip) row.append(marked(snip, words));
        row.onclick = () => {
          drawer.hidden = true;
          openHistoryEntry(s);
        };
        return row;
      }),
    );
    if (list.childElementCount === 0) list.append(el('div', 'empty', !all.length ? 'No chats yet.' : q.length > 1 && q !== hitsFor ? 'Searching…' : 'No match.'));
  };

  // Search inside the chats a moment after typing stops (the server reads the transcripts).
  const searchText = () => {
    clearTimeout(timer);
    const q = search.value.trim().toLowerCase();
    if (q.length < 2) {
      asked++;
      hits = new Map();
      hitsFor = '';
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++asked;
      try {
        const r = (await (await fetch(`/api/history/search?q=${encodeURIComponent(q)}${showsAll() ? '&all=1' : ''}`)).json()) as HistorySearchResponse;
        if (mine !== asked) return;
        hits = new Map((r.hits ?? []).map((h) => [h.sessionId, h.snippet]));
      } catch {
        if (mine !== asked) return;
        hits = new Map();
      }
      hitsFor = q;
      render();
    }, 250);
  };

  search.oninput = () => {
    render();
    searchText();
  };

  const load = async () => {
    list.replaceChildren(el('div', 'empty', 'Loading…'));
    all = await loadHistory();
    hitsFor = ''; // the list changed: ask again
    render();
    searchText();
  };

  const toggleAll = async () => {
    saveShowsAll(!showsAll());
    showAllState();
    await load();
  };

  openBtn.onclick = async () => {
    drawer.hidden = !drawer.hidden;
    if (drawer.hidden) return;
    showAllState();
    await load();
    search.focus();
  };
}

// A snippet with the searched words marked.
function marked(text: string, words: string[]): HTMLElement {
  const out = el('span', 'h-snip');
  const esc = [...words].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = esc.length ? text.split(new RegExp(`(${esc.join('|')})`, 'giu')) : [text];
  parts.forEach((p, i) => p && out.append(i % 2 ? el('mark', '', p) : p));
  return out;
}

// The saved chats, newest first ([] when the server can't be reached). Also used by the launcher.
export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    return ((await (await fetch(`/api/history${showsAll() ? '?all=1' : ''}`)).json()) as HistoryResponse).sessions ?? [];
  } catch {
    return [];
  }
}

// Reopen a saved chat: its tab if it is open, else a new tab on that chat.
export function openHistoryEntry(s: HistoryEntry): void {
  if (s.openTab && store.tabs.has(s.openTab)) store.setActive(s.openTab);
  else send({ t: 'open_session', sessionId: s.sessionId, cwd: s.cwd, title: s.title, req: newReq() });
}
