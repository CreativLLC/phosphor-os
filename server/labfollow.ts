import { execFile } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { LabResult, LabVersion } from '../shared/lab.ts';
import { JUNK, listFiles, pickPage, readJson } from './labrun.ts';

// LAB FOLLOW UP and versions (docs/MODEL-LAB.md section 5). A follow-up runs a result's model again in the same files
// folder, with more words from the owner. The app's own session cannot go on: it lived in the box's HOME, which is
// deleted after every run (keeping it would keep sign-in material on disk). So the prompt carries the context and the
// folder carries the work. Before a follow-up or RUN AGAIN, the result as it is is kept as a version:
// <result>/versions/<n>/ with the result.json, reply.md, log.jsonl and files/ it had.

const exec = promisify(execFile);
const REPLY_PART = 1500; // characters of the last reply that go into a follow-up's prompt
const EARLIER_PART = 1000; // characters of each earlier follow-up

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

// The prompt for a follow-up: a note that its earlier work is in this folder and should be changed, not made again;
// the task; the earlier follow-ups (they still hold); the start of its last reply, or how its last run ended; and the
// new words last.
export function followUpPrompt(task: string, last: Pick<LabResult, 'state' | 'timeUp' | 'error' | 'followUps'>, reply: string, text: string): string {
  const ended = last.timeUp
    ? 'The time limit stopped your last run before it finished.'
    : last.state === 'limit'
      ? 'Your last run stopped at a usage limit before it finished.'
      : last.state === 'stopped'
        ? 'Your last run was stopped before it finished.'
        : last.state === 'failed'
          ? `Your last run failed${(last.error ?? '').trim() ? `: ${cut(last.error.trim(), 300)}` : '.'}`
          : '';
  const parts = [
    'This is a follow-up to a task you worked on before. Whatever you made for it is still in this folder (your current working folder). Build on that work to do what the follow-up asks: change the existing files, do not start over, and do not make a new copy of the project next to the old one. Keep what already works. When you are done, reply with a short note of what you changed.',
    `<original_task>\n${task.trim()}\n</original_task>`,
  ];
  if (last.followUps.length) parts.push(`<earlier_follow_ups>\nYou already did these; keep their changes.\n${last.followUps.map((u, i) => `${i + 1}. ${cut(u.text.trim(), EARLIER_PART)}`).join('\n')}\n</earlier_follow_ups>`);
  parts.push(`<your_last_reply>\n${[cut(reply.trim(), REPLY_PART) || '(none)', ended].filter(Boolean).join('\n\n')}\n</your_last_reply>`);
  parts.push(`<follow_up>\n${text.trim()}\n</follow_up>`);
  return parts.join('\n\n');
}

// The versions kept in a result folder, oldest first.
export function versionNumbers(resultDir: string): number[] {
  try {
    return readdirSync(join(resultDir, 'versions'))
      .filter((n) => /^[1-9]\d{0,5}$/.test(n))
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// Keeps the result as it is now as versions/<n>/ and gives n. Its reply, log and build notes move there and its
// result.json is copied. files/ is copied when the model works on in it (a follow-up), or moves there when the next run
// starts empty (RUN AGAIN). The version fills a hidden folder first, so a half-made one is never listed.
export async function saveVersion(resultDir: string, copyFiles: boolean): Promise<number> {
  const root = join(resultDir, 'versions');
  const n = (versionNumbers(resultDir).at(-1) ?? 0) + 1;
  const tmp = join(root, `.${n}`);
  rmSync(tmp, { recursive: true, force: true }); // left by a crash
  mkdirSync(tmp, { recursive: true });
  const files = join(resultDir, 'files');
  try {
    if (!existsSync(files)) mkdirSync(join(tmp, 'files'));
    else if (copyFiles) await copyTree(files, join(tmp, 'files'));
    else renameSync(files, join(tmp, 'files'));
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`Its earlier version could not be kept, so nothing changed: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const name of ['reply.md', 'log.jsonl', 'stderr.txt', 'build.json', 'build.log']) if (existsSync(join(resultDir, name))) renameSync(join(resultDir, name), join(tmp, name));
  copyFileSync(join(resultDir, 'result.json'), join(tmp, 'result.json'));
  renameSync(tmp, join(root, String(n)));
  return n;
}

// A copy of a folder that costs no space on a disk that can share data between files (reflinks: btrfs, XFS): the
// copy and the original share it until one of them changes. A disk that cannot (ext4) gets a plain copy without the
// build junk (node_modules and the like: one install makes them again).
export async function copyTree(from: string, to: string): Promise<void> {
  try {
    await exec('cp', ['-a', '--reflink=always', '--', from, to], { timeout: 10 * 60_000, maxBuffer: 1 << 20 });
  } catch {
    rmSync(to, { recursive: true, force: true }); // what it had copied when it failed
    await copyPlain(from, to);
  }
}

// copyTree without reflinks: every file but the junk folders. A link is copied as a link, never followed.
export function copyPlain(from: string, to: string): Promise<void> {
  const keep = (p: string) => !JUNK.has(basename(p)) || !lstatSync(p).isDirectory();
  return cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE, filter: keep });
}

// Every kept version, oldest first, with its reply and page.
export function versionsOf(resultDir: string): LabVersion[] {
  return versionNumbers(resultDir).flatMap((n): LabVersion[] => {
    const dir = join(resultDir, 'versions', String(n));
    const r = readJson<LabResult>(join(dir, 'result.json'));
    if (!r) return [];
    let reply = '';
    try {
      reply = readFileSync(join(dir, 'reply.md'), 'utf8').slice(0, 200_000);
    } catch {
      /* it had none */
    }
    const files = join(dir, 'files');
    return [{ ...r, rank: r.rank ?? 0, timeUp: r.timeUp ?? false, effort: r.effort ?? '', followUps: r.followUps ?? [], n, reply, page: pickPage(files, listFiles(files)).page }];
  });
}

// The folder the lab's own page build made (dist/, build/ or out/ around the page it shows), or ''. A follow-up deletes
// it from files/ once the version holds a copy: the model changes the source, and the old build would still show.
export function labBuildDir(resultDir: string): string {
  if (readJson<{ state?: string }>(join(resultDir, 'build.json'))?.state !== 'done') return '';
  const root = join(resultDir, 'files');
  return /^((?:.+\/)?(?:dist|build|out))\/index\.html$/i.exec(pickPage(root, listFiles(root)).page)?.[1] ?? '';
}
