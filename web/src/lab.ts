import './lab.css';
import { LAB_MAX_MODELS, LAB_TIME_LIMITS, type LabModel, type LabModelsResponse, type LabResult, type LabResultFull, type LabStorage, type LabTest, type LabTestFull } from '../../shared/lab.ts';
import { closeDocs, isDocsOpen, onDocsToggle } from './docs.ts';
import { button, confirmBox, el, toast } from './ui.ts';
import { useDictation } from './voice.ts';

// LAB (docs/MODEL-LAB.md): one prompt to many AI models, each in its own app inside a locked box (server/labrun.ts).
// Results are folders on the PC (server/lab.ts); this file only shows them, rates them and starts new tests.
// Open straight to a screen with ?lab=new | history | archive | <test id> (&labview=table | video, &labopen=<n>).

type View = { kind: 'new' } | { kind: 'history' } | { kind: 'archive' } | { kind: 'test'; id: string };
type SortKey = 'date' | 'test' | 'models' | 'stars' | 'model' | 'time' | 'tokens';

let rootEl: HTMLElement | null = null;
let main: HTMLElement;
let nav: HTMLElement;
let topBtn: HTMLElement | null = null;
let isOpen = false;
let pendingBack = 0;
let poll = 0;
let ticker = 0;
let view: View = { kind: 'history' };
const toggles = new Set<() => void>();

let models: LabModelsResponse | null = null;
let current: LabTestFull | null = null; // the open test
const filt = { q: '', model: '', app: '', range: 'all', minStars: 0, rows: 'tests' as 'tests' | 'results', sort: 'date' as SortKey, dir: -1 };
let testMode: 'cards' | 'table' | 'rank' = 'cards';
let video = false;
let releaseDictation: (() => void) | null = null; // NEW TEST borrows DICTATE for its prompt
let openAfterLoad = -1; // ?labopen=<n>: show result n full screen once the test loads
const PICKED_KEY = 'phosphor.lab.picked';
const draft = { title: '', prompt: '', picked: new Set<string>(JSON.parse(localStorage.getItem(PICKED_KEY) ?? '[]') as string[]), limit: 30, blind: false, filter: '' };

const LETTERS = 'ABCDEFGHIJKLMNOP';
const RANGES: [string, string, number][] = [['30d', '30 DAYS', 30], ['90d', '90 DAYS', 90], ['1y', '1 YEAR', 366], ['all', 'ALL', Infinity]];
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-pointer-lock'; // same as the server's header

// ------------------------------------------------------------ public

export function mountLab(btn: HTMLElement | null): void {
  topBtn = btn;
  if (btn) btn.onclick = () => (isOpen ? closeLab() : openLab());
  // Going to a chat leaves LAB, like DOCS.
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tab-label, .tab-add')) closeLab();
  });
  document.getElementById('history')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.history-row')) closeLab();
  });
  onDocsToggle(() => {
    if (isDocsOpen()) closeLab(true); // DOCS pushed its own back-button entry
  });
  addEventListener('popstate', () => {
    if (pendingBack > 0) {
      pendingBack--;
      return;
    }
    if (document.querySelector('.lab-full')) return void closeFull(); // back closes the full-screen view first
    if (isOpen && (history.state as { phosphorLab?: boolean } | null)?.phosphorLab !== true) closeLab(true);
  });
  const q = new URLSearchParams(location.search);
  const start = q.get('lab');
  if (start !== null) {
    if (q.get('labview') === 'table') testMode = 'table';
    if (q.get('labview') === 'video') video = true;
    if (q.get('labopen')) openAfterLoad = Number(q.get('labopen'));
    openLab(start === 'new' || start === 'archive' ? { kind: start } : !start || start === 'history' ? { kind: 'history' } : { kind: 'test', id: start });
  }
}

export const isLabOpen = (): boolean => isOpen;

export function onLabToggle(fn: () => void): void {
  toggles.add(fn);
}

export function openLab(v?: View): void {
  build();
  if (v) view = v;
  if (!isOpen) {
    const fromDocs = isDocsOpen();
    if (fromDocs) closeDocs(true); // reuse DOCS's back-button entry
    isOpen = true;
    rootEl!.hidden = false;
    document.body.classList.add('lab-open');
    topBtn?.classList.add('on');
    try {
      if (fromDocs) history.replaceState({ phosphorLab: true }, '');
      else history.pushState({ phosphorLab: true }, '');
    } catch {
      /* fine without the back button */
    }
    ticker = window.setInterval(tickClocks, 1000);
    for (const fn of toggles) fn();
  }
  render();
}

export function closeLab(fromPop = false): void {
  if (!isOpen || !rootEl) return;
  isOpen = false;
  video = false;
  rootEl.hidden = true;
  document.body.classList.remove('lab-open');
  topBtn?.classList.remove('on');
  clearInterval(ticker);
  clearTimeout(poll);
  releaseDictation?.();
  releaseDictation = null;
  closeFull(true);
  for (const d of document.querySelectorAll<HTMLDialogElement>('dialog.lab-box')) d.remove();
  if (!fromPop && (history.state as { phosphorLab?: boolean } | null)?.phosphorLab) {
    pendingBack++;
    history.back();
  }
  for (const fn of toggles) fn();
}

export const labCommands = [
  { id: 'lab', label: 'LAB', hint: 'One prompt, many AI models: compare and rate', keywords: ['model', 'models', 'compare', 'test', 'arena', 'benchmark', 'rate'], run: () => openLab() },
  { id: 'lab-new', label: 'NEW LAB TEST', hint: 'Send a prompt to many AI models', keywords: ['lab', 'models', 'compare', 'prompt'], run: () => openLab({ kind: 'new' }) },
];

