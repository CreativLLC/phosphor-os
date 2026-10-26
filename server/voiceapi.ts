import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { transcribe, voiceInstalled, voiceQueueFull, warmVoice, wavPcm } from './voice.ts';

// PHONE KEYBOARD: this PC's speech engine (the one DICTATE uses) as an OpenAI-style transcription server, for phone
// keyboards that take a custom server (Dictate Keyboard on Android, github.com/DevEmperor/DictateKeyboard, and
// others). It is the app's own server and port, so only this PC and the owner's tailnet reach it (tailscale serve);
// never the internet.
//
//   POST /v1/audio/transcriptions  multipart/form-data: file (WAV, or with ffmpeg on the PC: m4a/aac, ogg/opus, webm,
//                                  mp3, flac, amr; up to 10 minutes and 25 MB), model (any name), language and prompt
//                                  (taken but not used: the engine is English and has no prompt), response_format
//                                  json (default) -> { text } | text -> plain text | verbose_json -> { task, language,
//                                  duration, text, segments: [] }. Errors: { error: { message, type, code } }.
//   GET  /v1/models                the model list (the keyboard's model picker). It also wakes the engine: keyboards
//                                  ask for it just before they record.
// Auth: Authorization: Bearer <token>. One token, made on first use and kept in data/voice-api.key (only this user can
// read it); never logged. More than 10 wrong tokens in a minute: everyone waits a minute (429). A request with no token
// does not count: any web page can make a browser on this PC send those, but never one with a token.
//   GET  /api/voice/keyboard       (login cookie) -> KeyboardInfo: the token (made now if there is none), the address
//   POST /api/voice/keyboard/new   (login cookie) -> KeyboardInfo with a new token; the old one stops working

export const TOKEN_FILE = join(DATA_DIR, 'voice-api.key');
export const MODEL_ID = 'parakeet-tdt-0.6b-v2';
const MAX_BYTES = 25 * 1024 * 1024; // OpenAI's own limit; Dictate packs longer takes into m4a below it
const MAX_SECONDS = 600;
const RATE = 16000;
const FFMPEG_MS = 60_000;
const BAD_TOKENS = 10; // per minute, then a minute's wait

export type KeyboardInfo = { token: string; base: string | null; model: string };

export type ApiDeps = {
  transcribe: (pcm: Buffer) => Promise<{ text: string; ms: number }>;
  installed: () => boolean;
  queueFull: () => boolean;
  warm: () => void;
  tokenFile: string;
  ffmpeg: string; // the ffmpeg program ('' = none)
  now: () => number;
};

export const apiDeps: ApiDeps = { transcribe, installed: voiceInstalled, queueFull: voiceQueueFull, warm: warmVoice, tokenFile: TOKEN_FILE, ffmpeg: 'ffmpeg', now: Date.now };

// ---------------------------------------------------------------- the token

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

export async function keyboardToken(file = TOKEN_FILE): Promise<string> {
  try {
    const t = (await fsp.readFile(file, 'utf8')).trim();
    if (t) return t;
  } catch (e) {
    if (code(e) !== 'ENOENT') throw e;
  }
  return newKeyboardToken(file);
}

export async function newKeyboardToken(file = TOKEN_FILE): Promise<string> {
  const token = `phos_${randomBytes(32).toString('base64url')}`;
  await fsp.writeFile(`${file}.new`, token, { mode: 0o600 });
  await fsp.rename(`${file}.new`, file);
  return token;
}

const sha = (s: string) => createHash('sha256').update(s).digest();

async function tokenOk(header: string | undefined, file: string): Promise<boolean> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!m) return false;
  let want = '';
  try {
    want = (await fsp.readFile(file, 'utf8')).trim();
  } catch {
    return false; // no token made yet: nothing can match
  }
  return want.length > 0 && timingSafeEqual(sha(m[1]), sha(want));
}

let fails: number[] = [];
let lockedUntil = 0;

// ---------------------------------------------------------------- the tailnet address

let baseCache: { at: number; base: string | null } | undefined;

// https://<this PC>.<tailnet>.ts.net/v1/, from `tailscale status`; null when Tailscale is not up here.
function tailnetBase(): Promise<string | null> {
  if (baseCache && Date.now() - baseCache.at < 60_000) return Promise.resolve(baseCache.base);
  return new Promise((done) => {
    execFile('tailscale', ['status', '--json'], { timeout: 1500, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      let base: string | null = null;
      try {
        const name = String(JSON.parse(String(out)).Self?.DNSName ?? '').replace(/\.$/, '');
        if (!err && /\.ts\.net$/.test(name)) base = `https://${name}/v1/`;
      } catch {
        /* not running */
      }
      baseCache = { at: Date.now(), base };
      done(base);
    });
  });
}

