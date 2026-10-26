import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  KEYWORDS_MAX_TERMS, type KeywordResult, type KeywordRun, type KeywordRunSummary, type KeywordSignals, type KeywordVerdict, type KeywordVideo,
} from '../shared/keywords.ts';
import { DATA_DIR } from './config.ts';

// YouTube keyword check (docs/KEYWORDS.md). No API key: YouTube's autocomplete, its search page, yt-dlp for the top
// videos' channel sizes and tags, and Google Trends (YouTube search) for a relative score. YouTube does not publish
// search counts, so demand and competition are estimates built from those signals.
// Used by the server (KEYWORDS screen) and by scripts/keywords.ts (Claude); both save runs in data/keywords/.

export const KEYWORDS_DIR = join(DATA_DIR, 'keywords');
const CACHE_DIR = join(KEYWORDS_DIR, '.cache');
const CACHE_MS = 24 * 3600_000;
const TOP = 10; // videos looked at closely per term
const STALE_MS = 15 * 60_000; // a "running" run untouched this long died with its process
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const run = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
// log10 of n mapped so lo -> 0 and hi -> 100
const logScale = (n: number, lo: number, hi: number) => clamp(((Math.log10(Math.max(n, 1)) - lo) / (hi - lo)) * 100);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
export const cleanTerm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);

async function get(url: string, timeout = 15_000): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.text();
}

// ---- YouTube autocomplete ----

export async function suggest(q: string, region = 'US'): Promise<string[]> {
  const u = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=en&gl=${region}&q=${encodeURIComponent(q)}`;
  const data = JSON.parse(await get(u, 8000));
  return Array.isArray(data?.[1]) ? data[1].map((s: unknown) => cleanTerm(String(s))) : [];
}

// How early autocomplete offers the term: the fewest letters typed (as a share of the whole term) after which it
// shows up. Popular searches show up after a few letters.
async function suggestReach(term: string, region: string) {
  const full = await suggest(term, region);
  const at = full.indexOf(term);
  const inSuggest = at >= 0;
  let ratio = inSuggest ? 1 : 1.2;
  if (inSuggest) {
    for (const f of [0.35, 0.5, 0.7, 0.85]) {
      const n = Math.max(2, Math.round(term.length * f));
      if (n >= term.length) continue;
      await sleep(120);
      if ((await suggest(term.slice(0, n), region)).includes(term)) { ratio = n / term.length; break; }
    }
  }
  await sleep(120);
  const related = (await suggest(term + ' ', region)).filter((s) => s !== term && s.startsWith(term));
  return { inSuggest, suggestRank: inSuggest ? at + 1 : null, ratio, related };
}

// ---- YouTube search page ----

interface Found { id: string; title: string; channel: string; views: number; ageDays: number | null }

const AGE_UNITS: Record<string, number> = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30.4, year: 365 };
export function parseAge(text: string): number | null {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year|mo|s|m|h|d|w|y)\w*\s+ago/i.exec(text);
  if (!m) return null;
  const short: Record<string, string> = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' };
  const unit = AGE_UNITS[m[2].toLowerCase()] ?? AGE_UNITS[short[m[2].toLowerCase()]];
  return unit === undefined ? null : Math.round(Number(m[1]) * unit);
}
const num = (s: string | undefined) => Number((s ?? '').replace(/[^\d]/g, '')) || 0;
const text = (t: any): string => t?.simpleText ?? t?.runs?.map((r: any) => r.text).join('') ?? '';

export function parseSearch(html: string): { results: number | null; videos: Found[] } {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html);
  if (!m) throw new Error('YouTube search page changed (no ytInitialData)');
  const d = JSON.parse(m[1]);
  const sections = d?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  const videos: Found[] = [];
  for (const s of sections) {
    for (const item of s?.itemSectionRenderer?.contents ?? []) {
      const v = item?.videoRenderer;
      if (!v?.videoId) continue;
      videos.push({
        id: v.videoId,
        title: text(v.title),
        channel: text(v.ownerText) || text(v.longBylineText),
        views: num(text(v.viewCountText)),
        ageDays: parseAge(text(v.publishedTimeText)),
      });
    }
  }
  const est = Number(d?.estimatedResults);
  return { results: Number.isFinite(est) && est > 0 ? est : null, videos };
}

async function search(term: string, region: string) {
  const u = `https://www.youtube.com/results?search_query=${encodeURIComponent(term)}&hl=en&gl=${region}&sp=EgIQAQ%253D%253D`; // videos only
  return parseSearch(await get(u));
}