// ------------------------------------------------------------ server

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(`/api/lab/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `The server said ${r.status}.`);
  return data;
}

const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 6000);

// ------------------------------------------------------------ frame

function build(): void {
  if (rootEl) return;
  const root = el('section', 'lab');
  rootEl = root;
  root.hidden = true;
  root.setAttribute('aria-label', 'LAB');
  const bar = el('div', 'lab-bar');
  nav = el('nav', 'lab-nav');
  const tab = (label: string, kind: 'new' | 'history' | 'archive') => {
    const b = button(label, () => go({ kind }));
    b.dataset.v = kind;
    return b;
  };
  nav.append(tab('+ NEW TEST', 'new'), tab('HISTORY', 'history'), tab('ARCHIVE', 'archive'));
  bar.append(el('span', 'lab-tag', 'MODEL LAB'), nav);
  main = el('div', 'lab-main');
  root.append(bar, main);
  document.body.append(root);
}

function go(v: View): void {
  view = v;
  if (v.kind !== 'test') video = false;
  render();
  main.scrollTop = 0;
}

function render(): void {
  if (!rootEl) return;
  clearTimeout(poll);
  releaseDictation?.();
  releaseDictation = null;
  for (const b of nav.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.v === view.kind || (view.kind === 'test' && b.dataset.v === (current?.archived ? 'archive' : 'history')));
  rootEl.classList.toggle('lab-video', view.kind === 'test' && video);
  const v = view;
  const box = el('div', `lab-${v.kind}`);
  box.append(el('p', 'lab-empty', 'LOADING…'));
  main.replaceChildren(box);
  const fill = v.kind === 'new' ? newView : v.kind === 'archive' ? archiveView : v.kind === 'test' ? () => testView(v.id) : historyView;
  void fill()
    .then((node) => {
      if (view === v) box.replaceWith(node);
    })
    .catch((e) => {
      if (view !== v) return;
      box.replaceChildren(el('p', 'lab-empty', e instanceof Error ? e.message : String(e)));
    });
}

// ------------------------------------------------------------ helpers

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtTime = (ms: number) => new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtBytes = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);
const fmtMoney = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(4)}`);
const costText = (r: LabResult) => (r.value === null ? 'PLAN' : `PLAN (≈${fmtMoney(r.value)})`);
const costTip = 'Runs on your plan. In brackets: what the same run would cost at API prices, when the app reports it.';
const runMs = (r: LabResult) => (r.state === 'running' ? Date.now() - r.startedAt : r.startedAt && r.endedAt ? r.endedAt - r.startedAt : 0);
const isBlind = (t: LabTest | LabTestFull) => t.blind && !t.revealed;
const nameOf = (t: LabTest | LabTestFull, i: number) => (isBlind(t) ? `MODEL ${LETTERS[i]}` : t.results[i].modelName);
const appOf = (t: LabTest | LabTestFull, i: number) => (isBlind(t) ? 'hidden until you rate or rank them all' : `${t.results[i].appName} · ${t.results[i].account}`);
const topStars = (t: LabTest | LabTestFull) => Math.max(0, ...t.results.map((r) => r.stars));
// The best: the owner's #1 once they ranked, else the most stars (ties all count).
const isWinner = (t: LabTest | LabTestFull, r: LabResult) => (t.results.some((x) => x.rank > 0) ? r.rank === 1 : r.stars > 0 && r.stars === topStars(t));
// REVEAL: once nothing runs and every finished result has stars, or every one has a place in the ranking.
const canReveal = (t: LabTest | LabTestFull) => {
  const done = t.results.filter((r) => r.state === 'done');
  return !t.results.some(busy) && (done.every((r) => r.stars > 0) || done.every((r) => r.rank > 0));
};
const rated = (t: LabTest) => t.results.filter((r) => r.stars > 0);
const avgStars = (rs: LabResult[]) => (rs.length ? rs.reduce((a, r) => a + r.stars, 0) / rs.length : 0);
const busy = (r: LabResult) => r.state === 'running' || r.state === 'queued';
const working = (r: LabResultFull) => busy(r) || r.build === 'building'; // keep polling while true
const pageUrl = (t: LabTestFull, r: LabResultFull, path = r.page) => `${t.view}${encodeURIComponent(r.dir)}/${path.split('/').map(encodeURIComponent).join('/')}?v=${r.endedAt}`;

function stateLabel(r: LabResult): string {
  if (r.state === 'running') return `RUNNING ${fmtClock(runMs(r))}`;
  if (r.state === 'queued') return 'WAITING';
  if (r.state === 'done') return `${r.timeUp ? 'TIME UP' : 'DONE'} ${fmtClock(runMs(r))}`;
  return r.state === 'limit' ? 'PLAN LIMIT' : r.state === 'stopped' ? 'STOPPED' : 'FAILED';
}

