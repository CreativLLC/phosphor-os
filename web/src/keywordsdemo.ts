import type { KeywordResult, KeywordRun, KeywordRunSummary, KeywordVerdict, KeywordVideo } from '../../shared/keywords.ts';

// Fake data for KEYWORDS in demo mode (/?demo=1): no real API call is made. Numbers are made up but move together
// the way real ones do (high demand and low competition give a high score).

const now = Date.now();
const MIN = 60_000;
const TERM_MS = 1200; // a new run finishes one term this often

// Terms with chosen numbers: [demand, competition]. Other terms get numbers from a hash of the word.
const PROFILES: Record<string, [number, number]> = {
  'learn piano': [72, 96],
  'piano for beginners': [81, 71],
  'piano chords app': [58, 34],
  'piano lesson for adults': [63, 41],
  'easy piano songs': [90, 77],
  'how to read sheet music fast': [52, 22],
  'slow piano practice trick': [24, 12],
  'left hand piano exercises': [47, 28],
  'make ai videos': [74, 55],
  'ai video editor free': [69, 61],
  'claude code tutorial': [66, 24],
  'claude code for beginners': [80, 14],
};

const hash = (s: string): number => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};
const rnd = (seed: string, lo: number, hi: number) => lo + (hash(seed) % 1000) / 1000 * (hi - lo);

const verdictOf = (demand: number, score: number): KeywordVerdict => (demand < 25 ? 'low demand' : score >= 75 ? 'great' : score >= 60 ? 'good' : score >= 45 ? 'ok' : 'hard');

const CHANNELS = ['Maple Studio', 'Quiet Fox', 'North Bay Tutorials', 'Daily Spark', 'The Practice Room', 'Lena Makes', 'Orbit Learning', 'Tinker Hub'];
const TITLES = [
  (t: string) => `${t}: the complete guide`,
  (t: string) => `I tried ${t} for 30 days`,
  (t: string) => `${t} in 10 minutes`,
  (t: string) => `Stop doing ${t} wrong`,
  (t: string) => `${t} for total beginners (2026)`,
  (t: string) => `Why ${t} is easier than you think`,
];

