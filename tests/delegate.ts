// ROUTER (server/delegate.ts): ask_local's file reading and folder checks, the job queue, the model pick, the stream
// reader, the ledger, the tool end to end, and the thread worker choice. Fakes only: no model is called, files live in
// a temp folder, nothing is written to data/.
//   npx tsx tests/delegate.ts

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegateCount } from '../shared/protocol.ts';
import { askLocalTool, Busy, CAPS, JobQueue, Ledger, ledger, pickLocal, readJobFiles, runLocal, threadModel, tokensOf, type Deps, type Pick } from '../server/delegate.ts';
import { Tab } from '../server/tab.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
ledger.save = () => {}; // the live ledger (Tab uses it) never writes data/router.json here

const dir = mkdtempSync(join(tmpdir(), 'delegate-test-'));
const root = join(dir, 'chat');
const uploads = join(dir, 'uploads');
const outside = join(dir, 'outside');
for (const d of [root, uploads, outside, join(root, 'sub')]) mkdirSync(d, { recursive: true });
writeFileSync(join(root, 'a.txt'), 'alpha file\n');
writeFileSync(join(root, 'sub', 'c.md'), '# notes\n');
writeFileSync(join(root, 'big.log'), 'x'.repeat(5000));
writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
writeFileSync(join(root, '.env'), 'KEY=secret\n');
writeFileSync(join(root, '.env.example'), 'KEY=\n');
writeFileSync(join(root, 'server.pem'), 'cert\n');
writeFileSync(join(uploads, 'up.txt'), 'uploaded\n');
writeFileSync(join(outside, 'o.txt'), 'outside\n');
symlinkSync(join(outside, 'o.txt'), join(root, 'link-out.txt'));
symlinkSync(join(root, 'a.txt'), join(root, 'link-in.txt'));

