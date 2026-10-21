import { ideasPrompt, type Idea, type IdeasResponse } from '../../shared/ideas.ts';
import { demoIdeas } from './demo.ts';
import { newReq, send } from './net.ts';
import { store } from './store.ts';
import { button, confirmBox, el, toast } from './ui.ts';

// IDEAS section under TODAY in the left column (agents.ts mounts it): the "do this later" file (server/ideas.ts,
// format in shared/ideas.ts). Tap ideas to pick them, DO opens a new chat that works through them (and deletes
// each line when done), X drops one. Hidden when the file does not exist.
// Refresh: every minute while the page is visible (six times slower in GAME MODE), and on coming back into view.

const EVERY_MS = 60_000;
const gaming = () => document.documentElement.dataset.game === 'on';

type Heading = { el: HTMLElement; extra: HTMLElement };

export function mountIdeas(root: HTMLElement, head: Heading): void {
  root.classList.add('ideas');
  const list = el('div', 'ideas-list');
  const body = el('div', 'ideas-body');
  body.append(list);
  const doBtn = button('', () => doPicked(), 'ideas-do');
  const clearBtn = button('CLEAR', () => {
    picked.clear();
    render();
  }, 'ideas-clear');
  const bar = el('div', 'ideas-bar');
  bar.append(doBtn, clearBtn);
  root.replaceChildren(head.el, body, bar);
  root.hidden = true; // until the server has answered once

  let data: IdeasResponse | undefined;
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const picked = new Set<string>(); // by line, so a pick survives a reload

  function row(i: Idea): HTMLElement {
    const r = el('article', 'ideas-row');
    const mark = el('span', 'ideas-mark');
    const paint = () => {
      const on = picked.has(i.line);
      r.classList.toggle('on', on);
      r.setAttribute('aria-checked', String(on));
      mark.textContent = on ? '[x]' : '[ ]';
    };
    paint();
    r.tabIndex = 0;
    r.setAttribute('role', 'checkbox');
    r.title = [i.text, i.project, i.date].filter(Boolean).join(' · ');
    const text = el('div', 'ideas-text', i.text);
    if (i.project) text.prepend(el('span', 'ideas-proj', i.project));
    const drop = button('X', () => void dropOne(i), 'ideas-drop');
    drop.title = 'Drop this idea (deletes its line)';
    drop.setAttribute('aria-label', 'Drop');
    r.append(mark, text, drop);
    // In place, not a redraw: on a phone the left panel closes on a tap whose target has left the page (main.ts).
    const toggle = () => {
      if (picked.has(i.line)) picked.delete(i.line);
      else picked.add(i.line);
      paint();
      renderBar();
    };
    r.onclick = (e) => {
      if (!(e.target as HTMLElement).closest('.ideas-drop')) toggle();
    };
    r.onkeydown = (e) => {
      if (e.target === r && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        toggle();
      }
    };
    return r;
  }

  function render(): void {
    if (!data) return;
    root.hidden = !data.found;
    if (!data.found) return;
    const lines = new Set(data.ideas.map((i) => i.line));
    for (const l of picked) if (!lines.has(l)) picked.delete(l);
    const parked = data.ideas.filter((i) => i.section === 'parked');
    const suggested = data.ideas.filter((i) => i.section === 'suggested');
    head.extra.textContent = data.ideas.length ? String(data.ideas.length) : '';
    list.replaceChildren(
      ...(data.ideas.length ? [] : [el('div', 'ideas-empty', 'Nothing parked. Say "park this" in any chat.')]),
      ...parked.map(row),
      ...(suggested.length ? [el('div', 'today-sub', 'SUGGESTED')] : []),
      ...suggested.map(row),
    );
    renderBar();
  }

  function renderBar(): void {
    bar.hidden = !picked.size;
    doBtn.textContent = `DO ${picked.size}`;
    doBtn.title = 'Open a new chat that works through the picked ideas';
  }

  function doPicked(): void {
    if (!data) return;
    const chosen = data.ideas.filter((i) => picked.has(i.line));
    if (!chosen.length) return;
    const text = ideasPrompt(chosen, data.file);
    picked.clear();
    render();
    document.body.classList.remove('show-left'); // phone: show the new chat
    send({ t: 'new_tab', req: newReq((tab) => send({ t: 'send', tab, text })) });
  }

  async function dropOne(i: Idea): Promise<void> {
    if (!(await confirmBox('DROP IDEA?', `"${i.text}" is deleted from the list.`, 'DROP'))) return;
    picked.delete(i.line);
    if (store.demo) {
      data = data && { ...data, ideas: data.ideas.filter((x) => x.line !== i.line) };
      return render();
    }
    try {
      const r = await fetch('/api/ideas/drop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [i.line] }) });
      if (!r.ok) throw new Error(String(r.status));
      data = (await r.json()) as IdeasResponse;
      render();
    } catch {
      toast('Could not drop that idea.');
    }
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      if (store.demo) data ??= demoIdeas();
      else {
        const r = await fetch('/api/ideas', { cache: 'no-store' });
        if (r.ok) data = (await r.json()) as IdeasResponse;
      }
    } catch {
      /* server not reachable: keep what is on screen */
    }
    loading = false;
    render();
    schedule();
  }

  function schedule(): void {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(() => void load(), EVERY_MS * (gaming() ? 6 : 1));
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void load();
  });
  setTimeout(() => void load(), 0); // main.ts decides demo mode after the panels are mounted
}
