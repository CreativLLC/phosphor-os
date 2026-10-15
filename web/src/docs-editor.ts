import { Editor } from '@tiptap/core';
import { EditorState, Selection, TextSelection } from '@tiptap/pm/state';
import { Keeper, load, mdExtensions } from './mdkeep.ts';
import { button, el } from './ui.ts';

// DOCS' DOC view: a WYSIWYG editor (TipTap) over the Markdown file. Loaded on demand (its own chunk), the first
// time a Markdown file shows in DOC view. docs.ts keeps the file text; this only shows and edits it.
// mdkeep.ts does the reading and writing, so untouched parts of the file keep their exact bytes.
// Keys (TipTap's own): Ctrl+B bold, Ctrl+I italic, Ctrl+U underline (saved as <u>text</u>), Ctrl+Shift+X strike,
// Ctrl+E code, Ctrl+Alt+1..3 headings, Ctrl+Shift+8 / 7 / 9 bullet, numbered and checklist, Ctrl+Z / Ctrl+Shift+Z.
// Typing "# ", "- ", "1. ", "[ ] ", "> " at the start of a line makes that block. Ctrl+click (or Cmd+click) opens
// a link.

export type LoadResult = { ok: true; kept: number; why: string[] } | { ok: false; why: string };

export type DocEditor = {
  el: HTMLElement;
  load(text: string): LoadResult;
  text(): string;
  setEditable(on: boolean): void;
  focus(): void;
  // Select the first q in the block that held this offset of the loaded text. False: not found.
  goto(offset: number, q: string): boolean;
  isIn(node: Node | null): boolean;
};

type Opts = {
  onChange: () => void;
  askLink: (current: string) => Promise<string | null>; // null = cancel, '' = remove the link
  openSource: () => void; // double-click on a RAW box
};

type Tool = { label: string; title: string; run: (e: Editor) => void; on?: (e: Editor) => boolean; cls?: string };

