import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { LAB_MAX_MODELS, LAB_TIME_LIMITS, type LabNewTest, type LabResult, type LabResultFull, type LabStorage, type LabTest, type LabTestFull } from '../shared/lab.ts';
import { buildPage, buildState, JUNK, LAB_DIR, labModels, listFiles, liveOf, markStopped, pickPage, queueRun, readJson, stopRuns, writeJson } from './labrun.ts';

// Model Lab (docs/MODEL-LAB.md): tests and results as plain folders, the /api/lab/* routes, and the file viewer.
// The folder is the truth: data/lab/tests/<year>/<id>/ (or archive/), each with prompt.md, test.json and one folder
// per model (result.json, reply.md, log.jsonl, files/). Moving or deleting a folder by hand is fine.

const exec = promisify(execFile);
const TESTS = join(LAB_DIR, 'tests');
const ARCHIVE = join(LAB_DIR, 'archive');
const SCHEMA = 1;

type Stored = Omit<LabTest, 'results' | 'archived'> & { schema: number; key: string; results: { dir: string }[] };
type Found = { dir: string; archived: boolean };

const ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,70}$/;
const DIR = /^[a-z0-9][a-z0-9._-]{0,90}$/;

function find(id: string): Found | null {
  if (!ID.test(id)) return null;
  for (const [root, archived] of [[TESTS, false], [ARCHIVE, true]] as const) {
    const dir = join(root, id.slice(0, 4), id);
    if (existsSync(join(dir, 'test.json'))) return { dir, archived };
  }
  return null;
}

function all(): Found[] {
  const out: Found[] = [];
  for (const [root, archived] of [[TESTS, false], [ARCHIVE, true]] as const) {
    if (!existsSync(root)) continue;
    for (const year of readdirSync(root)) {
      if (!/^\d{4}$/.test(year)) continue;
      for (const id of readdirSync(join(root, year))) if (ID.test(id) && existsSync(join(root, year, id, 'test.json'))) out.push({ dir: join(root, year, id), archived });
    }
  }
  return out;
}

function load(f: Found): (LabTest & { key: string }) | null {
  const t = readJson<Stored>(join(f.dir, 'test.json'));
  if (!t) return null;
  const results = t.results.map(({ dir }): LabResult => {
    const r = readJson<LabResult>(join(f.dir, dir, 'result.json'));
    const live = r?.state === 'running' ? liveOf(f.dir, dir) : null;
    return r ? { ...r, dir, rank: r.rank ?? 0, tokens: live?.tokens ?? r.tokens } : { ...blank(dir, dir), state: 'failed', error: 'result.json is missing.' };
  });
  return { id: t.id, title: t.title, prompt: t.prompt, at: t.at, archived: f.archived, blind: !!t.blind, revealed: !!t.revealed, timeLimitMin: t.timeLimitMin, results, key: t.key };
}

function blank(dir: string, model: string): LabResult {
  return { dir, model, modelName: model, app: 'claude', appName: '', appVersion: '', account: '', state: 'queued', startedAt: 0, endedAt: 0, tokens: 0, value: null, stars: 0, rank: 0, note: '', error: '' };
}

function full(f: Found): LabTestFull | null {
  const t = load(f);
  if (!t) return null;
  const results = t.results.map((r): LabResultFull => {
    let reply = '';
    try {
      reply = readFileSync(join(f.dir, r.dir, 'reply.md'), 'utf8').slice(0, 200_000);
    } catch {
      /* not finished */
    }
    const root = join(f.dir, r.dir, 'files');
    const files = listFiles(root);
    const { page, buildDir } = pickPage(root, files);
    return { ...r, reply, files, page, build: buildState(join(f.dir, r.dir)), canBuild: buildDir !== null };
  });
  const { key, ...rest } = t;
  return { ...rest, results, folder: f.dir, view: `/lab/v/${key}/${t.id}/` };
}

// ------------------------------------------------------------ changes

const slug = (s: string, max: number, dots = false) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(dots ? /[^a-z0-9.]+/g : /[^a-z0-9]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, max)
    .replace(/[-.]+$/, '') || 'test';

const titleFrom = (prompt: string) => prompt.trim().split('\n')[0].split(/\s+/).slice(0, 8).join(' ').replace(/[.,:;!?]+$/, '').slice(0, 80);

