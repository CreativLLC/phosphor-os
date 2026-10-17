// Local model speed (server/localmeter.ts) and the relay's copy of the stream. Made-up SSE answers in llama.cpp's and
// Strata's shapes, cut at awkward places; a fake clock. Then the relay end to end against a fake model server on a
// spare port (never the real ones): bytes pass through untouched, a cancelled answer does not stop the server.
//   npx tsx tests/localmeter.ts

import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Meter, localSpeed, meterOn, resetMeter } from '../server/localmeter.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail: unknown = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const near = (a: number | null | undefined, b: number, tol = 0.6) => typeof a === 'number' && Math.abs(a - b) <= tol;

const ev = (data: object) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
const start = (input?: number, cached?: number) =>
  ev({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', content: [], usage: input === undefined ? undefined : { input_tokens: input, ...(cached === undefined ? {} : { cache_read_input_tokens: cached }), output_tokens: 0 } } });
const think = (t: string) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: t } });
const text = (t: string) => ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } });
const tool = (j: string) => ev({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: j } });
const end = (usage?: object, extra: object = {}) => ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, ...(usage ? { usage } : {}), ...extra }) + ev({ type: 'message_stop' });

// Feed `parts` to a meter on a fake clock: each part is [ms since forwarded, text]. Every part goes in as bytes cut
// into pieces of `cut` bytes (cutting through lines, "data:" and multi-byte letters).
function play(parts: [number, string][], cut: number, o: { model?: string; crlf?: boolean; outcome?: 'ok' | 'cancelled' | 'error' | null } = {}) {
  let t = 1000;
  const m = new Meter(o.model ?? 'fake-model', () => t);
  t += 300; // the model switch
  m.forwarded();
  const base = t;
  const snaps: ReturnType<Meter['run']>[] = [];
  for (const [at, s] of parts) {
    t = base + at;
    const bytes = new TextEncoder().encode(o.crlf ? s.replace(/\n/g, '\r\n') : s);
    for (let i = 0; i < bytes.length; i += cut) m.feed(bytes.subarray(i, i + cut));
    snaps.push(m.run());
  }
  if (o.outcome !== null) m.end(o.outcome ?? 'ok');
  return { m, snaps, last: localSpeed()?.last };
}

meterOn();

// llama.cpp: message_start arrives with the first token (input_tokens = the part not in the cache), 10 thinking and
// 40 text pieces 20 ms apart, final output_tokens 50.
function llamaParts(): [number, string][] {
  const p: [number, string][] = [[2000, start(1000, 200) + think('Hmm, ')]];
  for (let i = 1; i < 10; i++) p.push([2000 + i * 20, think('hmm ')]);
  for (let i = 10; i < 50; i++) p.push([2000 + i * 20, text(i % 7 ? 'héllo' : '→ ✓ ')]);
  p.push([2000 + 49 * 20 + 5, end({ output_tokens: 50 })]);
  return p;
}
for (const cut of [1, 3, 7, 64, 100_000]) {
  resetMeter();
  const { last, snaps } = play(llamaParts(), cut, { crlf: cut === 7 });
  check(`llama.cpp shape, cut ${cut}: ok`, last?.outcome === 'ok', last);
  check(`llama.cpp shape, cut ${cut}: input and cache`, last?.inputTokens === 1000 && last?.cachedTokens === 200, last);
  check(`llama.cpp shape, cut ${cut}: output from the server`, last?.outputTokens === 50 && last?.outputExact === true, last);
  check(`llama.cpp shape, cut ${cut}: first token 2.0 s`, last?.firstTokenMs === 2000, last);
  check(`llama.cpp shape, cut ${cut}: read ~500 tok/s (estimated)`, near(last?.readTps, 500) && last?.readExact === false, last);
  check(`llama.cpp shape, cut ${cut}: write 50 tok / 0.98 s`, near(last?.writeTps, 51), last);
  check(`llama.cpp shape, cut ${cut}: total from arrival`, last?.totalMs === 300 + 2985, last);
  check(`llama.cpp shape, cut ${cut}: phases`, snaps[0].phase === 'thinking' && snaps[12].phase === 'writing' && last?.phase === undefined, snaps.map((s) => s.phase));
}

// Live numbers while it runs.
{
  resetMeter();
  const { m, snaps } = play(llamaParts().slice(0, 30), 5, { outcome: null });
  const live = localSpeed()?.live;
  check('live: shown while running', live?.outcome === 'running' && live.phase === 'writing', live);
  check('live: tokens so far estimated (not exact)', live?.outputExact === false && (live?.outputTokens ?? 0) >= 30, live);
  check('live: writing speed over the last seconds (~50 tok/s)', (snaps.at(-1)?.nowTps ?? 0) > 35 && (snaps.at(-1)?.nowTps ?? 0) < 75, snaps.at(-1));
  check('live: no last request yet', localSpeed()?.last === null);
  m.end('cancelled');
}

