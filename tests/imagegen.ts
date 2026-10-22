// Local image model: prompt options, the GPU hand-over between chat and pictures, the painter's queue (fake engine),
// and how a tab keeps its pictures. Nothing real is started or called; files go to a temp folder.
//   npx tsx tests/imagegen.ts

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageItem, Item, ServerEvent } from '../shared/protocol.ts';
import { Gpu } from '../server/gpu.ts';
import { fileName, Painter, type Engine } from '../server/imagegen.ts';
import { editSize, fitSize, imageSize, parseImageOptions } from '../server/imageopts.ts';
import { geminiAsk, pictureFrom } from '../server/geminiimage.ts';
import { mergeImages, Tab, type SavedImage } from '../server/tab.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---- prompt options
{
  const o = parseImageOptions('a lighthouse at sunset', () => 0.5);
  check('plain prompt: kept whole', o.prompt === 'a lighthouse at sunset', o.prompt);
  check('plain prompt: square 1024', o.width === 1024 && o.height === 1024);
  check('plain prompt: Turbo, 8 steps, random seed', o.steps === 8 && o.fast && !o.stepsSet && o.seed === 2 ** 30 && !o.shaped);
  const w = parseImageOptions('--wide a lighthouse --seed 42 at sunset --steps 20');
  check('options anywhere, taken out', w.prompt === 'a lighthouse at sunset', JSON.stringify(w.prompt));
  check('--wide is 16:9', w.width === 1344 && w.height === 768 && w.shaped);
  check('--seed and --steps', w.seed === 42 && w.steps === 20 && w.stepsSet);
  const t = parseImageOptions('tall tower --tall --hd');
  check('--tall --hd doubles the sides', t.width === 1536 && t.height === 2688 && t.hd, `${t.width}x${t.height}`);
  const f = parseImageOptions('a fine portrait --best');
  check('--best: the full model, 30 steps', !f.fast && f.steps === 30 && f.prompt === 'a fine portrait');
  check('--best with --steps keeps the steps', parseImageOptions('x --best --steps 12').steps === 12);
  const s = parseImageOptions('banner --size 1280x720');
  check('--size rounds to 32', s.width === 1280 && s.height === 736 && s.notes.length === 1, `${s.width}x${s.height} ${s.notes}`);
  const big = parseImageOptions('x --size 9000x9000');
  check('--size capped at the largest side', big.width === 2752 && big.height === 2752, `${big.width}x${big.height}`);
  const bad = parseImageOptions('x --seed abc --steps 500');
  check('bad values: notes, steps clamped', bad.notes.length === 2 && bad.steps === 100, JSON.stringify(bad.notes));
  const unknown = parseImageOptions('a sign that says --hello-- and --nope');
  check('unknown -- words stay in the prompt', unknown.prompt === 'a sign that says --hello-- and --nope', unknown.prompt);
  const lines = parseImageOptions('line one\nline two --wide');
  check('line breaks kept', lines.prompt === 'line one\nline two', JSON.stringify(lines.prompt));
  check('trailing --seed with no value: a note', parseImageOptions('x --seed').notes.length === 1);
  check('only options: empty prompt', parseImageOptions('--wide --seed 3').prompt === '');
  check('fitSize keeps shape', JSON.stringify(fitSize(3000, 1500)) === JSON.stringify([2752, 1376]), JSON.stringify(fitSize(3000, 1500)));
  check('editSize: about a megapixel, same shape', JSON.stringify(editSize(4000, 3000, false)) === JSON.stringify([1184, 896]), JSON.stringify(editSize(4000, 3000, false)));
}

// ---- picture sizes from headers
{
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(800, 16);
  png.writeUInt32BE(600, 20);
  check('PNG size', JSON.stringify(imageSize(png)) === '[800,600]');
  // JPEG: SOI, an APP0 segment, then SOF0 with height 480 and width 640.
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0]);
  check('JPEG size', JSON.stringify(imageSize(jpg)) === '[640,480]', JSON.stringify(imageSize(jpg)));
  const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
  check('GIF size', JSON.stringify(imageSize(gif)) === '[320,240]');
  check('not a picture', imageSize(Buffer.from('hello world, not an image at all')) === undefined);
}

