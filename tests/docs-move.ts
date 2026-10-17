// DOCS moves and renames: the title -> file name rule and the drag-and-drop rules (web/src/docsmove.ts).
// Plain functions, no browser, no disk.
//   npx tsx tests/docs-move.ts

import { dropProblem, isDefaultName, movedPath, nameFromTitle, titleOf, titleRename } from '../web/src/docsmove.ts';

let pass = 0;
let fail = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (got === want) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
};

// The title: only a "# heading" on the very first line.
eq('title: first-line heading', titleOf('# Shopping\n\nmilk\n'), 'Shopping');
eq('title: closing hashes go', titleOf('# Notes ##\n'), 'Notes');
eq('title: C# keeps its hash', titleOf('# Learn C#\n'), 'Learn C#');
eq('title: CRLF file', titleOf('# Trip\r\nday one'), 'Trip');
eq('title: no heading', titleOf('Dear Sam,\n# Later\n'), '');
eq('title: level 2 is not the title', titleOf('## Sub\n'), '');
eq('title: hashtag is not a heading', titleOf('#tag\n'), '');
eq('title: empty heading', titleOf('# \n'), '');
eq('title: one line, no newline', titleOf('# Only'), 'Only');

// Cleaning a title into a file name.
eq('clean: plain', nameFromTitle('Shopping list'), 'Shopping list');
eq('clean: Windows characters', nameFromTitle('Q&A: who/what? <draft> "v2" a|b'), 'Q&A who what draft v2 a b');
eq('clean: stars and backslashes go (Markdown marks)', nameFromTitle('5 * 3 \\ 2 \\*not bold\\*'), '5 3 2 not bold');
eq('clean: spaces collapse and trim', nameFromTitle('   lots    of\tspace   '), 'lots of space');
eq('clean: Markdown marks', nameFromTitle('**Big** `code` [Site](https://x.org)'), 'Big code Site');
eq('clean: no hidden file, no trailing dot', nameFromTitle('..secret...'), 'secret');
eq('clean: only bad characters = no name', nameFromTitle(' /// ?? '), '');
eq('clean: Windows device name = no name', nameFromTitle('CON'), '');
eq('clean: device name with a dot = no name', nameFromTitle('nul.txt'), '');
eq('clean: device-like word is fine', nameFromTitle('Console'), 'Console');
eq('clean: capped at 100 letters', nameFromTitle('a'.repeat(150)).length, 100);
eq('clean: cap does not end in a space', nameFromTitle(`${'a'.repeat(99)} bcd`), 'a'.repeat(99));
eq('clean: cap keeps emoji whole', Array.from(nameFromTitle('😀'.repeat(120))).length, 100);
eq('clean: unicode kept', nameFromTitle('Café über naïve'), 'Café über naïve');

// The names NEW gives.
eq('default: Untitled', isDefaultName('Untitled'), true);
eq('default: Note with date', isDefaultName('Note 2026-10-16'), true);
eq('default: List with date and number', isDefaultName('List 2026-10-16 2'), true);
eq('default: a real name', isDefaultName('Notes on Rome'), false);

// When the file follows the title.
eq('rename: new note from the template', titleRename('Note 2026-10-16.md', 'Note', '# Shopping\n\n- milk\n'), 'Shopping.md');
eq('rename: blank doc gets its first title', titleRename('work/Untitled.md', '', '# Plan\n'), 'work/Plan.md');
eq('rename: in sync with the old title', titleRename('Trip.md', 'Trip', '# Trip to Rome\n'), 'Trip to Rome.md');
eq('rename: in sync after the same cleaning', titleRename('a/Q&A notes.md', 'Q&A: notes', '# Q&A: notes 2\n'), 'a/Q&A notes 2.md');
eq('rename: keeps .markdown', titleRename('Trip.markdown', 'Trip', '# Rome\n'), 'Rome.markdown');
eq('rename: named on purpose stays', titleRename('README.md', 'Something', '# Something else\n'), null);
eq('rename: old title not in sync stays', titleRename('Rome notes.md', 'Trip', '# Rome\n'), null);
eq('rename: title unchanged', titleRename('Trip.md', 'Trip', '# Trip\n'), null);
eq('rename: a NEW name takes a title that was there before', titleRename('LLM work/Note 2026-10-16.md', '1. Test prompt for LLMs', '# 1. Test prompt for LLMs\n'), 'LLM work/1. Test prompt for LLMs.md');
eq('rename: a NEW name already matching stays', titleRename('Note 2026-10-16.md', 'Note 2026-10-16', '# Note 2026-10-16\n'), null);
eq('rename: new note, title still the template one', titleRename('Note 2026-10-16.md', 'Note', '# Note\n\nmilk\n'), null);
eq('rename: title removed = no rename', titleRename('Trip.md', 'Trip', 'Trip\n'), null);
eq('rename: unusable title = no rename', titleRename('Trip.md', 'Trip', '# ???\n'), null);
eq('rename: not Markdown', titleRename('Trip.txt', 'Trip', '# Rome\n'), null);
eq('rename: letter template (no heading) stays', titleRename('Letter 2026-10-16.md', '', 'Your name\n'), null);

// Drag and drop.
const file = (path: string, readonly = false) => ({ path, dir: false, readonly });
const dir = (path: string, readonly = false) => ({ path, dir: true, readonly });
eq('drop: file into a folder', dropProblem(file('a.md'), { path: 'work', readonly: false, names: ['b.md'] }), '');
eq('drop: file to the top', dropProblem(file('work/a.md'), { path: '', readonly: false }), '');
eq('drop: where it already is', dropProblem(file('work/a.md'), { path: 'work', readonly: false }), null);
eq('drop: folder onto itself', dropProblem(dir('work'), { path: 'work', readonly: false }), null);
eq('drop: folder into its own subfolder', dropProblem(dir('work'), { path: 'work/old/x', readonly: false }), 'A folder cannot go inside itself.');
eq('drop: folder into a look-alike sibling', dropProblem(dir('work'), { path: 'work2', readonly: false }), '');
eq('drop: nested folder up one level', dropProblem(dir('a/b/c'), { path: 'a', readonly: false }), '');
eq('drop: read-only item', dropProblem(file('ro/a.md', true), { path: '', readonly: false }), 'a.md is read-only in DOCS.');
eq('drop: into a read-only folder', dropProblem(file('a.md'), { path: 'ro', readonly: true }), 'ro is read-only in DOCS.');
eq('drop: name taken (any case)', dropProblem(file('a/Plan.md'), { path: 'b', readonly: false, names: ['plan.md'] }), 'b already has something called Plan.md.');

// Paths that follow a move.
eq('moved: the item', movedPath('work/a.md', 'work/a.md', 'old/a.md'), 'old/a.md');
eq('moved: inside a moved folder', movedPath('work/x/a.md', 'work', 'old/work'), 'old/work/x/a.md');
eq('moved: look-alike untouched', movedPath('work2/a.md', 'work', 'old/work'), 'work2/a.md');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
