// Clickable paths in chat replies (shared/pathlinks.mjs, shell/pathlinks.mjs): finding paths in text, inline code and
// link targets for Linux, macOS and Windows; turning them into absolute paths; and the rule for what the desktop
// app may open. Windows and macOS are checked as data only (the resolving runs through path.win32); the open/show
// decision and the batch check run for real on this PC's files in a temp folder. No Electron.
//   npx tsx tests/pathlinks.ts

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canOpen, extOf, fileUrlPath, inlineCodePath, linkTargetPath, scanPaths } from '../shared/pathlinks.mjs';
import { openDecision, openPathLink, resolveRaw, statPaths } from '../shell/pathlinks.mjs';

let pass = 0;
let fail = 0;
const ok = (what: string, cond: boolean, got?: unknown) => {
  if (cond) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${JSON.stringify(got)}`);
  }
};
const eq = (what: string, got: unknown, want: unknown) => ok(what, JSON.stringify(got) === JSON.stringify(want), got);
const raws = (text: string, p: string) => scanPaths(text, p).map((m) => m.raw);

// Plain text, every OS
for (const p of ['linux', 'darwin', 'win32']) {
  eq(`${p}: absolute`, raws('Edit /home/me/phosphor-os/server/tab.ts now', p), ['/home/me/phosphor-os/server/tab.ts']);
  eq(`${p}: tilde`, raws('see ~/projects/x/README.md.', p), ['~/projects/x/README.md']);
  eq(`${p}: relative`, raws('in server/tab.ts and ./x and ../y/z.md and docs/A.md', p), ['server/tab.ts', './x', '../y/z.md', 'docs/A.md']);
  eq(`${p}: bare file name`, raws('open package.json, then README.md!', p), ['package.json', 'README.md']);
  eq(`${p}: punctuation and brackets`, raws('(see /etc/hosts), "web/src/md.ts"; [docs/B.md]?', p), ['/etc/hosts', 'web/src/md.ts', 'docs/B.md']);
  eq(`${p}: web addresses are not paths`, raws('go to https://example.com/a/b.html or http://x.org/y or mailto:a@b.c or //cdn/x', p), []);
  eq(`${p}: words are not paths`, raws('this is a plain sentence, e.g. nothing here. Version 1.2 is out; 3/4 done', p), []);
  eq(`${p}: lone slash and dots`, raws('a / b ... .. ~ /', p), []);
}
const t1 = scanPaths('at server/tab.ts:42:7, and x/y.ts:9. Then docs/A.md#L12-L20.', 'linux');
eq('line and column kept, not in raw', t1.map((m) => [m.raw, m.line, m.col]), [['server/tab.ts', 42, 7], ['x/y.ts', 9, 0], ['docs/A.md', 12, 0]]);
const text = 'at server/tab.ts:42:7, ok';
const m1 = scanPaths(text, 'linux')[0];
eq('start/end cover the path and its :line, not the comma', text.slice(m1.start, m1.end), 'server/tab.ts:42:7');
eq('version numbers with a colon are not lines', raws('it took 12:30 or a/b:12', 'linux'), ['a/b']);

// Windows forms
eq('win: drive path, both slashes', raws('C:\\Users\\me\\a.txt and D:/work/x.md', 'win32'), ['C:\\Users\\me\\a.txt', 'D:/work/x.md']);
eq('win: drive path with line', scanPaths('C:\\a\\b.ts:12:3', 'win32').map((m) => [m.raw, m.line, m.col]), [['C:\\a\\b.ts', 12, 3]]);
eq('win: UNC and backslash relative', raws('\\\\srv\\share\\f.txt and docs\\A.md and .\\x and ~\\Desktop\\n.txt', 'win32'), ['\\\\srv\\share\\f.txt', 'docs\\A.md', '.\\x', '~\\Desktop\\n.txt']);
eq('linux: drive paths and backslashes are not paths', raws('C:\\Users\\me\\folder docs\\Sub', 'linux'), []);
eq('mac: same as linux', raws('/Users/me/Library/x.plist ~/Desktop/a.png', 'darwin'), ['/Users/me/Library/x.plist', '~/Desktop/a.png']);

// Inline code
eq('code: absolute with spaces', inlineCodePath('/home/me/My Docs/a b.md', 'linux'), { raw: '/home/me/My Docs/a b.md', line: 0, col: 0 });
eq('code: relative', inlineCodePath('server/tab.ts', 'linux'), { raw: 'server/tab.ts', line: 0, col: 0 });
eq('code: line', inlineCodePath(' web/src/md.ts:97 ', 'linux'), { raw: 'web/src/md.ts', line: 97, col: 0 });
eq('code: dotfile and bare name with an ending', [inlineCodePath('.env', 'linux')?.raw, inlineCodePath('README.md', 'linux')?.raw], ['.env', 'README.md']);
eq('code: bare words, commands, flags are not paths', ['server', 'git status', 'npm run build', '--force', 'foo()', 'x = 1', 'a b/c.ts'].map((s) => inlineCodePath(s, 'linux')), [null, null, null, null, null, null, null]);
eq('code: url is not a path', inlineCodePath('https://a.b/c', 'linux'), null);
eq('code: win drive path with spaces', inlineCodePath('C:\\Program Files\\x\\a.txt', 'win32')?.raw, 'C:\\Program Files\\x\\a.txt');
eq('code: win path with spaces is nothing on linux', inlineCodePath('C:\\Program Files\\x\\a.txt', 'linux'), null);
eq('code: multiline', inlineCodePath('a/b\nc/d', 'linux'), null);

// Link targets
eq('link: absolute and relative', ['/home/me/a.md', 'docs/A.md', './x.md', '~/x.md'].map((h) => linkTargetPath(h, 'linux')?.raw), ['/home/me/a.md', 'docs/A.md', './x.md', '~/x.md']);
eq('link: encoded spaces', linkTargetPath('/home/me/My%20Docs/a.md', 'linux')?.raw, '/home/me/My Docs/a.md');
eq('link: file url kept for the app', linkTargetPath('file:///home/me/a.md', 'linux')?.raw, 'file:///home/me/a.md');
eq('link: web, mail, anchors are not paths', ['https://a.b/c', 'http://x', 'mailto:a@b.c', '#top', 'javascript:alert(1)', '//cdn/x'].map((h) => linkTargetPath(h, 'linux')), [null, null, null, null, null, null]);
eq('link: line hint', linkTargetPath('src/a.ts:10', 'linux'), { raw: 'src/a.ts', line: 10, col: 0 });
eq('link: win drive', linkTargetPath('C:\\a\\b.md', 'win32')?.raw, 'C:\\a\\b.md');

// file:// addresses
eq('file url: linux', fileUrlPath('file:///home/me/a%20b.md', 'linux'), '/home/me/a b.md');
eq('file url: localhost', fileUrlPath('file://localhost/etc/hosts', 'darwin'), '/etc/hosts');
eq('file url: host on linux is refused', fileUrlPath('file://evil/share/x', 'linux'), null);
eq('file url: windows drive', fileUrlPath('file:///C:/Users/me/a.txt', 'win32'), 'C:/Users/me/a.txt');
eq('file url: windows share', fileUrlPath('file://srv/share/f.txt', 'win32'), '\\\\srv\\share\\f.txt');
eq('file url: linux path on windows is refused', fileUrlPath('file:///home/me/a', 'win32'), null);
eq('file url: bad escapes', fileUrlPath('file:///a/%zz', 'linux'), null);

// Resolving (data only for Windows and macOS)
eq('resolve linux: absolute', resolveRaw('/home/me/../me/a.md', '/w', '/home/me', 'linux'), '/home/me/a.md');
eq('resolve linux: tilde', resolveRaw('~/x/y.md', '/w', '/home/me', 'linux'), '/home/me/x/y.md');
eq('resolve linux: relative to the chat folder', resolveRaw('server/tab.ts', '/w/app', '/home/me', 'linux'), '/w/app/server/tab.ts');
eq('resolve linux: ./ and ../', [resolveRaw('./x', '/w/app', '/h', 'linux'), resolveRaw('../y', '/w/app', '/h', 'linux')], ['/w/app/x', '/w/y']);
eq('resolve linux: trailing slash dropped, root kept', [resolveRaw('/w/app/', '/', '/h', 'linux'), resolveRaw('/', '/', '/h', 'linux')], ['/w/app', '/']);
eq('resolve linux: relative without a usable chat folder', [resolveRaw('a/b', '', '/h', 'linux'), resolveRaw('a/b', 'rel', '/h', 'linux')], [null, null]);
eq('resolve linux: ~user and junk', [resolveRaw('~bob/x', '/w', '/h', 'linux'), resolveRaw('a\0b', '/w', '/h', 'linux'), resolveRaw('', '/w', '/h', 'linux'), resolveRaw(5, '/w', '/h', 'linux')], [null, null, null, null]);
eq('resolve mac: file url', resolveRaw('file:///Users/me/a%20b.md', '/w', '/Users/me', 'darwin'), '/Users/me/a b.md');
eq('resolve win: drive', resolveRaw('C:/Users/me/a.txt', 'C:\\w', 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\a.txt');
eq('resolve win: tilde', resolveRaw('~\\Desktop\\n.txt', 'C:\\w', 'C:\\Users\\me', 'win32'), 'C:\\Users\\me\\Desktop\\n.txt');
eq('resolve win: relative', resolveRaw('docs/A.md', 'C:\\w\\app', 'C:\\Users\\me', 'win32'), 'C:\\w\\app\\docs\\A.md');
eq('resolve win: UNC and file url', [resolveRaw('\\\\srv\\share\\f.txt', 'C:\\w', 'C:\\h', 'win32'), resolveRaw('file:///C:/x/y.txt', 'C:\\w', 'C:\\h', 'win32')], ['\\\\srv\\share\\f.txt', 'C:\\x\\y.txt']);
eq('resolve win: stream names and wildcards are refused', [resolveRaw('C:\\a.txt:evil', 'C:\\w', 'C:\\h', 'win32'), resolveRaw('C:\\a*.txt', 'C:\\w', 'C:\\h', 'win32')], [null, null]);
eq('resolve win: drive root kept', resolveRaw('C:\\', 'C:\\w', 'C:\\h', 'win32'), 'C:\\');

// What may be opened
const blocked = 'exe msi bat cmd com ps1 psm1 vbs js jse wsf scr lnk reg jar app command desktop appimage sh bash zsh run bin pkg dmg deb rpm apk'.split(' ');
for (const p of ['linux', 'darwin', 'win32']) {
  ok(`${p}: every listed ending is blocked, in any case`, blocked.every((e) => !canOpen(`/x/a.${e}`, false, 0o644, p) && !canOpen(`/x/A.${e.toUpperCase()}`, false, 0o644, p)), blocked.filter((e) => canOpen(`/x/a.${e}`, false, 0o644, p)));
  ok(`${p}: documents and pictures open`, ['md', 'txt', 'pdf', 'png', 'jpg', 'html', 'json', 'ts', 'csv', 'docx'].every((e) => canOpen(`/x/a.${e}`, false, 0o644, p)));
  ok(`${p}: a folder opens, a .app folder does not`, canOpen('/x/docs', true, 0o755, p) && !canOpen('/x/My.app', true, 0o755, p));
  ok(`${p}: only the last ending counts`, canOpen('/x/a.sh.txt', false, 0o644, p) && !canOpen('/x/a.txt.sh', false, 0o644, p));
}
ok('linux/mac: an execute bit blocks, whatever the name', !canOpen('/x/tool', false, 0o755, 'linux') && !canOpen('/x/notes.txt', false, 0o700, 'darwin') && !canOpen('/x/g', false, 0o010, 'linux'));
ok('linux: no execute bit, no ending: opens', canOpen('/x/Makefile', false, 0o644, 'linux'));
ok('win: the mode bits mean nothing (Node sets them for every file)', canOpen('C:\\x\\a.txt', false, 0o755, 'win32'));
ok('win: trailing dots and spaces do not hide an ending', !canOpen('C:\\x\\setup.exe.', false, 0o644, 'win32') && !canOpen('C:\\x\\run.bat ', false, 0o644, 'win32'));
eq('extOf', [extOf('/a/b.TXT', 'linux'), extOf('/a/.bashrc', 'linux'), extOf('/a/b', 'linux'), extOf('C:\\a.b\\c', 'win32'), extOf('/a/b.tar.gz', 'linux')], ['txt', '', '', '', 'gz']);

// For real, in a temp folder (this PC's OS)
const root = mkdtempSync(join(tmpdir(), 'pathlinks-test-'));
try {
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'My.app'));
  writeFileSync(join(root, 'docs', 'A.md'), 'x');
  writeFileSync(join(root, 'run.sh'), 'echo hi');
  writeFileSync(join(root, 'tool'), 'x');
  chmodSync(join(root, 'tool'), 0o755);
  writeFileSync(join(root, 'notes.txt'), 'x');
  symlinkSync(join(root, 'run.sh'), join(root, 'innocent.txt'));
  symlinkSync(join(root, 'tool'), join(root, 'innocent2.txt'));
  const hits = await statPaths(root, ['docs/A.md', 'docs', 'nope.md', './notes.txt', '~/definitely-not-here-xyz', '/definitely/not/here', 7], 'linux', '/nonexistent-home');
  eq('statPaths: files and folders found, the rest null, same order', hits, [{ path: join(root, 'docs', 'A.md'), kind: 'file' }, { path: join(root, 'docs'), kind: 'dir' }, null, { path: join(root, 'notes.txt'), kind: 'file' }, null, null, null]);
  eq('statPaths: only the first 50 are looked at', (await statPaths(root, Array(60).fill('notes.txt'), 'linux', '/h')).filter(Boolean).length, 50);
  eq('statPaths: not a list', await statPaths(root, 'x'), []);
  eq('open: a document', await openDecision(join(root, 'docs', 'A.md'), 'linux'), 'open');
  eq('open: a folder', await openDecision(join(root, 'docs'), 'linux'), 'open');
  eq('show: a script by its ending', await openDecision(join(root, 'run.sh'), 'linux'), 'show');
  eq('show: a file with an execute bit', await openDecision(join(root, 'tool'), 'linux'), 'show');
  eq('show: a .app folder', await openDecision(join(root, 'My.app'), 'linux'), 'show');
  eq('show: a harmless name that points at a script', await openDecision(join(root, 'innocent.txt'), 'linux'), 'show');
  eq('show: a harmless name that points at an executable', await openDecision(join(root, 'innocent2.txt'), 'linux'), 'show');
  eq('open: missing', await openDecision(join(root, 'nope'), 'linux'), null);
  const calls: string[] = [];
  const shell = { openPath: async (p: string) => (calls.push(`open ${p}`), ''), showItemInFolder: (p: string) => void calls.push(`show ${p}`) };
  eq('click: document opens', await openPathLink(shell, join(root, 'notes.txt'), 'linux'), 'opened');
  eq('click: script is shown, never opened', await openPathLink(shell, join(root, 'run.sh'), 'linux'), 'shown');
  eq('click: relative path refused', await openPathLink(shell, 'notes.txt', 'linux'), false);
  eq('click: missing refused', await openPathLink(shell, join(root, 'nope.txt'), 'linux'), false);
  eq('click: calls made', calls, [`open ${join(root, 'notes.txt')}`, `show ${join(root, 'run.sh')}`]);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