// ---- file names
check('file name', fileName('A Lighthouse at sunset, "PHOSPHOR"!', 42, new Date(2026, 9, 19, 21, 5, 3)) === '2026-10-19_210503_a-lighthouse-at-sunset-phosphor_42.png');
check('file name, no words', fileName('!!!', 1, new Date(2026, 0, 2, 3, 4, 5)) === '2026-01-02_030405_picture_1.png');

// ---- GPU turns: chat requests share the card, a picture waits for them, chats wait for the picture
{
  const log: string[] = [];
  const gpu = new Gpu(async (to) => {
    log.push(`handover:${to}`);
    await tick(5);
  });
  const c1 = await gpu.acquire('chat');
  log.push('chat1');
  const c2 = await gpu.acquire('chat');
  log.push('chat2');
  let imgRelease: (() => void) | undefined;
  const img = gpu.acquire('image').then((r) => {
    log.push('image');
    imgRelease = r;
  });
  const c3 = gpu.acquire('chat').then((r) => {
    log.push('chat3');
    return r;
  });
  await tick(10);
  check('picture waits while chats run', !log.includes('image'), log.join(' '));
  check('a chat after a waiting picture waits too (no skipping the line)', !log.includes('chat3'), log.join(' '));
  c1();
  c1(); // twice: counted once
  await tick(10);
  check('one chat still running: picture still waits', !log.includes('image'), log.join(' '));
  c2();
  await img;
  check('then the card goes to the picture, after a hand-over', log.join(' ') === 'handover:chat chat1 chat2 handover:image image', log.join(' '));
  await tick(10);
  check('chat waits for the picture', !log.includes('chat3'));
  imgRelease!();
  const r3 = await c3;
  check('then back to chat, after a hand-over', log.slice(-2).join(' ') === 'handover:chat chat3', log.join(' '));
  r3();
  check('card free at the end', gpu.state.holder === null && gpu.state.users === 0 && gpu.state.waiting === 0, JSON.stringify(gpu.state));
  const r4 = await gpu.acquire('chat');
  check('same kind again: no new hand-over', log.filter((l) => l === 'handover:chat').length === 2, log.join(' '));
  r4();
  // Clean-up turn for the image engine: skipped (no hand-over) once a chat had the card.
  const skip = await gpu.acquireIfLast('image');
  check('acquireIfLast: chat had the card last: skipped, no hand-over', skip === null && log.filter((l) => l.startsWith('handover')).length === 3, log.join(' '));
  const ri = await gpu.acquire('image');
  ri();
  const mine = await gpu.acquireIfLast('image');
  check('acquireIfLast: picture had it last: a turn', typeof mine === 'function' && gpu.state.holder === 'image');
  const chatWaits = gpu.acquire('chat');
  await tick(10);
  check('acquireIfLast turn: a chat waits for it', gpu.state.waiting === 1);
  mine!();
  (await chatWaits)();
}

