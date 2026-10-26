// STATION > Unraid (server/unraidapi.ts, server/unraid.ts) and the 24-hour strip (server/stationhealth.ts).
// Made-up data only: answers shaped like Unraid's GraphQL API (tests/fixtures/unraid, from github.com/unraid/api's
// generated schema), a fake `send`, and mock servers on 127.0.0.1 with a made-up key. It never connects to anything
// else, and never to a real Unraid.
//   npx tsx tests/station-unraid.ts

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { UnraidAlert, UnraidDisk, UnraidSummary } from '../shared/unraid.ts';
import { Health } from '../server/stationhealth.ts';
import { UnraidWatch, takeSetup, unraidRoute } from '../server/unraid.ts';
import { Link, NetError, PARTS, QUERIES, askPart, graphqlUrl, httpSend, netNote, parseDoc, parseUnraid, queryFor, unraidAlerts, type Part, type Reply, type Send } from '../server/unraidapi.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail: unknown = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const eq = (what: string, got: unknown, want: unknown) => check(what, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const KEY = 'KEY-6f1d0c2e-91ab-4c77-8e3d-secret'; // made up
const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const HOUR = 3_600_000;

type Rec = Record<string, unknown>;
const fx = (name: string): Rec => JSON.parse(readFileSync(new URL(`./fixtures/unraid/${name}.json`, import.meta.url), 'utf8'));
const FIX: Record<Part, Rec> = { system: fx('system'), array: fx('array'), parity: fx('parity'), disks: fx('disks'), metrics: fx('metrics'), docker: fx('docker'), vms: fx('vms'), notices: fx('notices'), ups: fx('ups') };
const dataOf = (part: Part): Rec => FIX[part].data as Rec;
const allData = (): Partial<Record<Part, Rec>> => Object.fromEntries(PARTS.map((p) => [p, dataOf(p)]));

