// Numbered lists after a line of text (web/src/mdlists.ts). Plain functions, no browser.
//   npx tsx tests/mdlists.ts

import { marked } from 'marked';
import { fixLists } from '../web/src/mdlists.ts';

let pass = 0;
let fail = 0;
const ok = (what: string, cond: boolean, got: string) => {
  if (cond) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${JSON.stringify(got)}`);
  }
};
const html = (t: string) => marked.parse(fixLists(t), { async: false }) as string;

const tiers = '**Tier 1**\n1. One\n2. Two\n\n**Tier 2**\n5. Five [27:29](https://youtu.be/x?t=1)\n6. Six\n\n**Tier 3**\n9. Nine\n10. Ten';
const h = html(tiers);
ok('list at 5 after bold line', h.includes('<ol start="5">'), h);
ok('list at 9 after bold line', h.includes('<ol start="9">'), h);
ok('three lists', (h.match(/<ol/g) ?? []).length === 3, h);
ok('items stay tight (no <p> in items)', !/<li><p>/.test(h), h);
ok('link kept', h.includes('href="https://youtu.be/x?t=1"'), h);
ok('bold heading stays a paragraph', h.includes('<p><strong>Tier 2</strong></p>'), h);

const one = '**Steps**\n1. a\n2. b';
ok('list at 1 unchanged', fixLists(one) === one, fixLists(one));
const none = 'Just text.\nMore text.';
ok('plain text unchanged', fixLists(none) === none, fixLists(none));
const year = 'It shipped in\n2026. Then it grew.';
ok('a year at a line start is not a list', fixLists(year) === year, fixLists(year));
const code = '```\nstep\n5. not a list\n```';
ok('code block untouched', fixLists(code) === code, fixLists(code));
const quote = '> note\n> 5. inside quote';
ok('blockquote untouched', fixLists(quote) === quote, fixLists(quote));
const paren = 'Options:\n3) three\n4) four';
ok('3) style', html(paren).includes('<ol start="3">'), html(paren));
const deep = 'Intro\n    5. indented four = code';
ok('4-space indent not a list', fixLists(deep) === deep, fixLists(deep));
const crlf = 'Head\r\n5. five\r\n6. six';
ok('CRLF line ends', html(crlf).includes('<ol start="5">'), html(crlf));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
