// DOCS: the rules for moving and renaming files in the list, as plain functions (docs.ts uses them; tested in
// tests/docs-move.ts). Paths are relative to the docs root, '/'-joined, like everywhere in DOCS.

const MAX_NAME = 100;
// Names Windows keeps for itself (the folder syncs to Windows PCs); the server refuses them too.
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i;
// The names NEW gives a document before the owner names it (TEMPLATES in docs.ts), "Note 2026-10-12 2" too.
const DEFAULT_NAME = /^(?:Untitled|(?:Note|Letter|List) \d{4}-\d{2}-\d{2})(?: \d+)?$/;

export const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
export const isMd = (path: string) => /\.(md|markdown|mdown)$/i.test(path);

// The document's title: its first line when that is a Markdown heading "# Title". '' = no title.
export function titleOf(text: string): string {
  const first = text.split('\n', 1)[0].replace(/\r$/, '');
  const m = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(first);
  return m ? m[1] : '';
}

// A title as a file name (without the extension) that works on Linux and on Windows (Nextcloud): Markdown marks
// and the characters Windows refuses go, spaces collapse, at most MAX_NAME letters. '' = no usable name.
export function nameFromTitle(title: string): string {
  let s = title
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](link) -> text
    .replace(/[*`]|\\(?=[^\s])/g, '') // bold, italic, code, escapes
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, ''); // no hidden file, no trailing dot or space (Windows)
  const letters = Array.from(s);
  if (letters.length > MAX_NAME) s = letters.slice(0, MAX_NAME).join('').replace(/[\s.]+$/, '');
  return DEVICE.test(s) ? '' : s;
}

export const isDefaultName = (base: string) => DEFAULT_NAME.test(base);

// Title -> file name: the path the document should move to after a save, or null to leave it. Only when the title
// changed since oldTitle (the title at the last check), and only while the name follows the title: the file is
// named after oldTitle (cleaned the same way), or it still has the name NEW gave it. A file named on purpose
// (README.md with "# Something") keeps its name.
export function titleRename(path: string, oldTitle: string, text: string): string | null {
  if (!isMd(path)) return null;
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  const base = name.slice(0, dot);
  const next = nameFromTitle(titleOf(text));
  const old = nameFromTitle(oldTitle);
  if (!next || next === base || next === old) return null;
  if (old !== base && !isDefaultName(base)) return null;
  const dir = parentOf(path);
  return `${dir ? `${dir}/` : ''}${next}${name.slice(dot)}`;
}

// Dragging an item onto a folder in the list. '' = the top folder.
export type DropItem = { path: string; dir: boolean; readonly: boolean };
export type DropFolder = { path: string; readonly: boolean; names?: string[] }; // names: what is in it, when known

// Why the drop is refused ('' = fine), or null when it would change nothing (dropped where it already is).
export function dropProblem(item: DropItem, folder: DropFolder): string | null {
  const to = folder.path;
  if (parentOf(item.path) === to || item.path === to) return null;
  if (item.dir && to.startsWith(`${item.path}/`)) return 'A folder cannot go inside itself.';
  if (item.readonly) return `${nameOf(item.path)} is read-only in DOCS.`;
  if (folder.readonly) return `${to ? nameOf(to) : 'That folder'} is read-only in DOCS.`;
  const name = nameOf(item.path).toLowerCase();
  if (folder.names?.some((n) => n.toLowerCase() === name)) return `${to ? nameOf(to) : 'The top folder'} already has something called ${nameOf(item.path)}.`;
  return '';
}

// Where the item lands when dropped into folder.
export const dropTarget = (item: string, folder: string) => (folder ? `${folder}/${nameOf(item)}` : nameOf(item));

// A path after the item at from moved to to (the item itself, or something inside a moved folder); else unchanged.
export const movedPath = (path: string, from: string, to: string) => (path === from || path.startsWith(`${from}/`) ? to + path.slice(from.length) : path);
