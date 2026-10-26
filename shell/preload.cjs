// Bridge between the app page and the desktop app (shell/web.mjs): window.phosphorShell.
// Exposed only on the app's own address; the main process checks every message again.
// Sandboxed preload: CommonJS, and only the 'electron' module is available.

const { contextBridge, ipcRenderer } = require('electron');

const base = (process.argv.find((a) => a.startsWith('--phosphor-base=')) ?? '').slice('--phosphor-base='.length);

if (base && location.origin === base) {
  contextBridge.exposeInMainWorld('phosphorShell', {
    version: 1,
    // 'linux', 'win32', 'darwin': the page shows what fits the OS (no LAUNCH button on Linux: the Super key opens it).
    platform: process.platform,
    state: () => ipcRenderer.invoke('web:state'),
    newTab: (url) => ipcRenderer.invoke('web:new', typeof url === 'string' ? url : ''),
    site: (id) => ipcRenderer.invoke('web:site', String(id)),
    show: (tab, rect, focus) => ipcRenderer.send('web:show', { tab, rect, focus: !!focus }),
    navigate: (tab, input) => ipcRenderer.send('web:navigate', { tab, input: String(input) }),
    act: (tab, action) => ipcRenderer.send('web:act', { tab, action: String(action) }),
    setSites: (sites) => ipcRenderer.send('web:sites', sites),
    launch: (id) => ipcRenderer.invoke('web:launch', String(id)),
    setApps: (apps) => ipcRenderer.send('web:apps', apps),
    onChange: (fn) => ipcRenderer.on('web:changed', (_e, s) => fn(s)),
    onCommand: (fn) => ipcRenderer.on('web:command', (_e, c) => fn(String(c))),
    // Launcher (shell/installed.mjs): programs on this PC and Steam games. Only ids go back.
    installed: () => ipcRenderer.invoke('launcher:installed'),
    games: () => ipcRenderer.invoke('launcher:games'),
    openInstalled: (id) => ipcRenderer.invoke('launcher:open-installed', String(id)),
    openGame: (id) => ipcRenderer.invoke('launcher:open-game', String(id)),
    // STATION skins (shell/skins.mjs): the theme and which self-hosted apps get the Retro look.
    setSkins: (cfg) => ipcRenderer.send('web:skins', cfg),
    // Paste: the clipboard's picture as PNG bytes (null when there is none).
    clipboardImage: () => ipcRenderer.invoke('clipboard:image'),
    // FILES: show this absolute path in the system file manager.
    showInFolder: (path) => ipcRenderer.invoke('files:show', String(path)),
    // A picture file, full size in the system image viewer.
    openImage: (path) => ipcRenderer.invoke('files:open-image', String(path)),
    // DICTATE in any app (shell/dictate.mjs): its CLEAN UP setting.
    dictate: () => ipcRenderer.invoke('dictate:get'),
    setDictate: (patch) => ipcRenderer.invoke('dictate:set', { cleanup: patch?.cleanup }),
  });
}
