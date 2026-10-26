// Local model relay: one model on the GPU at a time. Fake servers (a fetch stub), nothing real is started or called.
//   npx tsx tests/localrelay.ts

import { IMAGE_NOTE, makeRoom, NO_VISION, swapNeeded, withoutImages } from '../server/localrelay.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};

const ROUTER = 'http://router.test';
const OWN = 'http://own.test';
const m = {
  url: ROUTER,
  models: [],
  key: 'k',
  context: 98304,
  urls: { big: OWN } as Record<string, string>,
  units: { big: 'own.service' } as Record<string, string>,
  contexts: { big: 65536 } as Record<string, number>,
};

// A world of two servers: the router (models with a status) and an own server (/health, /unload).
function world(o: { router: Record<string, string>; ownUp: boolean; ownLoaded: boolean; startBrings?: boolean }) {
  const calls: string[] = [];
  const started: string[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    const what = `${init?.method ?? 'GET'} ${u.origin}${u.pathname}${u.search}`;
    calls.push(init?.body && u.pathname === '/models/unload' ? `${what} ${init.body}` : what);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.origin === ROUTER && u.pathname === '/v1/models') return ok({ data: Object.entries(o.router).map(([id, value]) => ({ id, status: { value } })) });
    if (u.origin === ROUTER && u.pathname === '/models/unload') return ok({ success: true });
    if (u.origin === OWN) {
      if (!o.ownUp) throw new TypeError('fetch failed');
      if (u.pathname === '/health') return ok({ loaded: o.ownLoaded });
      if (u.pathname === '/unload') return ok({ unloaded: true });
    }
    throw new Error(`unexpected ${what}`);
  }) as typeof fetch;
  const start = async (unit: string) => {
    started.push(unit);
    if (o.startBrings) o.ownUp = true;
  };
  return { f, start, calls, started };
}

// A router model while the own server holds the GPU: the own server unloads (and waits for a running answer).
{
  const w = world({ router: { qwen: 'unloaded' }, ownUp: true, ownLoaded: true });
  await makeRoom(m, 'qwen', w.f, w.start);
  check('router model: own server asked to unload', w.calls.includes(`POST ${OWN}/unload?wait=300`), w.calls.join(' | '));
  check('router model: router left alone', !w.calls.some((c) => c.startsWith(`GET ${ROUTER}`)), w.calls.join(' | '));
}

// A router model while the own server is up but idle: nothing to unload.
{
  const w = world({ router: {}, ownUp: true, ownLoaded: false });
  await makeRoom(m, 'qwen', w.f, w.start);
  check('router model, own server idle: no unload', !w.calls.some((c) => c.includes('/unload')), w.calls.join(' | '));
}

// A router model while the own server is down: nothing breaks, nothing started.
{
  const w = world({ router: {}, ownUp: false, ownLoaded: false });
  await makeRoom(m, 'qwen', w.f, w.start);
  check('router model, own server down: no start', w.started.length === 0);
}

// The own model: every router model that is not unloaded goes (loaded and sleeping), then the own server is checked.
{
  const w = world({ router: { qwen: 'loaded', gemma: 'sleeping', other: 'unloaded' }, ownUp: true, ownLoaded: true });
  await makeRoom(m, 'big', w.f, w.start);
  check('own model: loaded router model unloaded', w.calls.includes(`POST ${ROUTER}/models/unload {"model":"qwen"}`), w.calls.join(' | '));
  check('own model: sleeping router model unloaded', w.calls.includes(`POST ${ROUTER}/models/unload {"model":"gemma"}`), w.calls.join(' | '));
  check('own model: unloaded router model left alone', !w.calls.some((c) => c.includes('"other"')), w.calls.join(' | '));
  check('own model: up already, no start', w.started.length === 0);
  check('own model: router first, then own server', w.calls.findIndex((c) => c.includes('/models/unload')) < w.calls.findIndex((c) => c.startsWith(`GET ${OWN}/health`)));
}

