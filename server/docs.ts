import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp, type Dirent, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DocConflict, DocEntry, DocFile, DocFormat, DocKind, DocStat, DocsHit, DocsInfo, DocsList, DocsSearch, OpenFile, TrashItem } from '../shared/docs.ts';
import { DATA_DIR, ROOT } from './config.ts';

// DOCS: the document program's file API (shapes in shared/docs.ts). Called only for authed /api/docs/ requests.
//
// Where: the docs root is PHOSPHOR_DOCS_DIR in .env, else ~/Documents. It may not exist yet: the first save makes it.
// PHOSPHOR_DOCS_READONLY lists folders DOCS shows but never changes (default: none), unless the docs root itself
// is inside one: then the owner chose it on purpose.
//
// Safety (this server can reach the whole PC):
// - Paths are relative to the root. Absolute paths, drive letters, '..', ':' (NTFS streams), Windows device
//   names, trailing dots or spaces, odd characters and over-long names are refused before touching the disk.
// - Real paths (symlinks and junctions resolved) must stay inside the real root, for reads and writes.
// - Nothing is ever really deleted: DELETE moves the item into <root>/.retro-trash/<stamp>/.
// - Saves carry the etag (content hash) the page last saw; a file changed on disk since (Nextcloud synced a
//   change, another program) is refused with 409 and both versions go back to the page. Saves are atomic
//   (temp file + rename), so a crash never leaves half a file.
// - Only plain text is edited (UTF-8, or UTF-16 LE with its mark), up to MAX_EDIT bytes.
// - OPEN FILES (files outside the root, opened from the PC): only those the desktop app on this PC added; see below.

export const MAX_EDIT = 2 * 1024 * 1024;
const MAX_BODY = 10 * 1024 * 1024; // JSON-escaped text runs larger than the file
const LIST_CAP = 2000;
const MAX_PATH = 1024;
const MAX_SEG = 255;
const SNIFF = 8 * 1024;
export const TRASH = '.retro-trash'; // named before the rename; kept so older trash stays in one place
const TRASH_LIST_CAP = 500;

const SEARCH_BUDGET_MS = 2500;
const SEARCH_MAX_ENTRIES = 40000;
const SEARCH_MAX_READ = 64 * 1024 * 1024;
const SEARCH_FILE_CAP = 1024 * 1024;
const SEARCH_RESULTS = 100;
const SEARCH_HITS_PER_FILE = 3;
const SEARCH_MAX_DEPTH = 16;
const SKIP_DIRS = new Set(['node_modules', '__pycache__']);

// Opened in the editor straight away. Unknown types are sniffed when opened.
const TEXT_EXT = new Set(
  '.md .markdown .mdown .txt .text .org .rst .adoc .tex .csv .tsv .log .json .jsonc .yaml .yml .toml .ini .cfg .conf .env .xml .html .htm .css .js .mjs .cjs .ts .tsx .jsx .py .sh .ps1 .bat .cmd .sql .srt .vtt .todo'.split(' '),
);
// Shown with a hint (open them in Nextcloud or the PC's own program). Never read: a Nextcloud online-only file
// would download.
const OTHER_EXT = new Set(
  '.doc .docx .odt .rtf .pages .xls .xlsx .ods .ppt .pptx .odp .odg .pdf .epub .png .jpg .jpeg .gif .webp .bmp .ico .svg .heic .tif .tiff .psd .mp3 .mp4 .m4a .wav .flac .ogg .mov .mkv .avi .webm .zip .7z .rar .gz .tgz .bz2 .xz .tar .iso .exe .dll .msi .bin .db .sqlite .woff .woff2 .ttf .otf .lnk .url .gdoc .gsheet .gslides .whiteboard'.split(
    ' ',
  ),
);

const WIN = process.platform === 'win32';
// Refused on every OS: the folder syncs to Windows PCs, where these names break.
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i;
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- config

// opened: the OPEN FILES list (data/docs-open.json); without it there are none.
export type Ctx = { root: string; readonly: string[]; opened?: string };

const expand = (p: string) => resolve(ROOT, p.trim().replace(/^~(?=$|[\\/])/, homedir()));

export function docsConfig(): Ctx & { fromEnv: boolean } {
  const raw = process.env.PHOSPHOR_DOCS_DIR?.trim();
  const root = raw ? expand(raw) : join(homedir(), 'Documents');
  const ro = process.env.PHOSPHOR_DOCS_READONLY?.trim();
  const list = ro ? ro.split(delimiter) : [];
  return { root, fromEnv: !!raw, readonly: list.filter((s) => s.trim()).map(expand), opened: join(DATA_DIR, 'docs-open.json') };
}

// ---------------------------------------------------------------- paths

