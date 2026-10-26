// YouTube keyword check (docs/KEYWORDS.md): what the server, the CLI and the KEYWORDS screen send each other.
// A run checks 1-10 search terms; it is saved as data/keywords/<id>.json with the same fields plus `schema`.

export const KEYWORDS_MAX_TERMS = 10;

export type KeywordVerdict = 'great' | 'good' | 'ok' | 'hard' | 'low demand';
export type KeywordRunState = 'running' | 'done' | 'failed';

export interface KeywordVideo {
  id: string;
  title: string;
  channel: string;
  subs: number | null; // channel subscribers (null = unknown)
  views: number;
  ageDays: number | null; // days since upload (null = unknown)
  viewsPerDay: number | null;
  exactTitle: boolean; // the title holds every word of the term
}

export interface KeywordSignals {
  inSuggest: boolean; // YouTube's own autocomplete offers this exact term
  suggestRank: number | null; // its place in that list (1 = first)
  longTail: number; // how many longer searches autocomplete knows that start with the term
  trends: number | null; // Google Trends (YouTube search), 0-100 relative to the other terms in the run; null = no data
  results: number | null; // YouTube's "about N results" for the term
  medianViews: number; // of the top videos
  medianSubs: number | null; // of their channels
  medianAgeDays: number | null;
  medianViewsPerDay: number | null;
  exactTitleShare: number; // 0-1, top videos whose title holds every word of the term
  smallChannelWins: number; // top videos from channels under 50K subscribers with more views than subscribers
}

export interface KeywordResult {
  term: string;
  demand: number; // 0-100, how much people look for it (estimate)
  competition: number; // 0-100, how hard it is to show up (estimate)
  score: number; // 0-100, demand high + competition low
  verdict: KeywordVerdict;
  why: string[]; // short plain lines behind the scores
  signals: KeywordSignals;
  top: KeywordVideo[]; // the top results, in YouTube's order
  related: string[]; // autocomplete searches that start with the term
  tags: string[]; // tags the top videos use most, most used first
  error?: string; // set when this term could not be checked
}

export interface KeywordRun {
  id: string; // yyyymmdd-hhmmss-xxxx
  at: number; // start, ms since epoch
  endedAt: number; // 0 while running
  state: KeywordRunState;
  by: 'screen' | 'claude'; // who started it (the CLI is Claude)
  region: string; // two-letter country, e.g. US
  terms: string[];
  done: number; // terms finished so far
  results: KeywordResult[]; // best score first once done
  error?: string;
}

export interface KeywordRunSummary {
  id: string;
  at: number;
  state: KeywordRunState;
  by: KeywordRun['by'];
  terms: string[];
  best: { term: string; score: number } | null;
}

// POST /api/keywords/runs        {terms, region?}  -> {id}            (starts a run; poll it)
// GET  /api/keywords/runs                          -> {runs: KeywordRunSummary[]} newest first
// GET  /api/keywords/runs/<id>                     -> KeywordRun
// DELETE /api/keywords/runs/<id>                   -> {ok: true}
// GET  /api/keywords/suggest?q=<seed>              -> {suggestions: string[]}  (autocomplete, quick)
export interface KeywordStartRequest {
  terms: string[];
  region?: string;
}
