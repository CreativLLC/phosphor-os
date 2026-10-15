import { Node as TNode, type AnyExtension, type JSONContent } from '@tiptap/core';
import { HardBreak } from '@tiptap/extension-hard-break';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { Underline } from '@tiptap/extension-underline';
import { MarkdownManager } from '@tiptap/markdown';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Marked } from 'marked';

// DOCS' Markdown bridge for the WYSIWYG editor (docs-editor.ts). No DOM: tests/docs-roundtrip.ts runs it in node.
// The file is the truth, so nothing the owner did not touch may change:
// - The file is cut into top-level blocks (marked's tokens). Each block remembers its own source text.
// - Saving writes an untouched block's source back byte for byte, and the blank lines around it. Only blocks
//   the owner changed are written fresh (TipTap's serializer), so a diff shows just the edit.
// - A block the editor cannot carry exactly (raw HTML, footnotes, front matter...) becomes a grey RAW box that
//   is kept as it is; it is changed in SOURCE. "Exactly" = it renders to the same HTML before and after a
//   parse and write.
// - Files that cannot be cut cleanly (reference links, text marked does not give back) open in SOURCE.
// Line breaks: a single newline is a line break in DOCS (as in the old preview and Obsidian), so the editor's
// line break (Shift+Enter) is written as a plain newline.

// A block kept as its Markdown source: shown, never changed in DOC view. label: PROPERTIES (front matter) or MARKDOWN.
export const RawBlock = TNode.create({
  name: 'rawBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { src: { default: '' }, label: { default: 'MARKDOWN' } };
  },
  parseHTML() {
    return [{ tag: 'div[data-raw-md]', getAttrs: (el) => ({ src: (el as HTMLElement).dataset.src ?? '', label: (el as HTMLElement).dataset.label ?? 'MARKDOWN' }) }];
  },
  renderHTML({ node }) {
    const src = String(node.attrs.src);
    return ['div', { class: 'dc-raw', 'data-raw-md': '', 'data-src': src, 'data-label': String(node.attrs.label), title: 'Kept exactly as written. Change it in SOURCE (double-click).' }, ['pre', {}, src]];
  },
  renderMarkdown: (node) => String(node.attrs?.src ?? ''),
});

const LineBreak = HardBreak.extend({ renderMarkdown: () => '\n' });

// Markdown has no underline: it is written as inline HTML, <u>text</u>, which Obsidian, GitHub and agents read.
// (TipTap's own ++text++ is not Markdown anywhere else.) Ctrl+U is the extension's own key.
const U = /^<u>([\s\S]+?)<\/u>/;
const UnderlineTag = Underline.extend({
  renderMarkdown: (node, h) => `<u>${h.renderChildren(node)}</u>`,
  markdownTokenizer: {
    name: 'underline',
    level: 'inline',
    start: (src) => src.indexOf('<u>'),
    tokenize(src, _tokens, lexer) {
      const m = U.exec(src);
      return m ? { type: 'underline', raw: m[0], text: m[1], tokens: lexer.inlineTokens(m[1]) } : undefined;
    },
  },
});

// The editor's parts: the same list for the page and the test, so both read and write the same way.
export function mdExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      underline: false, // UnderlineTag below
      hardBreak: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
    }),
    LineBreak,
    UnderlineTag,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    RawBlock,
  ];
}

let mgr: MarkdownManager | null = null;
// One manager for the page: it registers its tokenizers on marked once.
export function manager(): MarkdownManager {
  mgr ??= new MarkdownManager({ extensions: mdExtensions(), markedOptions: { gfm: true, breaks: true } });
  return mgr;
}

// The meaning check: the same HTML from the same renderer (breaks on, as DOCS shows files).
const ref = new Marked({ gfm: true, breaks: true });
const html = (md: string) => (ref.parse(md, { async: false }) as string).replace(/>\s+</g, '><').trim();

export type Block = { raw: string; start: number; nodes: JSONContent[]; gap: string; raw_kept: boolean };
export type Loaded =
  | { ok: true; text: string; lead: string; blocks: Block[]; doc: JSONContent; kept: number; why: string[] }
  | { ok: false; why: string };

