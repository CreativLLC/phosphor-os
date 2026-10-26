// Gemini chats (server/geminitab.ts): agy's stream-json events from recorded real runs (tests/fixtures/gemini; paths
// replaced by placeholders; signin.jsonl is made from agy's own message text, stop.jsonl is cut to the lines that
// matter), the mode and thinking-level mapping, the conversation saved and continued after a restart, STOP, errors,
// and the rule that a chat stays with Claude or with Gemini. A fake agy (fixtures/gemini/fake-agy.mjs) plays the
// recordings: nothing real runs, every file goes to a temp folder.
//   npx tsx tests/geminichat.ts

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, ServerEvent } from '../shared/protocol.ts';

const tmp = mkdtempSync(join(tmpdir(), 'phosphor-gemini-test-'));
const fixtures = join(import.meta.dirname, 'fixtures', 'gemini');
const fake = join(fixtures, 'fake-agy.mjs');
process.env.PHOSPHOR_IMAGE_DIR = join(tmp, 'images'); // read when the server modules load
process.env.FAKE_AGY_BRAIN = join(tmp, 'brain');
process.env.FAKE_AGY_LOG = join(tmp, 'argv.log');
const { agyMode, fitEffort, GeminiChat, geminiModels, NO_BYPASS, parseAgyModels } = await import('../server/geminitab.ts');
const { Tab } = await import('../server/tab.ts');
GeminiChat.bin = fake;
GeminiChat.brain = join(tmp, 'brain');
GeminiChat.dir = join(tmp, 'chats');

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
type T = InstanceType<typeof Tab>;

const cwd = join(tmp, 'cwd');
mkdirSync(cwd);
const events: ServerEvent[] = [];
const newTab = (init: Record<string, unknown> = {}) => new Tab((e) => events.push(e), { cwd, model: 'gemini:gemini-3.8-flash', ...init });
const idle = async (t: T) => {
  for (let i = 0; i < 500 && t.state.meta.busy; i++) await tick(10);
};
const play = async (t: T, run: string, text: string) => {
  process.env.FAKE_AGY_RUN = run;
  t.send(text, []);
  await idle(t);
};
const lastArgs = (): string[] => JSON.parse(readFileSync(join(tmp, 'argv.log'), 'utf8').trim().split('\n').pop()!).args;
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const notes = (t: T) => t.state.items.filter((i) => i.kind === 'note').map((i) => (i.kind === 'note' ? i.text : ''));
const tools = (t: T) => t.state.items.filter((i): i is Extract<Item, { kind: 'tool' }> => i.kind === 'tool');
const replies = (t: T) => t.state.items.filter((i): i is Extract<Item, { kind: 'claude' }> => i.kind === 'claude');

