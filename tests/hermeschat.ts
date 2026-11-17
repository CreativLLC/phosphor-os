// Hermes chats (server/hermestab.ts) and their guards (scripts/hermes-guards.mjs). A fake `hermes acp`
// (fixtures/hermes/fake-hermes.mjs) answers with the update shapes a real Hermes sent; made-up Claude Code hooks and a
// temp Hermes home stand in for the owner's. Nothing real runs, every file goes to a temp folder.
//   npx tsx tests/hermeschat.ts

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, ServerEvent } from '../shared/protocol.ts';

const tmp = mkdtempSync(join(tmpdir(), 'phosphor-hermes-test-'));
const fake = join(import.meta.dirname, 'fixtures', 'hermes', 'fake-hermes.mjs');
chmodSync(fake, 0o755);
process.env.HERMES_HOME = join(tmp, 'hermes-home'); // the guards install here, never in ~/.hermes
process.env.CLAUDE_CONFIG_DIR = join(tmp, 'claude'); // made-up Claude Code hooks, never the owner's
process.env.PHOSPHOR_HERMES_MODES = join(tmp, 'modes.json');
process.env.FAKE_HERMES_LOG = join(tmp, 'acp.log');
process.env.PHOSPHOR_LOCAL_URL = 'http://127.0.0.1:1';
process.env.PHOSPHOR_LOCAL_MODELS = 'gemma4-26b=Gemma 4 26B (local),qwen3.8=Qwen 3.8';
process.env.PHOSPHOR_LOCAL_MORE_MODELS = 'strata=Strata';
process.env.PHOSPHOR_LOCAL_URLS = 'strata=http://127.0.0.1:2';
const { HermesChat, hermesGuards, hermesModels, toolLine } = await import('../server/hermestab.ts');
const { Tab } = await import('../server/tab.ts');
const guards = await import('../scripts/hermes-guards.mjs' as string);
HermesChat.bin = fake;
HermesChat.dir = join(tmp, 'chats');
HermesChat.modes = join(tmp, 'modes.json');

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
type T = InstanceType<typeof Tab>;
const cwd = join(tmp, 'cwd');
mkdirSync(cwd);
mkdirSync(process.env.HERMES_HOME!);
mkdirSync(process.env.CLAUDE_CONFIG_DIR!);
// A Claude Code hook that blocks any command naming "prodorg" (exit 2), like the owner's prod-write block.
writeFileSync(join(tmp, 'block.sh'), '#!/bin/sh\ngrep -q prodorg && { echo "blocked: prodorg" >&2; exit 2; }\nexit 0\n');
chmodSync(join(tmp, 'block.sh'), 0o755);
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: join(tmp, 'block.sh') }] }] } }));

