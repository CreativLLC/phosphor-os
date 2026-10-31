// Gemini chats (server/geminitab.ts): agy's stream-json events from recorded real runs (tests/fixtures/gemini; paths
// replaced by placeholders; signin.jsonl is made from agy's own message text, stop.jsonl is cut to the lines that
// matter), the mode and thinking-level mapping, the conversation saved and continued after a restart, STOP, errors,
// and the rule that a chat stays with Claude or with Gemini. A fake agy (fixtures/gemini/fake-agy.mjs) plays the
// recordings: nothing real runs, every file goes to a temp folder.
//   npx tsx tests/geminichat.ts

import { spawnSync } from 'node:child_process';
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
const { agyArgs, chatText, deniedNote, fitEffort, GeminiChat, geminiGuards, geminiModels, GUARDS_SCRIPT, parseAgyModels, savedGeminiChats } = await import('../server/geminitab.ts');
const { Tab } = await import('../server/tab.ts');
GeminiChat.bin = fake;
GeminiChat.brain = join(tmp, 'brain');
GeminiChat.dir = join(tmp, 'chats');
GeminiChat.hooks = join(tmp, 'agy-hooks.json'); // none yet: no command guards (the guards section below adds them)
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude'); // made-up Claude Code hooks, never the owner's

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
  const modes = (guarded: boolean) => ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions', ''].map((m) => agyArgs(m, guarded).join(' ')).join('|');
  check("modes without the guards: ASK FIRST agy's default, PLAN ONLY plan, AUTO-EDIT, AUTO and BYPASS accept-edits (no commands)", modes(false) === '|--mode plan|--mode accept-edits|--mode accept-edits|--mode accept-edits|', modes(false));
  check("modes with the guards: AUTO adds agy's sandbox where commands run without asking, BYPASS skips every permission; the rest the same", modes(true) === '|--mode plan|--mode accept-edits|--mode accept-edits --sandbox --settings {"toolPermission":"proceed-in-sandbox"}|--dangerously-skip-permissions|', modes(true));
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
  check('AUTO runs as accept-edits; a refused command is not followed by advice to allow it in agy', flag(lastArgs(), '--mode') === 'accept-edits' && !notes(denied).some((n) => /allow rule|\/permissions/.test(n)), JSON.stringify(notes(denied)));
  check('no empty reply', replies(denied).length === 0);

  // Without bubblewrap, ASK FIRST and PLAN ONLY stop at the first file write (agy's default and plan modes both write).
  GeminiChat.bwrap = '';
  const asked = newTab();
  await play(asked, 'followup', 'Create a file named moon.txt.');
  check('ASK FIRST, no bubblewrap: a file written anyway stops the run there, and the chat names the file', notes(asked).length === 1 && notes(asked)[0].startsWith(`Gemini changed ${join(cwd, 'moon.txt')}, which ASK FIRST does not allow`) && !asked.state.meta.busy && asked.state.stats.filesChanged.length === 1, JSON.stringify(notes(asked)));
  const goAhead = newTab({ mode: 'plan' });
  await play(goAhead, 'followup', 'The plan is approved. Go ahead.');
  check('PLAN ONLY, no bubblewrap: the same tripwire (plan mode writes once told to go ahead)', notes(goAhead).length === 1 && notes(goAhead)[0].startsWith(`Gemini changed ${join(cwd, 'moon.txt')}, which PLAN ONLY does not allow`), JSON.stringify(notes(goAhead)));
  GeminiChat.bwrap = 'bwrap';

  const quota = newTab();
  await play(quota, 'quota', '/quota');
  check("an agy slash command: sent as typed (no ASK FIRST note in front), its table as a code block", lastArgs()[1] === '/quota' && replies(quota).length === 1 && replies(quota)[0].text.startsWith('```\nGemini Models\tWeekly Limit Remaining') && notes(quota).length === 0, JSON.stringify(replies(quota)));

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

