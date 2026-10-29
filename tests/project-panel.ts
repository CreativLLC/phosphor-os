// Project settings: INSTRUCTIONS (the user's own rules for a project, in every project chat's system prompt).
// Fake tabs only: no Claude process starts, nothing is written to data/ (the project book uses a temp folder).
//   npx tsx tests/project-panel.ts

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTRUCTIONS_MAX, MEMORY_MAX } from '../shared/protocol.ts';
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
const saved = book.setDoc('p1', 'instructions', 'Use Godot 4.\r\nWrite in my voice.\n\n');
check('saved: trimmed, plain newlines, in INSTRUCTIONS.md', 'ok' in saved && readFileSync(join(root, 'p1', 'INSTRUCTIONS.md'), 'utf8') === 'Use Godot 4.\nWrite in my voice.\n');
check('read back', book.instructions('p1').text === 'Use Godot 4.\nWrite in my voice.\n' && book.instructions('p1').updatedAt > 0);
check('too long: refused, the old text stays', 'error' in book.setDoc('p1', 'instructions', 'x'.repeat(INSTRUCTIONS_MAX + 1)) && /Godot/.test(book.instructions('p1').text));
check('the cap counts bytes, not letters', 'error' in book.setDoc('p1', 'instructions', 'é'.repeat(INSTRUCTIONS_MAX / 2 + 1)) && 'ok' in book.setDoc('p1', 'instructions', 'é'.repeat(INSTRUCTIONS_MAX / 2)));
check('empty text removes the file', 'ok' in book.setDoc('p1', 'instructions', '   ') && !existsSync(join(root, 'p1', 'INSTRUCTIONS.md')) && book.instructions('p1').text === '');
check('bad or unknown ids are refused', 'error' in book.setDoc('../p1', 'instructions', 'x') && 'error' in book.setDoc('nope', 'instructions', 'x') && book.instructions('../p1').text === '' && !existsSync(join(root, 'nope')));
const outside = join(root, 'outside.txt');
writeFileSync(outside, 'secret');
symlinkSync(outside, join(root, 'p1', 'INSTRUCTIONS.md'));
check('a link in its place is neither read nor written through', book.instructions('p1').text === '' && 'error' in book.setDoc('p1', 'instructions', 'x') && readFileSync(outside, 'utf8') === 'secret');
rmSync(join(root, 'p1', 'INSTRUCTIONS.md'));
rmSync(outside);

// ---- MEMORY: PROJECT.md, which the chats write too. A save over a newer version is refused unless based on it.
const mem = join(root, 'p1', 'PROJECT.md');
writeFileSync(mem, '# Game jam\n\nGoal: a puzzle game.\n');
const m1 = book.doc('p1', 'memory')!;
check('memory: read with a version', m1.text === '# Game jam\n\nGoal: a puzzle game.\n' && m1.version.length > 0 && m1.updatedAt > 0);
const m2 = book.setDoc('p1', 'memory', '# Game jam\r\n\r\nGoal: a puzzle game in Godot.\n', m1.version);
check('memory: saved on the version it was loaded at, kept as typed (plain newlines)', 'ok' in m2 && readFileSync(mem, 'utf8') === '# Game jam\n\nGoal: a puzzle game in Godot.\n' && m2.version === book.doc('p1', 'memory')!.version);
writeFileSync(mem, readFileSync(mem, 'utf8') + '- Art thread: 3 sprites done\n'); // a chat writes it
const stale = book.setDoc('p1', 'memory', 'my edit', m1.version);
check('memory: a save over a chat\'s newer edit is refused, with the file as it is now', 'error' in stale && stale.changed?.text.includes('3 sprites') === true && readFileSync(mem, 'utf8').includes('3 sprites'), JSON.stringify(stale));
check('memory: saved when based on the new version (OVERWRITE)', 'ok' in book.setDoc('p1', 'memory', 'my edit\n', 'error' in stale ? stale.changed!.version : '') && readFileSync(mem, 'utf8') === 'my edit\n');
check('memory: empty text keeps the file (empty)', 'ok' in book.setDoc('p1', 'memory', '') && existsSync(mem) && readFileSync(mem, 'utf8') === '');
check('memory: too long is refused', 'error' in book.setDoc('p1', 'memory', 'x'.repeat(MEMORY_MAX + 1)));
writeFileSync(mem, 'x'.repeat(MEMORY_MAX * 2 + 1));
check('memory: a file grown far past the cap is not loaded', book.doc('p1', 'memory') === undefined);
writeFileSync(mem, '# Game jam\n');

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
const r = tabs.saveProjectDoc('p1', 'instructions', 'Use Godot 4.');
check('setInstructions: saved, counts the chats and the ones still working', 'ok' in r && r.chats === 3 && r.waiting === 2 && d.closed() === 0, JSON.stringify(r));
check('the prompt hook reads the saved text', Tab.projects?.instructions?.('p1') === 'Use Godot 4.\n');
live(idle);
const e = live(idle);
const rm = tabs.saveProjectDoc('p1', 'memory', '# Game jam\n\nNew goal.\n');
check('saving MEMORY restarts no chat (they read the file themselves)', 'ok' in rm && rm.chats === undefined && e.closed() === 0);
check('setInstructions: an unknown project is an error', 'error' in tabs.saveProjectDoc('nope', 'instructions', 'x'));

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