const events: ServerEvent[] = [];
const newTab = (init: Record<string, unknown> = {}) => new Tab((e) => events.push(e), { cwd, model: 'hermes:gemma4-26b', mode: 'default', ...init });
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 1000 && !cond(); i++) await tick(10);
};
const notes = (t: T) => t.state.items.filter((i) => i.kind === 'note').map((i) => (i.kind === 'note' ? i.text : ''));
const of = <K extends Item['kind']>(t: T, kind: K) => t.state.items.filter((i): i is Extract<Item, { kind: K }> => i.kind === kind);
const sent = () => (existsSync(process.env.FAKE_HERMES_LOG!) ? readFileSync(process.env.FAKE_HERMES_LOG!, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const answered = () => sent().filter((m) => m.id === 'p1' && m.result).map((m) => m.result.outcome.optionId);

// ---- the guard script
{
  const d = (tool_name: string, tool_input: Record<string, unknown>, session_id = 's') => guards.decide({ tool_name, tool_input, session_id, cwd });
  check('guards: a command a Claude Code hook blocks is blocked', (await d('terminal', { command: 'sf deploy prodorg' })).decision === 'block');
  check('guards: code is checked as a command', (await d('execute_code', { code: 'run("prodorg")' })).decision === 'block');
  check('guards: a browser step is checked with all its text', (await d('browser_exec', { code: 'new_tab("prodorg")' })).decision === 'block');
  check('guards: an ordinary command passes', JSON.stringify(await d('terminal', { command: 'echo hi' })) === '{}');
  check("guards: Hermes's own settings are off limits", (await d('write_file', { path: '/home/x/.hermes/config.yaml', content: '' })).decision === 'block');
  check('guards: so is the guard script', (await d('terminal', { command: 'rm scripts/hermes-guards.mjs' })).decision === 'block');
  writeFileSync(process.env.PHOSPHOR_HERMES_MODES!, JSON.stringify({ planned: 'plan', asking: 'default' }));
  check('guards: PLAN ONLY blocks a tool that changes something', (await d('terminal', { command: 'echo hi' }, 'planned')).decision === 'block');
  check('guards: PLAN ONLY lets reading through', JSON.stringify(await d('read_file', { path: '/tmp/a' }, 'planned')) === '{}');
  check('guards: ASK FIRST sends a change to the OK gate', (await d('write_file', { path: '/tmp/a', content: 'x' }, 'asking')).action === 'approve');
  check('guards: ASK FIRST does not ask about a web search', JSON.stringify(await d('web_search', { query: 'x' }, 'asking')) === '{}');
}

// ---- models, tool lines
{
  const list = hermesModels();
  check("models: the router's models as Hermes entries, Strata (its own server) left out", list.map((m) => m.value).join() === 'hermes:gemma4-26b,hermes:qwen3.8', list.map((m) => m.value).join());
  check('models: named for the picker', list[0].label === 'Hermes · Gemma 4 26B', list[0].label);
  const t = toolLine('terminal: echo   hi');
  check('tool line: name and detail from the title', t.name === 'Run' && t.detail === 'echo hi' && t.tool === 'terminal');
}

// ---- no guards: no Hermes
const tab = newTab();
{
  check('a hermes: model makes a Hermes chat', tab.state.info.agent === 'hermes');
  check('guards: missing at first', (await hermesGuards()) !== '');
  tab.send('hello', []);
  await until(() => !tab.state.meta.busy);
  check('without the guards the message is not sent', notes(tab).some((n) => n.startsWith('Hermes did not start')) && !existsSync(process.env.FAKE_HERMES_LOG!), notes(tab).join(' | '));
}

// ---- with the guards: a turn in ASK FIRST
writeFileSync(join(process.env.HERMES_HOME!, 'config.yaml'), 'model:\n  default: x\n');
const { execFileSync } = await import('node:child_process');
execFileSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'hermes-guards.mjs'), 'install']);
{
  check('guards: installed into the Hermes home', (await hermesGuards()) === '' && readFileSync(join(process.env.HERMES_HOME!, 'config.yaml'), 'utf8').includes('fail_closed: true'));
  tab.send('do it', []);
  await until(() => of(tab, 'perm').some((p) => p.status === 'pending'));
  const perm = of(tab, 'perm').find((p) => p.status === 'pending');
  check('ASK FIRST: the OK request shows as a card', !!perm && perm.title.includes('terminal: echo hi') && perm.detail === 'echo hi', JSON.stringify(perm));
  check('the chat waits for the owner', tab.state.meta.attention === true);
  tab.answerPermission(perm!.id, true);
  await until(() => !tab.state.meta.busy);
  const m = sent();
  check('a new session in the chat folder', m.some((x) => x.method === 'session/new' && x.params.cwd === cwd));
  check('ASK FIRST: Hermes asks before edits', m.some((x) => x.method === 'session/set_config_option' && x.params.value === 'ask'));
  check('the picked model is set', m.some((x) => x.method === 'session/set_model' && x.params.modelId === 'custom:gemma4-26b'));
  check('the OK went back to Hermes', answered().join() === 'allow_once', answered().join());
  check('tool lines with their results', of(tab, 'tool').map((t) => `${t.name}:${t.detail}:${t.body ?? ''}`).join('|') === 'Run:echo hi:hi|Write:/tmp/x.txt:', of(tab, 'tool').map((t) => `${t.name}:${t.detail}:${t.body}`).join('|'));
  const reply = of(tab, 'claude')[0];
  check('the reply streams in, named for the model', reply?.text === 'Hello there' && reply.who === 'Hermes · Gemma 4 26B', JSON.stringify(reply));
  check('a written file counts as changed', tab.state.stats.filesChanged.includes('/tmp/x.txt'));
  check('the mode is there for the guards', JSON.parse(readFileSync(HermesChat.modes, 'utf8'))['local-new-session-0002'] === 'default');
  check('the chat is saved', existsSync(join(HermesChat.dir, 'local-new-session-0002.json')));
  check('the tab knows its session', tab.sideKey === 'hermes:local-new-session-0002');
}