// ---- ASK FIRST and PLAN ONLY see the chat's folder read-only (bubblewrap); the same run in AUTO-EDIT writes
if (spawnSync('bwrap', ['--dev-bind', '/', '/', 'true']).status !== 0) console.log('SKIP: bubblewrap does not work here (read-only runs)');
else {
  const written = async (mode: string) => {
    const dir = mkdtempSync(join(tmp, 'ro-'));
    const t = newTab({ cwd: dir, mode });
    await play(t, 'readonly', 'Create a file named a.txt containing hi.');
    return { t, file: existsSync(join(dir, 'a.txt')) };
  };
  for (const mode of ['default', 'plan']) {
    const { t, file } = await written(mode);
    check(`${mode === 'plan' ? 'PLAN ONLY' : 'ASK FIRST'}: the write fails in the read-only folder; a failed Write line, no changed file, the reply`, !file && tools(t)[0]?.name === 'Write' && tools(t)[0].error === true && t.state.stats.filesChanged.length === 0 && notes(t).length === 0 && /read-only/.test(replies(t)[0]?.text ?? ''), JSON.stringify({ file, notes: notes(t), tools: tools(t) }));
  }
  check('AUTO-EDIT: the same run writes the file', (await written('acceptEdits')).file);
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
  const back = new Tab(() => {}, { cwd, model: 'gemini:gemini-3.8-flash', gemini: st.geminiId });
  await back.loadHistory();
  check('notes from a run are saved with the chat', notes(back).join('|') === 'Stopped before it was sent.|Stopped.', JSON.stringify(notes(back)));

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
  check('BYPASS without the guards: AUTO, with a note saying why and how to set them up', tab.mode === 'auto' && tab.state.info.permissionMode === 'auto' && /^BYPASS is not offered for this Gemini chat: the command guards are not set up for Gemini: run `node scripts\/agy-guards.mjs install`/.test(notes(tab).at(-1) ?? ''), notes(tab).at(-1));
  check('no "/" list, no MCP screen for a Gemini chat', (await tab.commands()).length === 0 && (await tab.mcpServers().then(() => false, () => true)));
  await tab.undo(tab.state.items[0].id, true);
  const u = events.findLast((e) => e.t === 'undo_result');
  check('UNDO: refused in a Gemini chat', u?.t === 'undo_result' && !u.ok && /only in chats with Claude/.test(u.error ?? ''));
  tab.close();
  const saved = JSON.parse(readFileSync(join(tmp, 'chats', `${conv}.json`), 'utf8'));
  check('closing saves the chat with its name', saved.title === tab.state.meta.title && saved.model === 'gemini:gemini-4-argon');
  const listed = savedGeminiChats().find((c) => c.conversation === conv);
  check('HISTORY lists saved Gemini chats; its search sees your words and the replies', !!listed && chatText(listed).includes('Write 3 short sentences about the moon.') && chatText(listed).includes("only natural satellite"));
  const odd = new Tab(() => {}, { cwd, gemini: `../../${conv}` }); // HISTORY's open request names the chat
  check('a conversation id that is not one is not used (a file name and an agy flag)', odd.geminiId === undefined && odd.state.info.agent === 'gemini');
  const reopened = new Tab(() => {}, { cwd, gemini: conv });
  await reopened.loadHistory();
  check('reopened from HISTORY: a Gemini chat on the model it last ran on', reopened.state.info.agent === 'gemini' && reopened.model === 'gemini:gemini-4-argon' && reopened.state.info.model === 'gemini:gemini-4-argon');
}

