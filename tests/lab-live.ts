// Model Lab end to end with REAL models (uses plan quota): npx tsx tests/lab-live.ts [model ids...]
// Runs on a private port with its own lab folder; never touches data/lab or the app on 7337.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lab-live-'));
process.env.PHOSPHOR_LAB_DIR = dir;
const { handleLab, serveLabFile, startLab } = await import('../server/lab.ts');
startLab();
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/lab/v/')) return serveLabFile(res, url);
  void handleLab(req, res, url);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const api = async (path: string, method = 'GET', body?: unknown) => {
  const r = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
};
let fails = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}`);
  if (!ok) fails++;
};

const models = (await api('/api/lab/models')).data;
console.log('models:', models.models.length, 'notes:', models.notes);
const want = process.argv.slice(2).length ? process.argv.slice(2) : ['claude:claude-haiku-5-5', 'codex:gpt-6-luna', 'opencode:opencode-go/kimi-k3.1-pro'];
for (const w of want) check(models.models.some((m: { id: string }) => m.id === w), `model listed: ${w}`);

const prompt = 'Make index.html: a red square in the middle of a black page, plus a script.js that logs "hi". Then reply with one short sentence.';
const made = await api('/api/lab/tests', 'POST', { prompt, models: want, timeLimitMin: 10, blind: false });
check(made.status === 200 && typeof made.data.id === 'string', `test made: ${made.data?.id ?? made.data?.error}`);
const id = made.data.id;
let t;
for (let i = 0; i < 240; i++) {
  t = (await api(`/api/lab/tests/${id}`)).data;
  if (t.results.every((r: { state: string }) => !['queued', 'running'].includes(r.state))) break;
  await new Promise((r) => setTimeout(r, 2000));
}
for (const r of t.results) {
  console.log(`  ${r.modelName} [${r.appName} ${r.appVersion}]: ${r.state} ${Math.round((r.endedAt - r.startedAt) / 1000)}s ${r.tokens} tok value=${r.value} page=${r.page} files=${r.files.map((f: { path: string }) => f.path).join(',')} ${r.error}`);
  console.log(`    reply: ${r.reply.slice(0, 160).replace(/\n/g, ' ')}`);
  check(r.state === 'done', `${r.modelName} done`);
  check(r.page === 'index.html', `${r.modelName} made index.html`);
  if (r.page) {
    const v = await fetch(`${base}${t.view}${r.dir}/${r.page}`);
    check(v.status === 200 && (v.headers.get('content-security-policy') ?? '').startsWith('sandbox'), `${r.modelName} page served sandboxed`);
  }
}
const r0 = t.results[0];
check((await fetch(`${base}/lab/v/wrongkeywrongkeywrongkey/${id}/${r0.dir}/index.html`)).status === 404, 'wrong key refused');
check((await fetch(`${base}${t.view}${r0.dir}/..%2F..%2Ftest.json`)).status === 404, 'path outside files/ refused');
check((await api(`/api/lab/tests/${id}/results/${r0.dir}`, 'PATCH', { stars: 4, note: 'nice' })).status === 200, 'stars saved');
check((await api(`/api/lab/tests/${id}`)).data.results[0].stars === 4, 'stars read back');
check((await api(`/api/lab/tests/${id}/archive`, 'POST')).status === 200, 'archived');
check((await api('/api/lab/tests?archived=1')).data.tests.length === 1, 'in the archive list');
check((await api(`/api/lab/tests/${id}/restore`, 'POST')).status === 200, 'restored');
console.log('storage:', (await api('/api/lab/storage')).data);
check((await api(`/api/lab/tests/${id}`, 'DELETE')).status === 200, 'deleted');
check((await api('/api/lab/tests')).data.tests.length === 0, 'gone from the list');

server.close();
rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
