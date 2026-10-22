import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { TranscribeResponse, VoiceLiveEvent, VoiceStatusResponse } from '../shared/protocol.ts';
import { DATA_DIR } from './config.ts';
import { voiceDir, voiceSetupCommand } from './osdirs.ts';

// DICTATE: speech to text on this PC. The engine (sherpa-onnx + NVIDIA Parakeet + Silero VAD, installed
// by scripts/setup-voice.ps1, or scripts/setup-voice.sh on Linux, outside any synced folder) runs in a child process that this server
// starts on first use and talks to over an IPC pipe: no network port at all. It stops with the server
// (the child exits when the pipe closes) and after IDLE_MS without use, to give back ~1 GB of memory.
//
//   WebSocket /ws/voice       live: the page streams 16 kHz mono 16-bit PCM while you talk, then sends
//                             {"t":"end"}; the server answers VoiceLiveEvent JSON (partial, final, done).
//                             Login and Origin are checked in index.ts before the upgrade.
//   GET  /api/voice           -> VoiceStatusResponse
//   POST /api/voice/warm      -> 202; loads the model
//   POST /api/transcribe      one shot, body: 16 kHz mono 16-bit PCM WAV, up to 5 minutes -> TranscribeResponse
//                             (the page uses it when the live socket can't connect or breaks)
//   POST /api/voice/diag      JSON, a take's timing from the page -> one line in data/voice-diag.log
//                             (with the engine's start and stop), to find what makes a start slow

export const VOICE_DIR = voiceDir();
const WORKER = fileURLToPath(new URL('./voice-worker.mjs', import.meta.url));

const RATE = 16000;
const MAX_SECONDS = 300;
const MAX_PCM = (MAX_SECONDS + 2) * RATE * 2; // a little slack for the page's stop tail
const MAX_BODY = MAX_PCM + 4096; // WAV header and extra chunks
const MAX_QUEUE = 3;
const DECODE_TIMEOUT_MS = 120_000;
const IDLE_MS = 20 * 60_000;
const MAX_LIVE = 3; // live sessions at once (PC + phone + one spare)
const MAX_LIVE_SECONDS = 10 * 60;

const DIAG_LOG = join(DATA_DIR, 'voice-diag.log');
const DIAG_MAX = 256 * 1024; // then it moves to voice-diag.log.old and starts over

const NOT_INSTALLED = `The voice engine is not installed. On the PC run: ${voiceSetupCommand()}`;

type Waiter = { resolve: (r: { text: string; ms: number }) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type WorkerMsg = { t: string; id?: number; sid?: number; text?: string; ms?: number; end?: number; message?: string; live?: boolean; joinPrev?: boolean };

let child: ChildProcess | undefined;
let ready: Promise<void> | undefined;
let loaded = false;
let nextId = 1;
const waiting = new Map<number, Waiter>();
let nextSid = 1;
const live = new Map<number, WebSocket>(); // live sessions by id
let idleTimer: NodeJS.Timeout | undefined;

export const voiceInstalled = () => existsSync(join(VOICE_DIR, 'install.json'));

function diag(line: object): void {
  try {
    if (existsSync(DIAG_LOG) && statSync(DIAG_LOG).size > DIAG_MAX) renameSync(DIAG_LOG, `${DIAG_LOG}.old`);
    appendFileSync(DIAG_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  } catch {
    /* the log is only a help */
  }
}

function touch(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (waiting.size === 0 && live.size === 0) stopVoice();
    else touch();
  }, IDLE_MS);
  idleTimer.unref();
}

export function stopVoice(): void {
  if (child) diag({ engine: 'stop' });
  clearTimeout(idleTimer);
  child?.kill();
  child = undefined;
  ready = undefined;
  loaded = false;
}

function toWorker(msg: object): void {
  if (child?.connected) child.send(msg);
}

function sendLive(ws: WebSocket, ev: VoiceLiveEvent): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev));
}

