import './cleanup.css';
import { CLEANUP_MAX_CHARS, type CleanupStyle } from '../../shared/cleanup.ts';
import { demoCleanup } from './demo.ts';
import { store } from './store.ts';
import { button, el, toast } from './ui.ts';

// CLEAN UP: messy dictated or typed text becomes a clean request. The CLEAN UP button next to DICTATE (and in the
// first-message box of the new chat and project dialogs) sends the text to POST /api/voice/cleanup (server/cleanup.ts:
// the local model when it is in memory, else Haiku) and puts the answer in the box. An UNDO chip shows for a few
// seconds above the box; Ctrl+Z puts the old text back for as long as the box still holds the cleaned text. A failed
// clean-up leaves the text alone and says why in a toast.
//
// SETTINGS > CLEAN UP AFTER DICTATING (this browser only): voice.ts holds each take's words back, cleans them in one
// piece when the take ends, and puts the clean text in the box (offerUndo brings the words as spoken back).

const KEY = 'phosphor.cleanup';
const UNDO_MS = 10_000;
const FETCH_MS = 80_000; // the server's own limits add up to 72 s

type Cleaned = { text: string; by: string };

let auto = loadAuto();
let dictating = false; // a take is running, or its words are being turned into text
const syncs = new Set<() => void>();

function loadAuto(): boolean {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}')?.auto === true;
  } catch {
    return false;
  }
}

// Each finished dictation is cleaned before it goes in the box (voice.ts asks).
export const autoCleanOn = (): boolean => auto;

// voice.ts: a dictation is running (CLEAN UP waits until it ends, so the words it cleans are all there).
export function setDictating(on: boolean): void {
  if (dictating === on) return;
  dictating = on;
  for (const f of syncs) f();
}

// ---- Asking the server ----

function serverError(status: number, msg?: string): string {
  if (status === 404) return 'The server update for CLEAN UP has not loaded yet. Reload in a minute.';
  if (status === 401) return 'Logged out. Reload the page and log in.';
  return msg || `Clean up failed (error ${status}).`;
}

// The clean text, or an Error whose message says what to tell the user (the text stays as it was). `signal`: the caller
// cancelling it throws the browser's AbortError.
export async function cleanText(text: string, style: CleanupStyle = 'prompt', signal?: AbortSignal): Promise<Cleaned> {
  if (store.demo) {
    await new Promise((wait) => setTimeout(wait, 900));
    return demoCleanup(text);
  }
  let res: Response;
  try {
    res = await fetch('/api/voice/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, style }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_MS)]) : AbortSignal.timeout(FETCH_MS),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error(e instanceof DOMException && e.name === 'TimeoutError' ? 'Clean up took too long.' : 'Could not reach the server.');
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string; by?: string; error?: string };
  if (!res.ok || typeof data.text !== 'string' || typeof data.by !== 'string') throw new Error(serverError(res.status, data.error));
  return { text: data.text, by: data.by };
}

// ---- A box that changes by script too ----

// The message box also changes when a tab's draft comes back, after SEND, or when a path is inserted: none of that
// fires an input event. So `value` reports every change itself (once per box), and so does the input event.
const watchers = new WeakMap<HTMLTextAreaElement, (() => void)[]>();
function watch(box: HTMLTextAreaElement, fn: () => void): void {
  let list = watchers.get(box);
  if (!list) {
    const all: (() => void)[] = [];
    list = all;
    watchers.set(box, all);
    const run = () => all.forEach((f) => f());
    box.addEventListener('input', run);
    const own = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
    Object.defineProperty(box, 'value', {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return own.get!.call(this) as string;
      },
      set(this: HTMLTextAreaElement, v: string) {
        own.set!.call(this, v);
        run();
      },
    });
  }
  list.push(fn);
}

function setBox(box: HTMLTextAreaElement, value: string): void {
  box.value = value;
  box.setSelectionRange(value.length, value.length);
  box.dispatchEvent(new Event('input', { bubbles: true })); // chat.ts saves the draft and resizes the box
}

// ---- The UNDO chip ----

type Note = { show: (before: string, after: string, by: string) => void };
const notes = new WeakMap<HTMLTextAreaElement, Note>();

