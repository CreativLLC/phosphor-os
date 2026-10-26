import './keywords.css';
import { KEYWORDS_MAX_TERMS, type KeywordResult, type KeywordRun, type KeywordRunSummary } from '../../shared/keywords.ts';
import { closeDocs, isDocsOpen, onDocsToggle } from './docs.ts';
import { closeLab, isLabOpen, onLabToggle } from './lab.ts';
import { demoKeywordsApi } from './keywordsdemo.ts';
import { store } from './store.ts';
import { button, confirmBox, el, toast } from './ui.ts';

// KEYWORDS (docs/KEYWORDS.md): check YouTube search terms. The server does the work (autocomplete, search results,
// Google Trends) and saves each run; this file sends the terms, shows progress and results, and lists past runs.
// Runs Claude starts from the command line show in HISTORY too (the list refreshes while this screen is open).
// Open straight to a screen with ?keys=check | history | <run id> (&keysopen=<n>: unfold result n).

type View = 'check' | 'history';

const POLL_MS = 1500;
const HISTORY_MS = 10_000;

let rootEl: HTMLElement | null = null;
let topBtn: HTMLElement | null = null;
let isOpen = false;
let pendingBack = 0;
let view: View = 'check';
const toggles = new Set<() => void>();

let checkBox: HTMLElement;
let historyBox: HTMLElement;
let nav: HTMLElement;
let input: HTMLTextAreaElement;
let countEl: HTMLElement;
let checkBtn: HTMLButtonElement;
let seedInput: HTMLInputElement;
let suggestBox: HTMLElement;
let statusBox: HTMLElement;
let resultBox: HTMLElement;
let historyList: HTMLElement;

let current: KeywordRun | null = null; // the run on screen
let token = 0; // changes when another run is opened, so an old poll stops
let pollTimer = 0;
let historyTimer = 0;
let runList: KeywordRunSummary[] | null = null;
let historyKey = '';
let runKey = '';
const unfolded = new Set<string>(); // terms whose details are open
let openAfterLoad = -1; // ?keysopen=<n>

// ------------------------------------------------------------ public

export function mountKeywords(btn: HTMLElement | null): void {
  topBtn = btn;
  if (btn) btn.onclick = () => (isOpen ? closeKeywords() : openKeywords());
  // Going to a chat leaves KEYWORDS, like DOCS and LAB.
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tab-label, .tab-add')) closeKeywords();
  });
  document.getElementById('history')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.history-row')) closeKeywords();
  });
  onDocsToggle(() => {
    if (isDocsOpen()) closeKeywords(true); // DOCS pushed its own back-button entry
  });
  onLabToggle(() => {
    if (isLabOpen()) closeKeywords(true);
  });
  addEventListener('popstate', () => {
    if (pendingBack > 0) {
      pendingBack--;
      return;
    }
    if (isOpen && (window.history.state as { phosphorKeys?: boolean } | null)?.phosphorKeys !== true) closeKeywords(true);
  });
  const start = new URLSearchParams(location.search).get('keys');
  if (start !== null) {
    const n = new URLSearchParams(location.search).get('keysopen');
    if (n) openAfterLoad = Number(n);
    if (!start || start === 'check') openKeywords();
    else if (start === 'history') openKeywords('history');
    else {
      openKeywords();
      openRun(start);
    }
  }
}

export const isKeywordsOpen = (): boolean => isOpen;

export function onKeywordsToggle(fn: () => void): void {
  toggles.add(fn);
}

export function openKeywords(v?: View): void {
  build();
  if (v) view = v;
  if (!isOpen) {
    const fromOther = isDocsOpen() || isLabOpen();
    if (isDocsOpen()) closeDocs(true); // reuse their back-button entry
    if (isLabOpen()) closeLab(true);
    isOpen = true;
    rootEl!.hidden = false;
    document.body.classList.add('keys-open');
    topBtn?.classList.add('on');
    try {
      if (fromOther) window.history.replaceState({ phosphorKeys: true }, '');
      else window.history.pushState({ phosphorKeys: true }, '');
    } catch {
      /* fine without the back button */
    }
    historyTimer = window.setInterval(() => void refreshHistory(), HISTORY_MS);
    if (current?.state === 'running') void poll(current.id, token);
    for (const fn of toggles) fn();
  }
  showView();
  void refreshHistory();
}

