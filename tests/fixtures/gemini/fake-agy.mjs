#!/usr/bin/env node
// Stand-in for agy in tests/geminichat.ts. `models` prints models.txt. Otherwise it plays the recorded run named by
// FAKE_AGY_RUN (<name>.jsonl in this folder): JSON lines to stdout ({{CWD}} = the folder it runs in, {{BRAIN}} =
// FAKE_AGY_BRAIN), "#stderr <text>" to stderr, "#picture <path>" saves a tiny PNG there (what agy's picture helper does),
// "#wait" waits for SIGINT (STOP), "#exit <code>" ends. Each run's arguments go to FAKE_AGY_LOG, one JSON line.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\n`);
if (args[0] === 'models') {
  process.stderr.write('Fetching available models...\n');
  process.stdout.write(readFileSync(join(here, 'models.txt')));
  process.exit(0);
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
let interrupted;
const stopped = new Promise((resolve) => (interrupted = resolve));
process.on('SIGINT', () => interrupted());
const text = readFileSync(join(here, `${process.env.FAKE_AGY_RUN ?? 'chat'}.jsonl`), 'utf8')
  .replaceAll('{{CWD}}', process.cwd())
  .replaceAll('{{BRAIN}}', process.env.FAKE_AGY_BRAIN ?? '/nowhere');
for (const line of text.split('\n').filter(Boolean)) {
  if (line === '#wait') {
    const alive = setInterval(() => {}, 60_000); // a signal handler alone does not keep Node running
    await stopped;
    clearInterval(alive);
  } else if (line.startsWith('#stderr ')) process.stderr.write(`${line.slice(8)}\n`);
  else if (line.startsWith('#picture ')) {
    mkdirSync(dirname(line.slice(9)), { recursive: true });
    writeFileSync(line.slice(9), Buffer.from(PNG, 'base64'));
  } else if (line.startsWith('#exit ')) process.exit(Number(line.slice(6)));
  else {
    process.stdout.write(`${line}\n`);
    await new Promise((r) => setTimeout(r, 3));
  }
}
