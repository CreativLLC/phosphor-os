// LAB FOLLOW UP, versions and RUN AGAIN, with no model started: POST /api/lab/tests/<id>/results/<dir>/followup and
// .../again, GET .../versions, the version viewer (/lab/v/<key>/<test>/<result>@<n>/), the follow-up prompt and the
// copies (server/labfollow.ts). A fake model list and a fake queue stand in for the runner (server/lab.ts `runner`), in
// a throwaway lab folder; a run's end is faked by writing its result.json, reply and files by hand.
// npx tsx tests/lab-followup.ts
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LabModel, LabResult, LabTestFull, LabVersion } from '../shared/lab.ts';
import type { Job } from '../server/labrun.ts';

const dir = mkdtempSync(join(tmpdir(), 'lab-followup-'));
process.env.PHOSPHOR_LAB_DIR = dir;
const { handleLab, runner, serveLabFile } = await import('../server/lab.ts');
const { copyPlain, copyTree, followUpPrompt, labBuildDir } = await import('../server/labfollow.ts');
const { startable } = await import('../server/labrun.ts');

let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};

// ------------------------------------------------------------ the follow-up prompt

const TASK = 'Make a snake game in one HTML file.\nArrow keys steer.';
const up = (text: string) => ({ text, at: 1, version: 1 });
const done = { state: 'done' as const, timeUp: false, error: '', followUps: [] };
const p1 = followUpPrompt(TASK, done, 'Made index.html with a snake game.', 'Slow it down.');
check(p1.startsWith('This is a follow-up') && /still in this folder/.test(p1) && /do not start over/.test(p1), 'prompt: it says the earlier work is in this folder and to change it, not start over');
check(p1.includes(`<original_task>\n${TASK}\n</original_task>`), 'prompt: the original task, word for word');
check(p1.includes('<your_last_reply>\nMade index.html with a snake game.\n</your_last_reply>'), 'prompt: its last reply');
check(p1.endsWith('<follow_up>\nSlow it down.\n</follow_up>'), 'prompt: the follow-up comes last');
check(!p1.includes('<earlier_follow_ups>'), 'prompt: no earlier follow-ups on the first one');
const long = followUpPrompt(TASK, done, 'x'.repeat(5000), 'Go on.');
check(long.includes(`${'x'.repeat(1500)}…`) && !long.includes('x'.repeat(1501)), 'prompt: only the start of a long reply (1500 characters)');
const p2 = followUpPrompt(TASK, { ...done, followUps: [up('Slow it down.'), up(`Add a pause key.${'y'.repeat(2000)}`)] }, 'Paused.', 'Add a high score.');
check(/<earlier_follow_ups>\nYou already did these; keep their changes\.\n1\. Slow it down\.\n2\. Add a pause key\.y+…\n<\/earlier_follow_ups>/.test(p2) && !p2.includes('y'.repeat(1001)), 'prompt: earlier follow-ups, numbered, each cut to 1000 characters');
check(p2.indexOf('<original_task>') < p2.indexOf('<earlier_follow_ups>') && p2.indexOf('<earlier_follow_ups>') < p2.indexOf('<your_last_reply>') && p2.indexOf('<your_last_reply>') < p2.indexOf('<follow_up>'), 'prompt: in the order things happened');
check(followUpPrompt(TASK, { ...done, timeUp: true }, '', 'Finish it.').includes('(none)\n\nThe time limit stopped your last run before it finished.'), 'prompt: a run the time limit stopped');
check(followUpPrompt(TASK, { ...done, state: 'failed', error: 'The app stopped with code 1.' }, '', 'Again.').includes('Your last run failed: The app stopped with code 1.'), 'prompt: a failed run, with its error');
check(followUpPrompt(TASK, { ...done, state: 'limit' }, 'Half done.', 'Go on.').includes('Half done.\n\nYour last run stopped at a usage limit'), 'prompt: a run that hit the plan limit');

// ------------------------------------------------------------ copies

