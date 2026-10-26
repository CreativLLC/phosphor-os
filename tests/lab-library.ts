// LAB prompt library and + MODELS, with no model started: the distinct-prompt list (shared/lab.ts promptLibrary and
// GET /api/lab/prompts) and POST /api/lab/tests/<id>/models (duplicates refused, blind letters, test.json kept intact).
// A fake model list and a fake queue stand in for the runner (server/lab.ts `runner`), in a throwaway lab folder.
// npx tsx tests/lab-library.ts
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAB_LETTERS, LAB_MAX_MODELS, promptLibrary, type LabModel, type LabPrompt, type LabTestFull } from '../shared/lab.ts';
import type { Job } from '../server/labrun.ts';

const dir = mkdtempSync(join(tmpdir(), 'lab-library-'));
process.env.PHOSPHOR_LAB_DIR = dir;
const { handleLab, runner } = await import('../server/lab.ts');

let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};

// ------------------------------------------------------------ the pure list

const T = (title: string, prompt: string, at: number) => ({ title, prompt, at });
const lib = promptLibrary([T('old snake', 'Make a snake game.', 100), T('cat', 'Draw a pixel cat.', 300), T('new snake', '  Make a snake game.\n', 200), T('blank', '   ', 400), T('snake 2', 'Make a snake game!', 50)]);
check(lib.length === 3, 'one entry per distinct text (a trim does not make a new one, a "!" does, a blank one is skipped)');
check(lib.map((p) => p.prompt).join('|') === 'Draw a pixel cat.|Make a snake game.|Make a snake game!', 'newest first');
check(lib[1].tests === 2 && lib[1].title === 'new snake' && lib[1].at === 200, 'the count, and the title and date of the newest test using it');
check(promptLibrary([]).length === 0, 'no tests, no prompts');

// ------------------------------------------------------------ fakes in place of the runner

const model = (id: string, name: string): LabModel => ({ id: `opencode:${id}`, name, app: 'opencode', appName: 'opencode', account: 'Test', efforts: [] });
const FAKE = Array.from({ length: LAB_MAX_MODELS + 2 }, (_, i) => model(`vendor/model-${i + 1}`, `Model ${i + 1}`));
const TWIN_A = model('openrouter/lookalike', 'Lookalike A'); // these two would share the folder name "lookalike--opencode"
const TWIN_B = model('vendor/lookalike', 'Lookalike B');
FAKE.push(TWIN_A, TWIN_B);
const queued: Job[] = [];
runner.models = async () => ({ models: FAKE, notes: [] });
runner.queue = (job) => void queued.push(job);

