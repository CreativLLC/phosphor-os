import { INSTRUCTIONS_MAX, type InstructionsSaved, type ProjectInstructions } from '../../shared/protocol.ts';
import { store } from './store.ts';
import { button, confirmBox, el, toast } from './ui.ts';

// INSTRUCTIONS (owner's ask 2026-10-28): the user's own rules for a project, like a CLAUDE.md for it ("write in my
// voice", "use Godot 4"). Saved to the project folder (INSTRUCTIONS.md, server/projects.ts); every chat of the project
// gets them in its system prompt from its next message (Tabs.setInstructions). Opened from PROJECTS and the tab menu.

const demoText: Record<string, string> = { 'demo-p': 'Write in my voice: short, plain words, no hype.\nVideos are 8 to 12 minutes.\nThumbnails: retro RPG look, big readable text.' };

export async function editInstructions(p: { id: string; name: string }): Promise<void> {
  let loaded: ProjectInstructions = { text: '', updatedAt: 0 };
  try {
    loaded = store.demo ? { text: demoText[p.id] ?? '', updatedAt: Date.now() } : ((await (await fetch(`/api/projects/${encodeURIComponent(p.id)}/instructions`)).json()) as ProjectInstructions);
  } catch {
    return toast('Could not load the instructions.');
  }
  const d = el('dialog', 'proj-edit');
  const area = el('textarea', 'proj-edit-text');
  area.value = loaded.text;
  area.placeholder = 'For example:\nWrite in my voice: short, plain words.\nUse Godot 4 and GDScript.\nAsk before deleting files.';
  area.spellcheck = true;
  const size = el('span', 'proj-edit-size');
  const bytes = () => new TextEncoder().encode(area.value.trim()).length;
  const count = () => {
    const n = bytes();
    size.textContent = `${(n / 1000).toFixed(1)} / ${INSTRUCTIONS_MAX / 1000} KB`;
    size.classList.toggle('over', n > INSTRUCTIONS_MAX);
  };
  area.oninput = count;
  count();

  const done = () => {
    d.close();
    d.remove();
  };
  const leave = async () => {
    if (area.value.trim() === loaded.text.trim() || (await confirmBox('DISCARD CHANGES?', 'Your edits to the instructions are not saved.', 'DISCARD'))) done();
  };
  const save = async () => {
    if (bytes() > INSTRUCTIONS_MAX) return toast(`Too long: at most ${INSTRUCTIONS_MAX / 1000} KB.`);
    if (store.demo) {
      demoText[p.id] = area.value.trim();
      done();
      return toast('Saved (demo).');
    }
    let r: InstructionsSaved;
    try {
      r = (await (await fetch(`/api/projects/${encodeURIComponent(p.id)}/instructions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: area.value }) })).json()) as InstructionsSaved;
    } catch {
      return toast('Not saved: the app did not answer.');
    }
    if ('error' in r) return toast(`Not saved: ${r.error}`);
    done();
    const later = r.waiting ? ` ${r.waiting} working chat${r.waiting === 1 ? ' gets' : 's get'} it once done.` : '';
    toast(r.chats ? `Saved. Applies from each chat's next message.${later}` : 'Saved. Applies when a chat of this project starts.', 6000);
  };

  const head = el('h2', '', `INSTRUCTIONS: ${p.name.toUpperCase()}`);
  const help = el('p', 'proj-edit-help', 'Your own rules for this project, like a CLAUDE.md. Every chat in it (lead and threads) follows them, from its next message.');
  const foot = el('div', 'buttons');
  foot.append(size, button('SAVE', () => void save(), 'primary'), button('CANCEL', () => void leave()));
  d.append(head, help, area, foot);
  d.addEventListener('cancel', (e) => {
    e.preventDefault();
    void leave();
  });
  area.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
  };
  document.body.append(d);
  d.showModal();
  area.focus();
}
