// DICTATE in any app, the desktop app's part (shell/main.mjs mounts it).
// - Linux (Omarchy): the floating mic is the pack's shell plugin (os/omarchy/dictate) and the take its script
//   (os/omarchy/clock/phosphor-dictate). Here only their settings file, ~/.config/phosphor-os/dictate.json, for
//   SETTINGS > VOICE in the page (written in place: the plugin watches the file).
// - Windows and Mac (untested): the floating mic is a small window of this app with the page /dictate.html
//   (web/src/dictatefloat.ts records and turns speech into text like DICTATE, on the same server). The window never
//   takes the keyboard (Windows: never activated; Mac: a non-activating panel on every Space), so the words go into
//   the app you were typing in: they go on the clipboard, then Ctrl+V (Windows: paste.exe, built by
//   scripts/setup-shell.ps1 from shell/paste.cs) or Command+V (Mac: System Events, which needs Accessibility for
//   Phosphor-OS), then the old clipboard comes back. Ctrl+Alt+D starts and stops it from any app. Settings and the
//   spot: shell-data/prefs.json (dictate: { icon, cleanup, x, y }).
// Bridge (preload.cjs): invoke dictate:get -> DictateInfo | null; invoke dictate:set { icon?, cleanup? } -> DictateInfo.
// The floating page only: invoke dictate:paste (text) -> 'pasted' | 'copied' | 'failed'; send dictate:menu;
// send dictate:drag { phase: 'start' | 'move' | 'end', dx, dy }; it gets dictate:command 'toggle'.
// DictateInfo = { where: 'pack' | 'app' | 'none', icon, cleanup, keys }.

import { BrowserWindow, Menu, clipboard, globalShortcut, ipcMain, screen } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appFolder } from '../shared/names.mjs';
import { readSettings, settingsFile } from '../shared/dictate.mjs';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const LINUX = process.platform === 'linux';
const SIZE = 64; // the floating mic's window (Windows, Mac)
const KEY = 'Control+Alt+D'; // Windows, Mac: start and stop from any app
const RESTORE_MS = 1000; // time for the app to read the clipboard after the paste key
const PASTE_EXE = join(appFolder(process.env.LOCALAPPDATA ?? ''), 'shell', 'paste.exe');