const FRONT = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?=\n|$)/;
const isEmptyPara = (n: { type: { name: string }; childCount: number }) => n.type.name === 'paragraph' && n.childCount === 0;

export function load(text: string): Loaded {
  const m = manager();
  const blocks: Block[] = [];
  const why = new Set<string>();
  let lead = '';
  let at = 0;
  const front = FRONT.exec(text);
  if (front) {
    blocks.push({ raw: front[0], start: 0, nodes: [{ type: 'rawBlock', attrs: { src: front[0], label: 'PROPERTIES' } }], gap: '', raw_kept: true });
    why.add('front matter');
    at = front[0].length;
  }
  const rest = text.slice(at);
  let tokens: { type: string; raw: string }[];
  try {
    tokens = m.instance.lexer(rest) as unknown as { type: string; raw: string }[];
  } catch (e) {
    return { ok: false, why: `could not be read as Markdown (${e instanceof Error ? e.message : e})` };
  }
  if (tokens.map((t) => t.raw).join('') !== rest) return { ok: false, why: 'has parts that do not read back exactly as written' };
  const gapAdd = (s: string) => {
    if (blocks.length) blocks[blocks.length - 1].gap += s;
    else lead += s;
  };
  for (const t of tokens) {
    if (t.type === 'def') return { ok: false, why: 'uses reference links ([text][name])' };
    if (t.type === 'space') {
      gapAdd(t.raw);
      continue;
    }
    const tail = /\n*$/.exec(t.raw)![0];
    blocks.push({ raw: t.raw.slice(0, t.raw.length - tail.length), start: 0, nodes: [], gap: tail, raw_kept: false });
  }
  // Offsets (for "open at line"), then each block's nodes.
  let pos = lead.length;
  for (const b of blocks) {
    b.start = pos;
    pos += b.raw.length + b.gap.length;
    if (b.raw_kept) continue;
    const r = blockNodes(b.raw);
    b.nodes = r.nodes;
    if (r.why) {
      b.raw_kept = true;
      why.add(r.why);
    }
  }
  const content = blocks.flatMap((b) => b.nodes);
  return {
    ok: true,
    text,
    lead,
    blocks,
    doc: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] },
    kept: blocks.filter((b) => b.raw_kept).length,
    why: [...why],
  };
}

// One block's nodes, or a RAW box when the editor would change what it means.
function blockNodes(raw: string): { nodes: JSONContent[]; why?: string } {
  const keep = (why: string) => ({ nodes: [{ type: 'rawBlock', attrs: { src: raw, label: 'MARKDOWN' } }], why });
  let nodes: JSONContent[];
  let back: string;
  try {
    nodes = manager().parse(raw).content ?? [];
    back = writeNodes(nodes);
  } catch {
    return keep('Markdown the editor cannot read');
  }
  if (!nodes.length) return keep('Markdown the editor cannot show');
  if (back === raw) return { nodes };
  if (html(back) === html(raw)) return { nodes };
  return keep(/<[a-z!/]/i.test(raw) ? 'HTML' : 'Markdown the editor cannot show');
}

function writeNodes(nodes: JSONContent[]): string {
  return manager().serialize({ type: 'doc', content: nodes }).replace(/^\n+|\n+$/g, '');
}

// A changed block, written fresh. Cached per node: unchanged nodes keep their object between edits.
const written = new WeakMap<PMNode, string>();
function writeNode(n: PMNode): string {
  let md = written.get(n);
  if (md === undefined) {
    md = tidy(writeNodes([n.toJSON() as JSONContent]));
    written.set(n, md);
  }
  return md;
}

