// PROMPTER (shared/prompter.ts, server/prompter.ts): the list format, the rolling transcript, the tick rule with a fake
// decider and a fake clock, a fake transcript stream, the AFTER check, and the routes on a loopback port. No network
// beyond 127.0.0.1, no models.
//   npx tsx tests/prompter.ts

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkAfter, Cue, cutPieces, Heard, parsePoints, parseTranscript, TICK_LIKELY, TICK_SURE, WINDOW_MS,
  type CueAsk, type CueDecide, type CueVerdict, type PrompterLive,
} from '../shared/prompter.ts';
import { askQuestion, askState } from '../server/prompterdecide.ts';
import { engine, handlePrompter, resetPrompter } from '../server/prompter.ts';

let pass = 0;
let fail = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${g}\n  want ${w}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the list format

const pts = parsePoints('- Cold open\n  show the bill\n    and the meter\n\n2. Why local AI\n* [ ] Hardware\n[x] Setup\n   \nCall to action');
eq('points: marks stripped, notes joined', pts.map((p) => [p.id, p.text, p.note]), [
  ['p1', 'Cold open', 'show the bill and the meter'], ['p2', 'Why local AI', ''], ['p3', '[ ] Hardware', ''], ['p4', 'Setup', ''], ['p5', 'Call to action', ''],
]);
eq('points: an indented first line is a point', parsePoints('  first\nsecond').map((p) => p.text), ['first', 'second']);
eq('points: at most 40', parsePoints(Array.from({ length: 50 }, (_, i) => `point ${i}`).join('\n')).length, 40);
eq('points: long text clipped', parsePoints('x'.repeat(500))[0].text.length, 200);
eq('points: empty', parsePoints(' \n\n'), []);

// ---------- the rolling transcript

const h = new Heard();
h.add('hello there', true, 0);
h.add('this is a part', false, 1000);
eq('heard: finals and the partial', h.window(1000), 'hello there this is a part');
const v = h.version;
h.add('this is a part', false, 1100);
eq('heard: same partial, no new version', h.version, v);
h.add('this is a partial phrase', true, 2000);
eq('heard: a final replaces the partial', h.window(2000), 'hello there this is a partial phrase');
h.add('later words', true, 2000 + WINDOW_MS + 1);
eq('heard: old phrases fall out of the window', h.window(2000 + WINDOW_MS + 1), 'later words');
eq('heard: words counted', h.words, 9);

// Three hours of talk, a phrase every 4 s: the window and the tail stay small.
const long = new Heard();
let maxWin = 0;
for (let t = 0; t < 3 * 3600_000; t += 4000) {
  long.add(`phrase number ${t / 4000} with a few more words in it to make it long enough`, true, t);
  long.add('and a partial', false, t + 2000);
  maxWin = Math.max(maxWin, long.window(t + 2000).length);
}
eq('long session: the window never passes 1500 characters', maxWin <= 1500, true);
eq('long session: the tail is short', long.tail().length <= 222, true);
eq('long session: words keep counting', long.words, 2700 * 15);

// ---------- the tick rule (fake decider, fake clock)

// A decider that answers from a table, records each ask, and can be held open.
function fake(answer: (a: CueAsk) => Record<string, number>) {
  const asks: CueAsk[] = [];
  let hold: (() => void) | null = null;
  let held = false;
  const decide: CueDecide = async (a) => {
    asks.push(a);
    if (held) await new Promise<void>((r) => (hold = r));
    const t = answer(a);
    return a.points.flatMap((p): CueVerdict[] => (p.id in t ? [{ id: p.id, yes: t[p.id] }] : []));
  };
  return { decide, asks, hold: () => (held = true), release: () => ((held = false), hold?.()) };
}

