import type { FoldersResponse, ProjectsResponse, TabState } from '../../shared/protocol.ts';
import { firstMessage, type FirstMessage } from './firstmsg.ts';
import { newReq, send } from './net.ts';
import { newProjectChat } from './projects.ts';
import { editInstructions, editMemory } from './projectedit.ts';
import { store, working } from './store.ts';
import { shellApi } from './shellapi.ts';
import { button, editInline, el, folderName, pickBox } from './ui.ts';

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
      b.title = `${m.title}\n${t.info.cwd}\nDouble-click to rename. Right-click: rename, projects. Drag to move.`;
      const label = el('button', 'tab-label');
      label.type = 'button';
      label.append(el('span', 'tab-dot'), el('span', 'tab-title', m.title));
      // A second click on the open lead of a project folds or shows its other chats, like the project label (after a
      // moment, so a double click still renames without folding).
      label.onclick = (e: MouseEvent) => {
        if (!(m.project?.main && m.id === store.active)) return store.setActive(m.id);
        if (e.detail > 1) return clearTimeout(foldSoon);
        foldSoon = setTimeout(() => toggleFold(m.project!.id), 250);
      };
      // prompt() does nothing in the desktop app, so the name is edited in the tab itself.
      const rename = () => {
        clearTimeout(foldSoon);
        b.draggable = false; // text in the name box can be selected
        editing = true;
        editInline(label, m.title, (title) => send({ t: 'rename_tab', tab: m.id, title }), () => {
          editing = false;
          render();
        });
      };
      label.ondblclick = (e: MouseEvent) => {
        e.preventDefault();
        rename();
      };
      // Right-click (a long press on a phone): RENAME, and into a project, to another, or out of it.
      label.oncontextmenu = (e: MouseEvent) => {
        e.preventDefault();
        void tabMenu(t, rename);
      };
      const close = button('×', () => closeTab(m.id), 'tab-close');
      close.title = 'Close tab (the chat stays in HISTORY)';
      b.classList.toggle('lead', !!m.project?.main);
      b.append(label, close);
      if (!m.project) draggable(b, [m.id]);
      return b;
  };
  // Fold or show a project's chats in the tab bar. Folded, the whole project is one tab: its name and how many chats
  // it holds, lit like a tab when one of them is open, busy, done or needs you (the owner, 2026-10-28).
  let foldSoon: ReturnType<typeof setTimeout> | undefined;
  let shownActive = store.active;
  const toggleFold = (id: string) => {
    if (!folded.delete(id)) folded.add(id);
    saveFolded();
    render();
  };
  // Drag a tab (or a project's group) to a new place in the bar. The order is the server's (tabs.json), so every
  // device shows it. A drop lands before or after the item under the pointer, by which half it is on.
  let dragIds: string[] | null = null;
  const draggable = (item: HTMLElement, ids: string[]) => {
    item.draggable = true;
    item.dataset.ids = ids.join(',');
    item.addEventListener('dragstart', (e) => {
      dragIds = ids;
      item.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', '');
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      dragIds = null;
      item.classList.remove('dragging');
      for (const x of nav.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after');
    });
    item.addEventListener('dragover', (e) => {
      if (!dragIds || dragIds.join(',') === item.dataset.ids) return;
      e.preventDefault();
      const r = item.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      item.classList.toggle('drop-after', after);
      item.classList.toggle('drop-before', !after);
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
    item.addEventListener('drop', (e) => {
      if (!dragIds) return;
      e.preventDefault();
      const after = item.classList.contains('drop-after');
      item.classList.remove('drop-before', 'drop-after');
      const moving = dragIds;
      const groups = [...nav.querySelectorAll<HTMLElement>(':scope > [data-ids]')].map((x) => x.dataset.ids!.split(',')).filter((g) => g.join(',') !== moving.join(','));
      const at = groups.findIndex((g) => g.join(',') === item.dataset.ids);
      if (at < 0) return;
      groups.splice(at + (after ? 1 : 0), 0, moving);
      const ids = groups.flat();
      store.tabs = new Map(ids.flatMap((id) => (store.tabs.has(id) ? [[id, store.tabs.get(id)!] as const] : [])));
      store.emit({ kind: 'tabs' });
      send({ t: 'reorder_tabs', ids });
    });
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
      // A folded project opens again when another of its chats becomes the open one (THREADS, a notice, HISTORY).
      const inside = members.some((x) => x.meta.id === store.active);
      if (folded.has(p.id) && inside && store.active !== shownActive) {
        folded.delete(p.id);
        saveFolded();
      }
      const fold = folded.has(p.id);
      const busy = members.filter((x) => working(x)).length;
      const n = members.length;
      const head = button('', () => toggleFold(p.id), 'tab-group-label');
      head.append(el('span', 'tab-dot'), `${fold ? '▸' : '▾'} `, el('span', 'tab-group-name', p.name));
      if (fold) head.append(el('span', 'tab-group-count', String(n)));
      head.title = `Project "${p.name}": ${n} chat${n === 1 ? '' : 's'}${busy ? `, ${busy} working` : ''}. Click to ${fold ? 'show' : 'fold'} them.`;
      head.classList.toggle('busy', busy > 0);
      // Folded: the project's tab stands in for its chats.
      if (fold) {
        head.classList.add('tab', 'folded');
        head.classList.toggle('on', inside);
        head.classList.toggle('attention', members.some((x) => x.meta.attention));
        head.classList.toggle('done', !busy && members.some((x) => unseen.has(x.meta.id) && !x.meta.attention));
      }
      const group = el('div', 'tab-group');
      group.classList.toggle('folded', fold);
      const more = button('+', () => newProjectChat(p), 'tab-add tab-group-add');
      more.title = `New chat in "${p.name}"`;
      group.append(head, ...(fold ? [] : [...members.map(tabEl), more]));
      draggable(group, members.map((x) => x.meta.id)); // a project moves as one
      items.push(group);
    }
    shownActive = store.active;
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
  // Ctrl+Shift+T: the chat closed last comes back in its place; again for the one before it (server/tabs.ts).
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.isComposing || e.key.toLowerCase() !== 't') return;
    e.preventDefault();
    send({ t: 'reopen_closed', req: newReq() });
  });
  track();
  render();
}

