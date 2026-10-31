// Clickable paths in chat replies, the desktop app's half: turn a path as written in a reply into a real absolute
// path (`~`, relative to the chat's folder, file:// addresses), say which of a batch exist, and open one. Which words
// look like paths and which files may be opened is in shared/pathlinks.mjs (pure, tested for all three OSes). The
// page only ever sends text; nothing here runs a program: openPath hands a file to the system's default app, and
// anything that could run code is shown in its folder instead.

import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { MAX_CANDIDATES, canOpen, fileUrlPath } from '../shared/pathlinks.mjs';

const flavour = (platform) => (platform === 'win32' ? path.win32 : path.posix);

// The absolute, normalised path for `raw` (as written in a reply), or null. cwd: the chat's folder (relative paths
// need an absolute one). home: the user's home for `~`.
export function resolveRaw(raw, cwd, home, platform) {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || raw.includes('\0')) return null;
  const p = flavour(platform);
  let s = raw;
  if (/^file:\/\//i.test(s)) {
    s = fileUrlPath(s, platform);
    if (!s) return null;
  }
  if (platform === 'win32' && /[<>"|?*]/.test(s)) return null;
  if (platform === 'win32' && s.slice(2).includes(':')) return null; // C:\a.txt:stream, not a file name
  let abs;
  if (s === '~' || /^~[\\/]/.test(s)) {
    if (!home || !p.isAbsolute(home) || (platform !== 'win32' && s.includes('\\'))) return null;
    abs = p.join(home, s.slice(1));
  } else if (platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/])/.test(s) : s.startsWith('/')) {
    abs = p.normalize(s);
  } else {
    if (s[0] === '~' || !p.isAbsolute(cwd || '')) return null;
    abs = p.resolve(cwd, s);
  }
  // Keep the root's own slash ("/", "C:\"), drop a trailing one elsewhere.
  return abs.length > p.parse(abs).root.length ? abs.replace(/[\\/]+$/, '') : abs;
}

// For a batch of candidates: an array alongside it with { path, kind: 'file' | 'dir' } for each that exists, else
// null. At most MAX_CANDIDATES are looked at (the rest are null).
export async function statPaths(cwd, list, platform = process.platform, home = homedir()) {
  if (!Array.isArray(list)) return [];
  const c = typeof cwd === 'string' ? cwd : '';
  return Promise.all(
    list.map(async (raw, i) => {
      if (i >= MAX_CANDIDATES) return null;
      const abs = resolveRaw(raw, c, home, platform);
      const st = abs && (await stat(abs).catch(() => null));
      if (!st) return null;
      return st.isDirectory() ? { path: abs, kind: 'dir' } : st.isFile() ? { path: abs, kind: 'file' } : null;
    }),
  );
}

// What to do for a click on an absolute path: 'open' (default app / file manager for a folder), 'show' (select it
// in its folder: it could run code), or null (not there). A link is judged by its own name AND by what it points at.
export async function openDecision(abs, platform = process.platform) {
  const st = await stat(abs).catch(() => null);
  if (!st || !(st.isFile() || st.isDirectory())) return null;
  const real = await realpath(abs).catch(() => abs);
  const rst = real === abs ? st : (await stat(real).catch(() => null)) ?? st;
  return canOpen(abs, st.isDirectory(), st.mode, platform) && canOpen(real, rst.isDirectory(), rst.mode, platform) ? 'open' : 'show';
}

// The click: shell is Electron's `shell`. Resolves 'opened', 'shown', or false.
export async function openPathLink(shell, abs, platform = process.platform) {
  if (typeof abs !== 'string' || !path[platform === 'win32' ? 'win32' : 'posix'].isAbsolute(abs) || abs.includes('\0')) return false;
  const what = await openDecision(abs, platform);
  if (!what) return false;
  if (what === 'open') return (await shell.openPath(abs)) === '' ? 'opened' : false;
  shell.showItemInFolder(abs);
  return 'shown';
}
