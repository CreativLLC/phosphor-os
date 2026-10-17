import { readdirSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claude Code's saved chats: ~/.claude/projects/<folder>/<sessionId>.jsonl, one JSON object per line.
// HISTORY reads them directly for what the SDK does not give: where a chat was started (entrypoint) and the
// chat's text for search.

// Chats started in this app (the Agent SDK for TypeScript). Others: cli, claude-vscode, claude-desktop.
export const APP_ENTRYPOINT = 'sdk-ts';
export const ATTACH_HEADER = 'Attached files (saved on this PC; images are also shown inline):';

export const projectsDir = (): string => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

// sessionId -> transcript path, across all project folders (a chat is saved under the folder it started in).
export function transcriptPaths(root = projectsDir()): Map<string, string> {
  const out = new Map<string, string>();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, d));
    } catch {
      continue; // a file, or unreadable
    }
    for (const f of files) if (f.endsWith('.jsonl')) out.set(f.slice(0, -6), join(root, d, f));
  }
  return out;
}

// ------------------------------------------------------------ entrypoint

// Where the chat was started, from the first line that says. Usually in the first few KB, but a chat can open
// with long queue lines, so read on in chunks (up to 8 MB: very old chats have none). It never changes, so a
// found one is kept for good.
const ENTRY_KEY = Buffer.from('"entrypoint":"');
const entrypoints = new Map<string, { value?: string; size: number }>();

export async function entrypointOf(path: string): Promise<string | undefined> {
  const known = entrypoints.get(path);
  if (known?.value) return known.value;
  let size = 0;
  try {
    size = (await stat(path)).size;
  } catch {
    return undefined;
  }
  if (known && known.size === size) return undefined; // read before, not there, file unchanged
  const value = await scanEntrypoint(path);
  entrypoints.set(path, { value, size });
  return value;
}

async function scanEntrypoint(path: string): Promise<string | undefined> {
  const CHUNK = 64 * 1024;
  const fh = await open(path, 'r').catch(() => undefined);
  if (!fh) return undefined;
  try {
    let carry = Buffer.alloc(0);
    for (let pos = 0; pos < 8 * 1024 * 1024; pos += CHUNK) {
      const buf = Buffer.alloc(CHUNK);
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) return undefined;
      const hay = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      const at = hay.indexOf(ENTRY_KEY);
      if (at >= 0) {
        const end = hay.indexOf(0x22, at + ENTRY_KEY.length); // closing quote
        if (end >= 0) return hay.toString('utf8', at + ENTRY_KEY.length, end);
      }
      carry = hay.subarray(Math.max(0, hay.length - 64)); // a key split across two chunks
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

// ------------------------------------------------------------ search text

// Remove harness wrappers from saved user text; keep what the person typed.
export function cleanUserText(text: string): string {
  return text
    .replace(/<(system-reminder|task-notification|local-command-stdout|local-command-stderr|command-message|command-args)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .replace(/^\[Note from the (?:Phosphor-OS|Retro Claude) app:[\s\S]*?\]\s*/, '') // Retro Claude: chats from before the rename
    .trim();
}

// What the person and Claude wrote, from transcript lines: user and assistant text only. Not tool calls or
// results, thinking, helper-agent lines, compaction summaries or notes the harness adds.
export function chatText(jsonl: string): string[] {
  const out: string[] = [];
  for (const line of jsonl.split('\n')) {
    // Cheap test first: most lines (tool output, metadata) are skipped without parsing.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let o: { type?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta || o.isCompactSummary) continue;
    const c = o.message?.content;
    const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text as string) : [];
    for (let t of parts) {
      if (o.type === 'user') {
        t = cleanUserText(t);
        const at = t.indexOf(ATTACH_HEADER);
        if (at >= 0) t = t.slice(0, at).trim();
        if (t.startsWith('[Request interrupted by user')) continue;
      } else t = t.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

// The words to look for: lower case, each counted once, at most 8.
export function queryWords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Where the first matched word sits, or -1 unless every word is somewhere in the text (any case).
export function matchAt(text: string, words: string[]): number {
  if (!words.length) return -1;
  let first = Infinity;
  for (const w of words) {
    const m = new RegExp(escapeRe(w), 'iu').exec(text);
    if (!m) return -1;
    first = Math.min(first, m.index);
  }
  return first;
}

// About `len` characters of plain text around a hit, on one line, cut at word edges.
export function snippet(text: string, at: number, len = 120): string {
  const lead = Math.round(len / 3);
  let start = Math.max(0, at - lead);
  let end = Math.min(text.length, start + len);
  start = Math.max(0, Math.min(start, end - len));
  if (start > 0) {
    const sp = text.slice(start, at).search(/\s/);
    if (sp >= 0) start += sp + 1;
  }
  if (end < text.length) {
    const sp = text.slice(at, end).search(/\s\S*$/);
    if (sp > 0) end = at + sp;
  }
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

// Extracted text per transcript, in memory. A chat file only grows, so a bigger file is read from where the
// last read stopped. Capped per chat and overall (least recently used goes first).
const PER_CHAT = 2_000_000; // characters
const TOTAL = 48_000_000;
type Cached = { size: number; mtime: number; offset: number; text: string };
const texts = new Map<string, Cached>();
let cachedChars = 0;

export async function textOf(path: string): Promise<string> {
  let st;
  try {
    st = await stat(path);
  } catch {
    return '';
  }
  let c = texts.get(path);
  if (c && c.size === st.size && c.mtime === st.mtimeMs) {
    texts.delete(path); // move to the newest end
    texts.set(path, c);
    return c.text;
  }
  if (!c || st.size < c.size) c = { size: 0, mtime: 0, offset: 0, text: '' }; // new, or rewritten: read it all
  texts.delete(path);
  cachedChars -= c.text.length;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(st.size - c.offset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, c.offset);
    const done = buf.lastIndexOf(0x0a, bytesRead - 1) + 1; // a half-written last line waits for next time
    if (c.text.length < PER_CHAT) {
      const add = chatText(buf.toString('utf8', 0, done)).join('\n');
      if (add) c.text = (c.text ? `${c.text}\n${add}` : add).slice(0, PER_CHAT);
    }
    c.offset += done;
  } finally {
    await fh.close();
  }
  c.size = st.size;
  c.mtime = st.mtimeMs;
  texts.set(path, c);
  cachedChars += c.text.length;
  for (const [p, old] of texts) {
    if (cachedChars <= TOTAL || p === path) break;
    texts.delete(p);
    cachedChars -= old.text.length;
  }
  return c.text;
}
