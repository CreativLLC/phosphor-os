import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Attachment } from '../shared/protocol.ts';
import { DATA_DIR } from './config.ts';

// Files the user pastes, drops or picks in the chat. Each one lands in data/uploads/<id>/<name>.
// Images go to Claude inline (it sees them); every file's path is also listed in the message so
// Claude can open it with Read. Claude gets this folder as an extra allowed directory.

export const UPLOADS_DIR = join(DATA_DIR, 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_BYTES = 30 * 1024 * 1024;
const ID = /^[0-9a-f-]{36}$/;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export type StoredUpload = Attachment & { path: string };

function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^\w.\- ()]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(-100);
  return clean || 'file';
}

function describe(id: string, path: string, name: string): StoredUpload {
  const mediaType = IMAGE_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
  return { id, name, path, size: statSync(path).size, kind: mediaType.startsWith('image/') ? 'image' : 'file', mediaType };
}

export function getUpload(id: string): StoredUpload | undefined {
  if (!ID.test(id)) return undefined;
  const dir = join(UPLOADS_DIR, id);
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir)[0];
  return name ? describe(id, join(dir, name), name) : undefined;
}

// POST /api/upload?name=<file name>, raw bytes as the body.
export async function receiveUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const json = (data: unknown, status = 200): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  };
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const name = safeName(url.searchParams.get('name') ?? '');
  const id = randomUUID();
  const dir = join(UPLOADS_DIR, id);
  mkdirSync(dir);
  const path = join(dir, name);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done(bytes > MAX_BYTES ? new Error('too big') : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(path));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    const big = e instanceof Error && e.message === 'too big';
    return json({ error: big ? 'File is over 30 MB.' : 'Upload failed.' }, big ? 413 : 400);
  }
  if (bytes === 0) {
    rmSync(dir, { recursive: true, force: true });
    return json({ error: 'Empty file.' }, 400);
  }
  const { path: _p, ...att } = describe(id, path, name);
  json(att satisfies Attachment);
}

// GET /api/upload/<id>: images only, for thumbnails. Sandboxed so nothing in it can run.
export function serveUpload(res: ServerResponse, id: string): void {
  const up = getUpload(id);
  if (!up || up.kind !== 'image') {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': up.mediaType,
    'Content-Length': up.size,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  createReadStream(up.path).pipe(res);
}