function starText(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function summary(t: LabTest | LabTestFull): string {
  const n = (s: LabResult['state']) => t.results.filter((r) => r.state === s).length;
  const parts = [`${t.results.length} MODEL${t.results.length === 1 ? '' : 'S'}`, `${n('done')} DONE`];
  if (n('running')) parts.push(`${n('running')} RUNNING`);
  if (n('queued')) parts.push(`${n('queued')} WAITING`);
  if (n('failed')) parts.push(`${n('failed')} FAILED`);
  if (n('limit')) parts.push(`${n('limit')} AT LIMIT`);
  if (n('stopped')) parts.push(`${n('stopped')} STOPPED`);
  parts.push(`${t.results.filter((r) => r.stars > 0).length} RATED`);
  return parts.join(' · ');
}

function select(label: string, options: [string, string][], value: string, change: (v: string) => void): HTMLLabelElement {
  const l = el('label', 'lab-field');
  const s = el('select');
  for (const [v, text] of options) {
    const o = el('option', '', text);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.onchange = () => change(s.value);
  l.append(el('span', '', label), s);
  return l;
}

// ------------------------------------------------------------ NEW TEST

async function newView(): Promise<HTMLElement> {
  models = await api<LabModelsResponse>('models');
  const w = el('div', 'lab-new');
  for (const n of models.notes) w.append(el('p', 'lab-warn', n));
  const available = new Set(models.models.map((m) => m.id));
  for (const id of draft.picked) if (!available.has(id)) draft.picked.delete(id);

  const title = el('input', 'lab-title-in');
  title.placeholder = 'Title (optional: made from the prompt if empty)';
  title.value = draft.title;
  title.oninput = () => (draft.title = title.value);
  const prompt = el('textarea', 'lab-prompt-in');
  prompt.placeholder = 'Your prompt. Every model gets exactly this text.';
  prompt.value = draft.prompt;
  prompt.rows = 7;
  const count = el('span', 'lab-count');
  const startBtn = button('', () => void start(startBtn), 'primary lab-start');
  const sync = () => {
    count.textContent = `${draft.picked.size} PICKED`;
    startBtn.textContent = draft.picked.size ? `START ${draft.picked.size} MODEL${draft.picked.size > 1 ? 'S' : ''}` : 'PICK SOME MODELS';
    startBtn.disabled = !draft.picked.size || !draft.prompt.trim() || draft.picked.size > LAB_MAX_MODELS;
    if (draft.picked.size > LAB_MAX_MODELS) startBtn.textContent = `${LAB_MAX_MODELS} MODELS AT MOST`;
    localStorage.setItem(PICKED_KEY, JSON.stringify([...draft.picked]));
  };
  prompt.oninput = () => {
    draft.prompt = prompt.value;
    sync();
  };

  // Models, one group per app and account.
  const groups = el('div', 'lab-groups');
  const chips: { c: HTMLInputElement; l: HTMLLabelElement; m: LabModel }[] = [];
  const byGroup = new Map<string, LabModel[]>();
  for (const m of models.models) byGroup.set(`${m.appName} · ${m.account}`, [...(byGroup.get(`${m.appName} · ${m.account}`) ?? []), m]);
  for (const [name, ms] of byGroup) {
    const g = el('fieldset', 'lab-group');
    g.append(el('legend', '', name));
    for (const m of ms) {
      const l = el('label', 'lab-chip');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = draft.picked.has(m.id);
      c.onchange = () => {
        if (c.checked) draft.picked.add(m.id);
        else draft.picked.delete(m.id);
        l.classList.toggle('on', c.checked);
        sync();
      };
      l.classList.toggle('on', c.checked);
      l.title = m.id;
      if (m.app === 'local') l.title += '\nRuns on this PC. Local models take turns (one GPU).';
      l.append(c, el('span', '', m.name));
      chips.push({ c, l, m });
      g.append(l);
    }
    groups.append(g);
  }
  if (!models.models.length) groups.append(el('p', 'lab-empty', 'No models are ready. See the notes above.'));
  const filter = el('input', 'lab-search lab-model-filter');
  filter.type = 'search';
  filter.placeholder = 'Filter models';
  filter.value = draft.filter;
  const applyFilter = () => {
    draft.filter = filter.value;
    const q = filter.value.trim().toLowerCase();
    for (const { l, m } of chips) l.hidden = !!q && !`${m.name} ${m.id} ${m.appName}`.toLowerCase().includes(q);
    for (const g of groups.querySelectorAll<HTMLElement>('.lab-group')) g.hidden = ![...g.querySelectorAll('.lab-chip')].some((c) => !(c as HTMLElement).hidden);
  };
  filter.oninput = applyFilter;
  const clear = () => {
    for (const { c } of chips) if (c.checked) (c.checked = false), c.dispatchEvent(new Event('change'));
  };

  const modelsHead = el('div', 'lab-row');
  modelsHead.append(el('h3', '', 'MODELS'), count, filter, button('NONE', clear));

  const opts = el('div', 'lab-row lab-opts');
  opts.append(select('TIME LIMIT', LAB_TIME_LIMITS.map((n): [string, string] => [String(n), n < 60 ? `${n} MIN` : `${n / 60} HOUR`]), String(draft.limit), (v) => (draft.limit = Number(v))));
  const blind = el('label', 'lab-check');
  const bc = el('input');
  bc.type = 'checkbox';
  bc.checked = draft.blind;
  bc.onchange = () => (draft.blind = bc.checked);
  blind.append(bc, el('span', '', 'BLIND: hide the names until every result has stars'));
  opts.append(blind);

  const foot = el('div', 'lab-row lab-foot');
  foot.append(startBtn, el('span', 'lab-dim', 'All models start at once, each in its own locked box and folder. Local models take turns.'));

  const dictate = button('DICTATE', () => {}, 'lab-dictate');
  const promptHead = el('div', 'lab-row');
  promptHead.append(el('h3', '', 'PROMPT'), el('span', 'lab-grow'), dictate);
  w.append(promptHead, title, prompt, modelsHead, groups, opts, foot);
  if (view.kind === 'new') releaseDictation = useDictation(dictate, prompt); // not if the owner moved on while it loaded
  sync();
  applyFilter();
  setTimeout(() => (draft.prompt ? null : prompt.focus({ preventScroll: true })), 0);
  return w;
}

async function start(btn: HTMLButtonElement): Promise<void> {
  if (!draft.prompt.trim() || !draft.picked.size) return;
  btn.disabled = true;
  try {
    const { id } = await api<{ id: string }>('tests', 'POST', { title: draft.title, prompt: draft.prompt, models: [...draft.picked], timeLimitMin: draft.limit, blind: draft.blind });
    draft.prompt = '';
    draft.title = '';
    go({ kind: 'test', id });
  } catch (e) {
    fail(e);
    btn.disabled = false;
  }
}

// ------------------------------------------------------------ one TEST

async function testView(id: string): Promise<HTMLElement> {
  current = await api<LabTestFull>(`tests/${encodeURIComponent(id)}`);
  for (const b of nav.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.v === (current.archived ? 'archive' : 'history'));
  const t = current;
  const w = el('div', 'lab-test');

  const head = el('div', 'lab-row lab-test-head');
  const back = button(t.archived ? '< ARCHIVE' : '< HISTORY', () => go({ kind: t.archived ? 'archive' : 'history' }), 'lab-back');
  const h = el('h2', 'lab-test-title', t.title);
  const modeBtns = el('div', 'lab-seg');
  for (const m of ['cards', 'table', 'rank'] as const) {
    const b = button(m.toUpperCase(), () => {
      testMode = m;
      render();
    });
    b.classList.toggle('on', testMode === m);
    modeBtns.append(b);
  }
  const videoBtn = button(video ? 'EXIT VIDEO' : 'VIDEO MODE', () => {
    video = !video;
    render();
  }, video ? 'on' : '');
  videoBtn.title = 'Big cards and race timers: made for recording';
  const blindBtn = button(isBlind(t) ? 'REVEAL' : t.blind ? 'BLIND OFF' : 'BLIND', () => void setBlind(t), isBlind(t) ? 'primary lab-reveal' : '');
  blindBtn.title = 'BLIND hides the model names, so the brand does not change your stars. REVEAL works once every result has stars, or all are ranked.';
  head.append(back, h, el('span', 'lab-grow'), modeBtns, blindBtn, videoBtn);

  const meta = el('div', 'lab-meta');
  const sum = el('span', 'lab-sum', `${fmtTime(t.at)} · ${summary(t)}`);
  const path = el('code', 'lab-path', t.folder);
  path.title = 'The test folder on the PC: the prompt, and one folder per model with its reply, files, log and stars.';
  meta.append(sum, path);

  const prompt = el('details', 'lab-prompt');
  prompt.open = video || t.prompt.length < 400;
  prompt.append(el('summary', '', 'PROMPT'), el('pre', '', t.prompt));

  const body = el('div', 'lab-results');
  fillResults(t, body);

  const more = el('div', 'lab-row lab-actions');
  const stop = button('STOP ALL', () => void act(`tests/${t.id}/stop`, 'Stopping.'));
  stop.hidden = !t.results.some(busy);
  stop.classList.add('lab-stop');
  more.append(
    stop,
    button('RE-RUN', () => rerun(t)),
    button('REMOVE JUNK', () => void act(`tests/${t.id}/junk`, 'Junk removed: node_modules and build caches.')),
    button(t.archived ? 'RESTORE' : 'ARCHIVE', () => void act(`tests/${t.id}/${t.archived ? 'restore' : 'archive'}`, t.archived ? 'Back in HISTORY.' : 'Archived: kept, but hidden from HISTORY.')),
    button('DELETE', () => void remove(t), 'lab-danger'),
  );

  w.append(head, meta, prompt, body, more);
  blindBtn.disabled = isBlind(t) && !canReveal(t);
  if (t.results.some(working)) schedulePoll(t.id);
  if (t.results[openAfterLoad]) setTimeout((i: number) => openFull(t, i), 0, openAfterLoad);
  openAfterLoad = -1;
  return w;
}

function fillResults(t: LabTestFull, body: HTMLElement): void {
  if (testMode === 'table' && !video) return void body.replaceChildren(resultTable(t));
  if (testMode === 'rank' && !video) return void body.replaceChildren(rankView(t));
  const grid = el('div', 'lab-cards');
  grid.dataset.n = String(t.results.length);
  t.results.forEach((_, i) => grid.append(card(t, i)));
  body.replaceChildren(grid);
}

// While models run: fetch the test again every 2 s and redraw only what changed (pages that are showing stay put).
function schedulePoll(id: string): void {
  clearTimeout(poll);
  poll = window.setTimeout(async () => {
    if (!isOpen || view.kind !== 'test' || view.id !== id) return;
    let t: LabTestFull;
    try {
      t = await api<LabTestFull>(`tests/${encodeURIComponent(id)}`);
    } catch {
      return schedulePoll(id);
    }
    if (view.kind !== 'test' || view.id !== id || !current) return;
    const old = current;
    current = t;
    t.results.forEach((r, i) => {
      const o = old.results[i];
      if (!o) return;
      if (o.state !== r.state || o.page !== r.page || o.files.length !== r.files.length || o.build !== r.build) {
        main.querySelector(`.lab-card[data-i="${i}"]`)?.replaceWith(card(t, i));
        const row = main.querySelector(`tr[data-i="${i}"]`);
        if (row) row.replaceWith(resultRow(t, i));
      } else for (const e of main.querySelectorAll<HTMLElement>(`[data-tok="${i}"]`)) e.textContent = `${fmtTok(r.tokens)} TOK`;
    });
    const sum = main.querySelector('.lab-sum');
    if (sum) sum.textContent = `${fmtTime(t.at)} · ${summary(t)}`;
    afterRate(t);
    const stop = main.querySelector<HTMLElement>('.lab-stop');
    if (stop) stop.hidden = !t.results.some(busy);
    if (t.results.some(working)) schedulePoll(id);
  }, 2000);
}

function tickClocks(): void {
  if (!current || view.kind !== 'test') return;
  for (const e of main.querySelectorAll<HTMLElement>('[data-clock]')) {
    const r = current.results[Number(e.dataset.clock)];
    if (r) e.textContent = stateLabel(r);
  }
}

function card(t: LabTestFull, i: number): HTMLElement {
  const r = t.results[i];
  const c = el('article', `lab-card lab-${r.state}`);
  c.dataset.i = String(i);
  c.classList.toggle('lab-top', isWinner(t, r));
  const top = el('div', 'lab-card-top');
  const state = el('span', 'lab-state', stateLabel(r));
  if (busy(r)) state.dataset.clock = String(i);
  const name = el('div', 'lab-name', nameOf(t, i));
  if (r.rank) name.prepend(el('span', 'lab-rank', `#${r.rank}`));
  top.append(name, state);

  const pane = el('div', 'lab-view');
  if (r.page) {
    const f = el('iframe');
    f.setAttribute('sandbox', SANDBOX);
    f.title = `${nameOf(t, i)}: its page`;
    f.loading = 'lazy';
    f.src = pageUrl(t, r);
    pane.append(f);
    pane.onclick = () => openFull(t, i);
  } else if (busy(r)) {
    pane.append(el('div', 'lab-wait', r.state === 'queued' ? (r.app === 'local' ? 'WAITING: A LOCAL MODEL RUNS ALONE, AFTER THE OTHERS' : 'WAITING FOR ITS TURN') : 'WORKING…'));
  } else if (r.build === 'building') {
    pane.append(el('div', 'lab-wait', 'BUILDING THE PAGE…'));
  } else if (r.canBuild) {
    // A project whose page only runs after `npm run build` (React, Vite, TypeScript...).
    const box = el('div', 'lab-needs');
    box.append(
      el('p', '', r.build === 'failed' ? 'THE BUILD FAILED. LOG shows why.' : 'THIS PROJECT MUST BE BUILT BEFORE ITS PAGE CAN SHOW.'),
      button(r.build === 'failed' ? 'TRY THE BUILD AGAIN' : 'BUILD THE PAGE', () => void act(`tests/${t.id}/results/${r.dir}/build`, 'Building: npm install, then npm run build.')),
    );
    pane.append(box);
    if (r.reply) pane.append(el('p', 'lab-reply-line', r.reply));
  } else {
    pane.append(el('pre', `lab-reply${r.error ? ' lab-err' : ''}`, r.reply || r.error || '(no reply)'));
  }
  if (r.page && (r.reply || r.error)) pane.append(el('p', 'lab-reply-line', r.reply || r.error));

  const stats = el('div', 'lab-stats');
  const tok = el('span', '', `${fmtTok(r.tokens)} TOK`);
  tok.dataset.tok = String(i);
  const cost = el('span', '', costText(r));
  cost.title = costTip;
  stats.append(tok, cost, el('span', '', `${r.files.length} FILE${r.files.length === 1 ? '' : 'S'}`));

  const acts = el('div', 'lab-card-acts');
  const big = button('OPEN BIG', () => openFull(t, i));
  big.disabled = busy(r) && !r.page;
  acts.append(big, button('FILES', () => openFiles(t, i)), button('LOG', () => void openLog(t, i)));
  if (r.state === 'failed' || r.state === 'limit' || r.state === 'stopped' || r.timeUp) acts.append(button('RUN AGAIN', () => void runAgain(t, i), 'lab-again'));

  const rate = el('div', 'lab-rate');
  rate.append(starsWidget(t, i));
  const note = el('input', 'lab-note');
  note.placeholder = 'Note';
  note.value = r.note;
  let noteTimer = 0;
  note.oninput = () => {
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => {
      r.note = note.value;
      api(`tests/${t.id}/results/${r.dir}`, 'PATCH', { note: note.value }).catch(fail);
    }, 600);
  };
  rate.append(note);
  if (r.state !== 'done') rate.classList.add('lab-off');

  c.append(top, el('div', 'lab-app', appOf(t, i)), pane, stats, acts, rate);
  return c;
}

function starsWidget(t: LabTestFull, i: number): HTMLElement {
  const r = t.results[i];
  const w = el('div', 'lab-stars');
  w.setAttribute('role', 'group');
  w.setAttribute('aria-label', 'Stars');
  const btns: HTMLButtonElement[] = [];
  const paint = () =>
    btns.forEach((b, k) => {
      b.textContent = k < r.stars ? '★' : '☆';
      b.classList.toggle('on', k < r.stars);
    });
  for (let n = 1; n <= 5; n++) {
    const b = button('☆', () => {
      const was = r.stars;
      r.stars = r.stars === n ? 0 : n;
      paint();
      afterRate(t);
      api(`tests/${t.id}/results/${r.dir}`, 'PATCH', { stars: r.stars }).catch((e) => {
        r.stars = was;
        paint();
        afterRate(t);
        fail(e);
      });
    }, 'lab-star');
    b.title = `${n} star${n > 1 ? 's' : ''}`;
    b.disabled = r.state !== 'done';
    btns.push(b);
  }
  w.append(...btns);
  paint();
  return w;
}

// Stars changed: move the TOP mark, refresh the counts, unlock REVEAL.
function afterRate(t: LabTestFull): void {
  for (const c of main.querySelectorAll<HTMLElement>('[data-i]')) {
    const r = t.results[Number(c.dataset.i)];
    if (r) c.classList.toggle('lab-top', isWinner(t, r));
  }
  const sum = main.querySelector('.lab-sum');
  if (sum) sum.textContent = `${fmtTime(t.at)} · ${summary(t)}`;
  const reveal = main.querySelector<HTMLButtonElement>('.lab-reveal');
  if (reveal) reveal.disabled = !canReveal(t);
}

function resultTable(t: LabTestFull): HTMLElement {
  const wrap = el('div', 'lab-table-wrap');
  const tb = el('table', 'lab-table');
  const hr = el('tr');
  for (const h of ['RANK', 'MODEL', 'APP', 'STATE', 'STARS', 'TOKENS', 'COST', 'FILES', 'NOTE']) hr.append(el('th', '', h));
  tb.append(el('thead'), el('tbody'));
  tb.tHead!.append(hr);
  t.results.forEach((_, i) => tb.tBodies[0].append(resultRow(t, i)));
  wrap.append(tb);
  return wrap;
}

function resultRow(t: LabTestFull, i: number): HTMLElement {
  const r = t.results[i];
  const tr = el('tr');
  tr.dataset.i = String(i);
  tr.classList.toggle('lab-top', isWinner(t, r));
  tr.onclick = (e) => {
    if (!(e.target as HTMLElement).closest('button, input')) openFull(t, i);
  };
  const st = el('td', 'lab-state lab-nowrap', stateLabel(r));
  if (busy(r)) st.dataset.clock = String(i);
  const stars = el('td');
  stars.append(starsWidget(t, i));
  const tok = el('td', '', fmtTok(r.tokens));
  tok.dataset.tok = String(i);
  const cost = el('td', 'lab-nowrap', costText(r));
  cost.title = costTip;
  tr.append(el('td', 'lab-nowrap', r.rank ? `#${r.rank}` : '-'), el('td', 'lab-strong', nameOf(t, i)), el('td', 'lab-dim', appOf(t, i)), st, stars, tok, cost, el('td', '', String(r.files.length)), el('td', 'lab-dim', r.note));
  return tr;
}

// RANK: the finished results in the owner's order, best at the top. ▲ ▼ move one (drag on a PC). Any move saves
// the whole order, so every result in the list gets a place.
function rankView(t: LabTestFull): HTMLElement {
  const w = el('div', 'lab-ranking');
  const done = t.results.map((r, i) => ({ r, i })).filter(({ r }) => r.state === 'done');
  const order = [...done].sort((a, b) => (a.r.rank || 99) - (b.r.rank || 99) || a.i - b.i);
  const ranked = done.some(({ r }) => r.rank > 0);
  const head = el('div', 'lab-row');
  head.append(el('p', 'lab-dim', ranked ? 'Best at the top. ▲ ▼ move one; on a PC you can also drag a row.' : 'Not ranked yet. Move any row and this order is saved: best at the top.'), el('span', 'lab-grow'));
  if (ranked) head.append(button('CLEAR', () => void saveRanking(t, [])));
  const list = el('ol', 'lab-rank-list');
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const [x] = order.splice(from, 1);
    order.splice(to, 0, x);
    void saveRanking(t, order.map(({ r }) => r.dir));
  };
  let dragFrom = -1;
  order.forEach(({ r, i }, pos) => {
    const li = el('li', 'lab-rank-row');
    li.draggable = true;
    li.ondragstart = () => (dragFrom = pos);
    li.ondragover = (e) => e.preventDefault();
    li.ondrop = (e) => {
      e.preventDefault();
      move(dragFrom, pos);
    };
    const who = el('div', 'lab-rank-who');
    who.append(el('div', 'lab-strong', nameOf(t, i)), el('div', 'lab-dim', `${r.stars ? starText(r.stars) : 'no stars'} · ${appOf(t, i)}`));
    const up = button('▲', () => move(pos, pos - 1), 'lab-rank-move');
    const down = button('▼', () => move(pos, pos + 1), 'lab-rank-move');
    up.disabled = pos === 0;
    down.disabled = pos === order.length - 1;
    up.title = 'Move up';
    down.title = 'Move down';
    li.append(el('span', 'lab-rank-num', ranked && r.rank ? `#${r.rank}` : `${pos + 1}`), who, button('VIEW', () => openFull(t, i)), up, down);
    list.append(li);
  });
  w.append(head, list);
  const out = t.results.filter((r) => r.state !== 'done');
  if (out.length) w.append(el('p', 'lab-dim', `Not in the ranking (did not finish): ${out.map((r) => nameOf(t, t.results.indexOf(r))).join(', ')}.`));
  if (!done.length) w.append(el('p', 'lab-empty', 'Nothing has finished yet.'));
  return w;
}

