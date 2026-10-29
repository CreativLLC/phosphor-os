import { INSTRUCTIONS_MAX, MEMORY_MAX, type DocSaved, type ProjectDoc, type ProjectDocKind } from '../../shared/protocol.ts';
import { store } from './store.ts';
import { button, confirmBox, el, pickBox, timeAgo, toast } from './ui.ts';

// A project's two text files, edited in the app (server/projects.ts, ProjectBook.doc/setDoc):
// - INSTRUCTIONS (owner's ask 2026-10-28): the user's own rules for the project, like a CLAUDE.md for it ("write in my
//   voice", "use Godot 4"). Every chat of the project gets them in its system prompt from its next message.
// - MEMORY: PROJECT.md, the shared memory file the chats read and keep current. The chats write it too, so the editor
//   watches the file while open: with no edits here it takes a chat's change at once; with edits it says so, and a
//   save over a newer version asks first (the server refuses it unless the user picks OVERWRITE).
// Opened from PROJECTS and the tab menu of a project chat.

const KINDS: Record<ProjectDocKind, { title: string; help: string; placeholder: string; max: number }> = {
  instructions: {
    title: 'INSTRUCTIONS',
    help: 'Your own rules for this project, like a CLAUDE.md. Every chat in it (lead and threads) follows them, from its next message.',
    placeholder: 'For example:\nWrite in my voice: short, plain words.\nUse Godot 4 and GDScript.\nAsk before deleting files.',
    max: INSTRUCTIONS_MAX,
  },
  memory: {
    title: 'MEMORY',
    help: "The project's shared memory (PROJECT.md): goal, decisions, what each chat is doing. The chats read it and keep it current; your edits count from their next read.",
    placeholder: '# Project name\n\nGoal, decisions, open questions.',
    max: MEMORY_MAX,
  },
};

const POLL_MS = 4000;
const lf = (s: string) => s.replace(/\r\n/g, '\n');

// Demo (?demo=1): texts kept in this page; the YT project's memory gets a chat's edit 5 s after it opens.
const demoDocs: Record<string, string> = {
  'instructions:demo-p': 'Write in my voice: short, plain words, no hype.\nVideos are 8 to 12 minutes.\nThumbnails: retro RPG look, big readable text.\n',
  'memory:demo-p': '# YT: Claude video\n\n## Goal\nA 10 minute video on running Claude Code from a retro desktop.\n\n## Decisions\n- Title: "I gave Claude a CRT"\n- Record on Saturday\n\n## Threads\n- Thumbnails: 6 drafts, picking 2\n- Outline: done, 6 beats\n',
};
let demoOpened = 0;
function demoDoc(id: string, kind: ProjectDocKind): ProjectDoc {
  const key = `${kind}:${id}`;
  if (key === 'memory:demo-p' && demoOpened && Date.now() - demoOpened > 5000 && !demoDocs[key].includes('Script')) demoDocs[key] += '- Script: first draft written\n';
  const text = demoDocs[key] ?? '';
  return { text, updatedAt: Date.now() - (key === 'memory:demo-p' && !text.includes('Script') ? 180000 : 0), version: String(text.length) };
}

const url = (id: string, kind: ProjectDocKind) => `/api/projects/${encodeURIComponent(id)}/${kind}`;

export async function loadDoc(id: string, kind: ProjectDocKind): Promise<ProjectDoc> {
  if (store.demo) return demoDoc(id, kind);
  const r = (await (await fetch(url(id, kind))).json()) as ProjectDoc | { error: string };
  if ('error' in r) throw new Error(r.error);
  return r;
}

async function save(id: string, kind: ProjectDocKind, text: string, base: string): Promise<DocSaved> {
  if (store.demo) {
    const now = demoDoc(id, kind);
    if (now.version !== base) return { error: 'The file changed since you opened it.', changed: now };
    demoDocs[`${kind}:${id}`] = text;
    return { ok: true, ...demoDoc(id, kind) };
  }
  return (await (await fetch(url(id, kind), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, base }) })).json()) as DocSaved;
}

// onClose: after the box closes (saved or not), so the project panel can show the new state.
export const editInstructions = (p: { id: string; name: string }, onClose?: () => void) => editProjectDoc(p, 'instructions', onClose);
export const editMemory = (p: { id: string; name: string }, onClose?: () => void) => editProjectDoc(p, 'memory', onClose);