// ---- BYPASS answers by itself; a denied OK
{
  await tab.setMode('bypassPermissions');
  tab.send('again', []);
  await until(() => !tab.state.meta.busy);
  check('BYPASS: the OK is answered without a card', answered().join() === 'allow_once,allow_once' && of(tab, 'perm').length === 1, answered().join());
  check('BYPASS: edits do not ask', sent().filter((x) => x.method === 'session/set_config_option').pop()?.params.value === 'session');
  check('one process for the chat (no second session)', sent().filter((x) => x.method === 'session/new').length === 1);
  await tab.setMode('default');
  tab.send('third', []);
  await until(() => of(tab, 'perm').some((p) => p.status === 'pending'));
  tab.answerPermission(of(tab, 'perm').find((p) => p.status === 'pending')!.id, false);
  await until(() => !tab.state.meta.busy);
  check('a denied OK goes back as a refusal', answered().pop() === 'deny');
}

// ---- STOP, switching, restart
{
  tab.send('WAIT here', []);
  await until(() => sent().some((x) => x.method === 'session/prompt' && x.params.prompt[0].text.includes('WAIT')));
  await tab.stop();
  await until(() => !tab.state.meta.busy);
  check('STOP cancels the turn', sent().some((x) => x.method === 'session/cancel') && notes(tab).at(-1) === 'Stopped.', notes(tab).at(-1));
  await tab.setModel('opus');
  check('a started Hermes chat stays with Hermes', tab.state.info.agent === 'hermes' && notes(tab).at(-1)!.includes('Claude cannot continue it'), notes(tab).at(-1));
  tab.close();
  check('closing ends the mode entry', JSON.parse(readFileSync(HermesChat.modes, 'utf8'))['local-new-session-0002'] === undefined);

  rmSync(process.env.FAKE_HERMES_LOG!);
  const back = newTab({ hermes: 'local-new-session-0002' });
  await back.loadHistory();
  check('reopened: the saved chat comes back', of(back, 'claude').length >= 1 && of(back, 'user').length === 5, `${of(back, 'user').length}`);
  back.send('after restart', []);
  await until(() => of(back, 'perm').some((p) => p.status === 'pending'));
  back.answerPermission(of(back, 'perm').find((p) => p.status === 'pending')!.id, true);
  await until(() => !back.state.meta.busy);
  check('a session Hermes lost: a new one, and the chat says so', sent().some((x) => x.method === 'session/load') && notes(back).some((n) => n.includes('could not find the earlier conversation')), notes(back).join(' | '));
  back.close();

  rmSync(process.env.FAKE_HERMES_LOG!);
  const known = newTab({ hermes: 'local-saved-session-0001', mode: 'bypassPermissions' });
  known.send('continue', []);
  await until(() => !known.state.meta.busy);
  check('a session Hermes has: continued, no new one', sent().some((x) => x.method === 'session/load') && !sent().some((x) => x.method === 'session/new') && known.hermesId === 'local-saved-session-0001');
  check('the replayed history is not shown again', !known.state.items.some((i) => JSON.stringify(i).includes('replayed')) && !notes(known).some((n) => n.includes('could not find')));
  known.close();

  const fresh = newTab();
  await fresh.setModel('opus');
  check('a Hermes tab with nothing sent switches to Claude', fresh.state.info.agent === undefined);
  fresh.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exit(fail ? 1 : 0);
