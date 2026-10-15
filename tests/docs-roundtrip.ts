// DOCS round trip: the WYSIWYG editor's Markdown bridge (web/src/mdkeep.ts) over the sample files in
// tests/fixtures/docs. Headless, no browser, nothing outside this folder.
//   npm run test:docs        (= npx tsx tests/docs-roundtrip.ts)
// Checks, for every sample:
//   1. Opened and saved untouched: byte for byte the same.
//   2. One paragraph edited: only that block changes; the rest of the file keeps its bytes.
//   3. Saved again after reopening: no further change (stable).
// Plus: ticking a checkbox, adding a reminder at the end, deleting a block, underline as <u>text</u>, RAW boxes
// for HTML and front matter, and SOURCE for files the editor cannot carry.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSchema, type JSONContent } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { Keeper, load, mdExtensions } from '../web/src/mdkeep.ts';

const dir = join(import.meta.dirname, 'fixtures', 'docs');
const schema = getSchema(mdExtensions());
let pass = 0;
let fail = 0;
const ok = (what: string) => {
  pass++;
  console.log(`PASS: ${what}`);
};
const bad = (what: string, detail = '') => {
  fail++;
  console.log(`FAIL: ${what}${detail ? `\n${detail}` : ''}`);
};
const check = (what: string, cond: boolean, detail = '') => (cond ? ok(what) : bad(what, detail));
const show = (s: string) => JSON.stringify(s);

type Opened = { keeper: Keeper; doc: PMNode; loaded: Extract<ReturnType<typeof load>, { ok: true }> };
function open(text: string): Opened | null {
  const loaded = load(text);
  if (!loaded.ok) return null;
  const doc = schema.nodeFromJSON(loaded.doc);
  return { keeper: new Keeper(loaded, schema, doc), doc, loaded };
}

const kids = (doc: PMNode) => {
  const out: PMNode[] = [];
  doc.forEach((n) => out.push(n));
  return out;
};
const withChild = (doc: PMNode, i: number, node: PMNode | null) =>
  doc.copy(node ? doc.content.replaceChild(i, node) : Fragment.from(kids(doc).filter((_, k) => k !== i)));

// ------------------------------------------------------------ every sample

const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
const notEditable = new Set(['refs.md']);
for (const f of files) {
  const text = readFileSync(join(dir, f), 'utf8');
  const o = open(text);
  if (notEditable.has(f)) {
    check(`${f}: opens in SOURCE (not in the editor)`, o === null);
    continue;
  }
  if (!o) {
    bad(`${f}: opens in the editor`, String((load(text) as { why?: string }).why));
    continue;
  }
  const raws = o.loaded.blocks.filter((b) => b.raw_kept).map((b) => show(b.raw.split('\n')[0].slice(0, 40)));
  if (raws.length) console.log(`  ${f}: RAW boxes (${o.loaded.why.join(', ')}): ${raws.join(' ')}`);
  const same = o.keeper.serialize(o.doc);
  check(`${f}: untouched save is byte for byte`, same === text, `want ${show(text)}\ngot  ${show(same)}`);

  // Edit the first plain paragraph (not a RAW box).
  const ks = kids(o.doc);
  const pi = ks.findIndex((n) => n.type.name === 'paragraph' && n.childCount > 0);
  if (pi < 0) continue;
  const para = ks[pi];
  const edited = withChild(o.doc, pi, para.copy(para.content.append(Fragment.from(schema.text(' EDITED')))));
  const out = o.keeper.serialize(edited);
  let bi = 0;
  for (let n = o.loaded.blocks[0].nodes.length; n <= pi; n += o.loaded.blocks[bi].nodes.length) bi++;
  const b = o.loaded.blocks[bi];
  const before = text.slice(0, b.start);
  const after = bi + 1 < o.loaded.blocks.length ? text.slice(o.loaded.blocks[bi + 1].start) : '';
  check(
    `${f}: one paragraph edited, the rest keeps its bytes`,
    out.includes('EDITED') && out.startsWith(before) && out.endsWith(after) && !text.includes('EDITED'),
    `got ${show(out)}`,
  );
  const again = open(out);
  check(`${f}: reopened after the edit, saves the same`, !!again && again.keeper.serialize(again.doc) === out);
}