// ---------------------------------------------------------------- multipart

export type Part = { name: string; filename: string | null; type: string; data: Buffer };

// The parts of a multipart/form-data body, or an error message.
export function parseMultipart(body: Buffer, contentType: string): Part[] | string {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!/^multipart\/form-data\b/i.test(contentType) || !m) return 'Send the audio as multipart/form-data.';
  const sep = Buffer.from(`--${m[1] ?? m[2]}`);
  const parts: Part[] = [];
  let at = body.indexOf(sep);
  if (at < 0) return 'Bad multipart body.';
  while (true) {
    at += sep.length;
    if (body.subarray(at, at + 2).toString() === '--') return parts; // the closing boundary
    if (body.subarray(at, at + 2).toString() === '\r\n') at += 2;
    const headEnd = body.indexOf('\r\n\r\n', at);
    const next = body.indexOf(sep, at);
    if (headEnd < 0 || next < 0 || headEnd > next) return 'Bad multipart body.';
    const head = body.subarray(at, headEnd).toString('utf8');
    const disposition = /^content-disposition:(.*)$/im.exec(head)?.[1] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
    if (name === undefined) return 'Bad multipart body.';
    const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    const type = (/^content-type:\s*(.*)$/im.exec(head)?.[1] ?? '').trim();
    let end = next;
    if (body[end - 2] === 13 && body[end - 1] === 10) end -= 2; // the CRLF before the boundary belongs to it
    parts.push({ name, filename, type, data: body.subarray(headEnd + 4, end) });
    at = next;
  }
}

// ---------------------------------------------------------------- audio

// ffmpeg's name for the container, from the first bytes (never from the file name, which the sender chose).
export function sniffAudio(b: Buffer): string | null {
  const ascii = (at: number, s: string) => b.length >= at + s.length && b.toString('latin1', at, at + s.length) === s;
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'wav';
  if (ascii(0, 'OggS')) return 'ogg';
  if (ascii(0, 'fLaC')) return 'flac';
  if (ascii(0, '#!AMR')) return 'amr';
  if (ascii(4, 'ftyp')) return 'mov'; // m4a, mp4, 3gp
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'matroska'; // webm
  if (ascii(0, 'ID3')) return 'mp3';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return (b[1] >> 1) & 3 ? 'mp3' : 'aac'; // MPEG frame, or ADTS
  return null;
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public type = 'invalid_request_error',
  ) {
    super(message);
  }
}