async function create(input: LabNewTest): Promise<string> {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw new Error('The prompt is empty.');
  if (prompt.length > 100_000) throw new Error('The prompt is too long (100,000 characters at most).');
  const ids = [...new Set(Array.isArray(input.models) ? input.models.map(String) : [])];
  if (!ids.length || ids.length > LAB_MAX_MODELS) throw new Error(`Pick 1 to ${LAB_MAX_MODELS} models.`);
  const limit = LAB_TIME_LIMITS.includes(Number(input.timeLimitMin)) ? Number(input.timeLimitMin) : 30;
  const { models } = await labModels();
  const picked = ids.map((id) => models.find((m) => m.id === id));
  if (picked.some((m) => !m)) throw new Error('A picked model is not available now. Reload the list.');
  const title = String(input.title ?? '').trim().slice(0, 120) || titleFrom(prompt);
  const at = Date.now();
  const d = new Date(at);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const base = `${date}-${slug(title, 50)}`;
  let id = base;
  for (let n = 2; find(id) || existsSync(join(TESTS, id.slice(0, 4), id)); n++) id = `${base}-${n}`;
  const dir = join(TESTS, id.slice(0, 4), id);
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  const results = picked.map((m) => {
    let rd = `${slug(m!.id.slice(m!.id.indexOf(':') + 1).split('/').pop()!, 60, true)}--${m!.app}`;
    for (let n = 2; used.has(rd); n++) rd = `${rd.replace(/-\d+$/, '')}-${n}`;
    used.add(rd);
    mkdirSync(join(dir, rd, 'files'), { recursive: true });
    const r: LabResult = { ...blank(rd, m!.id), modelName: m!.name, app: m!.app, appName: m!.appName, account: m!.account };
    writeJson(join(dir, rd, 'result.json'), { schema: SCHEMA, ...r });
    return { dir: rd };
  });
  writeFileSync(join(dir, 'prompt.md'), prompt + '\n');
  const stored: Stored = { schema: SCHEMA, id, title, prompt, at, blind: !!input.blind, revealed: false, timeLimitMin: limit, key: randomBytes(18).toString('base64url'), results };
  writeJson(join(dir, 'test.json'), stored);
  for (const r of results) queueRun({ testDir: dir, dir: r.dir, prompt, timeLimitMin: limit });
  return id;
}

function patchTest(f: Found, body: Record<string, unknown>): void {
  const file = join(f.dir, 'test.json');
  const t = readJson<Stored>(file);
  if (!t) throw new Error('test.json is missing.');
  if (typeof body.blind === 'boolean') t.blind = body.blind;
  if (typeof body.revealed === 'boolean') t.revealed = body.revealed;
  if (typeof body.title === 'string' && body.title.trim()) t.title = body.title.trim().slice(0, 120);
  writeJson(file, t);
  // The best-to-worst order: result folders, best first. Each result.json keeps its own place (rank).
  if (Array.isArray(body.ranking)) {
    const order = body.ranking.map(String);
    for (const { dir } of t.results) {
      const rf = join(f.dir, dir, 'result.json');
      const r = readJson<LabResult>(rf);
      if (r) writeJson(rf, { ...r, rank: order.indexOf(dir) + 1 });
    }
  }
}

// RUN AGAIN: one result from scratch (its files, reply and log go), same prompt and model.
function runAgain(f: Found, dir: string, minutes: unknown): void {
  if (!DIR.test(dir)) throw new Error('No such result.');
  const t = readJson<Stored>(join(f.dir, 'test.json'));
  const rd = join(f.dir, dir);
  const r = readJson<LabResult>(join(rd, 'result.json'));
  if (!t || !r || !t.results.some((x) => x.dir === dir)) throw new Error('No such result.');
  if (r.state === 'running' || r.state === 'queued') throw new Error('It is still running.');
  for (const n of ['files', 'reply.md', 'log.jsonl', 'stderr.txt', 'build.json', 'build.log']) rmSync(join(rd, n), { recursive: true, force: true });
  mkdirSync(join(rd, 'files'));
  writeJson(join(rd, 'result.json'), { ...r, state: 'queued', startedAt: 0, endedAt: 0, tokens: 0, value: null, stars: 0, rank: 0, note: '', error: '' });
  const limit = LAB_TIME_LIMITS.includes(Number(minutes)) ? Number(minutes) : t.timeLimitMin;
  queueRun({ testDir: f.dir, dir, prompt: t.prompt, timeLimitMin: limit });
}

function patchResult(f: Found, dir: string, body: Record<string, unknown>): void {
  if (!DIR.test(dir)) throw new Error('No such result.');
  const file = join(f.dir, dir, 'result.json');
  const r = readJson<LabResult>(file);
  if (!r) throw new Error('No such result.');
  if (typeof body.stars === 'number' && Number.isInteger(body.stars) && body.stars >= 0 && body.stars <= 5) r.stars = body.stars;
  if (typeof body.note === 'string') r.note = body.note.slice(0, 2000);
  writeJson(file, r);
}

