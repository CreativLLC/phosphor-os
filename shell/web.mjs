// Websites inside the app: the WEB browser and saved sites (Discord, YouTube...). Each site is an
// Electron WebContentsView laid over the app window. The page draws the program bar and toolbar and
// says where the site goes (web/src/browser.ts); this file owns the sites themselves.
//
// Safety:
// - Sites use their own profile ('persist:web'). Your logins live there, apart from the app's page.
//   Claude has no access to these panes.
// - Only http(s) pages load. Other links (file:, custom app links) are blocked.
// - Camera, microphone, notifications and location: the app asks you once per site and remembers
//   ("Forget website permissions" in the tray clears that). Fullscreen and copy are allowed. All else is blocked.
// - The page can only ask for the actions below, and only from this app's own address (checked here).
//
// Bridge (shell/preload.cjs exposes these as window.phosphorShell):
//   invoke web:state -> State          invoke web:new (url) -> tab id     invoke web:site (site id) -> tab id
//   send web:show { tab, rect, focus }  send web:navigate { tab, input }   send web:act { tab, action }
//   send web:sites [Site]              push web:changed State             push web:command 'program:N' | 'focus-address'
//   invoke web:launch (app id) -> 'front' | 'started' | 'failed'        send web:apps [{ id, name }] (rename, order, remove)
//   invoke launcher:installed / launcher:games -> list    invoke launcher:open-installed / launcher:open-game (id) -> bool
//   send web:skins { theme, crt, sites: [{ origin, kind }] } (STATION skins, shell/skins.mjs)
// State = { apps: { id, name }[], sites: Site[], tabs: { id, owner, title, url, loading, canBack, canForward, audible }[] }
// Site = { id, name, url }. owner = 'web' or a site id. Apps (shell/apps.mjs) are real programs on the PC.

import { Menu, WebContentsView, clipboard, dialog, ipcMain, session, shell } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { defaultApps, launchApp } from './apps.mjs';
import { launcherCatalog } from './installed.mjs';
import { skinner } from './skins.mjs';

const PARTITION = 'persist:web';
const MAX_TABS = 12;
const MAX_SITES = 20;
const SEARCH = 'https://www.google.com/search?q=';
const ALWAYS = new Set(['fullscreen', 'clipboard-sanitized-write']);
const ASKED = { notifications: 'show notifications', geolocation: 'see your location' };
const MEDIA = { audio: 'microphone', video: 'camera' };
// The first version's site buttons; the owner moved to real apps (shell/apps.mjs) instead.
const OLD_DEFAULT_URLS = new Set(['https://discord.com/app', 'https://www.youtube.com/']);

const isWeb = (url) => /^https?:\/\//i.test(url);

