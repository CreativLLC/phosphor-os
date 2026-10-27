// Decision model check: speed and accuracy of the engine at PHOSPHOR_DECIDE_URL (default the local decision
// server) on a small hand-made set: AUTO router cases (message -> model, effort, new topic) and punch-list cases
// (a 20-second talk chunk + 8 points -> which points the speaker has started on, by idea, not exact words).
// Only the decision engine is called; nothing is written.
//   npx tsx scripts/decide-bench.ts [runs=7]
import type { NoulQuestion, Questions } from '../shared/decide.ts';
import { ROUTE_QUESTIONS } from '../shared/router.ts';
import { askDecision, decideConfig } from '../server/decide.ts';
import { describe, type RouteInput } from '../server/router.ts';
import { HOME, PIANO, PUNCH, ROUTER, type RouterCase } from '../tests/fixtures/decide-cases.ts';

const RUNS = Math.max(1, Number(process.argv[2]) || 7);

const pointQuestions = (points: string[]): Questions =>
  Object.fromEntries(points.map((p, i): [string, NoulQuestion] => [`p${i}`, { type: 'noul', instructions: `Has the speaker started talking about this point, in any words: "${p}"?` }]));

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fullInput = (i: RouterCase['input']): RouteInput => ({ attachments: 0, title: '', turns: 0, current: null, lastReply: '', ...i });

const cfg = decideConfig();
console.log(`Engine: ${cfg.url}${cfg.model ? ` (${cfg.model})` : ''}\n`);

// Speed: a state of about 300 tokens with one choice question, and the same state with 10 noul questions.
const longState = [PUNCH[1], PUNCH[3], PUNCH[4]].map((c) => c.chunk).join(' ');
const tenNoul = pointQuestions([...HOME, ...PIANO.slice(0, 2)]);
const oneChoice = { model: ROUTE_QUESTIONS.model };
for (const [name, q] of [['1 choice', oneChoice], ['10 noul', tenNoul]] as const) {
  const ms: number[] = [];
  let tokens = 0;
  for (let i = 0; i <= RUNS; i++) {
    const r = await askDecision(longState, q, { timeoutMs: 60000 });
    if (!r.ok) throw new Error(`${name}: ${r.reason} ${r.error}`);
    if (i > 0) ms.push(r.ms); // the first run warms the server up
    tokens = r.inputTokens;
  }
  console.log(`${name}: median ${median(ms)} ms, min ${Math.min(...ms)}, max ${Math.max(...ms)} (${RUNS} runs, ${tokens} input tokens)`);
}

// Router: model, effort, new topic (the last only where the case says). Also the router's own pick rule.
const RANK = ['haiku', 'sonnet', 'opus'];
const EFF = ['low', 'medium', 'high', 'xhigh'];
let mOk = 0, mLow = 0, eOk = 0, eLow = 0, tOk = 0, tN = 0;
const routeMs: number[] = [];
console.log('\nROUTER                                                   want          got (confidence)');
for (const c of ROUTER) {
  const r = await askDecision(describe(fullInput(c.input)), ROUTE_QUESTIONS, { timeoutMs: 60000 });
  if (!r.ok) throw new Error(`router: ${r.reason} ${r.error}`);
  routeMs.push(r.ms);
  const { model, effort, newTopic } = r.answers;
  mOk += +(model.choice === c.model);
  mLow += +(RANK.indexOf(model.choice) < RANK.indexOf(c.model));
  eOk += +(effort.choice === c.effort);
  eLow += +(EFF.indexOf(effort.choice) < EFF.indexOf(c.effort));
  if (c.newTopic !== undefined) (tN++, (tOk += +(newTopic.yes === c.newTopic)));
  const mark = (ok: boolean) => (ok ? ' ' : '*');
  console.log(
    `${c.input.text.slice(0, 55).padEnd(56)} ${`${c.model}/${c.effort}`.padEnd(13)} ${mark(model.choice === c.model)}${model.choice} (${model.confidence.toFixed(2)}) ${mark(effort.choice === c.effort)}${effort.choice} (${effort.confidence.toFixed(2)})` +
      (c.newTopic !== undefined ? ` ${mark(newTopic.yes === c.newTopic)}new=${newTopic.p.toFixed(2)}` : ''),
  );
}
const n = ROUTER.length;
console.log(`model ${mOk}/${n} (too low ${mLow}), effort ${eOk}/${n} (too low ${eLow}), new topic ${tOk}/${tN}; median ${median(routeMs)} ms`);

// Punch list: every point is one noul question; a point counts as started at p >= 0.5 (other cut-offs below).
let tp = 0, fp = 0, fn = 0, exact = 0;
const punchMs: number[] = [];
const cuts = [0.3, 0.4, 0.5, 0.6].map((cut) => ({ cut, right: 0 }));
for (const c of PUNCH) {
  const r = await askDecision(c.chunk, pointQuestions(c.points), { timeoutMs: 60000 });
  if (!r.ok) throw new Error(`punch: ${r.reason} ${r.error}`);
  punchMs.push(r.ms);
  const got = c.points.map((_, i) => (r.answers[`p${i}`] as { yes: boolean }).yes);
  const want = c.points.map((_, i) => c.started.includes(i));
  got.forEach((g, i) => (g && want[i] ? tp++ : g ? fp++ : want[i] ? fn++ : 0));
  for (const k of cuts) k.right += c.points.filter((_, i) => ((r.answers[`p${i}`] as { p: number }).p >= k.cut) === want[i]).length;
  exact += +got.every((g, i) => g === want[i]);
  const ps = c.points.map((_, i) => (r.answers[`p${i}`] as { p: number }).p.toFixed(2)).join(' ');
  console.log(`${got.every((g, i) => g === want[i]) ? ' ' : '*'} want [${c.started.join(',')}] got [${got.flatMap((g, i) => (g ? [i] : [])).join(',')}]  p: ${ps}`);
}
const total = PUNCH.length * 8;
console.log(`punch list: ${total - fp - fn}/${total} points right, ${tp} of ${tp + fn} started found, ${fp} false alarms, ${exact}/${PUNCH.length} chunks exact; median ${median(punchMs)} ms`);
console.log(`points right by cut-off: ${cuts.map((k) => `${k.cut}: ${k.right}`).join(', ')}`);