{
  const list = parsePoints('Intro\nHardware\nSetup');
  let table: Record<string, number> = { p1: TICK_SURE };
  const f = fake(() => table);
  const cue = new Cue(list, 0);
  const heard = new Heard();
  eq('cue: no words, no call', cue.step(heard, f.decide, 100), null);
  heard.add('welcome to the video', true, 1000);
  await cue.step(heard, f.decide, 1000);
  eq('cue: one very sure answer ticks', cue.points.map((p) => p.done), [true, false, false]);
  eq('cue: ticked by the model, at the time it started', [cue.points[0].by, cue.points[0].at], ['model', 1000]);
  eq('cue: the quote is what was heard', cue.points[0].quote, 'welcome to the video');
  eq('cue: no new words, no call', cue.step(heard, f.decide, 2000), null);

  table = { p2: TICK_LIKELY };
  heard.add('so the hardware', false, 2500);
  await cue.step(heard, f.decide, 2500);
  eq('cue: only open points are asked', f.asks.at(-1)!.points.map((p) => p.id), ['p2', 'p3']);
  eq('cue: ticked points go along as a summary', f.asks.at(-1)!.covered, ['Intro']);
  eq('cue: one likely answer does not tick', cue.points[1].done, false);
  table = { p2: TICK_LIKELY - 0.1 };
  heard.add('so the hardware I', false, 3000);
  await cue.step(heard, f.decide, 3000);
  table = { p2: TICK_LIKELY };
  heard.add('so the hardware I use', false, 3500);
  await cue.step(heard, f.decide, 3500);
  eq('cue: likely, unsure, likely: no tick (not two in a row)', cue.points[1].done, false);
  heard.add('so the hardware I use is', false, 4000);
  await cue.step(heard, f.decide, 4000);
  eq('cue: two likely answers in a row tick', cue.points[1].done, true);
  eq('cue: the time is where the streak started', cue.points[1].at, 3500);

  // Never more than one call in flight.
  f.hold();
  table = {};
  heard.add('now setup', true, 5000);
  const first = cue.step(heard, f.decide, 5000);
  heard.add('more setup words', true, 5500);
  eq('cue: a second call waits for the first', [cue.inFlight, cue.step(heard, f.decide, 5500)], [true, null]);
  f.release();
  await first;
  eq('cue: the call is done', cue.inFlight, false);

  // Untick by hand: the point waits out one window before the model may tick it again.
  table = { p1: 1, p3: 0 };
  eq('cue: untick by hand', cue.mark('p1', false, 6000), true);
  heard.add('words', true, 6100);
  await cue.step(heard, f.decide, 6100);
  eq('cue: an unticked point is not asked for a while', [cue.points[0].done, f.asks.at(-1)!.points.map((p) => p.id)], [false, ['p3']]);
  heard.add('more words', true, 6000 + WINDOW_MS + 1);
  await cue.step(heard, f.decide, 6000 + WINDOW_MS + 1);
  eq('cue: after the window it can tick again', cue.points[0].done, true);
  eq('cue: tick by hand', [cue.mark('p3', true, 70_000), cue.points[2].by], [true, 'hand']);
  eq('cue: nothing open, no call', (heard.add('x', true, 71_000), cue.step(heard, f.decide, 71_000)), null);
}

{
  // Errors: the call fails, the cue waits a little longer each time, then works again.
  let broken = true;
  const cue = new Cue(parsePoints('A'), 0);
  const heard = new Heard();
  const decide: CueDecide = async () => {
    if (broken) throw new Error('engine down');
    return [{ id: 'p1', yes: 1 }];
  };
  heard.add('hello', true, 0);
  await cue.step(heard, decide, 0);
  eq('error: kept for the screen', cue.error, 'engine down');
  eq('error: waits before the next call', cue.step(heard, decide, 1000), null);
  broken = false;
  await cue.step(heard, decide, 2000);
  eq('error: asks again after the wait, even with no new words', [cue.error, cue.points[0].done], ['', true]);
}

{
  // Many points: the first eight open ones always, the rest in turn, never more than twelve.
  const cue = new Cue(parsePoints(Array.from({ length: 20 }, (_, i) => `point ${i + 1}`).join('\n')), 0);
  const seen = new Set<string>();
  const sizes: number[] = [];
  const decide: CueDecide = async (a) => {
    sizes.push(a.points.length);
    for (const p of a.points) seen.add(p.id);
    return [];
  };
  const heard = new Heard();
  for (let i = 0; i < 3; i++) {
    heard.add(`words ${i}`, true, i * 1000);
    await cue.step(heard, decide, i * 1000);
  }
  eq('many points: twelve per call at most', sizes, [12, 12, 12]);
  eq('many points: every point asked within three calls', seen.size, 20);
}

// ---------- a fake transcript stream through the whole loop

{
  // The speaker covers the points out of order; the fake decider says yes when a point's key word was heard.
  const list = parsePoints('Cold open\nWhy run AI locally\nHardware\nSetup\nCall to action');
  const keys: Record<string, string> = { p1: 'bill', p2: 'privacy', p3: 'graphics card', p4: 'install', p5: 'subscribe' };
  const decide: CueDecide = async (a) => a.points.map((p) => ({ id: p.id, yes: a.heard.toLowerCase().includes(keys[p.id]) ? 0.8 : 0.05 }));
  const talk = [
    'my power bill last month was huge', 'and that is why I started looking at this', 'the main thing is privacy',
    'nobody reads my notes', 'you need a decent graphics card', 'mine is four years old', 'so let us install it',
    'it takes ten minutes', 'that is it for today', 'thanks for watching',
  ];
  const cue = new Cue(list, 0);
  const heard = new Heard();
  let t = 0;
  for (const phrase of talk) {
    const words = phrase.split(' ');
    for (let i = 1; i <= words.length; i++) {
      t += 400;
      heard.add(words.slice(0, i).join(' '), i === words.length, t);
      await cue.step(heard, decide, t);
    }
  }
  eq('stream: the points spoken about ticked, in the order they came', cue.points.filter((p) => p.done).sort((a, b) => a.at! - b.at!).map((p) => p.id), ['p1', 'p2', 'p3', 'p4']);
  eq('stream: the point never made is still open', cue.points[4].done, false);
  eq('stream: each tick keeps the words that covered it', cue.points[2].quote.includes('graphics'), true);
}