export function mountWeb({ win, isApp, prefs, savePrefs, onFullscreenKey }) {
  prefs.sites ??= [];
  prefs.webTabs ??= []; // WEB tabs to bring back next time: { url, title }
  if (!prefs.apps) {
    // One time: real Firefox and Discord replace the built-in WEB browser and the Discord/YouTube site buttons.
    prefs.apps = defaultApps();
    prefs.sites = prefs.sites.filter((s) => !OLD_DEFAULT_URLS.has(s.url));
    prefs.webTabs = [];
    savePrefs();
  }
  prefs.webPermissions ??= {}; // origin -> { permission key -> true | false }

  const tabs = new Map(); // id -> { id, owner, url, title, view, rect, fullscreen }
  let shown = null;
  const skins = skinner(); // STATION: the Retro look on the owner's self-hosted apps

  // ------------------------------------------------------------ profile

  const ses = session.fromPartition(PARTITION);
  // A plain Chrome name: some sites refuse a browser that says "Electron".
  ses.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);

  const decided = (origin, key) => prefs.webPermissions[origin]?.[key];
  const remember = (origin, key, allow) => {
    prefs.webPermissions[origin] = { ...prefs.webPermissions[origin], [key]: allow };
    savePrefs();
  };
  // One question at a time, so two sites asking at once don't stack dialogs.
  let asking = Promise.resolve();
  const ask = (origin, what) => {
    const next = asking.then(async () => {
      const host = new URL(origin).host;
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Phosphor-OS',
        message: `${host} wants to ${what}.`,
        detail: 'The app remembers your answer for this site. "Forget website permissions" in the tray menu clears it.',
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return r.response === 0;
    });
    asking = next.catch(() => false);
    return next;
  };

  ses.setPermissionRequestHandler(async (wc, permission, done, details) => {
    if (ALWAYS.has(permission)) return done(true);
    let origin;
    try {
      origin = new URL(details.requestingUrl || wc.getURL()).origin;
    } catch {
      return done(false);
    }
    if (!isWeb(origin)) return done(false);
    let keys;
    let what;
    if (permission === 'media') {
      const types = (details.mediaTypes ?? []).filter((t) => t in MEDIA);
      if (!types.length) return done(false);
      keys = types.map((t) => `media:${t}`);
      what = `use your ${types.map((t) => MEDIA[t]).join(' and ')}`;
    } else if (permission in ASKED) {
      keys = [permission];
      what = ASKED[permission];
    } else {
      return done(false);
    }
    if (keys.every((k) => decided(origin, k) === true)) return done(true);
    if (keys.some((k) => decided(origin, k) === false)) return done(false);
    const allow = await ask(origin, what);
    for (const k of keys) remember(origin, k, allow);
    done(allow);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => {
    if (ALWAYS.has(permission)) return true;
    if (permission === 'media') return decided(origin, `media:${details.mediaType}`) === true;
    return permission in ASKED && decided(origin, permission) === true;
  });

  // ------------------------------------------------------------ tabs

  const push = debounce(() => {
    if (!win.isDestroyed()) win.webContents.send('web:changed', state());
  }, 60);
  // Keys typed in a site that the page handles (Ctrl+L, Ctrl+T, Ctrl+1..9): give the keyboard back to the page first.
  const command = (c) => {
    if (win.isDestroyed()) return;
    if (!c.startsWith('show-tab:')) win.webContents.focus();
    win.webContents.send('web:command', c);
  };
  const saveTabs = debounce(() => {
    prefs.webTabs = [...tabs.values()].filter((t) => t.owner === 'web' && t.url).map((t) => ({ url: t.url, title: t.title }));
    savePrefs();
  }, 1000);

  function state() {
    return {
      apps: prefs.apps.map(({ id, name }) => ({ id, name })),
      sites: prefs.sites,
      tabs: [...tabs.values()].map((t) => {
        const wc = t.view?.webContents;
        return {
          id: t.id,
          owner: t.owner,
          title: t.title,
          url: t.url,
          loading: !!wc?.isLoading(),
          canBack: !!wc?.navigationHistory.canGoBack(),
          canForward: !!wc?.navigationHistory.canGoForward(),
          audible: !!wc?.isCurrentlyAudible(),
        };
      }),
    };
  }

  // A tab's site loads the first time it is shown (tabs brought back from last time cost nothing until then).
  function addTab(owner, url, title = '') {
    if (tabs.size >= MAX_TABS) return null;
    const t = { id: randomUUID(), owner, url, title, view: null, rect: null, fullscreen: false };
    tabs.set(t.id, t);
    push();
    if (owner === 'web') saveTabs();
    return t;
  }

  function ensureView(t) {
    if (t.view) return t.view;
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true } });
    view.setBackgroundColor('#ffffff');
    t.view = view;
    const wc = view.webContents;
    guard(wc);
    skins.attach(wc);
    const sync = () => {
      t.url = wc.getURL();
      t.title = wc.getTitle() || t.title;
      push();
      if (t.owner === 'web') saveTabs();
    };
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'audio-state-changed']) wc.on(ev, sync);
    wc.on('enter-html-full-screen', () => {
      t.fullscreen = true;
      place(t);
    });
    wc.on('leave-html-full-screen', () => {
      t.fullscreen = false;
      place(t);
    });
    wc.on('before-input-event', (e, input) => {
      if (keys(t, input)) e.preventDefault();
    });
    wc.on('context-menu', (_e, p) => contextMenu(t, p));
    if (t.url) void wc.loadURL(t.url).catch(() => {});
    return view;
  }

  function place(t) {
    if (!t.view) return;
    if (t.fullscreen) {
      const [width, height] = win.getContentSize();
      t.view.setBounds({ x: 0, y: 0, width, height });
    } else if (t.rect) {
      t.view.setBounds(t.rect);
    }
  }

  function show(id, rect, focus) {
    for (const t of tabs.values()) {
      if (t.id !== id && t.attached) {
        win.contentView.removeChildView(t.view);
        t.attached = false;
      }
    }
    const t = id ? tabs.get(id) : null;
    if (!t || !rect) {
      shown = null;
      return;
    }
    const view = ensureView(t);
    t.rect = rect;
    if (!t.attached) {
      win.contentView.addChildView(view);
      t.attached = true;
    }
    place(t);
    shown = t.id;
    if (focus) view.webContents.focus();
  }

  function closeTab(id) {
    const t = tabs.get(id);
    if (!t) return;
    if (t.attached) win.contentView.removeChildView(t.view);
    t.view?.webContents.close();
    tabs.delete(id);
    if (shown === id) shown = null;
    push();
    saveTabs();
  }

  // Typed into the address bar: a web address, a bare domain, or words to search for.
  function toUrl(input) {
    const s = String(input ?? '').trim();
    if (!s) return null;
    if (isWeb(s)) return s;
    if (/^localhost(:\d+)?(\/\S*)?$/i.test(s)) return `http://${s}`;
    if (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s)) return `https://${s}`;
    return SEARCH + encodeURIComponent(s);
  }

  function navigate(t, url) {
    t.url = url;
    if (t.view) void t.view.webContents.loadURL(url).catch(() => {});
    push();
  }

  // ------------------------------------------------------------ guards, keys, menu

  // Every site page and popup: http(s) only; new tabs open in WEB; real popups (sign-in windows) stay popups.
  function guard(wc) {
    const blockOdd = (e, url) => {
      if (!isWeb(url) && url !== 'about:blank') e.preventDefault();
    };
    wc.on('will-navigate', blockOdd);
    wc.on('will-redirect', blockOdd);
    wc.on('will-frame-navigate', (e) => blockOdd(e, e.url));
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window' && (isWeb(url) || url === 'about:blank' || url === '')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: win,
            width: 620,
            height: 760,
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        };
      }
      if (isWeb(url)) void shell.openExternal(url); // a link to a new tab: your normal browser
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child) => {
      child.setMenu(null);
      guard(child.webContents);
    });
  }

  // Shortcuts typed while a site has the keyboard. True = handled here.
  function keys(t, i) {
    if (i.type !== 'keyDown') return false;
    const wc = t.view.webContents;
    const ctrl = i.control && !i.alt && !i.meta;
    if (i.key === 'F11') return onFullscreenKey(), true;
    if (i.key === 'Escape' && t.fullscreen) return void wc.executeJavaScript('document.exitFullscreen?.()', true).catch(() => {}), true;
    if (ctrl && /^[1-9]$/.test(i.key)) return command(`program:${i.key}`), true;
    if (ctrl && i.key.toLowerCase() === 'l') return command('focus-address'), true;
    if ((ctrl && i.key.toLowerCase() === 'r') || i.key === 'F5') return wc.reload(), true;
    if (i.alt && i.key === 'ArrowLeft') return wc.navigationHistory.goBack(), true;
    if (i.alt && i.key === 'ArrowRight') return wc.navigationHistory.goForward(), true;
    if (ctrl && (i.key === '=' || i.key === '+')) return wc.setZoomLevel(Math.min(5, wc.getZoomLevel() + 0.5)), true;
    if (ctrl && i.key === '-') return wc.setZoomLevel(Math.max(-5, wc.getZoomLevel() - 0.5)), true;
    if (ctrl && i.key === '0') return wc.setZoomLevel(0), true;
    return false;
  }

  function contextMenu(t, p) {
    const wc = t.view.webContents;
    const items = [];
    if (p.linkURL && isWeb(p.linkURL)) {
      items.push(
        {
          label: 'Open link in a new tab',
          click: () => {
            const nt = addTab('web', p.linkURL);
            if (nt) command(`show-tab:${nt.id}`);
          },
        },
        { label: 'Open link in my browser', click: () => void shell.openExternal(p.linkURL) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { role: 'selectAll' }, { type: 'separator' });
    } else if (p.selectionText) {
      items.push({ role: 'copy' }, { type: 'separator' });
    }
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Open page in my browser', enabled: isWeb(wc.getURL()), click: () => void shell.openExternal(wc.getURL()) },
    );
    Menu.buildFromTemplate(items).popup({ window: win });
  }

  // ------------------------------------------------------------ bridge

  const fromApp = (e) => e.sender === win.webContents && isApp(e.senderFrame?.url ?? '');
  const okRect = (r) => {
    if (!r || typeof r !== 'object') return null;
    const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : NaN);
    const rect = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) };
    return Object.values(rect).some(Number.isNaN) || rect.width < 1 || rect.height < 1 ? null : rect;
  };
  const okSites = (list) =>
    Array.isArray(list) && list.length <= MAX_SITES
      ? list
          .filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.url === 'string' && isWeb(s.url))
          .map((s) => ({ id: s.id.slice(0, 64), name: s.name.trim().slice(0, 24) || 'Site', url: s.url.slice(0, 2048) }))
      : null;

  ipcMain.handle('web:state', (e) => (fromApp(e) ? state() : null));
  ipcMain.handle('web:new', (e, url) => {
    if (!fromApp(e)) return null;
    return addTab('web', typeof url === 'string' && isWeb(url) ? url : '')?.id ?? null;
  });
  ipcMain.handle('web:site', (e, siteId) => {
    if (!fromApp(e)) return null;
    const site = prefs.sites.find((s) => s.id === siteId);
    if (!site) return null;
    const have = [...tabs.values()].find((t) => t.owner === site.id);
    return (have ?? addTab(site.id, site.url, site.name))?.id ?? null;
  });
  ipcMain.on('web:show', (e, m) => {
    if (!fromApp(e)) return;
    show(typeof m?.tab === 'string' ? m.tab : null, okRect(m?.rect), !!m?.focus);
  });
  ipcMain.on('web:navigate', (e, m) => {
    const t = fromApp(e) && tabs.get(m?.tab);
    const url = t && toUrl(m.input);
    if (url) navigate(t, url);
  });
  ipcMain.on('web:act', (e, m) => {
    const t = fromApp(e) && tabs.get(m?.tab);
    if (!t) return;
    const wc = t.view?.webContents;
    if (m.action === 'close') return closeTab(t.id);
    if (m.action === 'outside') return isWeb(t.url) && void shell.openExternal(t.url);
    if (!wc) return;
    if (m.action === 'back') wc.navigationHistory.goBack();
    else if (m.action === 'forward') wc.navigationHistory.goForward();
    else if (m.action === 'reload') wc.reload();
    else if (m.action === 'stop') wc.stop();
    else if (m.action === 'home') {
      const site = prefs.sites.find((s) => s.id === t.owner);
      if (site) navigate(t, site.url);
    }
  });
  ipcMain.handle('web:launch', (e, id) => {
    const a = fromApp(e) && prefs.apps.find((x) => x.id === id);
    return a ? launchApp(a) : 'failed';
  });
  // Rename, reorder or remove app buttons. Only apps already in the list survive: the page cannot add a program.
  ipcMain.on('web:apps', (e, list) => {
    if (!fromApp(e) || !Array.isArray(list)) return;
    prefs.apps = list
      .map((x) => {
        const a = prefs.apps.find((p) => p.id === x?.id);
        return a && typeof x.name === 'string' ? { ...a, name: x.name.trim().slice(0, 24) || a.name } : null;
      })
      .filter(Boolean);
    savePrefs();
    push();
  });
  // Launcher: programs installed on this PC and Steam games (shell/installed.mjs). The page sends an id only;
  // it is looked up in the shell's own scan.
  const catalog = launcherCatalog({ shell });
  ipcMain.handle('launcher:installed', (e) => (fromApp(e) ? catalog.installed() : null));
  ipcMain.handle('launcher:games', (e) => (fromApp(e) ? catalog.games() : null));
  ipcMain.handle('launcher:open-installed', (e, id) => (fromApp(e) && typeof id === 'string' ? catalog.openInstalled(id) : false));
  ipcMain.handle('launcher:open-game', (e, id) => (fromApp(e) && typeof id === 'string' ? catalog.openGame(id) : false));
  // Paste a screenshot: the picture on the clipboard as PNG bytes, or null. Chromium on Wayland often gives the
  // page no file for a copied picture (Omarchy's screenshot key), so the page asks here when its paste had none.
  ipcMain.handle('clipboard:image', (e) => (fromApp(e) ? clipboardImage() : null));
  // FILES right-click: show a file in the system file manager (a folder opens itself). Only real absolute paths;
  // a file is never opened, only shown, so nothing from the page can start a program.
  ipcMain.handle('files:show', async (e, path) => {
    if (!fromApp(e) || typeof path !== 'string' || !isAbsolute(path)) return false;
    const st = await stat(path).catch(() => null);
    if (!st) return false;
    if (st.isDirectory()) return (await shell.openPath(path)) === '';
    shell.showItemInFolder(path);
    return true;
  });
  // STATION skins: which addresses get which app's skin, and the app's theme. Applied on every page of those sites.
  ipcMain.on('web:skins', (e, cfg) => fromApp(e) && skins.set(cfg));
  ipcMain.on('web:sites', (e, list) => {
    const sites = fromApp(e) && okSites(list);
    if (!sites) return;
    const before = new Map(prefs.sites.map((s) => [s.id, s]));
    prefs.sites = sites;
    savePrefs();
    for (const t of [...tabs.values()]) {
      if (t.owner === 'web') continue;
      const site = sites.find((s) => s.id === t.owner);
      if (!site) closeTab(t.id); // button removed
      else if (before.get(site.id)?.url !== site.url) navigate(t, site.url); // address changed
    }
    push();
  });

  // The app page reloads or goes to the login page: no site may cover it.
  win.webContents.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) show(null, null, false);
  });
  win.on('resize', () => shown && place(tabs.get(shown)));

  for (const saved of prefs.webTabs) if (isWeb(saved.url)) addTab('web', saved.url, saved.title);

  return {
    forgetPermissions() {
      prefs.webPermissions = {};
      savePrefs();
    },
    // Tray: bring back the Web and Discord buttons after removing them.
    restoreApps() {
      const have = new Set(prefs.apps.map((a) => a.id));
      prefs.apps = [...prefs.apps, ...defaultApps().filter((a) => !have.has(a.id))];
      savePrefs();
      push();
    },
  };
}

function debounce(fn, ms) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// The clipboard's picture as PNG bytes, or null. Electron first; on Linux Wayland also wl-paste (Omarchy has it).
function clipboardImage() {
  const img = clipboard.readImage();
  if (!img.isEmpty()) return Promise.resolve(img.toPNG());
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('wl-paste', ['--no-newline', '--type', 'image/png'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 3000 }, (err, out) =>
      resolve(!err && out?.length > 8 && out.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? out : null),
    );
  });
}