// opts: { prefs, savePrefs, isApp, base, preload, partition, globalKeys, showApp }
export function mountDictate(opts) {
  const { prefs, savePrefs, isApp, globalKeys, showApp } = opts;
  const packFile = settingsFile(homedir());
  const packInstalled = () => existsSync(join(homedir(), '.config', 'omarchy', 'plugins', 'phosphor-os.dictate', 'manifest.json'));
  let float = null;

  const settings = () => {
    if (LINUX) {
      try {
        return readSettings(readFileSync(packFile, 'utf8'));
      } catch {
        return readSettings('');
      }
    }
    return readSettings(JSON.stringify(prefs.dictate ?? {}));
  };
  const info = () => {
    const s = settings();
    const where = LINUX ? (packInstalled() ? 'pack' : 'none') : WIN || MAC ? 'app' : 'none';
    return { where, icon: s.icon, cleanup: s.cleanup, keys: LINUX ? 'Ctrl+Space (tap, or hold to talk)' : 'Ctrl+Alt+D' };
  };
  const save = (patch) => {
    const next = { ...settings(), ...patch };
    if (LINUX) {
      mkdirSync(dirname(packFile), { recursive: true });
      writeFileSync(packFile, `${JSON.stringify(next, null, 2)}\n`); // in place: the plugin's watch stays on the file
    } else {
      prefs.dictate = next;
      savePrefs();
      if (next.icon) float?.showInactive();
      else float?.hide(); // hidden, it still listens for Ctrl+Alt+D
    }
  };

  const fromApp = (e) => isApp(e.senderFrame?.url ?? '');
  const fromFloat = (e) => !!float && e.sender === float.webContents && fromApp(e);
  ipcMain.handle('dictate:get', (e) => (fromApp(e) ? info() : null));
  ipcMain.handle('dictate:set', (e, patch) => {
    if (!fromApp(e) || !patch || typeof patch !== 'object') return null;
    const p = {};
    if (typeof patch.icon === 'boolean') p.icon = patch.icon;
    if (typeof patch.cleanup === 'boolean') p.cleanup = patch.cleanup;
    save(p);
    return info();
  });
  if (!WIN && !MAC) return;

  // ---------------------------------------------------------------- Windows and Mac: the floating mic window

  function makeFloat() {
    const area = screen.getPrimaryDisplay().workArea;
    const s = prefs.dictate ?? {};
    const x = Number.isFinite(s.x) ? s.x : area.x + area.width - SIZE - 24;
    const y = Number.isFinite(s.y) ? s.y : Math.round(area.y + area.height * 0.8);
    float = new BrowserWindow({
      x,
      y,
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false, // a click never takes the keyboard from the app you type in
      alwaysOnTop: true,
      ...(MAC && { type: 'panel' }), // non-activating: the app you type in stays in front
      title: 'Phosphor-OS DICTATE',
      webPreferences: {
        partition: opts.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: opts.preload,
        additionalArguments: [`--phosphor-base=${opts.base}`],
        backgroundThrottling: false, // it records while hidden too (Ctrl+Alt+D)
      },
    });
    float.setAlwaysOnTop(true, 'floating');
    if (MAC) float.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    float.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    float.webContents.on('will-navigate', (e, url) => isApp(url) || e.preventDefault());
    float.once('ready-to-show', () => settings().icon && float?.showInactive());
    float.on('closed', () => (float = null));
    // Not up yet (the server is starting, or not logged in: the login page): try again shortly, out of sight.
    const load = () => float?.loadURL(`${opts.base}/dictate.html`);
    float.webContents.on('did-fail-load', (_e, code, _d, _url, main) => main && code !== -3 && setTimeout(load, 5000));
    float.webContents.on('did-navigate', (_e, url) => {
      if (new URL(url).pathname === '/dictate.html') return void (settings().icon && float?.showInactive());
      float?.hide();
      setTimeout(load, 10000);
    });
    load();
  }

  // The words into the app in front: clipboard, the paste key, then the old clipboard back (if ours is still there).
  ipcMain.handle('dictate:paste', async (e, text) => {
    if (!fromFloat(e) || typeof text !== 'string' || !text) return 'failed';
    const old = { text: clipboard.readText(), image: clipboard.readImage() };
    clipboard.writeText(text);
    const keyed = await new Promise((done) => {
      if (WIN) execFile(PASTE_EXE, [], { timeout: 5000, windowsHide: true }, (err) => done(!err));
      else execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], { timeout: 5000 }, (err) => done(!err));
    });
    if (!keyed) return 'copied'; // the words stay on the clipboard, to paste by hand
    await new Promise((ok) => setTimeout(ok, RESTORE_MS));
    if (clipboard.readText() === text) {
      clipboard.clear();
      if (!old.image.isEmpty()) clipboard.writeImage(old.image);
      else if (old.text) clipboard.writeText(old.text);
    }
    return 'pasted';
  });

  ipcMain.on('dictate:menu', (e) => {
    if (!fromFloat(e)) return;
    const s = settings();
    Menu.buildFromTemplate([
      { label: 'CLEAN UP', type: 'checkbox', checked: s.cleanup, click: () => save({ cleanup: !s.cleanup }) },
      { label: 'HIDE THE MIC (SETTINGS > VOICE brings it back)', click: () => save({ icon: false }) },
      { type: 'separator' },
      { label: 'OPEN PHOSPHOR-OS', click: () => showApp() },
    ]).popup({ window: float });
  });

  let dragFrom = null;
  ipcMain.on('dictate:drag', (e, m) => {
    if (!fromFloat(e) || !m || typeof m !== 'object') return;
    const dx = Math.round(Number(m.dx) || 0);
    const dy = Math.round(Number(m.dy) || 0);
    if (m.phase === 'start') dragFrom = float.getPosition();
    else if (dragFrom) {
      float.setPosition(dragFrom[0] + dx, dragFrom[1] + dy);
      if (m.phase === 'end') {
        const [x, y] = float.getPosition();
        prefs.dictate = { ...settings(), x, y };
        savePrefs();
        dragFrom = null;
      }
    }
  });

  makeFloat();
  if (globalKeys) globalShortcut.register(KEY, () => float?.webContents.send('dictate:command', 'toggle'));
}
