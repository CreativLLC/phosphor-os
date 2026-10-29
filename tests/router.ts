// AUTO router: reading Haiku's answer, the decision model's answers and the stickiness rule (shared/router.ts), and
// the order of the engines (server/router.ts) with fakes. Nothing is asked of a model.
//   npm run test:router        (= npx tsx tests/router.ts)

import type { Answers, DecideResult, Questions } from '../shared/decide.ts';
import { clampEffort, decide, parsePick, pickFromAnswers, ROUTE_MIN_CONFIDENCE, type RoutePick, type RouteQuestions } from '../shared/router.ts';
import { autoDecideOn, DECIDE_ROUTE_TIMEOUT_MS, routeMessage, type HaikuResult, type RouteDeps, type RouteInput } from '../server/router.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const pick = (model: RoutePick['model'], effort: RoutePick['effort'], newTopic = false): RoutePick => ({ model, effort, newTopic, reason: 'why' });

// parsePick
check('plain JSON', same(parsePick('{"model":"opus","effort":"high","newTopic":true,"reason":"x y"}'), { model: 'opus', effort: 'high', newTopic: true, reason: 'x y' }));
check('JSON inside text and a fence', parsePick('Here:\n```json\n{"model":"Sonnet","effort":"MEDIUM","newTopic":false,"reason":"r"}\n```')?.model === 'sonnet');
check('reason cut to 12 words', parsePick('{"model":"haiku","effort":"low","reason":"1 2 3 4 5 6 7 8 9 10 11 12 13 14"}')?.reason === '1 2 3 4 5 6 7 8 9 10 11 12');
check('missing newTopic is false', parsePick('{"model":"haiku","effort":"low","reason":"r"}')?.newTopic === false);
check('unknown model rejected', parsePick('{"model":"gpt","effort":"low","reason":"r"}') === null);
check('max effort rejected', parsePick('{"model":"opus","effort":"max","reason":"r"}') === null);
check('no JSON rejected', parsePick('sorry') === null && parsePick('{broken') === null && parsePick('') === null);

// decide: first message and failures
check('first message: the pick', same(decide(pick('sonnet', 'medium'), null), { model: 'sonnet', effort: 'medium', reason: 'why' }));
check('failure with nothing yet: opus high', same(decide(null, null, 'timeout').model + decide(null, null, 'timeout').effort, 'opushigh'));
check('failure keeps current', same(decide(null, { model: 'sonnet', effort: 'low' }, 'timeout'), { model: 'sonnet', effort: 'low', reason: 'Router failed (timeout); kept sonnet.' }));
check('unknown current model (local): the pick', decide(pick('haiku', 'low'), { model: 'local', effort: '' }).model === 'haiku');
check('second local model (local:name): the pick', decide(pick('haiku', 'low'), { model: 'local:qwen3.6-35b', effort: '' }).model === 'haiku');

// decide: stickiness
const cur = { model: 'sonnet', effort: 'medium' };
check('upgrade applies', decide(pick('opus', 'high'), cur).model === 'opus');
check('downgrade held on the same topic', decide(pick('haiku', 'low'), cur).model === 'sonnet');
check('downgrade held: reason says so', decide(pick('haiku', 'low'), cur).reason.includes('kept sonnet'));
check('downgrade applies on a new topic', decide(pick('haiku', 'low', true), cur).model === 'haiku');
check('same model stays', decide(pick('sonnet', 'medium'), cur).model === 'sonnet');
check('family names in full ids rank', decide(pick('haiku', 'low'), { model: 'claude-opus-5-5', effort: 'high' }).model === 'claude-opus-5-5');
check('default ranks as sonnet', decide(pick('opus', 'high'), { model: 'default', effort: 'high' }).model === 'opus');
check('fable is never downgraded mid-topic', decide(pick('opus', 'high'), { model: 'fable', effort: 'high' }).model === 'fable');

// decide: effort
check('effort up applies', decide(pick('sonnet', 'high'), cur).effort === 'high');
check('effort down held on the same topic', decide(pick('sonnet', 'low'), cur).effort === 'medium');
check('effort down applies on a new topic', decide(pick('sonnet', 'low', true), cur).effort === 'low');
check('new model: effort follows the pick', decide(pick('opus', 'low'), { model: 'sonnet', effort: 'high' }).effort === 'low');
check('current effort max is held', decide(pick('sonnet', 'xhigh'), { model: 'sonnet', effort: 'max' }).effort === 'max');
check('current effort unset: the pick', decide(pick('sonnet', 'high'), { model: 'sonnet', effort: '' }).effort === 'high');

// clampEffort
check('supported effort stays', clampEffort('high', ['low', 'medium', 'high']) === 'high');
check('unsupported xhigh drops to the highest allowed', clampEffort('xhigh', ['low', 'medium', 'high']) === 'high');
check('below the lowest allowed: the lowest', clampEffort('low', ['medium', 'high']) === 'medium');
check('a model with no levels: none', clampEffort('high', []) === '');
check('no effort stays none', clampEffort('', ['low', 'high']) === '');