async function saveRanking(t: LabTestFull, dirs: string[]): Promise<void> {
  for (const r of t.results) r.rank = dirs.indexOf(r.dir) + 1;
  const body = main.querySelector<HTMLElement>('.lab-results');
  if (body) fillResults(t, body);
  afterRate(t);
  try {
    await api(`tests/${t.id}`, 'PATCH', { ranking: dirs });
  } catch (e) {
    fail(e);
  }
}

// RUN AGAIN: that one model from scratch, with at least an hour.
async function runAgain(t: LabTestFull, i: number): Promise<void> {
  const r = t.results[i];
  try {
    await api(`tests/${t.id}/results/${r.dir}/again`, 'POST', { timeLimitMin: Math.max(60, t.timeLimitMin) });
    toast('Running it again with a 1-hour limit.');
    render();
  } catch (e) {
    fail(e);
  }
}

async function setBlind(t: LabTestFull): Promise<void> {
  const patch = isBlind(t) ? { revealed: true } : t.blind ? { blind: false } : { blind: true, revealed: false };
  try {
    await api(`tests/${t.id}`, 'PATCH', patch);
    render();
  } catch (e) {
    fail(e);
  }
}

async function act(path: string, done: string): Promise<void> {
  try {
    await api(path, 'POST');
    toast(done);
    render();
  } catch (e) {
    fail(e);
  }
}

