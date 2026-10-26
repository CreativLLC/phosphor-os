import '@fontsource/vt323';
import './theme.css';
import './layout.css';
import './chat.css';
import './agents.css';
import './today.css';
import './ideas.css';
import './calendar.css';
import './mission.css';
import './files.css';
import './voice.css';
import './mcp.css';
import './usage.css';
import './browser.css';
import './system.css';
import './sdkupdate.css';
import { initAlerts } from './alerts.ts';
import { mountAgents } from './agents.ts';
import { mountAttach } from './attach.ts';
import { startBoot } from './boot.ts';
import { startCrt } from './crt.ts';
import { insertIntoChat, mountChat } from './chat.ts';
import { startDemo } from './demo.ts';
import { funCommands, startFun } from './fun.ts';
import { mountFiles } from './files.ts';
import { mountHistory } from './history.ts';
import { mountLauncher } from './launcher.ts';
import { addLauncherCommands, removeLauncherCommands } from './launcher.ts';
import { mountDocs } from './docs.ts';
import { keywordsCommands, mountKeywords } from './keywords.ts';
import { labCommands, mountLab } from './lab.ts';
import { showChat } from './programs.ts';
import { mountMcp } from './mcp.ts';
import { mountUsage } from './usage.ts';
import { mountMission, mountProgress } from './mission.ts';
import { mountPickers } from './pickers.ts';
import { mountPrograms } from './programs.ts';
import { shellApi } from './shellapi.ts';
import { mountResume } from './resume.ts';
import { apply, connect } from './net.ts';
import { mountSettings } from './settings.ts';
import { mountUpdate } from './sdkupdate.ts';
import { mountSlash } from './slash.ts';
import { mountStation } from './station.ts';
import { initSound } from './sound.ts';
import { mountSystem } from './system.ts';
import { store } from './store.ts';
import { mountTabs } from './tabs.ts';
import { mountUndo } from './undo.ts';
import { mountVoice } from './voice.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

startBoot();
startCrt();
mountSettings($('settings'));
initSound();
startFun(); // screensaver, ship voice, game mode (fun.ts)
mountTabs($('tabs'), $<HTMLDialogElement>('newtab'));
mountHistory($('history'), $('btn-history'));
mountMcp($('mcp'), $('btn-mcp'));
mountUsage($('usage'));
mountUpdate($<HTMLButtonElement>('btn-update'));
mountChat($('log'), $('composer'));
mountSlash($('composer'));
mountUndo($<HTMLDialogElement>('undo-dialog'));
mountAttach($('composer'), $('center'));
mountVoice($<HTMLButtonElement>('dictate'), $<HTMLTextAreaElement>('input'));
mountPickers($<HTMLSelectElement>('model'), $<HTMLSelectElement>('effort'));
mountProgress($('progress'));
mountResume($('progress'));
mountAgents($('agents'));
mountMission($('mission'));
mountFiles($('files'), { insertIntoChat });
mountSystem($('system'));
// STATION: your self-hosted services (drawer). Before the program bar, which hides sites while it is open.
mountStation($('station'), $('btn-station'));
// Desktop app only: program bar (CHAT, WEB, saved sites) and the web pane. Last: it watches SETTINGS, HISTORY and MCP.
mountPrograms($('programs'), $('webapp'));
// LAUNCHER: Ctrl+K, the LAUNCH button (MENU on phones), the desktop app's 'launcher' command. After the program bar.
mountLauncher($('btn-launch'));
// Linux desktop app: no LAUNCH button, the Super key opens the launcher. Asked of the desktop app itself, never the
// user agent (Android's says Linux too). Windows and the phone keep it; Ctrl+K and the launcher's keys stay.
if (shellApi?.platform === 'linux') $('btn-launch').hidden = true;
initAlerts(); // phone push and background alerts (alerts.ts); before connect(): it reads ?tab=
// DOCS: documents in the docs folder (PHOSPHOR_DOCS_DIR). DOCS button, program bar, launcher commands.
mountDocs($('btn-docs'), { insertIntoChat, showChat, addCommands: addLauncherCommands, removeCommands: removeLauncherCommands });
// LAB: one prompt to many AI models (lab.ts). After DOCS: each closes the other.
mountLab($('btn-lab'));
addLauncherCommands(labCommands);
// KEYWORDS: YouTube keyword check (keywords.ts). Each of DOCS, LAB and KEYWORDS closes the others.
mountKeywords($('btn-keys'));
addLauncherCommands(keywordsCommands);