// ---------- AFTER

const yt = parseTranscript('0:00\nhello and welcome\n1:05\ntoday the bill\n[1:02:03] much later');
eq('transcript: YouTube times per word', [yt.words.slice(0, 3), yt.times[0], yt.times[3], yt.times.at(-1)], [['hello', 'and', 'welcome'], '0:00', '1:05', '1:02:03']);
const srt = parseTranscript('1\n00:00:01,000 --> 00:00:03,000\nfirst line\n\n2\n00:01:10,500 --> 00:01:12,000\n<i>second</i> line');
eq('transcript: SRT cue numbers and arrows dropped', [srt.words, srt.times], [['first', 'line', 'second', 'line'], ['00:01', '00:01', '01:10', '01:10']]);
eq('transcript: VTT header dropped', parseTranscript('WEBVTT\n\n00:00.000 --> 00:02.000\nhi').words, ['hi']);

{
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const text = `[00:00] intro ${filler(80)}\n[02:10] the hardware matters ${filler(150)}\n[07:45] how to install it ${filler(60)}`;
  const decide: CueDecide = async (a) => a.points.map((p) => ({ id: p.id, yes: a.heard.includes(p.text.split(' ')[0]) ? 0.95 : 0 }));
  const steps: number[] = [];
  const res = await checkAfter(text, parsePoints('hardware\ninstall\nsponsor'), decide, (d) => steps.push(d));
  eq('after: covered and missed', res.map((p) => [p.text, p.covered]), [['hardware', true], ['install', true], ['sponsor', false]]);
  eq('after: the time comes from the transcript', res.map((p) => p.at), ['02:10', '07:45', '']);
  eq('after: the covering words are kept', res[0].quote.includes('hardware'), true);
  eq('after: progress per step', steps.length > 3, true);
  const plain = await checkAfter(`${filler(200)} hardware ${filler(100)}`, parsePoints('hardware'), decide);
  eq('after: no times: how far in', plain[0].at, '64% IN');
  let threw = '';
  await checkAfter('some words', parsePoints('x'), async () => { throw new Error('no engine'); }).catch((e: Error) => (threw = e.message));
  eq('after: a decider error stops the check', threw, 'no engine');
}

// ---------- AFTER audio pieces

{
  const rate = 100; // small rate keeps the test fast; the cut logic only counts samples
  const ch = new Float32Array(rate * 600).fill(0.5);
  ch.fill(0, rate * 262, rate * 263); // a quiet second inside the search range of the first cut
  const pieces = cutPieces(ch, rate);
  eq('pieces: cut at the quiet moment', pieces[0][1] >= rate * 262 && pieces[0][1] <= rate * 263, true);
  eq('pieces: all under the limit, joined end to end', pieces.every(([a, b], i) => b - a <= 270 * rate && (i === 0 || pieces[i - 1][1] === a)) && pieces.at(-1)![1] === ch.length, true);
}

// ---------- the decision model's question

{
  const q = askQuestion({ id: 'p1', text: 'Hardware', note: 'the card I use' });
  eq('question: yes/no, names the point and its note', [q.type, q.instructions.includes('"Hardware"'), q.instructions.includes('the card I use')], ['noul', true, true]);
  eq('state: recent speech and covered points', askState({ heard: 'abc', covered: ['Intro'], points: [] }), { recent_speech: 'abc', points_already_covered: ['Intro'] });
}

// ---------- the routes (loopback port, fake decider)

