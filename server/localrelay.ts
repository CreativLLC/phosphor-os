import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { config, localModel } from './config.ts';
import { Meter, meterOn } from './localmeter.ts';

// Claude Code asks for a thinking level on every request (output_config.effort). Qwen takes its level through the
// chat template (reasoning_effort: low, medium, xhigh). This relay turns one into the other and passes the rest on
// untouched. It adds no key: the caller's own key goes to llama.cpp, which refuses a wrong one.
const QWEN_LEVEL: Record<string, string> = { low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' };
// A model on its own server (Strata) reads Claude's levels itself, up to high.
const OWN_LEVEL: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

export const LOCAL_RELAY_PORT = config.port + 1;

type Local = NonNullable<typeof localModel>;
type Fetch = typeof fetch;
const json = { 'content-type': 'application/json' };
const startUnit = async (unit: string) => void (await promisify(execFile)('systemctl', ['--user', 'start', unit]));

// The GPU holds one model at a time (two at once crashed the desktop). Before a request, the other servers give
// theirs back: the router unloads its models before a model on its own server runs, and an own server unloads
// (Strata: POST /unload) before a router model runs. A server that is down holds nothing. Switches run one at a time.
let switching: Promise<unknown> = Promise.resolve();
export function makeRoom(m: Local, name: string, f: Fetch = fetch, start = startUnit): Promise<void> {
  const next = switching.then(() => room(m, name, f, start));
  switching = next.catch(() => {});
  return next;
}

// Requests to a model on its own server (Strata), from their GPU turn to their answer's end: that server is loading
// or answering, though its /health may not say loaded yet. ask_local (server/delegate.ts) is BUSY then.
let ownRequests = 0;
export const ownBusy = (): boolean => ownRequests > 0;

// ask_local's requests carry NO_SWAP: they run only on the model that holds the card now. Checked in the switch line,
// after a switch already on its way: a model on its own server loaded or busy, or another router model loaded or
// loading, is the reason given (the relay answers 409) instead of a swap. '' = it can run without one.
export const NO_SWAP = 'x-phosphor-no-swap';
export function swapNeeded(m: Local, name: string, f: Fetch = fetch): Promise<string> {
  const next = switching.then(async () => {
    if (m.urls[name]) return `${name} runs on its own server`;
    if (ownRequests > 0) return 'a model on its own server is loading or answering';
    for (const url of new Set(Object.values(m.urls))) if ((await health(url, f))?.loaded) return 'a model on its own server has the GPU';
    try {
      const r = await f(new URL('/v1/models', m.url), { headers: { authorization: `Bearer ${m.key}` }, signal: AbortSignal.timeout(3000) });
      const list = ((await r.json()) as { data?: { id?: string; status?: { value?: string } }[] }).data ?? [];
      const other = list.find((x) => x.id && x.id !== name && ['loaded', 'loading'].includes(x.status?.value ?? ''));
      if (other) return `${other.id} has the GPU`;
    } catch {
      /* not a router: its one model */
    }
    return '';
  });
  switching = next.catch(() => {});
  return next;
}

// The image model (server/imagegen.ts) needs the whole card: every chat model gives its memory back. A running
// Strata answer finishes first (/unload?wait); the GPU turns (server/gpu.ts) keep router requests from running then.
export function freeChatModels(f: Fetch = fetch): Promise<void> {
  if (!localModel) return Promise.resolve();
  const m = localModel;
  const next = switching.then(async () => {
    await unloadRouter(m, f);
    for (const url of new Set(Object.values(m.urls))) await unloadOwn(url, f);
  });
  switching = next.catch(() => {});
  return next;
}

// Each chat request waits for its turn on the GPU (server/gpu.ts) while a picture is being made, and holds it until
// its answer ends. Set by the image model when it is configured; without one, every request goes at once.
let chatTurn: () => Promise<() => void> = async () => () => {};
export function setChatTurn(fn: () => Promise<() => void>): void {
  chatTurn = fn;
}

async function room(m: Local, name: string, f: Fetch, start: (unit: string) => Promise<void>): Promise<void> {
  const own = m.urls[name];
  if (!own) {
    for (const url of Object.values(m.urls)) await unloadOwn(url, f);
    return;
  }
  await unloadRouter(m, f);
  // Another model on its own server (a second Strata size) gives its GPU and RAM back too.
  for (const url of new Set(Object.values(m.urls))) if (url !== own) await unloadOwn(url, f);
  await ensureUp(own, m.units[name], f, start);
}

async function unloadRouter(m: Local, f: Fetch): Promise<void> {
  const auth = { authorization: `Bearer ${m.key}` };
  try {
    const r = await f(new URL('/v1/models', m.url), { headers: auth, signal: AbortSignal.timeout(3000) });
    const list = ((await r.json()) as { data?: { id?: string; status?: { value?: string } }[] }).data ?? [];
    for (const x of list) {
      if (!x.id || !x.status?.value || x.status.value === 'unloaded') continue;
      await f(new URL('/models/unload', m.url), { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ model: x.id }), signal: AbortSignal.timeout(30_000) });
    }
  } catch {
    /* router off or not a router: nothing to unload */
  }
}