// One chip per box, made when first needed: a line above the box with "CLEANED BY ..." and UNDO.
function noteFor(box: HTMLTextAreaElement): Note {
  const have = notes.get(box);
  if (have) return have;
  let state: { before: string; after: string } | null = null; // what UNDO puts back, while the box still holds `after`
  let timer = 0;
  const line = el('div', 'clean-note');
  line.hidden = true;
  const label = el('span', 'clean-note-text');
  const hide = () => {
    clearTimeout(timer);
    line.hidden = true;
  };
  const undo = () => {
    if (!state || box.value !== state.after) return;
    const { before } = state;
    state = null;
    hide();
    setBox(box, before);
    if (matchMedia('(pointer: fine)').matches) box.focus();
  };
  const chip = button('UNDO', undo, 'clean-undo');
  chip.title = 'Put the text back as it was (Ctrl+Z)';
  line.append(label, chip);
  box.before(line);
  // Anything typed or changed after the clean-up ends the chip: the old text would wipe out the new.
  watch(box, () => {
    if (state && box.value !== state.after) {
      state = null;
      hide();
    }
  });
  box.addEventListener('keydown', (e) => {
    if (!state || e.isComposing || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return;
    e.preventDefault();
    undo();
  });
  const note: Note = {
    show(before, after, by) {
      state = { before, after };
      label.textContent = `CLEANED BY ${by.toUpperCase()}`;
      line.hidden = false;
      clearTimeout(timer);
      timer = window.setTimeout(hide, UNDO_MS);
    },
  };
  notes.set(box, note);
  return note;
}

// The box now holds the cleaned text (`after`); UNDO and Ctrl+Z bring `before` back.
export function offerUndo(box: HTMLTextAreaElement, before: string, after: string, by: string): void {
  noteFor(box).show(before, after, by);
}

// ---- The button ----

// Wire a CLEAN UP button to a text box. style: what the text is for ("prompt": a request to an AI agent).
// Returns what to call when the button goes away (a dialog's), so it is not kept alive here.
export function mountCleanup(btn: HTMLButtonElement, box: HTMLTextAreaElement, style: CleanupStyle = 'prompt'): () => void {
  btn.classList.add('clean-btn');
  const long = el('span', 'clean-long', 'CLEAN UP');
  const short = el('span', 'clean-short', 'CLEAN');
  btn.replaceChildren(long, short);
  btn.title = 'Clean up the text: filler words, restarts and spoken corrections go, and it reads as a clear request. Undo with Ctrl+Z.';
  noteFor(box);
  let working = false;
  const sync = () => {
    btn.disabled = dictating || !box.value.trim();
    btn.classList.toggle('on', working);
    btn.dataset.state = working ? 'busy' : 'idle';
    btn.setAttribute('aria-busy', String(working));
    long.textContent = working ? 'CLEANING…' : 'CLEAN UP';
    short.textContent = working ? 'WAIT…' : 'CLEAN';
  };
  syncs.add(sync);
  watch(box, sync);
  sync();

  btn.onclick = async () => {
    const before = box.value;
    const text = before.trim();
    if (!text || working || dictating) return;
    if (text.length > CLEANUP_MAX_CHARS) return toast(`Too long for CLEAN UP: ${CLEANUP_MAX_CHARS} characters at most.`, 5000);
    const tab = store.active;
    working = true;
    sync();
    try {
      const r = await cleanText(text, style);
      if (box.value !== before || store.active !== tab) toast('The text changed while it was being cleaned, so it was left alone.', 5000);
      else if (r.text === text) toast('Nothing to clean up: it already reads fine.', 3000);
      else {
        setBox(box, r.text);
        offerUndo(box, before, r.text, r.by);
        if (matchMedia('(pointer: fine)').matches) box.focus();
      }
    } catch (e) {
      toast(`${e instanceof Error ? e.message : 'Clean up failed.'} Your text is unchanged.`, 6000);
    } finally {
      working = false;
      sync();
    }
  };
  return () => void syncs.delete(sync);
}

// ---- SETTINGS ----

// SETTINGS > CLEAN UP AFTER DICTATING. settings.ts adds this section with one line.
export function cleanupSection(): HTMLElement {
  const box = el('div', 'set-cleanup');
  const on = button('ON', () => set(true));
  const off = button('OFF', () => set(false));
  on.title = 'Each finished dictation is cleaned before it goes in the message box';
  off.title = 'Dictation goes in as spoken (CLEAN UP is still there to press)';
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Clean up after dictating');
  seg.append(on, off);
  const sync = () => {
    for (const [b, v] of [[on, true], [off, false]] as const) {
      b.classList.toggle('on', auto === v);
      b.setAttribute('aria-pressed', String(auto === v));
    }
  };
  const set = (v: boolean) => {
    auto = v;
    try {
      localStorage.setItem(KEY, JSON.stringify({ auto }));
    } catch {
      /* storage blocked: it works until reload */
    }
    sync();
  };
  sync();
  const row = el('div', 'set-row');
  row.append(el('div', 'set-label', 'CLEAN UP AFTER DICTATING'), seg, el('div', 'clean-help', 'Fillers, restarts and spoken corrections are taken out before the words go in the box. UNDO brings them back as spoken.'));
  box.append(row);
  return box;
}
