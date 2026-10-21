// DOCS OPEN FILES: files outside the docs folder, opened from the PC (server/docs.ts). Only files the desktop app
// added may be read or written, and only while they are still the same regular .md/.txt file. Everything happens
// in a temp folder; the HTTP gate runs on a spare loopback port.
//   npx tsx tests/docs-open.ts   (part of npm run test:docs)

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocFile, DocStat } from '../shared/docs.ts';
import { addOpened, type Ctx, handleOpenLocal, HttpError, listOpened, localKey, readDoc, removeOpened, statDoc, writeDoc } from '../server/docs.ts';

let pass = 0;
let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${!cond && detail ? `\n  ${detail}` : ''}`);
};
// The HTTP status a call fails with (0 = it did not fail).
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (e) {
    if (e instanceof HttpError) return e.status;
    const c = (e as NodeJS.ErrnoException).code;
    return c === 'ENOENT' ? 404 : -1;
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'phosphor-docs-open-'));
const root = join(tmp, 'docs');
const out = join(tmp, 'elsewhere');
const data = join(tmp, 'data');
for (const d of [root, out, data]) mkdirSync(d);
const ctx: Ctx = { root, readonly: [], opened: join(data, 'docs-open.json') };
const put = (p: string, t: string) => writeFileSync(p, t);

try {
  put(join(out, 'notes.md'), '# Notes\n\nhello\n');
  put(join(out, 'secret.md'), 'secret\n');
  put(join(out, 'config.json'), '{}\n');
  put(join(out, 'run.sh'), 'echo hi\n');
  mkdirSync(join(out, 'folder.md'));
  put(join(root, 'inside.md'), 'inside\n');

  // Not on the list: refused.
  check('unknown OPEN FILES id: read refused (404)', (await status(readDoc(ctx, 'ext:AAAAAAAAAAAAAAAAAAAAAA/notes.md'))) === 404);
  check('unknown id: write refused (404)', (await status(writeDoc(ctx, { path: 'ext:AAAAAAAAAAAAAAAAAAAAAA/x.md', text: 'x', etag: null }))) === 404);
  check('malformed ext path refused', (await status(readDoc(ctx, 'ext:../../notes.md'))) === 404);
  check('absolute path through read refused (400)', (await status(readDoc(ctx, join(out, 'notes.md')))) === 400);
  check('outside path through write refused (400)', (await status(writeDoc(ctx, { path: '../elsewhere/notes.md', text: 'x', etag: null }))) === 400);
  check('nothing listed yet', (await listOpened(ctx)).length === 0);

  // Adding: only full paths of regular .md/.markdown/.mdown/.txt files.
  check('relative path refused', (await status(addOpened(ctx, 'elsewhere/notes.md'))) === 400);
  check('.json refused (415)', (await status(addOpened(ctx, join(out, 'config.json')))) === 415);
  check('.sh refused (415)', (await status(addOpened(ctx, join(out, 'run.sh')))) === 415);
  check('a folder named .md refused (400)', (await status(addOpened(ctx, join(out, 'folder.md')))) === 400);
  check('missing file refused (404)', (await status(addOpened(ctx, join(out, 'nope.md')))) === 404);
  symlinkSync(join(out, 'config.json'), join(out, 'link.md'));
  check('a .md link to a .json file refused (415)', (await status(addOpened(ctx, join(out, 'link.md')))) === 415);
  check('nothing listed after refusals', (await listOpened(ctx)).length === 0);

  // Registered: read and write in place.
  const { path } = await addOpened(ctx, join(out, 'notes.md'));
  check('added: an ext path ending in the file name', /^ext:[A-Za-z0-9_-]{22}\/notes\.md$/.test(path), path);
  const f = await readDoc(ctx, path);
  check('registered: read ok', f.text === '# Notes\n\nhello\n' && f.path === path && f.abs === join(out, 'notes.md') && !f.readonly);
  const s = (await writeDoc(ctx, { path, text: '# Notes\n\nchanged\n', etag: f.etag })) as DocStat;
  check('registered: write ok, in place', readFileSync(join(out, 'notes.md'), 'utf8') === '# Notes\n\nchanged\n');
  check('stat gives the saved version', (await statDoc(ctx, path)).etag === s.etag);
  check('stale etag: conflict (409)', (await status(writeDoc(ctx, { path, text: 'x', etag: f.etag }))) === 409);
  check('the name part of the path does not pick the file', (await readDoc(ctx, path.replace(/notes\.md$/, 'secret.md'))).text.includes('changed'));
  const list = await listOpened(ctx);
  check('listed with name and folder', list.length === 1 && list[0].path === path && list[0].name === 'notes.md' && list[0].folder === out, JSON.stringify(list));
  check('same file again: listed once', (await addOpened(ctx, join(out, 'notes.md'))).path === path && (await listOpened(ctx)).length === 1);
  const saved = JSON.parse(readFileSync(ctx.opened!, 'utf8'));
  check('list saved under data/', Array.isArray(saved) && saved[0]?.real === join(out, 'notes.md'));
  const copy = join(data, 'copy.json');
  put(copy, readFileSync(ctx.opened!));
  check('list survives a restart (read back from the file)', (await listOpened({ ...ctx, opened: copy }))[0]?.path === path);

  // A file inside the docs folder opens as a normal doc.
  check('inside the docs folder: a normal path', (await addOpened(ctx, join(root, 'inside.md'))).path === 'inside.md');

  // Symlink escape: the registered file swapped for a link to another file.
  const before = readFileSync(join(out, 'notes.md'), 'utf8');
  unlinkSync(join(out, 'notes.md'));
  symlinkSync(join(out, 'secret.md'), join(out, 'notes.md'));
  check('swapped for a link: read refused (403)', (await status(readDoc(ctx, path))) === 403);
  check('swapped for a link: stat refused (403)', (await status(statDoc(ctx, path))) === 403);
  check('swapped for a link: write refused (403)', (await status(writeDoc(ctx, { path, text: 'pwned', etag: 'x' }))) === 403);
  check('swapped for a link: write as new refused (403, no conflict text)', (await status(writeDoc(ctx, { path, text: 'pwned', etag: null }))) === 403);
  check('the link target is untouched', readFileSync(join(out, 'secret.md'), 'utf8') === 'secret\n');
  unlinkSync(join(out, 'notes.md'));
  put(join(out, 'notes.md'), before);

  // Folder swapped for a link: the real path changes, so refused.
  const sub = join(tmp, 'sub');
  mkdirSync(sub);
  put(join(sub, 'a.md'), 'a\n');
  const a = (await addOpened(ctx, join(sub, 'a.md'))).path;
  rmSync(sub, { recursive: true });
  mkdirSync(join(tmp, 'other'));
  put(join(tmp, 'other', 'a.md'), 'other\n');
  symlinkSync(join(tmp, 'other'), sub);
  check('folder swapped for a link: read refused (403)', (await status(readDoc(ctx, a))) === 403);
  check('folder swapped for a link: write as new refused', (await status(writeDoc(ctx, { path: a, text: 'x', etag: null }))) !== 0);
  check('the other folder is untouched', readFileSync(join(tmp, 'other', 'a.md'), 'utf8') === 'other\n');

  // Deleted on disk: KEEP MINE writes it back at the same place.
  const g = await readDoc(ctx, path);
  unlinkSync(join(out, 'notes.md'));
  check('deleted on disk: write with the old etag is a conflict', (await status(writeDoc(ctx, { path, text: 'mine\n', etag: g.etag }))) === 409);
  const back = (await writeDoc(ctx, { path, text: 'mine\n', etag: null })) as DocStat;
  check('deleted on disk: saved again in place', readFileSync(join(out, 'notes.md'), 'utf8') === 'mine\n' && back.path === path);

  // Read-only folders stay read-only.
  const ro: Ctx = { ...ctx, readonly: [out] };
  check('in a read-only folder: read says read-only', ((await readDoc(ro, path)) as DocFile).readonly);
  check('in a read-only folder: write refused (403)', (await status(writeDoc(ro, { path, text: 'x', etag: back.etag }))) === 403);

  // Removing from the list only removes access.
  await removeOpened(ctx, { path });
  check('removed: read refused (404)', (await status(readDoc(ctx, path))) === 404);
  check('removed: the file is still there', readFileSync(join(out, 'notes.md'), 'utf8') === 'mine\n');
  check('removed: gone from the saved list', !JSON.parse(readFileSync(ctx.opened!, 'utf8')).some((o: { real: string }) => o.real === join(out, 'notes.md')));
  check('remove needs an ext path', (await status(removeOpened(ctx, { path: 'inside.md' }))) === 400);

  // The HTTP gate: loopback, no proxy headers, the key.
  const keyFile = join(data, 'docs-open.key');
  const key = await localKey(keyFile);
  check('key made, 43 letters, owner-only', key.length === 43 && (statSync(keyFile).mode & 0o777) === 0o600);
  check('key stays the same', (await localKey(keyFile)) === key);
  const srv = createServer((req, res) => void handleOpenLocal(req, res, ctx, keyFile));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  const post = (headers: Record<string, string>, body: unknown) =>
    new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/docs/open-local', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(t || '{}') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  const file = join(out, 'notes.md');
  check('HTTP: no key refused (403)', (await post({}, { path: file })).status === 403);
  check('HTTP: wrong key refused (403)', (await post({ 'X-Phosphor-Key': 'x'.repeat(43) }, { path: file })).status === 403);
  check('HTTP: through a proxy (X-Forwarded-For) refused', (await post({ 'X-Phosphor-Key': key, 'X-Forwarded-For': '100.64.0.2' }, { path: file })).status === 403);
  check('HTTP: tailscale header refused', (await post({ 'X-Phosphor-Key': key, 'Tailscale-User-Login': 'someone' }, { path: file })).status === 403);
  check('HTTP: right key, non-md refused (415)', (await post({ 'X-Phosphor-Key': key }, { path: join(out, 'config.json') })).status === 415);
  const okRes = await post({ 'X-Phosphor-Key': key }, { path: file });
  check('HTTP: right key adds it', okRes.status === 200 && /^ext:.+\/notes\.md$/.test(String(okRes.body.path)), JSON.stringify(okRes));
  srv.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
