// Phosphor-OS desktop app (Electron): a window and a tray icon for the app server on this PC.
//
// The server is its own process (`scripts/serve.mjs` runs and guards it). Closing or quitting this app never stops
// it, so the phone and running chats keep going. If the server is not running, this app starts it,
// hidden, and leaves it running.
//
// Run: <electron.exe> shell/main.mjs [--hidden] [--desktop] [--launcher | --docs [file]]
//   (Windows: scripts/setup-shell.ps1 installs Electron + shortcut. Linux: scripts/setup-linux.sh, and
//   scripts/phosphor-os.sh starts it. Mac: scripts/setup-mac.sh, an app in ~/Applications starts it.)
//   --hidden: start in the tray only (used by "Start with Windows").
//   --desktop: Phosphor-OS is the desktop (Hyprland starts it this way on Linux): always full screen (Linux:
//     maximized under the bar), and
//     closing the window does nothing (no hiding to the tray). Quit from the tray, or restart it with its key.
//   --launcher: show the window and open the page's launcher. Works on the first start and on a second start
//     while it runs (the Super key on Linux does that). On Windows Ctrl+Alt+Space does the same.
//   --docs: the same, but switches the page to DOCS (the "Phosphor Docs" entry in the app menu).
//   --docs <file>: opens that file in DOCS where it is (a .md double-clicked in the file manager): this process
//     adds it to the server's OPEN FILES with the key in data/docs-open.key, which only this user can read
//     (server/docs.ts handleOpenLocal). The page itself can never add a file. Give the full path.
// Env: PHOSPHOR_NO_GLOBAL_KEYS=1 registers no global keys (tests use it, so a test app never takes the owner's keys).
//
// Safety (the window can reach the whole PC through Claude):
// - The window only shows this app's own address. Any other link opens in your normal browser.
// - Permissions: microphone (DICTATE), fullscreen, clipboard write and notifications, for this app only.
// - No Node in the page (sandbox, context isolation). No remote debugging port is opened.
// - The page gets one bridge, window.phosphorShell, for the website panes (shell/web.mjs, shell/preload.cjs).

import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Tray, session, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptOldEnv, appFolder, envFileValue } from '../shared/names.mjs';
import { mountDictate } from './dictate.mjs';
import { mountWeb } from './web.mjs';

const WIN = process.platform === 'win32';
const LINUX = process.platform === 'linux';
const MAC = process.platform === 'darwin';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fileURLToPath(import.meta.url);
const ICON = WIN ? join(ROOT, 'assets', 'phosphor-os.ico') : join(ROOT, 'web', 'public', 'icons', 'icon-192.png');
// XDG base folders (Linux); the spec says to ignore relative values.
const xdg = (name, fallback) => (process.env[name]?.startsWith('/') ? process.env[name] : join(homedir(), fallback));
adoptOldEnv(); // settings from before the rename say RETRO_*
// Per-PC folder outside any synced folder: %LOCALAPPDATA%\PhosphorOS, or ${XDG_DATA_HOME:-~/.local/share}/PhosphorOS
// (an install from before the rename keeps its RetroClaude folder: shared/names.mjs).
const APP_DATA = appFolder(WIN ? (process.env.LOCALAPPDATA ?? app.getPath('appData')) : xdg('XDG_DATA_HOME', '.local/share'));
const DATA = process.env.PHOSPHOR_SHELL_DATA || join(APP_DATA, 'shell-data');
const SERVER_LOG = join(DATA, 'server.log');
const PREFS = join(DATA, 'prefs.json');
const PID_FILE = join(DATA, 'app.pid'); // Linux: scripts/phosphor-os.sh --restart stops this pid
// Linux: the systemd user service that runs the server (scripts/setup-linux.sh makes it).
const SERVER_UNIT = 'phosphor-os-server.service';
const SERVER_UNIT_FILE = join(xdg('XDG_CONFIG_HOME', '.config'), 'systemd', 'user', SERVER_UNIT);
const PARTITION = 'persist:retro'; // named before the rename; a new name would log out every saved site
const ALLOWED_PERMISSIONS = new Set(['media', 'fullscreen', 'clipboard-sanitized-write', 'notifications']);
// From anywhere (Firefox, Discord, a game): bring Phosphor-OS back to the front.
const HOME_KEY = 'Control+Alt+R';
// From anywhere: Phosphor-OS in front, with its launcher open. (Linux: Hyprland's Super key does this.)
const LAUNCHER_KEY = 'Control+Alt+Space';
// Global keys: Windows and Mac (Hyprland binds the keys on Linux), and never in tests.
const GLOBAL_KEYS = (WIN || MAC) && process.env.PHOSPHOR_NO_GLOBAL_KEYS !== '1';
// Mac: the launchd agent that runs the server (scripts/setup-mac.sh makes it).
const MAC_AGENT = 'os.phosphor.server';
const MAC_AGENT_FILE = join(homedir(), 'Library', 'LaunchAgents', `${MAC_AGENT}.plist`);
const DESKTOP = process.argv.includes('--desktop');
// What a start asks the page to do (sent as a preload onCommand command): open the launcher, or show DOCS.
const wantedCommand = (argv) => (argv.includes('--docs') ? 'docs' : argv.includes('--launcher') ? 'launcher' : '');
// The file after --docs, if any (scripts/phosphor-os.sh makes it a full path).
const wantedFile = (argv) => {
  const f = argv[argv.indexOf('--docs') + 1];
  return argv.includes('--docs') && f && !f.startsWith('-') ? f : '';
};