// Start the worker if it is not running; resolves once the model is loaded.
function start(): Promise<void> {
  touch();
  if (ready) return ready;
  const proc = fork(WORKER, [VOICE_DIR], {
    execArgv: [], // plain Node: not the tsx loader this server runs under
    serialization: 'advanced', // audio goes over the pipe as raw bytes
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
    // Linux and Mac: the addon's libraries sit next to it. Its RPATH already says so; this is a second way in.
    ...(process.platform === 'linux' && { env: { ...process.env, LD_LIBRARY_PATH: [join(VOICE_DIR, 'node_modules', `sherpa-onnx-linux-${process.arch}`), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } }),
    ...(process.platform === 'darwin' && { env: { ...process.env, DYLD_LIBRARY_PATH: [join(VOICE_DIR, 'node_modules', `sherpa-onnx-darwin-${process.arch}`), process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':') } }),
  });
  child = proc;
  ready = new Promise<void>((resolve, reject) => {
    proc.on('message', (raw) => {
      const m = raw as WorkerMsg;
      if (m.sid !== undefined) return fromWorkerLive(m);
      if (m.t === 'ready') {
        loaded = true;
        console.log(`  Voice engine ready (${m.ms} ms${m.live ? '' : ', no VAD: live dictation off'}).`);
        diag({ engine: 'ready', ms: m.ms, live: m.live });
        resolve();
        return;
      }
      if (m.t === 'error') {
        reject(new Error(`The voice engine failed to start: ${m.message}`));
        return;
      }
      const w = waiting.get(m.id ?? -1);
      if (!w) return;
      waiting.delete(m.id!);
      clearTimeout(w.timer);
      if (m.t === 'result') w.resolve({ text: m.text ?? '', ms: m.ms ?? 0 });
      else w.reject(new Error(`The voice engine failed: ${m.message}`));
    });
    proc.on('error', (e) => reject(e));
    proc.on('exit', (code) => {
      reject(new Error(`The voice engine stopped (code ${code}).`));
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error('The voice engine stopped. Try again.'));
      }
      waiting.clear();
      for (const ws of live.values()) {
        sendLive(ws, { t: 'error', error: 'The voice engine stopped.' });
        ws.close();
      }
      live.clear();
      if (child === proc) {
        child = undefined;
        ready = undefined;
        loaded = false;
      }
    });
  });
  ready.catch(() => proc.kill()); // a failed start is retried on the next request
  return ready;
}

async function transcribe(pcm: Buffer): Promise<{ text: string; ms: number }> {
  await start();
  const proc = child;
  if (!proc?.connected) throw new Error('The voice engine stopped. Try again.');
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('The voice engine took too long.'));
      stopVoice(); // stuck: start fresh next time
    }, DECODE_TIMEOUT_MS);
    waiting.set(id, { resolve, reject, timer });
    proc.send({ t: 'decode', id, pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) });
  });
}

// ---- Live dictation over /ws/voice ----

// index.ts upgrades /ws/voice here after the same login and Origin checks as /ws.
export const voiceSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
voiceSockets.on('connection', onLiveSocket);

function onLiveSocket(ws: WebSocket): void {
  if (!voiceInstalled()) {
    sendLive(ws, { t: 'error', error: NOT_INSTALLED });
    ws.close();
    return;
  }
  if (live.size >= MAX_LIVE) {
    sendLive(ws, { t: 'error', error: 'Too many dictations at once. Stop one and try again.' });
    ws.close();
    return;
  }
  const sid = nextSid++;
  live.set(sid, ws);
  let bytes = 0;
  let ended = false;
  start().then(
    () => sendLive(ws, { t: 'ready' }),
    (e) => {
      sendLive(ws, { t: 'error', error: e instanceof Error ? e.message : String(e) });
      ws.close();
    },
  );
  toWorker({ t: 'open', sid }); // queued in the pipe while the model loads

  ws.on('message', (data, isBinary) => {
    touch();
    if (isBinary) {
      if (ended) return;
      const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      bytes += buf.length;
      if (bytes > MAX_LIVE_SECONDS * RATE * 2) {
        sendLive(ws, { t: 'error', error: `Too long: ${MAX_LIVE_SECONDS / 60} minutes at most.` });
        ws.close();
        return;
      }
      toWorker({ t: 'audio', sid, pcm: new Uint8Array(buf) }); // a copy: the pipe would carry ws's whole read buffer
      return;
    }
    let msg: { t?: unknown } = {};
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t === 'end' && !ended) {
      ended = true;
      toWorker({ t: 'end', sid });
    }
  });
  // Closing the socket cancels: the worker drops this session and anything not yet final.
  ws.on('close', () => {
    if (live.delete(sid)) toWorker({ t: 'close', sid });
  });
}

