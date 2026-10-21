// IDEAS file (shared/ideas.ts) and its endpoint (server/ideas.ts) on a temp file and a spare port.
//   npx tsx tests/ideas.ts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropIdeas, ideasPrompt, parseIdeas, type IdeasResponse } from '../shared/ideas.ts';

let pass = 0;
let fail = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${g}\n  want ${w}`);
  }
};

const md = [
  '# Parked ideas',
  '',
  'Line format: `- [ ] YYYY-MM-DD · <project> · <the idea, one line>`',
  '- [ ] not in a section',
  '',
  '## Parked',
  '- [ ] 2026-10-21 · phosphor-os · Search pictures from HISTORY',
  '- [x] 2026-10-20 · old · done already',
  '- [ ] no date or project here',
  '- [ ] 2026-10-21 · brain · text with · a dot in it',
  '* plain bullet',
  '',
  '## Suggested',
  '- [ ] 2026-10-23 · routine · Weekly build check',
  '## Notes',
  '- [ ] not an idea either',
].join('\n');

const ideas = parseIdeas(md);
eq('count', ideas.length, 5);
eq('first', ideas[0], { line: '- [ ] 2026-10-21 · phosphor-os · Search pictures from HISTORY', section: 'parked', date: '2026-10-21', project: 'phosphor-os', text: 'Search pictures from HISTORY' });
eq('no date', [ideas[1].date, ideas[1].project, ideas[1].text], ['', '', 'no date or project here']);
eq('dot in text', ideas[2].text, 'text with · a dot in it');
eq('plain bullet', ideas[3].text, 'plain bullet');
eq('suggested', [ideas[4].section, ideas[4].text], ['suggested', 'Weekly build check']);
eq('CRLF', parseIdeas('## Parked\r\n- [ ] 2026-10-21 · p · x\r\n').map((i) => i.text), ['x']);
eq('empty file', parseIdeas(''), []);

const dropped = dropIdeas(md, [ideas[0].line, 'gone line']);
eq('drop removes the line', dropped.includes('Search pictures'), false);
eq('drop keeps the rest', dropped.split('\n').length, md.split('\n').length - 1);
eq('drop twice-listed line once', dropIdeas('a\nb\na', ['a']), 'b\na');
eq('drop keeps CRLF', dropIdeas('a\r\nb\r\nc', ['b']), 'a\r\nc');

const p = ideasPrompt([ideas[0], ideas[1]], '/w/parked.md');
eq('prompt names the file', p.startsWith('Do these parked ideas from /w/parked.md:'), true);
eq('prompt lists with project', p.includes('1. [phosphor-os] Search pictures from HISTORY\n2. no date or project here'), true);
eq('prompt asks to delete lines', p.includes('delete its line from that file'), true);

// Endpoint on a temp file.
const dir = mkdtempSync(join(tmpdir(), 'ideas-test-'));
const file = join(dir, 'parked.md');
process.env.PHOSPHOR_IDEAS_FILE = file;
const { handleIdeas } = await import('../server/ideas.ts');
const server = createServer((req, res) => void handleIdeas(req, res, new URL(req.url ?? '/', 'http://x')));
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  let r = (await (await fetch(`${base}/api/ideas`)).json()) as IdeasResponse;
  eq('missing file', [r.found, r.ideas.length], [false, 0]);
  writeFileSync(file, md);
  r = (await (await fetch(`${base}/api/ideas`)).json()) as IdeasResponse;
  eq('file found', [r.found, r.ideas.length, r.file], [true, 5, file]);
  const form = await fetch(`${base}/api/ideas/drop`, { method: 'POST', body: 'lines=x' });
  eq('drop needs JSON', form.status, 405);
  const bad = await fetch(`${base}/api/ideas/drop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"lines":[1]}' });
  eq('drop needs strings', bad.status, 400);
  // A chat adds a line after the page loaded: the drop keeps it.
  writeFileSync(file, md + '\n- [ ] 2026-10-22 · late · added by a chat');
  r = (await (await fetch(`${base}/api/ideas/drop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: [ideas[0].line] }) })).json()) as IdeasResponse;
  eq('drop answer', r.ideas.map((i) => i.text), ['no date or project here', 'text with · a dot in it', 'plain bullet', 'Weekly build check']);
  eq('late line kept on disk', readFileSync(file, 'utf8').includes('added by a chat'), true);
  eq('dropped line gone on disk', readFileSync(file, 'utf8').includes('Search pictures'), false);
  eq('unknown path', (await fetch(`${base}/api/ideas/nope`)).status, 404);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
