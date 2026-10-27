import './prompter.css';
import { cutPieces, parsePoints, type AfterJob, type CuePoint, type PromptList, type PromptListSummary, type PrompterLive } from '../../shared/prompter.ts';
import { closeDocs, isDocsOpen, onDocsToggle } from './docs.ts';
import { closeKeywords, isKeywordsOpen, onKeywordsToggle } from './keywords.ts';
import { closeLab, isLabOpen, onLabToggle } from './lab.ts';
import { demoPrompterApi } from './prompterdemo.ts';
import { CueMic, type MicState } from './promptermic.ts';
import { showChat } from './programs.ts';
import { store } from './store.ts';
import { button, confirmBox, el, toast } from './ui.ts';

// PROMPTER (PLAN.md "PROMPTER"): a punch list for recording a video. LIST: write or paste the points (one per line,
// indented lines are notes), save named lists, START. RUN: the points left, big, the next one first; ticked ones
// dim at the bottom; a tap ticks or unticks. The mic of the device that pressed START (or LISTEN HERE) streams to the
// PC's speech engine; the PC asks a decision model about the open points and ticks them (server/prompter.ts). Every
// screen with PROMPTER open shows the same session, so a phone or a second monitor can be the prompter while the PC
// records. FULL shows only the points (nothing private on screen). AFTER: a finished recording's transcript against a
// list: covered and missed points. Open straight to it with ?prompter (list), ?prompter=run or ?prompter=stage.

type View = 'list' | 'run' | 'after';
type LiveReply = { live?: PrompterLive | null; engine?: PrompterLive['engine']; now?: number; v?: number };

const POLL_RUN_MS = 700;
const POLL_IDLE_MS = 4000;
const AFTER_POLL_MS = 1000;
const DRAFT_KEY = 'phosphor.prompter.draft';

let rootEl: HTMLElement | null = null;
let topBtn: HTMLElement | null = null;
let isOpen = false;
let pendingBack = 0;
let view: View = 'list';

let nav: HTMLElement;
let listBox: HTMLElement;
let runBox: HTMLElement;
let afterBox: HTMLElement;
let savedEl: HTMLElement;
let nameInput: HTMLInputElement;
let textInput: HTMLTextAreaElement;
let countEl: HTMLElement;
let engineEl: HTMLElement;
let runningEl: HTMLElement;

let lists: PromptListSummary[] = [];
let listId: string | null = null;
let live: PrompterLive | null = null;
let engine: PrompterLive['engine'] = { ready: false, label: '', note: '' };
let skew = 0; // the PC's clock minus this device's
let pollTimer = 0;
let clockTimer = 0;
let polling = false;
let mic: CueMic | null = null;
let micState: MicState | 'off' = 'off';
let micNote = '';
let wake: { release(): Promise<void> } | null = null;
let shownV = -1;

// ------------------------------------------------------------ public

export function mountPrompter(btn: HTMLElement | null): void {
  topBtn = btn;
  if (btn) btn.onclick = () => (isOpen ? closePrompter() : openPrompter());
  document.getElementById('tabs')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.tab-label, .tab-add')) closePrompter();
  });
  document.getElementById('history')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.history-row')) closePrompter();
  });
  // DOCS, LAB and KEYWORDS each push their own back-button entry.
  onDocsToggle(() => isDocsOpen() && closePrompter(true));
  onLabToggle(() => isLabOpen() && closePrompter(true));
  onKeywordsToggle(() => isKeywordsOpen() && closePrompter(true));
  addEventListener('popstate', () => {
    if (pendingBack > 0) {
      pendingBack--;
      return;
    }
    if (document.body.classList.contains('cue-stage')) setStage(false);
    if (isOpen && (window.history.state as { phosphorCue?: boolean } | null)?.phosphorCue !== true) closePrompter(true);
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('cue-stage')) setStage(false);
  });
  document.addEventListener('visibilitychange', () => void holdScreen());
  const start = new URLSearchParams(location.search).get('prompter');
  if (start !== null) {
    openPrompter(start === 'run' || start === 'stage' ? 'run' : start === 'after' ? 'after' : 'list');
    if (start === 'stage') setStage(true);
  }
}

export const isPrompterOpen = (): boolean => isOpen;

