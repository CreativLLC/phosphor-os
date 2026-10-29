// Project settings: INSTRUCTIONS (the user's own rules for a project, in every project chat's system prompt).
// Fake tabs only: no Claude process starts, nothing is written to data/ (the project book uses a temp folder).
//   npx tsx tests/project-panel.ts

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTRUCTIONS_MAX } from '../shared/protocol.ts';
import { ProjectBook } from '../server/projects.ts';
import { projectRules, Tab } from '../server/tab.ts';
import { Tabs } from '../server/tabs.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};

const root = mkdtempSync(join(tmpdir(), 'phosphor-projects-'));
const book = new ProjectBook(root);
book.create('p1', 'Game jam');

// ---- The book: INSTRUCTIONS.md in the project folder.
check('none yet: empty', book.instructions('p1').text === '' && book.instructions('p1').updatedAt === 0);
const saved = book.setInstructions('p1', 'Use Godot 4.\r\nWrite in my voice.\n\n');
check('saved: trimmed, plain newlines, in INSTRUCTIONS.md', 'ok' in saved && readFileSync(join(root, 'p1', 'INSTRUCTIONS.md'), 'utf8') === 'Use Godot 4.\nWrite in my voice.\n');
check('read back', book.instructions('p1').text === 'Use Godot 4.\nWrite in my voice.\n' && book.instructions('p1').updatedAt > 0);
check('too long: refused, the old text stays', 'error' in book.setInstructions('p1', 'x'.repeat(INSTRUCTIONS_MAX + 1)) && /Godot/.test(book.instructions('p1').text));
check('the cap counts bytes, not letters', 'error' in book.setInstructions('p1', 'é'.repeat(INSTRUCTIONS_MAX / 2 + 1)) && 'ok' in book.setInstructions('p1', 'é'.repeat(INSTRUCTIONS_MAX / 2)));
check('empty text removes the file', 'ok' in book.setInstructions('p1', '   ') && !existsSync(join(root, 'p1', 'INSTRUCTIONS.md')) && book.instructions('p1').text === '');
check('bad or unknown ids are refused', 'error' in book.setInstructions('../p1', 'x') && 'error' in book.setInstructions('nope', 'x') && book.instructions('../p1').text === '' && !existsSync(join(root, 'nope')));
const outside = join(root, 'outside.txt');
writeFileSync(outside, 'secret');
symlinkSync(outside, join(root, 'p1', 'INSTRUCTIONS.md'));
check('a link in its place is neither read nor written through', book.instructions('p1').text === '' && 'error' in book.setInstructions('p1', 'x') && readFileSync(outside, 'utf8') === 'secret');
rmSync(join(root, 'p1', 'INSTRUCTIONS.md'));
rmSync(outside);

// ---- The prompt text: marked as the user's, after projectHelp; nothing when empty.
const ref = { id: 'p1', name: 'Game jam', main: true };
const rules = projectRules(ref, 'Use Godot 4.');
check('rules text: marked as the user\'s instructions, wrapped, with the project name', /user's instructions for the project "Game jam"/.test(rules) && /<project-instructions>\nUse Godot 4\.\n<\/project-instructions>$/.test(rules) && /do not change .*INSTRUCTIONS\.md/.test(rules), rules);
check('rules text: none for empty instructions', projectRules(ref, '  \n') === '');

// ---- A chat restarts its Claude process when idle, never mid-work.
type Inner = { q?: { close(): void }; run?: { inbox: unknown[]; closed: boolean; wake?: () => void }; promptStale: boolean; setBusy(b: boolean): void };
const live = (t: Tab) => {
  const i = t as unknown as Inner;
  let closed = 0;
  i.q = { close: () => void closed++ };
  i.run = { inbox: [], closed: false };
  return { i, closed: () => closed };
};
const idle = new Tab(() => {}, { cwd: '/tmp', title: 'Lead', project: ref });
const a = live(idle);
check('idle chat: restarts now (next message starts it with the new prompt)', idle.refreshPrompt() === false && a.closed() === 1 && !a.i.q);
const notStarted = new Tab(() => {}, { cwd: '/tmp', title: 'New', project: ref });
check('a chat with no Claude process: nothing to do', notStarted.refreshPrompt() === false);
const busy = new Tab(() => {}, { cwd: '/tmp', title: 'Art', project: { ...ref, main: false } });
const b = live(busy);
busy.state.meta.busy = true;
check('working chat: not cut off, waits', busy.refreshPrompt() === true && b.closed() === 0 && b.i.promptStale);
b.i.setBusy(false);
await new Promise((r) => setTimeout(r, 5));
check('working chat: restarts once it is done', b.closed() === 1 && !b.i.promptStale);
const agent = new Tab(() => {}, { cwd: '/tmp', title: 'Bg', project: { ...ref, main: false } });
const c = live(agent);
agent.state.agents.push({ id: 'a1', status: 'running' } as (typeof agent.state.agents)[number]);
check('a chat with a helper agent still running waits too', agent.refreshPrompt() === true && c.closed() === 0);

// ---- Tabs: saving applies to the project's open chats and feeds the prompt.
const proto = Tab.prototype as unknown as Record<string, unknown>;
proto.loadHistory = async () => {};
proto.prefillInfo = async () => {};
proto.syncSessionTitle = async () => {};
const tabs = new Tabs(() => {});
const T = tabs as unknown as { save(): void; book: ProjectBook; tabs: Map<string, Tab> };
T.save = () => {};
T.book = book;
for (const t of [idle, busy, agent]) T.tabs.set(t.id, t);
live(idle);
const d = live(busy);
busy.state.meta.busy = true;
const r = tabs.setInstructions('p1', 'Use Godot 4.');
check('setInstructions: saved, counts the chats and the ones still working', 'ok' in r && r.chats === 3 && r.waiting === 2 && d.closed() === 0, JSON.stringify(r));
check('the prompt hook reads the saved text', Tab.projects?.instructions?.('p1') === 'Use Godot 4.\n');
check('setInstructions: an unknown project is an error', 'error' in tabs.setInstructions('nope', 'x'));

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