async function editProjectDoc(p: { id: string; name: string }, kind: ProjectDocKind, onClose?: () => void): Promise<void> {
  const k = KINDS[kind];
  let doc: ProjectDoc;
  try {
    if (store.demo && kind === 'memory') demoOpened = Date.now();
    doc = await loadDoc(p.id, kind);
  } catch (e) {
    return toast(`Could not load the ${k.title.toLowerCase()}${e instanceof Error && e.message ? `: ${e.message}` : '.'}`);
  }
  const d = el('dialog', 'proj-edit');
  const area = el('textarea', 'proj-edit-text');
  area.placeholder = k.placeholder;
  area.spellcheck = true;
  const size = el('span', 'proj-edit-size');
  const note = el('div', 'proj-edit-note');
  note.hidden = true;
  const edited = () => lf(area.value) !== lf(doc.text);
  const bytes = () => new TextEncoder().encode(area.value).length;
  const count = () => {
    const n = bytes();
    size.textContent = `${(n / 1000).toFixed(1)} / ${k.max / 1000} KB${doc.updatedAt ? ` · CHANGED ${timeAgo(doc.updatedAt).toUpperCase()}` : ''}`;
    size.classList.toggle('over', n > k.max);
  };
  const take = (next: ProjectDoc) => {
    doc = next;
    area.value = next.text;
    note.hidden = true;
    count();
  };
  take(doc);
  area.oninput = count;

  // The file changed on disk (a chat wrote it): taken at once with no edits here, else the user picks.
  let newer: ProjectDoc | undefined;
  const changedOnDisk = (next: ProjectDoc) => {
    if (next.version === doc.version) return;
    if (!edited()) {
      take(next);
      note.textContent = 'A CHAT UPDATED THIS FILE. SHOWN NOW.';
      note.hidden = false;
      return;
    }
    newer = next;
    const loadBtn = button('LOAD IT', () => newer && take(newer), 'proj-edit-load');
    loadBtn.title = 'Show the new version. Your unsaved edits here go.';
    note.replaceChildren(el('span', '', `A CHAT CHANGED THIS FILE ${timeAgo(next.updatedAt).toUpperCase()}, AFTER YOU OPENED IT.`), loadBtn);
    note.hidden = false;
  };
  const poll = setInterval(() => {
    if (!d.open) return;
    count(); // the CHANGED time moves on
    loadDoc(p.id, kind).then(changedOnDisk, () => {});
  }, POLL_MS);

  const done = () => {
    clearInterval(poll);
    d.close();
    d.remove();
    onClose?.();
  };
  const leave = async () => {
    if (!edited() || (await confirmBox('DISCARD CHANGES?', `Your edits to the ${k.title.toLowerCase()} are not saved.`, 'DISCARD'))) done();
  };
  const commit = async (base: string): Promise<void> => {
    if (bytes() > k.max) return toast(`Too long: at most ${k.max / 1000} KB.`);
    let r: DocSaved;
    try {
      r = await save(p.id, kind, area.value, base);
    } catch {
      return toast('Not saved: the app did not answer.');
    }
    if ('error' in r && r.changed) {
      const pick = await pickBox<'mine' | 'theirs'>('THE FILE CHANGED', [
        { head: `A chat wrote to it ${timeAgo(r.changed.updatedAt)}, after you opened it.` },
        { label: 'OVERWRITE WITH MINE', value: 'mine' },
        { label: 'LOAD THE NEW VERSION (DROP MY EDITS)', value: 'theirs' },
      ]);
      if (pick === 'mine') return commit(r.changed.version);
      if (pick === 'theirs') take(r.changed);
      return;
    }
    if ('error' in r) return toast(`Not saved: ${r.error}`);
    done();
    if (kind === 'memory') return toast('Saved. The chats see it from their next read.');
    const later = r.waiting ? ` ${r.waiting} working chat${r.waiting === 1 ? ' gets' : 's get'} it once done.` : '';
    toast(r.chats ? `Saved. Applies from each chat's next message.${later}` : 'Saved. Applies when a chat of this project starts.', 6000);
  };

  const head = el('h2', '', `${k.title}: ${p.name.toUpperCase()}`);
  const help = el('p', 'proj-edit-help', k.help);
  const foot = el('div', 'buttons');
  foot.append(size, button('SAVE', () => void commit(doc.version), 'primary'), button('CANCEL', () => void leave()));
  d.append(head, help, note, area, foot);
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    void leave();
  });
  area.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void commit(doc.version);
  };
  document.body.append(d);
  d.showModal();
  area.focus();
  area.setSelectionRange(0, 0);
}