export function openPrompter(v?: View): void {
  build();
  if (v) view = v;
  if (!isOpen) {
    const fromOther = isDocsOpen() || isLabOpen() || isKeywordsOpen();
    if (isDocsOpen()) closeDocs(true);
    if (isLabOpen()) closeLab(true);
    if (isKeywordsOpen()) closeKeywords(true);
    showChat(); // the desktop app: a site in the web pane would sit on top
    isOpen = true;
    rootEl!.hidden = false;
    document.body.classList.add('prompter-open');
    topBtn?.classList.add('on');
    try {
      if (fromOther) window.history.replaceState({ phosphorCue: true }, '');
      else window.history.pushState({ phosphorCue: true }, '');
    } catch {
      /* fine without the back button */
    }
    clockTimer = window.setInterval(renderClock, 1000);
    void loadLists();
  }
  showView();
  void poll();
}

// Leaving the screen does not stop a recording: the mic keeps feeding and the session goes on.
export function closePrompter(fromPop = false): void {
  if (!isOpen || !rootEl) return;
  setStage(false);
  isOpen = false;
  rootEl.hidden = true;
  document.body.classList.remove('prompter-open');
  topBtn?.classList.remove('on');
  clearTimeout(pollTimer);
  clearInterval(clockTimer);
  void holdScreen();
  if (!fromPop && (window.history.state as { phosphorCue?: boolean } | null)?.phosphorCue) {
    pendingBack++;
    window.history.back();
  }
}

export const prompterCommands = [
  { id: 'prompter', label: 'PROMPTER', hint: 'Punch list for recording a video: ticks off points as you talk', keywords: ['teleprompter', 'cue', 'youtube', 'record', 'video', 'points', 'script'], run: () => openPrompter() },
  { id: 'prompter-after', label: 'PROMPTER AFTER', hint: 'Which points a recording covered and which it missed', keywords: ['prompter', 'transcript', 'covered', 'missed', 'video'], run: () => openPrompter('after') },
];

// ------------------------------------------------------------ server

