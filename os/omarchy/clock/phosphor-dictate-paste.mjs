// DICTATE in any app (Linux): put the words into the focused program at its cursor, for phosphor-dictate-live.mjs.
// 1. The words go on the clipboard, marked sensitive so Omarchy's clipboard history skips them.
// 2. The program gets its paste key (shared/dictate.mjs pasteKeys: Ctrl+V, Ctrl+Shift+V in a terminal), sent by
//    Hyprland (send_key_state, down and up apart, as Omarchy's own universal paste does: the user's held keys do not
//    mix in), or by wtype where this is not Hyprland.
// 3. A moment later the clipboard gets back what it held before, if it still holds our words.
// No program has the keyboard, or another one than when the take stopped: the words stay on the clipboard, to paste by
// hand. Needs wl-clipboard (wl-copy,
// wl-paste). `run` and `sleep` are only there so tests can stand in for the tools.
import { spawnSync } from 'node:child_process';

const RESTORE_MS = 1000; // time for the program to read the clipboard after the key
const TEXT = 'text/plain;charset=utf-8';

function runTool(cmd, args, { input, binary = false } = {}) {
  // stdout only: wl-copy leaves a copy of itself running in the background to serve the clipboard, and that copy
  // must not hold our pipes open (spawnSync would wait for it).
  const r = spawnSync(cmd, args, {
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    encoding: binary ? 'buffer' : 'utf8',
    timeout: 3000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.error ? -1 : r.status, stdout: r.stdout ?? (binary ? Buffer.alloc(0) : '') };
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const hyprland = () => !!process.env.HYPRLAND_INSTANCE_SIGNATURE;

// The focused window ({ class, initialClass, tags, address }), null when none has the keyboard, {} when unknown.
function activeWindow(run) {
  if (!hyprland()) return {};
  const r = run('hyprctl', ['activewindow', '-j']);
  if (r.status !== 0) return {};
  try {
    const w = JSON.parse(r.stdout);
    return w && typeof w === 'object' && w.address ? w : null;
  } catch {
    return {};
  }
}

// The focused window's address now: '' when none has the keyboard, undefined when unknown (not Hyprland).
export function focusedWindow(run = runTool) {
  const w = activeWindow(run);
  return w === null ? '' : w.address;
}

const readText = (run) => {
  const r = run('wl-paste', ['--no-newline', '--type', 'text']);
  return r.status === 0 ? r.stdout : null;
};

const copy = (run, text, sensitive) => run('wl-copy', [...(sensitive ? ['--sensitive'] : []), '--type', TEXT], { input: text }).status === 0;

// What the clipboard holds now, to put back afterwards: one type (a picture, a copied file, else text), and whether
// it was marked sensitive (a password manager's), which it keeps. null: could not read it, so it is left alone.
function saveClipboard(run) {
  const r = run('wl-paste', ['--list-types']);
  if (r.status !== 0) return { empty: true };
  const types = String(r.stdout).split('\n').map((t) => t.trim()).filter(Boolean);
  if (!types.length) return { empty: true };
  const sensitive = types.includes('x-kde-passwordManagerHint');
  const type = types.find((t) => t.startsWith('image/')) ?? types.find((t) => t === 'text/uri-list') ?? (types.some((t) => t.startsWith('text/') || /STRING$/.test(t)) ? 'text' : types[0]);
  const data = run('wl-paste', ['--no-newline', '--type', type], { binary: true });
  if (data.status !== 0) return null;
  return { type: type === 'text' ? TEXT : type, data: data.stdout, sensitive };
}

function restore(run, saved) {
  if (!saved) return;
  if (saved.empty) run('wl-copy', ['--clear']);
  else run('wl-copy', [...(saved.sensitive ? ['--sensitive'] : []), '--type', saved.type], { input: saved.data });
}

async function sendKeys(run, sleep, { mods, key }) {
  if (hyprland()) {
    const send = (state) => run('hyprctl', ['dispatch', `hl.dsp.send_key_state({ mods = "${mods}", key = "${key}", state = "${state}" })`]);
    const down = send('down');
    if (down.status === 0 && String(down.stdout).trim().startsWith('ok')) {
      await sleep(40);
      send('up');
      return true;
    }
  }
  const m = mods.toLowerCase().split(/\s+/).filter(Boolean).map((x) => (x === 'super' ? 'logo' : x));
  return run('wtype', [...m.flatMap((x) => ['-M', x]), '-k', key, ...[...m].reverse().flatMap((x) => ['-m', x])]).status === 0;
}

// -> { ok, copied?, moved?, keys?, why? }. keysFor(win): the paste shortcut for that window (shared/dictate.mjs
// pasteKeys); wordsFor(win, text): the words as that window gets them (pasteWords). target: focusedWindow() when the
// take stopped; when another window has the keyboard now (moved), the words only go on the clipboard.
export async function pasteText(text, { keysFor, wordsFor = (_win, t) => t, target, run = runTool, sleep = wait, restoreMs = RESTORE_MS }) {
  const win = activeWindow(run);
  const moved = !!win && target !== undefined && win.address !== undefined && win.address !== target;
  if (!win || moved) return copy(run, text, false) ? { ok: true, copied: true, moved } : { ok: false, why: 'NO CLIPBOARD' };
  const keys = keysFor(win);
  text = wordsFor(win, text);
  const saved = saveClipboard(run);
  if (!copy(run, text, true)) return { ok: false, why: 'NO CLIPBOARD' };
  // wl-copy hands the clipboard to its background copy as it exits: wait until the clipboard holds the words.
  for (let i = 0; i < 10 && readText(run) !== text; i++) await sleep(30);
  if (!(await sendKeys(run, sleep, keys))) return { ok: true, copied: true };
  await sleep(restoreMs);
  if (readText(run) === text) restore(run, saved);
  return { ok: true, keys };
}
