// Projects: a lead chat starts, steers and reads thread chats; a thread reports back (server/tab.ts project tools).
// + CHAT and PROJECTS: a chat the user adds to a project, closed chats kept and reopened (server/projects.ts, Tabs).
// Fake tabs only: no Claude process starts, nothing is written to data/ (the project book uses a temp folder).
//   npx tsx tests/projects.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEAD_PREFIX, REPORT_PREFIX, type ServerEvent, type TabState } from '../shared/protocol.ts';
import { joinRef, ProjectBook } from '../server/projects.ts';
import { chatStatus, projectHelp, Tab } from '../server/tab.ts';
import { Tabs } from '../server/tabs.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};

type ToolDef = { name: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }> };
const tools = (t: Tab) => (t as unknown as { projectTools(): ToolDef[] }).projectTools();
const run = async (t: Tab, name: string, args: Record<string, unknown> = {}) => (await tools(t).find((x) => x.name === name)!.handler(args, {})).content[0].text;

const sent = new Map<string, string[]>();
const fake = (t: Tab) => {
  t.send = (text: string) => void sent.set(t.id, [...(sent.get(t.id) ?? []), text]);
  return t;
};
const project = { id: 'p1', name: 'YT: Claude video' };
const lead = fake(new Tab(() => {}, { cwd: '/tmp', title: 'YT: Claude video', project: { ...project, main: true } }));
const members: Tab[] = [lead];
Tab.projects = {
  members: (id) => members.filter((t) => t.project?.id === id),
  thread: (l, title, brief) => {
    const t = fake(new Tab(() => {}, { cwd: '/tmp', title, project: { ...project, main: false, parent: l.id } }));
    members.push(t);
    t.send(`${LEAD_PREFIX}${brief}`);
    return t;
  },
};

check('a lead has start, send, read and list; a plain chat has none', tools(lead).map((t) => t.name).join() === 'start_thread,send_to_thread,read_thread,list_threads' && tools(new Tab(() => {}, { cwd: '/tmp' })).length === 0);
check('list: none yet', /No threads yet/.test(await run(lead, 'list_threads')));
const started = await run(lead, 'start_thread', { title: 'Outline', brief: 'Write the outline in 7 beats.' });
const outline = members[1];
check('start_thread: a thread tab starts on the brief, marked as from the lead', /Started thread "Outline"/.test(started) && sent.get(outline.id)?.[0] === `${LEAD_PREFIX}Write the outline in 7 beats.`, started);
check('a thread has only report_to_project', tools(outline).map((t) => t.name).join() === 'report_to_project');
check('send_to_thread by title (any case)', /Sent to "Outline"/.test(await run(lead, 'send_to_thread', { thread: 'outline', message: 'Make it 6 beats.' })) && sent.get(outline.id)?.[1] === `${LEAD_PREFIX}Make it 6 beats.`);
check('send_to_thread: unknown name says so', /No thread "Edit"/.test(await run(lead, 'send_to_thread', { thread: 'Edit', message: 'x' })));
outline.state.items.push({ id: 'r1', kind: 'claude', text: 'Outline done: 6 beats.' });
const read = await run(lead, 'read_thread', { thread: outline.id });
check('read_thread: status and its last reply', /"Outline".*IDLE/.test(read) && /Outline done: 6 beats\./.test(read), read);
check('report_to_project: the lead gets it, marked as a report', /Sent to the lead/.test(await run(outline, 'report_to_project', { summary: 'Outline done.' })) && sent.get(lead.id)?.[0] === `${REPORT_PREFIX}"Outline": Outline done.`, JSON.stringify(sent.get(lead.id)));
members.splice(0, 1);
check('report with the lead closed: says to tell the user', /lead chat is closed/.test(await run(outline, 'report_to_project', { summary: 'x' })));

const st = (patch: Partial<TabState['meta']>, extra: Partial<TabState> = {}) => ({ ...lead.state, meta: { ...lead.state.meta, ...patch }, items: [], agents: [], ...extra }) as TabState;
check('status words', chatStatus(st({ attention: true })) === 'NEEDS YOU' && chatStatus(st({ busy: true })) === 'WORKING' && chatStatus(st({})) === 'NOT STARTED' && chatStatus(st({}, { items: [{ id: 'x', kind: 'claude', text: 'hi' }] })) === 'IDLE');