// ------------------------------------------------------------ checkboxes, reminders, delete

{
  const text = readFileSync(join(dir, 'list.md'), 'utf8');
  const o = open(text)!;
  const li = kids(o.doc).findIndex((n) => n.type.name === 'taskList');
  const list = kids(o.doc)[li];
  const item = list.child(0);
  const ticked = schema.nodes.taskItem.create({ ...item.attrs, checked: true }, item.content);
  const out = o.keeper.serialize(withChild(o.doc, li, list.copy(list.content.replaceChild(0, ticked))));
  check('list.md: ticking a checkbox writes [x] and nothing else', out === text.replace('- [ ] buy milk', '- [x] buy milk'), show(out));
}

{
  const text = readFileSync(join(dir, 'note.md'), 'utf8');
  const o = open(text)!;
  const add: JSONContent[] = [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Reminders' }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'call the bank' }] }] }] },
  ];
  const doc = o.doc.copy(o.doc.content.append(Fragment.fromArray(add.map((j) => schema.nodeFromJSON(j)))));
  const out = o.keeper.serialize(doc);
  check('note.md: a reminder added at the end', out === `${text.replace(/\n$/, '')}\n\n## Reminders\n\n- [ ] call the bank\n`, show(out));
}

{
  const text = readFileSync(join(dir, 'note.md'), 'utf8');
  const o = open(text)!;
  const out = o.keeper.serialize(withChild(o.doc, 1, null));
  check('note.md: a deleted block is gone, the rest stays', out === '# Note\n\nPick up the parcel before 5. Ask about the **blue** one, not the _green_ one.\n', show(out));
}

{
  const text = readFileSync(join(dir, 'note.md'), 'utf8');
  const o = open(text)!;
  const empty = schema.nodes.paragraph.create();
  const doc = o.doc.copy(o.doc.content.append(Fragment.from(empty)));
  check('note.md: an empty line left at the end changes nothing', o.keeper.serialize(doc) === text);
}

{
  const o = open('Line one\nline two\n')!;
  const p = kids(o.doc)[0];
  const doc = withChild(o.doc, 0, p.copy(p.content.append(Fragment.fromArray([schema.nodes.hardBreak.create(), schema.text('line three')]))));
  check('a line break (Shift+Enter) is written as a plain newline', o.keeper.serialize(doc) === 'Line one\nline two\nline three\n', show(o.keeper.serialize(doc)));
}

{
  const text = readFileSync(join(dir, 'obsidian.md'), 'utf8');
  const o = open(text)!;
  const pi = kids(o.doc).findIndex((n) => n.textContent.startsWith('Links to'));
  const p = kids(o.doc)[pi];
  const out = o.keeper.serialize(withChild(o.doc, pi, p.copy(p.content.append(Fragment.from(schema.text(' More.'))))));
  check('obsidian.md: an edited paragraph keeps [[wiki links]] and #tags unescaped', out.includes('Links to [[Projects]] and [[People/Sam|Sam]]. Tagged #home. More.\n'), show(out));
}

{
  const o = open('A URL https://example.com/a_b?x=1&y=2 and snake_case.\n')!;
  const p = kids(o.doc)[0];
  const out = o.keeper.serialize(withChild(o.doc, 0, p.copy(p.content.append(Fragment.from(schema.text('!'))))));
  check('an edited paragraph keeps bare URLs, & and snake_case as typed', out === 'A URL https://example.com/a_b?x=1&y=2 and snake_case.!\n', show(out));
}

// ------------------------------------------------------------ underline (<u>text</u>)

