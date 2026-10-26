// DICTATE in any app: the rules every way of dictating into another program shares. Plain JavaScript with no
// imports, so the desktop app (shell/dictate.mjs), the Linux take (os/omarchy/clock/phosphor-dictate-live.mjs,
// which loads it from the app's folder), the floating mic page and the tests all use the same code.

// The settings, shared by the floating mic (its right-click menu), SETTINGS in the app and the take:
// ~/.config/phosphor-os/dictate.json = { icon, cleanup, screen, x, y } (x, y: where the mic sits, 0..1 of the
// room on that screen). Unknown or broken values fall back to these.
export const SETTINGS_DEFAULTS = { icon: true, cleanup: false };

export function settingsFile(home) {
  return `${home}/.config/phosphor-os/dictate.json`;
}

export function readSettings(text) {
  let s = {};
  try {
    s = JSON.parse(text);
  } catch {
    /* none yet, or broken: the defaults */
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  return { ...s, icon: s.icon !== false, cleanup: s.cleanup === true };
}

// Terminal emulators, by window class. Omarchy also tags its terminals "terminal" (default/hypr/apps/terminals.lua).
const TERMINALS =
  /^(?:alacritty|kitty|foot(?:client)?|org\.codeberg\.dnkl\.foot(?:client)?|com\.mitchellh\.ghostty|(?:org\.wezfurlong\.)?wezterm(?:-gui)?|(?:org\.kde\.)?konsole|org\.gnome\.(?:terminal|console|ptyxis)|gnome-terminal(?:-server)?|kgx|ptyxis|xterm|uxterm|urxvt|st(?:-256color)?|terminator|(?:com\.gexperts\.)?tilix|xfce4-terminal|lxterminal|qterminal|sakura|termite|rio|contour|(?:dev\.warp\.)?warp|org\.omarchy\..+|tui\..+)$/i;

// win: the focused window as `hyprctl activewindow -j` gives it ({ class, initialClass, tags }).
export function isTerminal(win) {
  if (!win || typeof win !== 'object') return false;
  if (Array.isArray(win.tags) && win.tags.some((t) => String(t).replace(/\*$/, '') === 'terminal')) return true;
  return [win.class, win.initialClass].some((c) => typeof c === 'string' && TERMINALS.test(c));
}

// The paste shortcut the focused program takes, with Hyprland's modifier names. Terminals on Linux paste with
// Ctrl+Shift+V (Ctrl+V is a control character there); a Mac pastes with Command+V everywhere.
export function pasteKeys(platform, win) {
  if (platform === 'darwin') return { mods: 'SUPER', key: 'v' };
  if (platform === 'linux' && isTerminal(win)) return { mods: 'CTRL SHIFT', key: 'v' };
  return { mods: 'CTRL', key: 'v' };
}

// The words as the focused program gets them: a terminal gets one line, since a line break there runs the line before
// it as a command wherever the shell does not guard pastes (CLEAN UP may answer in paragraphs).
export function pasteWords(platform, win, text) {
  const t = String(text ?? '');
  return platform === 'linux' && isTerminal(win) ? t.replace(/\s*[\x00-\x1f\x7f-\x9f]+\s*/g, ' ') : t;
}

// One more phrase onto the text so far, as the app's DICTATE joins them: a capital at a sentence start, one space
// between. joinPrev: the speech engine heard no sentence end at the last pause, so that period goes.
export function joinPhrase(text, raw, joinPrev = false) {
  let t = String(raw ?? '').trim();
  if (!t) return text;
  if (joinPrev) text = text.replace(/([^.])\.\s*$/, '$1');
  if (!text.trim() || /[.!?]["')\]]?\s*$/.test(text)) t = t.charAt(0).toUpperCase() + t.slice(1);
  return text ? `${text.replace(/\s*$/, '')} ${t}` : t;
}

// The finished words as they go into the other program: a space after a sentence end, so the next take does not
// run into this one.
export function finalText(text) {
  const t = String(text ?? '').trim();
  return /[.!?]["')\]]?$/.test(t) ? `${t} ` : t;
}

export const CLEANUP_TIMEOUT_MS = 15_000;

// CLEAN UP (optional): the server tidies the words (POST /api/voice/cleanup, style "plain"). Whatever goes wrong
// (no such endpoint yet: 404, an error, no answer, too slow, an empty answer), the words go in as they were.
// Returns { text, cleaned, by, error }. fetchImpl and headers: the take script sends its login cookie; tests fake it.
export async function cleanUp(text, { url = '', headers = {}, fetchImpl = fetch, timeoutMs = CLEANUP_TIMEOUT_MS } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { text: raw, cleaned: false, by: '', error: '' };
  try {
    const res = await fetchImpl(`${url}/api/voice/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ text: raw, style: 'plain' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && typeof data?.text === 'string' && data.text.trim()) {
      return { text: data.text.trim(), cleaned: true, by: typeof data.by === 'string' ? data.by : '', error: '' };
    }
    const why = res.status === 404 ? 'not on this server yet' : typeof data?.error === 'string' && data.error ? data.error : `error ${res.status}`;
    return { text: raw, cleaned: false, by: '', error: why };
  } catch (e) {
    return { text: raw, cleaned: false, by: '', error: e?.name === 'TimeoutError' ? 'took too long' : 'no answer' };
  }
}