// ---- yt-dlp: channel size, exact upload day and tags of one video ----

interface Detail { subs: number | null; ageDays: number | null; views: number | null; tags: string[] }
const ytdlpMissing = { checked: false, missing: false };

async function detail(id: string): Promise<Detail | null> {
  if (ytdlpMissing.missing) return null;
  try {
    const { stdout } = await run('yt-dlp', ['-J', '--skip-download', '--no-warnings', '--no-playlist', `https://www.youtube.com/watch?v=${id}`],
      { timeout: 40_000, maxBuffer: 64 * 1024 * 1024 });
    const j = JSON.parse(stdout);
    const up = /^(\d{4})(\d{2})(\d{2})$/.exec(j.upload_date ?? '');
    const ageDays = up ? Math.max(0, Math.round((Date.now() - Date.UTC(+up[1], +up[2] - 1, +up[3])) / 86400_000)) : null;
    return {
      subs: typeof j.channel_follower_count === 'number' ? j.channel_follower_count : null,
      ageDays,
      views: typeof j.view_count === 'number' ? j.view_count : null,
      tags: Array.isArray(j.tags) ? j.tags.map((t: unknown) => cleanTerm(String(t))).filter(Boolean) : [],
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') ytdlpMissing.missing = true;
    return null;
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// ---- Google Trends (YouTube search), relative 0-100 ----

// Trends compares at most 5 terms at once, so with more terms every batch carries the first term as an anchor and
// is scaled to it. Any failure (Trends often answers 429) leaves trends null; the other signals still work.
export async function trends(terms: string[], region = 'US'): Promise<Map<string, number> | null> {
  try {
    const home = await fetch(`https://trends.google.com/?geo=${region}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    const cookie = (home.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const hdr = { 'User-Agent': UA, Cookie: cookie };
    const avg = async (batch: string[]) => {
      const req = { comparisonItem: batch.map((k) => ({ keyword: k, geo: region, time: 'today 12-m' })), category: 0, property: 'youtube' };
      const q = (o: Record<string, string>) => new URLSearchParams({ hl: 'en-US', tz: '0', ...o }).toString();
      const r1 = await fetch(`https://trends.google.com/trends/api/explore?${q({ req: JSON.stringify(req) })}`, { headers: hdr, signal: AbortSignal.timeout(15_000) });
      if (!r1.ok) throw new Error(`trends ${r1.status}`);
      const w = JSON.parse((await r1.text()).slice(5)).widgets.find((x: any) => x.id === 'TIMESERIES');
      const r2 = await fetch(`https://trends.google.com/trends/api/widgetdata/multiline?${q({ req: JSON.stringify(w.request), token: w.token })}`,
        { headers: hdr, signal: AbortSignal.timeout(15_000) });
      if (!r2.ok) throw new Error(`trends ${r2.status}`);
      const rows: any[] = JSON.parse((await r2.text()).slice(5)).default.timelineData;
      return batch.map((_, i) => rows.reduce((s, r) => s + (r.value?.[i] ?? 0), 0) / Math.max(rows.length, 1));
    };
    const raw = new Map<string, number>();
    if (terms.length <= 5) {
      (await avg(terms)).forEach((v, i) => raw.set(terms[i], v));
    } else {
      const anchor = terms[0];
      for (let i = 1; i < terms.length; i += 4) {
        const batch = [anchor, ...terms.slice(i, i + 4)];
        const v = await avg(batch);
        if (!raw.has(anchor)) raw.set(anchor, v[0]);
        const scale = v[0] > 0 ? raw.get(anchor)! / v[0] : 1;
        batch.slice(1).forEach((t, j) => raw.set(t, v[j + 1] * scale));
        await sleep(1500);
      }
    }
    const max = Math.max(...raw.values());
    if (!(max > 0)) return new Map(terms.map((t) => [t, 0]));
    return new Map([...raw].map(([t, v]) => [t, Math.round((v / max) * 100)]));
  } catch {
    return null;
  }
}

// ---- one term ----

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));

export function scoreTerm(term: string, s: KeywordSignals, suggestRatio: number, trendsKnown: boolean): Pick<KeywordResult, 'demand' | 'competition' | 'score' | 'verdict' | 'why'> {
  const why: string[] = [];
  // Demand: how early autocomplete offers it, how many longer searches build on it, how fast its videos get views,
  // and Trends when it answered.
  const reach = s.inSuggest ? clamp(35 + (65 * (1 - suggestRatio)) / 0.65) : 0;
  const tail = clamp(s.longTail * 10);
  const pace = s.medianViewsPerDay === null ? 0 : logScale(s.medianViewsPerDay, 0.5, 4); // ~3/day -> 0, 10K/day -> 100
  const parts: [number, number][] = [[reach, 0.4], [tail, 0.15], [pace, 0.3]];
  if (trendsKnown && s.trends !== null) parts.push([s.trends, 0.15]);
  const wsum = parts.reduce((a, [, w]) => a + w, 0);
  const demand = Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / wsum);

  if (!s.inSuggest) why.push('YouTube does not suggest this exact search');
  else if (suggestRatio < 1) why.push(`YouTube suggests it after typing ${Math.round(suggestRatio * term.length)} of ${term.length} letters`);
  else why.push('YouTube suggests it only once it is typed in full');
  if (s.longTail) why.push(`${s.longTail} longer searches build on it`);
  if (s.medianViewsPerDay !== null) why.push(`Top videos from the last 2 years get about ${fmt(s.medianViewsPerDay)} views a day`);
  if (trendsKnown && s.trends !== null) why.push(`Google Trends: ${s.trends} of 100 next to the other terms in this check`);

  // Competition: channel size, how many top videos aim at the exact words, their views, how fresh they are, and
  // the total result count. Small channels that win here pull it down.
  const subs = s.medianSubs === null ? 50 : logScale(s.medianSubs, 3, 6.3); // 1K -> 0, 2M -> 100
  const exact = s.exactTitleShare * 100;
  const views = logScale(s.medianViews, 3, 6.3);
  const results = s.results === null ? 50 : logScale(s.results, 3, 7.5);
  let competition = subs * 0.3 + exact * 0.25 + views * 0.25 + results * 0.2 - s.smallChannelWins * 4;
  competition = Math.round(clamp(competition));
  if (s.medianSubs !== null) why.push(`Top channels have about ${fmt(s.medianSubs)} subscribers (median)`);
  why.push(`${Math.round(s.exactTitleShare * TOP)} of ${TOP} top videos use these words in the title`);
  why.push(`Top videos have about ${fmt(s.medianViews)} views (median)`);
  if (s.smallChannelWins) why.push(`${s.smallChannelWins} small channel${s.smallChannelWins > 1 ? 's' : ''} (under 50K subscribers) rank here with more views than subscribers`);

  const score = Math.round(demand * (1 - 0.75 * (competition / 100)));
  const verdict: KeywordVerdict = demand < 25 ? 'low demand' : score >= 55 ? 'great' : score >= 42 ? 'good' : score >= 30 ? 'ok' : 'hard';
  return { demand, competition, score, verdict, why };
}

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const file = join(CACHE_DIR, createHash('sha1').update(key).digest('hex').slice(0, 20) + '.json');
  try {
    if (Date.now() - statSync(file).mtimeMs < CACHE_MS) return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch { /* not cached */ }
  const v = await fn();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(v));
  return v;
}