// Turn the page's path into clean '/'-joined segments, or refuse it. '' = the root.
export function cleanRel(input: unknown, opts: { trash?: boolean } = {}): string {
  if (typeof input !== 'string') throw new HttpError(400, 'Missing path.');
  if (input.length > MAX_PATH) throw new HttpError(400, 'Path too long.');
  if (/[\x00-\x1f<>"|?*]/.test(input)) throw new HttpError(400, 'Bad characters in the name. These are not allowed: < > " | ? * :');
  const p = input.replaceAll('\\', '/');
  if (p.startsWith('/') || /^[a-z]:/i.test(p)) throw new HttpError(400, 'Path must be inside the docs folder.');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new HttpError(400, 'Path may not go up a folder.');
    if (seg.includes(':')) throw new HttpError(400, 'Bad characters in the name. These are not allowed: < > " | ? * :');
    if (/[. ]$/.test(seg) || /^ /.test(seg)) throw new HttpError(400, 'A name may not start with a space or end with a dot or a space.');
    if (DEVICE.test(seg)) throw new HttpError(400, 'Windows keeps that name for itself. Pick another.');
    if (seg.length > MAX_SEG) throw new HttpError(400, `Name too long (over ${MAX_SEG} letters).`);
    if (seg.toLowerCase() === '.git') throw new HttpError(403, 'Hidden folder.');
    parts.push(seg);
  }
  if (!opts.trash && parts[0]?.toLowerCase() === TRASH) throw new HttpError(403, 'Use TRASH to see or restore deleted items.');
  return parts.join('/');
}

const fold = (p: string) => (WIN ? p.toLowerCase() : p);

export function inside(root: string, target: string): boolean {
  const r = fold(root);
  const t = fold(target);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

const parentRel = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
const segs = (rel: string) => (rel ? rel.split('/') : []);

async function realRootOrNull(ctx: Ctx): Promise<string | null> {
  try {
    return await fsp.realpath(ctx.root);
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    throw e;
  }
}

async function realRoot(ctx: Ctx): Promise<string> {
  const r = await realRootOrNull(ctx);
  if (!r) throw new HttpError(404, 'The docs folder does not exist yet. Save a document to make it.');
  return r;
}

// Writes may make the root, but only the root itself: its parent must exist (never build folders elsewhere).
async function ensureRoot(ctx: Ctx): Promise<string> {
  const r = await realRootOrNull(ctx);
  if (r) return r;
  try {
    await fsp.mkdir(ctx.root);
  } catch (e) {
    if (code(e) === 'ENOENT') throw new HttpError(404, `The folder that should hold the docs folder is missing: ${dirname(ctx.root)}`);
    if (code(e) !== 'EEXIST') throw e;
  }
  return await fsp.realpath(ctx.root);
}

// Real path of root/rel (it must exist), refused if it lands outside the real root.
export async function resolveExisting(root: string, rel: string): Promise<string> {
  const joined = rel ? join(root, ...segs(rel)) : root;
  if (!inside(root, joined)) throw new HttpError(403, 'Outside the docs folder.');
  const real = await fsp.realpath(joined);
  if (!inside(root, real)) throw new HttpError(403, 'Outside the docs folder.');
  return real;
}

// A folder inside the root, made (one level at a time, each checked) when mkdirs and missing.
async function resolveDir(root: string, rel: string, mkdirs: boolean): Promise<string> {
  let cur = root;
  for (const s of segs(rel)) {
    const next = join(cur, s);
    let st: Stats | null = null;
    try {
      st = await fsp.lstat(next);
    } catch (e) {
      if (code(e) !== 'ENOENT') throw e;
    }
    if (!st) {
      if (!mkdirs) throw new HttpError(404, 'That folder is gone.');
      await fsp.mkdir(next);
      cur = next;
      continue;
    }
    const real = await fsp.realpath(next);
    if (!inside(root, real)) throw new HttpError(403, 'Outside the docs folder.');
    if (!(await fsp.stat(real)).isDirectory()) throw new HttpError(409, `${s} is a file, not a folder.`);
    cur = real;
  }
  return cur;
}

// Where a new item for rel goes: its real parent folder (inside the root) and the full path. Not checked for
// existence: callers create with 'wx' / mkdir, which fail on anything already there (links too).
export async function resolveNew(root: string, rel: string, mkdirs: boolean): Promise<{ parent: string; target: string }> {
  if (!rel) throw new HttpError(400, 'Missing name.');
  const parent = await resolveDir(root, parentRel(rel), mkdirs);
  const target = join(parent, nameOf(rel));
  if (!inside(root, target) || target === root) throw new HttpError(403, 'Outside the docs folder.');
  return { parent, target };
}

// The item at rel itself (a link stays a link, so moving it moves the link), in a real parent inside the root.
async function resolveItem(root: string, rel: string): Promise<{ path: string; real: string; st: Stats }> {
  if (!rel) throw new HttpError(400, 'The docs folder itself cannot be moved or deleted.');
  const parent = await resolveExisting(root, parentRel(rel));
  const path = join(parent, nameOf(rel));
  const st = await fsp.lstat(path);
  const real = await fsp.realpath(path);
  if (!inside(root, real)) throw new HttpError(403, 'Outside the docs folder.');
  return { path, real, st };
}

async function readonlyRoots(ctx: Ctx, root: string): Promise<string[]> {
  const out: string[] = [];
  for (const ro of ctx.readonly) {
    const real = await fsp.realpath(ro).catch(() => resolve(ro));
    if (!inside(real, root)) out.push(real); // root inside it = the owner chose to work there
  }
  return out;
}

async function isReadonly(ctx: Ctx, root: string, real: string): Promise<boolean> {
  return (await readonlyRoots(ctx, root)).some((ro) => inside(ro, real));
}

// Refuse a change at real; for a folder being moved or trashed, also when a read-only folder is inside it.
async function assertWritable(ctx: Ctx, root: string, real: string, holdsChildren = false): Promise<void> {
  const ros = await readonlyRoots(ctx, root);
  if (ros.some((ro) => inside(ro, real) || (holdsChildren && inside(real, ro)))) {
    throw new HttpError(403, 'That folder is read-only in DOCS (PHOSPHOR_DOCS_READONLY in .env).');
  }
}

// ---------------------------------------------------------------- text

export const etagOf = (buf: Buffer) => createHash('sha256').update(buf).digest('base64url').slice(0, 32);

type Decoded = ({ ok: true; text: string } & DocFormat) | { ok: false; why: string };

export function decodeText(buf: Buffer): Decoded {
  let body = buf;
  let bom = false;
  let encoding: DocFormat['encoding'] = 'utf-8';
  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    encoding = 'utf-16le';
    bom = true;
    body = buf.subarray(2, buf.length - (buf.length % 2));
    text = body.toString('utf16le');
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    return { ok: false, why: 'UTF-16 BE text. DOCS edits UTF-8 and UTF-16 LE only.' };
  } else {
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      bom = true;
      body = buf.subarray(3);
    }
    if (body.subarray(0, SNIFF).includes(0)) return { ok: false, why: 'Not a text file.' };
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      return { ok: false, why: 'Not UTF-8 text (an older encoding). Saving here could garble it.' };
    }
  }
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  const eol = crlf > lf ? 'crlf' : 'lf';
  return { ok: true, text: eol === 'crlf' ? text.replaceAll('\r\n', '\n') : text, eol, bom, encoding };
}

