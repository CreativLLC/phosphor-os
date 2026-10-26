// One DICTATE take for phosphor-dictate (it starts this in the background and signals it). Streams the
// microphone to the server's live speech socket (/ws/voice, the same one the app uses), writes what it hears
// so far to the state file (the bar's overlay shows it) and the mic's level for the floating mic, and at the end
// puts the whole text into the focused program (phosphor-dictate-paste.mjs), tidied first when CLEAN UP is on.
//   SIGUSR1  stop and put the words in          SIGTERM  cancel, nothing goes in
// When the live socket can't connect or breaks, the take is sent in one piece to /api/transcribe instead.
// Env: DICT_URL (http://127.0.0.1:PORT), DICT_APP (the app's folder: its ws package and shared/dictate.mjs),
// DICT_JAR (curl cookie jar with the login), DICT_STATE (state file: line 1 recording|transcribing|done|error|idle,
// then the text so far, or a short reason after error), DICT_LEVEL (the mic's level, 0 to 1, a few times a second),
// DICT_MAX (seconds, then it stops by itself), DICT_PID (this take's PID goes there once it takes the signals).
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { focusedWindow, pasteText } from './phosphor-dictate-paste.mjs';

const { DICT_URL: url = '', DICT_APP: app = '', DICT_JAR: jar = '', DICT_STATE: stateFile = '', DICT_LEVEL: levelFile = '' } = process.env;
const MAX_S = Number(process.env.DICT_MAX) || 300;
const RATE = 16000;
const DONE_TIMEOUT_MS = 30_000;
const WAKE_HINT_MS = 1500;
const LEVEL_MS = 120;

const say = (msg, urgency = 'critical') => spawn('notify-send', ['-a', 'DICTATE', '-u', urgency, 'DICTATE', msg], { stdio: 'ignore' }).on('error', () => {});
const setState = (word, text = '') => {
  try {
    writeFileSync(stateFile, `${word}\n${text.length > 600 ? `…${text.slice(-600)}` : text}`);
  } catch {}
};

// The rules the app's other dictation paths use too (paste key, joining, CLEAN UP), from the app's own folder.
let lib;
try {
  lib = await import(pathToFileURL(join(app, 'shared', 'dictate.mjs')).href);
} catch {
  say(`DICTATE can't find the Phosphor-OS app in ${app || '(no folder)'}. Update the app (git pull), then try again.`);
  setState('error', 'FAILED');
  process.exit(1);
}
const { cleanUp, finalText, joinPhrase, pasteKeys, pasteWords, readSettings, settingsFile } = lib;

let text = '';
let partial = '';
let hint = '';
const preview = () => [text, partial || hint].filter(Boolean).join(' ');

let finished = false;
// The end of the take: final = all the words (empty: nothing goes in); why = a short reason for the floating mic.
async function finish(final, why = '') {
  if (finished) return;
  finished = true;
  clearTimeout(maxTimer);
  clearTimeout(doneTimer);
  try {
    ws?.close();
  } catch {}
  rmSync(levelFile, { force: true });
  let out = (final ?? '').trim();
  if (!out) {
    setState(why ? 'error' : 'idle', why);
    process.exit(0);
  }
  setState('transcribing', out);
  let settings = { cleanup: false };
  try {
    settings = readSettings(readFileSync(settingsFile(homedir()), 'utf8'));
  } catch {}
  if (settings.cleanup) out = (await cleanUp(out, { url, headers })).text; // any failure: the words as they were
  // Let go of the keys first: a still-held Ctrl would turn the paste into another shortcut.
  await new Promise((ok) => setTimeout(ok, 150));
  const r = await pasteText(finalText(out), { keysFor: (win) => pasteKeys('linux', win), wordsFor: (win, t) => pasteWords('linux', win, t), target }).catch(() => ({ ok: false, why: 'NO CLIPBOARD' }));
  if (!r.ok) say('Could not put the words in: wl-copy did not work (install wl-clipboard).');
  else if (r.moved) say('The keyboard went to another window while DICTATE worked: the words are on the clipboard. Paste them with Ctrl+V.', 'normal');
  else if (r.copied) say('No program had the keyboard: the words are on the clipboard. Paste them with Ctrl+V.', 'normal');
  setState(r.ok ? 'done' : 'error', r.ok ? '' : r.why);
  process.exit(0);
}

let cookie = '';
try {
  cookie = readFileSync(jar, 'utf8').split('\n').map((l) => l.split('\t')).find((f) => f[5] === 'rcs')?.[6] ?? '';
} catch {}
const headers = { Cookie: `rcs=${cookie}`, Origin: url };

// ---- The microphone: raw 16 kHz mono 16-bit to stdout, kept for the one-shot fallback too.
const chunks = [];
let pending = [];
let peak = 0;
let levelAt = 0;
const rec = spawn('pw-record', ['--rate', String(RATE), '--channels', '1', '--format', 's16', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
rec.on('error', () => {
  say('Could not start the microphone (pw-record).');
  void finish('', 'NO MIC');
});
rec.stdout.on('data', (b) => {
  chunks.push(b);
  if (live) ws.send(b);
  else pending.push(b);
  // The level for the floating mic: the loudest sample, about -60 dBFS (room hiss) = 0, full scale = 1.
  for (let i = 0; i + 1 < b.length; i += 2) peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
  const now = Date.now();
  if (levelFile && now - levelAt >= LEVEL_MS && !stopping) {
    levelAt = now;
    const level = Math.max(0, Math.min(1, (20 * Math.log10(peak / 32768 + 1e-9) + 60) / 60));
    peak = 0;
    try {
      writeFileSync(levelFile, level.toFixed(2));
    } catch {}
  }
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
let target; // the window that had the keyboard when the take stopped: the words go only there
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
      text = joinPhrase(text, ev.text ?? '', ev.joinPrev);
      setState(stopping ? 'transcribing' : 'recording', preview());
    } else if (ev.t === 'done') void finish(text, 'NOTHING HEARD');
    else if (ev.t === 'error') {
      say(ev.error || 'The voice engine failed.');
      void finish('', /not installed/i.test(ev.error ?? '') ? 'NO VOICE ENGINE' : 'FAILED');
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
  target = focusedWindow();
  rmSync(levelFile, { force: true });
  setState('transcribing', preview());
  rec.kill('SIGINT');
}
const maxTimer = setTimeout(stop, MAX_S * 1000);
process.on('SIGUSR1', stop);
process.on('SIGTERM', () => {
  rec.kill('SIGINT');
  void finish('');
});
if (process.env.DICT_PID) writeFileSync(process.env.DICT_PID, String(process.pid));

// The live path failed: the whole take as one WAV.
let sentOnce = false;
async function oneShot() {
  if (sentOnce || finished) return;
  sentOnce = true;
  try {
    ws?.terminate();
  } catch {}
  const pcm = Buffer.concat(chunks);
  if (pcm.length < RATE) return finish('', 'NOTHING HEARD'); // under half a second
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
    finish(data.text ?? '', data.error || !res.ok ? 'FAILED' : 'NOTHING HEARD');
  } catch {
    say('Phosphor-OS is not answering.');
    finish('', 'SERVER DOWN');
  }
}

if (liveFailed) hint = '(no live preview: the text comes when you stop)';
setState('recording', preview());