{
  const f = fake((a) => Object.fromEntries(a.points.map((p) => [p.id, a.heard.includes(p.text.toLowerCase()) ? 0.97 : 0.02])));
  engine.decider = () => ({ label: 'FAKE', ready: true, note: '', decide: f.decide });
  const srv = createServer((req, res) => void handlePrompter(req, res, new URL(req.url ?? '/', 'http://x')));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/prompter/`;
  const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json()) as Record<string, unknown> };
  };
  const made: string[] = [];
  try {
    const plain = await fetch(`${base}live/start`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    eq('route: JSON only (a form from another site is refused)', plain.status, 400);
    eq('route: no session yet', (await call('live')).data.live, null);
    eq('route: an empty list is refused', (await call('live/start', { name: 'x', text: '  \n' })).status, 400);

    const list = await call('lists', { name: 'Test list', text: 'Intro\nHardware' });
    made.push(String(list.data.id));
    eq('route: list saved', [list.status, list.data.name], [200, 'Test list']);
    eq('route: list read back', (await call(`lists/${list.data.id}`)).data.text, 'Intro\nHardware');
    eq('route: list in the list', ((await call('lists')).data.lists as { id: string; points: number }[]).find((l) => l.id === list.data.id)?.points, 2);
    eq('route: a bad id is not found', (await call('lists/..%2F..%2Fetc')).status, 404);

    const started = await call('live/start', { name: 'Take 1', text: 'Intro\nHardware' });
    const mic = String(started.data.mic);
    const live = started.data.live as PrompterLive;
    eq('route: started', [live.name, live.points.length, live.endedAt, live.mic], ['Take 1', 2, null, 'off']);
    eq('route: a feed without the mic token is refused', (await call('live/feed', { mic: 'nope', finals: ['intro'] })).status, 409);
    eq('route: a feed with it works', (await call('live/feed', { mic, finals: ['hello and welcome to the intro'], level: 0.5 })).status, 200);
    await sleep(900);
    let now = (await call('live')).data.live as PrompterLive;
    eq('route: the loop asked and ticked', [now.points[0].done, now.points[0].by, now.mic, now.calls >= 1], [true, 'model', 'on', true]);
    eq('route: nothing changed: only the version', Object.keys((await call(`live?id=${now.id}&v=${now.v}`)).data), ['v']);
    eq('route: another session with the same version is sent whole', Object.keys((await call(`live?id=other&v=${now.v}`)).data).includes('live'), true);
    const marked = await call('live/mark', { id: 'p2', done: true });
    eq('route: tick by hand', (marked.data.live as PrompterLive).points[1].by, 'hand');
    const other = await call('live/mic', {});
    eq('route: another device takes the mic', (await call('live/feed', { mic, partial: 'x' })).status, 409);
    eq('route: the new device feeds', (await call('live/feed', { mic: other.data.mic, partial: 'next part' })).status, 200);
    now = (await call('live/stop', {})).data.live as PrompterLive;
    eq('route: stopped', now.endedAt !== null, true);
    eq('route: a feed after stop is gone', (await call('live/feed', { mic: other.data.mic, partial: 'x' })).status, 410);
    made.push(`session:${now.id}`);
    const session = await call(`sessions/${now.id}`);
    eq('route: the transcript was saved with times', [session.data.list, /^\[00:00\] hello and welcome to the intro\n$/.test(String(session.data.text))], ['Intro\nHardware', true]);
    eq('route: the session is listed', ((await call('sessions')).data.sessions as { id: string }[])[0]?.id, now.id);

    const job = await call('after', { points: 'Intro\nSponsor', transcript: '[00:03] this is the intro of the video' });
    let res = (await call(`after/${job.data.id}`)).data;
    for (let i = 0; i < 20 && res.state === 'running'; i++) {
      await sleep(50);
      res = (await call(`after/${job.data.id}`)).data;
    }
    eq('route: AFTER result', [res.state, (res.points as { covered: boolean; at: string }[]).map((p) => [p.covered, p.at])], ['done', [[true, '00:03'], [false, '']]]);
    engine.decider = () => ({ label: '', ready: false, note: 'The decision engine is not set up: tick points by hand.', decide: null });
    eq('route: AFTER without an engine says so', (await call('after', { points: 'a', transcript: 'b' })).data.error, 'The decision engine is not set up: tick points by hand.');
    eq('route: the screen learns the engine is off', ((await call('live')).data.engine as { ready: boolean }).ready, false);
    eq('route: list deleted', [(await call(`lists/${list.data.id}`, undefined, 'DELETE')).status, (await call(`lists/${list.data.id}`)).status], [200, 404]);
  } finally {
    resetPrompter();
    srv.close();
    // Leave the data folder as it was.
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { DATA_DIR } = await import('../server/config.ts');
    for (const m of made) {
      if (m.startsWith('session:')) for (const ext of ['json', 'txt']) rmSync(join(DATA_DIR, 'prompter', 'sessions', `${m.slice(8)}.${ext}`), { force: true });
      else rmSync(join(DATA_DIR, 'prompter', 'lists', `${m}.json`), { force: true });
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
