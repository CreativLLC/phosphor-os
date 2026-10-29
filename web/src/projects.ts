import type { ProjectsResponse, ProjectSummary, TabState } from '../../shared/protocol.ts';
import { demoProjects } from './demo.ts';
import { firstMessage, type FirstMessage } from './firstmsg.ts';
import { newReq, send } from './net.ts';
import { store, working } from './store.ts';
import { newProject } from './tabs.ts';
import { button, confirmBox, el, timeAgo } from './ui.ts';

// PROJECTS (owner's ask 2026-10-27): every project in one list (open or closed), and + CHAT, one more chat in a
// project. The list comes from GET /api/projects (server/projects.ts); open chats and how they are doing come live
// from the tabs. A closed project reopens its chats through HISTORY's resume path (open_project).

// The chat last used in each project (this browser only): opening a project goes back to it.
const LAST_KEY = 'phosphor-os.project-last';
const last: Record<string, string> = readLast();
function readLast(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

let drawerEl: HTMLElement | undefined;
let dialogEl: HTMLDialogElement | undefined;
let openDrawer = (): void => {};

// A project's open chats, the lead first, then the oldest first (as the tab bar and THREADS show them).
export function projectTabs(id: string): TabState[] {
  return [...store.tabs.values()]
    .filter((t) => t.meta.project?.id === id)
    .sort((a, b) => Number(!!b.meta.project?.main) - Number(!!a.meta.project?.main) || a.meta.createdAt - b.meta.createdAt);
}

// How a project is doing, in one word: from its open chats, else CLOSED.
export function projectState(tabs: TabState[]): string {
  if (tabs.some((t) => t.meta.attention)) return 'NEEDS YOU';
  if (tabs.some(working)) return 'WORKING';
  return tabs.length ? 'OPEN' : 'CLOSED';
}

export function showProjects(): void {
  openDrawer();
}

export function mountProjects(drawer: HTMLElement, openBtn: HTMLElement, dialog: HTMLDialogElement): void {
  drawerEl = drawer;
  dialogEl = dialog;
  const search = el('input', 'search');
  search.placeholder = 'Filter projects';
  const list = el('div', 'history-list project-list');
  const head = el('div', 'drawer-head');
  const tools = el('div', 'h-tools');
  const add = button('NEW PROJECT', () => {
    drawer.hidden = true;
    newProject(dialog);
  }, 'project-btn');
  add.title = 'A project: one lead chat that starts and steers thread chats, with a shared memory file';
  tools.append(add, button('CLOSE', () => (drawer.hidden = true)));
  head.append(el('h2', '', 'PROJECTS'), tools);
  drawer.replaceChildren(head, search, list);

  let saved: ProjectSummary[] = [];
  let loaded = false;

  // Saved projects with live state: open chats from the tabs; projects only the tabs know (made since the list
  // loaded) too. A project at work counts as active now.
  const rows = (): (ProjectSummary & { tabs: TabState[] })[] => {
    const all = new Map(saved.map((p) => [p.id, p]));
    for (const t of store.tabs.values()) {
      const p = t.meta.project;
      if (p && !all.has(p.id)) all.set(p.id, { id: p.id, name: p.name, createdAt: t.meta.createdAt, lastActive: t.meta.createdAt, closed: [] });
    }
    return [...all.values()]
      .map((p) => {
        const tabs = projectTabs(p.id);
        return { ...p, tabs, lastActive: tabs.some(working) ? Date.now() : p.lastActive };
      })
      .sort((a, b) => b.lastActive - a.lastActive);
  };

  const render = () => {
    if (drawer.hidden) return;
    const q = search.value.trim().toLowerCase();
    const shown = rows().filter((p) => !q || p.name.toLowerCase().includes(q));
    list.replaceChildren(...shown.map((p) => projectRow(p, p.tabs, () => (drawer.hidden = true), () => void load())));
    if (!shown.length) list.append(el('div', 'empty', !loaded ? 'Loading…' : q ? 'No match.' : 'No projects yet. NEW PROJECT starts one.'));
  };

  const load = async () => {
    loaded = false;
    render();
    try {
      saved = store.demo ? demoProjects() : ((await (await fetch('/api/projects')).json()) as ProjectsResponse).projects ?? [];
    } catch {
      saved = [];
    }
    loaded = true;
    render();
  };

  openDrawer = () => {
    for (const d of document.querySelectorAll<HTMLElement>('.drawer')) if (d !== drawer) d.hidden = true;
    document.body.classList.remove('show-left', 'show-right'); // phones: the slide-over panel it came from
    drawer.hidden = false;
    void load();
  };
  openBtn.onclick = () => (drawer.hidden ? openDrawer() : (drawer.hidden = true));
  // One drawer at a time.
  for (const id of ['btn-history', 'btn-mcp', 'btn-station']) document.getElementById(id)?.addEventListener('click', () => (drawer.hidden = true));
  search.oninput = render;

  store.on((c) => {
    if (c.kind === 'active') {
      const p = store.current()?.meta.project;
      if (p && store.active) {
        last[p.id] = store.active;
        try {
          localStorage.setItem(LAST_KEY, JSON.stringify(last));
        } catch {
          /* no storage: back to the lead */
        }
      }
    }
    if (c.kind === 'tabs' || c.kind === 'active' || (c.kind === 'patch' && (c.key === 'meta' || c.key === 'agents'))) render();
  });
}

// One project in the list: name and state, chats and last activity, its chat names. A tap opens it: the chat last
// used (or the lead) when it has open chats, else its closed chats come back. REOPEN brings back closed ones too.
function projectRow(p: ProjectSummary, tabs: TabState[], done: () => void, reload: () => void): HTMLElement {
  const state = projectState(tabs);
  const row = el('div', `project-row st-${state.toLowerCase().replace(/ /g, '-')}`);
  const main = el('button', 'history-row project-open');
  main.type = 'button';
  const top = el('span', 'project-top');
  top.append(el('span', 'h-title', p.name), el('span', 'project-state', state));
  const count = tabs.length + p.closed.length;
  const meta = [count ? `${count} CHAT${count === 1 ? '' : 'S'}` : 'NO SAVED CHATS', ...(tabs.length && p.closed.length ? [`${tabs.length} OPEN`] : []), timeAgo(p.lastActive)].join(' · ');
  // Every chat of the project, one button each: an open one is shown, a closed one comes back alone (the HISTORY
  // resume path puts it back in the project). The lead is often named like the project: then just LEAD. Closed: dim.
  const names = [
    ...tabs.map((t) => ({ title: t.meta.title, main: !!t.meta.project?.main, go: () => store.setActive(t.meta.id), open: true })),
    ...p.closed.map((c) => ({ title: c.title, main: c.main, go: () => send({ t: 'open_session', sessionId: c.sessionId, cwd: '', title: c.title, req: newReq() }), open: false })),
  ];
  const chats = el('div', 'project-chats');
  for (const c of names) {
    const b = button(c.main ? (c.title === p.name ? 'LEAD' : `LEAD: ${c.title}`) : c.title, () => {
      done();
      c.go();
    }, c.open ? 'open' : 'closed');
    b.title = c.open ? 'Go to this chat' : 'Closed: open this chat again, in the project';
    chats.append(b);
  }
  main.append(top, el('span', 'h-meta', meta));
  main.title = tabs.length ? 'Go to this project' : `Reopen this project${p.closed.length ? ` (${p.closed.length} chat${p.closed.length === 1 ? '' : 's'})` : ': a new lead chat on its memory file'}`;
  main.onclick = () => {
    done();
    openProject(p, tabs);
  };
  row.append(main);
  if (names.length) row.append(chats);
  const tools = el('div', 'project-tools');
  if (tabs.length) {
    const add = button('+ CHAT', () => newProjectChat(p));
    add.title = 'A new chat in this project';
    tools.append(add);
    // The lead was closed while other chats stay open: bring it back (or a new one on the same memory).
    if (!tabs.some((t) => t.meta.project?.main)) {
      const lead = button('OPEN LEAD', () => {
        done();
        send({ t: 'open_lead', project: p.id, req: newReq() });
      });
      lead.title = "The project's lead chat: it sees and steers the other chats";
      tools.append(lead);
    }
  }
  if (p.closed.length) {
    const back = button(`REOPEN ${p.closed.length} CLOSED`, () => {
      done();
      send({ t: 'open_project', project: p.id, req: newReq() });
    }, 'project-reopen');
    back.title = 'Bring back the chats of this project you closed';
    if (tabs.length) tools.append(back);
  }
  const del = button('DELETE', () => void deleteProject(p, tabs, reload), 'project-delete');
  del.title = 'Delete this project: its open chats close, its memory file goes. The chats stay in HISTORY.';
  tools.append(del);
  row.append(tools);
  return row;
}

// DELETE: asks first; the server closes the project's open chats and moves its folder to data/projects-deleted/.
async function deleteProject(p: ProjectSummary, tabs: TabState[], reload: () => void): Promise<void> {
  const open = tabs.length ? ` Its ${tabs.length} open chat${tabs.length === 1 ? '' : 's'} close.` : '';
  if (!(await confirmBox(`DELETE ${p.name.toUpperCase()}?`, `The project and its memory file go away.${open} The chats stay in HISTORY as plain chats.`, 'DELETE'))) return;
  if (store.demo) return;
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(p.id)}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = (await r.json()) as { error?: string };
    if (j.error) await confirmBox('NOT DELETED', j.error, 'OK');
  } catch {
    /* the list shows what is left */
  }
  reload();
}