const marksOf = (n: PMNode, text: string) => {
  let found: string[] | null = null;
  n.descendants((c) => {
    if (c.isText && c.text === text) found ??= c.marks.map((m) => m.type.name).sort();
    return !found;
  });
  return (found ?? []) as string[];
};
const u = schema.marks.underline.create();
const b = schema.marks.bold.create();
const it = schema.marks.italic.create();

{
  const text = readFileSync(join(dir, 'underline.md'), 'utf8');
  const o = open(text)!;
  check('underline.md: no RAW boxes, <u> is underline', o.loaded.kept === 0 && marksOf(o.doc, 'plain').join() === 'underline', o.loaded.why.join());
  check('underline.md: <u> mixed with bold and italic', marksOf(o.doc, 'bold and underlined').join() === 'bold,underline' && marksOf(o.doc, 'italic').join() === 'italic,underline' && marksOf(o.doc, 'mixed').join() === 'bold,underline');
  check('underline.md: <u> in a list item and a checklist item', marksOf(o.doc, 'two').join() === 'underline' && marksOf(o.doc, 'today').join() === 'underline');
}

{
  const o = open('Say it once.\n')!;
  const para = schema.nodes.paragraph.create(null, [schema.text('Say '), schema.text('it', [u]), schema.text(' once.')]);
  const out = o.keeper.serialize(withChild(o.doc, 0, para));
  check('underlining a word writes <u>word</u>', out === 'Say <u>it</u> once.\n', show(out));
  const again = open(out)!;
  check('a saved <u>word</u> opens underlined and saves the same', marksOf(again.doc, 'it').join() === 'underline' && again.keeper.serialize(again.doc) === out);
}

{
  const o = open('x\n')!;
  const para = schema.nodes.paragraph.create(null, [schema.text('bold', [b, u]), schema.text(' and '), schema.text('slanted', [it, u]), schema.text(' and '), schema.text('only u', [u])]);
  const out = o.keeper.serialize(withChild(o.doc, 0, para));
  const again = open(out)!;
  check(
    'underline mixed with bold and italic is written as <u> and reads back the same',
    /<u>/.test(out) && !/\+\+/.test(out) && again.loaded.kept === 0 && again.doc.child(0).eq(para) && again.keeper.serialize(again.doc) === out,
    show(out),
  );
}

{
  const text = '- first\n- second\n';
  const o = open(text)!;
  const list = kids(o.doc)[0];
  const item = list.child(1);
  const p2 = schema.nodes.paragraph.create(null, [schema.text('second', [u])]);
  const out = o.keeper.serialize(withChild(o.doc, 0, list.copy(list.content.replaceChild(1, item.copy(item.content.replaceChild(0, p2))))));
  check('underline inside a list item', out === '- first\n- <u>second</u>\n', show(out));
}

// ------------------------------------------------------------ RAW boxes

{
  const text = readFileSync(join(dir, 'html.md'), 'utf8');
  const o = open(text)!;
  const raws = kids(o.doc).filter((n) => n.type.name === 'rawBlock').map((n) => String(n.attrs.src));
  check('html.md: the HTML block is a RAW box', raws.some((s) => s.startsWith('<div align="center">')));
  check('html.md: inline HTML keeps its paragraph as a RAW box', raws.some((s) => s.includes('<kbd>')));
  check('html.md: the HTML comment is a RAW box', raws.some((s) => s.startsWith('<!--')));
}

{
  const text = readFileSync(join(dir, 'obsidian.md'), 'utf8');
  const o = open(text)!;
  const first = kids(o.doc)[0];
  check('obsidian.md: front matter is a PROPERTIES box, kept exactly', first.type.name === 'rawBlock' && first.attrs.label === 'PROPERTIES' && text.startsWith(String(first.attrs.src)));
  const tasks = kids(o.doc).find((n) => n.type.name === 'taskList');
  check('obsidian.md: the reminders are real checkboxes', !!tasks && tasks.childCount === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