// The part a question is about: the first thing it asks for.
const ROOT: Record<string, Part> = { info: 'system', vars: 'system', display: 'system', array: 'array', parityHistory: 'parity', disks: 'disks', metrics: 'metrics', docker: 'docker', vms: 'vms', notifications: 'notices', upsDevices: 'ups' };
const partOf = (q: string): Part => ROOT[/^\s*\{\s*(\w+)/.exec(q)?.[1] ?? '']!;

// A GraphQL server answers with exactly the fields asked: cut a fixture down to the question.
type Sel = ReturnType<typeof parseDoc>[number];
function project(v: unknown, sels: Sel[]): unknown {
  if (Array.isArray(v)) return v.map((x) => project(x, sels));
  if (!v || typeof v !== 'object') return v;
  const o = v as Rec;
  return Object.fromEntries(sels.filter((s) => s.name in o).map((s) => [s.name, s.kids ? project(o[s.name], s.kids) : o[s.name]]));
}
const answer = (q: string): Reply => ({ status: 200, body: JSON.stringify({ data: project(dataOf(partOf(q)), parseDoc(q)) }) });
const reply = (body: unknown, status = 200): Reply => ({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ---------------------------------------------------------------- the questions

{
  eq('queries: nine parts', PARTS.length, 9);
  const all = PARTS.map((p) => QUERIES[p]).join('\n');
  check('queries: read-only (no mutation, subscription or fragment)', !/mutation|subscription|fragment|\.\.\./i.test(all));
  for (const word of ['csrfToken', 'regGuid', 'flashGuid', 'apiKeys', 'registration', 'owner', 'serialNum', 'keyFile', 'apikey', 'logFile']) check(`queries: never ask for ${word}`, !all.includes(word));
  for (const p of PARTS) {
    const q = queryFor(p);
    check(`queries: ${p} is one balanced document`, q.startsWith('{ ') && q.endsWith(' }') && (q.match(/{/g) ?? []).length === (q.match(/}/g) ?? []).length, q);
  }
  eq('queries: a small one reads back as written', queryFor('parity'), '{ parityHistory { date duration speed status errors } }');
  check('prune: a field goes everywhere it is', !/isSpinning/.test(queryFor('array', new Set(['isSpinning']))) && /numErrors/.test(queryFor('array', new Set(['isSpinning']))));
  check('prune: a whole block goes', !/caches/.test(queryFor('array', new Set(['caches']))) && /parities/.test(queryFor('array', new Set(['caches']))));
  eq('prune: an object left empty goes with its last field', queryFor('metrics', new Set(['percentTotal', 'used', 'total'])), '');
  eq('prune: every root field gone = no question', queryFor('ups', new Set(['upsDevices'])), '');
  check('prune: other parts are unaffected', queryFor('docker', new Set(['isSpinning'])) === queryFor('docker'));
}

// ---------------------------------------------------------------- the address

{
  const u = (s: string) => graphqlUrl(s)?.href ?? null;
  eq('url: number address', u('192.168.1.10'), 'http://192.168.1.10/graphql');
  eq('url: with port and trailing slash', u('http://tower.local:8080/'), 'http://tower.local:8080/graphql');
  eq('url: https stays', u('https://tower.example.net'), 'https://tower.example.net/graphql');
  eq('url: /graphql already there', u('http://tower/graphql'), 'http://tower/graphql');
  eq('url: reverse proxy folder gets /graphql', u('https://home.example.net/unraid/'), 'https://home.example.net/unraid/graphql');
  eq('url: query and hash dropped', u('http://tower/?a=1#x'), 'http://tower/graphql');
  eq('url: nothing', u('  '), null);
  eq('url: not http', u('ftp://tower'), null);
  eq('url: with a login in it', u('http://me:pw@tower'), null);
  eq('url: junk', u('http://'), null);
}

// ---------------------------------------------------------------- the answers -> the summary

const full = parseUnraid(allData(), NOW);
{
  eq('system: host and version', [full.host, full.version], ['Tower', '7.2.0']);
  eq('system: uptime from boot time and the server clock (12 d 3.5 h)', full.uptimeSec, 12 * 86400 + 12600);
  eq('system: temperature limits from Unraid', [full.hotC, full.maxC], [45, 55]);
  eq('array: started, capacity', full.array, { state: 'STARTED', started: true, usedKb: 21474836480, totalKb: 46875541296 });
  eq('disks: parity, then data in slot order, an empty slot left out', full.disks.map((d) => d.name), ['parity', 'disk1', 'disk2', 'disk3', 'disk4']);
  eq('pools: the cache', full.pools.map((d) => d.name), ['cache']);
  const [parity, disk1, disk2, disk3, disk4] = full.disks;
  eq('disk: parity has no file system, spun down, SMART from the second list', [parity.usedKb, parity.fsKb, parity.spin, parity.smart, parity.tempC, parity.role], [null, null, 'down', 'ok', 34, 'parity']);
  eq('disk: a data disk', [disk1.device, disk1.sizeKb, disk1.usedKb, disk1.fsKb, disk1.tempC, disk1.spin, disk1.smart, disk1.errors, disk1.ssd], ['sdc', 11718885324, 8400000000, 11680000000, 36, 'up', 'ok', 0, false]);
  eq('disk: temperature only when it is a number', [disk2.tempC, disk3.tempC], [47, null]);
  eq('disk: spun down', disk3.spin, 'down');
  eq('disk: errors counted, SMART unknown stays unknown', [disk4.errors, disk4.smart], [12, 'unknown']);
  eq('pool: NVMe is an SSD', [full.pools[0].ssd, full.pools[0].device, full.pools[0].tempC], [true, 'nvme0n1', 41]);
  eq('parity: not running, last check is the newest one whatever the list order', [full.parity?.running, full.parity?.last?.result, full.parity?.last?.at, full.parity?.last?.durationSec, full.parity?.last?.speed], [false, 'ok', Date.parse('2026-10-01T04:20:00.000Z'), 52440, '89.2']);
  eq('cpu and memory', [full.cpuPct, full.mem], [12.4, { pct: 41.7, usedBytes: 13421772800, totalBytes: 32212254720 }]);
  eq('containers: sorted, slash cut, states', full.containers?.map((c) => [c.name, c.state, c.autoStart]), [['nextcloud', 'stopped', true], ['old-test', 'stopped', false], ['plex', 'running', true], ['radarr', 'paused', true], ['sonarr', 'running', true]]);
  eq('containers: Docker\'s own words kept', full.containers?.[0].detail, 'Exited (137) 5 minutes ago');
  eq('vms: sorted, crashed is its own state', full.vms?.map((v) => [v.name, v.state]), [['Home Assistant', 'stopped'], ['Test Box', 'crashed'], ['Windows 11', 'running']]);
  eq('notices: unread counts and the latest', [full.notices?.warning, full.notices?.alert, full.notices?.latest.length, full.notices?.latest[0].level], [1, 0, 1, 'warning']);
  eq('ups: online', [full.ups[0].name, full.ups[0].onBattery, full.ups[0].chargePct, full.ups[0].runtimeSec, full.ups[0].loadPct], ['Back-UPS', false, 100, 2400, 18]);
  check('nothing in the summary looks like a key, address or serial', !/KEY-|http|192\.168|serial/i.test(JSON.stringify(full)));
}

// Missing, odd and old.
{
  const none = parseUnraid({}, NOW);
  eq('nothing answered: empty, not an error', [none.host, none.array, none.parity, none.disks, none.pools, none.cpuPct, none.mem, none.containers, none.vms, none.notices, none.ups], ['', null, null, [], [], null, null, null, null, null, []]);
  eq('nothing answered: Unraid\'s own default limits', [none.hotC, none.maxC], [45, 55]);
  eq('nothing answered: no alerts', unraidAlerts(none, NOW), []);

  const junk = parseUnraid({ system: { info: 'x', vars: [], display: 7 }, array: { array: { state: 5, disks: 'no', caches: [null, 3, { name: 'cache' }] } }, docker: { docker: { containers: [{ names: 'plex', state: 'WHAT' }, { state: 'RUNNING' }, 'x'] } }, vms: { vms: { domain: [{ name: 'old style', state: 'IDLE' }] } }, metrics: { metrics: { cpu: { percentTotal: 'high' }, memory: { percentTotal: '55.5', used: 'lots' } } }, notices: { notifications: { overview: 3, warningsAndAlerts: [{ importance: 'ALERT' }] } }, ups: { upsDevices: [{ status: 'On Battery', battery: { chargeLevel: 'x' } }] } }, NOW);
  eq('odd: array without a state is no array', junk.array, null);
  eq('odd: a disk with nothing but a name', junk.pools.map((d) => [d.name, d.errors, d.status, d.tempC, d.usedKb, d.spin, d.smart]), [['cache', 0, 'ok', null, null, null, 'unknown']]);
  eq('odd: a container named by a plain string, unknown state = stopped, nameless dropped', junk.containers?.map((c) => [c.name, c.state]), [['plex', 'stopped']]);
  eq('odd: older vms shape (domain), IDLE counts as running', junk.vms, [{ name: 'old style', state: 'running' }]);
  eq('odd: numbers sent as text still count, words do not', [junk.cpuPct, junk.mem?.pct, junk.mem?.usedBytes], [null, 55.5, null]);
  eq('odd: notices with no counts', [junk.notices?.warning, junk.notices?.alert, junk.notices?.latest[0].level], [0, 0, 'alert']);
  eq('odd: UPS on battery from its status, missing numbers null', [junk.ups[0].name, junk.ups[0].onBattery, junk.ups[0].chargePct], ['UPS', true, null]);

  // An old Unraid: no isSpinning, no warningsAndAlerts (asked without them).
  const oldArray = JSON.parse(JSON.stringify(dataOf('array')));
  for (const d of [...oldArray.array.parities, ...oldArray.array.disks, ...oldArray.array.caches]) delete d.isSpinning;
  const old = parseUnraid({ ...allData(), array: oldArray, notices: { notifications: { overview: { unread: { warning: 2, alert: 1 } } } } }, NOW);
  eq('old Unraid: spin state comes from the second list instead', old.disks.map((d) => d.spin), ['down', 'up', 'up', 'down', 'up']);
  eq('old Unraid: counts without the list of titles', [old.notices?.warning, old.notices?.alert, old.notices?.latest], [2, 1, []]);

  const fahrenheit = parseUnraid({ system: { display: { unit: 'FAHRENHEIT', hot: 113, max: 131 } } }, NOW);
  eq('Fahrenheit limits are not used as Celsius', [fahrenheit.hotC, fahrenheit.maxC], [45, 55]);
  const custom = parseUnraid({ system: { display: { unit: 'CELSIUS', hot: 40, max: 50 } } }, NOW);
  eq('Celsius limits from Unraid are used', [custom.hotC, custom.maxC], [40, 50]);

  const bad = parseUnraid({ array: { array: { state: 'STARTED', parities: [{ name: 'parity', device: '/dev/sdb', status: 'DISK_DSBL' }], disks: [{ name: 'disk1', status: 'DISK_WRONG' }, { name: 'disk2', status: 'DISK_NP_MISSING' }, { name: 'disk3', status: 'DISK_NEW' }, { name: 'disk4', status: 'DISK_INVALID' }, { name: 'disk5', status: 'DISK_NP' }] } } }, NOW);
  eq('disk status words', bad.disks.map((d) => [d.name, d.status, d.statusText]), [['parity', 'bad', 'DISABLED'], ['disk1', 'bad', 'WRONG DISK'], ['disk2', 'bad', 'MISSING'], ['disk3', 'new', ''], ['disk4', 'bad', 'INVALID']]);

  const running = parseUnraid({ array: { array: { state: 'STARTED', parityCheckStatus: { status: 'RUNNING', running: true, progress: 42, errors: 2, correcting: true, speed: '101.5' } } }, parity: { parityHistory: [] } }, NOW);
  eq('parity running: progress, errors, no last', [running.parity?.running, running.parity?.progress, running.parity?.errors, running.parity?.correcting, running.parity?.last], [true, 42, 2, true, null]);
  const paused = parseUnraid({ array: { array: { state: 'STARTED', parityCheckStatus: { status: 'PAUSED', paused: true, progress: 150 } } } }, NOW);
  eq('parity paused counts as running; progress held to 0 to 100', [paused.parity?.running, paused.parity?.paused, paused.parity?.progress], [true, true, 100]);
  const cancelled = parseUnraid({ array: { array: { state: 'STARTED', parityCheckStatus: { status: 'NEVER_RUN', running: false } } }, parity: { parityHistory: [{ date: '2026-10-02T00:00:00Z', status: 'CANCELLED', errors: 0 }, { date: '2026-10-03T00:00:00Z', status: 'FAILED' }, { date: '2026-10-04T00:00:00Z', status: 'RUNNING' }] } }, NOW);
  eq('parity history: a running entry is not a result; the newest finished one wins', cancelled.parity?.last?.result, 'failed');
}

// ---------------------------------------------------------------- alerts

const disk = (o: Partial<UnraidDisk> = {}): UnraidDisk => ({ name: 'disk1', device: 'sdc', role: 'data', ssd: false, tempC: 36, sizeKb: 1, usedKb: 1, fsKb: 1, errors: 0, smart: 'ok', spin: 'up', status: 'ok', statusText: '', ...o });
const healthy = (o: Partial<UnraidSummary> = {}): UnraidSummary => ({
  host: 'Tower', version: '7.2.0', uptimeSec: 1000, array: { state: 'STARTED', started: true, usedKb: 1, totalKb: 2 }, parity: { running: false, paused: false, correcting: false, progress: null, speed: '', errors: null, last: { at: NOW, result: 'ok', errors: 0, durationSec: 1, speed: '' } },
  disks: [disk()], pools: [], cpuPct: 5, mem: { pct: 20, usedBytes: 1, totalBytes: 5 }, containers: [], vms: [], notices: { warning: 0, alert: 0, latest: [] }, ups: [], hotC: 45, maxC: 55, ...o,
});
const kinds = (a: UnraidAlert[]) => a.map((x) => `${x.level}:${x.id}`);
{
  eq('alerts: a healthy server has none', unraidAlerts(healthy(), NOW), []);
  eq('alerts: the example server', kinds(unraidAlerts(full, NOW)), ['alert:disk-errors:disk4', 'warn:disk-hot:disk2', 'warn:container-stopped:nextcloud', 'warn:vm-crashed:Test Box', 'warn:unread:warning']);

  eq('array: stopped is an alert', kinds(unraidAlerts(healthy({ array: { state: 'RECON DISK', started: false, usedKb: 1, totalKb: 2 } }), NOW)), ['alert:array-stopped:']);
  eq('array: no array answer, no alert', unraidAlerts(healthy({ array: null }), NOW), []);

  const hot = (t: number, o: Partial<UnraidDisk> = {}) => kinds(unraidAlerts(healthy({ disks: [disk({ tempC: t, ...o })] }), NOW));
  eq('hot disk: 44 fine, 45 warns, 54 warns, 55 is an alert', [hot(44), hot(45), hot(54), hot(55)], [[], ['warn:disk-hot:disk1'], ['warn:disk-hot:disk1'], ['alert:disk-hot:disk1']]);
  eq('hot SSD: limits 15 higher (59 fine, 60 warns, 70 alert)', [hot(59, { ssd: true }), hot(60, { ssd: true }), hot(70, { ssd: true })], [[], ['warn:disk-hot:disk1'], ['alert:disk-hot:disk1']]);
  eq('hot disk that is spun down: the old reading is not judged', hot(60, { spin: 'down' }), []);
  eq('hot disk with spin unknown is judged', hot(60, { spin: null }), ['alert:disk-hot:disk1']);
  eq('hot disk: Unraid\'s own limits are used', kinds(unraidAlerts(healthy({ hotC: 40, maxC: 50, disks: [disk({ tempC: 41 }), disk({ name: 'disk2', tempC: 50 })] }), NOW)), ['alert:disk-hot:disk2', 'warn:disk-hot:disk1']);
  eq('hot pool disk counts too', kinds(unraidAlerts(healthy({ pools: [disk({ name: 'cache', ssd: true, tempC: 72 })] }), NOW)), ['alert:disk-hot:cache']);

  eq('disk errors: 1 is an alert, singular', unraidAlerts(healthy({ disks: [disk({ errors: 1 })] }), NOW)[0].text, 'DISK1 HAS 1 ERROR');
  eq('disk errors: plural', unraidAlerts(healthy({ disks: [disk({ errors: 12 })] }), NOW)[0].text, 'DISK1 HAS 12 ERRORS');
  eq('disk not ok: disabled', unraidAlerts(healthy({ disks: [disk({ status: 'bad', statusText: 'DISABLED' })] }), NOW)[0].text, 'DISK1 IS DISABLED');
  eq('disk new: nothing', unraidAlerts(healthy({ disks: [disk({ status: 'new' })] }), NOW), []);
  eq('SMART unknown alone is no alert (Unraid\'s API cannot say "failing")', unraidAlerts(healthy({ disks: [disk({ smart: 'unknown' })] }), NOW), []);

  const par = (p: Partial<NonNullable<UnraidSummary['parity']>>) => unraidAlerts(healthy({ parity: { ...healthy().parity!, ...p } }), NOW);
  eq('parity: last check with errors', par({ last: { at: NOW, result: 'errors', errors: 3, durationSec: 1, speed: '' } }).map((a) => a.text), ['LAST PARITY CHECK FOUND 3 ERRORS']);
  eq('parity: last check failed', par({ last: { at: NOW, result: 'failed', errors: null, durationSec: null, speed: '' } }).map((a) => a.text), ['LAST PARITY CHECK FAILED']);
  eq('parity: last check cancelled is no alert', par({ last: { at: NOW, result: 'cancelled', errors: null, durationSec: null, speed: '' } }), []);
  eq('parity: running with errors', par({ running: true, errors: 1, correcting: false }).map((a) => [a.text, a.detail]), [['PARITY CHECK HAS FOUND 1 ERROR', 'It is only checking: parity is not being fixed.']]);
  eq('parity: running clean is no alert', par({ running: true, errors: 0 }), []);

  const c = (o: Partial<NonNullable<UnraidSummary['containers']>[number]>) => kinds(unraidAlerts(healthy({ containers: [{ name: 'plex', state: 'stopped', autoStart: false, detail: 'Exited (0)', stoppedAt: null, ...o }] }), NOW));
  eq('container: set to auto-start and stopped', c({ autoStart: true }), ['warn:container-stopped:plex']);
  eq('container: seen running, stopped 2 h ago', c({ stoppedAt: NOW - 2 * HOUR }), ['warn:container-stopped:plex']);
  eq('container: stopped a day and a bit ago, not auto-start: over', c({ stoppedAt: NOW - 25 * HOUR }), []);
  eq('container: stopped, never seen running, not auto-start: nobody cares', c({}), []);
  eq('container: running or paused is fine', [c({ state: 'running', autoStart: true }), c({ state: 'paused', autoStart: true })], [[], []]);
  eq('container: Docker did not answer = no judgement', unraidAlerts(healthy({ containers: null }), NOW), []);
  eq('vm: crashed warns, stopped does not', kinds(unraidAlerts(healthy({ vms: [{ name: 'A', state: 'crashed' }, { name: 'B', state: 'stopped' }] }), NOW)), ['warn:vm-crashed:A']);
  eq('ups: on battery warns', unraidAlerts(healthy({ ups: [{ name: 'Back-UPS', status: 'On Battery', chargePct: 80, runtimeSec: 600, loadPct: 20, onBattery: true }] }), NOW).map((a) => a.text), ['UPS IS ON BATTERY (80%)']);
  eq('unread: alerts are alerts, warnings warn, both listed alert first', kinds(unraidAlerts(healthy({ notices: { warning: 2, alert: 1, latest: [{ level: 'alert', text: 'Disk 3 failed', at: null }, { level: 'warning', text: 'Hot', at: null }] } }), NOW)), ['alert:unread:alert', 'warn:unread:warning']);
  eq('unread: the newest text of that kind goes in the detail', unraidAlerts(healthy({ notices: { warning: 0, alert: 1, latest: [{ level: 'warning', text: 'Hot', at: null }, { level: 'alert', text: 'Disk 3 failed', at: null }] } }), NOW)[0].detail, 'Disk 3 failed');
  const many = unraidAlerts(healthy({ disks: [disk({ errors: 2, tempC: 60 }), disk({ name: 'disk2', errors: 1 })], array: { state: 'STOPPED', started: false, usedKb: 1, totalKb: 2 } }), NOW);
  check('alerts: ids are unique and the alert level comes first', new Set(many.map((a) => a.id)).size === many.length && many.findIndex((a) => a.level === 'warn') === -1 || many.findLastIndex((a) => a.level === 'alert') < many.findIndex((a) => a.level === 'warn'), kinds(many));
}

// ---------------------------------------------------------------- asking one part

const asked: string[] = [];
const sender = (f: (q: string, n: number) => Reply | Promise<Reply>): Send => async (q) => {
  asked.push(q);
  return f(q, asked.length);
};
const ask = (part: Part, send: Send, drop = new Set<string>()) => askPart(part, send, drop, (s) => s.split(KEY).join('***'));

{
  asked.length = 0;
  const ok = await ask('docker', sender(answer));
  check('ask: a good answer', ok.ok && JSON.stringify((ok as { data: Rec }).data).includes('plex'), ok);
  eq('ask: one question sent', asked.length, 1);

  const why = async (r: Reply | Error, part: Part = 'docker') => {
    const o = await ask(part, async () => {
      if (r instanceof Error) throw r;
      return r;
    });
    return o.ok ? 'ok' : o.why;
  };
  eq('ask: HTTP 401 = key refused', await why(reply('', 401)), 'auth');
  eq('ask: HTTP 403 = key refused', await why(reply('', 403)), 'auth');
  eq('ask: Unraid\'s UNAUTHENTICATED error = key refused', await why(reply(fx('err-unauthenticated'))), 'auth');
  eq('ask: a missing/invalid api key message = key refused', await why(reply({ errors: [{ message: 'Invalid API key' }], data: null })), 'auth');
  eq('ask: FORBIDDEN on a part = only that part', await why(reply(fx('err-forbidden'))), 'forbidden');
  eq('ask: 404 = wrong address', await why(reply('Not found', 404)), 'wrong');
  eq('ask: a redirect = wrong address (never followed)', await why(reply('', 302)), 'wrong');
  eq('ask: a web page = wrong address', await why(reply('<html><title>Tower</title></html>')), 'wrong');
  eq('ask: 429 = slow down', await why(reply('', 429)), 'limit');
  eq('ask: 500 with no JSON = error', await why(reply('boom', 500)), 'error');
  eq('ask: an error and no data = error', await why(reply({ errors: [{ message: 'Docker is not running' }] })), 'error');
  eq('ask: no connection = down', await why(new NetError('ECONNREFUSED')), 'down');
  eq('ask: partial data with field errors is still an answer', await why(reply({ data: { docker: { containers: [] } }, errors: [{ message: 'Int cannot represent non-integer value: NaN', path: ['array', 'disks', 2, 'temp'] }] })), 'ok');
  eq('ask: data and an auth-looking error on one field: still an answer', await why(reply({ data: dataOf('docker'), errors: [{ message: 'Unauthorized', path: ['docker', 'containers', 0, 'x'] }] })), 'ok');
  eq('ask: JSON null data with FORBIDDEN code but no message words', await why(reply({ data: null, errors: [{ message: 'nope', extensions: { code: 'FORBIDDEN' } }] })), 'forbidden');

  const echo = await ask('docker', async () => reply({ data: null, errors: [{ message: `Bad request with ${KEY} in it` }] }));
  check('ask: a server that echoes the key back is scrubbed', !echo.ok && !echo.note.includes(KEY) && echo.note.includes('***'), echo);

  // Old Unraid: drops the fields it names, asks again, remembers.
  asked.length = 0;
  const drop = new Set<string>();
  const oldSend = sender((q) => {
    const bad = ['isSpinning', 'warningsAndAlerts'].filter((f) => q.includes(f));
    return bad.length ? reply({ errors: bad.map((f) => ({ message: `Cannot query field "${f}" on type "ArrayDisk".`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } })) }, 400) : answer(q);
  });
  const o1 = await ask('array', oldSend, drop);
  check('old Unraid: array works without isSpinning', o1.ok, o1);
  eq('old Unraid: two questions the first time (one refused, one pruned)', asked.length, 2);
  eq('old Unraid: the missing field is remembered', [...drop], ['isSpinning']);
  asked.length = 0;
  await ask('array', oldSend, drop);
  eq('old Unraid: next time one question', asked.length, 1);
  check('old Unraid: the answer has no isSpinning, and parses', !JSON.stringify((o1 as { data: Rec }).data).includes('isSpinning') && parseUnraid({ array: (o1 as { data: Rec }).data }, NOW).disks.length === 5);
  const o2 = await ask('notices', oldSend, new Set());
  check('old Unraid: notifications work without the list', o2.ok && !JSON.stringify((o2 as { data: Rec }).data).includes('warningsAndAlerts'), o2);

  const noUps = await ask('ups', sender(() => reply({ errors: [{ message: 'Cannot query field "upsDevices" on type "Query".' }] }, 400)));
  eq('missing root field: part missing, asked once more at most', noUps.ok ? 'ok' : noUps.why, 'missing');
  const endless = await ask('array', sender(() => reply({ errors: [{ message: 'Cannot query field "x1" on type "Query".' }] }, 400)));
  check('a server that keeps refusing is given up on', !endless.ok && endless.why === 'error' && asked.length < 20, endless);
}

// ---------------------------------------------------------------- the link: nothing prints the key

{
  const link = new Link(new URL('http://192.0.2.7/graphql'), KEY);
  const shown = [JSON.stringify(link), String(link), inspect(link, { depth: 5, showHidden: true }), `${link}`, JSON.stringify({ link }), JSON.stringify(Object.getOwnPropertyNames(link))].join('\n');
  check('link: printing, inspecting or JSON-ing it never shows the key', !shown.includes(KEY), shown);
  eq('link: scrub cuts the key out of other text', link.scrub(`a ${KEY} b ${KEY}`), 'a *** b ***');
  eq('link: the header is there for the request', link.headers()['x-api-key'], KEY);
}

// ---------------------------------------------------------------- .env

{
  const env = (o: Record<string, string>) => ({ ...o }) as NodeJS.ProcessEnv;
  const e1 = env({ PHOSPHOR_UNRAID_URL: '192.168.1.10', PHOSPHOR_UNRAID_KEY: KEY, PHOSPHOR_UNRAID_SELF_SIGNED: '1', PHOSPHOR_PORT: '7337' });
  const s1 = takeSetup(e1);
  check('setup: both lines make a link', !!s1.link && s1.problem === '' && s1.link.url.href === 'http://192.168.1.10/graphql' && s1.link.selfSigned);
  eq('setup: the three lines are taken out of the environment, others stay', Object.keys(e1), ['PHOSPHOR_PORT']);
  check('setup: self-signed is off unless asked', takeSetup(env({ PHOSPHOR_UNRAID_URL: 'tower', PHOSPHOR_UNRAID_KEY: KEY })).link?.selfSigned === false);
  eq('setup: nothing set = not connected, no complaint', takeSetup(env({})), { link: null, problem: '' });
  eq('setup: empty lines = not connected, no complaint', takeSetup(env({ PHOSPHOR_UNRAID_URL: '', PHOSPHOR_UNRAID_KEY: '' })), { link: null, problem: '' });
  eq('setup: key missing', takeSetup(env({ PHOSPHOR_UNRAID_URL: 'tower' })), { link: null, problem: 'PHOSPHOR_UNRAID_KEY is empty.' });
  eq('setup: address missing', takeSetup(env({ PHOSPHOR_UNRAID_KEY: KEY })), { link: null, problem: 'PHOSPHOR_UNRAID_URL is empty.' });
  check('setup: a bad address says so (and not the key)', takeSetup(env({ PHOSPHOR_UNRAID_URL: 'ftp://x', PHOSPHOR_UNRAID_KEY: KEY })).problem.startsWith('PHOSPHOR_UNRAID_URL is not a web address'));
}

// ---------------------------------------------------------------- the watcher (fake send, fake clock)

const tmp = mkdtempSync(join(tmpdir(), 'station-unraid-'));
const URL_HOST = '192.0.2.77'; // made up (documentation range); never contacted: every request below goes to a fake
const setup = () => takeSetup({ PHOSPHOR_UNRAID_URL: `http://${URL_HOST}`, PHOSPHOR_UNRAID_KEY: KEY } as NodeJS.ProcessEnv);
let clock = NOW;
const logs: string[] = [];
const watcher = (send: Send, file: string | null = null) => new UnraidWatch({ setup: setup(), send, now: () => clock, file, log: (l) => logs.push(l) });
const good: Send = async (q) => answer(q);

{
  const off = new UnraidWatch({ setup: { link: null, problem: 'PHOSPHOR_UNRAID_KEY is empty.' }, send: async () => { throw new Error('must not be asked'); }, file: null });
  off.onScreen();
  await off.refresh();
  const v = off.view();
  eq('watch: not configured', [v.configured, v.problem, v.summary, v.alerts], [false, 'PHOSPHOR_UNRAID_KEY is empty.', null, []]);

  clock = NOW;
  const w = watcher(good);
  eq('watch: before the first answer it says so', [w.view().state, w.view().checking, w.view().summary], ['loading', true, null]);
  await w.refresh();
  const v1 = w.view();
  eq('watch: answered', [v1.configured, v1.state, v1.note, v1.checking, v1.okAt, v1.at], [true, 'ok', '', false, NOW, NOW]);
  eq('watch: summary and alerts come with it', [v1.summary?.host, v1.alerts.length, v1.gaps], ['Tower', 5, []]);
  check('watch: the served answer never holds the key or the address', !JSON.stringify(v1).includes(KEY) && !JSON.stringify(v1).includes(URL_HOST));
  eq('watch: logs once, in words', logs, ['unraid: connected']);
  await w.refresh();
  eq('watch: the same state is not logged again', logs.length, 1);

  // A poll asks nine questions, one at a time.
  asked.length = 0;
  const w2 = watcher(sender(answer));
  await w2.refresh();
  eq('watch: nine questions per poll', asked.length, 9);
  w2.stop();

  // Parts that fail are gaps; the rest still shows.
  const w3 = watcher(async (q) => (partOf(q) === 'docker' ? reply(fx('err-forbidden')) : partOf(q) === 'ups' ? reply({ errors: [{ message: 'apcupsd is not running' }], data: null }) : answer(q)));
  await w3.refresh();
  const v3 = w3.view();
  eq('watch: a part that may not be read is a gap, a missing UPS is not', [v3.state, v3.gaps, v3.summary?.containers, v3.summary?.ups], ['ok', ['DOCKER: This key may not read it.'], null, []]);

  const w4 = watcher(async (q) => (q.includes('vars') ? reply({ errors: [{ message: 'Cannot query field "vars" on type "Query".' }] }, 400) : answer(q)));
  await w4.refresh();
  eq('watch: system part without vars still gives the host from info', [w4.view().state, w4.view().summary?.host, w4.view().summary?.version], ['ok', 'Tower', '7.2.0']);

  // No answer: the last good summary stays, marked by the state.
  let up = true;
  const w5 = watcher(async (q) => {
    if (!up) throw new NetError('ECONNREFUSED');
    return answer(q);
  });
  await w5.refresh();
  clock += 61_000;
  up = false;
  logs.length = 0;
  await w5.refresh();
  const v5 = w5.view();
  eq('watch: no answer = down, with words', [v5.state, v5.note.startsWith('Nothing answers'), v5.okAt, v5.summary?.host], ['down', true, NOW, 'Tower']);
  check('watch: the words carry no address', !JSON.stringify(v5).includes(URL_HOST));
  eq('watch: the change is logged', logs, ['unraid: no answer']);
  up = true;
  clock += 61_000;
  await w5.refresh();
  eq('watch: back again', w5.view().state, 'ok');

  // Key refused: look again only now and then.
  let polls = 0;
  const w6 = watcher(async () => {
    polls++;
    return reply(fx('err-unauthenticated'));
  });
  await w6.refresh();
  eq('watch: key refused stops the poll at the first question', [w6.view().state, polls], ['auth', 1]);
  check('watch: key refused says what to do', /VIEWER/.test(w6.view().note));
  // A forbidden-everywhere key
  const w7 = watcher(async () => reply(fx('err-forbidden')));
  await w7.refresh();
  eq('watch: a key that may read nothing', [w7.view().state, /VIEWER/.test(w7.view().note)], ['auth', true]);
  const w8 = watcher(async () => reply('', 404));
  await w8.refresh();
  eq('watch: wrong address', [w8.view().state, /\/graphql/.test(w8.view().note)], ['wrong', true]);
  const w9 = watcher(async () => reply('', 429));
  await w9.refresh();
  eq('watch: told to slow down shows as an error with words', [w9.view().state, /slow down/.test(w9.view().note)], ['error', true]);
  const w10 = watcher(async () => reply({ errors: [{ message: `no good ${KEY}` }], data: null }));
  await w10.refresh();
  check('watch: nothing usable, and the key an error echoed is not served', w10.view().state === 'error' && !JSON.stringify(w10.view()).includes(KEY));
  const w11 = watcher(async () => {
    throw new Error(`boom ${KEY} at ${URL_HOST}`);
  });
  await w11.refresh();
  check('watch: a request that blows up with its own text: down, in our words, nothing of it served or logged', w11.view().state === 'down' && !JSON.stringify(w11.view()).includes(KEY) && !logs.join('\n').includes(KEY) && !logs.join('\n').includes(URL_HOST), w11.view().note);
  const bomb = { get status(): number { throw new Error(`boom ${KEY} at ${URL_HOST}`); }, body: '' } as Reply;
  const w11b = watcher(async () => bomb);
  await w11b.refresh();
  check('watch: a bug while reading the answer: an error, nothing of it served or logged', w11b.view().state === 'error' && !JSON.stringify(w11b.view()).includes(KEY) && !logs.join('\n').includes(KEY) && !logs.join('\n').includes(URL_HOST), w11b.view());
  await w11b.refresh();

  // When it polls.
  let n = 0;
  clock = NOW;
  const w12 = watcher(async (q) => {
    if (partOf(q) === 'system') n++;
    return answer(q);
  });
  const settle = () => new Promise((r) => setTimeout(r, 15));
  w12.onScreen();
  await settle();
  eq('watch: the first look polls', n, 1);
  clock += 30_000;
  w12.onScreen();
  await settle();
  eq('watch: asked again within a minute: no new poll', n, 1);
  clock += 31_000;
  w12.onScreen();
  await settle();
  eq('watch: a minute on, an open screen polls again', n, 2);
  clock += 5 * 60_000;
  const before = n;
  (w12 as unknown as { tick(): void }).tick();
  eq('watch: nobody looking: not before 10 minutes', n, before);
  clock += 5 * 60_000;
  (w12 as unknown as { tick(): void }).tick();
  await w12.refresh();
  eq('watch: nobody looking: every 10 minutes', n, before + 1);
  // a refused key is not asked again at the open-screen pace
  let auths = 0;
  const w13 = watcher(async () => {
    auths++;
    return reply(fx('err-unauthenticated'));
  });
  await w13.refresh();
  w13.onScreen();
  clock += 61_000;
  (w13 as unknown as { tick(): void }).tick();
  eq('watch: a refused key is not asked again each minute', auths, 1);
}

// ---------------------------------------------------------------- "has stopped", remembered across restarts

{
  const file = join(tmp, 'unraid-seen.json');
  const running = (names: string[], stopped: string[], auto = false): Send => async (q) => {
    if (partOf(q) !== 'docker') return answer(q);
    const containers = [...names.map((n) => ({ names: [`/${n}`], state: 'RUNNING', status: 'Up', autoStart: auto })), ...stopped.map((n) => ({ names: [`/${n}`], state: 'EXITED', status: 'Exited (1) now', autoStart: auto }))];
    return reply({ data: { docker: { containers } } });
  };
  const alertsOf = (w: UnraidWatch) => w.view().alerts.filter((a) => a.kind === 'container-stopped').map((a) => a.id);
  clock = NOW;
  const a = watcher(running(['plex', 'sonarr'], []), file);
  await a.refresh();
  eq('stopped: all running, nothing', alertsOf(a), []);
  clock += HOUR;
  const a2 = watcher(running(['sonarr'], ['plex']), file);
  await a2.refresh();
  eq('stopped: plex ran at the last answer and has stopped (not auto-start)', alertsOf(a2), ['container-stopped:plex']);
  eq('stopped: the time it was seen to stop is kept', a2.view().summary?.containers?.find((c) => c.name === 'plex')?.stoppedAt, clock);
  clock += 2 * HOUR;
  await a2.refresh();
  eq('stopped: still stopped later, the time stays', a2.view().summary?.containers?.find((c) => c.name === 'plex')?.stoppedAt, NOW + HOUR);
  clock = NOW + HOUR + 23 * HOUR;
  eq('stopped: 23 hours on it still shows', alertsOf(a2), ['container-stopped:plex']);
  clock = NOW + HOUR + 25 * HOUR;
  eq('stopped: after a day it goes by itself, without a new poll', alertsOf(a2), []);
  clock = NOW + 2 * HOUR;
  const a3 = watcher(running(['sonarr'], ['plex']), file);
  await a3.refresh();
  eq('stopped: a restart of the server remembers (file)', alertsOf(a3), ['container-stopped:plex']);
  check('stopped: the file holds names and times only', /^\{"containers":\{/.test(readFileSync(file, 'utf8')) && !readFileSync(file, 'utf8').includes(KEY) && !readFileSync(file, 'utf8').includes(URL_HOST));
  clock += HOUR;
  const a4 = watcher(running(['sonarr', 'plex'], []), file);
  await a4.refresh();
  eq('stopped: running again clears it', alertsOf(a4), []);
  const a5 = watcher(running([], ['ghost'], true), file);
  await a5.refresh();
  eq('stopped: set to auto-start and stopped even if never seen running', alertsOf(a5), ['container-stopped:ghost']);
  // Docker not answering changes nothing remembered
  const a6 = watcher(async (q) => (partOf(q) === 'docker' ? reply(fx('err-forbidden')) : answer(q)), file);
  const mem = readFileSync(file, 'utf8');
  await a6.refresh();
  eq('stopped: Docker not answering leaves the memory alone', readFileSync(file, 'utf8'), mem);
  writeFileSync(file, '{ not json');
  const a7 = watcher(running(['x'], []), file);
  await a7.refresh();
  eq('stopped: a damaged memory file starts empty', a7.view().state, 'ok');
}

// ---------------------------------------------------------------- the route

{
  clock = NOW;
  let polls = 0;
  const w = watcher(async (q) => {
    if (partOf(q) === 'system') polls++;
    return answer(q);
  });
  const srv: Server = createServer((req, res) => void unraidRoute(w)(req, res, new URL(req.url ?? '/', 'http://x')));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  const call = (method: string, path: string) =>
    new Promise<{ status: number; type: string; cache: string; body: string }>((resolve, reject) => {
      const rq = request({ host: '127.0.0.1', port, method, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), cache: String(res.headers['cache-control']), body }));
      });
      rq.on('error', reject);
      rq.end();
    });
  const peek = await call('GET', '/api/station/unraid?peek=1');
  await new Promise((r) => setTimeout(r, 20));
  eq('route: a peek does not poll', polls, 0);
  eq('route: answers JSON that is not cached', [peek.status, peek.type, peek.cache], [200, 'application/json', 'no-store']);
  check('route: before any poll it says it is checking', JSON.parse(peek.body).checking === true && JSON.parse(peek.body).state === 'loading');
  const open = await call('GET', '/api/station/unraid');
  await new Promise((r) => setTimeout(r, 30));
  eq('route: an open screen polls', polls, 1);
  const shown = await call('GET', '/api/station/unraid?peek=1');
  const body = JSON.parse(shown.body);
  eq('route: then the answer is there', [body.state, body.summary.host, body.alerts.length], ['ok', 'Tower', 5]);
  check('route: no key, no address in what the page gets', !shown.body.includes(KEY) && !shown.body.includes(URL_HOST) && !open.body.includes(KEY));
  eq('route: POST is refused', (await call('POST', '/api/station/unraid')).status, 405);
  srv.close();
}

