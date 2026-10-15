// The launcher's INSTALLED and GAMES lists (web/src/launcher.ts): programs installed on this PC and the
// Steam library. Plain Node, so it also runs outside Electron (tests); Electron's shell is passed in.
//
// - Windows: Start Menu shortcuts (.lnk), for everyone and for this user. Linux: .desktop files (XDG data
//   dirs, flatpak exports), following the freedesktop rules (NoDisplay, Hidden, TryExec, OnlyShowIn).
// - Steam: libraryfolders.vdf and appmanifest_*.acf in every library, minus tools (Proton, runtimes).
// - The page only gets { id, name, hint, words, icon } and sends back an id. Ids are hashes of the path, so
//   they stay the same between scans. A launch looks the id up in this file's own scan: the page never
//   sends a path or a command.
// - Launch: Windows shell.openPath(<the .lnk>); Linux `gio launch <file>` (else gtk-launch <id>), never a
//   command built from Exec=; games steam://rungameid/<appid>, only for appids found in the scan.
// - Scans are cached; asking again after STALE_MS gives the old list at once and scans again in the background.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, extname, isAbsolute, join, relative, sep } from 'node:path';

const STALE_MS = 5 * 60 * 1000;
const MAX_ITEMS = 1500;
const MAX_DEPTH = 6;
const WIN = process.platform === 'win32';

// Start Menu links that are not programs to run.
const NOT_A_PROGRAM = /\b(un-?install\w*|uninst\w*|unistall\w*|help|read ?me|documentation|module docs|manuals?|release notes|change ?log|licen[cs]e|website|on the web|support center|faq)\b/i;
// Steam "apps" that are tools, not games.
const NOT_A_GAME = /^(steamworks common redistributables|steamworks sdk redist|proton\b|steam linux runtime|proton easyanticheat runtime|proton battleye runtime)/i;
const TOOL_APPIDS = new Set(['228980', '1007', '1070560', '1391110', '1628350', '1493710', '1826330', '1161040', '2180100']);

const hashId = (path) => createHash('sha1').update(WIN ? path.toLowerCase() : path).digest('hex').slice(0, 16);

// ------------------------------------------------------------ Windows: Start Menu

export function startMenuDirs(env = process.env) {
  const dirs = [];
  if (env.APPDATA) dirs.push(join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  dirs.push(join(env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  return dirs;
}

async function walk(dir, depth, onFile, skipDir = () => false) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    const p = join(dir, d.name);
    if (d.isDirectory()) {
      if (depth < MAX_DEPTH && !skipDir(d.name)) await walk(p, depth + 1, onFile, skipDir);
    } else if (d.isFile() || d.isSymbolicLink()) {
      onFile(p, d.name);
    }
  }
}

export async function scanStartMenu(dirs = startMenuDirs()) {
  const found = [];
  for (const [rank, root] of dirs.entries()) {
    await walk(
      root,
      0,
      (path, name) => {
        if (extname(name).toLowerCase() !== '.lnk') return;
        const title = name.slice(0, -4).trim();
        if (!title || NOT_A_PROGRAM.test(title)) return;
        const folder = relative(root, path).split(sep).slice(0, -1);
        found.push({ path, name: title, folder: folder.join(' / '), depth: folder.length, rank });
      },
      (d) => d.toLowerCase() === 'startup', // programs that start with Windows: listed elsewhere too
    );
  }
  // The same program is often linked twice (for everyone and for you, or in a folder and at the top):
  // keep one per name, the one nearest the top.
  found.sort((a, b) => a.depth - b.depth || a.rank - b.rank);
  const byName = new Map();
  for (const f of found) {
    const k = f.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, f);
  }
  return [...byName.values()].slice(0, MAX_ITEMS).map((f) => ({ id: hashId(f.path), name: f.name, hint: f.folder, words: f.folder, path: f.path }));
}

// ------------------------------------------------------------ Linux: .desktop files

export function desktopDirs(env = process.env, home = homedir()) {
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const dataDirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const dirs = [
    join(dataHome, 'applications'),
    join(dataHome, 'flatpak', 'exports', 'share', 'applications'),
    ...dataDirs.map((d) => join(d, 'applications')),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
  ];
  return [...new Set(dirs)];
}

