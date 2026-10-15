import { createReadStream, promises as fsp, type Dirent } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, sep } from 'node:path';
import type { FileEntry, FileReadResponse, FilesFindResponse, FilesListResponse } from '../shared/protocol.ts';
import type { Tabs } from './tabs.ts';

// File explorer API (read-only), rooted at the tab's working folder.
// GET /api/files/list, /api/files/read, /api/files/raw, /api/files/find — see shared/protocol.ts.
// Called only for authed requests whose path starts with /api/files/.
//
// Safety rules (this server can reach the whole PC):
// - Read-only. There is no write, delete, rename or upload route.
// - Paths are relative to the tab's folder. Absolute paths, drive letters, '..', ':' (NTFS streams),
//   Windows device names and odd characters are refused before touching the disk.
// - The real path (symlinks and junctions resolved) must stay inside the real root.
// - Only plain images are served raw. SVG is text: it can carry scripts.

const TEXT_CAP = 512 * 1024; // bytes of text sent to the viewer
const SNIFF = 8 * 1024; // NUL in the first 8 KB = binary
const LIST_CAP = 2000;
const RAW_CAP = 25 * 1024 * 1024;
const MAX_PATH = 1024;

const IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

// Never worth reading to sniff (and reading a NextCloud online-only file downloads it).
const KNOWN_BINARY = new Set(
  '.exe .dll .msi .zip .7z .rar .gz .tgz .bz2 .xz .tar .iso .bin .pdf .mp3 .mp4 .m4a .wav .flac .ogg .mov .mkv .avi .webm .woff .woff2 .ttf .otf .db .sqlite .psd .docx .xlsx .pptx .tif .tiff .heic'.split(' '),
);

const WIN = process.platform === 'win32';
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i;
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

// List responses also carry the full count, so the page can say when it was cut short.
type ListResponse = FilesListResponse & { total: number };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function handleFiles(req: IncomingMessage, res: ServerResponse, url: URL, tabs: Tabs): Promise<void> {
  try {
    if (req.method !== 'GET') throw new HttpError(405, 'Read only.');
    const action = url.pathname.slice('/api/files/'.length);
    if (action !== 'list' && action !== 'read' && action !== 'raw' && action !== 'find') throw new HttpError(404, 'not found');

    const tabId = url.searchParams.get('tab') ?? '';
    const cwd = tabs.get(tabId)?.state.info.cwd;
    if (!cwd) throw new HttpError(404, 'Unknown tab.');
    if (action === 'find') return sendJson(res, await find(await realRoot(cwd), url.searchParams.get('q') ?? ''));
    const rel = cleanRel(url.searchParams.get('path') ?? '');
    const root = await realRoot(cwd);
    const real = await resolveInside(root, rel);

    if (action === 'list') return sendJson(res, await list(root, real, rel));
    if (action === 'read') return sendJson(res, await read(real, rel, tabId));
    return await raw(res, real, rel);
  } catch (e) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const [status, error] = toHttp(e);
    if (status >= 500) console.warn('files api:', e);
    sendJson(res, { error }, status);
  }
}

// ---- paths ----