export function encodeText(text: string, f: DocFormat): Buffer {
  let t = text.replace(/\r\n?/g, '\n');
  if (f.eol === 'crlf') t = t.replaceAll('\n', '\r\n');
  if (f.encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]);
  const b = Buffer.from(t, 'utf8');
  return f.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) : b;
}

const NEW_FORMAT: DocFormat = { eol: 'lf', bom: false, encoding: 'utf-8' };

function formatOf(body: Record<string, unknown>): DocFormat {
  return {
    eol: body.eol === 'crlf' ? 'crlf' : 'lf',
    bom: body.bom === true,
    encoding: body.encoding === 'utf-16le' ? 'utf-16le' : 'utf-8',
  };
}

function kindOf(name: string, dir: boolean): DocKind {
  if (dir) return 'dir';
  const ext = extname(name).toLowerCase();
  if (TEXT_EXT.has(ext)) return 'text';
  if (OTHER_EXT.has(ext)) return 'other';
  return 'maybe';
}

// Hidden from lists and search: dot files (the trash, temp files, sync databases) and OS clutter.
const hiddenName = (n: string) => n.startsWith('.') || n.startsWith('~$') || n.endsWith('~') || /^(desktop\.ini|thumbs\.db)$/i.test(n);

// ---------------------------------------------------------------- operations

export async function info(ctx: Ctx & { fromEnv?: boolean }): Promise<DocsInfo> {
  const real = await realRootOrNull(ctx);
  return { root: real ?? ctx.root, exists: !!real, fromEnv: !!ctx.fromEnv, readonly: ctx.readonly, maxEdit: MAX_EDIT, sep: sep === '\\' ? '\\' : '/' };
}

