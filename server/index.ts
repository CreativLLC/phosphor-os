import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { AUTO_MODEL, EFFORTS, INSTRUCTIONS_MAX, MODES, type ClientEvent, type ServerEvent } from '../shared/protocol.ts';
import { checkPassword, isAuthed, loginLocked, makeCookie, noteLogin, setPassword } from './auth.ts';
import { bootChecks } from './bootcheck.ts';
import { calendarRange, startCalendar, today } from './calendar.ts';
import { handleCleanup } from './cleanup.ts';
import { handleIdeas, startIdeas } from './ideas.ts';
import { handleKeywords } from './keywords.ts';
import { handleLab, serveLabFile, startLab } from './lab.ts';
import { WEB_DIST, config } from './config.ts';
import { handleDocs, handleOpenLocal, localKey } from './docs.ts';
import { ledger, routerOn } from './delegate.ts';
import { handleFiles } from './files.ts';
import { serveImage } from './imagegen.ts';
import { startLocalRelay } from './localrelay.ts';
import { handleMcp } from './mcp.ts';
import { handlePasskeys } from './passkeys.ts';
import { handleStation, startStation } from './station.ts';
import { handleUpdate, startUpdates, updateState } from './sdkupdate.ts';
import { handleSystem } from './system.ts';
import { handlePrompter } from './prompter.ts';
import { handlePush, notePresence, watchForPush } from './push.ts';
import { Tabs } from './tabs.ts';
import { startUnraid } from './unraid.ts';
import { getUpload, receiveUpload, serveUpload } from './uploads.ts';
import { usage } from './usage.ts';
import { handleVoice, voiceSockets } from './voice.ts';
import { handleKeyboardToken, handleVoiceApi } from './voiceapi.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const wss = new WebSocketServer({ noServer: true });
const tabs = new Tabs(broadcast);
await tabs.restore();
startUpdates(tabs, broadcast);

function broadcast(ev: ServerEvent): void {
  const data = JSON.stringify(ev);
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  watchForPush(ev); // ALERTS: push when a turn ends or Claude needs you (server/push.ts)
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ t: 'hello', tabs: tabs.list() } satisfies ServerEvent));
  ws.send(JSON.stringify({ t: 'sdk_update', state: updateState() } satisfies ServerEvent));
  ws.on('message', (raw) => {
    let ev: ClientEvent;
    try {
      ev = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (ev.t === 'new_tab') return tabs.create(ev.cwd, ev.req);
    if (ev.t === 'new_project') return typeof ev.name === 'string' && ev.name.trim() ? tabs.createProject(ev.name.trim().slice(0, 60), ev.req) : undefined;
    if (ev.t === 'new_project_chat') return typeof ev.project === 'string' ? tabs.createInProject(ev.project, typeof ev.title === 'string' ? ev.title : undefined, ev.req) : undefined;
    if (ev.t === 'open_project') return typeof ev.project === 'string' ? void tabs.openProject(ev.project, ev.req) : undefined;
    if (ev.t === 'open_session') return void tabs.open(String(ev.sessionId), String(ev.cwd), String(ev.title ?? ''), ev.req);
    if (ev.t === 'close_tab') return tabs.close(ev.tab);
    if (ev.t === 'open_lead') return typeof ev.project === 'string' ? void tabs.openLead(ev.project, ev.req) : undefined;
    if (ev.t === 'move_to_project') return typeof ev.tab === 'string' && (typeof ev.project === 'string' || ev.project === null) ? tabs.moveToProject(ev.tab, ev.project) : undefined;
    if (ev.t === 'reorder_tabs') return Array.isArray(ev.ids) ? tabs.reorder(ev.ids.slice(0, 500).map(String)) : undefined;
    if (ev.t === 'reopen_closed') return void tabs.reopenClosed(ev.req);
    if (ev.t === 'presence') return notePresence(ws, ev);
    const tab = tabs.get(ev.tab);
    if (!tab) return;
    if (ev.t === 'send' && typeof ev.text === 'string') {
      const ids = Array.isArray(ev.attachments) ? ev.attachments.slice(0, 20) : [];
      const files = ids.map((id) => getUpload(String(id))).filter((f) => f !== undefined);
      if (ev.text.trim() || files.length) tab.send(ev.text, files);
    }
    else if (ev.t === 'perm') tab.answerPermission(ev.id, ev.allow === true);
    else if (ev.t === 'ask') tab.answerQuestions(ev.id, ev.answers);
    else if (ev.t === 'stop') void tab.stop();
    else if (ev.t === 'resume') ev.now === true ? tab.resumeNow() : tab.clearResume();
    else if (ev.t === 'mode' && MODES.includes(ev.mode)) void tab.setMode(ev.mode);
    else if (ev.t === 'model' && ev.model === AUTO_MODEL) tab.setAuto(true);
    else if (ev.t === 'model' && typeof ev.model === 'string' && /^[\w.:[\]-]{1,80}$/.test(ev.model)) void tab.setModel(ev.model);
    else if (ev.t === 'effort' && EFFORTS.includes(ev.effort)) void tab.setEffort(ev.effort);
    else if (ev.t === 'undo' && typeof ev.id === 'string') void tab.undo(ev.id, ev.dryRun !== false);
    else if (ev.t === 'rename_tab' && typeof ev.title === 'string' && ev.title.trim()) tab.rename(ev.title.trim());
  });
});

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function sendFile(res: ServerResponse, file: string, extra: Record<string, string> = {}): void {
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', ...extra });
  res.end(readFileSync(file));
}