// Turn the query value into clean '/'-joined segments, or refuse it.
function cleanRel(input: string): string {
  if (input.length > MAX_PATH) throw new HttpError(400, 'Path too long.');
  if (/[\x00-\x1f<>"|?*]/.test(input)) throw new HttpError(400, 'Bad characters in path.');
  const p = input.replaceAll('\\', '/');
  if (p.startsWith('/') || /^[a-z]:/i.test(p)) throw new HttpError(400, 'Path must be relative to the tab folder.');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new HttpError(400, 'Path may not go up a folder.');
    if (seg.includes(':')) throw new HttpError(400, 'Bad characters in path.'); // drive letters, NTFS streams
    if (/[. ]$/.test(seg)) throw new HttpError(400, 'Bad file name.'); // Windows drops trailing dots and spaces
    if (WIN && DEVICE.test(seg)) throw new HttpError(400, 'Bad file name.');
    if (seg.toLowerCase() === '.git') throw new HttpError(403, 'Hidden folder.');
    parts.push(seg);
  }
  return parts.join('/');
}

const fold = (p: string) => (WIN ? p.toLowerCase() : p);

function inside(root: string, target: string): boolean {
  const r = fold(root);
  const t = fold(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

async function realRoot(cwd: string): Promise<string> {
  try {
    return await fsp.realpath(cwd);
  } catch {
    throw new HttpError(404, 'The tab folder is missing.');
  }
}

// Real path of root/rel, refused if it lands outside the real root (symlinks, junctions).
async function resolveInside(root: string, rel: string): Promise<string> {
  const joined = rel ? join(root, ...rel.split('/')) : root;
  if (!inside(root, joined)) throw new HttpError(403, 'Outside the tab folder.');
  const real = await fsp.realpath(joined);
  if (!inside(root, real)) throw new HttpError(403, 'Outside the tab folder.');
  return real;
}

// ---- list ----

async function list(root: string, dir: string, rel: string): Promise<ListResponse> {
  const st = await fsp.stat(dir);
  if (!st.isDirectory()) throw new HttpError(400, 'Not a folder.');
  const dirents = await fsp.readdir(dir, { withFileTypes: true });

  // Links (symlinks, junctions): keep only those whose target stays inside the root.
  const rows: { d: Dirent; dir: boolean }[] = [];
  await Promise.all(
    dirents.map(async (d) => {
      if (d.name.toLowerCase() === '.git') return;
      if (!d.isSymbolicLink()) {
        if (d.isDirectory() || d.isFile()) rows.push({ d, dir: d.isDirectory() });
        return;
      }
      try {
        const target = await fsp.realpath(join(dir, d.name));
        if (!inside(root, target)) return;
        const ts = await fsp.stat(target);
        if (ts.isDirectory() || ts.isFile()) rows.push({ d, dir: ts.isDirectory() });
      } catch {
        /* broken link: skip */
      }
    }),
  );

  rows.sort((a, b) => (a.dir === b.dir ? collator.compare(a.d.name, b.d.name) : a.dir ? -1 : 1));
  const kept = rows.slice(0, LIST_CAP);
  const entries: FileEntry[] = await Promise.all(
    kept.map(async ({ d, dir: isDir }) => {
      let size = 0;
      let mtime = 0;
      try {
        const s = await fsp.stat(join(dir, d.name));
        size = isDir ? 0 : s.size;
        mtime = s.mtimeMs;
      } catch {
        /* locked or vanished: show it anyway */
      }
      return { name: d.name, path: rel ? `${rel}/${d.name}` : d.name, dir: isDir, size, mtime };
    }),
  );
  return { root, path: rel, entries, total: rows.length };
}

// ---- find (the launcher's FILES section) ----
// File names in the whole tab folder, from an index of relative paths built once and reused for FIND_TTL
// (after that the old index answers while a new one is built). An empty q only warms the index.
// Skips .git, node_modules and other bulky tool folders, links (they can lead outside the root) and the
// binary types the viewer can't show.

const FIND_TTL = 60 * 1000;
const FIND_MAX_FILES = 60000;
const FIND_MAX_DEPTH = 12;
const FIND_BUDGET_MS = 3000;
const FIND_RESULTS = 50;
const FIND_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv']);

type FindIndex = { at: number; files: string[]; truncated: boolean };
const indexes = new Map<string, { index?: FindIndex; pending?: Promise<FindIndex> }>();

async function buildIndex(root: string): Promise<FindIndex> {
  const files: string[] = [];
  const t0 = Date.now();
  let truncated = false;
  // Breadth first, so a cut-short index still has the files nearest the top.
  let level: string[] = [''];
  for (let depth = 0; level.length && depth <= FIND_MAX_DEPTH; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      if (files.length >= FIND_MAX_FILES || Date.now() - t0 > FIND_BUDGET_MS) {
        truncated = true;
        break;
      }
      let dirents: Dirent[];
      try {
        dirents = await fsp.readdir(rel ? join(root, ...rel.split('/')) : root, { withFileTypes: true });
      } catch {
        continue; // locked or vanished
      }
      for (const d of dirents) {
        const path = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) {
          if (!FIND_SKIP_DIRS.has(d.name.toLowerCase())) next.push(path);
        } else if (d.isFile() && !KNOWN_BINARY.has(extname(d.name).toLowerCase())) {
          files.push(path);
        }
      }
    }
    if (truncated) break;
    level = next;
  }
  if (level.length && !truncated) truncated = true; // deeper than FIND_MAX_DEPTH
  return { at: Date.now(), files, truncated };
}

function indexFor(root: string): Promise<FindIndex> {
  const key = fold(root);
  let slot = indexes.get(key);
  if (!slot) indexes.set(key, (slot = {}));
  const s = slot;
  const fresh = s.index && Date.now() - s.index.at < FIND_TTL;
  if (!fresh && !s.pending) {
    s.pending = buildIndex(root)
      .then((ix) => (s.index = ix))
      .finally(() => (s.pending = undefined));
  }
  return s.index ? Promise.resolve(s.index) : s.pending!;
}

async function find(root: string, query: string): Promise<FilesFindResponse> {
  const q = query.trim().toLowerCase().slice(0, 100);
  const ix = await indexFor(root);
  if (!q || /[\x00-\x1f]/.test(q)) return { root, results: [], truncated: ix.truncated };
  const words = q.split(/\s+/);
  const hits: { path: string; name: string; score: number; depth: number }[] = [];
  for (const path of ix.files) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    let score = 0;
    if (name === q) score = 4;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 2;
    else if (words.every((w) => lower.includes(w))) score = 1; // "src launcher" or "web/src/launch"
    if (score) hits.push({ path, name: path.slice(path.lastIndexOf('/') + 1), score, depth: path.split('/').length });
  }
  // Best match first, then nearer the top of the folder, then shorter.
  hits.sort((a, b) => b.score - a.score || a.depth - b.depth || a.path.length - b.path.length);
  return { root, results: hits.slice(0, FIND_RESULTS).map(({ path, name }) => ({ path, name })), truncated: ix.truncated };
}

