import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CommandsResponse, McpAction, McpResponse } from '../shared/protocol.ts';
import type { Tabs } from './tabs.ts';

// MCP screen and "/" menu. Both ask the tab's own Claude process (see Tab.mcpServers / Tab.commands).
// GET /api/mcp?tab=<id>, POST /api/mcp { tab, name, action }, GET /api/commands?tab=<id>. Types in shared/protocol.ts.
// Called only for authed requests.

const ACTIONS: McpAction[] = ['reconnect', 'enable', 'disable'];
const TIMEOUT_MS = 15_000;

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (c) => {
      text += c;
      if (text.length > 4096) req.destroy();
    });
    req.on('end', () => resolve(text));
    req.on('error', reject);
  });
}

// Claude's process can be slow to start; never leave the page waiting forever.
function inTime<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Claude did not answer in time. Try again.')), TIMEOUT_MS))]);
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL, tabs: Tabs): Promise<void> {
  if (url.pathname === '/api/commands') {
    const tab = tabs.get(url.searchParams.get('tab') ?? '');
    if (!tab) return json(res, { error: 'No such tab.' }, 404);
    return json(res, { commands: await inTime(tab.commands()) } satisfies CommandsResponse);
  }

  if (req.method === 'POST') {
    let b: { tab?: unknown; name?: unknown; action?: unknown } = {};
    try {
      b = JSON.parse(await body(req));
    } catch {
      /* empty or bad JSON */
    }
    const tab = tabs.get(String(b.tab ?? ''));
    const action = ACTIONS.find((a) => a === b.action);
    if (!tab || !action || typeof b.name !== 'string' || !b.name) return json(res, { error: 'Bad request.' }, 400);
    const error = await inTime(tab.mcpAction(b.name, action));
    return json(res, { servers: await inTime(tab.mcpServers()), ...(error ? { error } : {}) } satisfies McpResponse);
  }

  const tab = tabs.get(url.searchParams.get('tab') ?? '');
  if (!tab) return json(res, { error: 'No such tab.' }, 404);
  return json(res, { servers: await inTime(tab.mcpServers()) } satisfies McpResponse);
}
