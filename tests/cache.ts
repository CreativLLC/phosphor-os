// Prompt cache clock (shared/cache.ts). Plain functions, no browser.
//   npx tsx tests/cache.ts

import { cacheEnding, cacheLeft, cacheShort, TTL_1H, TTL_5M, ttlFromUsage } from '../shared/cache.ts';

let pass = 0;
let fail = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (got === want) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
};

const MIN = 60_000;

eq('1 h write', ttlFromUsage({ cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 } }, 0), TTL_1H);
eq('5 min write', ttlFromUsage({ cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 500 } }, TTL_1H), TTL_5M);
eq('both: 1 h wins', ttlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 10 } }, 0), TTL_1H);
eq('read only keeps last', ttlFromUsage({ cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } }, TTL_1H), TTL_1H);
eq('read only, none known: 5 min', ttlFromUsage({ cache_read_input_tokens: 9000 }, 0), TTL_5M);
eq('no breakdown write: 5 min', ttlFromUsage({ cache_creation_input_tokens: 300 }, 0), TTL_5M);
eq('no cache at all (local model)', ttlFromUsage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, TTL_1H), 0);
eq('nulls', ttlFromUsage({ cache_read_input_tokens: null, cache_creation: null }, 0), 0);

const now = 1_000_000_000;
eq('no reply yet', cacheLeft({ cacheAt: null, cacheTtlMs: TTL_1H }, now), null);
eq('no cache', cacheLeft({ cacheAt: now, cacheTtlMs: 0 }, now), null);
eq('just called', cacheLeft({ cacheAt: now, cacheTtlMs: TTL_1H }, now), TTL_1H);
eq('22 min ago', cacheLeft({ cacheAt: now - 22 * MIN, cacheTtlMs: TTL_1H }, now), 38 * MIN);
eq('cold', cacheLeft({ cacheAt: now - 3 * TTL_1H, cacheTtlMs: TTL_1H }, now), 0);
eq('clock ahead', cacheLeft({ cacheAt: now + 5000, cacheTtlMs: TTL_5M }, now), TTL_5M + 5000);

eq('short 60', cacheShort(TTL_1H), '60M');
eq('short rounds up', cacheShort(37 * MIN + 1), '38M');
eq('short under a minute', cacheShort(20_000), '<1M');
eq('short cold', cacheShort(0), 'COLD');

eq('1 h: 6 min left not ending', cacheEnding(6 * MIN, TTL_1H), false);
eq('1 h: 5 min left ending', cacheEnding(5 * MIN, TTL_1H), true);
eq('5 min: 2 min left not ending', cacheEnding(2 * MIN, TTL_5M), false);
eq('5 min: 1 min left ending', cacheEnding(MIN, TTL_5M), true);
eq('cold is not ending', cacheEnding(0, TTL_1H), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