// ---------------------------------------------------------------- real HTTP against a mock Unraid on 127.0.0.1

type Hit = { method: string; path: string; key: string | undefined; type: string | undefined; length: string | undefined; query: string };
async function mock(handler: (q: string, hit: Hit, res: import('node:http').ServerResponse) => void): Promise<{ srv: Server; url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let query = '';
      try {
        query = JSON.parse(body).query;
      } catch {
        /* not JSON */
      }
      const hit: Hit = { method: req.method ?? '', path: req.url ?? '', key: req.headers['x-api-key'] as string | undefined, type: req.headers['content-type'], length: req.headers['content-length'], query };
      hits.push(hit);
      handler(query, hit, res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits };
}
const json = (res: import('node:http').ServerResponse, body: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
const unraid = (key: string) => (q: string, hit: Hit, res: import('node:http').ServerResponse) => (hit.key === key ? json(res, answer(q).body) : json(res, fx('err-unauthenticated')));
const linkTo = (url: string, key = KEY, selfSigned = false) => new Link(graphqlUrl(url)!, key, selfSigned);

{
  const m = await mock(unraid(KEY));
  const w = new UnraidWatch({ setup: { link: linkTo(m.url), problem: '' }, now: () => clock, file: null, log: (l) => logs.push(l) });
  await w.refresh();
  eq('http: a whole poll over a real socket', [w.view().state, w.view().summary?.host, m.hits.length], ['ok', 'Tower', 9]);
  eq('http: POST /graphql, JSON, with the key header', [m.hits[0].method, m.hits[0].path, m.hits[0].type, m.hits[0].key], ['POST', '/graphql', 'application/json', KEY]);
  check('http: the question is in the body, and only questions', m.hits.every((h) => h.query.startsWith('{') && !/mutation/.test(h.query)));
  check('http: nothing in the answer to the page has the key', !JSON.stringify(w.view()).includes(KEY));
  m.srv.close();

  const wrongKey = await mock(unraid('some-other-key'));
  const w2 = new UnraidWatch({ setup: { link: linkTo(wrongKey.url), problem: '' }, now: () => clock, file: null, log: (l) => logs.push(l) });
  await w2.refresh();
  eq('http: a wrong key = auth, one question', [w2.view().state, wrongKey.hits.length], ['auth', 1]);
  wrongKey.srv.close();

  // A redirect is not followed: the key must not go along.
  const other = await mock((_q, _h, res) => json(res, { data: {} }));
  const redirecting = await mock((_q, _h, res) => res.writeHead(302, { Location: `${other.url}/graphql` }).end());
  const w3 = new UnraidWatch({ setup: { link: linkTo(redirecting.url), problem: '' }, now: () => clock, file: null, log: (l) => logs.push(l) });
  await w3.refresh();
  eq('http: a redirect is not followed', [w3.view().state, other.hits.length], ['wrong', 0]);
  other.srv.close();
  redirecting.srv.close();

  // Nothing listening
  const gone = await mock(unraid(KEY));
  const goneUrl = gone.url;
  gone.srv.close();
  await new Promise((r) => setTimeout(r, 20));
  const w4 = new UnraidWatch({ setup: { link: linkTo(goneUrl), problem: '' }, now: () => clock, file: null, log: (l) => logs.push(l) });
  await w4.refresh();
  check('http: connection refused = down, and the note has no address or port', w4.view().state === 'down' && !w4.view().note.includes('127.0.0.1') && !w4.view().note.includes(goneUrl.split(':')[2]), w4.view().note);

  // Slow server: cut off
  const slow = await mock(() => {});
  const t0 = Date.now();
  const r = await httpSend(linkTo(slow.url), 300)('{ x }').then(
    () => 'answered',
    (e) => (e instanceof NetError ? e.code : String(e)),
  );
  check('http: a server that never answers is cut off at the limit', r === 'TIMEOUT' && Date.now() - t0 < 2000, `${r} ${Date.now() - t0} ms`);
  eq('http: and says so in words', netNote(new NetError('TIMEOUT')), 'No answer in time. Is the server on?');
  slow.srv.close();

  // Huge answer
  const big = await mock((_q, _h, res) => res.writeHead(200).end('x'.repeat(5 * 1024 * 1024)));
  const rb = await httpSend(linkTo(big.url))('{ x }').then(
    () => 'answered',
    (e) => (e instanceof NetError ? e.code : String(e)),
  );
  eq('http: an enormous answer is refused', rb, 'TOO_BIG');
  big.srv.close();

  // A web page where the API should be
  const page = await mock((_q, _h, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><title>Tower/Login</title></html>'));
  const w5 = new UnraidWatch({ setup: { link: linkTo(page.url), problem: '' }, now: () => clock, file: null, log: (l) => logs.push(l) });
  await w5.refresh();
  eq('http: a web page instead of the API = wrong address', w5.view().state, 'wrong');
  page.srv.close();

  // Old Unraid over the wire: rejects isSpinning / warningsAndAlerts the way graphql-js words it
  const oldM = await mock((q, hit, res) => {
    if (hit.key !== KEY) return json(res, fx('err-unauthenticated'));
    const bad = ['isSpinning', 'warningsAndAlerts'].filter((f) => q.includes(f));
    if (bad.length) return json(res, { errors: bad.map((f) => ({ message: `Cannot query field "${f}" on type "X".`, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } })) }, 400);
    json(res, answer(q).body);
  });
  const w6 = new UnraidWatch({ setup: { link: linkTo(oldM.url), problem: '' }, now: () => clock, file: null, log: (l) => logs.push(l) });
  await w6.refresh();
  const v6 = w6.view();
  eq('http: an older Unraid still gives the page its numbers (spin state is not there at all)', [v6.state, v6.summary?.disks.length, v6.summary?.disks.map((d) => d.spin), v6.summary?.notices?.warning], ['ok', 5, [null, null, null, null, null], 1]);
  const firstPoll = oldM.hits.length;
  await w6.refresh();
  eq('http: the first poll had 3 refused questions, the second repeats none', [firstPoll, oldM.hits.length - firstPoll], [12, 9]);
  oldM.srv.close();
}

// HTTPS with a certificate nobody trusts (needs the openssl command; skipped without).
{
  let pem: { key: string; cert: string } | null = null;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tmp, 'k.pem'), '-out', join(tmp, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    pem = { key: readFileSync(join(tmp, 'k.pem'), 'utf8'), cert: readFileSync(join(tmp, 'c.pem'), 'utf8') };
  } catch {
    console.log('SKIP: https with a self-signed certificate (openssl is not here)');
  }
  if (pem) {
    const hits: string[] = [];
    const srv = createTlsServer(pem, (req, res) => {
      hits.push(String(req.headers['x-api-key']));
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => json(res, answer(JSON.parse(body).query).body));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const strict = await httpSend(linkTo(url))('{ docker { containers { names } } }').then(
      () => 'answered',
      (e) => (e instanceof NetError ? netNote(e) : String(e)),
    );
    check('https: an untrusted certificate is refused, with the .env line to add', /PHOSPHOR_UNRAID_SELF_SIGNED=1/.test(strict) && hits.length === 0, strict);
    const relaxed = await httpSend(linkTo(url, KEY, true))('{ docker { containers { names } } }');
    check('https: with SELF_SIGNED it works, and the key goes only then', relaxed.status === 200 && hits.length === 1 && hits[0] === KEY, `${relaxed.status} ${hits.length}`);
    srv.close();
  }
}

// ---------------------------------------------------------------- nothing else can reach it

{
  const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const importers = (dir: string, re: RegExp) => readdirSync(new URL(`../${dir}`, import.meta.url)).filter((f) => /\.(ts|mjs)$/.test(f) && re.test(src(`${dir}/${f}`)));
  eq('wiring: only STATION code imports the Unraid modules (server)', importers('server', /from '\.\/unraid(api)?\.ts'/), ['index.ts', 'station.ts', 'unraid.ts']);
  eq('wiring: and nothing on the page side but the station screen', importers('web/src', /shared\/unraid\.ts|\.\/unraid\.ts|stationdemo/), ['station.ts', 'stationdemo.ts', 'unraid.ts']);
  for (const f of ['server/tab.ts', 'server/tabs.ts', 'server/mcp.ts', 'shared/protocol.ts', 'server/system.ts', 'server/files.ts']) check(`wiring: ${f} knows nothing of Unraid`, !/unraid/i.test(src(f)), f);
  check('wiring: the chat\'s environment cannot hold the key (config.ts does not copy it)', !/UNRAID/.test(src('server/config.ts')));
  check('wiring: the key is taken out of the environment', /delete env\.PHOSPHOR_UNRAID_KEY/.test(src('server/unraid.ts')));
  eq('wiring: the Unraid modules log through one line only (plain words)', [(src('server/unraid.ts').match(/console\./g) ?? []).length, (src('server/unraidapi.ts').match(/console\./g) ?? []).length], [1, 0]);
}

// ---------------------------------------------------------------- 24 hours of checks

{
  const t0 = Date.parse('2026-10-25T12:00:00.000Z');
  const h = new Health(null, () => t0);
  eq('health: no checks yet', h.day('a'), { cells: '.'.repeat(96), checks: 0, upPct: null, avgMs: null });
  h.note('a', t0, 'up', 100);
  h.note('a', t0 + 60_000, 'up', 300);
  h.note('a', t0 - 15 * 60_000, 'slow', 2500);
  h.note('a', t0 - 30 * 60_000, 'down', null);
  h.note('a', t0 - 45 * 60_000, 'down', null);
  h.note('a', t0 - 45 * 60_000 + 1000, 'up', 200);
  h.note('a', t0, 'unknown', null);
  const d = h.day('a');
  eq('health: newest cell last; up, slow, down, partly down', d.cells.slice(-4), 'pds' + 'u');
  eq('health: counts: 6 checks, 2 down, 4 answered', [d.checks, d.upPct, d.avgMs], [6 - 0, 66.7, Math.round((100 + 300 + 2500 + 200) / 4)]);
  check('health: 96 cells', d.cells.length === 96);
  eq('health: a day later the old checks have rolled off', new Health(null, () => t0 + 24 * HOUR + 15 * 60_000).day('a').checks, 0);
  eq('health: a service with no checks is not touched by others', h.day('b').checks, 0);

  const file = join(tmp, 'health.json');
  const w = new Health(file, () => t0);
  w.note('keep', t0, 'up', 150);
  w.note('gone', t0, 'up', 150);
  w.note('old', t0 - 30 * HOUR, 'up', 1);
  w.note('keep', t0 - 30 * HOUR, 'up', 1);
  w.save(new Set(['keep', 'old']));
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { rows: Record<string, Record<string, unknown>> };
  eq('health: file keeps wanted services only, and only the last day', [Object.keys(raw.rows), Object.keys(raw.rows.keep).length], [['keep'], 1]);
  eq('health: reading it back', new Health(file, () => t0).day('keep').checks, 1);
  check('health: the file holds counts, nothing else', !readFileSync(file, 'utf8').includes('http'));
  w.forget('keep');
  w.save(new Set(['keep']));
  eq('health: forget', new Health(file, () => t0).day('keep').checks, 0);
  writeFileSync(file, JSON.stringify({ rows: { x: { '5': [1, 2], '6': 'no', '7': [1, 0, 0, -4], '__proto__': { '1': [1, 0, 0, 1] } } } }));
  eq('health: a damaged file is read as far as it makes sense', new Health(file, () => t0).day('x').checks, 0);
  writeFileSync(file, 'nope');
  eq('health: an unreadable file starts empty', new Health(file, () => t0).day('x').checks, 0);
}

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