async function health(url: string, f: Fetch): Promise<{ loaded?: boolean } | undefined> {
  try {
    const r = await f(new URL('/health', url), { signal: AbortSignal.timeout(2000) });
    return r.ok ? ((await r.json()) as { loaded?: boolean }) : undefined;
  } catch {
    return undefined;
  }
}

async function unloadOwn(url: string, f: Fetch): Promise<void> {
  if (!(await health(url, f))?.loaded) return;
  try {
    // ?wait lets a running answer finish first.
    await f(new URL('/unload?wait=300', url), { method: 'POST', headers: json, body: '{}', signal: AbortSignal.timeout(310_000) });
  } catch {
    /* gone meanwhile */
  }
}

// Start the server's unit when it does not answer, then wait for it (Strata reads tens of GB at its first start).
async function ensureUp(url: string, unit: string | undefined, f: Fetch, start: (unit: string) => Promise<void>, waitMs = 600_000): Promise<void> {
  if ((await health(url, f)) || !unit) return;
  try {
    await start(unit);
  } catch (e) {
    console.warn(`Local model: could not start ${unit}:`, e);
    return;
  }
  for (const end = Date.now() + waitMs; Date.now() < end; ) {
    if (await health(url, f)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// A model without its vision file refuses any request with a picture in it (Strata: "400 ... started without the vision
// encoder"; llama.cpp: "500 image input is not supported"). The picture stays in the chat's history, so every later
// message failed too and the chat was stuck. Then the relay sends a short note in each picture's place and tries again.
export const NO_VISION = /without the vision encoder|image input is not supported/i;
export const IMAGE_NOTE = '[A picture was here. This model cannot see pictures, so it was left out.]';

// The request with every picture (also those inside tool results) swapped for IMAGE_NOTE; null when it has none.
export function withoutImages(j: { messages?: unknown }): object | null {
  let found = false;
  const swap = (blocks: unknown): unknown =>
    Array.isArray(blocks)
      ? blocks.map((b) => {
          if (b?.type === 'image') {
            found = true;
            return { type: 'text', text: IMAGE_NOTE };
          }
          return b?.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: swap(b.content) } : b;
        })
      : blocks;
  const messages = Array.isArray(j.messages) ? j.messages.map((msg) => (msg && typeof msg === 'object' ? { ...msg, content: swap((msg as { content?: unknown }).content) } : msg)) : j.messages;
  return found ? { ...j, messages } : null;
}

export function startLocalRelay(): void {
  if (!localModel) return;
  const m = localModel;
  meterOn();
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let target = m.url;
    let meter: Meter | undefined; // streamed answers only: the SYS panel's speed numbers (server/localmeter.ts)
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body = Buffer.concat(chunks);
      let blind: object | null = null; // the request without its pictures, for a model that cannot see them
      if (req.method === 'POST') {
        try {
          const j = JSON.parse(body.toString('utf8'));
          const name = typeof j?.model === 'string' ? j.model : '';
          if (name && j.stream === true && req.url?.split('?')[0] === '/v1/messages') meter = new Meter(name);
          if (name) {
            target = m.urls[name] || m.url;
            if (target !== m.url) {
              ownRequests++;
              res.on('close', () => ownRequests--);
            }
            const release = await chatTurn();
            if (abort.signal.aborted) release(); // the caller left while it waited
            else res.on('close', release);
            const busy = req.headers[NO_SWAP] ? await swapNeeded(m, name) : await makeRoom(m, name).then(() => '');
            if (busy) {
              meter?.drop();
              res.writeHead(409, json).end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: busy } }));
              return;
            }
          }
          const effort = j?.output_config?.effort;
          if (req.url?.startsWith('/v1/messages')) blind = withoutImages(j);
          if (req.url?.startsWith('/v1/messages') && effort) {
            if (m.urls[name]) {
              if (OWN_LEVEL[effort] && OWN_LEVEL[effort] !== effort) body = Buffer.from(JSON.stringify({ ...j, output_config: { ...j.output_config, effort: OWN_LEVEL[effort] } }));
            } else if (QWEN_LEVEL[effort]) {
              body = Buffer.from(JSON.stringify({ ...j, chat_template_kwargs: { ...j.chat_template_kwargs, reasoning_effort: QWEN_LEVEL[effort] } }));
            }
          }
        } catch {
          /* not JSON: pass it on as it is */
        }
      }
      if (abort.signal.aborted) return meter?.end('cancelled');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'content-length', 'connection', NO_SWAP].includes(k)) headers[k] = v;
      meter?.forwarded();
      const send = (b: typeof body) => fetch(new URL(req.url ?? '/', target), { method: req.method, headers, body: b.length ? b : undefined, signal: abort.signal });
      let r = await send(body);
      if (blind && !r.ok) {
        const text = await r.text();
        if (NO_VISION.test(text)) {
          // Same changes as above (thinking level), pictures out.
          const sent = JSON.parse(body.toString('utf8'));
          r = await send(Buffer.from(JSON.stringify({ ...sent, messages: (blind as { messages?: unknown }).messages })));
        } else r = new Response(text, { status: r.status, statusText: r.statusText, headers: r.headers });
      }
      res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k))));
      const sse = r.ok && !!r.headers.get('content-type')?.includes('text/event-stream');
      if (meter && !sse) {
        if (r.ok) meter.drop(); // not streamed: nothing to time
        else meter.end('error');
      }
      const mt = sse ? meter : undefined;
      if (r.body) {
        const answer = Readable.fromWeb(r.body as never);
        answer.pipe(res);
        // A cancelled or broken answer errors the stream: without this listener that error stopped the whole server.
        answer.on('error', () => {
          mt?.end(abort.signal.aborted ? 'cancelled' : 'error');
          res.destroy();
        });
        // After pipe: each chunk goes to Claude Code first, then a copy to the meter.
        if (mt) {
          answer.on('data', (c: Uint8Array) => mt.feed(c));
          answer.on('end', () => mt.end('ok'));
          res.on('close', () => mt.end('cancelled'));
        }
      } else {
        mt?.drop();
        res.end();
      }
    } catch (e) {
      meter?.end(abort.signal.aborted ? 'cancelled' : 'error');
      if (abort.signal.aborted) return;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      const own = Object.entries(m.urls).find(([, u]) => u === target)?.[0];
      const how = own && m.units[own] ? `systemctl --user start ${m.units[own]}` : 'bash scripts/local-model.sh on';
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Local model not reachable (${e instanceof Error ? e.message : e}). Start it: ${how}` } }));
    }
  });
  server.on('error', (e) => console.warn('Local model relay could not start:', e));
  server.listen(LOCAL_RELAY_PORT, '127.0.0.1');
}

// Is this model in its server's memory? A server that is not a router has no status per model: then yes. A model on
// its own server is loaded when that server's /health says so (a server still starting: not yet).
export async function localLoaded(name: string): Promise<boolean> {
  if (!localModel) return true;
  const own = localModel.urls[name];
  if (own) return !!(await health(own, fetch))?.loaded;
  try {
    const r = await fetch(new URL('/v1/models', localModel.url), { headers: { authorization: `Bearer ${localModel.key}` }, signal: AbortSignal.timeout(3000) });
    const list = ((await r.json()) as { data?: { id?: string; status?: { value?: string } }[] }).data ?? [];
    const status = list.find((m) => m.id === name)?.status?.value;
    return !status || status === 'loaded';
  } catch {
    return true; // not reachable: the request itself will say so
  }
}
