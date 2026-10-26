import { query } from '@anthropic-ai/claude-agent-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { CLEANUP_STYLES, CleanupError, messagesText, runCleanup, type Ask, type CleanupModel, type CleanupModels, type CleanupResponse, type CleanupStyle } from '../shared/cleanup.ts';
import { localModel } from './config.ts';

// CLEAN UP (POST /api/voice/cleanup): messy dictated text in, clean text out. The pure parts (instructions, the check
// on an answer, the order of the models) are in shared/cleanup.ts. Here: the two models and the route.
//
// 1. The local text model, when one is set up AND already in memory (GET /v1/models says loaded): a small request
//    with no thinking and a short timeout. Never a model that sleeps or is unloaded (waking one takes ~17 s and the
//    GPU holds one model at a time), and never a Strata model (it lives on its own server). It is called on the
//    router directly, not through the relay: the relay would unload other models to make room.
// 2. Claude Haiku through the Agent SDK, like server/router.ts.

const MAX_BODY = 64 * 1024; // 8000 characters is at most 32 KB of UTF-8, and JSON escapes add some
const MAX_PARALLEL = 4;
let running = 0;

type Local = NonNullable<typeof localModel>;
type Fetch = typeof fetch;

// Is this router model in GPU memory right now? A server that is not a router has no status per model: then yes.
async function inMemory(m: Local, name: string, f: Fetch): Promise<boolean> {
  try {
    const r = await f(new URL('/v1/models', m.url), { headers: { authorization: `Bearer ${m.key}` }, signal: AbortSignal.timeout(1500) });
    const list = ((await r.json()) as { data?: { id?: string; status?: { value?: string } }[] }).data ?? [];
    const status = list.find((x) => x.id === name)?.status?.value;
    return list.some((x) => x.id === name) && (!status || status === 'loaded');
  } catch {
    return false;
  }
}

// The default local model as a clean-up model, or null (see the top of the file). m and f are for tests/cleanup.ts.
export async function readyLocal(m: Local | null | undefined = localModel, f: Fetch = fetch): Promise<CleanupModel | null> {
  const first = m?.models[0]; // the picker's default model ("local")
  if (!m || !first || m.urls[first.name]) return null;
  if (!(await inMemory(m, first.name, f))) return null;
  const ask: Ask = async (a) => {
    const r = await f(new URL('/v1/messages', m.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${m.key}`, 'anthropic-version': '2023-06-01' },
      // temperature 0: the same words give the same clean-up. enable_thinking is the chat template's own switch.
      body: JSON.stringify({ model: first.name, max_tokens: a.maxTokens, temperature: 0, system: a.system, messages: [{ role: 'user', content: a.user }], chat_template_kwargs: { enable_thinking: false } }),
      signal: AbortSignal.timeout(a.timeoutMs),
    });
    if (!r.ok) throw new Error(`the local model answered ${r.status}`);
    const text = messagesText(await r.json());
    if (text === null) throw new Error('the local model gave no usable text');
    return text;
  };
  return { by: first.label, ask, strict: true };
}

// Same options as the AUTO router's call (server/router.ts): no tools, no settings, a temp folder, nothing saved.
const askHaiku: Ask = async (a) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), a.timeoutMs);
  try {
    const q = query({
      prompt: a.user,
      options: {
        cwd: tmpdir(),
        model: 'haiku', // the alias follows the newest Haiku
        systemPrompt: a.system,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        maxTurns: 1,
        thinking: { type: 'disabled' },
        effort: 'low',
        persistSession: false, // a clean-up must not show up in HISTORY
        abortController: abort,
      },
    });
    let out = '';
    for await (const m of q) {
      if (m.type === 'result') out = m.subtype === 'success' ? m.result : '';
    }
    if (!out) throw new Error(abort.signal.aborted ? 'Haiku took too long' : 'Haiku gave no answer');
    return out;
  } finally {
    clearTimeout(timer);
  }
};

export const cleanupModels: CleanupModels = { local: () => readyLocal(), haiku: { by: 'Haiku', ask: askHaiku } };

function reply(res: ServerResponse, status: number, data: CleanupResponse): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

// Read the body up to MAX_BODY bytes; null when it is bigger.
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        parts.length = 0;
        resolve(null);
        req.resume();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => over || resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

// POST /api/voice/cleanup. Login is checked by the caller (index.ts). The body is JSON whatever its content type says:
// the cookie is SameSite=Lax, so another site cannot send it, and nothing is changed by the call.
export async function handleCleanup(req: IncomingMessage, res: ServerResponse, models: CleanupModels = cleanupModels): Promise<void> {
  if (req.method !== 'POST') {
    req.resume();
    return reply(res, 405, { error: 'POST only.' });
  }
  const body = await readBody(req);
  if (body === null) return reply(res, 413, { error: 'Too long for CLEAN UP.' });
  let ask: { text?: unknown; style?: unknown } = {};
  try {
    ask = JSON.parse(body);
  } catch {
    return reply(res, 400, { error: 'Send JSON: { "text": "..." }.' });
  }
  if (!ask || typeof ask !== 'object' || typeof ask.text !== 'string') return reply(res, 400, { error: 'Send JSON: { "text": "..." }.' });
  const style = ask.style ?? 'prompt';
  if (!CLEANUP_STYLES.includes(style as CleanupStyle)) return reply(res, 400, { error: 'style is "prompt" or "plain".' });
  if (running >= MAX_PARALLEL) return reply(res, 429, { error: 'Clean up is busy. Try again in a moment.' });
  running++;
  try {
    reply(res, 200, await runCleanup(ask.text, style as CleanupStyle, models));
  } catch (e) {
    if (e instanceof CleanupError) reply(res, e.status, { error: e.message });
    else reply(res, 500, { error: 'Clean up failed.' });
  } finally {
    running--;
  }
}
