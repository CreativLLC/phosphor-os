import type { FoldersResponse } from '../../shared/protocol.ts';
import { newReq, send } from './net.ts';
import { store, working } from './store.ts';
import { shellApi } from './shellapi.ts';
import { button, editInline, el, folderName } from './ui.ts';

export function mountTabs(nav: HTMLElement, dialog: HTMLDialogElement): void {
  let editing = false; // a re-render would throw away the name being typed
  // Finished while you were looking elsewhere: marked until you open that tab (the done sound alone does not
  // say which tab made it).
  const wasWorking = new Map<string, boolean>();
  const unseen = new Set<string>();
  const seen = () => {
    if (store.active && !document.hidden && unseen.delete(store.active)) render();
  };
  const track = () => {
    for (const t of store.tabs.values()) {
      const id = t.meta.id;
      const now = working(t);
      if (wasWorking.get(id) && !now && (id !== store.active || document.hidden)) unseen.add(id);
      wasWorking.set(id, now);
    }
    for (const id of unseen) if (!store.tabs.has(id)) unseen.delete(id);
  };
  const render = () => {
    if (editing) return;
    const tabs = [...store.tabs.values()].map((t) => {
      const m = t.meta;
      const b = el('div', 'tab');
      b.classList.toggle('on', m.id === store.active);
      b.classList.toggle('busy', working(t));
      b.classList.toggle('attention', m.attention);
      b.classList.toggle('done', unseen.has(m.id) && !working(t) && !m.attention);
      b.title = `${m.title}\n${t.info.cwd}\nRight-click or double-click to rename`;
      const label = el('button', 'tab-label');
      label.type = 'button';
      label.append(el('span', 'tab-dot'), el('span', 'tab-title', m.title));
      label.onclick = () => store.setActive(m.id);
      // prompt() does nothing in the desktop app, so the name is edited in the tab itself.
      label.ondblclick = label.oncontextmenu = (e: MouseEvent) => {
        e.preventDefault();
        editing = true;
        editInline(label, m.title, (title) => send({ t: 'rename_tab', tab: m.id, title }), () => {
          editing = false;
          render();
        });
      };
      const close = button('×', () => closeTab(m.id), 'tab-close');
      close.title = 'Close tab (the chat stays in HISTORY)';
      b.append(label, close);
      return b;
    });
    const add = button('+', () => openNewTab(dialog), 'tab-add');
    add.title = 'New chat';
    nav.replaceChildren(...tabs, add);
    nav.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  // A mouse wheel only scrolls up/down; turn that into sideways scrolling of the strip.
  nav.addEventListener('wheel', (e) => {
    if (e.deltaY === 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    nav.scrollLeft += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaY;
    e.preventDefault();
  }, { passive: false });
  store.on((c) => {
    if (c.kind === 'tabs' || (c.kind === 'patch' && c.key === 'agents')) track();
    if (c.kind === 'active') unseen.delete(store.active ?? '');
    if (c.kind === 'tabs' || c.kind === 'active' || (c.kind === 'patch' && c.key === 'agents')) render();
  });
  document.addEventListener('visibilitychange', seen);
  shellApi?.onCommand((c) => {
    // Ctrl+W in the desktop app. Not while DOCS or the launcher is in front: the chat tab is not what you are looking at.
    if (c === 'close-tab' && store.active && !document.body.classList.contains('docs-open') && !document.querySelector('dialog.launcher[open]')) closeTab(store.active);
  });
  track();
  render();
}

function closeTab(id: string): void {
  if (store.tabs.get(id)?.meta.busy && !confirm('Claude is still working in this tab. Close it anyway?')) return;
  send({ t: 'close_tab', tab: id });
}

// Pick a folder for the new chat. Claude works inside that folder.
export async function openNewTab(dialog: HTMLDialogElement): Promise<void> {
  const list = el('div', 'folder-list');
  const cancel = button('CANCEL', () => dialog.close());
  dialog.replaceChildren(el('h2', '', 'NEW CHAT: PICK A FOLDER'), list, el('div', 'buttons', ''));
  dialog.lastElementChild!.append(cancel);
  dialog.showModal();
  list.append(el('div', 'empty', 'Loading…'));
  try {
    const data = (await (await fetch('/api/folders')).json()) as FoldersResponse;
    list.replaceChildren(
      ...data.folders.map((f, i) => {
        const b = button(i === 0 ? `${f.name} (whole workspace)` : f.name, () => {
          send({ t: 'new_tab', cwd: f.path, req: newReq() });
          dialog.close();
        }, 'folder');
        b.title = f.path;
        return b;
      }),
    );
  } catch {
    // Demo mode or server down: offer the current folder only.
    const cwd = store.current()?.info.cwd ?? '';
    list.replaceChildren(button(folderName(cwd) || 'Default folder', () => {
      send({ t: 'new_tab', cwd, req: newReq() });
      dialog.close();
    }, 'folder'));
  }
}