// The own model while its server is down: its unit is started and waited for.
{
  const w = world({ router: {}, ownUp: false, ownLoaded: false, startBrings: true });
  await makeRoom(m, 'big', w.f, w.start);
  check('own model down: unit started', w.started.join() === 'own.service', w.started.join());
  check('own model down: waited until it answers', w.calls.filter((c) => c.startsWith(`GET ${OWN}/health`)).length >= 2);
}

// Two requests at once: the switches run one after the other.
{
  const order: string[] = [];
  const w = world({ router: { qwen: 'loaded' }, ownUp: true, ownLoaded: false });
  const slow = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    order.push(`start ${u.pathname}`);
    await new Promise((r) => setTimeout(r, 20));
    order.push(`end ${u.pathname}`);
    return w.f(input, init);
  }) as typeof fetch;
  await Promise.all([makeRoom(m, 'big', slow, w.start), makeRoom(m, 'qwen', slow, w.start)]);
  const firstQwenHealth = order.lastIndexOf('start /health');
  check('switches do not overlap', order.indexOf('end /health') <= firstQwenHealth, order.join(' | '));
}

// Two models on their own servers: picking one unloads the other first.
{
  const OWN2 = 'http://own2.test';
  const m2 = { ...m, urls: { big: OWN, big2: OWN2 }, units: { big: 'own.service', big2: 'own2.service' } };
  const calls: string[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${u.origin}${u.pathname}${u.search}`);
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.origin === ROUTER) return ok({ data: [] });
    if (u.pathname === '/health') return ok({ loaded: u.origin === OWN });
    return ok({ unloaded: true });
  }) as typeof fetch;
  await makeRoom(m2, 'big2', f, async () => {});
  check('own model: the other own server unloaded', calls.includes(`POST ${OWN}/unload?wait=300`), calls.join(' | '));
  check('own model: its own server not unloaded', !calls.includes(`POST ${OWN2}/unload?wait=300`), calls.join(' | '));
}

// A model without its vision file: pictures go out as a short note, the rest stays as it was.
{
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const req = {
    model: 'big',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'look' }, img] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [img, { type: 'text', text: 'ok' }] }] },
      { role: 'user', content: 'plain text' },
    ],
  };
  const out = withoutImages(req) as typeof req | null;
  const flat = JSON.stringify(out);
  check('no vision: pictures swapped', !!out && !flat.includes('"image"') && flat.split(IMAGE_NOTE).length === 3, flat);
  check('no vision: other text kept', flat.includes('"look"') && flat.includes('"ok"') && flat.includes('"plain text"') && flat.includes('"model":"big"'));
  check('no vision: the request itself not changed', JSON.stringify(req).includes('"image"'));
  check('no vision: no pictures gives null', withoutImages({ messages: [{ role: 'user', content: 'hi' }] }) === null);
  check('no vision: Strata error matches', NO_VISION.test('this server was started without the vision encoder (run setup again and choose \'vision\'), so it cannot read images'));
  check('no vision: llama.cpp error matches', NO_VISION.test('{"error":{"message":"image input is not supported - hint: if this is unexpected, you may need to provide the mmproj"}}'));
}

// NO_SWAP (ask_local): only the model that holds the card; anything else is a reason (409), and nothing is unloaded.
{
  const idle = world({ router: { qwen: 'loaded', gemma: 'unloaded' }, ownUp: true, ownLoaded: false });
  check('no swap: the loaded router model runs', (await swapNeeded(m, 'qwen', idle.f)) === '');
  check('no swap: another router model would push it out: the reason', (await swapNeeded(m, 'gemma', idle.f)) === 'qwen has the GPU');
  check('no swap: a model on its own server: the reason', /own server/.test(await swapNeeded(m, 'big', idle.f)));
  const strata = world({ router: { qwen: 'sleeping' }, ownUp: true, ownLoaded: true });
  check('no swap: the own server holds the card: the reason', /own server has the GPU/.test(await swapNeeded(m, 'qwen', strata.f)));
  check('no swap: nothing unloaded or started', ![...idle.calls, ...strata.calls].some((c) => c.startsWith('POST')) && !idle.started.length && !strata.started.length, [...idle.calls, ...strata.calls].join(' | '));
}

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