function readBody(req: IncomingMessage, max = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > max) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (url.pathname === '/login' && req.method === 'POST') {
    if (loginLocked()) {
      res.writeHead(429).end('Too many tries. Wait a minute.');
      return;
    }
    const password = new URLSearchParams(await readBody(req)).get('password') ?? '';
    const ok = checkPassword(password);
    noteLogin(ok);
    if (ok) res.writeHead(303, { Location: '/', 'Set-Cookie': makeCookie() }).end();
    else res.writeHead(303, { Location: '/login.html?wrong=1' }).end();
    return;
  }

  // Fingerprint login: its login routes are public, adding one needs the cookie (checked inside).
  if (url.pathname.startsWith('/api/passkey/')) {
    try {
      return await handlePasskeys(req, res, url, isAuthed(req));
    } catch (e) {
      return sendJson(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  }

  // The desktop app opens a file from the PC in DOCS. Guarded by a key file instead of the cookie (server/docs.ts).
  if (url.pathname === '/api/docs/open-local') return await handleOpenLocal(req, res);

  // PHONE KEYBOARD: OpenAI-style speech to text for phone keyboards, with its own token instead of the cookie (server/voiceapi.ts).
  if (url.pathname.startsWith('/v1/')) return await handleVoiceApi(req, res, url);

  // LAB result files: sandboxed, opened by the test's key instead of the cookie (server/lab.ts).
  if (url.pathname.startsWith('/lab/v/') && req.method === 'GET') return serveLabFile(res, url);

  // Only the login page and its assets are public. Everything else needs the cookie.
  const publicPath = url.pathname === '/login.html' || url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest' || url.pathname === '/sw.js' || url.pathname === '/favicon.svg' || url.pathname.startsWith('/icons/');
  if (!publicPath && !isAuthed(req)) {
    if (url.pathname.startsWith('/api/')) return sendJson(res, { error: 'login needed' }, 401);
    res.writeHead(303, { Location: '/login.html' }).end();
    return;
  }

  try {
    if (url.pathname === '/api/projects') return sendJson(res, tabs.projectList());
    const del = /^\/api\/projects\/([\w-]+)\/delete$/.exec(url.pathname);
    if (del) {
      // JSON only: a form on another page cannot send it.
      if (req.method !== 'POST' || !String(req.headers['content-type'] ?? '').includes('application/json')) return sendJson(res, { error: 'POST JSON only.' }, 405);
      const r = tabs.deleteProject(del[1]);
      return sendJson(res, r, 'error' in r ? 409 : 200);
    }
    const rules = /^\/api\/projects\/([\w-]+)\/instructions$/.exec(url.pathname);
    if (rules) {
      if (req.method === 'GET') return sendJson(res, tabs.book.instructions(rules[1]));
      if (req.method !== 'POST' || !String(req.headers['content-type'] ?? '').includes('application/json')) return sendJson(res, { error: 'POST JSON only.' }, 405);
      let text: unknown;
      try {
        text = JSON.parse(await readBody(req, 4 * INSTRUCTIONS_MAX)).text;
      } catch {
        /* bad JSON */
      }
      if (typeof text !== 'string') return sendJson(res, { error: 'Send { text }.' }, 400);
      const r = tabs.setInstructions(rules[1], text);
      return sendJson(res, r, 'error' in r ? 400 : 200);
    }
    if (url.pathname === '/api/history') return sendJson(res, await tabs.history(url.searchParams.has('all')));
    if (url.pathname === '/api/history/search') return sendJson(res, await tabs.searchHistory(url.searchParams.get('q') ?? '', url.searchParams.has('all')));
    if (url.pathname === '/api/folders') return sendJson(res, tabs.folders());
    if (url.pathname === '/api/models') return sendJson(res, await tabs.models());
    if (url.pathname === '/api/password' && req.method === 'POST') {
      // Change the password: needs the current one. Other devices are logged out; this one stays in.
      if (loginLocked()) return sendJson(res, { error: 'Too many tries. Wait a minute.' }, 429);
      let body: { current?: unknown; next?: unknown } = {};
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        /* empty or bad JSON */
      }
      const ok = checkPassword(String(body.current ?? ''));
      noteLogin(ok);
      if (!ok) return sendJson(res, { error: 'The current password is wrong.' }, 403);
      const problem = setPassword(String(body.next ?? ''));
      if (problem) return sendJson(res, { error: problem }, 400);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': makeCookie() }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/api/upload') return await receiveUpload(req, res, url);
    const upload = url.pathname.match(/^\/api\/upload\/([0-9a-f-]{36})$/);
    if (upload) return serveUpload(res, upload[1]);
    const image = url.pathname.match(/^\/api\/images\/([^/]+)$/);
    if (image) return serveImage(res, decodeURIComponent(image[1]));
    if (url.pathname.startsWith('/api/files/')) return await handleFiles(req, res, url, tabs);
    if (url.pathname === '/api/mcp' || url.pathname === '/api/commands') return await handleMcp(req, res, url, tabs);
    if (url.pathname === '/api/voice/cleanup') return await handleCleanup(req, res);
    if (url.pathname === '/api/voice/keyboard' || url.pathname === '/api/voice/keyboard/new') return await handleKeyboardToken(req, res, url);
    if (url.pathname === '/api/transcribe' || url.pathname === '/api/voice' || url.pathname.startsWith('/api/voice/')) return await handleVoice(req, res, url);
    if (url.pathname === '/api/push' || url.pathname.startsWith('/api/push/')) return await handlePush(req, res, url);
    if (url.pathname === '/api/usage') return sendJson(res, await usage(tabs, url.searchParams.has('details'), url.searchParams.has('fresh')));
    if (url.pathname === '/api/router') return sendJson(res, ledger.status(routerOn())); // ROUTER totals (server/delegate.ts)
    if (url.pathname === '/api/system' || url.pathname.startsWith('/api/system/')) return await handleSystem(req, res, url);
    if (url.pathname === '/api/station' || url.pathname.startsWith('/api/station/')) return await handleStation(req, res, url);
    if (url.pathname.startsWith('/api/docs/')) return await handleDocs(req, res, url);
    if (url.pathname === '/api/update') return await handleUpdate(req, res, url);
    if (url.pathname === '/api/bootcheck') return sendJson(res, await bootChecks(tabs));
    if (url.pathname === '/api/today') return sendJson(res, await today());
    if (url.pathname === '/api/ideas' || url.pathname.startsWith('/api/ideas/')) return await handleIdeas(req, res, url);
    if (url.pathname.startsWith('/api/lab/')) return await handleLab(req, res, url);
    if (url.pathname.startsWith('/api/keywords/')) return await handleKeywords(req, res, url);
    if (url.pathname.startsWith('/api/prompter/')) return await handlePrompter(req, res, url);
    if (url.pathname === '/api/calendar') return sendJson(res, calendarRange(Number(url.searchParams.get('from') ?? NaN), Number(url.searchParams.get('to') ?? NaN)));
    if (url.pathname.startsWith('/api/')) return sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    return sendJson(res, { error: e instanceof Error ? e.message : String(e) }, 500);
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = normalize(join(WEB_DIST, rel));
  if (!file.startsWith(WEB_DIST + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  // Opening the app renews the login, so a device that uses it never gets logged out.
  sendFile(res, file, rel === 'index.html' ? { 'Set-Cookie': makeCookie() } : {});
});

server.on('upgrade', (req, socket, head) => {
  // The cookie is SameSite=Lax (other sites cannot POST with it); the Origin check is a second guard.
  const origin = req.headers.origin ? new URL(req.headers.origin).hostname : '';
  const okOrigin = origin === 'localhost' || origin === '127.0.0.1' || origin.endsWith('.ts.net');
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (!okOrigin || !isAuthed(req) || (path !== '/ws' && path !== '/ws/voice')) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  // Live DICTATE audio (server/voice.ts).
  if (path === '/ws/voice') return voiceSockets.handleUpgrade(req, socket, head, (ws) => voiceSockets.emit('connection', ws, req));
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

startLocalRelay();
startCalendar();
startIdeas();
startLab();
startStation();
startUnraid();
localKey().catch((e) => console.warn('docs: could not make the key for opening files from the PC:', e));
server.listen(config.port, config.host, () => {
  console.log(`\n  PHOSPHOR-OS is running.`);
  console.log(`  Open:     http://localhost:${config.port}`);
  console.log(`  Folder:   ${config.cwd}`);
  if (config.newPassword) console.log(`  Password: ${config.password}   (saved in .env; change it there)`);
  console.log('');
});