function rerun(t: LabTestFull): void {
  draft.prompt = t.prompt;
  draft.title = t.title;
  draft.picked = new Set(t.results.map((r) => r.model));
  draft.blind = t.blind;
  draft.limit = t.timeLimitMin;
  go({ kind: 'new' });
  toast('Same prompt and models. Change anything, then START.');
}

async function remove(t: LabTest | LabTestFull): Promise<void> {
  const ok = await confirmBox('DELETE THIS TEST?', `"${t.title}": ${t.results.length} results. Its folder on the PC is deleted for good.`, 'DELETE');
  if (!ok) return;
  try {
    await api(`tests/${t.id}`, 'DELETE');
    toast('Deleted.');
    go({ kind: t.archived ? 'archive' : 'history' });
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------ full screen and boxes

// OPEN BIG: the result fills the whole screen. A small CLOSE at the top right; DETAILS folds open at the bottom.
function openFull(t: LabTestFull, i: number): void {
  closeFull(true);
  const r = t.results[i];
  const d = el('div', 'lab-full');
  d.tabIndex = -1;
  const close = button('✕', () => closeFull(), 'lab-full-close');
  close.title = 'Close (Esc)';
  close.setAttribute('aria-label', 'Close');
  if (r.page) {
    const f = el('iframe', 'lab-full-frame');
    f.setAttribute('sandbox', SANDBOX);
    f.title = `${nameOf(t, i)}: its page`;
    f.src = pageUrl(t, r);
    d.append(f);
  } else d.append(el('pre', `lab-full-text${r.error && !r.reply ? ' lab-err' : ''}`, r.reply || r.error || '(no reply yet)'));

  const info = el('details', 'lab-full-info');
  const sum = el('summary');
  sum.append(el('span', 'lab-strong', nameOf(t, i)), el('span', 'lab-dim', ` · ${stateLabel(r)} · DETAILS`));
  const inner = el('div', 'lab-full-inner');
  const facts = el('div', 'lab-facts');
  const fact = (k: string, v: string) => facts.append(el('span', 'lab-dim', k), el('span', '', v));
  fact('APP', appOf(t, i));
  if (r.rank) fact('RANK', `#${r.rank} of ${t.results.filter((x) => x.rank > 0).length}`);
  if (!isBlind(t)) fact('VERSION', r.appVersion || '-');
  fact('TIME', r.startedAt ? fmtClock(runMs(r)) : '-');
  fact('TOKENS', fmtTok(r.tokens));
  fact('COST', costText(r));
  fact('FILES', String(r.files.length));
  inner.append(facts, starsWidget(t, i));
  if (r.page && r.reply) inner.append(el('pre', 'lab-reply', r.reply));
  if (r.error) inner.append(el('p', 'lab-err', r.error));
  if (r.page) {
    const open = el('a', 'lab-link', 'OPEN THE PAGE IN A NEW TAB');
    open.href = pageUrl(t, r);
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    inner.append(open);
  }
  const nav2 = el('div', 'lab-row');
  if (t.results.length > 1) {
    nav2.append(
      button('< PREV', () => openFull(t, (i - 1 + t.results.length) % t.results.length)),
      button('NEXT >', () => openFull(t, (i + 1) % t.results.length)),
    );
  }
  nav2.append(button('FILES', () => openFiles(t, i)), button('LOG', () => void openLog(t, i)));
  inner.append(nav2);
  info.append(sum, inner);
  d.append(close, info);
  d.onkeydown = (e) => {
    if (e.key === 'Escape') closeFull();
  };
  document.body.append(d);
  document.body.classList.add('lab-full-open');
  document.documentElement.classList.add('lab-noscan'); // the CRT scanlines would sit on top of the site
  try {
    history.pushState({ phosphorLab: true, full: true }, '');
  } catch {
    /* fine without */
  }
  d.focus();
}

function closeFull(quiet = false): void {
  const d = document.querySelector('.lab-full');
  if (!d) return;
  d.remove();
  document.body.classList.remove('lab-full-open');
  document.documentElement.classList.remove('lab-noscan');
  if (!quiet && (history.state as { full?: boolean } | null)?.full) {
    pendingBack++;
    history.back();
  }
}

function box(title: string, wide = false): { d: HTMLDialogElement; body: HTMLElement } {
  const d = el('dialog', `lab-box${wide ? ' lab-box-wide' : ''}`);
  const head = el('div', 'lab-row lab-box-head');
  head.append(el('h2', '', title), el('span', 'lab-grow'), button('CLOSE', () => d.close()));
  const body = el('div', 'lab-box-body');
  d.append(head, body);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return { d, body };
}

function openFiles(t: LabTestFull, i: number): void {
  const r = t.results[i];
  const { body } = box(`FILES · ${nameOf(t, i)}`);
  body.append(el('code', 'lab-path', `${t.folder}/${isBlind(t) ? '(hidden)' : r.dir}/files/`));
  if (!r.files.length) body.append(el('p', 'lab-dim', 'No files.'));
  const list = el('ul', 'lab-files');
  for (const f of r.files) {
    const li = el('li');
    const a = el('a', 'lab-strong', f.path);
    a.href = pageUrl(t, r, f.path);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a, el('span', 'lab-dim', fmtBytes(f.bytes)));
    list.append(li);
  }
  body.append(list, el('p', 'lab-dim', 'Each file opens in a locked tab. Also in the folder: result.json, reply.md and log.jsonl. Build junk (node_modules) is not listed.'));
}

async function openLog(t: LabTestFull, i: number): Promise<void> {
  const r = t.results[i];
  const { body } = box(`LOG · ${nameOf(t, i)}`, true);
  body.append(el('p', 'lab-dim', 'LOADING…'));
  try {
    const { log, stderr, build } = await api<{ log: string; stderr: string; build: string }>(`tests/${t.id}/results/${r.dir}/log`);
    body.replaceChildren();
    if (build.trim()) body.append(el('h3', '', 'BUILD (npm install, npm run build)'), el('pre', 'lab-log', build));
    body.append(el('h3', '', "THE APP'S OUTPUT (log.jsonl, one event per line)"), el('pre', 'lab-log', log || '(empty)'));
    if (stderr.trim()) body.append(el('h3', '', 'ERRORS AND NOTES (stderr)'), el('pre', 'lab-log', stderr));
  } catch (e) {
    body.replaceChildren(el('p', 'lab-err', e instanceof Error ? e.message : String(e)));
  }
}

// ------------------------------------------------------------ HISTORY

function inRange(t: LabTest): boolean {
  const days = RANGES.find((r) => r[0] === filt.range)?.[2] ?? Infinity;
  return Date.now() - t.at <= days * 86400000;
}

function resultMatches(r: LabResult): boolean {
  if (filt.model && r.modelName !== filt.model) return false;
  if (filt.app && r.appName !== filt.app) return false;
  if (filt.minStars && r.stars < filt.minStars) return false;
  return true;
}

function matches(t: LabTest): boolean {
  if (!inRange(t)) return false;
  const q = filt.q.trim().toLowerCase();
  if (q && !`${t.title} ${t.prompt}`.toLowerCase().includes(q)) return false;
  return !(filt.model || filt.app || filt.minStars) || t.results.some(resultMatches);
}

async function historyView(): Promise<HTMLElement> {
  const { tests } = await api<{ tests: LabTest[] }>('tests');
  const w = el('div', 'lab-history');
  const shown = tests.filter(matches);
  const results = shown.flatMap((t) => t.results.filter(resultMatches).map((r) => ({ t, r })));

  const bar = el('div', 'lab-row lab-filters');
  const q = el('input', 'lab-search');
  q.type = 'search';
  q.placeholder = 'Search prompts and titles';
  q.value = filt.q;
  let timer = 0;
  q.oninput = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      filt.q = q.value;
      const pos = q.selectionStart;
      void historyView().then((node) => {
        main.firstElementChild?.replaceWith(node);
        const nq = main.querySelector<HTMLInputElement>('.lab-search');
        nq?.focus();
        if (nq && pos !== null) nq.setSelectionRange(pos, pos);
      });
    }, 250);
  };
  const modelNames = [...new Set(tests.flatMap((t) => t.results.map((r) => r.modelName)))].sort();
  const appNames = [...new Set(tests.flatMap((t) => t.results.map((r) => r.appName)))].sort();
  const rangeSeg = el('div', 'lab-seg');
  for (const [k, label] of RANGES) {
    const b = button(label, () => {
      filt.range = k;
      render();
    });
    b.classList.toggle('on', filt.range === k);
    rangeSeg.append(b);
  }
  bar.append(
    q,
    select('MODEL', [['', 'ANY'], ...modelNames.map((n): [string, string] => [n, n])], filt.model, (v) => {
      filt.model = v;
      render();
    }),
    select('APP', [['', 'ANY'], ...appNames.map((n): [string, string] => [n, n])], filt.app, (v) => {
      filt.app = v;
      render();
    }),
    select('STARS', [['0', 'ANY'], ['3', '3+'], ['4', '4+'], ['5', '5 ONLY']], String(filt.minStars), (v) => {
      filt.minStars = Number(v);
      render();
    }),
    rangeSeg,
  );
  w.append(bar);
  if (!tests.length) {
    w.append(el('p', 'lab-empty', 'No tests yet. Press + NEW TEST, write a prompt, pick some models and START.'));
    return w;
  }

  const charts = el('div', 'lab-charts');
  charts.append(starsChart(results.map((x) => x.r)), speedChart(results.map((x) => x.r)), winsChart(shown));

  const rowsBar = el('div', 'lab-row');
  const seg = el('div', 'lab-seg');
  for (const [k, label] of [['tests', `TESTS (${shown.length})`], ['results', `RESULTS (${results.length})`]] as const) {
    const b = button(label, () => {
      filt.rows = k;
      if (k === 'tests' && !['date', 'test', 'models', 'stars'].includes(filt.sort)) filt.sort = 'date';
      render();
    });
    b.classList.toggle('on', filt.rows === k);
    seg.append(b);
  }
  rowsBar.append(seg, el('span', 'lab-grow'), el('span', 'lab-dim', 'Click a row to open it. Click a heading to sort.'));

  w.append(charts, rowsBar, filt.rows === 'tests' ? testsTable(shown) : resultsTable(results));
  if (!shown.length) w.append(el('p', 'lab-empty', 'No tests match. Clear the search or pick a longer time range.'));
  return w;
}

