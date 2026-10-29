import { randomUUID } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PROJECT_FILE_MAX, PROJECT_FILES_COUNT, PROJECT_FILES_TOTAL, type ProjectFile } from '../shared/protocol.ts';
import { safeName } from './uploads.ts';

// FILES (owner's ask 2026-10-28): reference files of a project (notes, PDFs, pictures, code) in
// data/projects/<id>/files/. Every chat of the project may read them (the project folder is an additional directory)
// and is told their names (Tab.start). Only plain files directly in the folder count: no subfolders, no links (a chat
// could put a link to anything there), no hidden names (uploads in progress). Names are cleaned like chat uploads.

const MB = 1024 * 1024;

export const filesDir = (projectDir: string) => join(projectDir, 'files');

// The files folder itself must be a real folder (a link there could lead anywhere).
const dirOk = (dir: string) => lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;

// The file's own name if it is one of the project's files, else undefined (path tricks, links, missing).
function fileOf(dir: string, name: string): string | undefined {
  if (!name || name !== safeName(name) || !dirOk(dir)) return undefined;
  const file = join(dir, name);
  return lstatSync(file, { throwIfNoEntry: false })?.isFile() ? file : undefined;
}

export function listFiles(projectDir: string): ProjectFile[] {
  const dir = filesDir(projectDir);
  if (!dirOk(dir)) return [];
  const out: ProjectFile[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const st = lstatSync(join(dir, name), { throwIfNoEntry: false });
    if (st?.isFile()) out.push({ name, size: st.size, updatedAt: st.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// POST /api/projects/<id>/files?name=<name>[&replace=1], raw bytes as the body. Written to a hidden name first, then
// moved into place, so a failed upload leaves nothing. A name in use needs replace=1 (the page asks first).
export async function receiveFile(req: IncomingMessage, projectDir: string, rawName: string, replace: boolean): Promise<{ status: number; body: ProjectFile | { error: string; exists?: true } }> {
  const name = safeName(rawName);
  const dir = filesDir(projectDir);
  const files = listFiles(projectDir);
  const old = files.find((f) => f.name === name);
  const fail = (status: number, error: string) => {
    req.resume(); // drain the body so the answer gets through
    return { status, body: { error } };
  };
  if (!dirOk(projectDir)) return fail(404, 'No such project.');
  if (existsSync(dir) && !dirOk(dir)) return fail(409, 'The files folder is not a plain folder.');
  if (old && !replace) {
    req.resume();
    return { status: 409, body: { error: `"${name}" is already there.`, exists: true } };
  }
  if (!old && existsSync(join(dir, name))) return fail(409, `"${name}" is taken by something that is not a plain file.`);
  if (!old && files.length >= PROJECT_FILES_COUNT) return fail(413, `At most ${PROJECT_FILES_COUNT} files in a project.`);
  const room = Math.min(PROJECT_FILE_MAX, PROJECT_FILES_TOTAL - files.reduce((n, f) => n + f.size, 0) + (old?.size ?? 0));
  const declared = Number(req.headers['content-length']);
  if (room <= 0 || declared > room) return fail(413, declared > PROJECT_FILE_MAX ? `A file can be at most ${PROJECT_FILE_MAX / MB} MB.` : `The project's files are full (${PROJECT_FILES_TOTAL / MB} MB).`);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.up-${randomUUID()}`);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      done(bytes > room ? new Error('too big') : null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(tmp, { flags: 'wx' }));
  } catch (e) {
    rmSync(tmp, { force: true });
    const big = e instanceof Error && e.message === 'too big';
    return { status: big ? 413 : 400, body: { error: big ? `Too big: room for ${(room / MB).toFixed(1)} MB.` : 'Upload failed.' } };
  }
  if (bytes === 0) {
    rmSync(tmp, { force: true });
    return { status: 400, body: { error: 'Empty file.' } };
  }
  renameSync(tmp, join(dir, name));
  const st = lstatSync(join(dir, name));
  return { status: 200, body: { name, size: st.size, updatedAt: st.mtimeMs } };
}

export function deleteFile(projectDir: string, name: string): boolean {
  const file = fileOf(filesDir(projectDir), name);
  if (!file) return false;
  rmSync(file);
  return true;
}

// GET /api/projects/<id>/files/<name>: pictures, PDFs and text open in the browser, anything else downloads.
// Sandboxed (no scripts) except PDFs, which the browser's own viewer shows (it does not run in a sandboxed page).
const INLINE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export function serveFile(res: ServerResponse, projectDir: string, name: string, download: boolean): void {
  const file = fileOf(filesDir(projectDir), name);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const type = INLINE[extname(name).toLowerCase()] ?? (looksLikeText(file) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
  const inline = !download && type !== 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': lstatSync(file).size,
    'X-Content-Type-Options': 'nosniff',
    ...(type === 'application/pdf' ? {} : { 'Content-Security-Policy': 'sandbox' }),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'private, no-cache',
  });
  createReadStream(file).pipe(res);
}

// Text if the first 8 KB have no NUL byte (notes, markdown, code).
function looksLikeText(file: string): boolean {
  const buf = Buffer.alloc(8192);
  const fd = openSync(file, 'r');
  try {
    return !buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).includes(0);
  } finally {
    closeSync(fd);
  }
}