function move(f: Found, toArchive: boolean): void {
  if (f.archived === toArchive) return;
  const id = f.dir.split(sep).pop()!;
  const dest = join(toArchive ? ARCHIVE : TESTS, id.slice(0, 4), id);
  if (existsSync(dest)) throw new Error('A folder with that name is already there.');
  mkdirSync(join(dest, '..'), { recursive: true });
  renameSync(f.dir, dest);
}

// Junk folders inside the results' files/ (it does not look inside them).
function junkDirs(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (!lstatSync(p, { throwIfNoEntry: false })?.isDirectory()) continue; // lstat: never through a symlink
      if (JUNK.has(n)) out.push(p);
      else walk(p, depth + 1);
    }
  };
  for (const d of dirs) {
    const t = readJson<Stored>(join(d, 'test.json'));
    for (const r of t?.results ?? []) walk(join(d, r.dir, 'files'), 0);
  }
  return out;
}

async function du(paths: string[]): Promise<number> {
  if (!paths.length) return 0;
  try {
    const out = (await exec('du', ['-sbc', ...paths], { timeout: 60000, maxBuffer: 8 << 20 })).stdout.trim().split('\n');
    return Number(out.at(-1)?.split(/\s/)[0]) || 0;
  } catch {
    return 0;
  }
}

async function storage(): Promise<LabStorage> {
  const tests = all();
  return {
    tests: tests.filter((t) => !t.archived).length,
    archived: tests.filter((t) => t.archived).length,
    bytes: await du(tests.map((t) => t.dir)),
    junkBytes: await du(junkDirs(tests.map((t) => t.dir))),
  };
}

function removeJunk(dirs: string[]): number {
  const found = junkDirs(dirs);
  for (const p of found) rmSync(p, { recursive: true, force: true });
  return found.length;
}

// ------------------------------------------------------------ HTTP

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
}

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 1_000_000) req.destroy(new Error('too big'));
    });
    req.on('end', () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch {
        no(new Error('Bad JSON.'));
      }
    });
    req.on('error', no);
  });
}

export function startLab(): void {
  markStopped(all().map((t) => t.dir));
}

export async function handleLab(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const m = req.method ?? 'GET';
  const parts = url.pathname.split('/').slice(3).map(decodeURIComponent); // after /api/lab/
  try {
    if (parts[0] === 'models' && m === 'GET') return json(res, await labModels());
    if (parts[0] === 'storage' && m === 'GET') return json(res, await storage());
    if (parts[0] === 'junk' && m === 'POST') return json(res, { removed: removeJunk(all().map((t) => t.dir)) });
    if (parts[0] !== 'tests') return json(res, { error: 'not found' }, 404);
    if (parts.length === 1) {
      if (m === 'GET') {
        const archived = url.searchParams.has('archived');
        const list = all()
          .filter((t) => t.archived === archived)
          .map(load)
          .filter((t) => t !== null)
          .map(({ key: _, ...t }) => t)
          .sort((a, b) => b.at - a.at);
        return json(res, { tests: list });
      }
      if (m === 'POST') return json(res, { id: await create((await body(req)) as unknown as LabNewTest) });
    }
    const f = find(parts[1] ?? '');
    if (!f) return json(res, { error: 'No such test.' }, 404);
    if (parts.length === 2) {
      if (m === 'GET') return json(res, full(f));
      if (m === 'PATCH') return (patchTest(f, await body(req)), json(res, { ok: true }));
      if (m === 'DELETE') {
        stopRuns(f.dir);
        rmSync(f.dir, { recursive: true, force: true });
        return json(res, { ok: true });
      }
    }
    if (parts.length === 3 && m === 'POST') {
      if (parts[2] === 'archive' || parts[2] === 'restore') return (move(f, parts[2] === 'archive'), json(res, { ok: true }));
      if (parts[2] === 'stop') return (stopRuns(f.dir), json(res, { ok: true }));
      if (parts[2] === 'junk') return json(res, { removed: removeJunk([f.dir]) });
    }
    if (parts[2] === 'results' && parts[3]) {
      if (parts.length === 4 && m === 'PATCH') return (patchResult(f, parts[3], await body(req)), json(res, { ok: true }));
      if (parts.length === 5 && parts[4] === 'again' && m === 'POST') return (runAgain(f, parts[3], (await body(req)).timeLimitMin), json(res, { ok: true }));
      if (parts.length === 5 && parts[4] === 'build' && m === 'POST' && DIR.test(parts[3])) {
        const root = join(f.dir, parts[3], 'files');
        const { buildDir } = pickPage(root, listFiles(root));
        if (buildDir === null) return json(res, { error: 'Nothing to build: no package.json with a build script.' }, 400);
        void buildPage(join(f.dir, parts[3]), buildDir);
        return json(res, { ok: true });
      }
      if (parts.length === 5 && parts[4] === 'log' && m === 'GET' && DIR.test(parts[3])) {
        let log = '';
        try {
          log = readFileSync(join(f.dir, parts[3], 'log.jsonl'), 'utf8');
        } catch {
          /* none yet */
        }
        let err = '';
        try {
          err = readFileSync(join(f.dir, parts[3], 'stderr.txt'), 'utf8');
        } catch {
          /* none */
        }
        let build = '';
        try {
          build = readFileSync(join(f.dir, parts[3], 'build.log'), 'utf8');
        } catch {
          /* never built */
        }
        return json(res, { log: log.length > 400_000 ? `…\n${log.slice(-400_000)}` : log, stderr: err.slice(-20_000), build: build.slice(-40_000) });
      }
    }
    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    return json(res, { error: e instanceof Error ? e.message : String(e) }, 400);
  }
}