type Raw = Omit<KeywordResult, 'demand' | 'competition' | 'score' | 'verdict' | 'why' | 'signals'> & {
  signals: Omit<KeywordSignals, 'trends'>; ratio: number;
};

async function checkTerm(term: string, region: string): Promise<Raw> {
  return cached(`v1|${region}|${term}`, async () => {
    const reach = await suggestReach(term, region);
    const found = await search(term, region);
    const top = found.videos.slice(0, TOP);
    const details = await pool(top, 4, (v) => detail(v.id));
    const want = words(term);
    const videos: KeywordVideo[] = top.map((v, i) => {
      const d = details[i];
      const ageDays = d?.ageDays ?? v.ageDays;
      const views = d?.views ?? v.views;
      const t = new Set(words(v.title));
      return {
        id: v.id, title: v.title, channel: v.channel, subs: d?.subs ?? null, views, ageDays,
        viewsPerDay: ageDays === null ? null : Math.round(views / Math.max(ageDays, 1)),
        exactTitle: want.every((w) => t.has(w)),
      };
    });
    const tagCount = new Map<string, number>();
    for (const d of details) for (const t of new Set(d?.tags ?? [])) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const recent = videos.filter((v) => v.ageDays !== null && v.ageDays <= 730 && v.viewsPerDay !== null);
    const subs = videos.map((v) => v.subs).filter((n): n is number => n !== null);
    return {
      term,
      top: videos,
      related: reach.related,
      tags: [...tagCount].filter(([t]) => t !== term).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t),
      ratio: reach.ratio,
      signals: {
        inSuggest: reach.inSuggest,
        suggestRank: reach.suggestRank,
        longTail: reach.related.length,
        results: found.results,
        medianViews: median(videos.map((v) => v.views)) ?? 0,
        medianSubs: median(subs),
        medianAgeDays: median(videos.map((v) => v.ageDays).filter((n): n is number => n !== null)),
        medianViewsPerDay: median(recent.map((v) => v.viewsPerDay!)),
        exactTitleShare: videos.length ? videos.filter((v) => v.exactTitle).length / videos.length : 0,
        smallChannelWins: videos.filter((v) => v.subs !== null && v.subs < 50_000 && v.views > v.subs).length,
      },
    };
  });
}

