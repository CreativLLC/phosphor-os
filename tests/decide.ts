// Decision engine client (server/decide.ts) and answer reading (shared/decide.ts). A fake fetch stands in for the
// engine: no network, no model.
//   npx tsx tests/decide.ts

import { decideConfig, DOWN_RETRY_MS, endpoint, makeDecider, type DecideConfig } from '../server/decide.ts';
import { choiceConfidence, parseAnswers, scoreConfidence, type Questions } from '../shared/decide.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};

const Q = {
  billing: { type: 'noul', instructions: 'Is this about billing?' },
  team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, shipping: 'parcels', technical: null } },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['can wait', 'today', 'right now'] },
} as const satisfies Questions;

const GOOD = {
  model: 'kev-0.8b',
  answers: {
    billing: { type: 'noul', noul: 0.9 },
    team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.8, shipping: 0.15, technical: 0.05 }, confidence: 0.7 },
    urgency: { type: 'score', score: 1.2, legend: { 0: 'can wait', 1: 'today', 2: 'right now' }, probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 }, confidence: 0.5 },
  },
  usage: { input_tokens: 120, output_tokens: 0 },
};

// ---------------------------------------------------------------- settings and URL
{
  const c = decideConfig({});
  check('default: on, the local server', c.on && c.url === 'http://127.0.0.1:8090' && c.key === '' && c.model === '');
  check('PHOSPHOR_DECIDE=off', !decideConfig({ PHOSPHOR_DECIDE: 'off' }).on);
  const d = decideConfig({ PHOSPHOR_DECIDE_URL: 'https://api.example.test', PHOSPHOR_DECIDE_KEY: 'k', PHOSPHOR_DECIDE_MODEL: 'jev-latest' });
  check('URL, key and model from the environment', d.url === 'https://api.example.test' && d.key === 'k' && d.model === 'jev-latest');
  check('base URL gets the path', endpoint('http://127.0.0.1:8090/') === 'http://127.0.0.1:8090/v1/systemone');
  check('a /v1 URL gets the rest', endpoint('https://api.example.test/v1') === 'https://api.example.test/v1/systemone');
  check('a full endpoint stays', endpoint('https://x.test/v1/systemone') === 'https://x.test/v1/systemone');
}

// ---------------------------------------------------------------- the client against a fake engine
type Call = { url: string; init: RequestInit };
function engine(reply: (call: Call) => Promise<Response> | Response, cfg: Partial<DecideConfig> = {}) {
  const calls: Call[] = [];
  let clock = 1000;
  const ask = makeDecider({
    config: () => ({ on: true, url: 'http://engine.test', key: '', model: '', ...cfg }),
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      return reply(call);
    }) as typeof fetch,
    now: () => clock,
  });
  return { ask, calls, tick: (ms: number) => (clock += ms) };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
// Waits until the request's signal fires, like an engine that never answers.
const hang = ({ init }: Call) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

{
  const e = engine(() => json(GOOD));
  const r = await e.ask('I was charged twice.', Q);
  check('answers come back typed', r.ok && r.answers.billing.yes && r.answers.team.choice === 'billing' && r.answers.urgency.level === 1, JSON.stringify(r));
  if (r.ok) {
    check('noul: p and confidence |2p-1|', r.answers.billing.p === 0.9 && Math.abs(r.answers.billing.confidence - 0.8) < 1e-9);
    check('choice: probabilities and the engine confidence', r.answers.team.probabilities.shipping === 0.15 && r.answers.team.confidence === 0.7);
    check('score: expected level, most likely level, probabilities by index', r.answers.urgency.score === 1.2 && r.answers.urgency.probabilities.join() === '0.1,0.6,0.3');
    check('model and input tokens', r.model === 'kev-0.8b' && r.inputTokens === 120);
  }
  const body = JSON.parse(String(e.calls[0].init.body));
  check('POST to /v1/systemone with state and questions', e.calls[0].url === 'http://engine.test/v1/systemone' && e.calls[0].init.method === 'POST' && body.state === 'I was charged twice.' && body.questions.team.type === 'choice');
  check('no model and no key when none is set', !('model' in body) && !(e.calls[0].init.headers as Record<string, string>).authorization);
}

{
  const e = engine(() => json(GOOD), { key: 'secret', model: 'jev-latest' });
  await e.ask({ message: 'hi', plan: 'pro' }, Q);
  const body = JSON.parse(String(e.calls[0].init.body));
  check('cloud: model in the body, Bearer key', body.model === 'jev-latest' && (e.calls[0].init.headers as Record<string, string>).authorization === 'Bearer secret');
  check('an object state is sent as it is', body.state.plan === 'pro');
}