// Before the model answers: loading, then reading the prompt.
{
  resetMeter();
  let t = 0;
  const m = new Meter('fake-model', () => t);
  check('phase: loading while the model switches', localSpeed()?.live?.phase === 'loading');
  t = 5000;
  m.forwarded();
  t = 6000;
  check('phase: reading after it was sent', localSpeed()?.live?.phase === 'reading' && localSpeed()?.live?.totalMs === 6000, localSpeed()?.live);
  m.end('cancelled');
}

// Strata: message_start at once with the whole prompt, the final message_delta says what was read and what came
// from the cache; pieces with several tokens each.
{
  resetMeter();
  const p: [number, string][] = [[5, start(5000)]];
  for (let i = 0; i < 20; i++) p.push([4000 + i * 100, text('x'.repeat(20))]); // 5 tokens a piece
  p.push([4000 + 19 * 100, end({ input_tokens: 3000, cache_read_input_tokens: 2000, output_tokens: 100 })]);
  const { last, snaps } = play(p, 11);
  check('Strata shape: reading phase shows the whole prompt', snaps[0].phase === 'reading' && snaps[0].inputTokens === 5000, snaps[0]);
  check('Strata shape: final input = read part', last?.inputTokens === 3000 && last?.cachedTokens === 2000, last);
  check('Strata shape: read 3000 tok / 4 s', near(last?.readTps, 750), last);
  check('Strata shape: write 100 tok / 1.9 s', near(last?.writeTps, 52.6), last);
  check('Strata shape: live estimate from text length', (snaps[5].outputTokens ?? 0) === 25, snaps[5]);
}

// The model server's own timings (llama.cpp's names) win over the relay's clock.
{
  resetMeter();
  const p: [number, string][] = [[1000, start(800) + text('a')]];
  for (let i = 1; i < 30; i++) p.push([1000 + i * 30, text('b')]);
  p.push([1900, end({ output_tokens: 30 }, { timings: { prompt_n: 800, prompt_ms: 400, prompt_per_second: 2000, predicted_per_second: 61.5 } })]);
  const { last } = play(p, 9);
  check('timings: exact read speed', last?.readTps === 2000 && last?.readExact === true, last);
  check('timings: write speed from the server', last?.writeTps === 61.5, last);
}

// No usage at all: estimates, no read speed, nothing breaks.
{
  resetMeter();
  const p: [number, string][] = [[500, start()]];
  for (let i = 0; i < 40; i++) p.push([500 + i * 25, tool('{"a":1}')]);
  p.push([1500, end()]);
  const { last } = play(p, 4);
  check('no usage: ok', last?.outcome === 'ok', last);
  check('no usage: input unknown, no read speed', last?.inputTokens === null && last?.readTps === null, last);
  check('no usage: output estimated', last?.outputTokens === 80 && last?.outputExact === false, last);
  check('no usage: write speed from the estimate', near(last?.writeTps, 80 / 0.975, 1), last);
}

// Junk in the stream (bad JSON, binary, a comment, huge line) costs nothing but its own numbers.
{
  resetMeter();
  const junk = 'data: {not json\n\n: keep-alive\n\ndata: \u0000\u0001\n\nevent: ping\ndata: {"type":"ping"}\n\n';
  const p: [number, string][] = [[100, junk + start(100)], [200, text('abcd')], [300, 'data: ' + 'z'.repeat(5 << 20)], [310, '\n\n'], [400, text('abcd')], [600, end({ output_tokens: 2 })]];
  let threw = false;
  let last;
  try {
    last = play(p, 13).last;
  } catch {
    threw = true;
  }
  check('junk: never throws', !threw);
  check('junk: real events still counted', last?.outputTokens === 2 && last?.inputTokens === 100, last);
}

// Cancelled half way: the numbers so far, marked cancelled, not in RECENT.
{
  resetMeter();
  const p = llamaParts().slice(0, 20);
  const { last } = play(p, 6, { outcome: 'cancelled' });
  check('cancelled: outcome', last?.outcome === 'cancelled', last);
  check('cancelled: first token kept', last?.firstTokenMs === 2000, last);
  check('cancelled: output estimated so far', last?.outputExact === false && (last?.outputTokens ?? 0) >= 20, last);
  check('cancelled: not in RECENT', localSpeed()?.recent === null, localSpeed()?.recent);
}