// ---- models, modes, thinking levels
{
  const list = parseAgyModels(readFileSync(join(fixtures, 'models.txt'), 'utf8'));
  check('models: one entry per Gemini model; agy\'s Claude and GPT models left out', list.map((m) => m.value).join() === 'gemini:gemini-4-argon,gemini:gemini-3.8-flash', list.map((m) => m.value).join());
  check('models: names without the level, levels low to high', list[0].label === 'Gemini 4 Argon' && list[1].label === 'Gemini 3.8 Flash' && list[0].efforts.join() === 'low,medium,high');
  check('models: asked from agy itself', (await geminiModels()).length === 2);
  check("modes: ASK FIRST agy's default, PLAN ONLY plan, AUTO-EDIT accept-edits, AUTO and BYPASS auto", ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions', ''].map(agyMode).join() === ',plan,accept-edits,auto,auto,');
  check('thinking level held to the model\'s own', fitEffort('gemini:gemini-4-argon', 'xhigh') === 'high' && fitEffort('gemini:gemini-4-argon', 'low') === 'low' && fitEffort('gemini:gemini-4-argon', '') === undefined);
}

// ---- a chat: first message, follow-up, restart
const tab = newTab();
const conv = '698555f5-d6e6-48b4-ae34-0ab407023a76';
{
  check('a Gemini model makes a Gemini chat', tab.state.info.agent === 'gemini');
  await play(tab, 'chat', 'Write 3 short sentences about the moon.');
  const r = replies(tab);
  const deltas = events.filter((e) => e.t === 'delta' && e.tab === tab.id).length;
  check('the reply streams in, in pieces', r.length === 1 && deltas >= 5 && r[0].text.startsWith("The Moon is Earth's only natural satellite."), `${deltas} ${JSON.stringify(r[0]?.text)}`);
  check('the reply is named after the model', r[0]?.who === 'Gemini 3.8 Flash');
  check('the title is the first words', tab.state.meta.title === 'Write 3 short sentences about t…', tab.state.meta.title);
  check('agy\'s conversation is the chat\'s', tab.geminiId === conv);
  check('idle after the run, one turn', !tab.state.meta.busy && tab.state.stats.turns === 1);
  const args = lastArgs();
  check("first run: ASK FIRST says read only before the message, agy's default mode, stream-json, the model, no conversation yet", args[0] === '-p' && args[1].startsWith('[Note from the Phosphor-OS app: this chat is in ASK FIRST mode.') && args[1].endsWith(']\n\nWrite 3 short sentences about the moon.') && !args.includes('--mode') && flag(args, '--output-format') === 'stream-json' && flag(args, '--model') === 'gemini-3.8-flash' && !args.includes('--conversation') && !args.includes('--effort'), JSON.stringify(args));
  check('saved as data for a restart', existsSync(join(tmp, 'chats', `${conv}.json`)));

  await tab.setMode('acceptEdits');
  await tab.setEffort('low');
  await play(tab, 'followup', 'Quote the second sentence you wrote before. Then create a file named moon.txt containing that sentence.');
  const f = lastArgs();
  check('follow-up: continues the conversation, AUTO-EDIT as accept-edits, the thinking level', flag(f, '--conversation') === conv && flag(f, '--mode') === 'accept-edits' && flag(f, '--effort') === 'low', JSON.stringify(f));
  const w = tools(tab)[0];
  check('a written file: a Write line with its path, counted as changed', w?.name === 'Write' && w.detail === join(cwd, 'moon.txt') && tab.state.stats.filesChanged.join() === join(cwd, 'moon.txt') && tab.state.stats.toolCalls === 1, JSON.stringify(w));
  check('follow-up reply after the tool line', replies(tab).length === 2 && replies(tab)[1].text.includes('It influences our planet'));
  tab.send('-v please', []);
  await idle(tab);
  check('a message starting with "-" is never read as a flag', lastArgs()[1] === ' -v please');

  const again = new Tab(() => {}, { cwd, model: 'gemini:gemini-3.8-flash', gemini: tab.geminiId, title: tab.state.meta.title });
  await again.loadHistory();
  const kinds = (t: T) => t.state.items.map((i) => i.kind).join();
  check('restart: the chat comes back from its file', kinds(again) === kinds(tab) && again.state.stats.turns === 3 && again.state.stats.filesChanged.length === 1, `${kinds(again)} / ${kinds(tab)}`);
  await play(again, 'chat', 'And the third sentence?');
  check('restart: the next message continues the same conversation', flag(lastArgs(), '--conversation') === conv);
}

// ---- other recorded runs
{
  const lost = newTab({ gemini: '11111111-2222-3333-4444-555555555555', mode: 'acceptEdits' });
  await play(lost, 'edit', 'Read notes.txt, then replace the word banana with cherry in it.');
  check('an edit: Read and Edit lines, the tool\'s own summary as the body', tools(lost).map((t) => t.name).join() === 'Read,Edit' && tools(lost)[0].body === '2 lines, 13 bytes');
  check('a lost conversation: said, and the new one kept', notes(lost).some((n) => /could not find the earlier conversation/.test(n)) && lost.geminiId === 'be1e9896-e35b-4129-ba61-d211e6b3cb26', JSON.stringify(notes(lost)));

  const denied = newTab({ mode: 'auto' });
  await play(denied, 'denied', 'Run the shell command: ls -la . Then tell me how many files are in this folder.');
  await play(denied, 'denied', 'Run it again.');
  check('a refused command: a Run line and a note naming it and the mode', tools(denied)[0]?.name === 'Run' && tools(denied)[0].detail === 'ls -la' && notes(denied).filter((n) => /wanted to run a command, which AUTO does not allow/.test(n)).length === 2, JSON.stringify(notes(denied)));
  check('AUTO not offered for the account: said once', notes(denied).filter((n) => /AUTO is not available/.test(n)).length === 1);
  check('no empty reply', replies(denied).length === 0);

  const asked = newTab();
  await play(asked, 'followup', 'Create a file named moon.txt.');
  check('ASK FIRST: a file written anyway stops the run there, and the chat names the file', notes(asked).length === 1 && notes(asked)[0].startsWith(`Gemini changed ${join(cwd, 'moon.txt')}, which ASK FIRST does not allow`) && !asked.state.meta.busy && asked.state.stats.filesChanged.length === 1, JSON.stringify(notes(asked)));

  const plan = newTab({ mode: 'plan' });
  const planDir = join(tmp, 'brain', '04fbd7cc-376c-40ef-8920-b1807ffc560a');
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(planDir, 'implementation_plan.md'), '# Create plan.txt\n\n1. Write the word hello');
  await play(plan, 'plan', 'Create a file named plan.txt containing the word hello.');
  const p = tools(plan)[0];
  check("PLAN ONLY: plan mode; the plan in agy's own folder shows its text in the line, not as a changed file", flag(lastArgs(), '--mode') === 'plan' && p?.detail === "implementation_plan.md (Gemini's notes)" && p.body?.startsWith('# Create plan.txt') === true && plan.state.stats.filesChanged.length === 0, JSON.stringify(p));
  check('plan mode: one reply, asking to review the plan', replies(plan).length === 1 && /review and approve/.test(replies(plan)[0].text), JSON.stringify(replies(plan)));

  const pic = newTab({ mode: 'acceptEdits' });
  await play(pic, 'picture', 'Make a small picture of a red circle on a white background.');
  const img = pic.state.items.find((i) => i.kind === 'image');
  check('a picture: shown in the chat as a PNG copy', img?.kind === 'image' && img.status === 'done' && img.width === 1 && img.model === 'Gemini 3.8 Flash' && !!img.path && existsSync(img.path), JSON.stringify(img));
  check("the picture helper: an Agent line with its role, its task as the body", tools(pic)[0]?.name === 'Agent' && tools(pic)[0].detail === 'Image Generator' && /red circle/.test(tools(pic)[0].body ?? ''), JSON.stringify(tools(pic)[0]));
}

