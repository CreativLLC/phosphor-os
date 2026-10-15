// AUTO router: reading Haiku's answer and the stickiness rule (shared/router.ts). Pure, nothing is asked of a model.
//   npm run test:router        (= npx tsx tests/router.ts)

import { clampEffort, decide, parsePick, type RoutePick } from '../shared/router.ts';

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

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