export function closeKeywords(fromPop = false): void {
  if (!isOpen || !rootEl) return;
  isOpen = false;
  rootEl.hidden = true;
  document.body.classList.remove('keys-open');
  topBtn?.classList.remove('on');
  clearInterval(historyTimer);
  clearTimeout(pollTimer);
  token++; // stops a poll that is waiting for the server
  if (!fromPop && (window.history.state as { phosphorKeys?: boolean } | null)?.phosphorKeys) {
    pendingBack++;
    window.history.back();
  }
  for (const fn of toggles) fn();
}

export const keywordsCommands = [
  { id: 'keywords', label: 'KEYWORDS', hint: 'Check YouTube search terms: demand and competition', keywords: ['keys', 'youtube', 'seo', 'search', 'terms', 'video', 'idea'], run: () => openKeywords('check') },
  { id: 'keywords-history', label: 'KEYWORD HISTORY', hint: 'Past keyword checks', keywords: ['keys', 'youtube', 'runs', 'past'], run: () => openKeywords('history') },
];

// ------------------------------------------------------------ server

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (isDemo()) return demoKeywordsApi<T>(path, method, body);
  const r = await fetch(`/api/keywords/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `The server said ${r.status}.`);
  return data;
}

// Demo mode is decided after the mounts, but a deep link can open this screen before that.
const isDemo = () => store.demo || new URLSearchParams(location.search).has('demo');

const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 6000);

// ------------------------------------------------------------ helpers

const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e5) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n >= 100 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1);
}

function fmtAge(days: number | null | undefined): string {
  if (days === null || days === undefined) return '-';
  if (days < 1) return 'today';
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 700) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

const slug = (v: string) => v.replace(' ', '-');

// Search terms in the box: one per line or comma separated; empty ones and repeats dropped.
function parseTerms(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

function addTerm(term: string): void {
  const have = parseTerms(input.value);
  if (have.some((t) => t.toLowerCase() === term.toLowerCase())) return void toast('That term is in the box.', 1800);
  if (have.length >= KEYWORDS_MAX_TERMS) return void toast(`The most is ${KEYWORDS_MAX_TERMS} terms per check.`);
  input.value = `${have.join('\n')}${have.length ? '\n' : ''}${term}`;
  updateCount();
  toast(`Added: ${term}`, 1500);
}

function updateCount(): void {
  const n = parseTerms(input.value).length;
  countEl.textContent = `${n} / ${KEYWORDS_MAX_TERMS} TERMS`;
  countEl.classList.toggle('keys-over', n > KEYWORDS_MAX_TERMS);
  checkBtn.disabled = n === 0 || n > KEYWORDS_MAX_TERMS || current?.state === 'running';
}

// ------------------------------------------------------------ frame

function build(): void {
  if (rootEl) return;
  const root = el('section', 'keys');
  rootEl = root;
  root.hidden = true;
  root.setAttribute('aria-label', 'KEYWORDS');
  const bar = el('div', 'keys-bar');
  nav = el('nav', 'keys-nav');
  for (const [label, v] of [['CHECK', 'check'], ['HISTORY', 'history']] as const) {
    const b = button(label, () => {
      view = v;
      showView();
      if (v === 'history') void refreshHistory();
    });
    b.dataset.v = v;
    nav.append(b);
  }
  bar.append(el('span', 'keys-tag', 'KEYWORD CHECK'), nav);
  const main = el('div', 'keys-main');

  // CHECK
  checkBox = el('div', 'keys-check');
  const note = el('p', 'keys-note', 'Scores are estimates from YouTube autocomplete, search results and Google Trends. There are no exact monthly numbers.');

  input = el('textarea', 'keys-input');
  input.rows = 5;
  input.placeholder = 'One search term per line, or separated by commas.\nExample: easy piano songs';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Search terms');
  input.oninput = updateCount;
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void startCheck();
    }
  };
  countEl = el('span', 'keys-count');
  checkBtn = button('CHECK', () => void startCheck(), 'primary keys-go');
  const goRow = el('div', 'keys-row');
  goRow.append(checkBtn, countEl, el('span', 'keys-dim keys-hint', 'Ctrl+Enter also starts it.'));

  const sug = el('div', 'keys-suggest');
  seedInput = el('input', 'keys-seed');
  seedInput.placeholder = 'A first word, for ideas';
  seedInput.setAttribute('aria-label', 'Seed word');
  seedInput.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') void suggest();
  };
  const sugRow = el('div', 'keys-row');
  sugRow.append(el('span', 'keys-label', 'SUGGEST'), seedInput, button('FIND IDEAS', () => void suggest()));
  suggestBox = el('div', 'keys-chips');
  sug.append(sugRow, suggestBox);

  statusBox = el('div', 'keys-status');
  resultBox = el('div', 'keys-results');
  checkBox.append(note, input, goRow, sug, statusBox, resultBox);

  // HISTORY
  historyBox = el('div', 'keys-hist');
  historyList = el('div', 'keys-hist-list');
  historyBox.append(el('p', 'keys-note', 'Past checks, newest first. Checks that Claude starts from the command line show here too.'), historyList);

  main.append(checkBox, historyBox);
  root.append(bar, main);
  document.body.append(root);
  updateCount();
  renderRun();
  renderHistory();
}

function showView(): void {
  for (const b of nav.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.v === view);
  checkBox.hidden = view !== 'check';
  historyBox.hidden = view !== 'history';
}

// ------------------------------------------------------------ check

async function startCheck(): Promise<void> {
  const terms = parseTerms(input.value);
  if (!terms.length) return void toast('Type at least one search term.');
  if (terms.length > KEYWORDS_MAX_TERMS) return void toast(`The most is ${KEYWORDS_MAX_TERMS} terms per check.`);
  checkBtn.disabled = true;
  try {
    const { id } = await api<{ id: string }>('runs', 'POST', { terms });
    loadRun(id);
    void refreshHistory();
  } catch (e) {
    fail(e);
    updateCount();
  }
}

// Show one run: fetch it now and again every 1.5 s while it runs.
function loadRun(id: string): void {
  token++;
  clearTimeout(pollTimer);
  current = null;
  runKey = '';
  unfolded.clear();
  statusBox.replaceChildren(el('p', 'keys-dim', 'LOADING…'));
  resultBox.replaceChildren();
  void poll(id, token, true);
}

function openRun(id: string): void {
  view = 'check';
  showView();
  loadRun(id);
}

async function poll(id: string, mine: number, first = false): Promise<void> {
  let errors = 0;
  for (;;) {
    if (mine !== token || !isOpen) return;
    try {
      const run = await api<KeywordRun>(`runs/${encodeURIComponent(id)}`);
      if (mine !== token || !isOpen) return;
      errors = 0;
      current = run;
      renderRun();
      if (first && run.state !== 'running' && openAfterLoad >= 0) {
        const t = run.results[openAfterLoad];
        openAfterLoad = -1;
        if (t) {
          unfolded.add(t.term);
          renderRun(true);
        }
      }
      first = false;
      if (run.state !== 'running') {
        void refreshHistory();
        return;
      }
    } catch (e) {
      if (mine !== token) return;
      if (++errors >= 3) {
        statusBox.replaceChildren(el('p', 'keys-err', e instanceof Error ? e.message : String(e)));
        current = null;
        updateCount();
        return;
      }
    }
    await new Promise<void>((ok) => (pollTimer = window.setTimeout(ok, POLL_MS)));
  }
}

function renderRun(force = false): void {
  const run = current;
  if (!run) {
    statusBox.replaceChildren();
    resultBox.replaceChildren();
    updateCount();
    return;
  }
  // Redraw only when something changed, so an open row and the scroll place stay.
  const key = JSON.stringify([run.id, run.state, run.done, run.results.length, run.error]);
  if (key === runKey && !force) return;
  runKey = key;

  const info = el('div', 'keys-meta');
  info.append(el('span', '', fmtTime(run.at)), el('span', '', `BY ${run.by === 'claude' ? 'CLAUDE' : 'SCREEN'}`), el('span', '', `${run.terms.length} TERM${run.terms.length === 1 ? '' : 'S'}`));
  const parts: HTMLElement[] = [info];
  if (run.state === 'running') {
    const bar = el('div', 'keys-bar-track');
    const fill = el('div', 'keys-bar-fill');
    fill.style.width = `${run.terms.length ? Math.round((run.done / run.terms.length) * 100) : 0}%`;
    bar.append(fill);
    parts.push(el('p', 'keys-busy', `CHECKING ${run.done} / ${run.terms.length}`), bar);
  } else if (run.state === 'failed') {
    parts.push(el('p', 'keys-err', `THE CHECK FAILED. ${run.error ?? ''}`.trim()));
  }
  statusBox.replaceChildren(...parts);
  resultBox.replaceChildren(...(run.results.length ? [resultTable(run.results)] : []));
  updateCount();
}

// ------------------------------------------------------------ results

function resultTable(results: KeywordResult[]): HTMLElement {
  const sorted = [...results].sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || b.score - a.score);
  const wrap = el('div', 'keys-table-wrap');
  const tb = el('table', 'keys-table');
  const head = el('tr');
  for (const [label, cls] of [['TERM', ''], ['SCORE', 'keys-num'], ['DEMAND', 'keys-num'], ['COMPETITION', 'keys-num'], ['VERDICT', ''], ['MEDIAN VIEWS', 'keys-num'], ['YT RESULTS', 'keys-num']]) head.append(el('th', cls, label));
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  for (const r of sorted) {
    const open = unfolded.has(r.term);
    const row = el('tr', `keys-row-main${open ? ' open' : ''}`);
    row.tabIndex = 0;
    const detail = el('tr', 'keys-detail-row');
    detail.hidden = !open;
    const dcell = el('td');
    dcell.colSpan = 7;
    dcell.append(detailView(r));
    detail.append(dcell);
    const toggle = () => {
      const opening = !row.classList.contains('open');
      detail.hidden = !opening;
      row.classList.toggle('open', opening);
      if (opening) unfolded.add(r.term);
      else unfolded.delete(r.term);
    };
    row.onclick = toggle;
    row.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    };
    row.append(cell(r.term, 'keys-term', ''));
    if (r.error) {
      const c = cell(`COULD NOT CHECK: ${r.error}`, 'keys-err keys-span', '');
      c.colSpan = 6;
      row.append(c);
    } else {
      const sc = cell('', `keys-num keys-score v-${slug(r.verdict)}`, 'SCORE');
      const bar = el('span', 'keys-mini');
      const fill = el('span');
      fill.style.width = `${Math.max(0, Math.min(100, r.score))}%`;
      bar.append(fill);
      sc.append(el('b', '', String(Math.round(r.score))), bar);
      row.append(
        sc,
        cell(String(Math.round(r.demand)), 'keys-num', 'DEMAND'),
        cell(String(Math.round(r.competition)), 'keys-num', 'COMPETITION'),
        cell(r.verdict.toUpperCase(), `keys-verdict v-${slug(r.verdict)}`, 'VERDICT'),
        cell(fmtNum(r.signals.medianViews), 'keys-num', 'MEDIAN VIEWS'),
        cell(fmtNum(r.signals.results), 'keys-num', 'YT RESULTS'),
      );
    }
    body.append(row, detail);
  }
  tb.append(thead, body);
  wrap.append(tb);
  return wrap;
}

function cell(text: string, cls: string, label: string): HTMLTableCellElement {
  const c = el('td', cls, text);
  if (label) c.dataset.l = label;
  return c;
}

function detailView(r: KeywordResult): HTMLElement {
  const box = el('div', 'keys-detail');
  if (r.error) {
    box.append(el('p', 'keys-err', r.error));
    return box;
  }
  const sec = (title: string, ...kids: (Node | string)[]) => {
    const s = el('section', 'keys-sec');
    s.append(el('h3', '', title), ...kids);
    box.append(s);
    return s;
  };

  if (r.why.length) {
    const ul = el('ul', 'keys-why');
    for (const w of r.why) ul.append(el('li', '', w));
    sec('WHY', ul);
  }

  const s = r.signals;
  const facts: [string, string][] = [
    ['In YouTube autocomplete', s.inSuggest ? `YES${s.suggestRank ? `, place ${s.suggestRank}` : ''}` : 'NO'],
    ['Longer searches known', String(s.longTail)],
    ['Google Trends (0-100)', s.trends === null ? 'no data' : String(Math.round(s.trends))],
    ['YouTube results', fmtNum(s.results)],
    ['Median views', fmtNum(s.medianViews)],
    ['Median channel subs', fmtNum(s.medianSubs)],
    ['Median video age', fmtAge(s.medianAgeDays)],
    ['Median views per day', fmtNum(s.medianViewsPerDay)],
    ['Titles with every word', `${Math.round(s.exactTitleShare * 100)}%`],
    ['Small channels that win', String(s.smallChannelWins)],
  ];
  const grid = el('dl', 'keys-facts');
  for (const [k, v] of facts) grid.append(el('dt', '', k), el('dd', '', v));
  sec('SIGNALS', grid);

  if (r.top.length) {
    const wrap = el('div', 'keys-table-wrap keys-vids');
    const t = el('table', 'keys-vtable');
    const h = el('tr');
    for (const [label, cls] of [['VIDEO', ''], ['CHANNEL', ''], ['SUBS', 'keys-num'], ['VIEWS', 'keys-num'], ['AGE', 'keys-num'], ['VIEWS/DAY', 'keys-num']]) h.append(el('th', cls, label));
    const thead = el('thead');
    thead.append(h);
    const tb = el('tbody');
    for (const v of r.top) {
      const tr = el('tr');
      const title = el('td', 'keys-vtitle');
      const a = el('a', 'keys-link', v.title);
      a.href = `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      title.append(a);
      if (v.exactTitle) {
        const tag = el('span', 'keys-exact', 'EXACT');
        tag.title = 'The title holds every word of the term.';
        title.append(' ', tag);
      }
      const c = (text: string, cls: string, l: string) => cell(text, cls, l);
      tr.append(title, c(v.channel, 'keys-vchan', 'CHANNEL'), c(fmtNum(v.subs), 'keys-num', 'SUBS'), c(fmtNum(v.views), 'keys-num', 'VIEWS'), c(fmtAge(v.ageDays), 'keys-num', 'AGE'), c(fmtNum(v.viewsPerDay), 'keys-num', 'VIEWS/DAY'));
      tb.append(tr);
    }
    t.append(thead, tb);
    wrap.append(t);
    sec('TOP VIDEOS', wrap);
  }

  if (r.related.length) {
    const chips = el('div', 'keys-chips');
    for (const t of r.related) chips.append(button(`+ ${t}`, () => addTerm(t), 'keys-chip'));
    sec('RELATED SEARCHES (TAP TO ADD)', chips);
  }

  if (r.tags.length) {
    const tags = el('div', 'keys-tags');
    for (const t of r.tags) tags.append(el('span', 'keys-tag-item', t));
    sec('TAGS', tags);
  }
  return box;
}