const server = createServer((req, res) => void handleLab(req, res, new URL(req.url ?? '/', 'http://x'))).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/lab/`;
const api = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const ids = (...n: number[]) => n.map((i) => FAKE[i - 1].id);
const make = async (prompt: string, models: string[], extra: object = {}) => {
  const r = await api('tests', 'POST', { prompt, models, timeLimitMin: 30, blind: false, effort: 'default', ...extra });
  if (r.status !== 200) throw new Error(`could not make a test: ${JSON.stringify(r.data)}`);
  return r.data.id as string;
};
const test = async (id: string) => (await api(`tests/${id}`)).data as LabTestFull;
const file = (t: LabTestFull) => join(t.folder, 'test.json');
const stored = (t: LabTestFull) => JSON.parse(readFileSync(file(t), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const setAt = (t: LabTestFull, at: number) => writeFileSync(file(t), JSON.stringify({ ...stored(t), at }));

check((await api('prompts')).data.prompts.length === 0, 'GET /prompts: an empty lab has none');

// ------------------------------------------------------------ the library from the folders (HISTORY and ARCHIVE)

const P1 = 'Make a snake game in one HTML file.';
const P2 = 'Draw a bouncing ball.\nUse a canvas.';
const a = await test(await make(P1, ids(1), { title: 'Snake, first try' }));
check(a.results[0].dir === 'model-1--opencode' && stored(a).schema === 1 && stored(a).key.length === 24, 'a new test is made as before (folder name, schema, key)');
const b = await test(await make(P2, ids(1, 2)));
const c = await test(await make(P1, ids(2), { title: 'Snake, second try' }));
setAt(a, Date.UTC(2026, 9, 1));
setAt(b, Date.UTC(2026, 9, 10));
setAt(c, Date.UTC(2026, 9, 20));
writeFileSync(file(a), JSON.stringify({ ...stored(a), prompt: `${P1}  \n` })); // typed by hand with a trailing blank
check((await api(`tests/${c.id}/archive`, 'POST')).status === 200, 'one test archived');
const prompts: LabPrompt[] = (await api('prompts')).data.prompts;
check(prompts.length === 2, 'GET /prompts: one entry per distinct text');
check(prompts[0].prompt === P1 && prompts[0].tests === 2, 'the archived test counts, a trailing blank does not split the text');
check(prompts[0].title === 'Snake, second try' && prompts[0].at === Date.UTC(2026, 9, 20), 'the title and date are the newest test\'s');
check(prompts[1].prompt === P2 && prompts[1].tests === 1 && prompts[1].title === b.title, 'the other prompt follows, with its line break kept');
check((await api('prompts', 'POST', {})).status === 404, 'POST /prompts is not a route');

// ------------------------------------------------------------ + MODELS

const blind = await test(await make('Write a haiku about rain.', ids(3, 4, 5), { title: 'Rain haiku', blind: true, timeLimitMin: 10, effort: 'high' }));
queued.length = 0;
const future = { ...stored(blind), futureField: { keep: 'me' } }; // a field a newer lab wrote: it must survive
writeFileSync(file(blind), JSON.stringify(future));
check((await api(`tests/${blind.id}/results/${blind.results[1].dir}`, 'PATCH', { stars: 4, note: 'good' })).status === 200, 'a result rated before');
const oldFiles = blind.results.map((r) => readFileSync(join(blind.folder, r.dir, 'result.json'), 'utf8'));
const before = stored(blind);

const add = await api(`tests/${blind.id}/models`, 'POST', { models: ids(6, 7) });
check(add.status === 200 && add.data.added.length === 2, 'POST /models: two models added');
const after = await test(blind.id);
check(after.results.length === 5, 'the test has 5 results');
check(after.results.slice(0, 3).map((r) => r.model).join() === ids(3, 4, 5).join(), 'the old results keep their places');
check(after.results.slice(3).map((r) => r.model).join() === ids(6, 7).join(), 'the new ones come last, in the order picked');
check(after.results.slice(3).every((r) => r.state === 'queued' && !r.startedAt && r.modelName.startsWith('Model ')), 'the new results wait in the queue');
check(after.blind && !after.revealed, 'the test is still blind (not revealed)');
check([3, 4].map((i) => LAB_LETTERS[i]).join('') === 'DE' && LAB_LETTERS.length >= LAB_MAX_MODELS, 'blind mode names them MODEL D and MODEL E (and never runs out of letters)');
const now = stored(blind);
check(JSON.stringify({ ...now, results: 0 }) === JSON.stringify({ ...before, results: 0 }), 'test.json: every other field is the same (key, prompt, limit, effort, blind, schema)');
check(now.futureField?.keep === 'me', 'test.json: a field this lab does not know is kept');
check(JSON.stringify(now.results.slice(0, 3)) === JSON.stringify(before.results) && now.results.length === 5, 'test.json: the old entries are the same, two more follow');
check(readdirSync(blind.folder).every((n) => !n.endsWith('.tmp')), 'test.json: no half-written file is left');
check(blind.results.every((r, i) => readFileSync(join(blind.folder, r.dir, 'result.json'), 'utf8') === oldFiles[i]), 'the old result.json files are not touched (stars, notes)');
check(after.results.slice(3).every((r) => existsSync(join(blind.folder, r.dir, 'files')) && existsSync(join(blind.folder, r.dir, 'result.json'))), 'each new result has its folder, files/ and result.json');
check(queued.length === 2 && queued.every((j, i) => j.testDir === blind.folder && j.dir === after.results[3 + i].dir), 'two runs queued, in the test\'s folder');
check(queued.every((j) => j.prompt === 'Write a haiku about rain.' && j.timeLimitMin === 10 && j.effort === 'high'), 'with the same prompt, and the test\'s own time limit and effort');

// refused
const snap = readFileSync(file(blind), 'utf8');
const refuse = async (what: string, models: unknown, want: RegExp, id = blind.id) => {
  queued.length = 0;
  const r = await api(`tests/${id}/models`, 'POST', { models });
  check(r.status === 400 && want.test(r.data.error), `refused: ${what} (${r.data.error})`);
  check(queued.length === 0 && (id !== blind.id || readFileSync(file(blind), 'utf8') === snap), '  nothing queued, test.json as it was');
};
await refuse('a model that is in the test', ids(6), /Already in this test: Model 6/);
await refuse('one new model with one that is in the test', ids(8, 3), /Already in this test: Model 3/);
await refuse('a model the lab does not have', ['opencode:vendor/gone'], /not available/);
await refuse('nothing picked', [], /at least one/);
await refuse('not a list', 'opencode:vendor/model-9', /at least one/);
check((await test(blind.id)).results.length === 5, 'the refused ones added nothing');
check((await api('tests/2026-10-01-no-such-test/models', 'POST', { models: ids(9) })).status === 404, 'a test that is not there: 404');

// the most a test holds
const full = await test(await make('Say hi.', Array.from({ length: LAB_MAX_MODELS - 1 }, (_, i) => FAKE[i].id)));
check((await api(`tests/${full.id}/models`, 'POST', { models: ids(LAB_MAX_MODELS, LAB_MAX_MODELS + 1) })).status === 400, `${LAB_MAX_MODELS} models at most: one over is refused`);
check((await api(`tests/${full.id}/models`, 'POST', { models: ids(LAB_MAX_MODELS) })).status === 200 && (await test(full.id)).results.length === LAB_MAX_MODELS, `${LAB_MAX_MODELS} is allowed`);

// folder names: two models that would share one get -2
const twin = await test(await make('Say hi.', [TWIN_B.id]));
await api(`tests/${twin.id}/models`, 'POST', { models: [TWIN_A.id] });
const twin2 = await test(twin.id);
check(twin2.results.map((r) => r.dir).join() === 'lookalike--opencode,lookalike--opencode-2', 'a second model with the same folder name gets -2, nothing is overwritten');
check(twin2.results.every((r) => existsSync(join(twin2.folder, r.dir, 'result.json'))), '  both result folders exist');

// the queue and other requests write at the same time
const race = await test(await make('Say hi.', ids(1)));
queued.length = 0;
const both = await Promise.all([api(`tests/${race.id}/models`, 'POST', { models: ids(2) }), api(`tests/${race.id}/models`, 'POST', { models: ids(3) }), api(`tests/${race.id}`, 'PATCH', { title: 'Renamed', blind: true })]);
const raced = await test(race.id);
check(both.every((r) => r.status === 200) && raced.results.length === 3, 'two adds and a rename at once: no lost update (3 results)');
check(raced.title === 'Renamed' && raced.blind, '  the rename is kept too');
const dup = await Promise.all([api(`tests/${race.id}/models`, 'POST', { models: ids(4) }), api(`tests/${race.id}/models`, 'POST', { models: ids(4) })]);
check(dup.map((r) => r.status).sort().join() === '200,400' && (await test(race.id)).results.length === 4, 'the same model asked twice at once: added once, the other refused');
check(queued.length === 3, '  one run queued for each model added');

// an archived test takes more models and stays in the archive
await api(`tests/${race.id}/archive`, 'POST');
check((await api(`tests/${race.id}/models`, 'POST', { models: ids(5) })).status === 200, 'an archived test takes more models');
const arch = await test(race.id);
check(arch.archived && arch.results.length === 5 && arch.folder.includes('archive'), '  and stays in the archive');

// a library prompt starts a new test (the NEW TEST flow), which counts in the library
const again = await make(P1, ids(7));
const lib2: LabPrompt[] = (await api('prompts')).data.prompts;
check(lib2.find((p) => p.prompt === P1)?.tests === 3 && lib2[0].prompt === P1, 'a new test with a library prompt: its count goes up and it moves to the top');
check((await test(again)).results.length === 1, '  and it is its own test, not a change to the old ones');

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
