// HISTORY: which chats count as this app's, and search inside chats (server/transcripts.ts).
// Small made-up transcripts in tests/fixtures/history; temp copies for the file-reading parts.
//   npx tsx tests/history.ts

import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ENTRYPOINT, chatText, entrypointOf, matchAt, queryWords, snippet, textOf, transcriptPaths } from '../server/transcripts.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};

const FIX = join(import.meta.dirname, 'fixtures', 'history');
const app = readFileSync(join(FIX, 'app-chat.jsonl'), 'utf8');

// chatText: only what the person and Claude wrote
const parts = chatText(app);
const all = parts.join('\n');
check('user text kept', all.includes('Please paint the Garden Shed blue.'));
check('assistant text kept', all.includes('Sure, I will use the cobalt paint.') && all.includes('Done: two coats of COBALT'));
check('user text part kept, reminder cut', all.includes('Make it   two coats,') && !all.includes('ostrich'));
check('attachment list cut', !all.includes('Attached files') && !all.includes('shed.png'));
check('thinking left out', !all.includes('zebra'));
check('tool input and output left out', !all.includes('walrus'));
check('helper-agent lines left out', !all.includes('penguins'));
check('meta lines left out', !all.includes('llamas'));
check('system lines left out', !all.includes('koalas'));
check('compaction summary left out', !all.includes('narwhal'));
check('titles and metadata left out', !all.includes('Shed paint'));
check('four pieces', parts.length === 4, JSON.stringify(parts));
check('STOP note left out', chatText('{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}').length === 0);
check('broken line skipped', chatText('{"type":"user","message":{"content":"half').length === 0);

// queryWords + matchAt
check('words: lower case, once each', JSON.stringify(queryWords('  Cobalt cobalt  SHED ')) === '["cobalt","shed"]');
check('all words must match', matchAt(all, ['cobalt', 'shed']) >= 0 && matchAt(all, ['cobalt', 'goldfish']) === -1);
check('any case', matchAt(all, ['garden']) === all.indexOf('Garden'));
check('first hit of any word', matchAt(all, ['coats', 'paint']) === all.indexOf('paint'));
check('across messages', matchAt(all, ['please', 'done:']) >= 0);
check('regex characters are plain', matchAt('a (b) c', ['(b)']) === 2 && matchAt('abc', ['.']) === -1);
check('no words: no match', matchAt(all, []) === -1);

// snippet
const long = `${'alpha beta gamma delta '.repeat(20)}the needle sits here ${'omega psi chi '.repeat(20)}`;
const s = snippet(long, long.indexOf('needle'));
check('snippet holds the hit', s.includes('needle'));
check('snippet about 120 chars', s.length <= 124 && s.length >= 90, String(s.length));
check('snippet marks both cut ends', s.startsWith('…') && s.endsWith('…'));
check('snippet cut at word edges', /^…(alpha|beta|gamma|delta) /.test(s) && / (omega|psi|chi)…$/.test(s), s);
check('snippet one line', snippet('one\n\ntwo   three\tfour', 4) === 'one two three four');
check('short text: whole, no dots', snippet('just a needle', 7) === 'just a needle');
check('hit at the very end', snippet(long + 'tailword', long.length).endsWith('tailword'));

// Files: the entrypoint filter, the path index, cached and growing text
const root = mkdtempSync(join(tmpdir(), 'ph-history-'));
try {
  mkdirSync(join(root, '-work'));
  mkdirSync(join(root, '-other'));
  const appPath = join(root, '-work', '11111111-1111-4111-8111-111111111111.jsonl');
  const cliPath = join(root, '-other', '22222222-2222-4222-8222-222222222222.jsonl');
  copyFileSync(join(FIX, 'app-chat.jsonl'), appPath);
  copyFileSync(join(FIX, 'terminal-chat.jsonl'), cliPath);
  writeFileSync(join(root, '-work', 'notes.txt'), 'not a chat');
  mkdirSync(join(root, '-work', '11111111-1111-4111-8111-111111111111')); // helper-agent folder, not a chat

  const paths = transcriptPaths(root);
  check('paths: every chat, any folder', paths.size === 2 && paths.get('22222222-2222-4222-8222-222222222222') === cliPath);
  check('paths: missing folder is empty', transcriptPaths(join(root, 'nope')).size === 0);

  check('app chat is this app', (await entrypointOf(appPath)) === APP_ENTRYPOINT);
  check('terminal chat is not', (await entrypointOf(cliPath)) === 'cli');
  const late = join(root, '-work', 'late.jsonl');
  writeFileSync(late, `${`{"type":"queue-operation","content":"${'x'.repeat(1000)}"}\n`.repeat(200)}{"type":"user","entrypoint":"sdk-ts"}\n`);
  check('entrypoint found past the first 64 KB', (await entrypointOf(late)) === 'sdk-ts');
  const none = join(root, '-work', 'none.jsonl');
  writeFileSync(none, '{"type":"user","message":{"content":"old chat"}}\n');
  check('no entrypoint: not this app', (await entrypointOf(none)) === undefined);
  check('missing file: not this app', (await entrypointOf(join(root, 'gone.jsonl'))) === undefined);

  check('text of a chat file', (await textOf(appPath)).includes('two coats of COBALT'));
  appendFileSync(appPath, '{"type":"assistant","message":{"content":[{"type":"text","text":"Later reply about varnish."}]}}\n{"type":"user","message":{"content":"half writ');
  const grown = await textOf(appPath);
  check('grown file: new text read', grown.includes('varnish') && grown.includes('Garden Shed'));
  check('half-written last line waits', !grown.includes('half writ'));
  appendFileSync(appPath, 'ten line"}}\n');
  check('finished line read next time', (await textOf(appPath)).includes('half written line'));
  writeFileSync(appPath, '{"type":"user","message":{"content":"fresh start"}}\n');
  const reset = await textOf(appPath);
  check('rewritten (smaller) file read again', reset === 'fresh start', reset);
  check('missing file: no text', (await textOf(join(root, 'gone.jsonl'))) === '');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