// Unescape a .desktop string value (\s \n \t \r \\).
const unescape = (v) => v.replace(/\\([sntr\\;])/g, (_m, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\', ';': ';' })[c]);
const list = (v) =>
  (v ?? '')
    .split(/(?<!\\);/)
    .map((x) => unescape(x).trim())
    .filter(Boolean);

// Name, GenericName and so on in this language when the file has it (Name[de_DE], Name[de], Name).
function localized(keys, key, langs) {
  for (const l of langs) if (keys.has(`${key}[${l}]`)) return keys.get(`${key}[${l}]`);
  return keys.get(key);
}

function langsOf(env) {
  const raw = (env.LC_ALL || env.LC_MESSAGES || env.LANG || '').split('.')[0].split('@')[0];
  if (!raw || raw === 'C' || raw === 'POSIX') return [];
  const [lang, country] = raw.split('_');
  return country ? [`${lang}_${country}`, lang] : [lang];
}

// Parse one .desktop file. Returns null when it is not a program to show.
// opts.desktops: the running desktop names (XDG_CURRENT_DESKTOP); opts.canRun(file): TryExec check.
export function parseDesktopFile(text, opts = {}) {
  const desktops = (opts.desktops ?? []).map((d) => d.toLowerCase());
  const canRun = opts.canRun ?? (() => true);
  const langs = opts.langs ?? [];
  const keys = new Map();
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    if (!keys.has(k)) keys.set(k, line.slice(eq + 1).trim());
  }
  if (keys.get('Type') !== 'Application') return null;
  if (keys.get('NoDisplay') === 'true' || keys.get('Hidden') === 'true') return null;
  if (!keys.get('Exec') && keys.get('DBusActivatable') !== 'true') return null;
  const only = list(keys.get('OnlyShowIn')).map((d) => d.toLowerCase());
  if (only.length && !only.some((d) => desktops.includes(d))) return null;
  if (list(keys.get('NotShowIn')).some((d) => desktops.includes(d.toLowerCase()))) return null;
  const tryExec = keys.get('TryExec');
  if (tryExec && !canRun(unescape(tryExec))) return null;
  const name = unescape(localized(keys, 'Name', langs) ?? '').trim();
  if (!name) return null;
  const generic = unescape(localized(keys, 'GenericName', langs) ?? '').trim();
  const keywords = list(localized(keys, 'Keywords', langs));
  const categories = list(keys.get('Categories'));
  return { name, generic, keywords, categories, terminal: keys.get('Terminal') === 'true' };
}

// TryExec: an absolute path that can run, or a name found on PATH.
async function canRunAsync(file, env) {
  const ok = async (p) => {
    try {
      await fsp.access(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(file)) return ok(file);
  for (const dir of (env.PATH || '').split(delimiter)) if (dir && (await ok(join(dir, file)))) return true;
  return false;
}

export async function scanDesktopFiles(dirs = desktopDirs(), env = process.env) {
  const desktops = (env.XDG_CURRENT_DESKTOP || '').split(':').filter(Boolean);
  const langs = langsOf(env);
  const seen = new Set(); // desktop file ids: the first dir that has one wins, even when it hides it
  const files = [];
  for (const root of dirs) {
    await walk(root, 0, (path, name) => {
      if (!name.endsWith('.desktop')) return;
      const id = relative(root, path).split(sep).join('-');
      if (seen.has(id)) return;
      seen.add(id);
      files.push({ path, desktopId: id });
    });
  }
  const out = [];
  for (const f of files.slice(0, MAX_ITEMS)) {
    let text;
    try {
      text = await fsp.readFile(f.path, 'utf8');
    } catch {
      continue;
    }
    // TryExec needs a disk check; parse once to find it, then decide.
    const tryExec = text.match(/^TryExec\s*=\s*(.+)$/m)?.[1]?.trim();
    const runnable = tryExec ? await canRunAsync(tryExec, env) : true;
    const e = parseDesktopFile(text, { desktops, langs, canRun: () => runnable });
    if (!e) continue;
    out.push({
      id: hashId(f.path),
      name: e.name,
      hint: e.generic || e.categories.find((c) => !/^(GTK|Qt|KDE|GNOME)$/i.test(c)) || '',
      words: [e.generic, ...e.keywords].filter(Boolean).join(' '),
      path: f.path,
      desktopId: f.desktopId,
    });
  }
  // Same name twice (a flatpak and a system package): keep the first.
  const byName = new Map();
  for (const x of out) if (!byName.has(x.name.toLowerCase())) byName.set(x.name.toLowerCase(), x);
  return [...byName.values()];
}

// ------------------------------------------------------------ Steam

// Valve's KeyValues text format (libraryfolders.vdf, appmanifest_*.acf). Keys are lowercased.
export function parseVdf(text) {
  const root = {};
  const stack = [root];
  let key = null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '{') {
      const obj = {};
      if (key !== null) stack[stack.length - 1][key] = obj;
      stack.push(obj);
      key = null;
      i++;
      continue;
    }
    if (c === '}') {
      if (stack.length > 1) stack.pop();
      key = null;
      i++;
      continue;
    }
    let tok = '';
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1];
          tok += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else tok += text[i++];
      }
      i++;
    } else {
      while (i < n && !/[\s{}"]/.test(text[i])) tok += text[i++];
    }
    if (key === null) key = tok.toLowerCase();
    else {
      stack[stack.length - 1][key] = tok;
      key = null;
    }
  }
  return root;
}

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out)));
  });