// The tab menu. Projects come from GET /api/projects (open or closed), the chat's own project left out.
async function tabMenu(t: TabState, rename: () => void): Promise<void> {
  const here = t.meta.project;
  let projects: { id: string; name: string }[] = [];
  try {
    projects = store.demo ? [] : (((await (await fetch('/api/projects')).json()) as ProjectsResponse).projects ?? []).filter((p) => p.id !== here?.id);
  } catch {
    /* no list: RENAME still works */
  }
  // The lead of this chat's project is closed: bring it back from here.
  const leadGone = here && ![...store.tabs.values()].some((x) => x.meta.project?.id === here.id && x.meta.project.main);
  type Pick = { do: 'rename' } | { do: 'lead' } | { do: 'rules' } | { do: 'memory' } | { do: 'move'; project: string | null };
  const pick = await pickBox<Pick>(t.meta.title.toUpperCase(), [
    { label: 'RENAME', value: { do: 'rename' } },
    ...(leadGone ? [{ label: 'OPEN THE LEAD CHAT', value: { do: 'lead' as const } }] : []),
    ...(here ? [{ label: 'PROJECT INSTRUCTIONS', value: { do: 'rules' as const } }, { label: 'PROJECT MEMORY', value: { do: 'memory' as const } }] : []),
    ...(here ? [{ label: `REMOVE FROM PROJECT (${here.name.toUpperCase()})`, value: { do: 'move' as const, project: null } }] : []),
    ...(projects.length ? [{ head: here ? 'MOVE TO PROJECT' : 'ADD TO PROJECT' }] : []),
    ...projects.map((p) => ({ label: p.name, value: { do: 'move' as const, project: p.id } })),
  ]);
  if (!pick) return;
  if (pick.do === 'rename') rename();
  else if (pick.do === 'lead') send({ t: 'open_lead', project: here!.id, req: newReq() });
  else if (pick.do === 'rules') void editInstructions(here!);
  else if (pick.do === 'memory') void editMemory(here!);
  else send({ t: 'move_to_project', tab: t.meta.id, project: pick.project });
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
  const project = button('NEW PROJECT…', () => newProject(dialog, first), 'folder project-btn');
  project.title = 'A project: one lead chat that starts and steers thread chats, with a shared memory file';
  // In a project now: one more chat in it is offered first (projects.ts).
  const here = store.current()?.meta.project;
  const inProject = here ? button(`IN THIS PROJECT: ${here.name}…`, () => newProjectChat(here, first), 'folder project-btn in-project') : '';
  if (inProject) inProject.title = 'A new chat in this project: same folder and shared memory, shown with its chats';
  dialog.replaceChildren(el('h2', '', 'NEW CHAT: PICK A FOLDER'), first.block, inProject, list, el('div', 'buttons', ''));
  dialog.lastElementChild!.append(project, cancel);
  dialog.showModal();
  dialog.tabIndex = -1;
  dialog.focus(); // not the message box: on a phone that would raise the keyboard over the folders
  list.append(el('div', 'empty', 'Loading…'));
  const start = async (cwd: string) => {
    const then = await first.take();
    if (then === null) return; // a second tap, or CANCEL while the first message's words came in
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
export function newProject(dialog: HTMLDialogElement, from?: FirstMessage): void {
  const input = el('input', 'project-name');
  input.placeholder = 'Project name, for example "YT: Claude video"';
  input.maxLength = 60;
  const first = firstMessage(dialog, 'lead chat', from);
  const create = async () => {
    const name = input.value.trim();
    if (!name) return input.focus();
    const then = await first.take();
    if (then === null) return;
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
  if (!dialog.open) dialog.showModal(); // from PROJECTS
  input.focus();
}