const tree = (root: string) => {
  for (const [p, text] of Object.entries({ 'index.html': '<p>hi</p>', 'node_modules/pkg/index.js': 'x', 'app/node_modules/dep.js': 'y', 'app/main.js': 'z', '.cache/c': 'c', 'build/out.txt': 'kept' })) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  symlinkSync('../../outside.txt', join(root, 'app', 'link'));
};
const plain = join(dir, 'copy-src');
tree(plain);
await copyPlain(plain, join(dir, 'copy-plain'));
const cp1 = join(dir, 'copy-plain');
check(readFileSync(join(cp1, 'index.html'), 'utf8') === '<p>hi</p>' && existsSync(join(cp1, 'app', 'main.js')) && existsSync(join(cp1, 'build', 'out.txt')), 'plain copy: the files are there (a folder named build is not junk)');
check(!existsSync(join(cp1, 'node_modules')) && !existsSync(join(cp1, 'app', 'node_modules')) && !existsSync(join(cp1, '.cache')), 'plain copy: junk folders are left out, nested ones too');
check(lstatSync(join(cp1, 'app', 'link')).isSymbolicLink() && readlinkSync(join(cp1, 'app', 'link')) === '../../outside.txt', 'plain copy: a link stays a link to the same place, never followed');
// copyTree on the disk the lab lives on (data/ in the repo): with reflinks it keeps everything, without them the junk goes.
const disk = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', '.lab-followup-test-'));
try {
  tree(join(disk, 'src'));
  writeFileSync(join(disk, 'probe'), 'p');
  let reflinks = true;
  try {
    execFileSync('cp', ['--reflink=always', join(disk, 'probe'), join(disk, 'probe2')], { stdio: 'ignore' });
  } catch {
    reflinks = false;
  }
  await copyTree(join(disk, 'src'), join(disk, 'dest'));
  const ok = readFileSync(join(disk, 'dest', 'app', 'main.js'), 'utf8') === 'z' && existsSync(join(disk, 'dest', 'node_modules', 'pkg', 'index.js')) === reflinks && lstatSync(join(disk, 'dest', 'app', 'link')).isSymbolicLink();
  check(ok, `copyTree on the lab's disk: ${reflinks ? 'reflinks, so node_modules is kept at no cost' : 'no reflinks here, so node_modules is left out'}`);
} finally {
  rmSync(disk, { recursive: true, force: true });
}

// ------------------------------------------------------------ fakes in place of the runner