const isDemo = () => store.demo || new URLSearchParams(location.search).has('demo');

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (isDemo()) return demoPrompterApi<T>(path, method, body);
  const r = await fetch(`/api/prompter/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `The server said ${r.status}.`);
  return data;
}

const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 6000);

const running = () => !!live && !live.endedAt;

async function poll(): Promise<void> {
  clearTimeout(pollTimer);
  if (!isOpen && !mic) return;
  if (polling) return;
  polling = true;
  try {
    const r = await api<LiveReply>(`live${live ? `?v=${live.v}` : ''}`);
    if (r.now) skew = r.now - Date.now();
    if (r.engine) engine = r.engine;
    if (r.live !== undefined) {
      const wasRunning = running();
      live = r.live;
      if (live && !live.endedAt && !wasRunning && isOpen && view === 'list' && !mic) toast('A recording is running. RUN shows it.', 3000);
      if (wasRunning && !running() && mic) void stopMic();
    }
  } catch {
    /* the next poll tries again */
  } finally {
    polling = false;
  }
  render();
  if (isOpen || mic) pollTimer = window.setTimeout(() => void poll(), running() || view === 'run' ? POLL_RUN_MS : POLL_IDLE_MS);
}

// ------------------------------------------------------------ frame

function build(): void {
  if (rootEl) return;
  const root = el('section', 'cue');
  rootEl = root;
  root.hidden = true;
  root.setAttribute('aria-label', 'PROMPTER');
  const bar = el('div', 'cue-bar');
  nav = el('nav', 'cue-nav');
  for (const [label, v] of [['LIST', 'list'], ['RUN', 'run'], ['AFTER', 'after']] as const) {
    const b = button(label, () => {
      view = v;
      showView();
    });
    b.dataset.v = v;
    nav.append(b);
  }
  runningEl = el('span', 'cue-running');
  bar.append(el('span', 'cue-tag', 'PROMPTER'), nav, runningEl);
  const main = el('div', 'cue-main');
  listBox = buildList();
  runBox = el('div', 'cue-run');
  afterBox = buildAfter();
  main.append(listBox, runBox, afterBox);
  root.append(bar, main);
  document.body.append(root);
}

function showView(): void {
  for (const b of nav.querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.v === view);
  listBox.hidden = view !== 'list';
  runBox.hidden = view !== 'run';
  afterBox.hidden = view !== 'after';
  shownV = -1;
  render();
  void holdScreen();
  if (view === 'after') void fillAfterPickers();
}

function render(): void {
  if (!rootEl) return;
  runningEl.textContent = running() ? `● REC ${clock()}` : '';
  engineEl.textContent = engine.ready ? `AUTO TICK: ${engine.label}` : engine.note || 'AUTO TICK IS OFF: tick points by hand.';
  engineEl.classList.toggle('cue-warn', !engine.ready);
  if (view === 'run' && (live?.v ?? 0) !== shownV) renderRun();
  else if (view === 'run') renderClock();
}

// ------------------------------------------------------------ LIST

function buildList(): HTMLElement {
  const box = el('div', 'cue-list');
  const side = el('div', 'cue-side');
  savedEl = el('div', 'cue-saved');
  side.append(el('h3', '', 'SAVED LISTS'), button('+ NEW LIST', () => void pickList(null), 'cue-new'), savedEl);

  const edit = el('div', 'cue-edit');
  nameInput = el('input', 'cue-name');
  nameInput.placeholder = 'Name, for example: Video 12, local AI on a budget';
  nameInput.maxLength = 80;
  nameInput.setAttribute('aria-label', 'List name');
  textInput = el('textarea', 'cue-text');
  textInput.rows = 12;
  textInput.spellcheck = true;
  textInput.placeholder = 'One point per line. Indent a line to add a short note under the point above.\n\nWhy local AI matters\n  privacy, no monthly bill\nThe hardware you need\nSetting it up in 10 minutes\nThe first real test';
  textInput.setAttribute('aria-label', 'Points');
  for (const i of [nameInput, textInput]) {
    i.oninput = () => {
      updateCount();
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: listId, name: nameInput.value, text: textInput.value }));
      } catch {
        /* no storage: fine */
      }
    };
    i.onkeydown = (e) => e.stopPropagation();
  }
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as { id: string | null; name: string; text: string } | null;
    if (d) {
      listId = d.id;
      nameInput.value = d.name;
      textInput.value = d.text;
    }
  } catch {
    /* no draft */
  }
  countEl = el('span', 'cue-dim');
  engineEl = el('p', 'cue-note');
  const row = el('div', 'cue-row');
  row.append(button('START', () => void startRun(), 'primary cue-go'), button('SAVE', () => void saveCurrent()), button('DELETE', () => void deleteCurrent()), countEl);
  edit.append(nameInput, textInput, row, engineEl, el('p', 'cue-note', 'START uses the mic of this device. To record on the PC and read the points on a phone: START on the PC, then open PROMPTER on the phone. LISTEN HERE moves the mic to another device.'));
  box.append(side, edit);
  updateCount();
  return box;
}

function updateCount(): void {
  const n = parsePoints(textInput.value).length;
  countEl.textContent = n === 1 ? '1 POINT' : `${n} POINTS`;
}

async function loadLists(): Promise<void> {
  try {
    lists = (await api<{ lists: PromptListSummary[] }>('lists')).lists;
  } catch (e) {
    return fail(e);
  }
  savedEl.replaceChildren(
    ...(lists.length
      ? lists.map((l) => {
          const b = button('', () => void pickList(l.id), 'cue-saved-row');
          b.classList.toggle('on', l.id === listId);
          b.append(el('span', 'cue-saved-name', l.name), el('span', 'cue-dim', `${l.points}`));
          return b;
        })
      : [el('p', 'cue-dim', 'None yet. SAVE keeps the list on the PC.')]),
  );
}

async function pickList(id: string | null): Promise<void> {
  if (id === listId && id !== null) return;
  if (id === null) {
    listId = null;
    nameInput.value = '';
    textInput.value = '';
  } else {
    try {
      const l = await api<PromptList>(`lists/${encodeURIComponent(id)}`);
      listId = l.id;
      nameInput.value = l.name;
      textInput.value = l.text;
    } catch (e) {
      return fail(e);
    }
  }
  textInput.dispatchEvent(new Event('input'));
  void loadLists();
}

async function saveCurrent(): Promise<void> {
  try {
    const l = await api<PromptList>('lists', 'POST', { id: listId ?? undefined, name: nameInput.value, text: textInput.value });
    listId = l.id;
    nameInput.value = l.name;
    textInput.dispatchEvent(new Event('input'));
    toast('Saved.', 1500);
    void loadLists();
  } catch (e) {
    fail(e);
  }
}

async function deleteCurrent(): Promise<void> {
  if (!listId) return void toast('This list is not saved.', 2000);
  if (!(await confirmBox('DELETE LIST', `Delete "${nameInput.value || 'this list'}"?`, 'DELETE'))) return;
  try {
    await api(`lists/${encodeURIComponent(listId)}`, 'DELETE');
    void pickList(null);
  } catch (e) {
    fail(e);
  }
}

// ------------------------------------------------------------ RUN

async function startRun(): Promise<void> {
  if (!parsePoints(textInput.value).length) return void toast('Write at least one point, one per line.');
  if (running() && !(await confirmBox('NEW RECORDING', 'A recording is running. Stop it and start this list?', 'START'))) return;
  // The mic starts inside this click (phones only allow it there), before the server answers.
  const m = isDemo() ? null : startMic();
  try {
    await stopMic(true);
    const r = await api<{ live: PrompterLive; mic: string }>('live/start', 'POST', { name: nameInput.value, text: textInput.value });
    live = r.live;
    if (m) m.attach(r.mic);
    view = 'run';
    showView();
    void poll();
  } catch (e) {
    void m?.mic.stop();
    fail(e);
  }
}

// Start this device's mic now; the session token comes when the server answers (`attach`).
function startMic(): { mic: CueMic; attach(token: string): void } {
  let token = '';
  let dead = false;
  const m = new CueMic(
    () => token,
    (s, note) => {
      micState = s;
      micNote = note ?? '';
      if (s === 'error') {
        dead = true;
        if (note) toast(note, 8000);
        if (mic === m) mic = null;
        micState = 'off';
      }
      shownV = -1;
      render();
    },
    (why) => {
      dead = true;
      if (mic === m) mic = null;
      micState = 'off';
      if (why === 'taken') toast('Another device has the mic now.', 4000);
      shownV = -1;
      render();
    },
  );
  m.start();
  return {
    mic: m,
    attach: (t) => {
      if (dead) return;
      token = t;
      mic = m;
      void holdScreen();
    },
  };
}

async function stopMic(quiet = false): Promise<void> {
  const m = mic;
  mic = null;
  micState = 'off';
  if (m) await m.stop();
  if (!quiet) render();
}

async function listenHere(): Promise<void> {
  const m = startMic();
  try {
    const { mic: token } = await api<{ mic: string }>('live/mic', 'POST', {});
    await stopMic(true);
    m.attach(token);
  } catch (e) {
    void m.mic.stop();
    fail(e);
  }
}

async function stopRun(): Promise<void> {
  await stopMic(true); // the last phrase goes in first
  try {
    live = (await api<{ live: PrompterLive | null }>('live/stop', 'POST', {})).live;
  } catch (e) {
    fail(e);
  }
  setStage(false);
  shownV = -1;
  render();
  void holdScreen();
}

async function markPoint(p: CuePoint): Promise<void> {
  p.done = !p.done; // at once on screen; the next poll brings the server's view
  p.by = p.done ? 'hand' : null;
  shownV = -1;
  render();
  try {
    const r = await api<{ live: PrompterLive | null }>('live/mark', 'POST', { id: p.id, done: p.done });
    if (r.live) live = r.live;
  } catch (e) {
    fail(e);
  }
  shownV = -1;
  render();
}

function clock(): string {
  if (!live) return '0:00';
  const ms = (live.endedAt ?? Date.now() + skew) - live.startedAt;
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}

function renderClock(): void {
  if (!rootEl) return;
  runningEl.textContent = running() ? `● REC ${clock()}` : '';
  const c = runBox.querySelector('.cue-clock');
  if (c) c.textContent = live?.endedAt ? `ENDED ${clock()}` : clock();
}

function micLabel(): string {
  if (mic) return micState === 'on' ? 'MIC: THIS DEVICE' : micState === 'starting' ? 'MIC: STARTING…' : 'MIC: ENGINE LOADING…';
  return live?.mic === 'on' ? 'MIC: OTHER DEVICE' : 'MIC: OFF';
}

function renderRun(): void {
  shownV = live?.v ?? 0;
  if (!live) {
    runBox.replaceChildren(el('p', 'cue-empty', 'No recording yet. Write a list in LIST and press START.'));
    return;
  }
  const l = live;
  const open = l.points.filter((p) => !p.done);
  const done = l.points.filter((p) => p.done);
  const top = el('div', 'cue-top');
  const status = el('div', 'cue-status');
  const rec = el('span', l.endedAt ? 'cue-clock cue-dim' : 'cue-clock', l.endedAt ? `ENDED ${clock()}` : clock());
  const meter = el('span', 'cue-meter');
  meter.style.setProperty('--lvl', String(mic || l.mic === 'on' ? l.level : 0));
  status.append(rec, el('span', 'cue-count', `${done.length} / ${l.points.length}`));
  if (!l.endedAt) status.append(el('span', l.mic === 'on' || mic ? 'cue-mic' : 'cue-mic cue-warn', micLabel()), meter);
  if (!l.endedAt) status.append(el('span', engine.ready ? 'cue-dim' : 'cue-warn', engine.ready ? (l.error ? 'AUTO TICK: WAITING' : 'AUTO TICK') : 'TICK BY HAND'));
  const tools = el('div', 'cue-tools');
  if (!l.endedAt) {
    if (!mic) tools.append(button('LISTEN HERE', () => void listenHere()));
    tools.append(button(document.body.classList.contains('cue-stage') ? 'EXIT FULL' : 'FULL', () => setStage(!document.body.classList.contains('cue-stage'))));
    tools.append(button('STOP', () => void stopRun(), 'cue-stop'));
  } else {
    tools.append(button('CHECK AFTER', () => void afterFromSession(l.id)), button('NEW', () => ((view = 'list'), showView())));
  }
  top.append(status, tools);

  const list = el('ol', 'cue-points');
  for (const [i, p] of open.entries()) list.append(pointRow(p, i === 0 ? 'cue-next' : ''));
  if (!open.length) list.append(el('li', 'cue-all', 'ALL POINTS COVERED'));
  for (const p of done) list.append(pointRow(p, 'cue-done'));
  const heard = el('div', 'cue-heard', l.heard || (l.endedAt ? '' : mic && micState !== 'on' ? micNote || 'Starting the mic…' : 'Listening…'));
  const extra: HTMLElement[] = [];
  if (!l.endedAt && l.error) extra.push(el('div', 'cue-err', l.error));
  runBox.replaceChildren(top, list, ...extra, heard);
}

function pointRow(p: CuePoint, cls: string): HTMLElement {
  const li = el('li', `cue-point ${cls}`);
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  li.title = p.done ? 'Tap to put this point back' : 'Tap to tick this point';
  li.append(el('span', 'cue-mark', p.done ? '[x]' : cls === 'cue-next' ? '[>]' : '[ ]'));
  const body = el('span', 'cue-body');
  body.append(el('span', 'cue-ptext', p.text));
  if (p.note && !p.done) body.append(el('span', 'cue-pnote', p.note));
  li.append(body);
  if (p.done && p.by === 'hand') li.append(el('span', 'cue-by', 'BY HAND'));
  li.onclick = () => void markPoint(p);
  li.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void markPoint(p);
    }
  };
  return li;
}

// FULL: only the points on screen (the whole browser screen when it can; on phones the page itself).
function setStage(on: boolean): void {
  if (document.body.classList.contains('cue-stage') === on) return;
  document.body.classList.toggle('cue-stage', on);
  if (on && document.fullscreenEnabled && !document.fullscreenElement) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  if (!on && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  shownV = -1;
  render();
}

// Keep the screen on while it shows a running session (a phone on a stand would go dark).
async function holdScreen(): Promise<void> {
  const want = (isOpen && view === 'run' && running()) || !!mic;
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
  if (want && !wake && wl && document.visibilityState === 'visible') {
    wake = await wl.request('screen').catch(() => null);
  } else if (!want && wake) {
    const w = wake;
    wake = null;
    await w.release().catch(() => {});
  }
}

// ------------------------------------------------------------ AFTER

let afterPoints: HTMLTextAreaElement;
let afterText: HTMLTextAreaElement;
let afterList: HTMLSelectElement;
let afterSessions: HTMLSelectElement;
let afterStatus: HTMLElement;
let afterResult: HTMLElement;
let afterGo: HTMLButtonElement;
let afterToken = 0;

function buildAfter(): HTMLElement {
  const box = el('div', 'cue-after');
  box.append(el('p', 'cue-note', 'A finished recording against a list: which points it covered (with the words that did) and which it missed.'));

  afterList = el('select', 'cue-select');
  afterList.setAttribute('aria-label', 'Saved list');
  afterList.onchange = () => {
    const id = afterList.value;
    if (id) void api<PromptList>(`lists/${encodeURIComponent(id)}`).then((l) => (afterPoints.value = l.text), fail);
  };
  afterPoints = el('textarea', 'cue-text cue-after-points');
  afterPoints.rows = 6;
  afterPoints.placeholder = 'The points, one per line (or pick a saved list).';
  afterPoints.onkeydown = (e) => e.stopPropagation();
  const pointsHead = el('div', 'cue-row');
  pointsHead.append(el('h3', '', 'POINTS'), afterList);

  afterSessions = el('select', 'cue-select');
  afterSessions.setAttribute('aria-label', 'A recording made with PROMPTER');
  afterSessions.onchange = () => {
    if (afterSessions.value) void afterFromSession(afterSessions.value);
  };
  const fileText = el('input');
  fileText.type = 'file';
  fileText.accept = '.txt,.srt,.vtt,.md,text/plain';
  fileText.hidden = true;
  fileText.onchange = () => {
    const f = fileText.files?.[0];
    fileText.value = '';
    if (f) void f.text().then((t) => (afterText.value = t), fail);
  };
  const fileAudio = el('input');
  fileAudio.type = 'file';
  fileAudio.accept = 'audio/*,video/*';
  fileAudio.hidden = true;
  fileAudio.onchange = () => {
    const f = fileAudio.files?.[0];
    fileAudio.value = '';
    if (f) void transcribeFile(f);
  };
  const textHead = el('div', 'cue-row');
  textHead.append(el('h3', '', 'TRANSCRIPT'), afterSessions, button('TEXT FILE', () => fileText.click()), button('AUDIO FILE', () => fileAudio.click()), fileText, fileAudio);
  afterText = el('textarea', 'cue-text cue-after-text');
  afterText.rows = 10;
  afterText.placeholder = 'Paste the transcript here: plain text, a YouTube transcript with times, or SRT / VTT captions.';
  afterText.onkeydown = (e) => e.stopPropagation();

  afterGo = button('CHECK', () => void runAfter(), 'primary cue-go');
  afterStatus = el('span', 'cue-dim');
  const goRow = el('div', 'cue-row');
  goRow.append(afterGo, afterStatus);
  afterResult = el('div', 'cue-after-result');
  box.append(pointsHead, afterPoints, textHead, afterText, goRow, afterResult);
  return box;
}

async function fillAfterPickers(): Promise<void> {
  try {
    const [{ lists: ls }, { sessions }] = await Promise.all([
      api<{ lists: PromptListSummary[] }>('lists'),
      api<{ sessions: { id: string; name: string; startedAt: number; words: number }[] }>('sessions'),
    ]);
    afterList.replaceChildren(new Option('SAVED LIST…', ''), ...ls.map((l) => new Option(l.name, l.id)));
    const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    afterSessions.replaceChildren(new Option('A PROMPTER RECORDING…', ''), ...sessions.map((s) => new Option(`${s.name}, ${when(s.startedAt)}, ${s.words} words`, s.id)));
  } catch {
    /* the pickers stay empty */
  }
}

async function afterFromSession(id: string): Promise<void> {
  view = 'after';
  showView();
  try {
    const s = await api<{ list: string; text: string }>(`sessions/${encodeURIComponent(id)}`);
    afterPoints.value = s.list;
    afterText.value = s.text;
    if (!s.text.trim()) toast('That recording has no words saved.', 3000);
  } catch (e) {
    fail(e);
  }
}

async function runAfter(): Promise<void> {
  if (!parsePoints(afterPoints.value).length) return void toast('Write the points first, one per line.');
  if (!afterText.value.trim()) return void toast('Paste or load the transcript first.');
  const mine = ++afterToken;
  afterGo.disabled = true;
  afterResult.replaceChildren();
  afterStatus.textContent = 'CHECKING…';
  try {
    const { id } = await api<{ id: string }>('after', 'POST', { points: afterPoints.value, transcript: afterText.value });
    for (;;) {
      await new Promise((r) => setTimeout(r, AFTER_POLL_MS));
      if (mine !== afterToken) return;
      const job = await api<AfterJob>(`after/${id}`);
      afterStatus.textContent = job.state === 'running' ? `CHECKING… ${job.done} / ${job.total}` : job.state === 'done' ? `DONE${job.by ? `, BY ${job.by}` : ''}` : '';
      if (job.state === 'error') throw new Error(job.error);
      if (job.state === 'done') {
        renderAfter(job);
        break;
      }
    }
  } catch (e) {
    afterStatus.textContent = '';
    fail(e);
  } finally {
    if (mine === afterToken) afterGo.disabled = false;
  }
}

function renderAfter(job: AfterJob): void {
  const covered = job.points.filter((p) => p.covered);
  const missed = job.points.filter((p) => !p.covered);
  const part = (title: string, items: AfterJob['points'], cls: string) => {
    const sec = el('div', `cue-after-part ${cls}`);
    sec.append(el('h3', '', `${title} (${items.length})`));
    for (const p of items) {
      const row = el('div', 'cue-after-row');
      const head = el('div', 'cue-after-head');
      head.append(el('span', 'cue-mark', p.covered ? '[x]' : '[ ]'), el('span', 'cue-strong', p.text));
      if (p.at) head.append(el('span', 'cue-dim', `AT ${p.at}`));
      row.append(head);
      if (p.quote) row.append(el('blockquote', 'cue-quote', p.quote));
      sec.append(row);
    }
    if (!items.length) sec.append(el('p', 'cue-dim', 'None.'));
    return sec;
  };
  afterResult.replaceChildren(part('MISSED', missed, 'cue-missed'), part('COVERED', covered, 'cue-covered'));
}

// An audio or video file to text on the PC: decoded here at 16 kHz, cut at quiet moments into pieces the one-shot
// path takes (POST /api/transcribe, the same engine as DICTATE), one piece at a time.
async function transcribeFile(f: File): Promise<void> {
  if (isDemo()) return void toast('Not in demo mode.', 2000);
  const mine = ++afterToken;
  afterGo.disabled = true;
  afterStatus.textContent = 'READING THE FILE…';
  try {
    const ctx = new OfflineAudioContext(1, 1, 16000);
    const buf = await ctx.decodeAudioData(await f.arrayBuffer());
    const ch = buf.getChannelData(0);
    const pieces = cutPieces(ch);
    const lines: string[] = [];
    for (const [i, [a, b]] of pieces.entries()) {
      if (mine !== afterToken) return;
      afterStatus.textContent = `TRANSCRIBING ${i + 1} / ${pieces.length}…`;
      const r = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav(ch.subarray(a, b)) });
      const data = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!r.ok) throw new Error(data.error ?? `The server said ${r.status}.`);
      const s = Math.floor(a / 16000);
      if (data.text?.trim()) lines.push(`[${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}] ${data.text.trim()}`);
    }
    afterText.value = lines.join('\n');
    afterStatus.textContent = lines.length ? 'TRANSCRIPT READY' : 'NO WORDS HEARD';
  } catch (e) {
    afterStatus.textContent = '';
    fail(e instanceof DOMException ? new Error('This browser could not read that file. Try a WAV, MP3 or M4A.') : e);
  } finally {
    if (mine === afterToken) afterGo.disabled = false;
  }
}

function wav(x: Float32Array): Blob {
  const pcm = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
  const v = new DataView(new ArrayBuffer(44));
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  return new Blob([v, pcm], { type: 'audio/wav' });
}