function sortHead(tr: HTMLElement, cols: [string, SortKey | null][]): void {
  for (const [label, key] of cols) {
    const th = el('th', key ? 'lab-sort' : '', label + (key && filt.sort === key ? (filt.dir < 0 ? ' ▼' : ' ▲') : ''));
    if (key)
      th.onclick = () => {
        filt.dir = filt.sort === key ? -filt.dir : key === 'test' || key === 'model' ? 1 : -1;
        filt.sort = key;
        render();
      };
    tr.append(th);
  }
}

const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);

function testsTable(shown: LabTest[], archive = false): HTMLElement {
  const val = (t: LabTest): number | string => (filt.sort === 'test' ? t.title.toLowerCase() : filt.sort === 'models' ? t.results.length : filt.sort === 'stars' ? avgStars(rated(t)) : t.at);
  const rows = archive ? shown : [...shown].sort((a, b) => cmp(val(a), val(b)) * filt.dir);
  const wrap = el('div', 'lab-table-wrap');
  const tb = el('table', 'lab-table lab-click');
  const hr = el('tr');
  if (archive) for (const h of ['DATE', 'TEST', 'MODELS', 'WINNER', '']) hr.append(el('th', '', h));
  else sortHead(hr, [['DATE', 'date'], ['TEST', 'test'], ['MODELS', 'models'], ['WINNER', null], ['AVG STARS', 'stars'], ['STATE', null]]);
  tb.append(el('thead'), el('tbody'));
  tb.tHead!.append(hr);
  for (const t of rows) {
    const tr = el('tr');
    tr.onclick = (e) => {
      if (!(e.target as HTMLElement).closest('button')) go({ kind: 'test', id: t.id });
    };
    const max = topStars(t);
    const winners = max || t.results.some((r) => r.rank > 0) ? t.results.filter((r) => isWinner(t, r)).map((r) => r.modelName) : [];
    const testCell = el('td', 'lab-test-cell');
    testCell.append(el('div', 'lab-strong', t.title), el('div', 'lab-dim lab-clip', t.prompt));
    const run = t.results.filter(busy).length;
    const avg = avgStars(rated(t));
    tr.append(el('td', 'lab-nowrap', fmtDate(t.at)), testCell, el('td', '', String(t.results.length)), el('td', '', isBlind(t) ? '(blind)' : winners.join(', ') || '-'));
    if (archive) {
      const acts = el('td', 'lab-nowrap');
      acts.append(button('RESTORE', () => void act(`tests/${t.id}/restore`, 'Back in HISTORY.')), button('DELETE', () => void remove(t), 'lab-danger'));
      tr.append(acts);
    } else
      tr.append(
        el('td', 'lab-nowrap', avg ? `${avg.toFixed(1)} ★` : '-'),
        el('td', 'lab-nowrap', run ? `${run} RUNNING` : t.results.some((r) => r.state === 'done' && !r.stars) ? 'TO RATE' : 'DONE'),
      );
    tb.tBodies[0].append(tr);
  }
  wrap.append(tb);
  return wrap;
}