// ---- the command guards (scripts/agy-guards.mjs): checked at the start of every AUTO or BYPASS run
{
  const claude = join(tmp, 'claude');
  mkdirSync(claude, { recursive: true });
  const guard = join(tmp, 'guard.mjs');
  writeFileSync(guard, "let r = ''; process.stdin.on('data', (c) => (r += c)); process.stdin.on('end', () => { if (/deploy/.test(JSON.parse(r).tool_input?.command ?? '')) { console.error('BLOCKED'); process.exit(2); } });\n");
  const settings = (groups: unknown[]) => writeFileSync(join(claude, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: groups } }));
  settings([{ matcher: 'Bash', hooks: [{ type: 'command', command: `node '${guard}'` }] }]);
  const entry = (script: string, more: Record<string, unknown> = {}) => writeFileSync(GeminiChat.hooks, JSON.stringify({ other: { PreToolUse: [] }, 'phosphor-guards': { ...more, PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `'${process.execPath}' '${script}' hook` }] }] } }));
  check('guards: no agy hooks file = not set up, with the step to set them up', /not set up for Gemini: run `node scripts\/agy-guards.mjs install`/.test(await geminiGuards(cwd)));
  entry(join(tmp, 'elsewhere', 'agy-guards.mjs'));
  check('guards: an entry for another copy of Phosphor-OS is not taken', /point at another copy/.test(await geminiGuards(cwd)));
  entry(GUARDS_SCRIPT, { enabled: false });
  check('guards: switched off in agy ("enabled": false) is not taken', /switched off/.test(await geminiGuards(cwd)));
  entry(GUARDS_SCRIPT);
  check('guards: in place = the entry runs and answers a test call', (await geminiGuards(cwd)) === '');
  settings([{ matcher: 'Read', hooks: [{ type: 'command', command: `node '${guard}'` }] }]);
  check('guards: no Claude Code hook for commands = nothing to guard with', /no PreToolUse hooks for commands/.test(await geminiGuards(cwd)));
  settings([{ matcher: 'Bash', hooks: [{ type: 'command', command: `node '${join(tmp, 'gone.mjs')}'` }] }]);
  check('guards: a hook that cannot run fails the test call', /failed a test call/.test(await geminiGuards(cwd)));
  settings([{ matcher: 'Bash', hooks: [{ type: 'command', command: `node '${guard}'` }] }]);

  const auto = newTab({ mode: 'auto' });
  await play(auto, 'chat', 'Hello.');
  const a = lastArgs();
  check("AUTO with the guards: accept-edits in agy's sandbox, commands run there without asking", flag(a, '--mode') === 'accept-edits' && a.includes('--sandbox') && flag(a, '--settings') === '{"toolPermission":"proceed-in-sandbox"}' && !a.includes('--dangerously-skip-permissions'), JSON.stringify(a));
  await auto.setMode('bypassPermissions');
  check('BYPASS with the guards: offered, no note', auto.mode === 'bypassPermissions' && auto.state.info.permissionMode === 'bypassPermissions' && notes(auto).length === 0, JSON.stringify(notes(auto)));
  await play(auto, 'chat', 'Again.');
  const b = lastArgs();
  check('BYPASS runs with --dangerously-skip-permissions (no mode, no sandbox)', b.includes('--dangerously-skip-permissions') && !b.includes('--mode') && !b.includes('--sandbox'), JSON.stringify(b));
  writeFileSync(GeminiChat.hooks, '{}'); // removed between two messages: no restart needed either way
  await play(auto, 'chat', 'Once more.');
  check('guards gone before a BYPASS run: it runs as AUTO-EDIT (no commands)', flag(lastArgs(), '--mode') === 'accept-edits' && !lastArgs().includes('--dangerously-skip-permissions') && !lastArgs().includes('--sandbox'), JSON.stringify(lastArgs()));
  const edit = newTab({ mode: 'acceptEdits' });
  await play(edit, 'chat', 'Hi.');
  check('AUTO-EDIT never runs commands, guards or not', flag(lastArgs(), '--mode') === 'accept-edits' && !lastArgs().includes('--sandbox'));

  const cmd = [{ action: 'command', display_name: 'RunCommand' }];
  check('note, guards missing: says why Gemini runs no commands', /^Gemini wanted to run a command, which AUTO does not allow, so it stopped there\. AUTO-EDIT lets it change files in this folder\. Gemini runs no commands yet: the command guards/.test(deniedNote(cmd, 'auto', 'the command guards are not set up for Gemini.')));
  check("note, AUTO with the guards: commands only in agy's sandbox, BYPASS outside it", /AUTO runs commands only inside agy's sandbox.*BYPASS runs them outside it/.test(deniedNote([{ action: 'unsandboxed' }], 'auto', '')));
  check('note, AUTO-EDIT with the guards: names AUTO and BYPASS', /which AUTO-EDIT does not allow.*AUTO also runs commands in agy's sandbox, BYPASS runs anything/.test(deniedNote(cmd, 'acceptEdits', '')));
}

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
