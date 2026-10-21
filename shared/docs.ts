// DOCS: the document program's REST shapes (server/docs.ts <-> web/src/docs.ts). Types only.
// All paths are relative to the docs root, '/'-joined, except OPEN FILES: 'ext:<id>/<file name>'. Routes (login needed):
//   GET  /api/docs/info | list?path= | read?path= | stat?path= | search?q=&path= | trash | opened
//   POST /api/docs/write | create | move | delete | restore | unopen   (JSON body, Content-Type: application/json)
// read, stat and write take OPEN FILES paths too. Adding one: POST /api/docs/open-local, the desktop app only (no login,
// a key file instead; server/docs.ts).

// text: edit here. maybe: no known type, opened if it sniffs as text. other: office files, images, PDFs...
export type DocKind = 'dir' | 'text' | 'maybe' | 'other';

export type DocEntry = { name: string; path: string; kind: DocKind; size: number; mtime: number; readonly?: boolean };

export type DocsInfo = {
  root: string; // absolute, as the server sees it
  exists: boolean; // false until the first save makes it
  fromEnv: boolean; // PHOSPHOR_DOCS_DIR is set
  readonly: string[]; // absolute folders DOCS shows but never changes
  maxEdit: number; // bytes
  sep: '/' | '\\';
};

export type DocsList = { path: string; entries: DocEntry[]; total: number; missing?: boolean; readonly?: boolean };

export type DocFormat = { eol: 'lf' | 'crlf'; bom: boolean; encoding: 'utf-8' | 'utf-16le' };

// text uses '\n' only; the server writes the file's own line ends (eol) back.
// abs: the file's place on the PC, for OPEN FILES only.
export type DocFile = DocFormat & { path: string; text: string; etag: string; mtime: number; size: number; readonly: boolean; abs?: string };

export type DocStat = { path: string; etag: string; mtime: number; size: number };

// write: etag = the version the page last read or saved; null = the file must not exist yet.
export type DocWrite = Partial<DocFormat> & { path: string; text: string; etag: string | null };

// 409 answer to a write: the file on disk is not the version the page had.
export type DocConflict = {
  error: string;
  conflict: { missing: true } | { missing: false; etag: string; mtime: number; size: number; text?: string };
};

export type DocsHit = { path: string; name: string; kind: DocKind; line?: number; col?: number; snippet?: string };
export type DocsSearch = { q: string; results: DocsHit[]; truncated: boolean; ms: number };

export type TrashItem = { id: string; path: string; name: string; when: number; dir: boolean };

// OPEN FILES: a file outside the docs folder, opened from the PC and edited where it is. folder: '~' for home.
export type OpenFile = { path: string; name: string; folder: string };