{
  const e = engine(() => json(GOOD), { on: false });
  const r = await e.ask('x', Q);
  check('off: no request, reason off', !r.ok && r.reason === 'off' && e.calls.length === 0);
}

{
  const r = await engine(() => new Response('{"error":{"message":"not a decision model"}}', { status: 501 })).ask('x', Q);
  check('HTTP error: reason error with the status', !r.ok && r.reason === 'error' && r.error.startsWith('HTTP 501'), JSON.stringify(r));
}

{
  const r = await engine(() => new Response('<html>proxy</html>')).ask('x', Q);
  check('not JSON: error', !r.ok && r.reason === 'error' && r.error === 'not JSON');
  const half = { ...GOOD, answers: { billing: GOOD.answers.billing } };
  const r2 = await engine(() => json(half)).ask('x', Q);
  check('an answer missing: the whole call failed', !r2.ok && r2.reason === 'error');
}

{
  const e = engine(hang);
  const t0 = Date.now();
  const r = await e.ask('x', Q, { timeoutMs: 50 });
  check('timeout: reason timeout, on time', !r.ok && r.reason === 'timeout' && Date.now() - t0 < 1000, JSON.stringify(r));
  const r2 = await e.ask('x', Q, { timeoutMs: 50 });
  check('a slow engine is asked again next time (not marked down)', !r2.ok && r2.reason === 'timeout' && e.calls.length === 2);
}

{
  const e = engine(hang);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 20);
  const r = await e.ask('x', Q, { signal: stop.signal, timeoutMs: 5000 });
  check('caller abort: reason aborted', !r.ok && r.reason === 'aborted');
  const r2 = await e.ask('x', Q, { signal: stop.signal });
  check('already aborted: no request', !r2.ok && r2.reason === 'aborted' && e.calls.length === 1);
}

{
  let up = false;
  const e = engine(() => {
    if (!up) throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:8090') });
    return json(GOOD);
  });
  const r = await e.ask('x', Q);
  check('nobody home: reason down, the cause kept', !r.ok && r.reason === 'down' && r.error.includes('ECONNREFUSED'), JSON.stringify(r));
  up = true;
  const r2 = await e.ask('x', Q);
  check('down: left alone for a moment (no request)', !r2.ok && r2.reason === 'down' && e.calls.length === 1);
  e.tick(DOWN_RETRY_MS);
  const r3 = await e.ask('x', Q);
  check('after the pause it is asked again', r3.ok && e.calls.length === 2);
}

// ---------------------------------------------------------------- parseAnswers edge cases
{
  const choice = { t: { type: 'choice', instructions: 'q', criteria: { a: null, b: null } } } as const satisfies Questions;
  const noChoice = parseAnswers({ t: { type: 'choice', probabilities: { a: 0.3, b: 0.7 } } }, choice);
  check('choice without a choice field: the most likely option', noChoice?.t.choice === 'b');
  check('no confidence sent: TypeSafe\'s formula ((0.7 - 0.5) / 0.5)', Math.abs((noChoice?.t.confidence ?? 0) - 0.4) < 1e-9, String(noChoice?.t.confidence));
  check('choice naming an unknown option: the most likely known one', parseAnswers({ t: { choice: 'zzz', probabilities: { a: 0.6, b: 0.4 } } }, choice)?.t.choice === 'a');
  check('choice with nothing usable: null', parseAnswers({ t: { probabilities: {} } }, choice) === null);
  const noul = { n: { type: 'noul', instructions: 'q' } } as const satisfies Questions;
  check('noul out of range is held to 0..1', parseAnswers({ n: { noul: 1.3 } }, noul)?.n.p === 1);
  check('noul at 0.5 counts as yes, confidence 0', parseAnswers({ n: { noul: 0.5 } }, noul)?.n.yes === true && parseAnswers({ n: { noul: 0.5 } }, noul)?.n.confidence === 0);
  check('noul without a number: null', parseAnswers({ n: { noul: 'yes' } }, noul) === null);
  check('choice confidence: all equal 0, one sure 1', choiceConfidence([1 / 3, 1 / 3, 1 / 3]) === 0 && choiceConfidence([0, 1, 0]) === 1);
  check('score confidence: one level 1, all equal 0', scoreConfidence([0, 0, 1, 0]) === 1 && Math.abs(scoreConfidence([0.25, 0.25, 0.25, 0.25])) < 1e-9);
  // llama.cpp's own answer for these probabilities (the server README example): 0.673.
  check('score confidence matches llama.cpp', Math.abs(scoreConfidence([0.0023, 0.116, 0.6753, 0.2064]) - 0.673) < 0.01, String(scoreConfidence([0.0023, 0.116, 0.6753, 0.2064])));
  check('no answers object: null', parseAnswers(undefined, noul) === null && parseAnswers('x', noul) === null);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
