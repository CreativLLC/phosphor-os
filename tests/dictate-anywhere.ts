// DICTATE in any app and PHONE KEYBOARD, headless: the shared rules (shared/dictate.mjs: paste key per window class,
// joining, CLEAN UP and its fallback, settings), the Linux paste (os/omarchy/clock/phosphor-dictate-paste.mjs, with
// stand-in clipboard and key tools) and the phone keyboard API (server/voiceapi.ts: multipart, audio, token, limits).
// No network, no real speech engine: the engine and the clock are fakes, the HTTP gate runs on a spare loopback port.
// ffmpeg is used when it is installed (a sine tone, no speech), else that case is skipped.
//   npx tsx tests/dictate-anywhere.ts

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanUp, finalText, isTerminal, joinPhrase, pasteKeys, pasteWords, readSettings, settingsFile } from '../shared/dictate.mjs';
import { type ApiDeps, handleKeyboardToken, handleVoiceApi, keyboardToken, MODEL_ID, parseMultipart, sniffAudio, toPcm } from '../server/voiceapi.ts';
import { focusedWindow, pasteText } from '../os/omarchy/clock/phosphor-dictate-paste.mjs';

let pass = 0;
let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${!cond && detail ? `\n  ${detail}` : ''}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'phosphor-dictate-test-'));