// ---- the painter with a fake engine
function fakeEngine(o: { upAfterStart?: boolean; failJob?: boolean; refuse?: boolean } = {}) {
  const calls: string[] = [];
  let up = false;
  const jobs: { id: string; body: Record<string, unknown>; polls: number }[] = [];
  const png = Buffer.from('fake png');
  const engine: Engine = {
    async up() {
      return up;
    },
    async start() {
      calls.push('start');
      if (o.upAfterStart !== false) up = true;
    },
    async stop() {
      calls.push('stop');
      up = false;
    },
    async freeChat() {
      calls.push('freeChat');
    },
    fetch: (async (input: URL | string, init?: RequestInit) => {
      const u = new URL(String(input));
      const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (u.pathname === '/sdcpp/v1/img_gen') {
        if (o.refuse) return ok({ error: 'job queue is full' }, 429);
        const id = `job${jobs.length + 1}`;
        jobs.push({ id, body: JSON.parse(String(init?.body)), polls: 0 });
        calls.push(`submit:${id}`);
        return ok({ id, status: 'queued' }, 202);
      }
      const m = /^\/sdcpp\/v1\/jobs\/(\w+)$/.exec(u.pathname);
      if (m) {
        const j = jobs.find((x) => x.id === m[1])!;
        j.polls++;
        const steps = (j.body.sample_params as { sample_steps: number }).sample_steps;
        if (j.polls <= 2) return ok({ status: 'generating', preview: { step: Math.ceil((steps * j.polls) / 3) } });
        if (o.failJob) return ok({ status: 'failed', error: { message: 'out of memory' } });
        calls.push(`done:${j.id}`);
        return ok({ status: 'completed', result: { images: [{ b64_json: png.toString('base64') }] } });
      }
      throw new Error(`unexpected ${u.pathname}`);
    }) as typeof fetch,
  };
  return { engine, calls, jobs, png };
}

const dir = mkdtempSync(join(tmpdir(), 'phosphor-img-'));
const cfg = { url: 'http://img.test', label: 'Fake Image (local)', dir, idleMs: 30, turbo: 'turbo.safetensors', pollMs: 1, startWaitMs: 50, busyFile: join(dir, 'busy') };

{
  const w = fakeEngine();
  const p = new Painter(w.engine, cfg);
  const updates: Partial<ImageItem>[] = [];
  const r = await p.paint({ opts: parseImageOptions('a lighthouse --seed 7 --best'), update: (u) => updates.push(u), cancelled: () => false });
  check('paint: done', r.status === 'done', JSON.stringify(r));
  check('paint: chat models freed, engine started, then the job', w.calls.slice(0, 3).join(' ') === 'freeChat start submit:job1', w.calls.join(' '));
  check('paint: saved PNG', r.status === 'done' && readFileSync(r.path).equals(w.png) && r.path.startsWith(dir) && r.file.endsWith('_a-lighthouse_7.png'), JSON.stringify(r));
  check('paint: progress reported', updates.some((u) => u.phase === 'Painting' && u.step === 10) && updates.some((u) => u.phase === 'Starting the image engine'), JSON.stringify(updates));
  const body = w.jobs[0].body as { prompt: string; seed: number; width: number; lora: unknown[]; sample_params: { sample_steps: number; guidance: { txt_cfg: number }; custom_sigmas?: number[] } };
  check('paint: job body', body.prompt === 'a lighthouse' && body.seed === 7 && body.width === 1024 && body.sample_params.sample_steps === 30 && body.lora.length === 0 && body.sample_params.guidance.txt_cfg > 1, JSON.stringify(body));
  check('paint: busy file gone after', !existsSync(cfg.busyFile));
  await tick(60);
  check('idle: engine stopped after the idle time', w.calls.at(-1) === 'stop', w.calls.join(' '));
}

{
  // A chat takes the card before the idle time is up: its hand-over stops the engine; the idle stop does not run
  // again, and never unloads the chat models.
  const w = fakeEngine();
  const p = new Painter(w.engine, cfg);
  await p.paint({ opts: parseImageOptions('x'), update: () => {}, cancelled: () => false });
  (await p.gpu.acquire('chat'))();
  await tick(60);
  check('idle after a chat: one stop (the hand-over), chat models freed once', w.calls.filter((c) => c === 'stop').length === 1 && w.calls.filter((c) => c === 'freeChat').length === 1, w.calls.join(' '));
}

