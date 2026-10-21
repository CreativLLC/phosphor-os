import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { dropIdeas, parseIdeas, type IdeasResponse } from '../shared/ideas.ts';
import { config } from './config.ts';

// IDEAS panel (web/src/ideas.ts): the "do this later" file, format in shared/ideas.ts.
// PHOSPHOR_IDEAS_FILE in .env, else parked.md in the workspace folder (PHOSPHOR_CWD).
// GET /api/ideas -> IdeasResponse. POST /api/ideas/drop { lines: string[] } removes those lines, answers the same.

const FILE = resolve(process.env.PHOSPHOR_IDEAS_FILE || join(config.cwd, 'parked.md'));
const MAX_BODY = 64 * 1024;

async function read(): Promise<IdeasResponse> {
  if (!existsSync(FILE)) return { file: FILE, found: false, ideas: [] };
  return { file: FILE, found: true, ideas: parseIdeas(await readFile(FILE, 'utf8')) };
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let text = '';
    req.on('data', (c) => {
      text += c;
      if (text.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => ok(text));
    req.on('error', fail);
  });
}

export async function handleIdeas(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/api/ideas' && req.method === 'GET') return json(res, await read());
  if (url.pathname === '/api/ideas/drop') {
    // JSON only: a form on another local page cannot send it without the browser asking this server first.
    if (req.method !== 'POST' || !String(req.headers['content-type'] ?? '').includes('application/json')) return json(res, { error: 'POST JSON only.' }, 405);
    let lines: unknown;
    try {
      lines = (JSON.parse(await body(req)) as { lines?: unknown }).lines;
    } catch {
      /* empty or bad JSON */
    }
    if (!Array.isArray(lines) || !lines.every((l) => typeof l === 'string')) return json(res, { error: 'lines: a list of lines' }, 400);
    if (!existsSync(FILE)) return json(res, await read());
    // Read right before writing: a chat may have added a line since the page loaded.
    const md = await readFile(FILE, 'utf8');
    const next = dropIdeas(md, lines);
    if (next !== md) await writeFile(FILE, next);
    return json(res, await read());
  }
  return json(res, { error: 'not found' }, 404);
}