try {
  // ---------------------------------------------------------------- the paste key, by window class
  const win = (cls: string, tags: string[] = []) => ({ address: '0x1', class: cls, initialClass: cls, tags });
  check('Discord, a browser: Ctrl+V', pasteKeys('linux', win('discord')).mods === 'CTRL' && pasteKeys('linux', win('firefox')).mods === 'CTRL');
  check('Omarchy tags its terminals: Ctrl+Shift+V', pasteKeys('linux', win('some.new.term', ['terminal*'])).mods === 'CTRL SHIFT');
  for (const cls of ['Alacritty', 'kitty', 'foot', 'com.mitchellh.ghostty', 'org.wezfurlong.wezterm', 'org.kde.konsole', 'org.gnome.Terminal', 'xterm', 'org.omarchy.terminal', 'TUI.float']) {
    check(`terminal by class: ${cls}`, isTerminal(win(cls)) && pasteKeys('linux', win(cls)).mods === 'CTRL SHIFT');
  }
  check('not a terminal: phosphor-os, code, chromium, footnotes', !['phosphor-os', 'code', 'chromium', 'footnotes'].some((c) => isTerminal(win(c))));
  check('no window or junk: not a terminal', !isTerminal(null) && !isTerminal({}) && !isTerminal({ tags: 'terminal' } as never));
  check('Mac: Command+V; Windows: Ctrl+V, terminals too', pasteKeys('darwin', win('Alacritty')).mods === 'SUPER' && pasteKeys('win32', win('Alacritty')).mods === 'CTRL');
  check('the key is v', pasteKeys('linux', win('foot')).key === 'v');
  check('a terminal gets one line: a line break would run a command', pasteWords('linux', win('kitty'), 'One.\n\nrm -rf x\r\n') === 'One. rm -rf x ');
  check('other programs get the lines as they are', pasteWords('linux', win('discord'), 'a\nb') === 'a\nb' && pasteWords('darwin', win('Alacritty'), 'a\nb') === 'a\nb');

  // ---------------------------------------------------------------- joining, the final text, settings
  let t = '';
  t = joinPhrase(t, 'hello there.');
  t = joinPhrase(t, 'how are you?');
  check('phrases join with a capital at a sentence start', t === 'Hello there. How are you?', t);
  check('joinPrev: the pause was mid-sentence, its period goes', joinPhrase('I went to the.', 'store today.', true) === 'I went to the store today.');
  check('an empty phrase changes nothing', joinPhrase('Hi.', '   ') === 'Hi.');
  check('final text: a space after a sentence end only', finalText(' Done. ') === 'Done. ' && finalText('no end') === 'no end' && finalText('Quote."') === 'Quote." ');
  check('settings: defaults, shown, CLEAN UP off', JSON.stringify(readSettings('')) === '{"icon":true,"cleanup":false}');
  check('settings: broken or odd values fall back, the spot stays', (() => {
    const s = readSettings('{"icon":"no","cleanup":1,"x":0.5,"screen":"DP-1"}');
    return s.icon === true && s.cleanup === false && s.x === 0.5 && s.screen === 'DP-1';
  })());
  check('settings: hidden, CLEAN UP on', (() => {
    const s = readSettings('{"icon":false,"cleanup":true}');
    return !s.icon && s.cleanup;
  })());
  check('settings file under ~/.config/phosphor-os', settingsFile('/h') === '/h/.config/phosphor-os/dictate.json');

  // ---------------------------------------------------------------- CLEAN UP and its fallback
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  let sent: { url: string; body: unknown; headers: Record<string, string> } | undefined;
  const ok = (async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    return new Response(JSON.stringify({ text: 'Hello, world.', by: 'test model' }), { status: 200 });
  }) as unknown as typeof fetch;
  let r = await cleanUp(' hello world ', { url: 'http://x', headers: { Cookie: 'c' }, fetchImpl: ok });
  check('clean-up: the tidy words, and who made them', r.text === 'Hello, world.' && r.cleaned && r.by === 'test model');
  check('clean-up: POST /api/voice/cleanup, style plain, the take\'s cookie', sent?.url === 'http://x/api/voice/cleanup' && JSON.stringify(sent.body) === '{"text":"hello world","style":"plain"}' && sent.headers.Cookie === 'c');
  r = await cleanUp('hello world', { fetchImpl: answer(404, { error: 'not found' }) });
  check('clean-up: 404 (no such endpoint yet) -> the words as they were', r.text === 'hello world' && !r.cleaned && r.error === 'not on this server yet');
  r = await cleanUp('hello world', { fetchImpl: answer(500, { error: 'model down' }) });
  check('clean-up: an error -> the words as they were, with why', r.text === 'hello world' && r.error === 'model down');
  r = await cleanUp('hello world', { fetchImpl: answer(200, { text: '  ' }) });
  check('clean-up: an empty answer -> the words as they were', r.text === 'hello world' && !r.cleaned);
  r = await cleanUp('hello world', { fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch });
  check('clean-up: no answer -> the words as they were', r.text === 'hello world' && r.error === 'no answer');
  const slow = ((_u: string, init: RequestInit) => new Promise((_ok, no) => init.signal?.addEventListener('abort', () => no(init.signal?.reason)))) as unknown as typeof fetch;
  const awake = setTimeout(() => {}, 1000); // AbortSignal.timeout alone does not keep Node running
  r = await cleanUp('hello world', { fetchImpl: slow, timeoutMs: 50 });
  clearTimeout(awake);
  check('clean-up: too slow -> the words as they were', r.text === 'hello world' && r.error === 'took too long');
  r = await cleanUp('   ', { fetchImpl: ok });
  check('clean-up: nothing to tidy, nothing asked', r.text === '' && !r.cleaned);

  // ---------------------------------------------------------------- the Linux paste (stand-in tools)
  type Clip = { data: Buffer | null; type: string; sensitive: boolean };
  const desk = (window: object | null, clip: Clip) => {
    const log: string[] = [];
    let pasted = '';
    const run = (cmd: string, args: string[], opt: { input?: Buffer | string; binary?: boolean } = {}) => {
      log.push(`${cmd} ${args.join(' ')}`);
      const out = (s: Buffer | string) => ({ status: 0, stdout: opt.binary ? Buffer.from(s) : String(s) });
      if (cmd === 'hyprctl' && args[0] === 'activewindow') return out(JSON.stringify(window ?? {}));
      if (cmd === 'hyprctl' && args[0] === 'dispatch') {
        if (args[1].includes('"down"')) pasted += clip.data?.toString() ?? '';
        return out('ok');
      }
      if (cmd === 'wl-copy') {
        if (args.includes('--clear')) clip.data = null;
        else Object.assign(clip, { data: Buffer.from(opt.input ?? ''), type: args[args.indexOf('--type') + 1], sensitive: args.includes('--sensitive') });
        return out('');
      }
      if (cmd === 'wl-paste') {
        if (!clip.data) return { status: 1, stdout: opt.binary ? Buffer.alloc(0) : '' };
        if (args[0] === '--list-types') return out(`${clip.type}\n${clip.sensitive ? 'x-kde-passwordManagerHint\n' : ''}`);
        return out(clip.data);
      }
      return { status: 1, stdout: '' };
    };
    return { log, run, clip, pasted: () => pasted };
  };
  const sleep = async () => {};
  const keysFor = (w: object) => pasteKeys('linux', w as never);
  process.env.HYPRLAND_INSTANCE_SIGNATURE = 'test';
  let d = desk(win('discord'), { data: Buffer.from('old'), type: 'text/plain', sensitive: false });
  let p = await pasteText('Hello there. ', { keysFor, run: d.run, sleep });
  check('paste: the words went in with Ctrl+V', p.ok && d.pasted() === 'Hello there. ' && d.log.some((l) => l.includes('mods = "CTRL", key = "v", state = "down"')) && d.log.some((l) => l.includes('state = "up"')));
  check('paste: on the clipboard marked sensitive (kept out of the clipboard history)', d.log.some((l) => l.startsWith('wl-copy --sensitive --type text/plain;charset=utf-8')));
  check('paste: the old clipboard is back', d.clip.data?.toString() === 'old' && !d.clip.sensitive);
  d = desk(win('kitty', ['terminal*']), { data: null, type: '', sensitive: false });
  p = await pasteText('ls', { keysFor, run: d.run, sleep });
  check('paste: a terminal gets Ctrl+Shift+V; an empty clipboard is empty again', d.pasted() === 'ls' && d.log.some((l) => l.includes('mods = "CTRL SHIFT"')) && d.clip.data === null);
  d = desk(win('discord'), { data: Buffer.from('pw'), type: 'text/plain', sensitive: true });
  await pasteText('Hi. ', { keysFor, run: d.run, sleep });
  check("paste: a password manager's clipboard comes back still marked sensitive", d.clip.data?.toString() === 'pw' && d.clip.sensitive);
  d = desk(win('gimp'), { data: Buffer.from([137, 80, 78, 71]), type: 'image/png', sensitive: false });
  await pasteText('Hi. ', { keysFor, run: d.run, sleep });
  check('paste: a copied picture comes back as a picture', d.clip.type === 'image/png' && d.clip.data?.[0] === 137);
  d = desk(null, { data: Buffer.from('old'), type: 'text/plain', sensitive: false });
  p = await pasteText('Hi. ', { keysFor, run: d.run, sleep });
  check('paste: no program has the keyboard -> no key, the words stay on the clipboard', p.copied === true && d.pasted() === '' && d.clip.data?.toString() === 'Hi. ' && !d.log.some((l) => l.includes('dispatch')));
  const userCopied = desk(win('discord'), { data: Buffer.from('old'), type: 'text/plain', sensitive: false });
  const mine = (cmd: string, args: string[], opt: { input?: Buffer | string; binary?: boolean } = {}) => {
    const out = userCopied.run(cmd, args, opt);
    if (cmd === 'hyprctl' && args[1]?.includes('"up"')) userCopied.clip.data = Buffer.from('copied meanwhile');
    return out;
  };
  await pasteText('Hi. ', { keysFor, run: mine, sleep });
  check('paste: something copied in the meantime is left alone', userCopied.clip.data?.toString() === 'copied meanwhile');
  d = desk(win('discord'), { data: Buffer.from('old'), type: 'text/plain', sensitive: false });
  check('the focused window at the stop: its address', focusedWindow(d.run) === '0x1' && focusedWindow(desk(null, d.clip).run) === '');
  p = await pasteText('Hi. ', { keysFor, target: '0x1', run: d.run, sleep });
  check('paste: the window that had the keyboard at the stop still has it -> the words go in', p.ok && !p.moved && d.pasted() === 'Hi. ');
  d = desk(win('discord'), { data: Buffer.from('old'), type: 'text/plain', sensitive: false });
  p = await pasteText('Hi. ', { keysFor, target: '0x9', run: d.run, sleep });
  check('paste: another window has the keyboard now -> no key, the words stay on the clipboard', p.moved === true && p.copied === true && d.pasted() === '' && d.clip.data?.toString() === 'Hi. ' && !d.log.some((l) => l.includes('dispatch')));
  d = desk(win('kitty', ['terminal*']), { data: null, type: '', sensitive: false });
  p = await pasteText('One.\nTwo. ', { keysFor, wordsFor: (w: object, t: string) => pasteWords('linux', w as never, t), run: d.run, sleep });
  check('paste: a terminal gets the words on one line', p.ok && d.pasted() === 'One. Two. ');
  delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
  d = desk(win('discord'), { data: null, type: '', sensitive: false });
  const wtype: string[] = [];
  await pasteText('Hi. ', { keysFor: () => ({ mods: 'CTRL SHIFT', key: 'v' }), run: (c: string, a: string[], o: object) => (c === 'wtype' ? (wtype.push(a.join(' ')), { status: 0, stdout: '' }) : d.run(c, a, o)), sleep });
  check('paste: not Hyprland -> the key by wtype, modifiers pressed and let go', wtype[0] === '-M ctrl -M shift -k v -m shift -m ctrl', wtype.join('|'));

  // ---------------------------------------------------------------- multipart and audio
  const boundary = '----phosphorTest';
  const form = (parts: { name: string; value: string | Buffer; filename?: string; type?: string }[], b = boundary) =>
    Buffer.concat([
      ...parts.flatMap((part) => [
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n${part.type ? `Content-Type: ${part.type}\r\n` : ''}\r\n`),
        Buffer.from(part.value),
        Buffer.from('\r\n'),
      ]),
      Buffer.from(`--${b}--\r\n`),
    ]);
  const wav = (seconds: number, rate = 16000, channels = 1) => {
    const n = Math.round(seconds * rate) * channels;
    const b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0);
    b.writeUInt32LE(36 + n * 2, 4);
    b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(channels, 22);
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 2 * channels, 28);
    b.writeUInt16LE(2 * channels, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36);
    b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 7)), 44 + i * 2);
    return b;
  };
  const audio = wav(1);
  const parts = parseMultipart(form([{ name: 'model', value: 'whisper-1' }, { name: 'file', value: audio, filename: 'a.wav', type: 'audio/wav' }]), `multipart/form-data; boundary=${boundary}`);
  check('multipart: fields and the file, byte for byte', Array.isArray(parts) && parts[0].name === 'model' && parts[0].data.toString() === 'whisper-1' && parts[1].filename === 'a.wav' && parts[1].type === 'audio/wav' && parts[1].data.equals(audio));
  const quoted = parseMultipart(form([{ name: 'model', value: 'x' }], 'a b'), 'multipart/form-data; boundary="a b"');
  check('multipart: a quoted boundary', Array.isArray(quoted) && quoted[0].data.toString() === 'x');
  check('multipart: not multipart, or no boundary -> an error', typeof parseMultipart(Buffer.from('x'), 'application/json') === 'string' && typeof parseMultipart(Buffer.from('x'), 'multipart/form-data') === 'string');
  check('multipart: a cut-off body -> an error', typeof parseMultipart(form([{ name: 'file', value: audio }]).subarray(0, 80), `multipart/form-data; boundary=${boundary}`) === 'string');
  const head = (s: string, at = 0) => Buffer.concat([Buffer.alloc(at), Buffer.from(s, 'latin1'), Buffer.alloc(16)]);
  check('audio kind from its bytes', sniffAudio(audio) === 'wav' && sniffAudio(head('OggS')) === 'ogg' && sniffAudio(head('fLaC')) === 'flac' && sniffAudio(head('ftyp', 4)) === 'mov' && sniffAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0])) === 'matroska' && sniffAudio(head('ID3')) === 'mp3' && sniffAudio(Buffer.from([0xff, 0xfb, 0x90])) === 'mp3' && sniffAudio(Buffer.from([0xff, 0xf1, 0x50])) === 'aac' && sniffAudio(head('#!AMR')) === 'amr');
  check('audio kind: unknown bytes and a name are not trusted', sniffAudio(Buffer.from('hello.wav')) === null);
  check('16 kHz mono WAV: used as it is, no ffmpeg', (await toPcm(audio, { ffmpeg: '' })).length === 32000);
  let refused = '';
  await toPcm(wav(1, 44100, 2), { ffmpeg: '' }).catch((e: Error) => (refused = e.message));
  check('another WAV and no ffmpeg: says to install it', /Install ffmpeg/.test(refused), refused);
  let hasFfmpeg = true;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    hasFfmpeg = false;
  }
  if (hasFfmpeg) {
    const ogg = join(tmp, 'tone.ogg');
    execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ar', '48000', '-ac', '2', '-c:a', 'libopus', ogg]);
    const pcm = await toPcm(readFileSync(ogg), { ffmpeg: 'ffmpeg' });
    check('ogg/opus 48 kHz stereo -> 16 kHz mono through ffmpeg (about 2 s)', Math.abs(pcm.length - 64000) < 3200, String(pcm.length));
    check('44.1 kHz stereo WAV -> 16 kHz mono through ffmpeg', Math.abs((await toPcm(wav(1, 44100, 2), { ffmpeg: 'ffmpeg' })).length - 32000) < 1600);
    let bad = '';
    await toPcm(head('OggS'), { ffmpeg: 'ffmpeg' }).catch((e: Error) => (bad = e.message));
    check('broken audio: says so', /Could not read the audio/.test(bad), bad);
  } else console.log('SKIP: ffmpeg cases (no ffmpeg)');

  // ---------------------------------------------------------------- the API over HTTP (fake engine and clock)
  const tokenFile = join(tmp, 'voice-api.key');
  let clock = 1_000_000;
  let heard: Buffer | undefined;
  let warmed = 0;
  let installed = true;
  let queueFull = false;
  const deps: ApiDeps = {
    transcribe: async (pcm) => ((heard = pcm), { text: 'Hello from the PC.', ms: 5 }),
    installed: () => installed,
    queueFull: () => queueFull,
    warm: () => void warmed++,
    tokenFile,
    ffmpeg: '',
    now: () => clock,
  };
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    void (url.pathname.startsWith('/v1/') ? handleVoiceApi(req, res, url, deps) : handleKeyboardToken(req, res, url, tokenFile));
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as AddressInfo).port;
  const call = (path: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}) =>
    new Promise<{ status: number; type: string; text: string; json: () => Record<string, unknown> }>((done, no) => {
      const rq = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, ...(body ? { 'Content-Length': String(body.length) } : {}) } }, (rs) => {
        let text = '';
        rs.setEncoding('utf8');
        rs.on('data', (c) => (text += c));
        rs.on('end', () => done({ status: rs.statusCode ?? 0, type: String(rs.headers['content-type'] ?? ''), text, json: () => JSON.parse(text) }));
      });
      rq.on('error', no);
      rq.end(body);
    });
  const upload = (token: string, extra: { name: string; value: string }[] = [], file: Buffer = audio) => {
    const body = form([{ name: 'model', value: 'whisper-1' }, ...extra, { name: 'file', value: file, filename: 'dictate_audio.wav', type: 'audio/wav' }]);
    return call('/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
  };

  let res = await upload('phos_anything');
  check('no token made yet: every key is wrong (401, OpenAI error shape)', res.status === 401 && (res.json().error as { type: string }).type === 'authentication_error');
  res = await call('/api/voice/keyboard');
  const info = res.json() as { token: string; base: string | null; model: string };
  check('SETTINGS: the token is made on first use', res.status === 200 && /^phos_[\w-]{43}$/.test(info.token) && info.model === MODEL_ID);
  check('the token file: only this user can read it', (statSync(tokenFile).mode & 0o777) === 0o600);
  check('asked again: the same token', (await call('/api/voice/keyboard')).json().token === info.token && (await keyboardToken(tokenFile)) === info.token);
  res = await upload(info.token);
  check('transcription: { text } (json, the default)', res.status === 200 && res.text === '{"text":"Hello from the PC."}', res.text);
  check('the engine got the PCM samples of the WAV', heard?.length === 32000);
  res = await upload(info.token, [{ name: 'response_format', value: 'text' }]);
  check('response_format text: the words as plain text', res.status === 200 && res.type.startsWith('text/plain') && res.text === 'Hello from the PC.\n');
  res = await upload(info.token, [{ name: 'response_format', value: 'verbose_json' }, { name: 'language', value: 'en' }, { name: 'prompt', value: 'names' }]);
  const v = res.json();
  check('response_format verbose_json: text, duration, task', res.status === 200 && v.text === 'Hello from the PC.' && v.duration === 1 && v.task === 'transcribe' && Array.isArray(v.segments));
  res = await upload(info.token, [{ name: 'response_format', value: 'srt' }]);
  check('response_format srt: refused (400)', res.status === 400);
  res = await upload(info.token, [], Buffer.from('not audio at all'));
  check('not audio: refused (400)', res.status === 400 && /Unknown audio format/.test(res.text));
  res = await upload(info.token, [], head('OggS'));
  check('ogg without ffmpeg on the PC: says so (415)', res.status === 415 && /Install ffmpeg/.test(res.text));
  res = await upload(info.token, [], wav(601));
  check('over 10 minutes: refused (413)', res.status === 413 && /10 minutes/.test(res.text));
  res = await call('/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body: form([{ name: 'model', value: 'x' }]) });
  check('no file field: refused (400)', res.status === 400 && /"file"/.test((res.json().error as { message: string }).message));
  installed = false;
  check('engine not installed: 503', (await upload(info.token)).status === 503);
  installed = true;
  queueFull = true;
  check('engine busy: 429', (await upload(info.token)).status === 429);
  queueFull = false;
  res = await call('/v1/models', { headers: { Authorization: `Bearer ${info.token}` } });
  check('models: the list, and the engine wakes', res.status === 200 && (res.json().data as { id: string }[])[0].id === MODEL_ID && warmed === 1);
  check('models without the key: 401', (await call('/v1/models')).status === 401);
  check('another /v1 path: 404 (with the key)', (await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${info.token}` } })).status === 404);
  res = await call('/api/voice/keyboard/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.from('{}') });
  const fresh = res.json().token as string;
  check('NEW TOKEN: a new one; the old one stops working', res.status === 200 && fresh !== info.token && (await upload(info.token)).status === 401 && (await upload(fresh)).status === 200);
  check('NEW TOKEN without JSON: refused (415)', (await call('/api/voice/keyboard/new', { method: 'POST', body: Buffer.from('x') })).status === 415);
  for (let i = 0; i < 12; i++) await call('/v1/models');
  check('requests with no key (a web page can send those) never lock the phone out', (await upload(fresh)).status === 200);
  for (let i = 0; i < 12; i++) await upload('phos_wrong');
  check('more than 10 wrong keys in a minute: everyone waits (429)', (await upload(fresh)).status === 429);
  clock += 61_000;
  check('... a minute later the right key works again', (await upload(fresh)).status === 200);
  const logged: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(' '));
  await upload(fresh);
  console.log = log;
  check('the server log says how long, never the key or the words', logged.length === 1 && /s of audio/.test(logged[0]) && !logged[0].includes(fresh) && !logged[0].includes('Hello'), logged.join('|'));
  srv.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