{
  // Default (Turbo): its LoRA, CFG 1, its own schedule. Two pictures at once: one after the other.
  const w = fakeEngine();
  const p = new Painter(w.engine, cfg);
  const a = p.paint({ opts: parseImageOptions('one'), update: () => {}, cancelled: () => false });
  const b = p.paint({ opts: parseImageOptions('two --best'), update: () => {}, cancelled: () => false });
  await tick(1);
  check('queue: second one waits', p.painting()?.queued === 1, JSON.stringify(p.painting()));
  const [ra, rb] = await Promise.all([a, b]);
  check('queue: both done', ra.status === 'done' && rb.status === 'done');
  check('queue: one after the other', w.calls.filter((c) => /^(submit|done)/.test(c)).join(' ') === 'submit:job1 done:job1 submit:job2 done:job2', w.calls.join(' '));
  check('queue: engine started once', w.calls.filter((c) => c === 'start').length === 1, w.calls.join(' '));
  const fast = w.jobs[0].body as { lora: { path: string }[]; sample_params: { sample_steps: number; guidance: { txt_cfg: number }; custom_sigmas?: number[] } };
  check('default: Turbo LoRA, 8 steps, CFG 1, its schedule', fast.lora[0]?.path === 'turbo.safetensors' && fast.sample_params.sample_steps === 8 && fast.sample_params.guidance.txt_cfg === 1 && fast.sample_params.custom_sigmas?.length === 9, JSON.stringify(fast));
  check('painting(): idle after', p.painting() === null);
}

{
  // Cancelled before its turn: never sent. A chat holding the card: the picture waits for it.
  const w = fakeEngine();
  const p = new Painter(w.engine, cfg);
  const chat = await p.gpu.acquire('chat');
  let stop = false;
  const r = p.paint({ opts: parseImageOptions('x'), update: () => {}, cancelled: () => stop });
  await tick(5);
  check('chat running: picture waits, engine not started', !w.calls.includes('start') && p.painting()?.phase === 'Waiting for the GPU', w.calls.join(' '));
  stop = true;
  chat();
  const res = await r;
  check('cancelled while waiting: not sent', res.status === 'cancelled' && !w.calls.some((c) => c.startsWith('submit')), w.calls.join(' '));
}

{
  const w = fakeEngine({ failJob: true });
  const r = await new Painter(w.engine, cfg).paint({ opts: parseImageOptions('x'), update: () => {}, cancelled: () => false });
  check('engine fails the job: failed with its reason', r.status === 'failed' && r.error === 'out of memory', JSON.stringify(r));
  const w2 = fakeEngine({ upAfterStart: false });
  const r2 = await new Painter(w2.engine, cfg).paint({ opts: parseImageOptions('x'), update: () => {}, cancelled: () => false });
  check('engine never comes up: failed, says where the log is', r2.status === 'failed' && /did not start/.test(r2.error), JSON.stringify(r2));
  const w3 = fakeEngine({ refuse: true });
  const r3 = await new Painter(w3.engine, cfg).paint({ opts: parseImageOptions('x'), update: () => {}, cancelled: () => false });
  check('engine refuses: failed', r3.status === 'failed' && /queue is full/.test(r3.error), JSON.stringify(r3));
}

// ---- a tab keeps its pictures: saved with the tab, back in place after a reload
{
  const u = (id: string, text = id): Item => ({ id, kind: 'user', text });
  const c = (id: string): Item => ({ id, kind: 'claude', text: id });
  const img = (id: string): Item => ({ id, kind: 'image', status: 'done', prompt: id, model: 'm', width: 1, height: 1, seed: 1, steps: 1, file: `${id}.png` });
  const items = [u('u1'), c('c1'), u('u2'), c('c2')];
  const log: SavedImage[] = [
    { after: null, item: img('first') },
    { after: 'u1', item: img('afterU1') },
    { after: 'u2', item: img('afterU2') },
    { after: 'gone', item: img('lost') },
  ];
  const ids = mergeImages(items, log).map((i) => i.id).join(' ');
  check('merge: each picture after the turn it followed', ids === 'first u1 c1 afterU1 u2 c2 afterU2 lost', ids);
  check('merge: nothing saved, same list', mergeImages(items, []) === items);

  const saved: SavedImage[] = [
    { after: null, item: { id: 'p1', kind: 'user', text: 'a cat', paint: true } },
    { after: null, item: img('done1') },
    { after: null, item: { ...(img('half') as ImageItem), status: 'painting', step: 3 } },
  ];
  const t = new Tab(() => {}, { cwd: '/tmp', images: saved });
  check('restore: pictures shown without a Claude session', t.state.items.map((i) => i.id).join(' ') === 'p1 done1 half');
  const half = t.state.items[2] as ImageItem;
  check('restore: a picture cut off by the restart says so', half.status === 'failed' && /restarted/.test(half.error ?? ''), JSON.stringify(half));
  check('restore: saved again as is', t.images.length === 3 && t.images[1].item.id === 'done1');
}