// An error event inside a stream that ends normally.
{
  resetMeter();
  const { last } = play([[100, start(10)], [200, ev({ type: 'error', error: { type: 'overloaded_error', message: 'x' } })]], 5);
  check('error event: outcome error', last?.outcome === 'error', last);
}

// RECENT: the middle value of the last 5 ok ones; one slow request does not move it much.
{
  resetMeter();
  const one = (gap: number) => {
    const p: [number, string][] = [[1000, start(500) + text('a')]];
    for (let i = 1; i < 40; i++) p.push([1000 + i * gap, text('b')]);
    p.push([1000 + 39 * gap, end({ output_tokens: 40 })]);
    play(p, 50);
  };
  for (const gap of [20, 20, 20, 200, 20, 20]) one(gap);
  const r = localSpeed()?.recent;
  check('recent: 5 counted', r?.count === 5, r);
  check('recent: middle write speed ignores the slow one', near(r?.writeTps, 51.3), r);
  check('recent: first token', r?.firstTokenMs === 1000, r);
}

// ---------------------------------------------------------------- the relay, end to end
// A fake model server and the relay on spare ports. Env first, then import (config reads .env but keeps what is set).

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const STREAM = start(64) + think('ok ') + text('Hello wörld') + end({ output_tokens: 3 });
let slowSeen: () => void = () => {};
const fake = createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    if (j.fail) return res.writeHead(500, { 'content-type': 'application/json' }).end('{"type":"error"}');
    if (!j.stream) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"usage":{"output_tokens":9}}');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!j.slow) {
      // cut through an event and a multi-byte letter
      const buf = Buffer.from(STREAM);
      res.write(buf.subarray(0, 77));
      setTimeout(() => res.end(buf.subarray(77)), 30);
      return;
    }
    res.write(start(64) + text('one'));
    slowSeen();
    const t = setInterval(() => res.write(text('more')), 20);
    res.on('close', () => clearInterval(t));
  });
});
const fakePort = await listen(fake);
const probe = createServer();
const free = await listen(probe);
probe.close();
Object.assign(process.env, {
  PHOSPHOR_PORT: String(free - 1),
  PHOSPHOR_PASSWORD: 'test-only',
  PHOSPHOR_LOCAL_URL: `http://127.0.0.1:${fakePort}`,
  PHOSPHOR_LOCAL_MODELS: 'fake=Fake',
  PHOSPHOR_LOCAL_MORE_MODELS: '',
  PHOSPHOR_LOCAL_URLS: '',
  PHOSPHOR_LOCAL_UNITS: '',
  PHOSPHOR_LOCAL_CONTEXTS: '',
});
const { startLocalRelay, LOCAL_RELAY_PORT } = await import('../server/localrelay.ts');
check('relay: spare port, not the live one', LOCAL_RELAY_PORT === free, LOCAL_RELAY_PORT);
startLocalRelay();
await new Promise((r) => setTimeout(r, 50));

function post(body: object, onFirst?: (stop: () => void) => void): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: LOCAL_RELAY_PORT, method: 'POST', path: '/v1/messages?beta=true', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        if (onFirst && chunks.length === 1) onFirst(() => req.destroy());
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve({ status: -1, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve({ status: -1, text: '' }));
    req.end(JSON.stringify({ model: 'fake', ...body }));
  });
}

resetMeter();
{
  const r = await post({ stream: true });
  check('relay: stream passed through byte for byte', r.status === 200 && r.text === STREAM, r.text.length);
  await new Promise((res) => setTimeout(res, 20));
  const last = localSpeed()?.last;
  check('relay: measured', last?.outcome === 'ok' && last.model === 'fake' && last.outputTokens === 3 && last.inputTokens === 64, last);
}
{
  const before = localSpeed()?.last;
  const r = await post({ stream: false });
  check('relay: non-streamed answer passed on, not measured', r.text === '{"usage":{"output_tokens":9}}' && localSpeed()?.last === before && localSpeed()?.live === null, localSpeed());
}
{
  const r = await post({ stream: true, fail: true });
  check('relay: server error passed on, measured as error', r.status === 500 && localSpeed()?.last?.outcome === 'error', localSpeed()?.last);
}
{
  const seen = new Promise<void>((r) => (slowSeen = r));
  await post({ stream: true, slow: true }, (stop) => void seen.then(() => setTimeout(stop, 120)));
  await new Promise((r) => setTimeout(r, 150));
  const last = localSpeed()?.last;
  check('relay: cancelled answer measured as cancelled', last?.outcome === 'cancelled' && (last.outputTokens ?? 0) > 1, last);
  const r = await post({ stream: true });
  check('relay: still serving after a cancel', r.status === 200 && r.text === STREAM);
}

fake.close();
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
