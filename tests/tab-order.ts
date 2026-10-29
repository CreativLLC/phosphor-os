// Tab bar order (a drag: reorder) and Ctrl+Shift+T (reopenClosed: the last closed chat comes back in its place).
// No Claude, no SDK reads, no tabs.json: those parts are stubbed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '../shared/protocol.ts';
import { ProjectBook } from '../server/projects.ts';
import { Tab } from '../server/tab.ts';
import { Tabs } from '../server/tabs.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond || !detail ? '' : `\n  ${detail}`}`);
  if (!cond) fail++;
};

const proto = Tab.prototype as unknown as Record<string, unknown>;
proto.loadHistory = async () => {};
proto.prefillInfo = async () => {};
proto.syncSessionTitle = async () => {};
proto.close = () => {};
const root = mkdtempSync(join(tmpdir(), 'phosphor-taborder-'));
const events: ServerEvent[] = [];
const tabs = new Tabs((ev) => events.push(ev));
const T = tabs as unknown as { save(): void; saveSoon(): void; book: ProjectBook };
T.save = () => {};
T.saveSoon = () => {};
T.book = new ProjectBook(root);
const titles = () => tabs.list().map((t) => t.meta.title).join(',');

for (const [s, title] of [['s-a', 'A'], ['s-b', 'B'], ['s-c', 'C'], ['s-d', 'D']]) await tabs.open(s, '/tmp', title);
const id = (title: string) => tabs.list().find((t) => t.meta.title === title)!.meta.id;
check('four chats open in order', titles() === 'A,B,C,D', titles());

tabs.reorder([id('C'), id('A')]);
check('reorder: the named ones first, the rest keep their order after them', titles() === 'C,A,B,D', titles());
const order = events.at(-1);
check('reorder: tab_order goes to every page', order?.t === 'tab_order' && order.ids.join() === tabs.list().map((t) => t.meta.id).join());
tabs.reorder(['nope', id('D'), 'x']);
check('reorder: unknown ids are ignored', titles() === 'D,C,A,B', titles());

tabs.close(id('C'));
tabs.close(id('B'));
check('closed two', titles() === 'D,A', titles());
await tabs.reopenClosed('r1');
check('Ctrl+Shift+T: the last closed (B) comes back in its place', titles() === 'D,A,B', titles());
await tabs.reopenClosed('r2');
check('Ctrl+Shift+T again: the one before (C) comes back in its place', titles() === 'D,C,A,B', titles());
const before = events.length;
await tabs.reopenClosed();
check('Ctrl+Shift+T with nothing left: a short notice, nothing opens', titles() === 'D,C,A,B' && events.slice(before).some((e) => e.t === 'toast'));

tabs.close(id('A'));
await tabs.open('s-a', '/tmp', 'A');
const n = tabs.list().length;
await tabs.reopenClosed();
check('a closed chat already open again is skipped', tabs.list().length === n && events.at(-1)?.t === 'toast');

// The tab menu: into a project (as the user's own chat under its lead), out again; a busy chat and a lead with
// chats hanging on it are refused.
// A project in the temp folder (createProject would write into the app's own data/projects).
T.book.create('pg1', 'Game');
await tabs.open('s-e', '/tmp', 'E');
tabs.get(id('E'))!.state.meta.project = { id: 'pg1', name: 'Game', main: true };
const lead = tabs.list().find((t) => t.meta.project?.main)!;
const pid = lead.meta.project!.id;
tabs.moveToProject(id('D'), pid);
const d = tabs.list().find((t) => t.meta.title === 'D')!;
check('move: D joins the project under its lead, as the user\'s own', d.meta.project?.id === pid && !d.meta.project.main && d.meta.project.parent === lead.meta.id && d.meta.project.own === true);
tabs.moveToProject(lead.meta.id, null);
check('move: the lead with a chat hanging on it stays', !!tabs.list().find((t) => t.meta.id === lead.meta.id)!.meta.project && events.at(-1)?.t === 'toast');
tabs.get(id('C'))!.state.meta.busy = true;
tabs.moveToProject(id('C'), pid);
check('move: a working chat is refused', !tabs.list().find((t) => t.meta.title === 'C')!.meta.project && events.at(-1)?.t === 'toast');
tabs.get(id('C'))!.state.meta.busy = false;
tabs.moveToProject(id('D'), null);
check('take out: D is a plain chat again', !tabs.list().find((t) => t.meta.title === 'D')!.meta.project);
tabs.moveToProject(id('D'), 'gone1');
check('move: an unknown project is refused', !tabs.list().find((t) => t.meta.title === 'D')!.meta.project && events.at(-1)?.t === 'toast');

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