// ---- STOP and errors
{
  const st = newTab();
  process.env.FAKE_AGY_RUN = 'stop';
  st.send('Write a 300-word story about a lighthouse keeper.', []);
  st.send('A second message.', []);
  await tick(200);
  const runs = readFileSync(join(tmp, 'argv.log'), 'utf8').trim().split('\n').length;
  check('busy while it runs; the second message waits its turn', st.state.meta.busy && tools(st).length === 0);
  await st.stop();
  await idle(st);
  check('STOP: the run ends at once, the waiting message is dropped', !st.state.meta.busy && notes(st).join('|') === 'Stopped before it was sent.|Stopped.', JSON.stringify(notes(st)));
  check('STOP: the waiting message never ran', readFileSync(join(tmp, 'argv.log'), 'utf8').trim().split('\n').length === runs);

  const signin = newTab();
  await play(signin, 'signin', 'hi');
  check('not signed in: says to run agy once in a terminal', notes(signin).some((n) => /run `agy` once in a terminal/.test(n)) && !signin.state.meta.busy, JSON.stringify(notes(signin)));
  const bad = newTab();
  await play(bad, 'badeffort', 'hi');
  check("agy's own error, in one line", notes(bad)[0]?.startsWith('Gemini stopped with an error: invalid model selection') === true, JSON.stringify(notes(bad)));
  GeminiChat.bin = join(tmp, 'no-agy');
  const missing = newTab();
  await play(missing, 'chat', 'hi');
  GeminiChat.bin = fake;
  check('agy not installed: says so', notes(missing).some((n) => /not installed/.test(n)) && !missing.state.meta.busy, JSON.stringify(notes(missing)));
}

// ---- a chat stays with Claude or with Gemini; what only Claude has
{
  const claude = new Tab(() => {}, { cwd });
  claude.state.items.push({ id: 'u1', kind: 'user', text: 'hi' });
  await claude.setModel('gemini:gemini-4-argon');
  check('a Claude chat stays with Claude', !claude.state.info.agent && claude.model === undefined && notes(claude).some((n) => /Gemini cannot continue it/.test(n)));
  const fresh = new Tab(() => {}, { cwd, effort: 'max' });
  await fresh.setModel('gemini:gemini-4-argon');
  check('a tab with nothing sent becomes a Gemini chat, its thinking level held to Gemini\'s', fresh.state.info.agent === 'gemini' && fresh.effort === 'high');
  await fresh.setModel('sonnet');
  check('... and goes back to Claude while nothing was sent', !fresh.state.info.agent && fresh.model === 'sonnet');
  await tab.setModel('opus');
  tab.setAuto(true);
  check('a Gemini chat stays with Gemini (a model or AUTO)', tab.state.info.agent === 'gemini' && tab.model === 'gemini:gemini-3.8-flash' && !tab.autoModel && notes(tab).filter((n) => /Claude cannot continue it/.test(n)).length === 2);
  await tab.setModel('gemini:gemini-4-argon');
  check('another Gemini model in the same chat', tab.model === 'gemini:gemini-4-argon');
  await play(tab, 'chat', 'Hello again.');
  check('... runs on it, same conversation', flag(lastArgs(), '--model') === 'gemini-4-argon' && flag(lastArgs(), '--conversation') === conv);
  await tab.setMode('bypassPermissions');
  check('BYPASS is not offered: AUTO, with a note', tab.mode === 'auto' && tab.state.info.permissionMode === 'auto' && notes(tab).at(-1) === NO_BYPASS);
  check('no "/" list, no MCP screen for a Gemini chat', (await tab.commands()).length === 0 && (await tab.mcpServers().then(() => false, () => true)));
  await tab.undo(tab.state.items[0].id, true);
  const u = events.findLast((e) => e.t === 'undo_result');
  check('UNDO: refused in a Gemini chat', u?.t === 'undo_result' && !u.ok && /only in chats with Claude/.test(u.error ?? ''));
  tab.close();
  const saved = JSON.parse(readFileSync(join(tmp, 'chats', `${conv}.json`), 'utf8'));
  check('closing saves the chat with its name', saved.title === tab.state.meta.title && saved.model === 'gemini:gemini-4-argon');
}

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
