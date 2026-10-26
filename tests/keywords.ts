// YouTube keyword check (server/keywords.ts): parsers, scores and the endpoint's checks. No network.
//   npx tsx tests/keywords.ts

import { createServer } from 'node:http';
import type { KeywordSignals } from '../shared/keywords.ts';
import { handleKeywords, parseAge, parseSearch, parseTerms, scoreTerm } from '../server/keywords.ts';

let pass = 0;
let fail = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${g}\n  want ${w}`);
  }
};

eq('age: days', parseAge('3 days ago'), 3);
eq('age: short form', parseAge('1d ago'), 1);
eq('age: years', parseAge('2 years ago'), 730);
eq('age: streamed', parseAge('Streamed 1 month ago'), 30);
eq('age: short months', parseAge('5mo ago'), 152);
eq('age: none', parseAge('LIVE'), null);

eq('terms: split, trim, lower, dedupe', parseTerms('Home  Assistant, local AI\nhome assistant\n\n'), ['home assistant', 'local ai']);
eq('terms: array', parseTerms([' A ', 'b']), ['a', 'b']);

const vr = (id: string, views: string, age: string) => ({
  videoRenderer: { videoId: id, title: { runs: [{ text: `Video ${id}` }] }, ownerText: { runs: [{ text: 'Chan' }] }, viewCountText: { simpleText: views }, publishedTimeText: { simpleText: age } },
});
const page = `<script>var ytInitialData = ${JSON.stringify({
  estimatedResults: '7009876',
  contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [vr('a', '1,234 views', '2 days ago'), { gridShelfViewModel: {} }, vr('b', '83,864 views', '1y ago')] } },
    { continuationItemRenderer: {} },
  ] } } } },
})};</script>`;
const parsed = parseSearch(page);
eq('search: result count', parsed.results, 7009876);
eq('search: videos in order, shelves skipped', parsed.videos.map((v) => [v.id, v.views, v.ageDays]), [['a', 1234, 2], ['b', 83864, 365]]);
let threw = false;
try { parseSearch('<html></html>'); } catch { threw = true; }
eq('search: changed page throws', threw, true);

const base: KeywordSignals = {
  inSuggest: true, suggestRank: 1, longTail: 10, trends: null, results: 1_000_000, medianViews: 50_000, medianSubs: 50_000,
  medianAgeDays: 200, medianViewsPerDay: 1000, exactTitleShare: 0.5, smallChannelWins: 0,
};
const s = (o: Partial<KeywordSignals>, ratio = 0.5) => scoreTerm('home assistant', { ...base, ...o }, ratio, false);
eq('score: suggested earlier = more demand', s({}, 0.4).demand > s({}, 0.9).demand, true);
eq('score: not suggested = less demand', s({ inSuggest: false }, 1.2).demand < s({}).demand, true);
eq('score: bigger channels = more competition', s({ medianSubs: 2_000_000 }).competition > s({ medianSubs: 5_000 }).competition, true);
eq('score: small channels winning = less competition', s({ smallChannelWins: 5 }).competition < s({}).competition, true);
eq('score: competition lowers the score', s({ medianSubs: 2_000_000, exactTitleShare: 1 }).score < s({}).score, true);
eq('score: nothing searched = low demand verdict', s({ inSuggest: false, longTail: 0, medianViewsPerDay: 2 }, 1.2).verdict, 'low demand');
eq('score: all in 0-100', [s({}).demand, s({}).competition, s({}).score].every((n) => n >= 0 && n <= 100), true);
eq('score: why lines', s({}).why.length >= 5, true);

const srv = createServer((req, res) => void handleKeywords(req, res, new URL(req.url!, 'http://x')));
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const port = (srv.address() as { port: number }).port;
const call = async (path: string, init?: RequestInit) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
  return [r.status, await r.json()] as const;
};
eq('api: list answers', (await call('/api/keywords/runs'))[0], 200);
eq('api: no terms = 400', (await call('/api/keywords/runs', { method: 'POST', body: JSON.stringify({ terms: [] }) }))[0], 400);
eq('api: too many terms = 400', (await call('/api/keywords/runs', { method: 'POST', body: JSON.stringify({ terms: Array.from({ length: 11 }, (_, i) => `t${i}`) }) }))[0], 400);
eq('api: bad id = 404', (await call('/api/keywords/runs/../../etc'))[0], 404);
eq('api: unknown run = 404', (await call('/api/keywords/runs/20990101-000000-abcd'))[0], 404);
eq('api: empty suggest', (await call('/api/keywords/suggest?q='))[1], { suggestions: [] });
srv.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