// 16 kHz mono 16-bit PCM for the engine. WAV in that shape needs nothing; anything else goes through ffmpeg, from a
// temp file (an m4a keeps its index at the end, which a pipe cannot seek to), with the container named so ffmpeg
// never guesses a playlist format that opens other files.
export async function toPcm(audio: Buffer, deps: Pick<ApiDeps, 'ffmpeg'>): Promise<Buffer> {
  const kind = sniffAudio(audio);
  if (!kind) throw new ApiError(400, 'Unknown audio format. Send WAV, m4a, ogg, webm, mp3 or flac.');
  if (kind === 'wav') {
    const pcm = wavPcm(audio);
    if (typeof pcm !== 'string') return pcm;
  }
  if (!deps.ffmpeg) throw new ApiError(415, 'Only 16 kHz mono 16-bit WAV here. Install ffmpeg on the PC for other formats.');
  const dir = await fsp.mkdtemp(join(tmpdir(), 'phosphor-voiceapi-'));
  try {
    const file = join(dir, 'audio');
    await fsp.writeFile(file, audio, { mode: 0o600 });
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', kind, '-i', file, '-t', String(MAX_SECONDS + 1), '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'];
    return await new Promise<Buffer>((done, fail) => {
      execFile(deps.ffmpeg, args, { encoding: 'buffer', timeout: FFMPEG_MS, maxBuffer: (MAX_SECONDS + 2) * RATE * 2, windowsHide: true }, (err, out) => {
        if (!err) return done(out);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fail(new ApiError(415, 'Only 16 kHz mono 16-bit WAV here. Install ffmpeg on the PC for other formats.'));
        fail(new ApiError(400, `Could not read the audio (${kind}).`));
      });
    });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- HTTP

function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((done, fail) => {
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > max) {
        over = true;
        parts.length = 0;
        done(null);
        req.resume();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => over || done(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(type === 'application/json' ? JSON.stringify(body) : String(body));
}

function sendError(res: ServerResponse, e: unknown): void {
  const err = e instanceof ApiError ? e : new ApiError(500, e instanceof Error ? e.message : String(e), 'server_error');
  send(res, err.status, { error: { message: err.message, type: err.type, code: null } });
}

// /v1/*: the keyboard's requests. No login cookie: the token instead.
export async function handleVoiceApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: ApiDeps = apiDeps): Promise<void> {
  try {
    const now = deps.now();
    if (now < lockedUntil) throw new ApiError(429, 'Too many wrong keys. Wait a minute.', 'rate_limit_error');
    if (!(await tokenOk(req.headers.authorization, deps.tokenFile))) {
      if (req.headers.authorization) fails = [...fails.filter((t) => now - t < 60_000), now];
      if (fails.length > BAD_TOKENS) {
        lockedUntil = now + 60_000;
        fails = [];
      }
      throw new ApiError(401, 'Wrong or missing API key. Copy it from Phosphor-OS: SETTINGS > VOICE > PHONE KEYBOARD.', 'authentication_error');
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      deps.warm();
      return send(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'phosphor-os' }] });
    }
    if (url.pathname !== '/v1/audio/transcriptions') throw new ApiError(404, 'Not found. This server only does /v1/audio/transcriptions and /v1/models.');
    if (req.method !== 'POST') throw new ApiError(405, 'Use POST.');
    if (!deps.installed()) throw new ApiError(503, 'The voice engine is not installed on the PC.', 'server_error');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BYTES + 65536) throw new ApiError(413, 'Too big: 25 MB at most.');
    if (deps.queueFull()) throw new ApiError(429, 'The voice engine is busy. Try again in a moment.', 'rate_limit_error');
    const body = await readBody(req, MAX_BYTES + 65536);
    if (!body) throw new ApiError(413, 'Too big: 25 MB at most.');
    const parts = parseMultipart(body, req.headers['content-type'] ?? '');
    if (typeof parts === 'string') throw new ApiError(400, parts);
    const field = (name: string) => parts.find((p) => p.name === name && p.filename === null)?.data.toString('utf8').trim() ?? '';
    const file = parts.find((p) => p.name === 'file');
    if (!file?.data.length) throw new ApiError(400, 'No audio: send it in the "file" field.');
    const format = field('response_format') || 'json';
    if (!['json', 'text', 'verbose_json'].includes(format)) throw new ApiError(400, 'response_format must be json, text or verbose_json.');
    const pcm = await toPcm(file.data, deps);
    const seconds = pcm.length / 2 / RATE;
    if (seconds > MAX_SECONDS) throw new ApiError(413, `Too long: ${MAX_SECONDS / 60} minutes at most.`);
    const { text, ms } = await deps.transcribe(pcm);
    console.log(`  Phone keyboard: ${seconds.toFixed(1)} s of audio, text in ${ms} ms.`);
    if (format === 'text') return send(res, 200, `${text}\n`, 'text/plain; charset=utf-8');
    if (format === 'verbose_json') return send(res, 200, { task: 'transcribe', language: 'english', duration: Math.round(seconds * 100) / 100, text, segments: [] });
    return send(res, 200, { text });
  } catch (e) {
    sendError(res, e);
  }
}

// /api/voice/keyboard[/new]: SETTINGS shows the token and the address to type into the keyboard (login cookie, checked
// by index.ts). A new token is a JSON POST, which a plain form on another site cannot send.
export async function handleKeyboardToken(req: IncomingMessage, res: ServerResponse, url: URL, file = TOKEN_FILE): Promise<void> {
  try {
    let token: string;
    if (url.pathname === '/api/voice/keyboard' && req.method === 'GET') token = await keyboardToken(file);
    else if (url.pathname === '/api/voice/keyboard/new' && req.method === 'POST') {
      req.resume();
      if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'Send JSON.');
      token = await newKeyboardToken(file);
    } else throw new ApiError(404, 'not found');
    send(res, 200, { token, base: await tailnetBase(), model: MODEL_ID } satisfies KeyboardInfo);
  } catch (e) {
    send(res, e instanceof ApiError ? e.status : 500, { error: e instanceof Error ? e.message : String(e) });
  }
}