function resultsTable(results: { t: LabTest; r: LabResult }[]): HTMLElement {
  const val = ({ t, r }: { t: LabTest; r: LabResult }): number | string =>
    filt.sort === 'test' ? t.title.toLowerCase() : filt.sort === 'model' ? r.modelName.toLowerCase() : filt.sort === 'stars' ? r.stars : filt.sort === 'time' ? runMs(r) : filt.sort === 'tokens' ? r.tokens : t.at;
  const rows = [...results].sort((a, b) => cmp(val(a), val(b)) * filt.dir);
  const wrap = el('div', 'lab-table-wrap');
  const tb = el('table', 'lab-table lab-click');
  const hr = el('tr');
  sortHead(hr, [['DATE', 'date'], ['TEST', 'test'], ['MODEL', 'model'], ['APP', null], ['RANK', null], ['STARS', 'stars'], ['TIME', 'time'], ['TOKENS', 'tokens'], ['COST', null], ['NOTE', null]]);
  tb.append(el('thead'), el('tbody'));
  tb.tHead!.append(hr);
  for (const { t, r } of rows) {
    const tr = el('tr');
    tr.onclick = () => go({ kind: 'test', id: t.id });
    const blind = isBlind(t);
    tr.append(
      el('td', 'lab-nowrap', fmtDate(t.at)),
      el('td', 'lab-strong', t.title),
      el('td', 'lab-nowrap', blind ? '(blind)' : r.modelName),
      el('td', 'lab-dim lab-nowrap', blind ? '' : r.appName),
      el('td', 'lab-nowrap', r.rank ? `#${r.rank}` : '-'),
      el('td', 'lab-nowrap lab-starcell', r.state === 'done' ? (r.stars ? starText(r.stars) : 'NOT RATED') : r.state.toUpperCase()),
      el('td', '', r.startedAt ? fmtClock(runMs(r)) : '-'),
      el('td', '', fmtTok(r.tokens)),
      el('td', 'lab-nowrap', costText(r)),
      el('td', 'lab-dim', r.note),
    );
    tb.tBodies[0].append(tr);
  }
  wrap.append(tb);
  return wrap;
}

// ------------------------------------------------------------ charts (one series each: no legend, the title names it)

