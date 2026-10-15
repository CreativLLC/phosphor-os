import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { config, localModel } from './config.ts';

// Claude Code asks for a thinking level on every request (output_config.effort). Qwen takes its level through the
// chat template (reasoning_effort: low, medium, xhigh). This relay turns one into the other and passes the rest on
// untouched. It adds no key: the caller's own key goes to llama.cpp, which refuses a wrong one.
const QWEN_LEVEL: Record<string, string> = { low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' };

export const LOCAL_RELAY_PORT = config.port + 1;

export function startLocalRelay(): void {
  if (!localModel) return;
  const upstream = localModel.url;
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
        try {
          const json = JSON.parse(body.toString('utf8'));
          const level = QWEN_LEVEL[json?.output_config?.effort];
          if (level) body = Buffer.from(JSON.stringify({ ...json, chat_template_kwargs: { ...json.chat_template_kwargs, reasoning_effort: level } }));
        } catch {
          /* not JSON: pass it on as it is */
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'content-length', 'connection'].includes(k)) headers[k] = v;
      const r = await fetch(new URL(req.url ?? '/', upstream), { method: req.method, headers, body: body.length ? body : undefined, signal: abort.signal });
      res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k))));
      if (r.body) Readable.fromWeb(r.body as never).pipe(res);
      else res.end();
    } catch (e) {
      if (abort.signal.aborted) return;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Local model not reachable (${e instanceof Error ? e.message : e}). Start it: bash scripts/local-model.sh on` } }));
    }
  });
  server.on('error', (e) => console.warn('Local model relay could not start:', e));
  server.listen(LOCAL_RELAY_PORT, '127.0.0.1');
}

// Is this model in the local server's memory? A server that is not a router has no status per model: then yes.
export async function localLoaded(name: string): Promise<boolean> {
  if (!localModel) return true;
  try {
    const r = await fetch(new URL('/v1/models', localModel.url), { headers: { authorization: `Bearer ${localModel.key}` }, signal: AbortSignal.timeout(3000) });
    const list = ((await r.json()) as { data?: { id?: string; status?: { value?: string } }[] }).data ?? [];
    const status = list.find((m) => m.id === name)?.status?.value;
    return !status || status === 'loaded';
  } catch {
    return true; // not reachable: the request itself will say so
  }
}
