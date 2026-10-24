import './lab.css';
import { closeDocs, isDocsOpen, onDocsToggle } from './docs.ts';
import { APPS, fakeFinish, MODELS, modelById, sampleTests, type Result, type Test } from './labdemo.ts';
import { button, confirmBox, el, toast } from './ui.ts';

// LAB (docs/MODEL-LAB.md): one prompt to many AI models, rate the results, look back at every test.
// MOCKUP: the screens run on sample data (labdemo.ts). Nothing is sent to a model and nothing is saved;
// a reload brings the sample data back.
// Open straight to a screen with ?lab=new | history | archive | <test id> (&labview=table | video).

type View = { kind: 'new' } | { kind: 'history' } | { kind: 'archive' } | { kind: 'test'; id: string };
type SortKey = 'date' | 'test' | 'models' | 'stars' | 'size' | 'model' | 'time' | 'tokens';

let rootEl: HTMLElement | null = null;
let main: HTMLElement;
let nav: HTMLElement;
let topBtn: HTMLElement | null = null;
let isOpen = false;
let pendingBack = 0;
let ticker = 0;
let view: View = { kind: 'history' };
const toggles = new Set<() => void>();
const tests: Test[] = sampleTests();
const revealed = new Set<string>();

const filt = { q: '', model: '', app: '', range: 'all', minStars: 0, rows: 'tests' as 'tests' | 'results', sort: 'date' as SortKey, dir: -1 };
let testMode: 'cards' | 'table' = 'cards';
let video = false;
const draft = { title: '', prompt: '', picked: new Set(['claude-opus-5-5', 'gemini-4-argon', 'gpt-6-luna', 'kimi-k3.1-pro']), limit: 10, blind: false };

const LETTERS = 'ABCDEFGHIJKLMNOP';
const RANGES: [string, string, number][] = [['30d', '30 DAYS', 30], ['90d', '90 DAYS', 90], ['1y', '1 YEAR', 366], ['all', 'ALL', Infinity]];

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
    if (isOpen && (history.state as { phosphorLab?: boolean } | null)?.phosphorLab !== true) closeLab(true);
  });
  const q = new URLSearchParams(location.search);
  const start = q.get('lab');
  if (start !== null) {
    if (q.get('labview') === 'table') testMode = 'table';
    if (q.get('labview') === 'video') video = true;
    openLab(start === 'new' || start === 'archive' ? { kind: start } : tests.some((t) => t.id === start) ? { kind: 'test', id: start } : { kind: 'history' });
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
    ticker = window.setInterval(tick, 1000);
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
  const mock = el('span', 'lab-mock', 'MOCKUP · SAMPLE DATA · NOTHING RUNS');
  mock.title = 'These screens run on sample data so you can see and click them. The real lab comes next (docs/MODEL-LAB.md).';
  bar.append(el('span', 'lab-tag', 'MODEL LAB'), nav, mock);
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
  for (const b of nav.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.v === view.kind || (view.kind === 'test' && b.dataset.v === 'history'));
  rootEl.classList.toggle('lab-video', view.kind === 'test' && video);
  const v = view;
  main.replaceChildren(v.kind === 'new' ? newView() : v.kind === 'archive' ? archiveView() : v.kind === 'test' ? testView(v.id) : historyView());
}