type Row = { label: string; value: number; text: string; tip: string };

function chartBox(title: string, sub: string): HTMLElement {
  const c = el('figure', 'lab-chart');
  const cap = el('figcaption');
  cap.append(el('span', 'lab-strong', title), el('span', 'lab-dim', sub));
  c.append(cap);
  return c;
}

function barRows(c: HTMLElement, rows: Row[], max: number): void {
  if (!rows.length) return void c.append(el('p', 'lab-dim lab-chart-empty', 'Rate some results to see this.'));
  const list = el('div', 'lab-bars');
  for (const r of rows) {
    const row = el('div', 'lab-bar-row');
    row.title = r.tip;
    const track = el('div', 'lab-bar-track');
    const fill = el('div', 'lab-bar-fill');
    fill.style.width = `${Math.max(2, (r.value / max) * 100)}%`;
    track.append(fill);
    row.append(el('span', 'lab-bar-label', r.label), track, el('span', 'lab-bar-val', r.text));
    list.append(row);
  }
  c.append(list);
}

function byModel(results: LabResult[]): Map<string, LabResult[]> {
  const m = new Map<string, LabResult[]>();
  for (const r of results) if (r.state === 'done') m.set(r.modelName, [...(m.get(r.modelName) ?? []), r]);
  return m;
}

function starsChart(results: LabResult[]): HTMLElement {
  const c = chartBox('AVERAGE STARS', 'per model, rated results');
  const rows: Row[] = [...byModel(results.filter((r) => r.stars > 0))].map(([label, rs]) => {
    const a = avgStars(rs);
    return { label, value: a, text: a.toFixed(1), tip: `${label}: ${a.toFixed(2)} stars from ${rs.length} result${rs.length > 1 ? 's' : ''}` };
  });
  rows.sort((a, b) => b.value - a.value);
  barRows(c, rows.slice(0, 8), 5);
  return c;
}

function winsChart(shown: LabTest[]): HTMLElement {
  const c = chartBox('WINS', 'tests where you ranked it #1 (or it got the most stars)');
  const wins = new Map<string, number>();
  for (const t of shown) {
    if (isBlind(t)) continue;
    for (const r of t.results) if (isWinner(t, r) && resultMatches(r)) wins.set(r.modelName, (wins.get(r.modelName) ?? 0) + 1);
  }
  const rows: Row[] = [...wins].map(([label, n]) => ({ label, value: n, text: String(n), tip: `${label}: the best in ${n} test${n > 1 ? 's' : ''} (#1 in your ranking, else the most stars; ties count for each)` }));
  rows.sort((a, b) => b.value - a.value);
  barRows(c, rows.slice(0, 8), Math.max(1, ...rows.map((r) => r.value)));
  return c;
}

// Stars (up) against time (right): the best are top-left.
function speedChart(results: LabResult[]): HTMLElement {
  const c = chartBox('QUALITY VS SPEED', 'average stars against average time');
  const pts = [...byModel(results.filter((r) => r.stars > 0))].map(([label, rs]) => ({ label, s: avgStars(rs), t: rs.reduce((a, r) => a + runMs(r), 0) / rs.length / 1000, n: rs.length }));
  if (!pts.length) {
    c.append(el('p', 'lab-dim lab-chart-empty', 'Rate some results to see this.'));
    return c;
  }
  const W = 320;
  const H = 190;
  const L = 30;
  const B = 24;
  const tMax = Math.max(60, Math.ceil(Math.max(...pts.map((p) => p.t)) / 60) * 60);
  const x = (t: number) => L + (t / tMax) * (W - L - 12);
  const y = (s: number) => 10 + ((5 - s) / 4) * (H - B - 10);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'lab-scatter');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Average stars against average time, one dot per model');
  const add = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (let s = 1; s <= 5; s++) {
    add('line', { x1: L, x2: W - 12, y1: y(s), y2: y(s), class: 'lab-grid' });
    add('text', { x: L - 6, y: y(s) + 4, class: 'lab-axis', 'text-anchor': 'end' }, `${s}★`);
  }
  for (let t = 0; t <= tMax; t += tMax / 4) add('text', { x: x(t), y: H - 6, class: 'lab-axis', 'text-anchor': 'middle' }, t >= 60 ? `${Math.round(t / 60)}m` : `${Math.round(t)}s`);
  // Direct labels for the best few only, skipping any that would overlap one already placed; every dot has a tooltip.
  const labelled = new Set<string>();
  const placed: { x: number; y: number }[] = [];
  for (const p of [...pts].sort((a, b) => b.s - a.s)) {
    if (labelled.size >= 4) break;
    const at = { x: x(p.t), y: y(p.s) };
    if (placed.some((q) => Math.abs(q.y - at.y) < 16 && Math.abs(q.x - at.x) < 120)) continue;
    labelled.add(p.label);
    placed.push(at);
  }
  for (const p of pts) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'lab-dot');
    const tip = document.createElementNS(NS, 'title');
    tip.textContent = `${p.label}: ${p.s.toFixed(2)} stars, ${Math.round(p.t)}s average (${p.n} result${p.n > 1 ? 's' : ''})`;
    g.append(tip);
    for (const [r, cls] of [[12, 'lab-hit'], [5, '']] as const) {
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(x(p.t)));
      dot.setAttribute('cy', String(y(p.s)));
      dot.setAttribute('r', String(r));
      if (cls) dot.setAttribute('class', cls);
      g.append(dot);
    }
    svg.append(g);
    if (labelled.has(p.label)) {
      const right = x(p.t) < W * 0.6;
      add('text', { x: x(p.t) + (right ? 9 : -9), y: y(p.s) + 4, class: 'lab-dot-label', 'text-anchor': right ? 'start' : 'end' }, p.label);
    }
  }
  c.append(svg);
  return c;
}

// ------------------------------------------------------------ ARCHIVE

async function archiveView(): Promise<HTMLElement> {
  const [{ tests }, st] = await Promise.all([api<{ tests: LabTest[] }>('tests?archived=1'), api<LabStorage>('storage')]);
  const w = el('div', 'lab-archive');
  const store = el('div', 'lab-row lab-storage');
  const junkBtn = button(`REMOVE ALL JUNK (${fmtBytes(st.junkBytes)})`, () => void act('junk', 'Junk removed: node_modules and build caches. Replies, files, logs and stars are kept.'));
  junkBtn.disabled = !st.junkBytes;
  junkBtn.title = 'Deletes node_modules and build caches in every test. Keeps the replies, the files, the logs and the stars.';
  store.append(el('span', '', `${st.tests} TESTS · ${st.archived} ARCHIVED · ${fmtBytes(st.bytes)} ON DISK · ${fmtBytes(st.junkBytes)} JUNK`), el('span', 'lab-grow'), junkBtn);
  w.append(store, el('p', 'lab-dim', 'Archived tests are kept in data/lab/archive/ but hidden from HISTORY. Moving a folder there by hand works too.'));
  if (!tests.length) w.append(el('p', 'lab-empty', 'Nothing archived. Open a test and press ARCHIVE.'));
  else w.append(testsTable(tests, true));
  return w;
}