// ---- a tab on the image model: the message becomes a picture, not a Claude message
{
  const events: ServerEvent[] = [];
  const jobs: { prompt: string; ref: boolean; w: number; h: number; fast: boolean; steps: number }[] = [];
  let finish: () => void = () => {};
  Tab.images = {
    model: { label: 'Fake Image (local)', edit: true, turbo: '' },
    painter: {
      paint: (job) => {
        jobs.push({ prompt: job.opts.prompt, ref: !!job.ref, w: job.opts.width, h: job.opts.height, fast: job.opts.fast, steps: job.opts.steps });
        job.update({ status: 'painting', phase: 'Painting', step: 2 });
        return new Promise((r) => (finish = () => r({ status: 'done', file: 'x.png', path: '/pics/x.png', ms: 1234 })));
      },
    },
  };
  let persisted = 0;
  const t = new Tab((e) => events.push(e), { cwd: '/tmp', model: 'image' });
  t.onPersist = () => persisted++;
  const shot = mkdtempSync(join(tmpdir(), 'phosphor-ref-'));
  const refPath = join(shot, 'ref.png');
  const png = Buffer.alloc(24);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(2000, 16);
  png.writeUInt32BE(1000, 20);
  writeFileSync(refPath, png);
  t.send('make it night', [{ id: 'up1', name: 'ref.png', kind: 'image', size: 24, mediaType: 'image/png', path: refPath }]);
  await tick(1);
  check('image tab: busy while painting', t.state.meta.busy && /Painting/.test(t.state.activity), t.state.activity);
  check('image tab: the prompt, then the picture', t.state.items.map((i) => (i.kind === 'user' ? `user${i.paint ? ':paint' : ''}` : i.kind)).join(' ') === 'user:paint image', JSON.stringify(t.state.items));
  check('image tab: the attached picture goes in, its shape kept; no Turbo here: full model', jobs[0]?.ref && jobs[0].w === 1440 && jobs[0].h === 736 && !jobs[0].fast && jobs[0].steps === 30, JSON.stringify(jobs));
  check('image tab: title from the prompt', t.state.meta.title.startsWith('make it night'), t.state.meta.title);
  finish();
  await tick(1);
  const done = t.state.items.at(-1) as ImageItem;
  check('image tab: picture done', done.status === 'done' && done.file === 'x.png' && done.ms === 1234, JSON.stringify(done));
  check('image tab: idle after', !t.state.meta.busy);
  check('image tab: saved (persist asked)', persisted > 0 && t.images.length === 2);
  check('image tab: no Claude process started', t.query === undefined);
  check('image tab: item events sent', events.some((e) => e.t === 'update' && e.item.kind === 'image' && e.item.status === 'done'));
  t.send('   --wide  ');
  await tick(1);
  check('image tab: options only: says there is nothing to paint', t.state.items.at(-1)?.kind === 'note' && jobs.length === 1);
  Tab.images = { model: { label: 'No Edit (local)', edit: false, turbo: 'x' }, painter: Tab.images.painter };
  t.send('again', [{ id: 'up2', name: 'ref.png', kind: 'image', size: 24, mediaType: 'image/png', path: refPath }]);
  await tick(1);
  const note = t.state.items.filter((i) => i.kind === 'note').at(-1);
  check('no editing: says so plainly, paints from the words', note?.kind === 'note' && /cannot change a picture/.test(note.text) && jobs[1]?.ref === false, JSON.stringify(note));
  check('with Turbo installed: the default is Turbo, 8 steps', jobs[1]?.fast === true && jobs[1].steps === 8, JSON.stringify(jobs[1]));
  finish();
  await tick(1);
  rmSync(shot, { recursive: true, force: true });
}