// ---- + CHAT: a chat the user adds joins like a thread, marked as their own.
check('joinRef: + CHAT with the lead open is a thread of it, marked own', JSON.stringify(joinRef('p1', 'P', { id: 'L' }, { main: false, own: true })) === JSON.stringify({ id: 'p1', name: 'P', main: false, parent: 'L', own: true }));
check('joinRef: a lead coming back while another lead is open joins as a thread', joinRef('p1', 'P', { id: 'L' }, { main: true }).main === false);
check('joinRef: a lead coming back with none open is the lead again', joinRef('p1', 'P', undefined, { main: true }).main === true);
const lead2 = fake(new Tab(() => {}, { cwd: '/tmp', title: 'YT: Claude video', project: { ...project, main: true } }));
members.unshift(lead2);
const mine = fake(new Tab(() => {}, { cwd: '/tmp', title: 'My notes', project: joinRef(project.id, project.name, lead2, { main: false, own: true }) }));
members.push(mine);
check('an own chat has report_to_project only', tools(mine).map((t) => t.name).join() === 'report_to_project');
check('the lead lists and can steer an own chat', /"My notes"/.test(await run(lead2, 'list_threads')) && /Sent to "My notes"/.test(await run(lead2, 'send_to_thread', { thread: 'my notes', message: 'hi' })));
const help = projectHelp(mine.project!);
check('an own chat is told the user opened it and reports only when asked', /opened by the user/.test(help) && /only when the user asks/.test(help) && !/started by the project's lead/.test(help), help);
check('a lead-made thread keeps its old text', /started by the project's lead chat/.test(projectHelp({ ...project, main: false })) && /When your job is done/.test(projectHelp({ ...project, main: false })));

// ---- The project book: closed chats kept, taken back, the list.
const root = mkdtempSync(join(tmpdir(), 'phosphor-projects-'));
const book = new ProjectBook(root);
book.create('p1', 'YT: Claude video');
mkdirSync(join(root, 'old1'));
writeFileSync(join(root, 'old1', 'PROJECT.md'), '# Piano app v2\n\nShared memory');
check('read: a new project, and an older one by its PROJECT.md title', book.read('p1')?.name === 'YT: Claude video' && book.read('old1')?.name === 'Piano app v2' && book.read('old1')?.closed.length === 0);
check('read: an id with a path in it is refused', book.read('../p1') === undefined && book.read('p1/..') === undefined);
book.noteClosed({ id: 'p1', name: 'YT: Claude video', main: false, parent: 'L' }, { sessionId: 's-out', title: 'Outline', main: false, createdAt: 2 });
book.noteClosed({ id: 'p1', name: 'YT: Claude video', main: true }, { sessionId: 's-lead', title: 'YT: Claude video', main: true, createdAt: 1 });
book.noteClosed({ id: 'p1', name: 'YT: Claude video', main: false }, { sessionId: 's-out', title: 'Outline 2', main: false, createdAt: 2 });
const kept = book.read('p1')!.closed;
check('noteClosed: kept once per chat, the newest title', kept.length === 2 && kept.find((c) => c.sessionId === 's-out')?.title === 'Outline 2', JSON.stringify(kept));
check('reopenOrder: the lead first', ProjectBook.reopenOrder(kept).map((c) => c.sessionId).join() === 's-lead,s-out');
const openTab = (id: string, p: string, sessionId?: string, createdAt = 5): TabState => ({ meta: { id, title: id, busy: false, attention: false, createdAt, sessionId, project: { id: p, name: 'Made now', main: true } }, info: { cwd: '/tmp', model: '', permissionMode: '', effort: '' }, items: [], mission: null, agents: [], stats: {} as TabState['stats'], activity: '' });
const listed = book.list([openTab('t9', 'new9', 'sx')], (sid) => (sid === 's-out' ? Date.now() + 1000 : sid === 'sx' ? 50 : undefined));
check('list: every project, the newest activity first; one only the tabs know too', listed.map((p) => p.id).join() === 'p1,old1,new9', JSON.stringify(listed.map((p) => [p.id, p.lastActive])));
check('list: closed chats and names', listed[0].closed.length === 2 && listed.find((p) => p.id === 'new9')?.name === 'Made now' && listed.find((p) => p.id === 'new9')?.lastActive === 50);
const taken = book.take('s-out');
check('take: the chat leaves the closed list, with its project', taken?.id === 'p1' && taken.chat.title === 'Outline 2' && book.read('p1')!.closed.length === 1 && book.take('s-out') === undefined);

// ---- Tabs: + CHAT, close keeps a project chat, PROJECTS and HISTORY reopen it into the project.
// No Claude, no SDK reads, no tabs.json: those parts are stubbed.
const proto = Tab.prototype as unknown as Record<string, unknown>;
proto.loadHistory = async () => {};
proto.prefillInfo = async () => {};
proto.syncSessionTitle = async () => {};
proto.close = () => {};
const events: ServerEvent[] = [];
const tabs = new Tabs((ev) => events.push(ev));
const T = tabs as unknown as { save(): void; saveSoon(): void; book: ProjectBook };
T.save = () => {};
T.saveSoon = () => {};
T.book = new ProjectBook(root);
const opened = () => events.filter((e): e is Extract<ServerEvent, { t: 'tab' }> => e.t === 'tab').map((e) => e.tab);
await tabs.openProject('old1', 'r1');
const newLead = opened().at(-1)!;
check('openProject: an older project with no kept chats gets a new lead on its memory', newLead.meta.project?.id === 'old1' && newLead.meta.project.main && newLead.meta.title === 'Piano app v2' && (events.at(-1) as { req?: string }).req === 'r1');
tabs.createInProject('old1', '  Budget  ', 'r2');
const added = opened().at(-1)!;
check('+ CHAT: joins the project as the user\'s thread of the lead, named', added.meta.title === 'Budget' && added.meta.project?.main === false && added.meta.project.own === true && added.meta.project.parent === newLead.meta.id && (events.at(-1) as { req?: string }).req === 'r2');
tabs.createInProject('old1', undefined);
check('+ CHAT without a name: "Chat N"', opened().at(-1)!.meta.title === 'Chat 3');
const before = events.length;
tabs.createInProject('nope', 'x');
check('+ CHAT for an unknown project does nothing', events.length === before);
tabs.get(added.meta.id)!.state.meta.sessionId = 's-budget';
tabs.get(newLead.meta.id)!.state.meta.sessionId = 's-newlead';
tabs.close(added.meta.id);
tabs.close(newLead.meta.id);
tabs.close(opened().at(-1)!.meta.id); // never used: no session, not kept
check('close: used project chats are kept, an unused one is not', T.book.read('old1')!.closed.map((c) => c.sessionId).sort().join() === 's-budget,s-newlead');
check('the list shows the project closed with both chats', tabs.projectList().projects.find((p) => p.id === 'old1')?.closed.length === 2);
await tabs.openProject('old1', 'r3');
const back = opened().slice(-2);
const reqOf = (id: string) => (events.find((e) => e.t === 'tab' && e.tab.meta.id === id) as { req?: string }).req;
check('openProject: the lead comes back first, as the lead, with the request', back[0].meta.project?.main === true && back[0].meta.title === 'Piano app v2' && reqOf(back[0].meta.id) === 'r3', JSON.stringify(back.map((t) => t.meta)));
check('openProject: the own chat comes back as a thread of the new lead, still own', back[1].meta.title === 'Budget' && back[1].meta.project?.parent === back[0].meta.id && back[1].meta.project?.own === true && reqOf(back[1].meta.id) === undefined);
check('openProject: nothing left closed', T.book.read('old1')!.closed.length === 0);
tabs.get(back[1].meta.id)!.state.meta.sessionId = 's-budget';
tabs.close(back[1].meta.id);
await tabs.open('s-budget', '/tmp', 'Budget', 'r4');
check('HISTORY reopening a closed project chat puts it back in its project', opened().at(-1)!.meta.project?.id === 'old1' && opened().at(-1)!.meta.project?.parent === back[0].meta.id);
await tabs.open('s-plain', '/tmp', 'Plain', 'r5');
check('HISTORY reopening any other chat: a plain chat', !opened().at(-1)!.meta.project);
check('project.json is plain JSON with the name', JSON.parse(readFileSync(join(root, 'old1', 'project.json'), 'utf8')).name === 'Piano app v2');
rmSync(root, { recursive: true, force: true });

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