export function createDocEditor(o: Opts): DocEditor {
  const wrap = el('div', 'dc-rich');
  const bar = el('div', 'dc-tb');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');
  const host = el('div', 'dc-rich-body');
  wrap.append(bar, host);

  let keeper: Keeper | null = null;
  let quiet = false; // an empty line added for the cursor is not an edit

  const editor = new Editor({
    element: host,
    extensions: mdExtensions(),
    content: '',
    editorProps: {
      attributes: { class: 'dc-pm', spellcheck: 'true', autocapitalize: 'sentences', 'aria-label': 'Document', 'aria-multiline': 'true', role: 'textbox' },
      handleDOMEvents: {
        click: (_view, e) => {
          const a = (e.target as HTMLElement).closest?.('a[href]');
          if (a && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            window.open((a as HTMLAnchorElement).href, '_blank', 'noopener,noreferrer');
            return true;
          }
          return false;
        },
        dblclick: (_view, e) => {
          if (!(e.target as HTMLElement).closest?.('.dc-raw')) return false;
          o.openSource();
          return true;
        },
      },
    },
    onUpdate: () => {
      if (!quiet) o.onChange();
    },
    onTransaction: () => syncBar(),
  });

  const link = async (e: Editor) => {
    const cur = String(e.getAttributes('link').href ?? '');
    const href = await o.askLink(cur);
    if (href === null) return;
    const c = e.chain().focus().extendMarkRange('link');
    if (!href) c.unsetLink().run();
    else if (e.state.selection.empty && !cur) c.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    else c.setLink({ href }).run();
  };

  const tools: (Tool | '|')[] = [
    { label: 'B', title: 'Bold (Ctrl+B)', run: (e) => e.chain().focus().toggleBold().run(), on: (e) => e.isActive('bold'), cls: 'dc-tb-b' },
    { label: 'I', title: 'Italic (Ctrl+I)', run: (e) => e.chain().focus().toggleItalic().run(), on: (e) => e.isActive('italic'), cls: 'dc-tb-i' },
    { label: 'U', title: 'Underline (Ctrl+U)', run: (e) => e.chain().focus().toggleUnderline().run(), on: (e) => e.isActive('underline'), cls: 'dc-tb-u' },
    { label: 'S', title: 'Strike through (Ctrl+Shift+X)', run: (e) => e.chain().focus().toggleStrike().run(), on: (e) => e.isActive('strike'), cls: 'dc-tb-s' },
    '|',
    { label: 'H1', title: 'Big heading (Ctrl+Alt+1)', run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), on: (e) => e.isActive('heading', { level: 1 }) },
    { label: 'H2', title: 'Heading (Ctrl+Alt+2)', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), on: (e) => e.isActive('heading', { level: 2 }) },
    { label: 'H3', title: 'Small heading (Ctrl+Alt+3)', run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), on: (e) => e.isActive('heading', { level: 3 }) },
    '|',
    { label: '• LIST', title: 'Bullet list (Ctrl+Shift+8)', run: (e) => e.chain().focus().toggleBulletList().run(), on: (e) => e.isActive('bulletList') },
    { label: '1. LIST', title: 'Numbered list (Ctrl+Shift+7)', run: (e) => e.chain().focus().toggleOrderedList().run(), on: (e) => e.isActive('orderedList') },
    { label: '[ ] TODO', title: 'Checklist: tick boxes for reminders (Ctrl+Shift+9)', run: (e) => e.chain().focus().toggleTaskList().run(), on: (e) => e.isActive('taskList') },
    '|',
    { label: 'QUOTE', title: 'Quote (Ctrl+Shift+B)', run: (e) => e.chain().focus().toggleBlockquote().run(), on: (e) => e.isActive('blockquote') },
    { label: 'CODE', title: 'Code (Ctrl+E); in an empty line: a code block', run: (e) => (e.state.selection.empty && e.state.selection.$from.parent.content.size === 0 ? e.chain().focus().toggleCodeBlock().run() : e.chain().focus().toggleCode().run()), on: (e) => e.isActive('code') || e.isActive('codeBlock') },
    { label: 'LINK', title: 'Add, change or remove a link. Ctrl+click opens one.', run: (e) => void link(e), on: (e) => e.isActive('link') },
    '|',
    { label: 'UNDO', title: 'Undo (Ctrl+Z)', run: (e) => e.chain().focus().undo().run() },
    { label: 'REDO', title: 'Redo (Ctrl+Shift+Z)', run: (e) => e.chain().focus().redo().run() },
  ];
  const btns: [HTMLButtonElement, Tool][] = [];
  for (const t of tools) {
    if (t === '|') {
      bar.append(el('span', 'dc-tb-sep'));
      continue;
    }
    const b = button(t.label, () => t.run(editor), `dc-tb-btn ${t.cls ?? ''}`);
    b.title = t.title;
    b.tabIndex = -1; // Tab stays in the text; the keys do the same
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection (and the phone keyboard)
    if (t.on) b.setAttribute('aria-pressed', 'false');
    btns.push([b, t]);
    bar.append(b);
  }

  let barQueued = false;
  function syncBar(): void {
    if (barQueued) return;
    barQueued = true;
    requestAnimationFrame(() => {
      barQueued = false;
      const editable = editor.isEditable;
      for (const [b, t] of btns) {
        b.disabled = !editable;
        if (t.on) {
          const on = editable && t.on(editor);
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        }
      }
    });
  }

  return {
    el: wrap,
    load(text) {
      const l = load(text);
      if (!l.ok) {
        keeper = null;
        return l;
      }
      // A new state, not a transaction: no "changed" signal, and Ctrl+Z starts empty (never undoes the loading).
      let doc;
      try {
        doc = editor.schema.nodeFromJSON(l.doc);
      } catch {
        keeper = null;
        return { ok: false, why: 'could not be laid out by the editor' };
      }
      editor.view.updateState(EditorState.create({ schema: editor.schema, doc, plugins: editor.state.plugins, selection: Selection.atStart(doc) }));
      keeper = new Keeper(l, editor.schema, doc);
      host.scrollTop = 0;
      syncBar();
      return { ok: true, kept: l.kept, why: l.why };
    },
    text() {
      return keeper ? keeper.serialize(editor.state.doc) : '';
    },
    setEditable(on) {
      editor.setEditable(on, false);
      wrap.classList.toggle('dc-rich-ro', !on);
      syncBar();
    },
    focus() {
      editor.commands.focus(null, { scrollIntoView: false });
    },
    goto(offset, q) {
      if (!keeper) return false;
      if (offset < 0) {
        // The end, on a new empty line (a new note: start writing). The empty line is not saved.
        const doc = editor.state.doc;
        const last = doc.lastChild;
        quiet = true;
        try {
          if (!last || last.type.name !== 'paragraph' || last.content.size) {
            editor.view.dispatch(editor.state.tr.insert(doc.content.size, editor.schema.nodes.paragraph.create()).setMeta('addToHistory', false));
          }
          editor.view.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)).scrollIntoView());
        } finally {
          quiet = false;
        }
        editor.view.focus();
        return true;
      }
      const bi = keeper.blockAtOffset(offset);
      if (bi < 0) return false;
      const doc = editor.state.doc;
      const idx = keeper.nodesBefore(bi);
      if (idx >= doc.childCount) return false;
      let start = 0;
      for (let i = 0; i < idx; i++) start += doc.child(i).nodeSize;
      const node = doc.child(idx);
      let from = start + 1;
      let to = from;
      if (q) {
        const needle = q.toLowerCase();
        node.descendants((n, p) => {
          if (to > from) return false;
          if (n.isText) {
            const i = n.text!.toLowerCase().indexOf(needle);
            if (i >= 0) {
              from = start + 1 + p + i;
              to = from + q.length;
            }
          }
          return true;
        });
      }
      const sel = to > from ? TextSelection.create(doc, from, to) : Selection.near(doc.resolve(Math.min(from, doc.content.size)));
      editor.view.dispatch(editor.state.tr.setSelection(sel).scrollIntoView());
      editor.view.focus();
      return true;
    },
    isIn(node) {
      return !!node && wrap.contains(node);
    },
  };
}
