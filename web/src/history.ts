import type { HistoryEntry, HistoryResponse } from '../../shared/protocol.ts';
import { newReq, send } from './net.ts';
import { store } from './store.ts';
import { button, el, folderName, timeAgo } from './ui.ts';

// Drawer listing past Claude Code chats (from this app and from the terminal). Tap one to open it in a tab.
export function mountHistory(drawer: HTMLElement, openBtn: HTMLElement): void {
  const search = el('input', 'search');
  search.placeholder = 'Search chats';
  const list = el('div', 'history-list');
  const head = el('div', 'drawer-head');
  head.append(el('h2', '', 'CHAT HISTORY'), button('CLOSE', () => (drawer.hidden = true)));
  drawer.replaceChildren(head, search, list);

  let all: HistoryEntry[] = [];
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const rows = all.filter((s) => !q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q));
    list.replaceChildren(
      ...rows.map((s) => {
        const row = el('button', 'history-row');
        row.type = 'button';
        row.append(el('span', 'h-title', s.title), el('span', 'h-meta', `${folderName(s.cwd)} · ${timeAgo(s.lastModified)}${s.openTab ? ' · OPEN' : ''}`));
        row.onclick = () => {
          drawer.hidden = true;
          openHistoryEntry(s);
        };
        return row;
      }),
    );
    if (rows.length === 0) list.append(el('div', 'empty', all.length ? 'No match.' : 'No chats yet.'));
  };
  search.oninput = render;

  openBtn.onclick = async () => {
    drawer.hidden = !drawer.hidden;
    if (drawer.hidden) return;
    list.replaceChildren(el('div', 'empty', 'Loading…'));
    all = await loadHistory();
    render();
    search.focus();
  };
}

// The saved chats, newest first ([] when the server can't be reached). Also used by the launcher.
export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    return ((await (await fetch('/api/history')).json()) as HistoryResponse).sessions ?? [];
  } catch {
    return [];
  }
}

// Reopen a saved chat: its tab if it is open, else a new tab on that chat.
export function openHistoryEntry(s: HistoryEntry): void {
  if (s.openTab && store.tabs.has(s.openTab)) store.setActive(s.openTab);
  else send({ t: 'open_session', sessionId: s.sessionId, cwd: s.cwd, title: s.title, req: newReq() });
}