function readEnv() {
  try {
    return readFileSync(join(ROOT, '.env'), 'utf8');
  } catch {
    return '';
  }
}
const PORT = envFileValue(readEnv(), 'PORT').match(/^\d+$/)?.[0] ?? '7337';
const BASE = `http://localhost:${PORT}`;

// Own profile and name, outside any synced folder. Must be set before the app is ready.
mkdirSync(DATA, { recursive: true });
app.setName('Phosphor-OS');
app.setPath('userData', DATA);
if (WIN) app.setAppUserModelId('PhosphorOS.Desktop'); // Windows-only API (missing on Linux)
// Linux: the window's class (Wayland app id) becomes "phosphor-os", which Hyprland's rules and keys look for
// (os/hyprland/phosphor-os.lua). Matches ~/.local/share/applications/phosphor-os.desktop.
if (LINUX) app.setDesktopName?.('phosphor-os.desktop');

// The request also goes as additionalData: Chromium may reorder a second start's argv.
const firstInstance = app.requestSingleInstanceLock({ command: wantedCommand(process.argv), file: wantedFile(process.argv) });
if (!firstInstance) app.exit(0); // already open: that one shows its window (and opens the launcher or DOCS if asked)
else if (LINUX) {
  try {
    writeFileSync(PID_FILE, String(process.pid));
  } catch {
    /* only the restart key needs it */
  }
}

let win = null;
let tray = null;
let web = null;
let quitting = false;
let pendingCommand = ''; // 'launcher', 'docs', 'docs-open:<path>' or 'docs-error:<text>', until the app page can take it
let shownUrl = '';
let prefs = { fullscreen: !MAC, trayTipShown: false }; // Mac: a normal window, not a full-screen Space
try {
  prefs = { ...prefs, ...JSON.parse(readFileSync(PREFS, 'utf8')) };
} catch {
  /* first run */
}
const savePrefs = () => {
  try {
    writeFileSync(PREFS, JSON.stringify(prefs));
  } catch {
    /* not important */
  }
};

const isApp = (url) => {
  try {
    return new URL(url).origin === BASE;
  } catch {
    return false;
  }
};
const openOutside = (url) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
};

