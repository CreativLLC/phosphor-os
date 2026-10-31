// Clickable paths in replies (desktop app only): file and folder paths in a message become links when they exist on
// this PC. A click opens a folder in the file manager and a file in its default app (a file that could run code is
// only shown in its folder); a small folder icon next to a file shows it in its folder. Which words count as paths
// and the open rule are in shared/pathlinks.mjs; the desktop app answers which exist (shell/pathlinks.mjs), one call
// for each message. In a browser or on the phone there is no bridge and the text stays as it is.

import { MAX_CANDIDATES, inlineCodePath, linkTargetPath, scanPaths } from '../../shared/pathlinks.mjs';
import { shellApi } from './shellapi.ts';
import { store } from './store.ts';
import { toast } from './ui.ts';

type Hit = { path: string; kind: 'file' | 'dir' };
type Found = { raw: string; line: number; col: number };

const TAG = '#phosphor-path:';

export const pathLinksOn = (): boolean => !!(shellApi?.statPaths && shellApi.openPath && shellApi.platform);

// A markdown link whose target is a path (or file:// address) gets a marker address, so it survives the sanitizer
// (which drops file: addresses); linkPaths then makes it a path link, or plain text when nothing is there.
export function markPathHref(href: string): string | null {
  const found = pathLinksOn() ? linkTargetPath(href, shellApi!.platform!) : null;
  return found ? TAG + encodeURIComponent(JSON.stringify(found)) : null;
}

// What the desktop app said lately, so a message that is drawn again (while it streams in) links at once.
const cache = new Map<string, { at: number; hit: Hit | null }>();
const HIT_MS = 30_000;
const MISS_MS = 4_000;
const fresh = (cwd: string, raw: string): Hit | null | undefined => {
  const c = cache.get(`${cwd}\0${raw}`);
  return c && Date.now() - c.at < (c.hit ? HIT_MS : MISS_MS) ? c.hit : undefined;
};

const draw = new WeakMap<HTMLElement, number>(); // a newer draw of the same body wins

type Job =
  | { kind: 'a'; el: HTMLAnchorElement; found: Found }
  | { kind: 'code'; el: HTMLElement; found: Found }
  | { kind: 'text'; node: Text; found: (Found & { start: number; end: number })[] };

export function linkPaths(body: HTMLElement): void {
  const api = shellApi;
  if (!api?.statPaths || !api.openPath || !api.platform) return;
  const platform = api.platform;
  const jobs: Job[] = [];
  for (const a of body.querySelectorAll<HTMLAnchorElement>(`a[href^="${TAG}"]`)) {
    let found: Found | null = null;
    try {
      found = JSON.parse(decodeURIComponent(a.getAttribute('href')!.slice(TAG.length)));
    } catch {}
    if (found?.raw) jobs.push({ kind: 'a', el: a, found });
    else unwrap(a);
  }
  for (const c of body.querySelectorAll<HTMLElement>('code')) {
    if (c.closest('pre, a')) continue;
    const found = inlineCodePath(c.textContent ?? '', platform);
    if (found) jobs.push({ kind: 'code', el: c, found });
  }
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.parentElement as Element).closest('pre, code, a, button')) continue;
    const found = scanPaths(n.nodeValue ?? '', platform);
    if (found.length) jobs.push({ kind: 'text', node: n as Text, found });
  }
  if (!jobs.length) return;

  const all = jobs.flatMap((j) => (j.kind === 'text' ? j.found.map((f) => f.raw) : [j.found.raw]));
  const raws = [...new Set(all)].slice(0, MAX_CANDIDATES);
  const cwd = store.current()?.info.cwd ?? '';
  const mine = (draw.get(body) ?? 0) + 1;
  draw.set(body, mine);
  const done = (got: Map<string, Hit | null>) => {
    if (draw.get(body) === mine) apply(jobs, got);
  };

  const known = new Map<string, Hit | null>();
  const need: string[] = [];
  for (const r of raws) {
    const c = fresh(cwd, r);
    if (c === undefined) need.push(r);
    else known.set(r, c);
  }
  if (!need.length) return done(known);
  api.statPaths(cwd, need).then(
    (res) => {
      need.forEach((r, i) => {
        const hit = res?.[i] ?? null;
        cache.set(`${cwd}\0${r}`, { at: Date.now(), hit });
        known.set(r, hit);
      });
      done(known);
    },
    () => done(known), // no answer: no links, and no marked links left behind
  );
}

function apply(jobs: Job[], got: Map<string, Hit | null>): void {
  for (const j of jobs) {
    if (j.kind === 'a') {
      const hit = got.get(j.found.raw);
      if (hit) {
        j.el.removeAttribute('href');
        j.el.removeAttribute('target');
        j.el.removeAttribute('rel');
        makeLink(j.el, hit, j.found.line);
      } else unwrap(j.el);
    } else if (j.kind === 'code') {
      const hit = got.get(j.found.raw);
      if (hit) makeLink(j.el, hit, j.found.line);
    } else {
      // From the end, so the earlier positions still fit.
      for (const f of [...j.found].reverse()) {
        const hit = got.get(f.raw);
        if (!hit) continue;
        j.node.splitText(f.end);
        const mid = j.node.splitText(f.start);
        const span = document.createElement('span');
        span.textContent = mid.nodeValue;
        mid.replaceWith(span);
        makeLink(span, hit, f.line);
      }
    }
  }
}

function unwrap(a: HTMLElement): void {
  a.replaceWith(...a.childNodes);
}

const svg = (d: string) =>
  `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" shape-rendering="crispEdges" aria-hidden="true">${d}</svg>`;
const FOLDER_ICON = svg('<path d="M1.5 3.5H6.5L8 5.5H14.5V12.5H1.5Z"/>');

function makeLink(el: HTMLElement, hit: Hit, line: number): void {
  const api = shellApi!;
  const name = hit.path.split(/[\\/]/).filter(Boolean).pop() ?? hit.path;
  el.classList.add('path-link');
  el.dataset.kind = hit.kind;
  el.setAttribute('role', 'link');
  el.tabIndex = 0;
  el.title = `Open ${name}${line ? ` (line ${line})` : ''}`;
  const go = () => void open(hit.path);
  el.onclick = (e) => {
    e.preventDefault();
    go();
  };
  el.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    go();
  };
  if (hit.kind === 'file' && api.showInFolder) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'path-dir';
    btn.innerHTML = FOLDER_ICON;
    btn.title = 'Show in folder';
    btn.setAttribute('aria-label', 'Show in folder');
    btn.onclick = () => void api.showInFolder!(hit.path).then((ok) => ok || toast("Couldn't open the file manager."));
    el.after(btn);
  }
}

async function open(path: string): Promise<void> {
  let res: 'opened' | 'shown' | false = false;
  try {
    res = (await shellApi?.openPath?.(path)) ?? false;
  } catch {}
  if (res === 'shown') toast('Not opened: this kind of file can run code. Shown in its folder.');
  else if (!res) toast("Couldn't open it. It may have moved.");
}