const model = (app: LabModel['app'], id: string, name: string): LabModel => ({ id: `${app}:${id}`, name, app, appName: app, account: 'Test', efforts: ['low', 'high'] });
const FAKE = [model('opencode', 'vendor/alpha', 'Alpha'), model('codex', 'beta', 'Beta'), model('local', 'gamma', 'Gamma'), model('opencode', 'vendor/delta', 'Delta')];
const queued: Job[] = [];
runner.models = async () => ({ models: FAKE, notes: [] });
runner.queue = (job) => void queued.push(job);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/lab/v/')) return serveLabFile(res, url);
  void handleLab(req, res, url);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const api = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(`${host}/api/lab/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const get = async (id: string) => (await api(`tests/${id}`)).data as LabTestFull;

const PROMPT = 'Make a retro snake game in one HTML file.';
const made = await api('tests', 'POST', { prompt: PROMPT, models: FAKE.map((m) => m.id), timeLimitMin: 10, blind: true, effort: 'high', title: 'Snake' });
const id = made.data.id as string;
let t = await get(id);
const [A, B, C, D] = t.results.map((r) => r.dir);
const rd = (d: string) => join(t.folder, d);
const res = (d: string) => JSON.parse(readFileSync(join(rd(d), 'result.json'), 'utf8')) as LabResult & { schema: number };
const setRes = (d: string, over: Partial<LabResult>) => writeFileSync(join(rd(d), 'result.json'), JSON.stringify({ ...res(d), ...over }));
const write = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
};
// What a run leaves behind.
const finish = (d: string, over: Partial<LabResult>, reply: string, files: Record<string, string> = {}) => {
  setRes(d, { state: 'done', startedAt: 1000, endedAt: 61_000, tokens: 1234, effort: 'high', ...over });
  writeFileSync(join(rd(d), 'reply.md'), reply);
  writeFileSync(join(rd(d), 'log.jsonl'), '{"type":"result"}\n');
  write(join(rd(d), 'files'), files);
};
check(t.results.every((r) => Array.isArray(r.followUps) && r.followUps.length === 0) && res(A).followUps?.length === 0, 'a new result has no follow-ups (result.json and the API)');

finish(A, {}, 'Made index.html with a snake game.', { 'index.html': '<h1>v1</h1>', 'node_modules/pkg/index.js': 'x' });
writeFileSync(join(rd(A), 'stderr.txt'), 'a warning');
finish(B, {}, 'Built it with Vite.', { 'package.json': '{"scripts":{"build":"vite build"}}', 'index.html': '<script type="module" src="/src/main.tsx"></script>', 'src/main.tsx': 'x', 'dist/index.html': '<h1>built</h1>' });
writeFileSync(join(rd(B), 'build.json'), JSON.stringify({ state: 'done', at: 1, ms: 5 }));
finish(C, { state: 'failed', error: 'The app stopped with code 1.' }, '');
finish(D, {}, 'Done.', { 'index.html': '<h1>d</h1>' });
await api(`tests/${id}/results/${A}`, 'PATCH', { stars: 4, note: 'too fast' });
await api(`tests/${id}/results/${B}`, 'PATCH', { stars: 3 });
await api(`tests/${id}`, 'PATCH', { ranking: [A, B, D] });
queued.length = 0;
const testJson = readFileSync(join(t.folder, 'test.json'), 'utf8');

// ------------------------------------------------------------ refused

const refuse = async (what: string, path: string, body: unknown, want: RegExp) => {
  const before = readdirSync(t.folder).map((d) => (existsSync(join(t.folder, d, 'result.json')) ? readFileSync(join(t.folder, d, 'result.json'), 'utf8') : '')).join();
  const r = await api(path, 'POST', body);
  const after = readdirSync(t.folder).map((d) => (existsSync(join(t.folder, d, 'result.json')) ? readFileSync(join(t.folder, d, 'result.json'), 'utf8') : '')).join();
  check(r.status === 400 && want.test(r.data.error) && queued.length === 0 && before === after, `refused: ${what} (${r.data.error})`);
};
setRes(D, { state: 'running' });
await refuse('a follow-up while it runs', `tests/${id}/results/${D}/followup`, { text: 'More.' }, /still running/);
await refuse('RUN AGAIN while it runs', `tests/${id}/results/${D}/again`, {}, /still running/);
setRes(D, { state: 'queued' });
await refuse('a follow-up while it waits in the queue', `tests/${id}/results/${D}/followup`, { text: 'More.' }, /still running/);
setRes(D, { state: 'done' });
await refuse('an empty follow-up', `tests/${id}/results/${A}/followup`, { text: '  \n ' }, /Write what/);
await refuse('a follow-up that is not text', `tests/${id}/results/${A}/followup`, { text: 42 }, /Write what/);
await refuse('a follow-up over 20,000 characters', `tests/${id}/results/${A}/followup`, { text: 'z'.repeat(20_001) }, /20,000 characters at most/);
await refuse('a result that is not in the test', `tests/${id}/results/nope--opencode/followup`, { text: 'Hi.' }, /No such result/);
await refuse('a bad folder name', `tests/${id}/results/..%2F..%2Fx/followup`, { text: 'Hi.' }, /No such result/);
check(![A, B, C, D].some((d) => existsSync(join(rd(d), 'versions'))), 'refused: no version was kept');
check((await api(`tests/2026-01-01-gone/results/${A}/followup`, 'POST', { text: 'Hi.' })).status === 404, 'a test that is not there: 404');

// ------------------------------------------------------------ the first follow-up

const r1 = await api(`tests/${id}/results/${A}/followup`, 'POST', { text: 'Slow the snake down and add P to pause.' });
check(r1.status === 200 && r1.data.version === 1, 'follow-up sent: version 1 kept');
const v1 = join(rd(A), 'versions', '1');
check(readFileSync(join(v1, 'files', 'index.html'), 'utf8') === '<h1>v1</h1>' && readFileSync(join(rd(A), 'files', 'index.html'), 'utf8') === '<h1>v1</h1>', 'version 1 has a copy of the files, and the files stay for the model to work on');
writeFileSync(join(rd(A), 'files', 'index.html'), '<h1>v2</h1>');
check(readFileSync(join(v1, 'files', 'index.html'), 'utf8') === '<h1>v1</h1>', '  a real copy: changing the file does not change the version');
check(readFileSync(join(v1, 'reply.md'), 'utf8') === 'Made index.html with a snake game.' && existsSync(join(v1, 'log.jsonl')) && readFileSync(join(v1, 'stderr.txt'), 'utf8') === 'a warning', 'version 1 holds the reply, the log and the errors');
check(!['reply.md', 'log.jsonl', 'stderr.txt'].some((n) => existsSync(join(rd(A), n))), '  and they left the result folder (the follow-up writes new ones)');
const kept = JSON.parse(readFileSync(join(v1, 'result.json'), 'utf8'));
check(kept.stars === 4 && kept.rank === 1 && kept.note === 'too fast' && kept.state === 'done' && kept.schema === 1, "version 1's result.json is the one it had (stars, rank, note, schema)");
const a1 = res(A);
check(a1.state === 'queued' && a1.stars === 0 && a1.rank === 0 && a1.startedAt === 0 && a1.tokens === 0 && a1.effort === '', 'the result waits in the queue, its stars and rank cleared');
check(a1.note === 'too fast', '  the note is kept');
check(a1.followUps.length === 1 && a1.followUps[0].text === 'Slow the snake down and add P to pause.' && a1.followUps[0].version === 1 && a1.followUps[0].at > 0, '  result.json lists the follow-up and the version it came after');
check(res(B).rank === 1 && res(D).rank === 2 && res(C).rank === 0, 'the ranking closes up: #2 and #3 move to #1 and #2');
check(res(B).stars === 3, '  the other results keep their stars');
check(readFileSync(join(t.folder, 'test.json'), 'utf8') === testJson, 'test.json is not touched: the test stays blind, not revealed');
check(queued.length === 1, 'one run queued');
const j1 = queued[0];
check(j1.testDir === t.folder && j1.dir === A, '  for the same result, in the same folder');
check(j1.timeLimitMin === 10 && j1.effort === 'high', "  with the test's time limit and effort");
check(j1.prompt.includes(PROMPT) && j1.prompt.includes('Made index.html with a snake game.') && j1.prompt.endsWith('<follow_up>\nSlow the snake down and add P to pause.\n</follow_up>'), '  with the follow-up prompt (task, last reply, the new words last)');
check(!/Alpha|alpha|opencode/.test(j1.prompt), '  which names no model or app (blind tests stay blind)');
check(readFileSync(join(rd(A), 'prompt.md'), 'utf8') === `${j1.prompt}\n` && (await api(`tests/${id}/results/${A}/log`)).data.prompt === `${j1.prompt}\n`, '  the exact prompt is kept in prompt.md, and LOG shows it');
t = await get(id);
check(t.blind && !t.revealed && t.results[0].followUps.length === 1 && t.results[0].state === 'queued', 'GET: still blind; the result shows its follow-up and waits');
check(t.results[0].files.some((f) => f.path === 'index.html'), '  its files are still listed');
queued.length = 0;
await refuse('a second follow-up while the first waits', `tests/${id}/results/${A}/followup`, { text: 'And more.' }, /still running/);

// ------------------------------------------------------------ queue order

queued.length = 0;
await api(`tests/${id}/results/${C}/followup`, 'POST', { text: 'Try again, and keep it small.' });
await api(`tests/${id}/results/${D}/followup`, 'POST', { text: 'Make it blue.' });
check(queued.map((j) => j.dir).join() === `${C},${D}`, 'queue: follow-ups join the queue in the order they were sent');
check(queued[0].prompt.includes('(none)\n\nYour last run failed: The app stopped with code 1.'), "  a failed run's follow-up says how it ended");
check(JSON.stringify(startable(['opencode', 'local'], { running: 1, localBusy: false, building: 0 })) === '[true,false]', "  a local model's follow-up still waits until no cloud run is left (it runs alone)");
check(res(B).rank === 1 && res(D).rank === 0, '  the ranking closed up again');

// ------------------------------------------------------------ the second follow-up, versions

finish(A, { tokens: 900 }, 'Slowed it down; P pauses.');
await api(`tests/${id}/results/${A}`, 'PATCH', { stars: 5 });
queued.length = 0;
const r2 = await api(`tests/${id}/results/${A}/followup`, 'POST', { text: 'Add a high score.' });
check(r2.status === 200 && r2.data.version === 2, 'second follow-up: version 2 kept');
check(queued[0].prompt.includes('<earlier_follow_ups>\nYou already did these; keep their changes.\n1. Slow the snake down and add P to pause.\n</earlier_follow_ups>') && queued[0].prompt.includes('Slowed it down; P pauses.'), '  its prompt has the first follow-up and the newest reply');
check(res(A).followUps.map((u) => u.version).join() === '1,2', '  result.json: two follow-ups, after versions 1 and 2');
check(readFileSync(join(rd(A), 'versions', '2', 'prompt.md'), 'utf8').includes('Slow the snake down') && readFileSync(join(rd(A), 'prompt.md'), 'utf8').includes('Add a high score.'), "  the first follow-up's prompt moved into version 2, the new one is in prompt.md");
const vs = (await api(`tests/${id}/results/${A}/versions`)).data.versions as LabVersion[];
check(vs.map((v) => v.n).join() === '1,2', 'GET versions: both, oldest first');
check(vs[0].reply === 'Made index.html with a snake game.' && vs[0].stars === 4 && vs[0].followUps.length === 0 && vs[0].page === 'index.html', '  version 1: the first reply, its 4 stars, its page');
check(vs[1].reply === 'Slowed it down; P pauses.' && vs[1].stars === 5 && vs[1].followUps.length === 1 && vs[1].tokens === 900, '  version 2: after follow-up 1, its 5 stars and tokens');
check((await api(`tests/${id}/results/${B}/versions`)).data.versions.length === 0, '  a result with none: an empty list');

// ------------------------------------------------------------ the viewer shows a version

const view = `${host}${t.view}`;
const page = async (path: string) => {
  const r = await fetch(view + path);
  return { status: r.status, text: await r.text(), csp: r.headers.get('content-security-policy') ?? '' };
};
const pv1 = await page(`${A}@1/index.html`);
check(pv1.status === 200 && pv1.text.includes('<h1>v1</h1>') && pv1.csp.startsWith('sandbox'), 'viewer: <result>@1 shows version 1, sandboxed');
check((await page(`${A}/index.html`)).text.includes('<h1>v2</h1>'), 'viewer: <result> still shows the files now');
write(join(v1, 'files'), { 'root.html': '<html><head></head><body><script src="/main.js"></script></body></html>' });
check((await page(`${A}@1/root.html`)).text.includes(`src="${t.view}${A}@1/main.js"`), "viewer: a root path in a version's page points into that version");
for (const [what, path] of [['a version that is not there', `${A}@9/index.html`], ['version 0', `${A}@0/index.html`], ['not a number', `${A}@x/index.html`], ['a path out of the version', `${A}@1/%2e%2e/%2e%2e/result.json`], ['out to the result folder', `${A}@1/%2e%2e/reply.md`]] as const)
  check((await page(path)).status === 404, `viewer: 404 for ${what}`);
symlinkSync('/etc/hostname', join(v1, 'files', 'leak'));
check((await page(`${A}@1/leak`)).status === 404, 'viewer: 404 for a link in a version that points out of it');
check((await fetch(`${host}/lab/v/wrong-key-wrong-key-wrong/${id}/${A}@1/index.html`)).status === 404, 'viewer: 404 with a wrong key');

// ------------------------------------------------------------ the lab's own page build goes before a follow-up

check(labBuildDir(rd(B)) === 'dist' && labBuildDir(rd(D)) === '', 'the page build the lab made is found (dist/), and only where build.json says it built');
const rb = await api(`tests/${id}/results/${B}/followup`, 'POST', { text: 'Make the title bigger.' });
check(rb.status === 200 && existsSync(join(rd(B), 'versions', '1', 'files', 'dist', 'index.html')) && existsSync(join(rd(B), 'versions', '1', 'build.json')), "a built project: the version keeps the build and build.json");
check(!existsSync(join(rd(B), 'files', 'dist')) && existsSync(join(rd(B), 'files', 'src', 'main.tsx')) && !existsSync(join(rd(B), 'build.json')), '  the old build leaves files/ (the source stays), so the old page cannot show');
finish(B, {}, 'Bigger title.');
const b2 = (await get(id)).results[1];
check(b2.page === '' && b2.canBuild && b2.build === '', '  after the run the page must be built again (the lab builds it as after a first run)');

// ------------------------------------------------------------ RUN AGAIN on a DONE result

finish(A, {}, 'Added a high score.');
await api(`tests/${id}/results/${A}`, 'PATCH', { stars: 2, note: 'meh' });
queued.length = 0;
const ra = await api(`tests/${id}/results/${A}/again`, 'POST', { timeLimitMin: 60 });
check(ra.status === 200 && ra.data.version === 3, 'RUN AGAIN on a done result: version 3 kept');
check(readFileSync(join(rd(A), 'versions', '3', 'files', 'index.html'), 'utf8') === '<h1>v2</h1>' && readFileSync(join(rd(A), 'versions', '3', 'reply.md'), 'utf8') === 'Added a high score.', '  it holds the files and reply it had');
check(existsSync(join(rd(A), 'files')) && readdirSync(join(rd(A), 'files')).length === 0, '  the run starts in an empty files folder');
check(!existsSync(join(rd(A), 'prompt.md')) && (await api(`tests/${id}/results/${A}/log`)).data.prompt === '', "  with no follow-up prompt left (it gets the test's own prompt)");
const a3 = res(A);
check(a3.state === 'queued' && a3.stars === 0 && a3.rank === 0 && a3.note === '' && a3.followUps.length === 0, '  stars, rank, note and follow-ups cleared: a fresh run');
check(queued.length === 1 && queued[0].prompt === PROMPT && queued[0].timeLimitMin === 60 && queued[0].effort === 'high' && queued[0].dir === A, '  queued with the plain prompt, the asked time limit and the effort');
check(((await api(`tests/${id}/results/${A}/versions`)).data.versions as LabVersion[]).map((v) => `${v.n}:${v.followUps.length}`).join() === '1:0,2:1,3:2', '  versions 1 to 3 are all kept, each with the follow-ups it had');
check(readFileSync(join(t.folder, 'test.json'), 'utf8') === testJson, 'test.json is still not touched (blind, not revealed)');

// ------------------------------------------------------------ at once, junk, old files, archive

finish(A, {}, 'Fresh.', { 'index.html': '<h1>fresh</h1>' });
queued.length = 0;
const twice = await Promise.all([api(`tests/${id}/results/${A}/followup`, 'POST', { text: 'One.' }), api(`tests/${id}/results/${A}/followup`, 'POST', { text: 'Two.' })]);
check(twice.map((r) => r.status).sort().join() === '200,400' && queued.length === 1 && res(A).followUps.length === 1, 'two follow-ups at once: one runs, the other is refused');
mkdirSync(join(rd(A), 'versions', '1', 'files', 'node_modules', 'pkg'), { recursive: true });
check((await api(`tests/${id}/junk`, 'POST')).data.removed >= 1 && !existsSync(join(rd(A), 'versions', '1', 'files', 'node_modules')), "REMOVE JUNK clears versions' node_modules too");
const { followUps: _, ...old } = res(D);
writeFileSync(join(rd(D), 'result.json'), JSON.stringify(old));
check((await get(id)).results[3].followUps.length === 0, 'a result.json from before follow-ups reads as none');
finish(D, {}, 'Blue.');
await api(`tests/${id}/archive`, 'POST');
const arch = await api(`tests/${id}/results/${D}/followup`, 'POST', { text: 'Green now.' });
check(arch.status === 200 && (await get(id)).archived && existsSync(join(dir, 'archive', id.slice(0, 4), id, D, 'versions', '2')), 'an archived test takes a follow-up and stays in the archive');

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