// pickFromAnswers: the decision model's answers
const answers = (model: string, conf: number, effort: string, newTopic = 0.1): Answers<RouteQuestions> => ({
  model: { type: 'choice', choice: model, probabilities: { [model]: 0.8 }, confidence: conf },
  effort: { type: 'choice', choice: effort, probabilities: { [effort]: 0.6 }, confidence: 0.3 },
  newTopic: { type: 'noul', p: newTopic, yes: newTopic >= 0.5, confidence: Math.abs(2 * newTopic - 1) },
});
check('sure: the pick, its confidence as the reason', same(pickFromAnswers(answers('sonnet', 0.62, 'medium', 0.9)), { model: 'sonnet', effort: 'medium', newTopic: true, reason: '62% sure' }));
check('unsure: no pick (Haiku decides)', pickFromAnswers(answers('opus', ROUTE_MIN_CONFIDENCE - 0.01, 'high')) === null);
check('at the bar: the pick', pickFromAnswers(answers('haiku', ROUTE_MIN_CONFIDENCE, 'low'))?.model === 'haiku');
check('opus gets at least high', pickFromAnswers(answers('opus', 0.7, 'medium'))?.effort === 'high' && pickFromAnswers(answers('opus', 0.7, 'xhigh'))?.effort === 'xhigh');
check('sonnet and haiku keep a low level', pickFromAnswers(answers('sonnet', 0.7, 'low'))?.effort === 'low' && pickFromAnswers(answers('haiku', 0.7, 'low'))?.effort === 'low');
check('new topic from the noul answer', pickFromAnswers(answers('sonnet', 0.7, 'low', 0.2))?.newTopic === false);

// routeMessage: the decision model first, Haiku when it is off, down, slow or unsure
const input: RouteInput = { text: 'rename foo to bar', attachments: 0, title: 'T', turns: 2, current: { model: 'sonnet', effort: 'medium' }, lastReply: 'Done.' };
const haikuPick: HaikuResult = { pick: { model: 'opus', effort: 'high', newTopic: false, reason: 'from haiku' }, raw: '{}', error: '', ms: 5 };
function fakes(result: DecideResult<Questions>) {
  const seen = { haiku: 0, state: '', timeout: 0, questions: [] as string[] };
  const deps: RouteDeps = {
    decide: (async (state: string, q: Questions, o: { timeoutMs?: number }) => {
      seen.state = state;
      seen.timeout = o.timeoutMs ?? 0;
      seen.questions = Object.keys(q);
      return result;
    }) as RouteDeps['decide'],
    haiku: async () => (seen.haiku++, haikuPick),
  };
  return { deps, seen };
}
{
  const { deps, seen } = fakes({ ok: true, answers: answers('haiku', 0.8, 'low', 0.2), model: 'kev', inputTokens: 400, ms: 900 });
  const r = await routeMessage(input, deps);
  check('decision model sure: its pick, no Haiku call', r.engine === 'decision model' && r.pick?.model === 'haiku' && seen.haiku === 0 && r.decision === 'picked', JSON.stringify(r));
  check('the three rubric questions, a short timeout', seen.questions.join() === 'model,effort,newTopic' && seen.timeout === DECIDE_ROUTE_TIMEOUT_MS && DECIDE_ROUTE_TIMEOUT_MS <= 2000);
  check('the state is what Haiku reads', seen.state.includes('Chat title: T') && seen.state.includes('rename foo to bar') && seen.state.includes('sonnet / medium'));
  check('raw keeps the probabilities for the tuning log', JSON.parse(r.raw).by === 'kev' && JSON.parse(r.raw).newTopic === 0.2);
}
{
  const { deps, seen } = fakes({ ok: true, answers: answers('haiku', 0.1, 'low'), model: 'kev', inputTokens: 400, ms: 900 });
  const r = await routeMessage(input, deps);
  check('decision model unsure: Haiku decides', r.engine === 'Haiku' && r.pick?.reason === 'from haiku' && seen.haiku === 1 && r.decision === 'unsure (10%)', JSON.stringify(r));
}
for (const reason of ['off', 'down', 'timeout', 'error'] as const) {
  const { deps, seen } = fakes({ ok: false, reason, error: reason === 'down' ? 'ECONNREFUSED' : '', ms: 1 });
  const r = await routeMessage(input, deps);
  check(`decision model ${reason}: Haiku decides`, r.engine === 'Haiku' && seen.haiku === 1 && r.pick?.model === 'opus' && r.decision.startsWith(reason), JSON.stringify(r));
}
{
  const long = { ...input, text: 'x'.repeat(5000) };
  const { deps, seen } = fakes({ ok: false, reason: 'off', error: '', ms: 0 });
  await routeMessage(long, deps);
  check('a long message is cut shorter for the decision model', seen.state.length < 2500, String(seen.state.length));
}
{
  const { deps } = fakes({ ok: false, reason: 'timeout', error: '', ms: 1500 });
  deps.haiku = async () => ({ pick: null, raw: '', error: 'timeout', ms: 8000 });
  const r = await routeMessage(input, deps);
  check('both fail: no pick, the error kept (the tab keeps its model)', r.pick === null && r.error === 'timeout' && r.engine === 'Haiku');
}

{
  const { deps } = fakes({ ok: true, answers: answers('haiku', 0.8, 'low', 0.2), model: 'kev', inputTokens: 400, ms: 900 });
  const r = await routeMessage(input, { ...deps, decide: null });
  check('no decision model: Haiku alone', r.engine === 'Haiku' && r.pick?.reason === 'from haiku' && r.decision === 'not asked', JSON.stringify(r));
  check('AUTO asks the decision model only with PHOSPHOR_AUTO_DECIDE=on', !autoDecideOn({}) && !autoDecideOn({ PHOSPHOR_AUTO_DECIDE: 'off' }) && autoDecideOn({ PHOSPHOR_AUTO_DECIDE: 'on' }));
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