// Fullscreen button (Fullscreen API). Hidden where the browser can't, or when the app already runs fullscreen.
const fullBtn = $('btn-full');
const syncFull = () => {
  fullBtn.textContent = document.fullscreenElement ? 'EXIT FULL' : 'FULL';
  fullBtn.hidden = !document.fullscreenEnabled || matchMedia('(display-mode: fullscreen)').matches;
};
fullBtn.onclick = () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
};
document.addEventListener('fullscreenchange', syncFull);
syncFull();

// Right panel: MISSION / FILES switch.
const panels = document.querySelectorAll<HTMLButtonElement>('.panel-switch button');
for (const b of panels) {
  b.onclick = () => {
    for (const x of panels) x.classList.toggle('on', x === b);
    $('mission').hidden = b.dataset.view !== 'mission';
    $('files').hidden = b.dataset.view !== 'files';
    $('system').hidden = b.dataset.view !== 'system';
  };
}

// Launcher commands from the other parts (each part exports its list; launcher.ts shows them under COMMANDS).
// Right-panel views open the panel too (it slides in on phones).
const showPanel = (view: string) => {
  document.querySelector<HTMLButtonElement>(`.panel-switch button[data-view="${view}"]`)?.click();
  if (getComputedStyle($('btn-right')).display !== 'none') document.body.classList.add('show-right');
};
addLauncherCommands([
  { id: 'sys', label: 'SYSTEM', hint: 'CPU, MEMORY, GPU, DRIVES, NETWORK, VOLUME', keywords: ['sys', 'cpu', 'ram', 'gpu', 'disk', 'volume', 'pc'], run: () => showPanel('system') },
  { id: 'mission', label: 'MISSION', hint: 'WHAT CLAUDE IS DOING', keywords: ['progress', 'steps', 'task'], run: () => showPanel('mission') },
  { id: 'files', label: 'FILES', hint: "THIS CHAT'S FOLDER", keywords: ['explorer', 'folder'], run: () => showPanel('files') },
  ...funCommands(),
]);

// Phones: the header tools live in a MENU; the message box pickers behind OPTIONS.
const menuBtn = $('btn-menu');
const setMenu = (open: boolean) => {
  document.body.classList.toggle('menu-open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
};
menuBtn.onclick = (e) => {
  e.stopPropagation();
  setMenu(!document.body.classList.contains('menu-open'));
};
document.querySelector('.top-tools')!.addEventListener('click', (e) => {
  // Picking AGENTS / HISTORY / INFO closes the menu; SETTINGS keeps it open while its box shows.
  if ((e.target as HTMLElement).closest('#settings')) return;
  setMenu(false);
});
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.top-tools, #btn-menu, .settings-pop')) setMenu(false);
});
const optsBtn = $('btn-opts');
optsBtn.onclick = () => {
  const open = $('composer').classList.toggle('opts-open');
  optsBtn.setAttribute('aria-expanded', String(open));
};

// Narrow screens (folded phone): side panels slide over the chat.
$('btn-left').onclick = () => document.body.classList.toggle('show-left');
$('btn-right').onclick = () => document.body.classList.toggle('show-right');
$('app').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('#left, #right, #btn-left, #btn-right')) return;
  document.body.classList.remove('show-left', 'show-right');
});

// OFFLINE banner: only after a short wait, so a quick relink (phone screen back on) does not flash it.
let offlineTimer = 0;
store.on((c) => {
  if (c.kind !== 'connection') return;
  clearTimeout(offlineTimer);
  if (store.connected || store.demo) document.body.classList.remove('offline');
  else offlineTimer = window.setTimeout(() => document.body.classList.toggle('offline', !store.connected), 2000);
});

if (new URLSearchParams(location.search).has('demo')) {
  store.demo = true;
  startDemo();
} else {
  connect();
}

// Dev server only (stripped from the build): lets perf scripts push fake events.
if (import.meta.env.DEV) Object.assign(window, { __retro: { apply, store } });

// Service worker: lets the page install as a home-screen app (Firefox needs one); caches nothing.
if ('serviceWorker' in navigator && !store.demo) navigator.serviceWorker.register('/sw.js').catch(() => {});