// The serializer plays safe: \[\[Page\]\], snake\_case, &amp;, [https://x](https://x). Agents and Obsidian
// read the plain form better ([[Page]] stays a wiki link), so each escape is dropped where the block still
// renders to the same HTML without it.
function tidy(md: string): string {
  const want = html(md);
  const same = (t: string) => t !== md && html(t) === want;
  const drop = (re: RegExp, to: (m: string) => string) => {
    const all = md.replace(re, to);
    if (all === md || same(all)) return void (md = all);
    const spots = [...md.matchAll(re)].reverse().slice(0, 100);
    for (const m of spots) {
      const t = md.slice(0, m.index) + to(m[0]) + md.slice(m.index + m[0].length);
      if (same(t)) md = t;
    }
  };
  drop(/\\[!-/:-@[-`{-~]/g, (m) => m[1]);
  drop(/&(?:amp|lt|gt|quot|#39);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m]!);
  drop(/\[(https?:\/\/[^\]\s]+)\]\(\1\)/g, (m) => m.slice(1, m.indexOf(']')));
  return md;
}

// Writes the editor's document as Markdown, keeping untouched blocks as they were in the file.
export class Keeper {
  private readonly loaded: Extract<Loaded, { ok: true }>;
  private readonly orig: PMNode[][];
  private readonly byKey = new Map<string, number[]>();

  // doc: the document as the editor first showed it (its own node objects make the unchanged check instant).
  constructor(loaded: Extract<Loaded, { ok: true }>, schema: Schema, doc?: PMNode) {
    this.loaded = loaded;
    const kids: PMNode[] = [];
    doc?.forEach((n) => kids.push(n));
    let i = 0;
    this.orig = loaded.blocks.map((b) =>
      b.nodes.map((j) => {
        const want = schema.nodeFromJSON(j);
        const have = kids[i++];
        return have && have.eq(want) ? have : want;
      }),
    );
    this.orig.forEach((ns, bi) => {
      if (!ns.length) return;
      const k = key(ns[0]);
      const list = this.byKey.get(k);
      if (list) list.push(bi);
      else this.byKey.set(k, [bi]);
    });
  }

  // Block index whose nodes sit at kids[i..], or -1.
  private match(kids: PMNode[], i: number, prev: number): number {
    const fits = (bi: number) => {
      const ns = this.orig[bi];
      if (!ns?.length || i + ns.length > kids.length) return false;
      return ns.every((n, k) => kids[i + k] === n || kids[i + k].eq(n));
    };
    if (fits(prev + 1)) return prev + 1;
    for (const bi of this.byKey.get(key(kids[i])) ?? []) if (fits(bi)) return bi;
    return -1;
  }

  serialize(doc: PMNode): string {
    const kids: PMNode[] = [];
    doc.forEach((n) => kids.push(n));
    const pieces: ({ block: number } | { text: string })[] = [];
    let fresh: PMNode[] = [];
    let prev = -1;
    const flush = () => {
      const run = fresh.filter((n) => !isEmptyPara(n));
      fresh = [];
      if (run.length) pieces.push({ text: run.map(writeNode).join('\n\n') });
    };
    for (let i = 0; i < kids.length; ) {
      const b = this.match(kids, i, prev);
      if (b < 0) {
        fresh.push(kids[i++]);
        continue;
      }
      flush();
      pieces.push({ block: b });
      prev = b;
      i += this.orig[b].length;
    }
    flush();
    const { blocks, lead } = this.loaded;
    if (!pieces.length) return blocks.length ? '' : lead; // a file of blank lines stays as it was
    let out = '';
    pieces.forEach((p, k) => {
      const next = pieces[k + 1];
      if ('block' in p) {
        if (k === 0 && p.block === 0) out += lead;
        out += blocks[p.block].raw;
        if (next) out += 'block' in next && next.block === p.block + 1 ? blocks[p.block].gap : '\n\n';
        else out += p.block === blocks.length - 1 ? blocks[p.block].gap : '\n';
      } else {
        out += p.text;
        out += next ? '\n\n' : '\n';
      }
    });
    return out;
  }

  // Where block bi starts in the editor's first document (for "open at line").
  blockAtOffset(offset: number): number {
    const bs = this.loaded.blocks;
    let found = -1;
    for (let i = 0; i < bs.length; i++) if (bs[i].start <= offset) found = i;
    return found;
  }

  nodesBefore(bi: number): number {
    let n = 0;
    for (let i = 0; i < bi; i++) n += this.orig[i].length;
    return n;
  }
}

const key = (n: PMNode) => `${n.type.name}:${n.childCount}:${n.textContent.slice(0, 40)}`;