// ---------------------------------------------------------------- files
{
  const roots = [root, uploads];
  const read = (paths: string[], room?: number) => readJobFiles(paths, root, roots, room);
  const one = read(['a.txt']);
  check('relative path: read, shown relative', one.files.length === 1 && one.files[0].path === 'a.txt' && one.files[0].text === 'alpha file\n' && !one.files[0].cut, JSON.stringify(one));
  check('absolute path inside, and a second root (uploads)', read([join(root, 'sub', 'c.md'), join(uploads, 'up.txt')]).files.map((f) => f.path).join() === `sub/c.md,${join(uploads, 'up.txt')}`);
  const why = (p: string) => read([p]).problems.join();
  check('outside the folders: refused', /outside this chat's folders/.test(why(join(outside, 'o.txt'))));
  check('.. out of the folder: refused', /outside/.test(why('../outside/o.txt')));
  check('a link that leads outside: refused', /outside/.test(why('link-out.txt')));
  check('a link inside: read, keyed by its real path', read(['link-in.txt']).files[0]?.real === join(root, 'a.txt'));
  check('.env and a key file: refused as secrets', /secret/.test(why('.env')) && /secret/.test(why('server.pem')));
  check('.env.example: read', read(['.env.example']).files.length === 1);
  check('binary: refused', /not a text file/.test(why('bin.dat')));
  check('folder: refused', /not a file/.test(why('sub')));
  check('missing: refused', /not found/.test(why('nope.txt')));
  const cut = read(['big.log', 'a.txt'], 1000);
  check('room: the first file is cut to fit, the next left out', cut.files.length === 1 && cut.files[0].cut && cut.files[0].text.length === 1000 && cut.files[0].size === 5000 && /no room left/.test(cut.problems.join()), JSON.stringify({ ...cut, files: cut.files.map((f) => ({ ...f, text: f.text.length })) }));
  const many = read(Array.from({ length: CAPS.files + 2 }, () => 'a.txt'));
  check(`at most ${CAPS.files} files per job`, many.files.length === CAPS.files && /2 more files/.test(many.problems.join()));
  // A file this user may not read: left out, the others still go (it threw, and the whole job failed).
  writeFileSync(join(root, 'locked.txt'), 'locked\n');
  chmodSync(join(root, 'locked.txt'), 0o000);
  if (process.getuid?.() !== 0) {
    const locked = (() => {
      try {
        return read(['locked.txt', 'a.txt']);
      } catch (e) {
        return String(e);
      }
    })();
    check('an unreadable file: left out, the next one read', typeof locked !== 'string' && locked.files.map((f) => f.path).join() === 'a.txt' && /locked\.txt \(could not be read\)/.test(locked.problems.join()), JSON.stringify(locked));
  }
  chmodSync(join(root, 'locked.txt'), 0o600);
}

// ---------------------------------------------------------------- queue
{
  const q = new JobQueue(2);
  const log: string[] = [];
  const job = (name: string, ms: number) => q.run(async () => {
    log.push(`${name}+`);
    await sleep(ms);
    log.push(`${name}-`);
    return name;
  }, 1000);
  const all = await Promise.all([job('a', 30), job('b', 10), job('c', 10)]);
  check('one at a time, in order', log.join(' ') === 'a+ a- b+ b- c+ c-' && all.join() === 'a,b,c', log.join(' '));

  const slow = q.run(() => sleep(80), 1000);
  const w1 = q.run(async () => 'w1', 1000);
  const w2 = q.run(async () => 'w2', 1000);
  const full = await q.run(async () => 'x', 1000).catch((e) => e);
  check('too many waiting: BUSY at once', full instanceof Busy, String(full));
  await Promise.all([slow, w1, w2]);

  const long = q.run(() => sleep(120), 1000);
  const late = await q.run(async () => 'late', 30).catch((e) => e);
  check('waited too long: BUSY', late instanceof Busy && /took longer/.test(late.message), String(late));
  const stop = new AbortController();
  const stopped = q.run(async () => 'never', 1000, stop.signal).catch((e) => e);
  stop.abort();
  check('STOP while waiting: leaves the queue', ((await stopped) as Error).message === 'stopped');
  await long;
  check('the queue runs again after those', (await q.run(async () => 'ok', 100)) === 'ok' && q.size.waiting === 0 && !q.size.running);
  await q.run(async () => Promise.reject(new Error('boom'))).catch(() => {});
  check('a failed job frees the queue', (await q.run(async () => 'after', 100)) === 'after');
}

// ---------------------------------------------------------------- which model
const ROUTER = 'http://router.test';
const OWN = 'http://own.test';
const setup = {
  url: ROUTER,
  models: [
    { value: 'local', name: 'strata-big', label: 'Big (local Strata)' },
    { value: 'local:qwen', name: 'qwen', label: 'Qwen 35B (local)' },
    { value: 'local:gemma', name: 'gemma', label: 'Gemma 26B (local)' },
  ],
  key: 'k',
  context: 98304,
  urls: { 'strata-big': OWN } as Record<string, string>,
  units: {} as Record<string, string>,
  contexts: {} as Record<string, number>,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// A model server: router rows, the own server's /health, and /v1/messages answered by `answer`.
function server(o: { rows?: Record<string, string>; ownLoaded?: boolean; down?: boolean; answer?: (body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response> }) {
  const calls: string[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${u.origin}${u.pathname}`);
    if (u.origin === OWN && u.pathname === '/health') return json({ loaded: !!o.ownLoaded });
    if (u.pathname === '/v1/models') {
      if (o.down) throw new TypeError('fetch failed');
      return json({ data: Object.entries(o.rows ?? {}).map(([id, value]) => ({ id, status: { value } })) });
    }
    if (u.pathname === '/v1/messages' && o.answer) return o.answer(JSON.parse(String(init?.body)), init);
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
  return { f, calls };
}
const no = async () => false;
{
  const name = async (rows: Record<string, string>) => {
    const p = await pickLocal(setup, server({ rows }).f, no);
    return p.ok ? `${p.name}|${p.value ?? ''}` : `${p.why}: ${p.text}`;
  };
  check('a loaded router model is used', (await name({ qwen: 'unloaded', gemma: 'loaded' })) === 'gemma|local:gemma');
  check('a sleeping one is used (no swap)', (await name({ qwen: 'unloaded', gemma: 'sleeping' })) === 'gemma|local:gemma');
  check('loaded wins over sleeping', (await name({ qwen: 'sleeping', gemma: 'loaded' })) === 'gemma|local:gemma');
  check('none held: the first router model, never the Strata one', (await name({ qwen: 'unloaded', gemma: 'unloaded' })) === 'qwen|local:qwen');
  check('a model held but not in the picker: used, no picker value', (await name({ other: 'loaded' })) === 'other|');
  const p = await pickLocal(setup, server({ rows: {} }).f, no);
  check('label without "(local)", context from the setup', p.ok && p.label === 'Qwen 35B' && p.context === 98304, JSON.stringify(p));
  const strata = await pickLocal(setup, server({ rows: { qwen: 'loaded' }, ownLoaded: true }).f, no);
  check('Strata holds the GPU: BUSY', !strata.ok && strata.why === 'BUSY' && /Big \(local Strata\)/.test(strata.text), JSON.stringify(strata));
  const image = await pickLocal(setup, server({ rows: { qwen: 'loaded' } }).f, async () => true);
  check('the image model holds the GPU: BUSY', !image.ok && image.why === 'BUSY' && /image/.test(image.text));
  const down = await pickLocal(setup, server({ down: true }).f, no);
  check('router not answering: DOWN', !down.ok && down.why === 'DOWN');
  check('nothing set up: DOWN', !(await pickLocal(undefined, server({}).f, no)).ok);
}

// ---------------------------------------------------------------- the stream
const sse = (events: object[], split = 0) => {
  const text = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const pieces = split ? text.match(new RegExp(`[\\s\\S]{1,${split}}`, 'g'))! : [text];
  return new Response(new ReadableStream({ start(c) {
    for (const p of pieces) c.enqueue(new TextEncoder().encode(p));
    c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
};
const answer = (text: string, o: { thinking?: string; stop?: string; inTok?: number; outTok?: number } = {}) => [
  { type: 'message_start', message: { usage: { input_tokens: o.inTok ?? 1200, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: o.thinking ?? 'hmm' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  ...text.match(/.{1,5}/gs)!.map((t) => ({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })),
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '' } },
  { type: 'message_delta', delta: { stop_reason: o.stop ?? 'end_turn' }, usage: { output_tokens: o.outTok ?? 80 } },
  { type: 'message_stop' },
];
const base = { url: 'http://relay.test', key: 'k', model: 'qwen', system: 's', prompt: 'p', maxTokens: 900, firstMs: 2000, totalMs: 4000 };
{
  let sent: Record<string, unknown> = {};
  let auth = '';
  const phases: string[] = [];
  const r = await runLocal({
    ...base,
    phase: (p) => phases.push(p),
    fetch: (async (_u: URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      auth = new Headers(init?.headers).get('authorization') ?? '';
      return sse(answer('The log shows three errors.'), 7);
    }) as typeof fetch,
  });
  check('answer text from the text pieces, thinking left out', r.text === 'The log shows three errors.', JSON.stringify(r));
  check("the model's own token counts", r.inTokens === 1200 && r.outTokens === 80 && !r.cut);
  check('phases: reading, thinking, writing', phases.join() === 'reading,thinking,writing', phases.join());
  check('request: streamed, no thinking, the cap, the key', sent.stream === true && (sent.chat_template_kwargs as { enable_thinking?: boolean })?.enable_thinking === false && sent.max_tokens === 900 && sent.model === 'qwen' && auth === 'Bearer k', JSON.stringify(sent));
  const cut = await runLocal({ ...base, fetch: (async () => sse(answer('<think>inline</think>Short.', { stop: 'max_tokens' }))) as typeof fetch });
  check('hit the length limit: marked; inline thinking taken out', cut.cut && cut.text === 'Short.', JSON.stringify(cut));
  const refused = await runLocal({ ...base, fetch: (async () => json({ type: 'error', error: { message: 'model not found' } }, 404)) as typeof fetch }).catch((e) => e);
  check('HTTP error: its message', /refused \(404: model not found\)/.test(String(refused)), String(refused));
  const hang = (async (_u: URL, init?: RequestInit) =>
    new Promise((_, no) => init?.signal?.addEventListener('abort', () => no(new DOMException('aborted', 'AbortError'))))) as typeof fetch;
  const slow = await runLocal({ ...base, firstMs: 40, fetch: hang }).catch((e) => e);
  check('no first piece in time: TOO SLOW message', /no answer within/.test(String(slow)), String(slow));
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  const stopped = await runLocal({ ...base, signal: stop.signal, fetch: hang }).catch((e) => e);
  check('STOP: stopped', (stopped as Error).message === 'stopped', String(stopped));
  const mid = await runLocal({ ...base, fetch: (async () => sse([{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'error', error: { message: 'out of memory' } }])) as typeof fetch }).catch((e) => e);
  check('an error event mid-stream: its message', /out of memory/.test(String(mid)));
}

// ---------------------------------------------------------------- ledger
{
  const file = join(dir, 'router.json');
  let now = 1000;
  const l = new Ledger(file, () => now);
  const real = join(root, 'big.log');
  const c1 = l.job('chat1', { ok: true, ms: 2000, worker: 'Qwen', inTokens: 1500, outTokens: 90, files: [{ real, chars: 4000 }], answerChars: 400 });
  check('a job with a file: kept off = file tokens less the answer', c1.calls === 1 && c1.keptOff === tokensOf(4000) - tokensOf(400) && c1.inTokens === 1500 && c1.outTokens === 90 && c1.worker === 'Qwen', JSON.stringify(c1));
  const c2 = l.job('chat1', { ok: true, ms: 1000, worker: 'Qwen', inTokens: 1500, outTokens: 50, files: [{ real, chars: 4000 }], answerChars: 200 });
  check('the same file again: nothing new kept off', c2.calls === 2 && c2.keptOff === c1.keptOff && c2.ms === 3000);
  const c3 = l.job('chat1', { ok: true, ms: 500, worker: 'Qwen', inTokens: 100, outTokens: 40, answerChars: 300 });
  check('a job without files: nothing kept off', c3.keptOff === c1.keptOff);
  const c4 = l.job('chat1', { ok: false, ms: 50, worker: 'Qwen' });
  check('a failed job: counted as failed, nothing kept off', c4.calls === 4 && c4.failed === 1 && c4.keptOff === c1.keptOff);
  l.job('chat2', { ok: true, ms: 100, worker: 'Gemma', files: [{ real: join(root, 'a.txt'), chars: 2000 }], answerChars: 0 });
  check('total adds up every chat', l.status(true).total.keptOff === c1.keptOff + 500 && l.status(true).total.calls === 5 && l.status(true).on);
  const seen = l.sawFile('chat1', join(root, 'big.log'));
  check('Claude reads the file itself: its tokens come back off (floored at 0)', seen?.keptOff === 0 && l.status(true).total.keptOff === 500, JSON.stringify(seen));
  check('reading it again, or an unknown file or chat: no change', l.sawFile('chat1', real) === undefined && l.sawFile('chat1', join(root, 'a.txt')) === undefined && l.sawFile('chatX', real) === undefined);
  now = 5000;
  l.save();
  const back = new Ledger(file);
  check('saved and read back', JSON.stringify(back.forChat('chat1')) === JSON.stringify(l.forChat('chat1')) && back.status(false).total.calls === 5 && back.status(false).since === 1000);
  check('a chat with no jobs: none', back.forChat('nobody') === undefined);
}

// ---------------------------------------------------------------- ask_local end to end
const counts: DelegateCount[] = [];
const statuses: string[] = [];
const chat = { id: 'tab-1', cwd: root, roots: [root, uploads], status: (s: string) => void statuses.push(s), counted: (c: DelegateCount) => void counts.push(c) };
type Tool = { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> };
const deps = (o: Parameters<typeof server>[0], extra: Partial<Deps> = {}): Deps & { calls: string[] } => {
  const s = server(o);
  return { local: setup, fetch: s.f, imageBusy: no, queue: new JobQueue(), ledger: new Ledger(join(dir, `l-${Math.random()}.json`)), relay: 'http://relay.test', waitMs: 1000, firstMs: 1000, totalMs: 2000, calls: s.calls, ...extra };
};
const ask = async (d: Deps, args: Record<string, unknown>, extra: unknown = {}) => {
  const r = await (askLocalTool(chat, d) as unknown as Tool).handler(args, extra);
  return { text: r.content[0].text, error: !!r.isError };
};
{
  let prompt = '';
  let model = '';
  const d = deps({ rows: { qwen: 'loaded' }, answer: (b) => {
    prompt = String((b.messages as { content: string }[])[0].content);
    model = String(b.model);
    return sse(answer('Two files: alpha and notes.', { inTok: 300, outTok: 20 }));
  } });
  const r = await ask(d, { task: 'What do these say?', files: ['a.txt', 'sub/c.md', join(outside, 'o.txt')], max_words: 50 });
  check('ask_local: the answer, under a short header', !r.error && /^\[ask_local: Qwen 35B read 2 files/.test(r.text) && r.text.endsWith('Two files: alpha and notes.'), r.text);
  check('ask_local: a refused file is named', /\[not read: .*o\.txt \(outside this chat's folders\)\]/.test(r.text), r.text);
  check('ask_local: the files go to the model, the task last', prompt.includes('<file path="a.txt">\nalpha file\n') && prompt.includes('<file path="sub/c.md">') && prompt.trim().endsWith('Task: What do these say?') && !prompt.includes('outside\n'), prompt);
  check('ask_local: the model that holds the card', model === 'qwen');
  check('ask_local: counted for the chat (an answer longer than the files keeps nothing off)', counts.at(-1)?.calls === 1 && counts.at(-1)?.keptOff === 0 && counts.at(-1)?.inTokens === 300 && counts.at(-1)?.outTokens === 20, JSON.stringify(counts.at(-1)));
  check('ask_local: the activity line follows the job', statuses.slice(-4).join(' | ') === 'Local model: reading 2 files | Local model: thinking | Local model: writing | Thinking', statuses.join(' | '));

  const big = await ask(deps({ rows: {}, answer: () => sse(answer('ok')) }), { task: 'x', files: ['big.log'] });
  check('ask_local: a whole small file is not marked cut', !/cut to fit/.test(big.text), big.text);
  check('ask_local: a bigger file: its tokens less the answer kept off', counts.at(-1)?.keptOff === tokensOf(5000) - tokensOf(2), JSON.stringify(counts.at(-1)));

  const none = deps({ rows: { qwen: 'loaded' }, answer: () => sse(answer('x')) });
  const bad = await ask(none, { task: 'x', files: ['.env', 'nope.txt'] });
  check('ask_local: no readable file: FAILED, the model is not asked', bad.error && /LOCAL MODEL FAILED: no file could be read: .env \(looks like a secret file\); nope.txt \(not found\)\. Do the job yourself\./.test(bad.text) && !none.calls.some((c) => c.includes('/v1/messages')), bad.text);
  const down = await ask(deps({ down: true }), { task: 'x' });
  check('ask_local: server down: DOWN, do it yourself', down.error && /^LOCAL MODEL DOWN: .*Do the job yourself\.$/.test(down.text), down.text);
  const busy = await ask(deps({ rows: {} }, { imageBusy: async () => true }), { task: 'x' });
  check('ask_local: the image model has the GPU: BUSY', busy.error && /^LOCAL MODEL BUSY: the image model has the GPU/.test(busy.text), busy.text);
  const q = new JobQueue(0);
  const hold = q.run(() => sleep(50), 1000);
  const queued = await ask(deps({ rows: {} }, { queue: q }), { task: 'x' });
  await hold;
  check('ask_local: queue full: BUSY', queued.error && /^LOCAL MODEL BUSY: 1 local jobs are already queued/.test(queued.text), queued.text);
  const stop = new AbortController();
  stop.abort();
  const stopped = await ask(deps({ rows: {}, answer: () => sse(answer('x')) }), { task: 'x' }, { signal: stop.signal });
  check('ask_local: stopped: STOPPED', stopped.error && /^LOCAL MODEL STOPPED/.test(stopped.text), stopped.text);
  const slow = await ask(deps({ rows: {}, answer: (_b, init) => new Promise((_, no) => init?.signal?.addEventListener('abort', () => no(new Error('aborted')))) }, { firstMs: 30 }), { task: 'x' });
  check('ask_local: no answer in time: TOO SLOW', slow.error && /^LOCAL MODEL TOO SLOW: no answer within/.test(slow.text), slow.text);
  const empty = await ask(deps({ rows: {}, answer: () => sse(answer(' ')) }), { task: 'x' });
  check('ask_local: an empty answer: FAILED', empty.error && /empty answer/.test(empty.text));
  check('ask_local: failures are counted as failed', counts.at(-1)?.failed === 1);
}

// ---------------------------------------------------------------- thread workers
{
  const lead = { model: 'opus', effort: 'xhigh' as const, auto: true };
  const efforts = (m: string) => ({ sonnet: ['low', 'medium', 'high'], haiku: [] } as Record<string, ('low' | 'medium' | 'high')[]>)[m];
  const ok: Pick = { ok: true, name: 'qwen', label: 'Qwen', value: 'local:qwen', context: 98304 };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  check('no worker: the lead\'s model, effort and AUTO', same(await threadModel(undefined, lead, { efforts }), lead));
  check('local: the model that holds the card, medium, AUTO off', same(await threadModel('local', lead, { efforts, pick: async () => ok }), { model: 'local:qwen', effort: 'medium', auto: false }));
  const busy = await threadModel('local', lead, { efforts, pick: async () => ({ ok: false, why: 'BUSY', text: 'the image model has the GPU' }) });
  check('local while BUSY: an error, so the lead picks another', 'error' in busy && /LOCAL MODEL BUSY: the image model has the GPU\. Pick another worker\./.test(busy.error), JSON.stringify(busy));
  check('sonnet: the lead\'s level held to what sonnet has', same(await threadModel('sonnet', lead, { efforts }), { model: 'sonnet', effort: 'high', auto: false }));
  check('haiku: no thinking levels, none set', same(await threadModel('haiku', lead, { efforts }), { model: 'haiku', auto: false }));
  check('opus with the model list not loaded: no level set', same(await threadModel('opus', lead, { efforts }), { model: 'opus', auto: false }));

  // start_thread through a lead tab: the worker reaches Tabs.thread.
  type T = { name: string; inputSchema: Record<string, unknown>; handler: (a: Record<string, unknown>, e: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> };
  let got: unknown;
  const leadTab = new Tab(() => {}, { cwd: root, title: 'Lead', model: 'opus', effort: 'high', project: { id: 'p1', name: 'P', main: true } });
  Tab.projects = {
    members: () => [leadTab],
    thread: (_l, title, _brief, run) => {
      got = run;
      return new Tab(() => {}, { cwd: root, title, project: { id: 'p1', name: 'P', main: false } });
    },
  };
  const start = (leadTab as unknown as { projectTools(): T[] }).projectTools().find((t) => t.name === 'start_thread')!;
  check('start_thread has a worker choice', 'worker' in start.inputSchema);
  const said = (await start.handler({ title: 'Sort', brief: 'Sort the list.', worker: 'haiku' }, {})).content[0].text;
  check('start_thread with worker haiku: the thread runs on haiku', same(got, { model: 'haiku', auto: false }) && /on haiku/.test(said), `${JSON.stringify(got)} ${said}`);
  await start.handler({ title: 'Plan', brief: 'Plan it.' }, {});
  check('start_thread without a worker: the lead\'s settings', same(got, { model: 'opus', effort: 'high', auto: false }), JSON.stringify(got));

  // A cloud chat gets ask_local; a chat on the local model does not (it would ask itself).
  const offered = (model: string) => (new Tab(() => {}, { cwd: root, model }) as unknown as { delegates: boolean }).delegates;
  check('ask_local: offered to a cloud chat, not to a local one', offered('sonnet') && !offered('local'));
  // A Read of a file ask_local read: the tab's count comes back down.
  const t = new Tab(() => {}, { cwd: root, model: 'sonnet' });
  ledger.job(t.id, { ok: true, ms: 1, worker: 'Qwen', files: [{ real: join(root, 'big.log'), chars: 4000 }], answerChars: 0 });
  (t as unknown as { onToolUse(id: string, name: string, input: Record<string, unknown>, parent: string | null): void }).onToolUse('r1', 'Read', { file_path: join(root, 'big.log') }, null);
  check('a Read of that file in the chat takes it back off', t.state.stats.delegate?.keptOff === 0 && t.state.stats.delegate?.calls === 1, JSON.stringify(t.state.stats.delegate));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