// ---------------------------------------------------------------- server

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/login.html`, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// Something is listening on the port (the server, maybe busy).
function portOpen() {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port: Number(PORT) });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

// Start the server's supervisor (scripts/serve.mjs) with this PC's Node, hidden and detached: it outlives this
// app. Its log is data/server.log in the project; this file only gets what fails before that log opens.
function startServer() {
  // Linux: the server is a systemd user service there; start that, so only one thing runs it.
  if (LINUX && existsSync(SERVER_UNIT_FILE)) {
    execFile('systemctl', ['--user', 'start', SERVER_UNIT], { timeout: 15000 }, () => {});
    return;
  }
  // Mac: the same with its launchd agent.
  if (MAC && existsSync(MAC_AGENT_FILE)) {
    execFile('launchctl', ['kickstart', `gui/${process.getuid()}/${MAC_AGENT}`], { timeout: 15000 }, () => {});
    return;
  }
  // An app opened from the Mac Dock gets no shell PATH, so look where Homebrew puts Node too.
  const nodes = WIN ? ['C:\\Program Files\\nodejs\\node.exe'] : MAC ? ['/opt/homebrew/bin/node', '/usr/local/bin/node'] : [];
  const node = nodes.find((n) => existsSync(n)) ?? 'node';
  const log = openSync(SERVER_LOG, 'a');
  const child = spawn(node, ['scripts/serve.mjs'], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.on('error', (e) => writeFileSync(SERVER_LOG, `Could not start the server with ${node}: ${e.message}\n`, { flag: 'a' })); // NO SIGNAL shows the log path
  child.unref();
}

// Never start a second server: a closed port can just mean it is restarting, so look twice.
// Two rounds: a supervisor that quit at once (a stale lock did that after a reboot, 2026-10-12) gets one more start.
async function ensureServer() {
  for (let round = 0; round < 2; round++) {
    if (!(await portOpen())) {
      await sleep(3000);
      if (!(await portOpen())) startServer();
    }
    for (let i = 0; i < 60; i++) {
      if (await serverUp()) return true;
      await sleep(500);
    }
  }
  return false;
}

// Show the app once the server answers. If it doesn't, NO SIGNAL keeps checking every 5 s (starting the server
// again each minute while nothing listens) and loads the app by itself: no restart of the app needed.
let waiting = null;
async function connectServer() {
  if (waiting) return;
  win?.loadURL(page('PHOSPHOR-OS', 'Starting the server...'));
  if (await ensureServer()) return void win?.loadURL(BASE);
  win?.loadURL(page('NO SIGNAL', `The server has not started yet. Still trying every few seconds; the app opens by itself when it answers. Logs: ${join(ROOT, 'data', 'server.log')} and ${SERVER_LOG}`));
  showWindow();
  let tries = 0;
  waiting = setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    if (await serverUp()) {
      clearInterval(waiting);
      waiting = null;
      win.loadURL(BASE);
    } else if (++tries % 12 === 0 && !(await portOpen())) startServer();
  }, 5000);
}

// ---------------------------------------------------------------- window

const page = (title, text) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><title>Phosphor-OS</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0700;color:#ffb000;font:22px Consolas,monospace;text-align:center"><div><div style="letter-spacing:6px;color:#ffd68a">${title}</div><p style="color:#b07c08;font-size:16px;max-width:60ch">${text}</p></div>`);

