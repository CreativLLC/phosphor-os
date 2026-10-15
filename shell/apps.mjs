// Program buttons that jump to real apps on this PC (owner's pick 2026-10-11: WEB = Firefox, DISCORD = the
// Discord app, so their own logins, history and add-ons are used). A running app's window comes to the front;
// when the app has no window, it is started.
//   Windows: focus-app.exe (shell/focus-app.cs) by process name (`proc`).
//   Linux (Hyprland): hyprctl finds the window by its class (`wclass`, a regex) and focuses it.
// The page only ever sends an app's id. Paths and names live here and in shell-data/prefs.json.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import { appFolder } from '../shared/names.mjs';

const LOCAL = process.env.LOCALAPPDATA ?? '';
const FOCUS = join(appFolder(LOCAL), 'shell', 'focus-app.exe');
// Omarchy starts apps through uwsm-app, so each gets its own systemd scope and outlives Phosphor-OS.
const UWSM_APP = '/usr/bin/uwsm-app';

// First-run buttons, only for apps that are installed. The owner renames or removes them in the app.
// (platform, exists, home: only for tests.)
export function defaultApps(platform = process.platform, exists = existsSync, home = homedir()) {
  if (platform === 'linux') return linuxDefaults(exists, home);
  return [
    { id: 'firefox', name: 'Web', proc: 'firefox', exe: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', args: [] },
    { id: 'discord', name: 'Discord', proc: 'Discord', exe: join(LOCAL, 'Discord', 'Update.exe'), args: ['--processStart', 'Discord.exe'] },
  ].filter((a) => exists(a.exe));
}

function linuxDefaults(exists, home) {
  const flatpak = (id) => ['/var/lib/flatpak', posix.join(home, '.local', 'share', 'flatpak')].some((d) => exists(posix.join(d, 'app', id)));
  const apps = [];
  if (exists('/usr/bin/firefox')) apps.push({ id: 'firefox', name: 'Web', wclass: 'firefox', exe: '/usr/bin/firefox', args: [] });
  if (exists('/usr/bin/discord')) apps.push({ id: 'discord', name: 'Discord', wclass: 'discord', exe: '/usr/bin/discord', args: [] });
  else if (flatpak('com.discordapp.Discord') && exists('/usr/bin/flatpak')) {
    apps.push({ id: 'discord', name: 'Discord', wclass: 'discord|com\\.discordapp\\.Discord', exe: '/usr/bin/flatpak', args: ['run', 'com.discordapp.Discord'] });
  }
  return apps;
}

// Front if running, else start it. Resolves 'front', 'started' or 'failed'.
// opts (tests only): platform, hyprctl = [file, ...first args], exists.
export function launchApp(app, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform === 'linux') return launchLinux(app, opts.hyprctl ?? ['hyprctl'], opts.exists ?? existsSync);
  return new Promise((resolve) => {
    const start = () => {
      try {
        spawn(app.exe, app.args ?? [], { detached: true, stdio: 'ignore' }).unref();
        resolve('started');
      } catch {
        resolve('failed');
      }
    };
    if (!app.proc || !existsSync(FOCUS)) return start();
    execFile(FOCUS, [app.proc], { timeout: 4000, windowsHide: true }, (err) => {
      const code = err ? err.code : 0;
      // 0 = in front; 3 = Windows kept another window in front (starting it again would open a second window).
      if (code === 0 || code === 3) resolve('front');
      else start(); // 2 = running without a window (Discord in the tray) or not running
    });
  });
}

// hyprctl with an argument list (never a shell string). ok = exit 0 and Hyprland said "ok" (or nothing).
function hyprctl(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd[0], [...cmd.slice(1), ...args], { timeout: 3000 }, (err, stdout) => {
      const out = String(stdout ?? '').trim();
      resolve({ ok: !err && (out === '' || /^ok$/i.test(out)), out });
    });
  });
}

async function launchLinux(app, cmd, exists) {
  let match = null;
  try {
    match = app.wclass ? new RegExp(`^(?:${app.wclass})$`, 'i') : null;
  } catch {
    /* a bad pattern in prefs.json: just start it */
  }
  if (match) {
    const list = await hyprctl(cmd, ['clients', '-j']);
    let address = null;
    try {
      const win = JSON.parse(list.out).find((c) => match.test(c.class ?? '') || match.test(c.initialClass ?? ''));
      if (/^0x[0-9a-f]+$/i.test(win?.address ?? '')) address = win.address;
    } catch {
      /* Hyprland not running or odd output: start the app */
    }
    if (address) {
      // Hyprland 0.55+ (Omarchy 4) takes a Lua dispatcher; older ones the plain one. Omarchy's own scripts try both.
      if ((await hyprctl(cmd, ['dispatch', `hl.dsp.focus({ window = "address:${address}" })`])).ok) return 'front';
      if ((await hyprctl(cmd, ['dispatch', 'focuswindow', `address:${address}`])).ok) return 'front';
    }
  }
  if (!app.exe || !exists(app.exe)) return 'failed';
  const [file, args] = exists(UWSM_APP) ? [UWSM_APP, ['--', app.exe, ...(app.args ?? [])]] : [app.exe, app.args ?? []];
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve('failed'));
      child.once('spawn', () => {
        child.unref();
        resolve('started');
      });
    } catch {
      resolve('failed');
    }
  });
}