// ------------------------------------------------------------ suggest

async function suggest(): Promise<void> {
  const q = seedInput.value.trim();
  if (!q) return void seedInput.focus();
  suggestBox.replaceChildren(el('span', 'keys-dim', 'LOOKING…'));
  try {
    const { suggestions } = await api<{ suggestions: string[] }>(`suggest?q=${encodeURIComponent(q)}`);
    if (!suggestions.length) return void suggestBox.replaceChildren(el('span', 'keys-dim', 'NO IDEAS FOR THAT WORD.'));
    suggestBox.replaceChildren(...suggestions.map((s) => button(`+ ${s}`, () => addTerm(s), 'keys-chip')));
  } catch (e) {
    suggestBox.replaceChildren();
    fail(e);
  }
}

// ------------------------------------------------------------ history

async function refreshHistory(): Promise<void> {
  if (!isOpen) return;
  try {
    const { runs } = await api<{ runs: KeywordRunSummary[] }>('runs');
    runList = runs;
    const key = JSON.stringify(runs);
    if (key !== historyKey) {
      historyKey = key;
      renderHistory();
    }
  } catch (e) {
    if (runList === null) historyList.replaceChildren(el('p', 'keys-empty', e instanceof Error ? e.message : String(e)));
  }
}

function renderHistory(): void {
  if (!runList) return void historyList.replaceChildren(el('p', 'keys-empty', 'LOADING…'));
  if (!runList.length) return void historyList.replaceChildren(el('p', 'keys-empty', 'NO CHECKS YET.'));
  const wrap = el('div', 'keys-table-wrap');
  const tb = el('table', 'keys-table keys-htable');
  const head = el('tr');
  for (const label of ['TIME', 'TERMS', 'BEST', 'BY', '']) head.append(el('th', '', label));
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  for (const r of runList) {
    const row = el('tr', 'keys-row-main');
    row.tabIndex = 0;
    row.onclick = () => openRun(r.id);
    row.onkeydown = (e) => {
      if (e.key === 'Enter') openRun(r.id);
    };
    const best = r.state === 'running' ? 'RUNNING…' : r.state === 'failed' && !r.best ? 'FAILED' : r.best ? `${r.best.term}  ${Math.round(r.best.score)}` : '-';
    const del = button('DELETE', () => void removeRun(r), 'keys-del');
    del.onclick = (e) => {
      e.stopPropagation();
      void removeRun(r);
    };
    const delCell = el('td', 'keys-actions');
    delCell.append(del);
    row.append(
      cell(fmtTime(r.at), 'keys-nowrap', 'TIME'),
      cell(r.terms.join(', '), 'keys-clip', 'TERMS'),
      cell(best, r.state === 'failed' ? 'keys-err keys-best' : 'keys-strong keys-best', 'BEST'),
      cell(r.by === 'claude' ? 'CLAUDE' : 'SCREEN', 'keys-nowrap', 'BY'),
      delCell,
    );
    body.append(row);
  }
  tb.append(thead, body);
  wrap.append(tb);
  historyList.replaceChildren(wrap);
}

async function removeRun(r: KeywordRunSummary): Promise<void> {
  const ok = await confirmBox('DELETE THIS CHECK?', `${r.terms.length} term${r.terms.length === 1 ? '' : 's'}: ${r.terms.slice(0, 3).join(', ')}${r.terms.length > 3 ? '…' : ''}. It is deleted for good.`, 'DELETE');
  if (!ok) return;
  try {
    await api(`runs/${encodeURIComponent(r.id)}`, 'DELETE');
    if (current?.id === r.id) {
      token++;
      clearTimeout(pollTimer);
      current = null;
      runKey = '';
      renderRun();
    }
    historyKey = '';
    await refreshHistory();
  } catch (e) {
    fail(e);
  }
}
