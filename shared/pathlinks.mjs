// Clickable paths in chat replies: which words of a reply look like a file or folder path, and which files the
// desktop app may open (anything that could run code is only shown in its folder). Pure: no fs, no DOM. The page
// finds candidates here and asks the desktop app (shell/pathlinks.mjs) which of them exist; only those become links.
// platform is process.platform of the desktop app: 'linux', 'darwin' or 'win32'.

export const MAX_CANDIDATES = 50;
const MAX_LEN = 1024;

// Endings that could run code, on any OS (a document on the same PC can be shared with another): never opened,
// only shown in their folder. Includes folders that are programs (.app on macOS).
const RUNNABLE = new Set(
  ('exe msi bat cmd com ps1 psm1 psd1 vbs vbe vb wsf wsh ws js jse hta scr lnk url reg jar app command desktop appimage ' +
    'sh bash zsh run bin pkg dmg deb rpm apk py pyw pl rb php cpl msc msp pif scf inf appref-ms gadget ' +
    'workflow action scpt scptd terminal tool prefpane').split(' '),
);

// The ending of a file name, lower-case, '' when none. On Windows trailing dots and spaces do not count
// ("setup.exe." is setup.exe there).
export function extOf(path, platform) {
  let name = path.split(platform === 'win32' ? /[\\/]/ : '/').pop() ?? '';
  if (platform === 'win32') name = name.replace(/[. ]+$/, '');
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// Whether the desktop app may open this by its default program. `mode` is the file mode (the execute bit counts on
// Linux and macOS). A folder is opened in the file manager, except one that is a program (.app).
export function canOpen(path, isDir, mode, platform) {
  if (RUNNABLE.has(extOf(path, platform))) return false;
  if (platform !== 'win32' && !isDir && typeof mode === 'number' && (mode & 0o111) !== 0) return false;
  return true;
}

const TRAIL = /[.,;:!?)\]}>'"*\u2026]+$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// "path:12", "path:12:3" and "path#L12" to { path, line, col }. Trailing punctuation goes first and last.
function splitLine(s) {
  let t = s.replace(TRAIL, '');
  let line = 0;
  let col = 0;
  let m = /^(.+?):(\d+)(?::(\d+))?$/.exec(t) ?? /^(.+?)#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/.exec(t);
  if (m) {
    t = m[1].replace(TRAIL, '');
    line = Number(m[2]);
    col = m[3] ? Number(m[3]) : 0;
  }
  return { path: t, line, col, len: s.replace(TRAIL, '').length };
}

const DRIVE = /^[a-zA-Z]:[\\/]/;
const UNC = /^\\\\[^\\/\s]/;

// The shape of a path on this OS. loose: inline code and link targets, where a lone name with an ending
// ("README.md") or a dotfile counts; plain text needs an ending of 2 to 8 characters that starts with a letter.
function looksLikePath(p, platform, loose) {
  if (!p || p.length > MAX_LEN || p.includes('\0')) return false;
  const win = platform === 'win32';
  if (/^file:\/\//i.test(p)) return p.length > 8;
  if (SCHEME.test(p)) return false;
  if (p.startsWith('//')) return false;
  if (p[0] === '/' || p.startsWith('~/') || (win && (p.startsWith('~\\') || DRIVE.test(p) || UNC.test(p)))) return p.length > 1 && p !== '~/';
  if (/^\.\.?[\\/]/.test(p) && (win || p.includes('/'))) return p.length > 2;
  const sep = win ? /[\\/]/ : /\//;
  if (sep.test(p)) {
    const segs = p.split(sep);
    if (segs.length < 2 || segs[0] === '') return false;
    // "and/or" passes too: the desktop app's check that the file exists is what keeps false links out
    return segs.slice(0, -1).every((s) => s !== '') && /[A-Za-z]/.test(p);
  }
  if (loose) return /^[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(p) || /^\.[A-Za-z][\w.-]*$/.test(p);
  return /^[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{1,7}$/.test(p); // not "e.g" or "i.e"
}

// All paths in a piece of plain text: [{ start, end, raw, line, col }]. `raw` as written (no :line, no trailing
// punctuation); the text from start to end is what becomes the link. Words with spaces are not found here (inline
// code has inlineCodePath).
export function scanPaths(text, platform) {
  const out = [];
  const win = platform === 'win32';
  const word = win ? /[^\s()[\]{}<>"'`,;|*?]+/g : /[^\s()[\]{}<>"'`,;|*?\\]+/g;
  for (const m of text.matchAll(word)) {
    const { path, line, col, len } = splitLine(m[0]);
    if (!looksLikePath(path, platform, false)) continue;
    out.push({ start: m.index, end: m.index + len, raw: path, line, col });
  }
  return out;
}

// The path an inline code span holds as a whole, or null: { raw, line, col }. A name with spaces counts only when it
// starts like a path (/, ~/, C:\, ./).
export function inlineCodePath(text, platform) {
  const t = text.trim();
  if (!t || t.includes('\n')) return null;
  const { path, line, col } = splitLine(t);
  const spaced = /\s/.test(path);
  if (spaced && !(path[0] === '/' || path.startsWith('~/') || path.startsWith('./') || (platform === 'win32' && (DRIVE.test(path) || UNC.test(path))))) return null;
  if (spaced ? path.length > MAX_LEN : !looksLikePath(path, platform, true)) return null;
  if (spaced && SCHEME.test(path)) return null;
  return { raw: path, line, col };
}

// What a markdown link points at, or null when it is a web address, mail, an in-page anchor, and so on:
// { raw, line, col }. href is the text of the link target as marked writes it.
export function linkTargetPath(href, platform) {
  if (typeof href !== 'string' || !href || href[0] === '#' || href[0] === '?') return null;
  let h = href;
  try {
    h = decodeURI(href);
  } catch {}
  if (/^file:\/\//i.test(h)) return { raw: h, line: 0, col: 0 };
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) && !DRIVE.test(h)) return null; // https:, mailto:, javascript:
  const { path, line, col } = splitLine(h);
  const raw = path.replace(/^<|>$/g, '');
  if (!looksLikePath(raw, platform, true)) return null;
  return { raw, line, col };
}

// "file:///home/a%20b/c" to "/home/a b/c"; "file:///C:/x" to "C:/x"; "file://host/share/x" to "\\host\share\x" on
// Windows; null for anything else (a host on Linux and macOS).
export function fileUrlPath(url, platform) {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(url);
  if (!m) return null;
  let p;
  try {
    p = decodeURIComponent(m[2] ?? '/');
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  const host = m[1];
  if (host && host.toLowerCase() !== 'localhost') return platform === 'win32' ? `\\\\${host}${p.replace(/\//g, '\\')}` : null;
  if (platform === 'win32') return /^\/[a-zA-Z]:/.test(p) ? p.slice(1) : null;
  return p;
}