export async function list(ctx: Ctx, relIn: unknown): Promise<DocsList> {
  const rel = cleanRel(relIn ?? '');
  const root = await realRootOrNull(ctx);
  if (!root) {
    if (rel) throw new HttpError(404, 'Not found.');
    return { path: '', entries: [], total: 0, missing: true };
  }
  const dir = await resolveExisting(root, rel);
  if (!(await fsp.stat(dir)).isDirectory()) throw new HttpError(400, 'Not a folder.');
  const ros = await readonlyRoots(ctx, root);
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const rows: { d: Dirent; dir: boolean }[] = [];
  await Promise.all(
    dirents.map(async (d) => {
      if (hiddenName(d.name)) return;
      if (!d.isSymbolicLink()) {
        if (d.isDirectory() || d.isFile()) rows.push({ d, dir: d.isDirectory() });
        return;
      }
      // Links and junctions: only those whose target stays inside the root.
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
  const entries: DocEntry[] = await Promise.all(
    rows.slice(0, LIST_CAP).map(async ({ d, dir: isDir }) => {
      const full = join(dir, d.name);
      let size = 0;
      let mtime = 0;
      try {
        const s = await fsp.stat(full);
        size = isDir ? 0 : s.size;
        mtime = s.mtimeMs;
      } catch {
        /* locked or vanished: show it anyway */
      }
      const e: DocEntry = { name: d.name, path: rel ? `${rel}/${d.name}` : d.name, kind: kindOf(d.name, isDir), size, mtime };
      if (isDir && ros.some((ro) => inside(ro, full))) e.readonly = true;
      return e;
    }),
  );
  const out: DocsList = { path: rel, entries, total: rows.length };
  if (ros.some((ro) => inside(ro, dir))) out.readonly = true;
  return out;
}

async function readCapped(file: string, cap: number): Promise<Buffer | null> {
  const fh = await fsp.open(file, 'r');
  try {
    const st = await fh.stat();
    if (st.size > cap) return null;
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

export async function readDoc(ctx: Ctx, relIn: unknown): Promise<DocFile> {
  if (isExt(relIn)) return readOpened(ctx, relIn);
  const rel = cleanRel(relIn);
  const root = await realRoot(ctx);
  const real = await resolveExisting(root, rel);
  return readAt(rel, real, () => isReadonly(ctx, root, real));
}

async function readAt(path: string, real: string, readonly: () => Promise<boolean>): Promise<DocFile> {
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new HttpError(400, 'Not a file.');
  if (kindOf(path, false) === 'other') throw new HttpError(415, "Not a plain text file. Open it in Nextcloud or with the PC's own program.", { kind: 'other' });
  const buf = await readCapped(real, MAX_EDIT);
  if (!buf) throw new HttpError(413, `Too big to edit here (${mb(st.size)}). DOCS edits files up to ${mb(MAX_EDIT)}.`, { size: st.size });
  const d = decodeText(buf);
  if (!d.ok) throw new HttpError(415, `${d.why} Open it in Nextcloud or with the PC's own program.`, { kind: 'other' });
  return { path, text: d.text, eol: d.eol, bom: d.bom, encoding: d.encoding, etag: etagOf(buf), mtime: st.mtimeMs, size: buf.length, readonly: await readonly() };
}

export async function statDoc(ctx: Ctx, relIn: unknown): Promise<DocStat> {
  if (isExt(relIn)) {
    const o = await findOpened(ctx, relIn);
    return statAt(o.path, await checkOpened(o.real));
  }
  const rel = cleanRel(relIn);
  const root = await realRoot(ctx);
  return statAt(rel, await resolveExisting(root, rel));
}

async function statAt(rel: string, real: string): Promise<DocStat> {
  const buf = await readCapped(real, 64 * 1024 * 1024);
  const st = await fsp.stat(real);
  return { path: rel, etag: buf ? etagOf(buf) : `big-${st.size}-${st.mtimeMs}`, mtime: st.mtimeMs, size: st.size };
}

// The disk version for a 409: its etag, and its text when it is still editable text.
async function conflictOf(file: string): Promise<DocConflict['conflict']> {
  let buf: Buffer | null;
  let st: Stats;
  try {
    st = await fsp.stat(file);
    buf = await readCapped(file, MAX_EDIT);
  } catch (e) {
    if (code(e) === 'ENOENT') return { missing: true };
    throw e;
  }
  if (!buf) return { missing: false, etag: `big-${st.size}-${st.mtimeMs}`, mtime: st.mtimeMs, size: st.size };
  const d = decodeText(buf);
  return { missing: false, etag: etagOf(buf), mtime: st.mtimeMs, size: buf.length, ...(d.ok ? { text: d.text } : {}) };
}

const conflict = async (file: string, why: string) => new HttpError(409, why, { conflict: await conflictOf(file) });

// Temp file next to it, then rename over it: a crash never leaves half a file. The "~" ending is on
// Nextcloud's default ignore list, so the temp file is not synced. Some Windows programs lock files
// against replacing; then write in place.
async function atomicWrite(file: string, data: Buffer, mode?: number): Promise<void> {
  const tmp = join(dirname(file), `.${nameOf(file.replaceAll('\\', '/')).slice(0, 80)}.${randomBytes(4).toString('hex')}.phosphor~`);
  await fsp.writeFile(tmp, data, { flag: 'wx' });
  try {
    if (mode !== undefined && !WIN) await fsp.chmod(tmp, mode & 0o7777);
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (code(e) !== 'EPERM' && code(e) !== 'EACCES' && code(e) !== 'EBUSY') throw e;
    await fsp.writeFile(file, data);
  }
}

// The text to write and the etag it was based on (null = the file must not exist yet).
function writeBody(body: Record<string, unknown>): { data: Buffer; etag: string | null } {
  if (typeof body.text !== 'string') throw new HttpError(400, 'Missing text.');
  const etag = body.etag === null ? null : typeof body.etag === 'string' ? body.etag : undefined;
  if (etag === undefined) throw new HttpError(400, 'Missing etag.');
  const data = encodeText(body.text, formatOf(body));
  if (data.length > MAX_EDIT) throw new HttpError(413, `Too big to save here (${mb(data.length)}). DOCS saves files up to ${mb(MAX_EDIT)}.`);
  return { data, etag };
}

export async function writeDoc(ctx: Ctx, body: Record<string, unknown>): Promise<DocStat> {
  if (isExt(body.path)) return writeOpened(ctx, body);
  const rel = cleanRel(body.path);
  if (!rel) throw new HttpError(400, 'Missing name.');
  const { data, etag } = writeBody(body);

  if (etag === null) {
    // Must not exist yet (a new file, or KEEP MINE after the file vanished from disk).
    const root = await ensureRoot(ctx);
    const { parent, target } = await resolveNew(root, rel, true);
    await assertWritable(ctx, root, parent);
    try {
      await fsp.writeFile(target, data, { flag: 'wx' });
    } catch (e) {
      if (code(e) === 'EEXIST') throw await conflict(target, 'A file with that name appeared on disk.');
      throw e;
    }
    return statOf(rel, target, data);
  }

  const root = await realRoot(ctx);
  let real: string;
  try {
    real = await resolveExisting(root, rel);
  } catch (e) {
    if (code(e) === 'ENOENT') throw new HttpError(409, 'The file was moved or deleted on disk.', { conflict: { missing: true } });
    throw e;
  }
  await assertWritable(ctx, root, real);
  return replaceAt(rel, real, data, etag);
}

// Write over the file at real, if it is still the version with that etag.
async function replaceAt(path: string, real: string, data: Buffer, etag: string): Promise<DocStat> {
  const st = await fsp.stat(real);
  if (!st.isFile()) throw new HttpError(400, 'Not a file.');
  const cur = await readCapped(real, 64 * 1024 * 1024);
  const curTag = cur ? etagOf(cur) : `big-${st.size}-${st.mtimeMs}`;
  if (curTag !== etag) throw await conflict(real, 'The file changed on disk since you opened it.');
  await atomicWrite(real, data, st.mode);
  return statOf(path, real, data);
}

async function statOf(rel: string, file: string, data: Buffer): Promise<DocStat> {
  const st = await fsp.stat(file);
  return { path: rel, etag: etagOf(data), mtime: st.mtimeMs, size: data.length };
}

export async function createItem(ctx: Ctx, body: Record<string, unknown>): Promise<DocStat & { kind: DocKind }> {
  const rel = cleanRel(body.path);
  if (!rel) throw new HttpError(400, 'Missing name.');
  const root = await ensureRoot(ctx);
  const { parent, target } = await resolveNew(root, rel, true);
  await assertWritable(ctx, root, parent);
  try {
    if (body.kind === 'folder') {
      await fsp.mkdir(target);
      const st = await fsp.stat(target);
      return { path: rel, etag: '', mtime: st.mtimeMs, size: 0, kind: 'dir' };
    }
    const data = encodeText(typeof body.text === 'string' ? body.text : '', NEW_FORMAT);
    if (data.length > MAX_EDIT) throw new HttpError(413, 'Too big.');
    await fsp.writeFile(target, data, { flag: 'wx' });
    return { ...(await statOf(rel, target, data)), kind: kindOf(rel, false) };
  } catch (e) {
    if (code(e) === 'EEXIST') throw new HttpError(409, 'Something with that name is already there.');
    throw e;
  }
}

export async function moveItem(ctx: Ctx, body: Record<string, unknown>): Promise<{ path: string }> {
  const from = cleanRel(body.from);
  const to = cleanRel(body.to);
  if (!from || !to) throw new HttpError(400, 'Missing name.');
  const root = await realRoot(ctx);
  const src = await resolveItem(root, from);
  await assertWritable(ctx, root, src.real, src.st.isDirectory());
  const { parent, target } = await resolveNew(root, to, true);
  await assertWritable(ctx, root, parent);
  if (src.st.isDirectory() && inside(src.real, parent)) throw new HttpError(400, 'A folder cannot go inside itself.');
  const caseOnly = WIN && fold(src.path) === fold(target) && src.path !== target;
  if (!caseOnly) {
    const there = await fsp.lstat(target).then(
      () => true,
      () => false,
    );
    if (there) throw new HttpError(409, 'Something with that name is already there.');
  }
  await fsp.rename(src.path, target);
  return { path: to };
}

type TrashNote = { path: string; when: number; dir: boolean };

async function trashDir(root: string): Promise<string> {
  const t = join(root, TRASH);
  try {
    await fsp.mkdir(t);
  } catch (e) {
    if (code(e) !== 'EEXIST') throw e;
  }
  const st = await fsp.lstat(t);
  if (st.isSymbolicLink() || !st.isDirectory() || !inside(root, await fsp.realpath(t))) throw new HttpError(403, 'The trash folder is not a plain folder.');
  return t;
}

// DELETE: never a real delete. The item moves to <root>/.retro-trash/<stamp>/<its path>, with <stamp>.json
// saying where it came from (RESTORE puts it back).
export async function trashItem(ctx: Ctx, body: Record<string, unknown>): Promise<{ id: string }> {
  const rel = cleanRel(body.path);
  const root = await realRoot(ctx);
  const src = await resolveItem(root, rel);
  await assertWritable(ctx, root, src.real, src.st.isDirectory());
  const trash = await trashDir(root);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const dest = join(trash, stamp, ...segs(rel));
  await fsp.mkdir(dirname(dest), { recursive: true }); // new folders under the stamp only
  await fsp.writeFile(join(trash, `${stamp}.json`), JSON.stringify({ path: rel, when: Date.now(), dir: src.st.isDirectory() } satisfies TrashNote));
  await fsp.rename(src.path, dest);
  return { id: stamp };
}

const STAMP = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[0-9a-f]{6}$/;

export async function listTrash(ctx: Ctx): Promise<TrashItem[]> {
  const root = await realRootOrNull(ctx);
  if (!root) return [];
  let names: string[];
  try {
    names = await fsp.readdir(join(root, TRASH));
  } catch {
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith('.json') && STAMP.test(n.slice(0, -5)))
    .map((n) => n.slice(0, -5))
    .sort()
    .reverse()
    .slice(0, TRASH_LIST_CAP);
  const out: TrashItem[] = [];
  for (const id of ids) {
    try {
      const note = JSON.parse(await fsp.readFile(join(root, TRASH, `${id}.json`), 'utf8')) as TrashNote;
      const path = cleanRel(note.path);
      out.push({ id, path, name: nameOf(path), when: Number(note.when) || 0, dir: !!note.dir });
    } catch {
      /* broken note: leave it */
    }
  }
  return out;
}

export async function restoreItem(ctx: Ctx, body: Record<string, unknown>): Promise<{ path: string }> {
  const id = String(body.id ?? '');
  if (!STAMP.test(id)) throw new HttpError(400, 'Unknown trash item.');
  const root = await realRoot(ctx);
  const trash = await trashDir(root);
  const note = JSON.parse(await fsp.readFile(join(trash, `${id}.json`), 'utf8')) as TrashNote;
  const rel = cleanRel(note.path);
  if (!rel) throw new HttpError(400, 'Unknown trash item.');
  const src = join(trash, id, ...segs(rel));
  await fsp.lstat(src);
  if (!inside(trash, await fsp.realpath(src))) throw new HttpError(403, 'Outside the trash.');
  const { parent, target } = await resolveNew(root, rel, true);
  await assertWritable(ctx, root, parent);
  const there = await fsp.lstat(target).then(
    () => true,
    () => false,
  );
  if (there) throw new HttpError(409, `Something is already at ${rel}. Move it first.`);
  await fsp.rename(src, target);
  // Tidy the now-empty stamp folders (rmdir only removes empty ones).
  for (let p = dirname(src); inside(join(trash, id), p); p = dirname(p)) {
    if (!(await fsp.rmdir(p).then(
      () => true,
      () => false,
    )))
      break;
  }
  await fsp.rm(join(trash, `${id}.json`), { force: true });
  return { path: rel };
}

// Search names (every word) and text (the whole phrase) under a folder. Breadth first, so a cut-short search
// still covers the top. Limits: time, entries seen, bytes read, file size, results. Text is read only from
// known text types (TEXT_EXT): reading others could download Nextcloud online-only files.
export async function search(ctx: Ctx, qIn: unknown, relIn: unknown): Promise<DocsSearch> {
  const t0 = Date.now();
  const start = cleanRel(relIn ?? '');
  const q = String(qIn ?? '').trim().slice(0, 200);
  const out: DocsSearch = { q, results: [], truncated: false, ms: 0 };
  if (q.length < 2 || /[\x00-\x1f]/.test(q)) return out;
  const root = await realRootOrNull(ctx);
  if (!root) return out;
  const startDir = await resolveExisting(root, start);
  const words = q.toLowerCase().split(/\s+/);
  const phrase = q.toLowerCase();
  const nameHits: DocsHit[] = [];
  const textHits: DocsHit[] = [];
  let seen = 0;
  let readBytes = 0;
  const full = () => nameHits.length + textHits.length >= SEARCH_RESULTS;
  const over = () => Date.now() - t0 > SEARCH_BUDGET_MS || seen > SEARCH_MAX_ENTRIES;

  let level: { rel: string; abs: string }[] = [{ rel: start, abs: startDir }];
  for (let depth = 0; level.length && !full(); depth++) {
    if (depth > SEARCH_MAX_DEPTH) {
      out.truncated = true;
      break;
    }
    const next: typeof level = [];
    for (const { rel, abs } of level) {
      if (over() || full()) {
        out.truncated = true;
        break;
      }
      let dirents: Dirent[];
      try {
        dirents = await fsp.readdir(abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        seen++;
        if (hiddenName(d.name) || d.isSymbolicLink()) continue; // links could lead outside the root
        const path = rel ? `${rel}/${d.name}` : d.name;
        const isDir = d.isDirectory();
        if (!isDir && !d.isFile()) continue;
        const lower = d.name.toLowerCase();
        const kind = kindOf(d.name, isDir);
        if (words.every((w) => lower.includes(w))) nameHits.push({ path, name: d.name, kind });
        if (isDir) {
          if (!SKIP_DIRS.has(lower)) next.push({ rel: path, abs: join(abs, d.name) });
          continue;
        }
        if (kind !== 'text' || full() || readBytes > SEARCH_MAX_READ) continue;
        try {
          const buf = await readCapped(join(abs, d.name), SEARCH_FILE_CAP);
          if (!buf || buf.subarray(0, 1024).includes(0)) continue;
          readBytes += buf.length;
          const text = buf.toString('utf8');
          const low = text.toLowerCase();
          let at = low.indexOf(phrase);
          let line = 1;
          let counted = 0;
          for (let n = 0; at >= 0 && n < SEARCH_HITS_PER_FILE && !full(); n++) {
            for (let i = text.indexOf('\n', counted); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) {
              line++;
              counted = i + 1;
            }
            const ls = text.lastIndexOf('\n', at - 1) + 1;
            let le = text.indexOf('\n', at);
            if (le < 0) le = text.length;
            const col = at - ls;
            const from = Math.max(ls, at - 60);
            const snippet = (from > ls ? '...' : '') + text.slice(from, Math.min(le, from + 160)).replace(/\s+/g, ' ').trim();
            textHits.push({ path, name: d.name, kind, line, col, snippet });
            at = low.indexOf(phrase, le);
          }
        } catch {
          /* locked or vanished */
        }
        if (over()) break;
      }
    }
    level = next;
  }
  if (full()) out.truncated = true;
  out.results = [...nameHits, ...textHits].slice(0, SEARCH_RESULTS);
  out.ms = Date.now() - t0;
  return out;
}

// ---------------------------------------------------------------- OPEN FILES (outside the root)

// A Markdown or text file opened from the PC (double-clicked in the file manager) is edited where it is; nothing
// is copied into the root. The page names it 'ext:<id>/<file name>' and never sees a path it could change: the
// real path stays here, in ctx.opened (data/docs-open.json, so the list survives a restart).
// Who may add one: only the desktop app on this PC (handleOpenLocal): a direct loopback request (no proxy headers,
// so not through `tailscale serve`) with the key in data/docs-open.key, a file only this user can read. The page
// can list them and take them off the list (that only removes access), never add one.
// Every read and write resolves the path again and needs the same real path (a file swapped for a link is
// refused), a regular file, and one of OPEN_EXT.
const OPEN_EXT = new Set(['.md', '.markdown', '.mdown', '.txt']);
const OPEN_MAX = 50;
const EXT_PATH = /^ext:([A-Za-z0-9_-]{22})(?:\/|$)/;
export const LOCAL_KEY = join(DATA_DIR, 'docs-open.key');
type Opened = { id: string; real: string };
const openedCache = new Map<string, Opened[]>();
let openedSaving: Promise<void> = Promise.resolve();

export const isExt = (p: unknown): p is string => typeof p === 'string' && p.startsWith('ext:');
const openedPath = (o: Opened) => `ext:${o.id}/${basename(o.real)}`;
const openedId = (real: string) => createHash('sha256').update(real).digest('base64url').slice(0, 22);
const tilde = (p: string) => (inside(homedir(), p) ? `~${p.slice(homedir().length)}` : p);

async function openedList(ctx: Ctx): Promise<Opened[]> {
  if (!ctx.opened) return [];
  const cached = openedCache.get(ctx.opened);
  if (cached) return cached;
  let list: Opened[] = [];
  try {
    const v: unknown = JSON.parse(await fsp.readFile(ctx.opened, 'utf8'));
    if (Array.isArray(v)) list = v.filter((o): o is Opened => typeof o?.id === 'string' && typeof o?.real === 'string' && isAbsolute(o.real) && o.id === openedId(o.real));
  } catch (e) {
    if (code(e) !== 'ENOENT') console.warn('docs: OPEN FILES list unreadable, starting empty:', e);
  }
  openedCache.set(ctx.opened, list);
  return list;
}

// One write at a time, always the newest list.
function saveOpened(ctx: Ctx, list: Opened[]): Promise<void> {
  const file = ctx.opened!;
  openedCache.set(file, list);
  openedSaving = openedSaving.catch(() => {}).then(() => atomicWrite(file, Buffer.from(JSON.stringify(openedCache.get(file)))));
  return openedSaving;
}

async function findOpened(ctx: Ctx, p: string): Promise<Opened & { path: string }> {
  const m = EXT_PATH.exec(p);
  const o = m && (await openedList(ctx)).find((x) => x.id === m[1]);
  if (!o) throw new HttpError(404, 'Not in OPEN FILES any more. Open it again from the PC.');
  return { ...o, path: openedPath(o) };
}

// The file must still be at the real path it was added with: a regular file of an allowed type.
async function checkOpened(real: string): Promise<string> {
  if ((await fsp.realpath(real)) !== real) throw new HttpError(403, 'That file is now a link to somewhere else. Open it again from the PC.');
  if (!OPEN_EXT.has(extname(real).toLowerCase())) throw new HttpError(415, 'DOCS opens only .md, .markdown, .mdown and .txt files from outside its folder.');
  if (!(await fsp.lstat(real)).isFile()) throw new HttpError(400, 'Not a file.');
  return real;
}

const openedReadonly = async (ctx: Ctx, real: string) => {
  const root = (await realRootOrNull(ctx)) ?? ctx.root;
  return (await readonlyRoots(ctx, root)).some((ro) => inside(ro, real));
};

// Add a file to OPEN FILES (desktop app only: handleOpenLocal). Returns the path the page opens: a normal docs
// path when the file is inside the root anyway.
export async function addOpened(ctx: Ctx, input: unknown): Promise<{ path: string }> {
  if (typeof input !== 'string' || !isAbsolute(input) || input.length > 4096 || /[\x00]/.test(input)) throw new HttpError(400, 'Send the full path of a file.');
  if (!ctx.opened) throw new HttpError(404, 'OPEN FILES is off.');
  const real = await fsp.realpath(input);
  await checkOpened(real);
  const root = await realRootOrNull(ctx);
  if (root && inside(root, real)) {
    try {
      return { path: cleanRel(relative(root, real).split(sep).join('/')) };
    } catch {
      /* a name DOCS would not list (trash, .git): open it as an outside file */
    }
  }
  const o: Opened = { id: openedId(real), real };
  await saveOpened(ctx, [o, ...(await openedList(ctx)).filter((x) => x.id !== o.id)].slice(0, OPEN_MAX));
  return { path: openedPath(o) };
}

export async function listOpened(ctx: Ctx): Promise<OpenFile[]> {
  return (await openedList(ctx)).map((o) => ({ path: openedPath(o), name: basename(o.real), folder: tilde(dirname(o.real)) }));
}

// Take a file off the list (the file itself is not touched).
export async function removeOpened(ctx: Ctx, body: Record<string, unknown>): Promise<{ ok: true }> {
  const m = typeof body.path === 'string' ? EXT_PATH.exec(body.path) : null;
  if (!m) throw new HttpError(400, 'Not an OPEN FILES path.');
  const list = await openedList(ctx);
  if (list.some((o) => o.id === m[1])) await saveOpened(ctx, list.filter((o) => o.id !== m[1]));
  return { ok: true };
}

async function readOpened(ctx: Ctx, p: string): Promise<DocFile> {
  const o = await findOpened(ctx, p);
  const real = await checkOpened(o.real);
  return { ...(await readAt(o.path, real, () => openedReadonly(ctx, real))), abs: real };
}

async function writeOpened(ctx: Ctx, body: Record<string, unknown>): Promise<DocStat> {
  const o = await findOpened(ctx, body.path as string);
  const { data, etag } = writeBody(body);
  if (await openedReadonly(ctx, o.real)) throw new HttpError(403, 'That folder is read-only in DOCS (PHOSPHOR_DOCS_READONLY in .env).');
  if (etag === null) {
    // Gone from disk and saved again (KEEP MINE): only at the same place, in the same real folder.
    if ((await fsp.realpath(dirname(o.real))) !== dirname(o.real)) throw new HttpError(403, 'That folder is now a link to somewhere else.');
    try {
      await fsp.writeFile(o.real, data, { flag: 'wx' });
    } catch (e) {
      if (code(e) !== 'EEXIST') throw e;
      await checkOpened(o.real); // a link there: refused, its target never goes to the page
      throw await conflict(o.real, 'A file with that name appeared on disk.');
    }
    return statOf(o.path, o.real, data);
  }
  let real: string;
  try {
    real = await checkOpened(o.real);
  } catch (e) {
    if (code(e) === 'ENOENT') throw new HttpError(409, 'The file was moved or deleted on disk.', { conflict: { missing: true } });
    throw e;
  }
  return replaceAt(o.path, real, data, etag);
}

// The key the desktop app sends with POST /api/docs/open-local. Made at server start, readable by this user only.
export async function localKey(file = LOCAL_KEY): Promise<string> {
  try {
    return (await fsp.readFile(file, 'utf8')).trim();
  } catch (e) {
    if (code(e) !== 'ENOENT') throw e;
  }
  try {
    await fsp.writeFile(file, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (code(e) !== 'EEXIST') throw e;
  }
  return (await fsp.readFile(file, 'utf8')).trim();
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// POST /api/docs/open-local {path}: the desktop app (shell/main.mjs) opens a file from the PC. Not behind the login
// cookie: the app's main process has none. Instead: loopback, no proxy headers, and the key file's content.
export async function handleOpenLocal(req: IncomingMessage, res: ServerResponse, ctx: Ctx = docsConfig(), keyFile = LOCAL_KEY): Promise<void> {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    const h = req.headers;
    const proxied = !!(h['x-forwarded-for'] || h.forwarded || h.via || Object.keys(h).some((k) => k.startsWith('tailscale-')));
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '') || proxied) throw new HttpError(403, 'Only the desktop app on this PC can open files.');
    const sent = Buffer.from(String(h['x-phosphor-key'] ?? ''));
    const key = Buffer.from(await localKey(keyFile));
    if (key.length < 32 || sent.length !== key.length || !timingSafeEqual(sent, key)) throw new HttpError(403, 'Only the desktop app on this PC can open files.');
    if (!/^application\/json\b/i.test(h['content-type'] ?? '')) throw new HttpError(415, 'Send JSON.');
    sendJson(res, await addOpened(ctx, (await readJson(req)).path));
  } catch (e) {
    sendError(res, e);
  }
}

// ---------------------------------------------------------------- HTTP

export async function handleDocs(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const action = url.pathname.slice('/api/docs/'.length);
    const ctx = docsConfig();
    const q = url.searchParams;
    if (req.method === 'GET') {
      if (action === 'info') return sendJson(res, await info(ctx));
      if (action === 'list') return sendJson(res, await list(ctx, q.get('path') ?? ''));
      if (action === 'read') return sendJson(res, await readDoc(ctx, q.get('path')));
      if (action === 'stat') return sendJson(res, await statDoc(ctx, q.get('path')));
      if (action === 'search') return sendJson(res, await search(ctx, q.get('q'), q.get('path') ?? ''));
      if (action === 'trash') return sendJson(res, await listTrash(ctx));
      if (action === 'opened') return sendJson(res, await listOpened(ctx));
      throw new HttpError(404, 'not found');
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    // JSON only: a plain cross-site form cannot send it (the cookie is SameSite=Lax as well).
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send JSON.');
    const body = await readJson(req);
    if (action === 'write') return sendJson(res, await writeDoc(ctx, body));
    if (action === 'create') return sendJson(res, await createItem(ctx, body));
    if (action === 'move') return sendJson(res, await moveItem(ctx, body));
    if (action === 'delete') return sendJson(res, await trashItem(ctx, body));
    if (action === 'restore') return sendJson(res, await restoreItem(ctx, body));
    if (action === 'unopen') return sendJson(res, await removeOpened(ctx, body));
    throw new HttpError(404, 'not found');
  } catch (e) {
    sendError(res, e);
  }
}

function sendError(res: ServerResponse, e: unknown): void {
  if (res.headersSent) return void res.destroy();
  const [status, error, extra] = toHttp(e);
  if (status >= 500) console.warn('docs api:', e);
  sendJson(res, { error, ...extra }, status);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Too big.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolveBody(v as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'Bad JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(data));
}

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

function toHttp(e: unknown): [number, string, Record<string, unknown>] {
  if (e instanceof HttpError) return [e.status, e.message, e.extra ?? {}];
  const c = code(e);
  if (c === 'ENOENT' || c === 'ENOTDIR') return [404, 'Not found.', {}];
  if (c === 'EACCES' || c === 'EPERM') return [403, 'The PC would not let DOCS do that (no permission, or the file is open in another program).', {}];
  if (c === 'EBUSY') return [423, 'That file is locked by another program.', {}];
  if (c === 'EISDIR') return [400, 'Not a file.', {}];
  if (c === 'ENAMETOOLONG') return [400, 'Name or path too long.', {}];
  if (c === 'EEXIST') return [409, 'Something with that name is already there.', {}];
  return [500, e instanceof Error ? e.message : String(e), {}];
}