function videos(term: string, demand: number, competition: number): KeywordVideo[] {
  return Array.from({ length: 8 }, (_, i): KeywordVideo => {
    const seed = `${term}/${i}`;
    const subs = Math.round(10 ** rnd(`${seed}s`, 3.2, 3.9 + competition / 40));
    const views = Math.round(10 ** rnd(`${seed}v`, 3.4, 4 + demand / 30));
    const ageDays = Math.round(rnd(`${seed}a`, 12, 1100));
    const exact = i < 5 && hash(`${seed}e`) % 4 !== 0;
    const t = term.replace(/^./, (c) => c.toUpperCase());
    return {
      id: hash(seed).toString(36).padStart(11, 'x').slice(0, 11),
      title: exact ? TITLES[i % TITLES.length](t) : `${CHANNELS[i % CHANNELS.length]} live: ${term.split(' ')[0]} tips`,
      channel: CHANNELS[(hash(term) + i) % CHANNELS.length],
      subs: i === 6 ? null : subs,
      views,
      ageDays,
      viewsPerDay: Math.round((views / Math.max(1, ageDays)) * 10) / 10,
      exactTitle: exact,
    };
  });
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

function result(term: string): KeywordResult {
  const [demand, competition] = PROFILES[term] ?? [Math.round(rnd(`${term}d`, 15, 90)), Math.round(rnd(`${term}c`, 10, 90))];
  const score = Math.round(demand * 0.55 + (100 - competition) * 0.45);
  const top = videos(term, demand, competition);
  const exactShare = top.filter((v) => v.exactTitle).length / top.length;
  const small = top.filter((v) => v.subs !== null && v.subs < 50_000 && v.views > v.subs).length;
  const rank = demand > 60 ? 1 + (hash(term) % 3) : demand > 40 ? 4 + (hash(term) % 4) : null;
  const why = [
    rank ? `YouTube offers this search when you type it (place ${rank}).` : 'YouTube does not offer this exact search while you type.',
    demand >= 60 ? 'Many people look for it.' : demand >= 35 ? 'A fair number of people look for it.' : 'Few people look for it.',
    small >= 3 ? `${small} of the top ${top.length} videos come from small channels and still beat their subscriber count.` : 'Most top videos come from big channels.',
    exactShare >= 0.6 ? 'Most top titles hold all the words: a clear title is not enough to stand out.' : 'Few top titles hold all the words: there is room for a title that does.',
  ];
  return {
    term,
    demand,
    competition,
    score,
    verdict: verdictOf(demand, score),
    why,
    signals: {
      inSuggest: rank !== null,
      suggestRank: rank,
      longTail: Math.round(rnd(`${term}l`, 1, 10)),
      trends: demand > 20 ? Math.min(100, demand + Math.round(rnd(`${term}t`, -10, 12))) : null,
      results: Math.round(10 ** rnd(`${term}r`, 4.3, 6.4)),
      medianViews: median(top.map((v) => v.views)),
      medianSubs: median(top.flatMap((v) => (v.subs === null ? [] : [v.subs]))),
      medianAgeDays: median(top.map((v) => v.ageDays ?? 0)),
      medianViewsPerDay: median(top.map((v) => v.viewsPerDay ?? 0)),
      exactTitleShare: exactShare,
      smallChannelWins: small,
    },
    top,
    related: [`${term} for kids`, `${term} 2026`, `${term} free`, `best ${term}`, `${term} step by step`].slice(0, 3 + (hash(term) % 3)),
    tags: [term, term.split(' ')[0], 'tutorial', 'how to', 'beginner', 'tips'].slice(0, 4 + (hash(term) % 3)),
  };
}

function makeRun(id: string, at: number, by: KeywordRun['by'], terms: string[]): KeywordRun {
  const results = terms.map(result).sort((a, b) => b.score - a.score);
  return { id, at, endedAt: at + terms.length * TERM_MS, state: 'done', by, region: 'US', terms, done: terms.length, results };
}

const runs: KeywordRun[] = [
  makeRun('demo-run-1', now - 25 * MIN, 'screen', ['learn piano', 'piano for beginners', 'piano chords app', 'piano lesson for adults', 'easy piano songs']),
  makeRun('demo-run-2', now - 5 * 3600_000, 'claude', ['claude code tutorial', 'claude code for beginners', 'make ai videos', 'ai video editor free']),
  makeRun('demo-run-3', now - 2 * 86400_000, 'screen', ['how to read sheet music fast', 'slow piano practice trick', 'left hand piano exercises']),
];

const summary = (r: KeywordRun): KeywordRunSummary => {
  const best = r.results[0];
  return { id: r.id, at: r.at, state: r.state, by: r.by, terms: r.terms, best: best ? { term: best.term, score: best.score } : null };
};

// A started demo run shows progress for a few seconds, then its results.
function view(r: KeywordRun): KeywordRun {
  const done = Math.min(r.terms.length, Math.floor((Date.now() - r.at) / TERM_MS));
  if (done >= r.terms.length) return r;
  return { ...r, state: 'running', endedAt: 0, done, results: [] };
}

export function demoKeywordsApi<T>(path: string, method: string, body?: unknown): Promise<T> {
  const reply = (v: unknown) => new Promise<T>((ok) => setTimeout(() => ok(v as T), 150));
  if (path === 'runs' && method === 'POST') {
    const terms = (body as { terms: string[] }).terms;
    const id = `demo-run-${Date.now().toString(36)}`;
    runs.unshift(makeRun(id, Date.now(), 'screen', terms));
    return reply({ id });
  }
  if (path === 'runs') return reply({ runs: runs.map((r) => summary(view(r))) });
  if (path.startsWith('runs/')) {
    const i = runs.findIndex((r) => r.id === path.slice(5));
    if (i < 0) return Promise.reject(new Error('That run is gone.'));
    if (method === 'DELETE') {
      runs.splice(i, 1);
      return reply({ ok: true });
    }
    return reply(view(runs[i]));
  }
  if (path.startsWith('suggest')) {
    const q = new URLSearchParams(path.slice(path.indexOf('?'))).get('q')?.trim().toLowerCase() ?? '';
    return reply({ suggestions: ['for beginners', 'tutorial', 'free', 'app', 'songs', 'for kids', 'at home', '2026'].map((s) => `${q} ${s}`) });
  }
  return Promise.reject(new Error('Not found.'));
}