export async function steamRoots(env = process.env, home = homedir()) {
  const roots = [];
  if (WIN) {
    const reg = await run('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    const p = reg.match(/SteamPath\s+REG_SZ\s+(.+)/)?.[1]?.trim();
    if (p) roots.push(p.replaceAll('/', '\\'));
    roots.push(join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'));
  } else {
    roots.push(join(home, '.local', 'share', 'Steam'), join(home, '.steam', 'steam'), join(home, '.steam', 'root'), join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'));
  }
  const real = new Map();
  for (const r of roots) {
    try {
      const rp = await fsp.realpath(r);
      const k = WIN ? rp.toLowerCase() : rp;
      if (!real.has(k)) real.set(k, rp);
    } catch {
      /* not there */
    }
  }
  return [...real.values()];
}

async function libraries(root) {
  const libs = [root];
  for (const f of [join(root, 'steamapps', 'libraryfolders.vdf'), join(root, 'config', 'libraryfolders.vdf')]) {
    let v;
    try {
      v = parseVdf(await fsp.readFile(f, 'utf8'));
    } catch {
      continue;
    }
    for (const [k, x] of Object.entries(v.libraryfolders ?? {})) {
      if (typeof x === 'object' && typeof x.path === 'string') libs.push(x.path);
      else if (/^\d+$/.test(k) && typeof x === 'string') libs.push(x); // the old format: "1" "D:\\SteamLibrary"
    }
    break;
  }
  return libs;
}

export async function scanSteam(roots) {
  roots ??= await steamRoots();
  const games = new Map();
  const doneLibs = new Set();
  for (const root of roots) {
    for (const lib of await libraries(root)) {
      const apps = join(lib, 'steamapps');
      const k = WIN ? apps.toLowerCase() : apps;
      if (doneLibs.has(k)) continue;
      doneLibs.add(k);
      let names;
      try {
        names = await fsp.readdir(apps);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!/^appmanifest_\d+\.acf$/.test(n)) continue;
        let st;
        try {
          st = parseVdf(await fsp.readFile(join(apps, n), 'utf8')).appstate;
        } catch {
          continue;
        }
        const appid = String(st?.appid ?? '');
        const name = String(st?.name ?? '').trim();
        if (!/^\d+$/.test(appid) || !name || TOOL_APPIDS.has(appid) || NOT_A_GAME.test(name) || games.has(appid)) continue;
        games.set(appid, { id: appid, name, hint: 'STEAM', lastPlayed: Number(st.lastplayed) * 1000 || 0 });
      }
    }
  }
  return [...games.values()].sort((a, b) => b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ cache + launch (used by shell/web.mjs)

export function launcherCatalog({ shell }) {
  const make = (scan) => ({ scan, list: null, at: 0, pending: null });
  const installed = make(() => (WIN ? scanStartMenu() : process.platform === 'linux' ? scanDesktopFiles() : Promise.resolve([])));
  const games = make(() => scanSteam());
  const icons = new Map(); // path -> data URL ('' = none)
  let iconsRunning = false;

  // The cached list now (and a background rescan when it is old); the first time, wait for the scan.
  function get(c, after) {
    const fresh = c.list && Date.now() - c.at < STALE_MS;
    if (!fresh && !c.pending) {
      c.pending = c
        .scan()
        .catch(() => [])
        .then((l) => {
          c.list = l;
          c.at = Date.now();
          after?.(l);
          return l;
        })
        .finally(() => (c.pending = null));
    }
    return c.list ? Promise.resolve(c.list) : c.pending;
  }

  // Small icons for Windows shortcuts, one at a time in the background. The next open shows them.
  // A .lnk file's own icon is the plain "shortcut" icon, so the icon comes from what it points to.
  async function loadIcons(items) {
    if (!WIN || iconsRunning) return;
    iconsRunning = true;
    try {
      const { app } = await import('electron');
      for (const x of items) {
        if (icons.has(x.path)) continue;
        try {
          const img = await app.getFileIcon(iconSource(x.path), { size: 'normal' });
          icons.set(x.path, img.isEmpty() ? '' : img.toDataURL());
        } catch {
          icons.set(x.path, '');
        }
      }
      // The same picture on many programs is Windows' generic one (a shortcut with no target, like
      // Store-installed apps): show no icon rather than that.
      const count = new Map();
      for (const v of icons.values()) if (v) count.set(v, (count.get(v) ?? 0) + 1);
      for (const [k, v] of icons) if (v && count.get(v) > 3) icons.set(k, '');
    } catch {
      /* not inside Electron: no icons */
    } finally {
      iconsRunning = false;
    }
  }

  // The shortcut's own icon file (.exe or .ico), else its target, else the shortcut.
  function iconSource(lnk) {
    try {
      const l = shell.readShortcutLink(lnk);
      const expand = (p) => (p ?? '').replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
      const icon = expand(l.icon);
      if (/\.(exe|ico)$/i.test(icon)) return icon;
      return expand(l.target) || lnk;
    } catch {
      return lnk;
    }
  }

  const pub = ({ id, name, hint, words, path }) => ({ id, name, hint, words, ...(icons.get(path) ? { icon: icons.get(path) } : {}) });

  async function find(c, id) {
    const l = (await get(c)) ?? [];
    return l.find((x) => x.id === id) ?? null;
  }

  return {
    async installed() {
      const l = await get(installed, (fresh) => void loadIcons(fresh));
      if (l && !iconsRunning && l.some((x) => !icons.has(x.path))) void loadIcons(l);
      return (l ?? []).map(pub);
    },
    async games() {
      return ((await get(games)) ?? []).map(({ id, name, hint }) => ({ id, name, hint }));
    },
    async openInstalled(id) {
      const x = await find(installed, id);
      if (!x) return false;
      if (WIN) return (await shell.openPath(x.path)) === '';
      return launchDesktop(x);
    },
    async openGame(id) {
      const x = await find(games, id);
      if (!x) return false;
      try {
        await shell.openExternal(`steam://rungameid/${x.id}`);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// gio launch runs the file the way the desktop would (Exec, Terminal, field codes); gtk-launch is the fallback.
// stdio is ignored so the program never holds a pipe of ours; gio itself exits as soon as the program started.
function launchDesktop(x) {
  const tryRun = (cmd, args) =>
    new Promise((resolve) => {
      try {
        const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
        p.once('error', () => resolve(false));
        p.once('exit', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  return tryRun('gio', ['launch', x.path]).then((ok) => ok || tryRun('gtk-launch', [basename(x.desktopId, '.desktop')]));
}
