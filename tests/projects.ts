// Projects: a lead chat starts, steers and reads thread chats; a thread reports back (server/tab.ts project tools).
// Fake tabs only: no Claude process starts, nothing is written to data/.
//   npx tsx tests/projects.ts

import { LEAD_PREFIX, REPORT_PREFIX, type TabState } from '../shared/protocol.ts';
import { chatStatus, Tab } from '../server/tab.ts';

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

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