// ------------------------------------------------------------ helpers

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtMb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb >= 1 ? `${Math.round(mb)} MB` : `${Math.max(1, Math.round(mb * 1024))} KB`);
const costText = (r: Result) => (r.cost === null ? 'PLAN' : `$${r.cost.toFixed(2)}`);
const testSize = (t: Test) => t.junkMb + t.results.reduce((a, r) => a + r.files.reduce((b, f) => b + f.kb, 0) / 1024 + 0.02, 0);
const slug = (t: Test) => `${new Date(t.at).toISOString().slice(0, 10)}-${t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
const folder = (t: Test) => `data/lab/${t.archived ? 'archive' : 'tests'}/${new Date(t.at).getFullYear()}/${slug(t)}`;
const resultDir = (r: Result) => `${r.model}--${modelById(r.model).app}`;
const isBlind = (t: Test) => t.blind && !revealed.has(t.id);
const nameOf = (t: Test, i: number) => (isBlind(t) ? `MODEL ${LETTERS[i]}` : modelById(t.results[i].model).name);
const appOf = (t: Test, i: number) => {
  if (isBlind(t)) return 'hidden until you rate all';
  const a = APPS[modelById(t.results[i].model).app];
  return `${a.name} · ${a.account}`;
};
const topStars = (t: Test) => Math.max(0, ...t.results.map((r) => r.stars));
const rated = (t: Test) => t.results.filter((r) => r.stars > 0);
const avgStars = (rs: Result[]) => (rs.length ? rs.reduce((a, r) => a + r.stars, 0) / rs.length : 0);
const stateLabel = (r: Result) => (r.state === 'running' ? `RUNNING ${fmtClock(Date.now() - r.startedAt)}` : r.state === 'done' ? `DONE ${fmtClock(r.ms)}` : r.state === 'limit' ? 'PLAN LIMIT' : 'FAILED');

function starText(n: number): string {
  return n > 0 ? '★'.repeat(n) + '☆'.repeat(5 - n) : '☆☆☆☆☆';
}

function summary(t: Test): string {
  const n = (s: Result['state']) => t.results.filter((r) => r.state === s).length;
  const parts = [`${t.results.length} MODELS`, `${n('done')} DONE`];
  if (n('running')) parts.push(`${n('running')} RUNNING`);
  if (n('failed')) parts.push(`${n('failed')} FAILED`);
  if (n('limit')) parts.push(`${n('limit')} AT LIMIT`);
  parts.push(`${rated(t).length} RATED`);
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

function newView(): HTMLElement {
  const w = el('div', 'lab-new');
  const title = el('input', 'lab-title-in');
  title.placeholder = 'Title (optional: made from the prompt if empty)';
  title.value = draft.title;
  title.oninput = () => (draft.title = title.value);
  const prompt = el('textarea', 'lab-prompt-in');
  prompt.placeholder = 'Your prompt. Every model gets exactly this text.';
  prompt.value = draft.prompt;
  prompt.rows = 7;
  const count = el('span', 'lab-count');
  const startBtn = button('', () => start(), 'primary lab-start');
  const sync = () => {
    count.textContent = `${draft.picked.size} PICKED`;
    startBtn.textContent = draft.picked.size ? `START ${draft.picked.size} MODEL${draft.picked.size > 1 ? 'S' : ''}` : 'PICK SOME MODELS';
    startBtn.disabled = !draft.picked.size || !draft.prompt.trim();
  };
  prompt.oninput = () => {
    draft.prompt = prompt.value;
    sync();
  };

  const groups = el('div', 'lab-groups');
  const boxes: HTMLInputElement[] = [];
  for (const app of Object.keys(APPS) as (keyof typeof APPS)[]) {
    const ms = MODELS.filter((m) => m.app === app && !m.old);
    if (!ms.length) continue;
    const g = el('fieldset', 'lab-group');
    const leg = el('legend', '', `${APPS[app].name} · ${APPS[app].account}`);
    g.append(leg);
    for (const m of ms) {
      const l = el('label', 'lab-chip');
      const c = el('input');
      c.type = 'checkbox';
      c.value = m.id;
      c.checked = draft.picked.has(m.id);
      c.onchange = () => {
        if (c.checked) draft.picked.add(m.id);
        else draft.picked.delete(m.id);
        l.classList.toggle('on', c.checked);
        sync();
      };
      l.classList.toggle('on', c.checked);
      l.append(c, el('span', '', m.name));
      if (app === 'local') l.title = 'Runs on this PC. Local models run one at a time (one GPU).';
      boxes.push(c);
      g.append(l);
    }
    groups.append(g);
  }
  const setAll = (on: boolean) => {
    for (const c of boxes) {
      c.checked = on;
      c.dispatchEvent(new Event('change'));
    }
  };

  const modelsHead = el('div', 'lab-row');
  modelsHead.append(el('h3', '', 'MODELS'), count, el('span', 'lab-grow'), button('ALL', () => setAll(true)), button('NONE', () => setAll(false)));

  const opts = el('div', 'lab-row lab-opts');
  opts.append(
    select('TIME LIMIT', [['5', '5 MIN'], ['10', '10 MIN'], ['30', '30 MIN'], ['60', '1 HOUR']], String(draft.limit), (v) => (draft.limit = Number(v))),
  );
  const blind = el('label', 'lab-check');
  const bc = el('input');
  bc.type = 'checkbox';
  bc.checked = draft.blind;
  bc.onchange = () => (draft.blind = bc.checked);
  blind.append(bc, el('span', '', 'BLIND: hide the names until every result has stars'));
  opts.append(blind);

  const foot = el('div', 'lab-row lab-foot');
  foot.append(startBtn, el('span', 'lab-dim', 'All models start at once, each in its own locked folder. Local models take turns.'));

  w.append(el('h3', '', 'PROMPT'), title, prompt, modelsHead, groups, opts, foot);
  sync();
  setTimeout(() => (draft.prompt ? null : prompt.focus({ preventScroll: true })), 0);
  return w;
}

function start(): void {
  const text = draft.prompt.trim();
  if (!text || !draft.picked.size) return;
  const now = Date.now();
  const picked = MODELS.filter((m) => draft.picked.has(m.id));
  let localWait = 0;
  const t: Test = {
    id: `n${now}`,
    title: draft.title.trim() || text.split(/\s+/).slice(0, 6).join(' ').replace(/[.,:;!?]+$/, ''),
    prompt: text,
    at: now,
    archived: false,
    blind: draft.blind,
    timeLimitMin: draft.limit,
    junkMb: 0,
    results: picked.map((m): Result => {
      const ms = 7000 + Math.round(Math.random() * 18000);
      const wait = m.app === 'local' ? localWait : 0; // one GPU: local models take turns
      if (m.app === 'local') localWait += ms;
      return { model: m.id, state: 'running', startedAt: now + wait, ms, tokens: 0, cost: null, stars: 0, note: '', reply: '', files: [], page: '' };
    }),
  };
  tests.unshift(t);
  draft.prompt = '';
  draft.title = '';
  go({ kind: 'test', id: t.id });
}

// ------------------------------------------------------------ one TEST

function testView(id: string): HTMLElement {
  const t = tests.find((x) => x.id === id);
  if (!t) return el('p', 'lab-empty', 'This test is gone.');
  const w = el('div', 'lab-test');

  const head = el('div', 'lab-row lab-test-head');
  const back = button('< HISTORY', () => go({ kind: t.archived ? 'archive' : 'history' }), 'lab-back');
  const h = el('h2', 'lab-test-title', t.title);
  const modeBtns = el('div', 'lab-seg');
  for (const m of ['cards', 'table'] as const) {
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
  videoBtn.title = 'Full screen, big text, race timers: made for recording';
  const blindBtn = button(isBlind(t) ? 'REVEAL' : t.blind ? 'BLIND OFF' : 'BLIND', () => {
    if (isBlind(t)) revealed.add(t.id);
    else if (t.blind) t.blind = false;
    else {
      t.blind = true;
      revealed.delete(t.id);
    }
    render();
  }, isBlind(t) ? 'primary lab-reveal' : '');
  blindBtn.title = 'BLIND hides the model names, so the brand does not change your stars';
  const doneAll = t.results.every((r) => r.state !== 'running');
  if (isBlind(t)) blindBtn.disabled = !doneAll || t.results.some((r) => r.state === 'done' && r.stars === 0);
  const more = el('div', 'lab-row lab-actions');
  more.append(
    button('RE-RUN', () => rerun(t)),
    button(t.archived ? 'RESTORE' : 'ARCHIVE', () => {
      t.archived = !t.archived;
      toast(t.archived ? 'Archived. It is kept, but hidden from HISTORY.' : 'Back in HISTORY.');
      render();
    }),
    button('DELETE', () => void remove(t), 'lab-danger'),
  );
  head.append(back, h, el('span', 'lab-grow'), modeBtns, blindBtn, videoBtn);

  const meta = el('div', 'lab-meta');
  const sum = el('span', '', `${fmtDate(t.at)} · ${summary(t)}`);
  sum.dataset.sum = t.id;
  const path = el('code', 'lab-path', folder(t));
  path.title = 'Each test is one folder: the prompt, and one folder per model with its reply, files, log and stars.';
  meta.append(sum, path);

  const prompt = el('details', 'lab-prompt');
  prompt.open = video || t.prompt.length < 220;
  prompt.append(el('summary', '', 'PROMPT'), el('pre', '', t.prompt));

  const body = el('div', 'lab-results');
  body.dataset.test = t.id;
  fillResults(t, body);

  w.append(head, meta, prompt, body, more);
  return w;
}

function fillResults(t: Test, body: HTMLElement): void {
  if (testMode === 'table' && !video) body.replaceChildren(resultTable(t));
  else body.replaceChildren(el('div', 'lab-cards', '') as HTMLElement);
  if (testMode === 'cards' || video) {
    const grid = body.firstElementChild as HTMLElement;
    grid.dataset.n = String(t.results.length);
    t.results.forEach((_, i) => grid.append(card(t, i)));
  }
}

function card(t: Test, i: number): HTMLElement {
  const r = t.results[i];
  const c = el('article', `lab-card lab-${r.state}`);
  c.dataset.card = String(i);
  c.classList.toggle('lab-top', r.stars > 0 && r.stars === topStars(t));
  const top = el('div', 'lab-card-top');
  const name = el('div', 'lab-name', nameOf(t, i));
  const state = el('span', 'lab-state', stateLabel(r));
  if (r.state === 'running') state.dataset.clock = `${t.id}:${i}`;
  top.append(name, state);
  const app = el('div', 'lab-app', appOf(t, i));

  const pane = el('div', 'lab-view');
  if (r.page) {
    const f = el('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.title = `${nameOf(t, i)}: its page`;
    f.loading = 'lazy';
    f.srcdoc = r.page;
    pane.append(f);
  } else if (r.state === 'running') {
    pane.append(el('div', 'lab-wait', r.startedAt > Date.now() ? 'WAITING FOR THE GPU' : 'WORKING…'));
  } else {
    pane.append(el('pre', 'lab-reply', r.reply || '(no reply)'));
  }
  if (r.page && r.reply) pane.append(el('p', 'lab-reply-line', r.reply));

  const stats = el('div', 'lab-stats');
  const tok = el('span', '', `${fmtTok(r.tokens)} TOK`);
  if (r.state === 'running') tok.dataset.tok = `${t.id}:${i}`;
  stats.append(tok, el('span', '', costText(r)), el('span', '', `${r.files.length} FILE${r.files.length === 1 ? '' : 'S'}`));

  const acts = el('div', 'lab-card-acts');
  const big = button('OPEN BIG', () => openBig(t, i));
  big.disabled = r.state === 'running';
  acts.append(big, button('FILES', () => openFiles(t, i)), button('LOG', () => openLog(t, i)));

  const rate = el('div', 'lab-rate');
  rate.append(starsWidget(t, i));
  const note = el('input', 'lab-note');
  note.placeholder = 'Note';
  note.value = r.note;
  note.oninput = () => (r.note = note.value);
  rate.append(note);
  if (r.state !== 'done') rate.classList.add('lab-off');

  c.append(top, app, pane, stats, acts, rate);
  return c;
}

function starsWidget(t: Test, i: number): HTMLElement {
  const r = t.results[i];
  const w = el('div', 'lab-stars');
  w.setAttribute('role', 'group');
  w.setAttribute('aria-label', 'Stars');
  const btns: HTMLButtonElement[] = [];
  const paint = () => btns.forEach((b, k) => {
    b.textContent = k < r.stars ? '★' : '☆';
    b.classList.toggle('on', k < r.stars);
  });
  for (let n = 1; n <= 5; n++) {
    const b = button('☆', () => {
      r.stars = r.stars === n ? 0 : n;
      paint();
      afterRate(t);
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
function afterRate(t: Test): void {
  const max = topStars(t);
  for (const c of main.querySelectorAll<HTMLElement>('[data-card]')) {
    const r = t.results[Number(c.dataset.card)];
    c.classList.toggle('lab-top', r.stars > 0 && r.stars === max);
  }
  const sum = main.querySelector<HTMLElement>(`[data-sum="${t.id}"]`);
  if (sum) sum.textContent = `${fmtDate(t.at)} · ${summary(t)}`;
  const reveal = main.querySelector<HTMLButtonElement>('.lab-reveal');
  if (reveal) reveal.disabled = t.results.some((r) => r.state === 'running' || (r.state === 'done' && r.stars === 0));
}

function resultTable(t: Test): HTMLElement {
  const wrap = el('div', 'lab-table-wrap');
  const tb = el('table', 'lab-table');
  const hr = el('tr');
  for (const h of ['MODEL', 'APP', 'STATE', 'STARS', 'TIME', 'TOKENS', 'COST', 'FILES', 'NOTE']) hr.append(el('th', '', h));
  tb.append(el('thead'), el('tbody'));
  tb.tHead!.append(hr);
  const max = topStars(t);
  t.results.forEach((r, i) => {
    const tr = el('tr');
    tr.classList.toggle('lab-top', r.stars > 0 && r.stars === max);
    tr.onclick = (e) => {
      if (!(e.target as HTMLElement).closest('button, input') && r.state !== 'running') openBig(t, i);
    };
    const st = el('td', 'lab-state', stateLabel(r));
    if (r.state === 'running') st.dataset.clock = `${t.id}:${i}`;
    const stars = el('td');
    stars.append(starsWidget(t, i));
    tr.append(el('td', 'lab-strong', nameOf(t, i)), el('td', 'lab-dim', appOf(t, i)), st, stars, el('td', '', r.state === 'done' ? fmtClock(r.ms) : '-'), el('td', '', fmtTok(r.tokens)), el('td', '', costText(r)), el('td', '', String(r.files.length)), el('td', 'lab-dim', r.note));
    tb.tBodies[0].append(tr);
  });
  wrap.append(tb);
  return wrap;
}

function rerun(t: Test): void {
  draft.prompt = t.prompt;
  draft.title = t.title;
  draft.picked = new Set(t.results.map((r) => r.model).filter((m) => !modelById(m).old));
  draft.blind = t.blind;
  go({ kind: 'new' });
  toast('Same prompt and models. Change anything, then START.');
}

async function remove(t: Test): Promise<void> {
  const ok = await confirmBox('DELETE THIS TEST?', `"${t.title}": ${t.results.length} results, ${fmtMb(testSize(t))}. The folder is deleted for good.`, 'DELETE');
  if (!ok) return;
  tests.splice(tests.indexOf(t), 1);
  toast('Deleted (mockup: nothing was on disk).');
  go({ kind: t.archived ? 'archive' : 'history' });
}

// ------------------------------------------------------------ boxes

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

function openBig(t: Test, i: number): void {
  const r = t.results[i];
  const { body } = box(`${nameOf(t, i)} · ${t.title}`, true);
  if (r.page) {
    const f = el('iframe', 'lab-big-frame');
    f.setAttribute('sandbox', 'allow-scripts');
    f.srcdoc = r.page;
    body.append(f);
  }
  body.append(el('pre', 'lab-reply', r.reply || '(no reply)'));
}

function openFiles(t: Test, i: number): void {
  const r = t.results[i];
  const { body } = box(`FILES · ${nameOf(t, i)}`);
  body.append(el('code', 'lab-path', `${folder(t)}/${isBlind(t) ? `model-${LETTERS[i].toLowerCase()}` : resultDir(r)}/`));
  const list = el('ul', 'lab-files');
  const rows: [string, string][] = [['result.json', 'model, app, times, tokens, stars, note'], ['reply.md', 'the final answer'], ['log.jsonl', "the app's full log"]];
  for (const [n, what] of rows) list.append(fileRow(n, what));
  for (const f of r.files) list.append(fileRow(`files/${f.name}`, `${f.kb} KB`));
  if (t.junkMb && r.files.length > 1) list.append(fileRow('files/node_modules/', `${fmtMb(t.junkMb / t.results.length)} · junk`));
  body.append(list);
}

function fileRow(name: string, what: string): HTMLElement {
  const li = el('li');
  li.append(el('span', 'lab-strong', name), el('span', 'lab-dim', what));
  return li;
}

function openLog(t: Test, i: number): void {
  const r = t.results[i];
  const m = modelById(r.model);
  const { body } = box(`LOG · ${nameOf(t, i)}`, true);
  const at = new Date(r.startedAt).toISOString();
  const lines = [
    { type: 'start', at, app: APPS[m.app].name, model: isBlind(t) ? 'hidden' : m.id, folder: 'out/' },
    { type: 'tool', tool: 'write', path: r.files[0]?.name ?? 'answer.md' },
    { type: 'usage', input_tokens: Math.round(r.tokens * 0.7), output_tokens: Math.round(r.tokens * 0.3) },
    { type: 'end', state: r.state, ms: r.ms },
  ];
  body.append(el('p', 'lab-dim', 'MOCKUP: a real log is the app\'s own JSON stream, saved as log.jsonl.'), el('pre', 'lab-log', lines.map((l) => JSON.stringify(l)).join('\n')));
}

// ------------------------------------------------------------ HISTORY

function inRange(t: Test): boolean {
  const days = RANGES.find((r) => r[0] === filt.range)?.[2] ?? Infinity;
  return Date.now() - t.at <= days * 86400000;
}

function matches(t: Test): boolean {
  if (t.archived || !inRange(t)) return false;
  const q = filt.q.trim().toLowerCase();
  if (q && !`${t.title} ${t.prompt}`.toLowerCase().includes(q)) return false;
  if (filt.model && !t.results.some((r) => modelById(r.model).name === filt.model)) return false;
  if (filt.app && !t.results.some((r) => modelById(r.model).app === filt.app)) return false;
  if (filt.minStars && !t.results.some((r) => r.stars >= filt.minStars)) return false;
  return true;
}

function resultMatches(r: Result): boolean {
  const m = modelById(r.model);
  if (filt.model && m.name !== filt.model) return false;
  if (filt.app && m.app !== filt.app) return false;
  if (filt.minStars && r.stars < filt.minStars) return false;
  return true;
}

function historyView(): HTMLElement {
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
      render();
      const nq = main.querySelector<HTMLInputElement>('.lab-search');
      nq?.focus();
      if (nq && pos !== null) nq.setSelectionRange(pos, pos);
    }, 200);
  };
  const modelNames = [...new Set(MODELS.map((m) => m.name))].sort();
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
    select('APP', [['', 'ANY'], ...(Object.keys(APPS) as (keyof typeof APPS)[]).filter((a) => a !== 'local').map((a): [string, string] => [a, APPS[a].name]), ['local', 'Local (this PC)']], filt.app, (v) => {
      filt.app = v;
      render();
    }),
    select('STARS', [['0', 'ANY'], ['3', '3+'], ['4', '4+'], ['5', '5 ONLY']], String(filt.minStars), (v) => {
      filt.minStars = Number(v);
      render();
    }),
    rangeSeg,
  );

  const charts = el('div', 'lab-charts');
  charts.append(starsChart(results.map((x) => x.r)), speedChart(results.map((x) => x.r)), winsChart(shown));

  const rowsBar = el('div', 'lab-row');
  const seg = el('div', 'lab-seg');
  for (const [k, label] of [['tests', `TESTS (${shown.length})`], ['results', `RESULTS (${results.length})`]] as const) {
    const b = button(label, () => {
      filt.rows = k;
      if (k === 'tests' && !['date', 'test', 'models', 'stars', 'size'].includes(filt.sort)) filt.sort = 'date';
      render();
    });
    b.classList.toggle('on', filt.rows === k);
    seg.append(b);
  }
  rowsBar.append(seg, el('span', 'lab-grow'), el('span', 'lab-dim', 'Click a row to open it. Click a heading to sort.'));

  w.append(bar, charts, rowsBar, filt.rows === 'tests' ? testsTable(shown) : resultsTable(results));
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

function testsTable(shown: Test[]): HTMLElement {
  const val = (t: Test): number | string =>
    filt.sort === 'test' ? t.title.toLowerCase() : filt.sort === 'models' ? t.results.length : filt.sort === 'stars' ? avgStars(rated(t)) : filt.sort === 'size' ? testSize(t) : t.at;
  const rows = [...shown].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * filt.dir);
  const wrap = el('div', 'lab-table-wrap');
  const tb = el('table', 'lab-table lab-click');
  const hr = el('tr');
  sortHead(hr, [['DATE', 'date'], ['TEST', 'test'], ['MODELS', 'models'], ['WINNER', null], ['AVG STARS', 'stars'], ['STATE', null], ['SIZE', 'size']]);
  tb.append(el('thead'), el('tbody'));
  tb.tHead!.append(hr);
  for (const t of rows) {
    const tr = el('tr');
    tr.onclick = () => go({ kind: 'test', id: t.id });
    const max = topStars(t);
    const winners = max ? t.results.filter((r) => r.stars === max).map((r) => modelById(r.model).name) : [];
    const testCell = el('td', 'lab-test-cell');
    testCell.append(el('div', 'lab-strong', t.title), el('div', 'lab-dim lab-clip', t.prompt));
    const running = t.results.filter((r) => r.state === 'running').length;
    const avg = avgStars(rated(t));
    tr.append(
      el('td', 'lab-nowrap', fmtDate(t.at)),
      testCell,
      el('td', '', String(t.results.length)),
      el('td', '', isBlind(t) ? '(blind)' : winners.join(', ') || '-'),
      el('td', 'lab-nowrap', avg ? `${avg.toFixed(1)} ★` : '-'),
      el('td', 'lab-nowrap', running ? `${running} RUNNING` : rated(t).length < t.results.filter((r) => r.state === 'done').length ? 'TO RATE' : 'DONE'),
      el('td', 'lab-nowrap', fmtMb(testSize(t))),
    );
    tb.tBodies[0].append(tr);
  }
  wrap.append(tb);
  return wrap;
}

function resultsTable(results: { t: Test; r: Result }[]): HTMLElement {
  const val = ({ t, r }: { t: Test; r: Result }): number | string =>
    filt.sort === 'test' ? t.title.toLowerCase() : filt.sort === 'model' ? modelById(r.model).name.toLowerCase() : filt.sort === 'stars' ? r.stars : filt.sort === 'time' ? r.ms : filt.sort === 'tokens' ? r.tokens : t.at;
  const rows = [...results].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * filt.dir);
  const wrap = el('div', 'lab-table-wrap');
  const tb = el('table', 'lab-table lab-click');
  const hr = el('tr');
  sortHead(hr, [['DATE', 'date'], ['TEST', 'test'], ['MODEL', 'model'], ['APP', null], ['STARS', 'stars'], ['TIME', 'time'], ['TOKENS', 'tokens'], ['COST', null], ['NOTE', null]]);
  tb.append(el('thead'), el('tbody'));
  tb.tHead!.append(hr);
  for (const { t, r } of rows) {
    const tr = el('tr');
    tr.onclick = () => go({ kind: 'test', id: t.id });
    const m = modelById(r.model);
    const blind = isBlind(t);
    tr.append(
      el('td', 'lab-nowrap', fmtDate(t.at)),
      el('td', 'lab-strong', t.title),
      el('td', 'lab-nowrap', blind ? '(blind)' : m.name),
      el('td', 'lab-dim lab-nowrap', blind ? '' : APPS[m.app].name),
      el('td', 'lab-nowrap lab-starcell', r.state === 'done' ? starText(r.stars) : r.state.toUpperCase()),
      el('td', '', r.state === 'done' ? fmtClock(r.ms) : '-'),
      el('td', '', fmtTok(r.tokens)),
      el('td', '', costText(r)),
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
  if (!rows.length) {
    c.append(el('p', 'lab-dim lab-chart-empty', 'Rate some results to see this.'));
    return;
  }
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

function byModel(results: Result[]): Map<string, Result[]> {
  const m = new Map<string, Result[]>();
  for (const r of results) {
    if (r.state !== 'done') continue;
    const k = modelById(r.model).name;
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
}

function starsChart(results: Result[]): HTMLElement {
  const c = chartBox('AVERAGE STARS', 'per model, rated results');
  const rows: Row[] = [...byModel(results.filter((r) => r.stars > 0))].map(([label, rs]) => {
    const a = avgStars(rs);
    return { label, value: a, text: a.toFixed(1), tip: `${label}: ${a.toFixed(2)} stars from ${rs.length} result${rs.length > 1 ? 's' : ''}` };
  });
  rows.sort((a, b) => b.value - a.value);
  barRows(c, rows.slice(0, 8), 5);
  return c;
}

function winsChart(shown: Test[]): HTMLElement {
  const c = chartBox('WINS', 'tests where it got the most stars');
  const wins = new Map<string, number>();
  for (const t of shown) {
    const max = topStars(t);
    if (!max) continue;
    for (const r of t.results) if (r.stars === max && resultMatches(r)) wins.set(modelById(r.model).name, (wins.get(modelById(r.model).name) ?? 0) + 1);
  }
  const rows: Row[] = [...wins].map(([label, n]) => ({ label, value: n, text: String(n), tip: `${label}: top stars in ${n} test${n > 1 ? 's' : ''} (ties count for each)` }));
  rows.sort((a, b) => b.value - a.value);
  barRows(c, rows.slice(0, 8), Math.max(1, ...rows.map((r) => r.value)));
  return c;
}

// Stars (up) against time (right): the best are top-left.
function speedChart(results: Result[]): HTMLElement {
  const c = chartBox('QUALITY VS SPEED', 'average stars against average time');
  const pts = [...byModel(results.filter((r) => r.stars > 0))].map(([label, rs]) => ({ label, s: avgStars(rs), t: rs.reduce((a, r) => a + r.ms, 0) / rs.length / 1000, n: rs.length }));
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
    const hit = document.createElementNS(NS, 'circle');
    hit.setAttribute('cx', String(x(p.t)));
    hit.setAttribute('cy', String(y(p.s)));
    hit.setAttribute('r', '12');
    hit.setAttribute('class', 'lab-hit');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', String(x(p.t)));
    dot.setAttribute('cy', String(y(p.s)));
    dot.setAttribute('r', '5');
    const tip = document.createElementNS(NS, 'title');
    tip.textContent = `${p.label}: ${p.s.toFixed(2)} stars, ${Math.round(p.t)}s average (${p.n} result${p.n > 1 ? 's' : ''})`;
    g.append(tip, hit, dot);
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

function archiveView(): HTMLElement {
  const w = el('div', 'lab-archive');
  const arch = tests.filter((t) => t.archived).sort((a, b) => b.at - a.at);
  const total = tests.reduce((a, t) => a + testSize(t), 0);
  const junk = tests.reduce((a, t) => a + t.junkMb, 0);
  const store = el('div', 'lab-row lab-storage');
  const junkBtn = button(`REMOVE ALL JUNK (${fmtMb(junk)})`, () => {
    for (const t of tests) t.junkMb = 0;
    toast('Junk removed: node_modules and build caches. Replies, files, logs and stars are kept.');
    render();
  });
  junkBtn.disabled = !junk;
  junkBtn.title = 'Deletes node_modules and build caches in every test. Keeps the replies, the files, the logs and the stars.';
  store.append(el('span', '', `${tests.length} TESTS · ${fmtMb(total)} ON DISK · ${fmtMb(junk)} JUNK`), el('span', 'lab-grow'), junkBtn);
  w.append(store);
  w.append(el('p', 'lab-dim', 'Archived tests are kept in data/lab/archive/ but hidden from HISTORY. Moving a folder there by hand works too.'));
  if (!arch.length) {
    w.append(el('p', 'lab-empty', 'Nothing archived. Open a test and press ARCHIVE.'));
    return w;
  }
  const wrap = el('div', 'lab-table-wrap');
  const tb = el('table', 'lab-table lab-click');
  const hr = el('tr');
  for (const h of ['DATE', 'TEST', 'MODELS', 'SIZE', '']) hr.append(el('th', '', h));
  tb.append(el('thead'), el('tbody'));
  tb.tHead!.append(hr);
  for (const t of arch) {
    const tr = el('tr');
    tr.onclick = (e) => {
      if (!(e.target as HTMLElement).closest('button')) go({ kind: 'test', id: t.id });
    };
    const acts = el('td', 'lab-nowrap');
    acts.append(
      button('RESTORE', () => {
        t.archived = false;
        toast('Back in HISTORY.');
        render();
      }),
      button('DELETE', () => void remove(t), 'lab-danger'),
    );
    const testCell = el('td', 'lab-test-cell');
    testCell.append(el('div', 'lab-strong', t.title), el('div', 'lab-dim lab-clip', t.prompt));
    tr.append(el('td', 'lab-nowrap', fmtDate(t.at)), testCell, el('td', '', String(t.results.length)), el('td', 'lab-nowrap', fmtMb(testSize(t))), acts);
    tb.tBodies[0].append(tr);
  }
  wrap.append(tb);
  w.append(wrap);
  return w;
}

// ------------------------------------------------------------ the fake runner

function tick(): void {
  const now = Date.now();
  for (const t of tests)
    t.results.forEach((r, i) => {
      if (r.state !== 'running' || r.startedAt > now) return;
      if (now - r.startedAt >= r.ms) {
        fakeFinish(r, t.prompt, i + t.id.length);
        r.ms = now - r.startedAt;
        finished(t, i);
      } else r.tokens += 150 + Math.round(Math.random() * 500);
    });
  if (!rootEl) return;
  for (const e of rootEl.querySelectorAll<HTMLElement>('[data-clock]')) {
    const [id, i] = e.dataset.clock!.split(':');
    const r = tests.find((t) => t.id === id)?.results[Number(i)];
    if (r?.state === 'running') e.textContent = r.startedAt > now ? 'WAITING' : stateLabel(r);
  }
  for (const e of rootEl.querySelectorAll<HTMLElement>('[data-tok]')) {
    const [id, i] = e.dataset.tok!.split(':');
    const r = tests.find((t) => t.id === id)?.results[Number(i)];
    if (r) e.textContent = `${fmtTok(r.tokens)} TOK`;
  }
}

function finished(t: Test, i: number): void {
  if (view.kind !== 'test' || view.id !== t.id) return;
  const old = main.querySelector<HTMLElement>(`[data-card="${i}"]`);
  if (old) old.replaceWith(card(t, i));
  else {
    const body = main.querySelector<HTMLElement>(`[data-test="${t.id}"]`);
    if (body) fillResults(t, body);
  }
  afterRate(t);
}
