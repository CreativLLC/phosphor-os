// One DICTATE take for phosphor-dictate (it starts this in the background and signals it). Streams the
// microphone to the server's live speech socket (/ws/voice, the same one the app uses), writes what it hears
// so far to the state file (the bar's overlay shows it), and types the whole text with wtype at the end.
//   SIGUSR1  stop and type          SIGTERM  cancel, type nothing
// When the live socket can't connect or breaks, the take is sent in one piece to /api/transcribe instead.
// Env: DICT_URL (http://127.0.0.1:PORT), DICT_APP (the app's folder: its ws package), DICT_JAR (curl cookie jar
// with the login), DICT_STATE (state file: line 1 idle|recording|transcribing, then the text so far),
// DICT_MAX (seconds, then it stops by itself).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const { DICT_URL: url = '', DICT_APP: app = '', DICT_JAR: jar = '', DICT_STATE: stateFile = '' } = process.env;
const MAX_S = Number(process.env.DICT_MAX) || 300;
const RATE = 16000;
const DONE_TIMEOUT_MS = 30_000;
const WAKE_HINT_MS = 1500;

const say = (msg) => spawn('notify-send', ['-a', 'DICTATE', '-u', 'critical', 'DICTATE', msg], { stdio: 'ignore' }).on('error', () => {});
const setState = (word, text = '') => {
  try {
    writeFileSync(stateFile, `${word}\n${text.length > 600 ? `…${text.slice(-600)}` : text}`);
  } catch {}
};

// Phrases joined as the app joins them: a capital at a sentence start; joinPrev = the last period was a pause.
let text = '';
let partial = '';
let hint = '';
function add(raw, joinPrev) {
  let t = raw.trim();
  if (!t) return;
  if (joinPrev) text = text.replace(/([^.])\.\s*$/, '$1');
  if (!text.trim() || /[.!?]["')\]]?\s*$/.test(text)) t = t.charAt(0).toUpperCase() + t.slice(1);
  text = text ? `${text.replace(/\s*$/, '')} ${t}` : t;
}
const preview = () => [text, partial || hint].filter(Boolean).join(' ');

let finished = false;
function finish(final) {
  if (finished) return;
  finished = true;
  clearTimeout(maxTimer);
  clearTimeout(doneTimer);
  try {
    ws?.close();
  } catch {}
  setState('idle');
  let out = (final ?? '').trim();
  if (out) {
    if (/[.!?]$/.test(out)) out += ' '; // so the next take does not run into this one
    // Let go of Ctrl first: a held Ctrl would turn the typed letters into shortcuts.
    setTimeout(() => {
      spawnSync('wtype', ['--', out], { stdio: 'ignore' });
      process.exit(0);
    }, 150);
  } else process.exit(0);
}

let cookie = '';
try {
  cookie = readFileSync(jar, 'utf8').split('\n').map((l) => l.split('\t')).find((f) => f[5] === 'rcs')?.[6] ?? '';
} catch {}
const headers = { Cookie: `rcs=${cookie}`, Origin: url };

// ---- The microphone: raw 16 kHz mono 16-bit to stdout, kept for the one-shot fallback too.
const chunks = [];
let pending = [];
const rec = spawn('pw-record', ['--rate', String(RATE), '--channels', '1', '--format', 's16', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
rec.on('error', () => {
  say('Could not start the microphone (pw-record).');
  finish('');
});
rec.stdout.on('data', (b) => {
  chunks.push(b);
  if (live) ws.send(b);
  else pending.push(b);
});

// ---- The live socket.
let WebSocket;
try {
  WebSocket = createRequire(join(app, 'package.json'))('ws');
} catch {}
let ws = null;
let live = false; // open and still usable
let liveFailed = !WebSocket;
let stopping = false;
let doneTimer;
if (WebSocket) {
  ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws/voice`, { headers });
  ws.on('open', () => {
    live = true;
    for (const b of pending) ws.send(b);
    pending = [];
    if (stopping && recDone) sendEnd();
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let ev;
    try {
      ev = JSON.parse(String(data));
    } catch {
      return;
    }
    if (ev.t === 'ready') {
      if (hint) setState(stopping ? 'transcribing' : 'recording', preview());
      hint = '';
      ready = true;
    } else if (ev.t === 'partial') {
      partial = ev.text ?? '';
      hint = '';
      if (!stopping) setState('recording', preview());
    } else if (ev.t === 'final') {
      partial = '';
      add(ev.text ?? '', ev.joinPrev);
      setState(stopping ? 'transcribing' : 'recording', preview());
    } else if (ev.t === 'done') finish(text);
    else if (ev.t === 'error') {
      say(ev.error || 'The voice engine failed.');
      finish('');
    }
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    live = false;
    if (finished) return;
    liveFailed = true;
    if (stopping && recDone) oneShot();
    else if (!stopping) {
      hint = '(no live preview: the text comes when you stop)';
      partial = '';
      setState('recording', preview());
    }
  });
}
let ready = false;
setTimeout(() => {
  if (ready || finished || stopping) return;
  hint = '(waking the speech engine, keep talking)';
  setState('recording', preview());
}, WAKE_HINT_MS);

// ---- Stopping.
let recDone = false;
rec.on('close', () => {
  recDone = true;
  if (!stopping) stop(); // the mic went away by itself
  if (live) sendEnd();
  else if (liveFailed) oneShot();
});
function sendEnd() {
  ws.send(JSON.stringify({ t: 'end' }));
  doneTimer = setTimeout(oneShot, DONE_TIMEOUT_MS);
}
function stop() {
  if (stopping || finished) return;
  stopping = true;
  setState('transcribing', preview());
  rec.kill('SIGINT');
}
const maxTimer = setTimeout(stop, MAX_S * 1000);
process.on('SIGUSR1', stop);
process.on('SIGTERM', () => {
  rec.kill('SIGINT');
  finish('');
});

// The live path failed: the whole take as one WAV.
let sentOnce = false;
async function oneShot() {
  if (sentOnce || finished) return;
  sentOnce = true;
  try {
    ws?.terminate();
  } catch {}
  const pcm = Buffer.concat(chunks);
  if (pcm.length < RATE) return finish(''); // under half a second
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  try {
    const res = await fetch(`${url}/api/transcribe`, { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: Buffer.concat([head, pcm]) });
    const data = await res.json().catch(() => ({}));
    if (data.error || !res.ok) say(data.error || `Dictation failed (error ${res.status}).`);
    finish(data.text ?? '');
  } catch {
    say('Phosphor-OS is not answering.');
    finish('');
  }
}

if (liveFailed) hint = '(no live preview: the text comes when you stop)';
setState('recording', preview());
