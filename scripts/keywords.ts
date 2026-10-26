// YouTube keyword check from the command line (docs/KEYWORDS.md). Claude runs this; the run is saved in
// data/keywords/ like a run from the KEYWORDS screen, so it shows there too.
//   npx tsx scripts/keywords.ts "home assistant" "self hosted ai" [--region US] [--json]
//   npx tsx scripts/keywords.ts --suggest "home assistant"     (autocomplete ideas only)
import { KEYWORDS_MAX_TERMS, type KeywordResult } from '../shared/keywords.ts';
import { cleanTerm, startRun, suggest } from '../server/keywords.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const asJson = args.includes('--json');
if (asJson) args.splice(args.indexOf('--json'), 1);
const region = flag('--region')?.toUpperCase();
const seed = flag('--suggest');

const fmt = (n: number | null) => (n === null ? '-' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));

if (seed !== undefined) {
  const q = cleanTerm(seed);
  const list = [...new Set([...(await suggest(q, region)), ...(await suggest(q + ' ', region))])].filter((s) => s !== q);
  console.log(asJson ? JSON.stringify(list, null, 1) : list.join('\n'));
  process.exit(0);
}

if (!args.length) {
  console.error(`usage: npx tsx scripts/keywords.ts "term" ["term" ...] (max ${KEYWORDS_MAX_TERMS}) [--region US] [--json] | --suggest "seed"`);
  process.exit(2);
}

const { run, done } = startRun(args, {
  region,
  by: 'claude',
  onProgress: (r) => { if (!asJson) process.stderr.write(`checked ${r.done}/${r.terms.length}: ${r.terms[r.done - 1]}\n`); },
});
if (!asJson) process.stderr.write(`run ${run.id}: ${run.terms.length} terms\n`);
const r = await done;
if (asJson) {
  console.log(JSON.stringify(r, null, 1));
} else {
  if (r.error) console.log(`FAILED: ${r.error}`);
  const row = (x: KeywordResult) =>
    [x.score, x.demand, x.competition, x.verdict.padEnd(10), fmt(x.signals.medianViews).padStart(6), fmt(x.signals.medianSubs).padStart(6),
      x.signals.trends ?? '-', x.term].join('\t');
  console.log(['SCORE', 'DEMAND', 'COMP', 'VERDICT   ', 'VIEWS', 'SUBS', 'TRENDS', 'TERM'].join('\t'));
  for (const x of r.results) console.log(row(x));
  for (const x of r.results) {
    console.log(`\n${x.term.toUpperCase()}  (score ${x.score})`);
    for (const w of x.why) console.log(`  - ${w}`);
    if (x.related.length) console.log(`  related: ${x.related.join(' | ')}`);
    if (x.tags.length) console.log(`  tags: ${x.tags.slice(0, 10).join(', ')}`);
    for (const v of x.top.slice(0, 5)) console.log(`  top: ${fmt(v.views)} views, ${fmt(v.subs)} subs, ${v.ageDays ?? '?'}d  ${v.title}  [${v.channel}]`);
  }
  console.log(`\nsaved: data/keywords/${r.id}.json`);
}