// ---- read ----

async function read(file: string, rel: string, tabId: string): Promise<FileReadResponse> {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new HttpError(400, 'Not a file.');
  const size = st.size;
  const ext = extname(file).toLowerCase();
  if (IMAGES[ext]) {
    const url = `/api/files/raw?tab=${encodeURIComponent(tabId)}&path=${encodeURIComponent(rel)}`;
    return { path: rel, kind: 'image', url, size };
  }
  if (KNOWN_BINARY.has(ext)) return { path: rel, kind: 'binary', size };

  const fh = await fsp.open(file, 'r');
  let buf: Buffer;
  try {
    const want = Math.min(size, TEXT_CAP);
    buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    buf = buf.subarray(0, got);
  } finally {
    await fh.close();
  }

  const text = decode(buf);
  if (text === null) return { path: rel, kind: 'binary', size };
  return { path: rel, kind: 'text', text, size, truncated: size > buf.length };
}

// Text with a UTF-16 byte-order mark is decoded as such; otherwise a NUL byte means binary.
function decode(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(evenLength(buf.subarray(2)));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(evenLength(buf.subarray(2)));
  if (buf.subarray(0, SNIFF).includes(0)) return null;
  return new TextDecoder('utf-8', { ignoreBOM: false }).decode(buf);
}

const evenLength = (b: Buffer) => (b.length % 2 ? b.subarray(0, b.length - 1) : b);

// ---- raw (images only) ----

async function raw(res: ServerResponse, file: string, rel: string): Promise<void> {
  const type = IMAGES[extname(file).toLowerCase()];
  if (!type) throw new HttpError(415, 'Only images can be opened raw.');
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new HttpError(400, 'Not a file.');
  if (st.size > RAW_CAP) throw new HttpError(413, 'Image too large to preview.');

  await new Promise<void>((resolve) => {
    const stream = createReadStream(file);
    stream.once('open', () => {
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(rel.split('/').pop() ?? 'image')}`,
        'Cache-Control': 'private, no-cache',
      });
      stream.pipe(res);
    });
    stream.once('error', (e) => {
      if (res.headersSent) res.destroy();
      else {
        const [status, error] = toHttp(e);
        sendJson(res, { error }, status);
      }
      resolve();
    });
    stream.once('close', () => resolve());
    res.once('close', () => stream.destroy());
  });
}

// ---- helpers ----

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(data));
}

function toHttp(e: unknown): [number, string] {
  if (e instanceof HttpError) return [e.status, e.message];
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return [404, 'Not found.'];
  if (code === 'EACCES' || code === 'EPERM') return [403, 'Windows would not let us read that.'];
  if (code === 'EBUSY') return [423, 'That file is locked by another program.'];
  if (code === 'EISDIR') return [400, 'Not a file.'];
  return [500, e instanceof Error ? e.message : String(e)];
}