// ---- Gemini pictures (server/geminiimage.ts): the words sent, the file found, and a tab on a Gemini entry
{
  const ask = geminiAsk('a red kite over a beach', 1024, 576, true);
  check('gemini: asks for one picture, the shape, the user\'s words and only the path back', /exactly one picture/.test(ask) && /landscape, aspect ratio 16:9/.test(ask) && ask.includes('a red kite over a beach') && /only the full path/.test(ask) && /ref-1\.png/.test(ask), ask);
  check('gemini: no attached picture, no ref file named', !/ref-1/.test(geminiAsk('x', 896, 1120, false)) && /portrait, aspect ratio 4:5/.test(geminiAsk('x', 896, 1120, false)));
  const home = homedir();
  const pic = `${home}/.gemini/antigravity-cli/brain/abc/kite_1.jpg`;
  const out = [JSON.stringify({ event: 'tool', text: 'saved /etc/passwd.png' }), JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'chat-1234-abcd', response: `Done.\n${pic}\n` } })].join('\n');
  const got = pictureFrom(out, (f) => f === pic);
  check('gemini: the picture path from the answer, and its chat', got.file === pic && /Done/.test(got.answer ?? '') && got.chat === 'chat-1234-abcd', JSON.stringify(got));
  check('gemini: asks it to wait for the picture in this turn', /wait for its result in this turn/.test(ask));
  check('gemini: the last picture: change it only when asked', /last\.png/.test(geminiAsk('x', 512, 512, false, true)) && /If the request is a new picture, do not use last\.png/.test(geminiAsk('x', 512, 512, false, true)) && !/last\.png/.test(ask));
  check('gemini: a path outside its own folder is never taken', pictureFrom(JSON.stringify({ event: 'result', result: { response: '/home/x/secret.png' } }), () => true).file === undefined);
  check('gemini: no picture: the answer is kept for the message', pictureFrom(JSON.stringify({ event: 'result', result: { response: 'Your daily limit is used up.' } })).answer === 'Your daily limit is used up.');

  const jobs: { prompt: string; ref: boolean; thread?: string; w: number; h: number }[] = [];
  Tab.gemini = new Map([['image:gemini:fake', { model: { label: 'Gemini Image (Fake)', edit: true, turbo: '' }, painter: { paint: async (job) => (jobs.push({ prompt: job.opts.prompt, ref: !!job.ref, thread: job.thread, w: job.opts.width, h: job.opts.height }), { status: 'done', file: 'g.png', path: '/pics/g.png', ms: 50 }) } }]]);
  const t = new Tab(() => {}, { cwd: '/tmp', model: 'image:gemini:fake' });
  t.send('a lighthouse --wide');
  await tick(1);
  const item = t.state.items.find((i) => i.kind === 'image') as ImageItem | undefined;
  check('gemini tab: the message becomes a Gemini picture, no Claude process', jobs[0]?.prompt === 'a lighthouse' && t.query === undefined, JSON.stringify(jobs));
  check('gemini tab: no seed or steps on the card; done', item?.seed === 0 && item.steps === 0 && item.status === 'done' && item.model === 'Gemini Image (Fake)', JSON.stringify(item));
  check('gemini tab: the tab is the thread (one Gemini chat per tab)', jobs[0]?.thread === t.id, JSON.stringify(jobs[0]));
  t.send('the same, but at night');
  await tick(1);
  check('gemini tab: a follow-up keeps the last picture\'s shape', jobs[1]?.w === jobs[0].w && jobs[1].h === jobs[0].h && jobs[0].w > jobs[0].h, JSON.stringify(jobs));
  t.send('a tall tower --tall');
  await tick(1);
  check('gemini tab: a shape asked wins', jobs[2]?.h > jobs[2]?.w, JSON.stringify(jobs[2]));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