function openProject(p: ProjectSummary, tabs: TabState[]): void {
  const pick = tabs.find((t) => t.meta.id === last[p.id]) ?? tabs[0];
  if (pick) store.setActive(pick.meta.id);
  else send({ t: 'open_project', project: p.id, req: newReq() });
}

// + CHAT: one more chat in the project, with an optional name and first message. It joins like a thread: the
// project's folder and shared memory, next to the others in the tab bar and THREADS; the lead can see and steer it.
// from: NEW CHAT's first message box, when its CHAT IN button got here.
export function newProjectChat(p: { id: string; name: string }, from?: FirstMessage): void {
  const dialog = dialogEl;
  if (!dialog) return;
  if (drawerEl) drawerEl.hidden = true;
  const input = el('input', 'project-name');
  input.placeholder = 'Chat name (optional)';
  input.maxLength = 60;
  const first = firstMessage(dialog, 'chat', from);
  const start = async () => {
    const then = await first.take();
    if (then === null) return;
    send({ t: 'new_project_chat', project: p.id, title: input.value.trim() || undefined, req: newReq(then) });
    dialog.close();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') void start();
  };
  const buttons = el('div', 'buttons');
  buttons.append(button('START', () => void start(), 'primary'), button('CANCEL', () => dialog.close()));
  const help = el('p', 'project-help', 'A new chat in this project: same folder and shared memory file. It sits with the others in the tab bar and THREADS, and the lead chat can see it and send it work.');
  dialog.replaceChildren(el('h2', '', `NEW CHAT IN ${p.name.toUpperCase()}`), help, input, first.block, buttons);
  if (!dialog.open) dialog.showModal();
  input.focus();
}