function createWindow(show) {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    title: 'Phosphor-OS',
    icon: ICON,
    backgroundColor: '#0b0700',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      preload: join(ROOT, 'shell', 'preload.cjs'),
      additionalArguments: [`--phosphor-base=${BASE}`],
    },
  });
  const wc = win.webContents;
  // The taskbar showed Electron's atom: Windows takes the button's icon from the app id's shortcut, and
  // the desktop shortcut has no app id. Give the window its own icon, name and relaunch command.
  if (process.platform === 'win32') {
    win.setAppDetails({ appId: 'PhosphorOS.Desktop', appIconPath: ICON, relaunchCommand: `"${process.execPath}" "${MAIN}"`, relaunchDisplayName: 'Phosphor-OS' });
  }

  // Only this app's pages in the window; everything else goes to the normal browser.
  wc.on('will-navigate', (e, url) => {
    if (!isApp(url) && !url.startsWith('data:')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  wc.on('will-redirect', (e, url) => {
    if (!isApp(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  // The server was restarting: try again shortly.
  wc.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && isApp(url) && code !== -3) setTimeout(() => win && !win.isDestroyed() && win.loadURL(BASE), 1500);
  });
  // The page the window really shows. getURL() already names a page that is still on its way.
  wc.on('did-navigate', (_e, url) => {
    shownUrl = url;
  });
  wc.on('did-stop-loading', sendCommand); // (at did-finish-load isLoading() can still say true)
  // Electron underlines misspelled words but shows no right-click menu of its own. Pages that make their
  // own menu (files, tabs) cancel the event, and then this does not fire.
  wc.on('context-menu', (_e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    const items = p.dictionarySuggestions.slice(0, 6).map((word) => ({ label: word, click: () => wc.replaceMisspelling(word) }));
    if (p.misspelledWord) {
      if (!items.length) items.push({ label: 'No suggestions', enabled: false });
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
    else items.push({ role: 'copy' });
    Menu.buildFromTemplate(items).popup({ window: win });
  });
  // F11 = fullscreen, like a browser. Remembered for next time. F5 / Ctrl+R = reload the page.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      e.preventDefault();
      setFullscreen(!win.isFullScreen());
    } else if (input.key === 'F5' || (input.control && !input.alt && !input.meta && input.key.toLowerCase() === 'r')) {
      e.preventDefault();
      wc.reload();
    } else if (input.control && !input.alt && !input.meta && !input.shift && input.key.toLowerCase() === 'w') {
      e.preventDefault(); // Ctrl+W = close the chat tab you are on, like a browser tab (never the window)
      wc.send('web:command', 'close-tab');
    }
  });
  win.on('enter-full-screen', () => rememberFullscreen(true));
  win.on('leave-full-screen', () => rememberFullscreen(false));

  // Closing the window hides it to the tray; the tray menu quits. As the desktop it stays put.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    if (DESKTOP) return;
    win.hide();
    if (!prefs.trayTipShown && tray?.displayBalloon) {
      tray.displayBalloon({ title: 'Phosphor-OS', content: 'Still here, in the tray. Right-click the icon to quit.', iconType: 'info' });
      prefs.trayTipShown = true;
      savePrefs();
    }
  });

  web = mountWeb({ win, isApp, prefs, savePrefs, onFullscreenKey: () => setFullscreen(!win.isFullScreen()) });
  mountDictate({ isApp }); // DICTATE in any app: its one setting for SETTINGS > VOICE (Linux, shell/dictate.mjs)
  if (show) showWindow();
}

function showWindow() {
  if (!win) return;
  if (!win.isVisible()) {
    win.maximize();
    win.show();
    // Linux desktop: maximized, not full screen, so the bar (taskbar) above it stays visible (hyprland rule too).
    if (DESKTOP && LINUX) win.maximize();
    else if (prefs.fullscreen || DESKTOP) win.setFullScreen(true);
  }
  win.focus();
}

// Show the window and send the page a command: 'launcher' opens its launcher, 'docs' switches to DOCS. Before
// the app page has loaded (still starting, or the server was down), it goes once the page has finished loading;
// on the login page it is dropped.
function showWith(command) {
  if (!win) return;
  showWindow();
  pendingCommand = command;
  sendCommand();
}

function sendCommand() {
  if (!pendingCommand || !win || win.isDestroyed() || win.webContents.isLoading()) return;
  const url = shownUrl;
  if (!isApp(url)) return; // the "starting" page: wait for the app
  const command = pendingCommand;
  pendingCommand = '';
  if (new URL(url).pathname === '/login.html') return;
  win.webContents.focus();
  win.webContents.send('web:command', command); // same channel as shell/web.mjs commands (preload onCommand)
}