// ---- runs (saved as data/keywords/<id>.json) ----

const newId = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(2).toString('hex')}`;
};
const fileOf = (id: string) => join(KEYWORDS_DIR, `${id}.json`);
const validId = (id: string) => /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(id);

function save(r: KeywordRun): void {
  mkdirSync(KEYWORDS_DIR, { recursive: true });
  const tmp = fileOf(r.id) + '.tmp';
  writeFileSync(tmp, JSON.stringify({ schema: 1, ...r }, null, 1));
  renameSync(tmp, fileOf(r.id));
}

export function readRun(id: string): KeywordRun | null {
  if (!validId(id)) return null;
  try {
    const r = JSON.parse(readFileSync(fileOf(id), 'utf8')) as KeywordRun & { schema?: number };
    delete r.schema;
    if (r.state === 'running' && !active.has(id) && Date.now() - statSync(fileOf(id)).mtimeMs > STALE_MS) {
      r.state = 'failed';
      r.error = 'stopped before it finished';
    }
    return r;
  } catch {
    return null;
  }
}

export function listRuns(): KeywordRunSummary[] {
  if (!existsSync(KEYWORDS_DIR)) return [];
  return readdirSync(KEYWORDS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readRun(f.slice(0, -5)))
    .filter((r): r is KeywordRun => r !== null)
    .sort((a, b) => b.at - a.at)
    .map((r) => ({ id: r.id, at: r.at, state: r.state, by: r.by, terms: r.terms, best: r.results[0] ? { term: r.results[0].term, score: r.results[0].score } : null }));
}

const active = new Set<string>();

export function parseTerms(input: unknown): string[] {
  const list = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[\n,]/);
  return [...new Set(list.map(cleanTerm).filter(Boolean))];
}

// Starts a run and returns it at once; `done` resolves with the finished run. Terms are checked one after another
// (polite to YouTube); progress is saved after each one so the screen can show it.
export function startRun(termsIn: string[], opts: { region?: string; by: KeywordRun['by']; onProgress?: (r: KeywordRun) => void }): { run: KeywordRun; done: Promise<KeywordRun> } {
  const terms = parseTerms(termsIn);
  if (!terms.length) throw new Error('no search terms');
  if (terms.length > KEYWORDS_MAX_TERMS) throw new Error(`at most ${KEYWORDS_MAX_TERMS} terms at once`);
  const region = /^[A-Z]{2}$/.test(opts.region ?? '') ? opts.region! : 'US';
  const r: KeywordRun = { id: newId(), at: Date.now(), endedAt: 0, state: 'running', by: opts.by, region, terms, done: 0, results: [] };
  active.add(r.id);
  save(r);
  const done = (async () => {
    try {
      const raws: Raw[] = [];
      for (const term of terms) {
        try {
          raws.push(await checkTerm(term, region));
        } catch (e) {
          raws.push({ term, top: [], related: [], tags: [], ratio: 1.2, error: e instanceof Error ? e.message : String(e),
            signals: { inSuggest: false, suggestRank: null, longTail: 0, results: null, medianViews: 0, medianSubs: null, medianAgeDays: null, medianViewsPerDay: null, exactTitleShare: 0, smallChannelWins: 0 } });
        }
        r.done++;
        r.results = raws.map((x) => finish(x, null));
        save(r);
        opts.onProgress?.(r);
      }
      const tr = terms.length > 1 ? await trends(terms, region) : null;
      r.results = raws.map((x) => finish(x, tr)).sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || b.score - a.score);
      r.state = 'done';
    } catch (e) {
      r.state = 'failed';
      r.error = e instanceof Error ? e.message : String(e);
    }
    r.endedAt = Date.now();
    active.delete(r.id);
    save(r);
    return r;
  })();
  return { run: r, done };
}

function finish(x: Raw, tr: Map<string, number> | null): KeywordResult {
  const { ratio, ...rest } = x;
  const signals: KeywordSignals = { ...x.signals, trends: tr?.get(x.term) ?? null };
  if (x.error) return { ...rest, signals, demand: 0, competition: 0, score: 0, verdict: 'low demand', why: [`Could not check: ${x.error}`] };
  return { ...rest, signals, ...scoreTerm(x.term, signals, ratio, tr !== null) };
}

// ---- HTTP (server/index.ts) ----

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 64 * 1024) req.destroy(new Error('too big')); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new Error('bad JSON')); } });
    req.on('error', no);
  });
}

export async function handleKeywords(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/api/keywords/suggest' && req.method === 'GET') {
    const q = cleanTerm(url.searchParams.get('q') ?? '');
    if (!q) return json(res, { suggestions: [] });
    return json(res, { suggestions: [...new Set([...(await suggest(q)), ...(await suggest(q + ' '))])].filter((s) => s !== q) });
  }
  if (path === '/api/keywords/runs') {
    if (req.method === 'GET') return json(res, { runs: listRuns() });
    if (req.method === 'POST') {
      const b = await body(req);
      try {
        const { run: r } = startRun(parseTerms(b.terms), { region: typeof b.region === 'string' ? b.region : undefined, by: 'screen' });
        return json(res, { id: r.id });
      } catch (e) {
        return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
      }
    }
  }
  const m = /^\/api\/keywords\/runs\/([^/]+)$/.exec(path);
  if (m) {
    const r = readRun(m[1]);
    if (!r) return json(res, { error: 'not found' }, 404);
    if (req.method === 'GET') return json(res, r);
    if (req.method === 'DELETE') {
      if (active.has(r.id)) return json(res, { error: 'still running' }, 409);
      rmSync(fileOf(r.id), { force: true });
      return json(res, { ok: true });
    }
  }
  return json(res, { error: 'not found' }, 404);
}