// ------------------------------------------------------------ the file viewer

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

// A sandboxed page has no origin, so it cannot keep anything in localStorage: reading it throws, and many pages stop
// right there. This puts a stand-in (kept in memory for the page's life) in front of each page.
const STORAGE_SHIM =
  '<script>(function(){function m(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(_){}}})})();</script>';

// Built sites (Vite and the like) point at "/assets/...": the root of a website. Here a site lives under
// /lab/v/<key>/<test>/<result>/<folder>/, so those paths are pointed at the site's own folder (the nearest folder
// above the file that has an index.html). Only what is sent changes, never the file on disk.
function rewrite(text: string, type: string, site: string): string {
  if (type.startsWith('text/html')) {
    text = text.replace(/(\s(?:src|href|poster|action|data-src)\s*=\s*)(["'])\/(?!\/)/gi, `$1$2${site}/`).replace(/url\(\s*(["']?)\/(?!\/)/g, `url($1${site}/`);
    const head = text.search(/<head[^>]*>/i);
    if (head >= 0) {
      const end = text.indexOf('>', head) + 1;
      return text.slice(0, end) + STORAGE_SHIM + text.slice(end);
    }
    return STORAGE_SHIM + text;
  }
  if (type.startsWith('text/css')) return text.replace(/url\(\s*(["']?)\/(?!\/)/g, `url($1${site}/`).replace(/@import\s+(["'])\/(?!\/)/g, `@import $1${site}/`);
  if (type.startsWith('text/javascript')) return text.replace(/(["'`])\/assets\//g, `$1${site}/assets/`);
  return text;
}

// A page a model made is unknown code. It is served sandboxed (no origin: it cannot use the login or call the API),
// framed only by this app. The key in the path stands in for the login, because a sandboxed page's own requests
// (its scripts, pictures) carry no cookie. One key opens one test, read-only. Any origin may read the files
// (Access-Control-Allow-Origin *): the sandboxed page itself counts as another origin, and module scripts,
// "crossorigin" style sheets and fetch() all need that. The key is still the lock.
export function serveLabFile(res: ServerResponse, url: URL): void {
  const [key = '', id = '', dir = '', ...rest] = url.pathname.split('/').slice(3).map(decodeURIComponent);
  const f = find(id);
  const t = f && readJson<Stored>(join(f.dir, 'test.json'));
  const ok = !!t && DIR.test(dir) && key.length === t.key.length && timingSafeEqual(Buffer.from(key), Buffer.from(t.key));
  if (!ok) return void res.writeHead(404).end('Not found');
  // Real paths: a model can leave a symlink in its folder that points at any file on the PC. Never follow one out.
  const inside = (p: string, root: string) => p === root || p.startsWith(root + sep);
  let root = '';
  let file = '';
  try {
    root = realpathSync(resolve(f.dir, dir, 'files'));
    file = realpathSync(resolve(root, ...rest));
    if (inside(file, root) && statSync(file).isDirectory()) file = realpathSync(join(file, 'index.html'));
  } catch {
    return void res.writeHead(404).end('Not found');
  }
  if (!inside(file, root) || !statSync(file).isFile()) return void res.writeHead(404).end('Not found');
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  let body: Buffer | string = readFileSync(file);
  if (/^text\/(html|css|javascript)/.test(type)) {
    let siteDir = file.slice(0, file.lastIndexOf(sep));
    for (let d = siteDir; inside(d, root); d = d.slice(0, d.lastIndexOf(sep)))
      if (existsSync(join(d, 'index.html'))) {
        siteDir = d;
        break;
      }
    if (!existsSync(join(siteDir, 'index.html'))) siteDir = root;
    const rel = siteDir.slice(root.length).split(sep).filter(Boolean).map(encodeURIComponent);
    const site = ['/lab/v', key, id, dir, ...rel].join('/');
    body = rewrite(body.toString('utf8'), type, site);
  }
  res.removeHeader('X-Frame-Options');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-modals allow-pointer-lock; frame-ancestors 'self'",
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