function fromWorkerLive(m: WorkerMsg): void {
  const ws = live.get(m.sid!);
  if (!ws) return;
  if (m.t === 'partial') sendLive(ws, { t: 'partial', text: m.text ?? '' });
  else if (m.t === 'final') sendLive(ws, { t: 'final', text: m.text ?? '', end: m.end ?? 0, joinPrev: m.joinPrev });
  else if (m.t === 'done' || m.t === 'error') {
    sendLive(ws, m.t === 'done' ? { t: 'done', end: m.end ?? 0 } : { t: 'error', error: m.message ?? 'The voice engine failed.' });
    live.delete(m.sid!);
    ws.close();
  }
}

// ---- One shot over HTTP ----

// The PCM samples of a 16 kHz mono 16-bit WAV, or an error message.
export function wavPcm(buf: Buffer): Buffer | string {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 'Not a WAV file.';
  let pos = 12;
  let fmtOk = false;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) return 'Bad WAV header.';
      const format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (format !== 1 || channels !== 1 || rate !== RATE || bits !== 16) return 'Send 16 kHz mono 16-bit PCM WAV.';
      fmtOk = true;
    } else if (id === 'data') {
      if (!fmtOk) return 'Bad WAV header.';
      const end = Math.min(buf.length, body + size); // some writers leave the size at 0 or 0xFFFFFFFF
      const len = (size === 0 ? buf.length - body : end - body) & ~1;
      return buf.subarray(body, body + len);
    }
    pos = body + size + (size % 2);
  }
  return 'No audio in the WAV file.';
}

// Read the body up to `max` bytes; null when it is bigger.
function readBuffer(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        parts.length = 0;
        resolve(null);
        req.resume();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => over || resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, data: TranscribeResponse | VoiceStatusResponse | { ok: true }): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

// Routes /api/voice* and /api/transcribe. Login is checked by the caller (index.ts).
export async function handleVoice(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/api/voice' && req.method === 'GET') {
    return reply(res, 200, { installed: voiceInstalled(), loaded, maxSeconds: MAX_SECONDS });
  }
  if (url.pathname === '/api/voice/warm' && req.method === 'POST') {
    if (!voiceInstalled()) return reply(res, 503, { error: NOT_INSTALLED });
    start().catch((e) => console.error(`  ${e instanceof Error ? e.message : e}`));
    return reply(res, 202, { ok: true });
  }
  if (url.pathname === '/api/voice/diag' && req.method === 'POST') {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      req.resume();
      return reply(res, 415, { error: 'Send JSON.' });
    }
    const body = await readBuffer(req, 4096);
    if (!body) return reply(res, 413, { error: 'Too big.' });
    let take: unknown;
    try {
      take = JSON.parse(body.toString('utf8'));
    } catch {
      return reply(res, 400, { error: 'Bad JSON.' });
    }
    if (!take || typeof take !== 'object' || Array.isArray(take)) return reply(res, 400, { error: 'Bad JSON.' });
    diag({ ua: String(req.headers['user-agent'] ?? '').slice(0, 160), ...take });
    return reply(res, 200, { ok: true });
  }
  if (url.pathname === '/api/transcribe' && req.method === 'POST') {
    if (!voiceInstalled()) {
      req.resume();
      return reply(res, 503, { error: NOT_INSTALLED });
    }
    // Only raw WAV bodies: a plain HTML form on another site cannot send this content type.
    if (!/^audio\/(x-)?wav\b/i.test(req.headers['content-type'] ?? '')) {
      req.resume();
      return reply(res, 415, { error: 'Send the audio as Content-Type: audio/wav.' });
    }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
      req.resume();
      return reply(res, 413, { error: `Too long: ${MAX_SECONDS / 60} minutes at most.` });
    }
    if (waiting.size >= MAX_QUEUE) {
      req.resume();
      return reply(res, 429, { error: 'The voice engine is busy. Try again in a moment.' });
    }
    const body = await readBuffer(req, MAX_BODY);
    if (!body) return reply(res, 413, { error: `Too long: ${MAX_SECONDS / 60} minutes at most.` });
    const pcm = wavPcm(body);
    if (typeof pcm === 'string') return reply(res, 400, { error: pcm });
    if (pcm.length > MAX_PCM) return reply(res, 413, { error: `Too long: ${MAX_SECONDS / 60} minutes at most.` });
    try {
      const { text, ms } = await transcribe(pcm);
      return reply(res, 200, { text, ms, seconds: Math.round((pcm.length / 2 / RATE) * 10) / 10 });
    } catch (e) {
      return reply(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  return reply(res, 404, { error: 'not found' });
}

process.on('exit', () => child?.kill());
