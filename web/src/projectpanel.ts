import { AUTO_MODEL, EFFORTS, isGeminiModel, isImageModel, MODES, type ModelChoice, type ProjectDefaults, type ProjectsResponse, type ProjectSummary, type TabState } from '../../shared/protocol.ts';
import { demoProjects } from './demo.ts';
import { newReq, send } from './net.ts';
import { editInstructions, editMemory, loadDoc } from './projectedit.ts';
import { editFiles, fmtSize, listFiles } from './projectfiles.ts';
import { deleteProject, newProjectChat, projectTabs } from './projects.ts';
import { MODE_LABELS } from './chat.ts';
import { store, working } from './store.ts';
import { button, el, timeAgo, toast } from './ui.ts';

// PROJECT PANEL (owner's ask 2026-10-28): one place per project for its name (RENAME), its chats with how each is
// doing (a tap goes to one; a closed one comes back), OPEN LEAD, + CHAT, REOPEN, and its INSTRUCTIONS, MEMORY and
// FILES (each opens its own box over the panel), and DELETE. Opened from PANEL on a PROJECTS row, from a project
// chat's tab menu, and by right-clicking a project's label in the tab bar.

let openNow: HTMLDialogElement | undefined;

// leave: closes whatever the panel was opened from (the PROJECTS drawer) when it goes to a chat.
// changed: after a rename or delete, so that list can load again.
export async function openPanel(start: { id: string; name: string }, leave?: () => void, changed?: () => void): Promise<void> {
  openNow?.close();
  const p = { id: start.id, name: start.name };
  const d = el('dialog', 'proj-edit proj-panel');
  openNow = d;
  const title = el('h2', '');
  const body = el('div', 'pp-body');
  let saved: ProjectSummary | undefined;

  const go = (fn: () => void) => {
    close();
    leave?.();
    fn();
  };

  // ---- Name
  const name = el('input', 'pp-name');
  name.maxLength = 60;
  name.value = p.name;
  const renameBtn = button('RENAME', () => void rename(), 'pp-rename');
  name.oninput = () => (renameBtn.disabled = !name.value.trim() || name.value.trim() === p.name);
  name.onkeydown = (e) => {
    if (e.key === 'Enter') void rename();
  };
  renameBtn.disabled = true;
  const rename = async () => {
    const next = name.value.trim();
    if (!next || next === p.name) return;
    if (!store.demo) {
      const r = (await fetch(`/api/projects/${encodeURIComponent(p.id)}/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: next }) })
        .then((x) => x.json())
        .catch(() => ({ error: 'the app did not answer' }))) as { name?: string; error?: string };
      if (r.error) return toast(`Not renamed: ${r.error}`);
    }
    p.name = next;
    name.value = next;
    renameBtn.disabled = true;
    showTitle();
    changed?.();
    toast('Renamed.');
  };
  const showTitle = () => (title.textContent = `PROJECT: ${p.name.toUpperCase()}`);
  showTitle();
  const nameRow = el('div', 'pp-row');
  nameRow.append(name, renameBtn);

  // ---- Chats: open ones live from the tabs, closed ones from the saved list.
  const chats = el('div', 'pp-chats');
  const chatTools = el('div', 'pp-tools');
  const chatsHead = el('h3', 'pp-head', 'CHATS');
  const stateOf = (t: TabState) => (t.meta.attention ? 'NEEDS YOU' : working(t) ? 'WORKING' : 'OPEN');
  const renderChats = () => {
    const tabs = projectTabs(p.id);
    const closed = saved?.closed ?? [];
    chatsHead.textContent = `CHATS · ${tabs.length + closed.length}`;
    const row = (label: string, lead: boolean, state: string, title: string, fn: () => void) => {
      const b = button('', () => go(fn), `pp-chat st-${state.toLowerCase().replace(/ /g, '-')}`);
      b.append(el('span', 'pp-chat-name', `${lead ? 'LEAD · ' : ''}${label}`), el('span', 'pp-chat-state', state));
      b.title = title;
      return b;
    };
    chats.replaceChildren(
      ...tabs.map((t) => row(t.meta.title, !!t.meta.project?.main, stateOf(t), 'Go to this chat', () => store.setActive(t.meta.id))),
      ...closed.map((c) => row(c.title, c.main, 'CLOSED', 'Open this chat again, in the project', () => send({ t: 'open_session', sessionId: c.sessionId, cwd: '', title: c.title, req: newReq() }))),
    );
    if (!tabs.length && !closed.length) chats.append(el('div', 'empty', saved ? 'No saved chats. OPEN LEAD starts a lead chat on its memory.' : 'Loading…'));
    const tools: HTMLElement[] = [];
    if (tabs.length) tools.push(button('+ CHAT', () => go(() => newProjectChat(p))));
    if (!tabs.some((t) => t.meta.project?.main)) {
      const lead = button('OPEN LEAD', () => go(() => send(tabs.length || !closed.length ? { t: 'open_lead', project: p.id, req: newReq() } : { t: 'open_project', project: p.id, req: newReq() })));
      lead.title = "The project's lead chat: it sees and steers the other chats";
      tools.push(lead);
    }
    if (closed.length > 1 || (closed.length && tabs.length)) tools.push(button(`REOPEN ${closed.length} CLOSED`, () => go(() => send({ t: 'open_project', project: p.id, req: newReq() }))));
    chatTools.replaceChildren(...tools);
  };

  // ---- INSTRUCTIONS, MEMORY, FILES: a line on each, and a button that opens its box over the panel.
  const part = (head: string, open: string, edit: () => void) => {
    const box = el('div', 'pp-part');
    const line = el('div', 'pp-line', '…');
    const top = el('div', 'pp-part-top');
    top.append(el('h3', 'pp-head', head), button(open, edit));
    box.append(top, line);
    return { box, line };
  };
  const rules = part('INSTRUCTIONS', 'EDIT', () => void editInstructions(p, refresh));
  const memory = part('MEMORY', 'OPEN', () => void editMemory(p, refresh));
  const files = part('FILES', 'MANAGE', () => void editFiles(p, refresh));
  const changedAgo = (t: number) => (t ? ` · changed ${timeAgo(t)}` : '');
  const refresh = async () => {
    const [list, r, m, f] = await Promise.allSettled([
      store.demo ? Promise.resolve(demoProjects()) : fetch('/api/projects').then(async (x) => ((await x.json()) as ProjectsResponse).projects ?? []),
      loadDoc(p.id, 'instructions'),
      loadDoc(p.id, 'memory'),
      listFiles(p.id),
    ]);
    if (list.status === 'fulfilled') saved = list.value.find((x) => x.id === p.id) ?? { id: p.id, name: p.name, createdAt: 0, lastActive: 0, closed: [] };
    renderChats();
    if (saveDefs.disabled) fillDefaults(saved?.defaults ?? {}); // not over a choice still to save
    if (r.status === 'fulfilled') {
      const lines = r.value.text.split('\n').filter((l) => l.trim());
      rules.line.textContent = lines.length ? `${lines[0].slice(0, 90)}${lines.length > 1 ? ` (+${lines.length - 1} more line${lines.length === 2 ? '' : 's'})` : ''}${changedAgo(r.value.updatedAt)}` : 'None yet. Your own rules for every chat in this project.';
    } else rules.line.textContent = 'Could not load.';
    memory.line.textContent = m.status === 'fulfilled' ? (m.value.text.trim() ? `${fmtSize(new TextEncoder().encode(m.value.text).length)}${changedAgo(m.value.updatedAt)}` : 'Empty.') : 'Could not load.';
    if (f.status === 'fulfilled') {
      const n = f.value.length;
      files.line.textContent = n ? `${n} file${n === 1 ? '' : 's'} · ${fmtSize(f.value.reduce((s, x) => s + x.size, 0))}: ${f.value.slice(0, 4).map((x) => x.name).join(', ')}${n > 4 ? ', …' : ''}` : 'None yet. Notes, PDFs, pictures, code every chat here can read.';
    } else files.line.textContent = 'Could not load.';
  };

  // ---- DEFAULTS: what new chats here start with (+ CHAT, a thread the lead starts without a worker, a new lead).
  const defaults = el('div', 'pp-part');
  const modelSel = el('select', 'pp-select');
  const effortSel = el('select', 'pp-select');
  const modeSel = el('select', 'pp-select');
  const saveDefs = button('SAVE', () => void storeDefaults(), 'pp-defaults-save');
  saveDefs.disabled = true; // until a choice changes
  let models: ModelChoice[] = [];
  let shown: ProjectDefaults = {};
  const option = (value: string, label: string) => {
    const o = el('option', '', label);
    o.value = value;
    return o;
  };
  const fillEffort = () => {
    const m = models.find((x) => x.value === modelSel.value);
    const want = effortSel.value || shown.effort || '';
    effortSel.replaceChildren(option('', modelSel.value === AUTO_MODEL ? 'AUTO PICKS' : 'MODEL DEFAULT'), ...(m?.efforts ?? []).map((e) => option(e, e.toUpperCase())));
    effortSel.value = m?.efforts.includes(want as never) ? want : '';
    effortSel.disabled = modelSel.value === AUTO_MODEL || !m?.efforts.length;
  };
  const fillDefaults = (d: ProjectDefaults) => {
    shown = d;
    const list = models.filter((m) => m.value !== AUTO_MODEL && !isImageModel(m.value) && !isGeminiModel(m.value));
    const known = !d.model || list.some((m) => m.value === d.model);
    modelSel.replaceChildren(option(AUTO_MODEL, 'AUTO'), ...list.map((m) => option(m.value, m.label.toUpperCase())), ...(known ? [] : [option(d.model!, `${d.model!.toUpperCase()} (GONE)`)]));
    modelSel.value = d.model ?? AUTO_MODEL;
    effortSel.value = '';
    fillEffort();
    modeSel.replaceChildren(option('', 'ASK FIRST (APP DEFAULT)'), ...MODES.filter((m) => m !== 'default').map((m) => option(m, MODE_LABELS[m] ?? m)));
    modeSel.value = d.mode ?? '';
    saveDefs.disabled = true;
  };
  const pickedDefaults = (): ProjectDefaults => ({
    ...(modelSel.value && modelSel.value !== AUTO_MODEL ? { model: modelSel.value } : {}),
    ...(effortSel.value && !effortSel.disabled ? { effort: effortSel.value as (typeof EFFORTS)[number] } : {}),
    ...(modeSel.value ? { mode: modeSel.value as (typeof MODES)[number] } : {}),
  });
  const dirty = () => (saveDefs.disabled = JSON.stringify(pickedDefaults()) === JSON.stringify(shown));
  modelSel.onchange = () => {
    fillEffort();
    dirty();
  };
  effortSel.onchange = dirty;
  modeSel.onchange = dirty;
  const storeDefaults = async () => {
    const d = pickedDefaults();
    if (!store.demo) {
      const r = (await fetch(`/api/projects/${encodeURIComponent(p.id)}/defaults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
        .then((x) => x.json())
        .catch(() => ({ error: 'the app did not answer' }))) as { defaults?: ProjectDefaults; error?: string };
      if (r.error) return toast(`Not saved: ${r.error}`);
      fillDefaults(r.defaults ?? {});
    } else fillDefaults(d);
    toast('Saved. New chats in this project start with these.');
  };
  const field = (label: string, sel: HTMLSelectElement) => {
    const f = el('label', 'pp-field');
    f.append(el('span', '', label), sel);
    return f;
  };
  const defTop = el('div', 'pp-part-top');
  defTop.append(el('h3', 'pp-head', 'DEFAULTS FOR NEW CHATS'), saveDefs);
  const defRow = el('div', 'pp-fields');
  defRow.append(field('MODEL', modelSel), field('THINK', effortSel), field('MODE', modeSel));
  defaults.append(defTop, defRow);
  defaults.title = '+ CHAT, threads the lead starts without picking a worker, and a new lead start with these. Chats that exist keep their own.';
  const loadModels = async () => {
    try {
      models = ((await (await fetch('/api/models')).json()) as { models?: ModelChoice[] }).models ?? [];
    } catch {
      models = [];
    }
  };

  const off = store.on((c) => {
    if (c.kind === 'tabs' || (c.kind === 'patch' && (c.key === 'meta' || c.key === 'agents'))) renderChats();
  });
  const close = () => {
    off();
    if (openNow === d) openNow = undefined;
    d.close();
    d.remove();
  };

  const nameBox = el('div', 'pp-part');
  nameBox.append(el('h3', 'pp-head', 'NAME'), nameRow);
  const chatBox = el('div', 'pp-part');
  chatBox.append(chatsHead, chats, chatTools);
  body.append(nameBox, chatBox, rules.box, memory.box, files.box, defaults);
  const del = button('DELETE PROJECT', () => {
    void deleteProject(saved ?? { id: p.id, name: p.name, createdAt: 0, lastActive: 0, closed: [] }, projectTabs(p.id)).then((gone) => {
      if (!gone) return;
      close();
      changed?.();
    });
  }, 'project-delete');
  const foot = el('div', 'buttons');
  foot.append(del, button('CLOSE', close, 'primary'));
  d.append(title, body, foot);
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  renderChats();
  document.body.append(d);
  d.showModal();
  await loadModels();
  await refresh();
}
