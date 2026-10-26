import type { FoldersResponse, TabState } from '../../shared/protocol.ts';
import { firstMessage } from './firstmsg.ts';
import { newReq, send } from './net.ts';
import { store, working } from './store.ts';
import { shellApi } from './shellapi.ts';
import { button, editInline, el, folderName } from './ui.ts';

// Projects whose threads are folded away in the tab bar (this browser only).
const FOLD_KEY = 'phosphor-os.folded-projects';
const folded = new Set<string>(readFolded());
function readFolded(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function saveFolded(): void {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify([...folded]));
  } catch {
    /* no storage: folds last until a reload */
  }
}

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
  const tabEl = (t: TabState) => {
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
      b.classList.toggle('lead', !!m.project?.main);
      b.append(label, close);
      return b;
  };
  const render = () => {
    if (editing) return;
    // A project's tabs stay together where its first tab is: a label (click folds the threads away), the lead,
    // then the threads, oldest first.
    const all = [...store.tabs.values()];
    const drawn = new Set<string>();
    const items: HTMLElement[] = [];
    for (const t of all) {
      const p = t.meta.project;
      if (!p) {
        items.push(tabEl(t));
        continue;
      }
      if (drawn.has(p.id)) continue;
      drawn.add(p.id);
      const members = all
        .filter((x) => x.meta.project?.id === p.id)
        .sort((a, b) => Number(!!b.meta.project?.main) - Number(!!a.meta.project?.main) || a.meta.createdAt - b.meta.createdAt);
      const fold = folded.has(p.id) && !members.some((x) => x.meta.id === store.active && !x.meta.project?.main);
      const busy = members.filter((x) => working(x)).length;
      const head = button(`${fold ? '▸' : '▾'} ${p.name}${fold && members.length > 1 ? ` (${members.length - 1})` : ''}`, () => {
        if (!folded.delete(p.id)) folded.add(p.id);
        saveFolded();
        render();
      }, 'tab-group-label');
      head.title = `Project "${p.name}": ${members.length - 1} thread${members.length === 2 ? '' : 's'}${busy ? `, ${busy} working` : ''}. Click to ${fold ? 'show' : 'fold'} the threads.`;
      head.classList.toggle('busy', busy > 0);
      const group = el('div', 'tab-group');
      group.append(head, ...members.filter((x) => !fold || x.meta.project?.main).map(tabEl));
      items.push(group);
    }
    const add = button('+', () => openNewTab(dialog), 'tab-add');
    add.title = 'New chat or project';
    nav.replaceChildren(...items, add);
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

// Pick a folder for the new chat. Claude works inside that folder. The first message is optional: typed or dictated
// here, it waits in the new chat's message box (firstmsg.ts).
export async function openNewTab(dialog: HTMLDialogElement): Promise<void> {
  const list = el('div', 'folder-list');
  const first = firstMessage(dialog, 'chat');
  const cancel = button('CANCEL', () => dialog.close());
  const project = button('NEW PROJECT…', () => newProject(dialog), 'folder project-btn');
  project.title = 'A project: one lead chat that starts and steers thread chats, with a shared memory file';
  dialog.replaceChildren(el('h2', '', 'NEW CHAT: PICK A FOLDER'), first.block, list, el('div', 'buttons', ''));
  dialog.lastElementChild!.append(project, cancel);
  dialog.showModal();
  dialog.tabIndex = -1;
  dialog.focus(); // not the message box: on a phone that would raise the keyboard over the folders
  list.append(el('div', 'empty', 'Loading…'));
  const start = async (cwd: string) => {
    const then = await first.take();
    send({ t: 'new_tab', cwd, req: newReq(then) });
    dialog.close();
  };
  try {
    const data = (await (await fetch('/api/folders')).json()) as FoldersResponse;
    list.replaceChildren(
      ...data.folders.map((f, i) => {
        const b = button(i === 0 ? `${f.name} (whole workspace)` : f.name, () => void start(f.path), 'folder');
        b.title = f.path;
        return b;
      }),
    );
  } catch {
    // Demo mode or server down: offer the current folder only.
    const cwd = store.current()?.info.cwd ?? '';
    list.replaceChildren(button(folderName(cwd) || 'Default folder', () => void start(cwd), 'folder'));
  }
}

// A new project: its name, then its lead chat opens (in the workspace folder). The first message is optional too.
function newProject(dialog: HTMLDialogElement): void {
  const input = el('input', 'project-name');
  input.placeholder = 'Project name, for example "YT: Claude video"';
  input.maxLength = 60;
  const first = firstMessage(dialog, 'lead chat');
  const create = async () => {
    const name = input.value.trim();
    if (!name) return input.focus();
    const then = await first.take();
    send({ t: 'new_project', name, req: newReq(then) });
    dialog.close();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') void create();
  };
  const buttons = el('div', 'buttons');
  buttons.append(button('CREATE', () => void create()), button('CANCEL', () => dialog.close()));
  const help = el('p', 'project-help', 'The lead chat splits the work into thread chats (one per job), starts them, and checks on them. Threads show next to it in the tab bar and in THREADS on the left. All of them share one memory file.');
  dialog.replaceChildren(el('h2', '', 'NEW PROJECT'), help, input, first.block, buttons);
  input.focus();
}