// --docs <file>: add the file to the server's OPEN FILES, then have the page open it (or say why not).
async function openDocsFile(file) {
  showWindow();
  let answer;
  try {
    const key = readFileSync(join(ROOT, 'data', 'docs-open.key'), 'utf8').trim();
    const r = await fetch(`http://127.0.0.1:${PORT}/api/docs/open-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Phosphor-Key': key },
      body: JSON.stringify({ path: file }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    answer = r.ok && typeof data.path === 'string' ? `docs-open:${data.path}` : `docs-error:Could not open ${file}: ${data.error ?? `error ${r.status}`}`;
  } catch {
    answer = `docs-error:Could not open ${file}: the server did not answer (restart it if it is older than this app).`;
  }
  showWith(answer);
}

function setFullscreen(on) {
  if (!win) return;
  win.setFullScreen(on);
  rememberFullscreen(on);
}

function rememberFullscreen(on) {
  if (DESKTOP) return; // the desktop is always full screen; keep the window's own setting for normal use
  if (prefs.fullscreen === on) return;
  prefs.fullscreen = on;
  savePrefs();
  buildTrayMenu();
}

// ---------------------------------------------------------------- tray

const loginItem = () => ({ path: process.execPath, args: [MAIN, '--hidden'] });

function buildTrayMenu() {
  if (!tray) return;
  // Linux has no login items: Hyprland starts the app there (os/hyprland/phosphor-os.lua).
  const startup = WIN && app.getLoginItemSettings(loginItem()).openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Phosphor-OS', click: showWindow },
      {
        label: 'Reload the page (F5)',
        click: () => {
          showWindow();
          win?.webContents.reload();
        },
      },
      {
        label: 'Start the server',
        click: () => {
          showWindow();
          void connectServer();
        },
      },
      { label: 'Fullscreen', type: 'checkbox', checked: prefs.fullscreen, click: (m) => (win?.isVisible() ? setFullscreen(m.checked) : rememberFullscreen(m.checked)) },
      { type: 'separator' },
      ...(WIN
        ? [
            {
              label: 'Start with Windows (in the tray)',
              type: 'checkbox',
              checked: startup,
              click: (m) => {
                app.setLoginItemSettings({ ...loginItem(), openAtLogin: m.checked, name: 'Phosphor-OS' });
                buildTrayMenu();
              },
            },
          ]
        : []),
      { label: 'Open in my browser', click: () => void shell.openExternal(BASE) },
      { label: 'Forget website permissions', click: () => web?.forgetPermissions() },
      { label: 'Bring back the Web and Discord buttons', click: () => web?.restoreApps() },
      { type: 'separator' },
      {
        label: 'Quit (the server keeps running)',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ---------------------------------------------------------------- start

app.on('second-instance', (_e, argv, cwd, data) => {
  const command = data?.command ?? wantedCommand(argv);
  const file = data?.file ?? wantedFile(argv);
  if (file) void openDocsFile(isAbsolute(file) ? file : join(cwd, file));
  else if (command) showWith(command);
  else showWindow();
});
// Any quit (tray, SIGTERM from the restart key, logout) may close the window, also as the desktop.
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (LINUX && firstInstance) {
    try {
      if (readFileSync(PID_FILE, 'utf8') === String(process.pid)) rmSync(PID_FILE, { force: true });
    } catch {
      /* already gone */
    }
  }
});
app.on('window-all-closed', () => {
  /* stay in the tray */
});
// Mac: a click on the Dock icon brings the hidden window back.
app.on('activate', () => showWindow());

app.whenReady().then(async () => {
  // Mac: no menu would also mean no Cmd+C, Cmd+V or Cmd+Q, so keep the app and edit menus there.
  Menu.setApplicationMenu(MAC ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((wc, permission, done, details) => {
    const fromApp = isApp(details.requestingUrl || wc.getURL());
    const audioOnly = permission !== 'media' || (details.mediaTypes ?? []).every((t) => t === 'audio');
    done(fromApp && audioOnly && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => isApp(origin) && ALLOWED_PERMISSIONS.has(permission));

  // Linux: the tray needs a tray host in the bar (Omarchy's bar may be hidden in desktop mode). Without one
  // the icon just does not show; if Electron refuses outright, the app runs without a tray.
  try {
    const size = MAC ? 18 : 32; // the Mac menu bar is 22 px high
    tray = new Tray(WIN ? ICON : nativeImage.createFromPath(ICON).resize({ width: size, height: size }));
  } catch {
    tray = null;
  }
  const homeKey = GLOBAL_KEYS && globalShortcut.register(HOME_KEY, showWindow);
  if (GLOBAL_KEYS) globalShortcut.register(LAUNCHER_KEY, () => showWith('launcher'));
  tray?.setToolTip(homeKey ? 'Phosphor-OS (Ctrl+Alt+R brings it back)' : 'Phosphor-OS');
  tray?.on('click', showWindow);
  buildTrayMenu();

  const hidden = process.argv.includes('--hidden') && !DESKTOP;
  createWindow(!hidden);
  const command = wantedCommand(process.argv);
  const file = wantedFile(process.argv);
  if (command && !file) showWith(command);
  await connectServer();
  if (file) await openDocsFile(isAbsolute(file) ? file : join(process.cwd(), file));
});
