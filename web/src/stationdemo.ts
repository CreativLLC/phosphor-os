import type { StationEntry, StationKind, StationResponse, StationState } from '../../shared/station.ts';
import type { UnraidAlert, UnraidDisk, UnraidResponse, UnraidSummary } from '../../shared/unraid.ts';

// STATION in demo mode (?demo=1): made-up services and a made-up Unraid server, drawn without asking the server
// anything. Nothing here is real. ?unraid=off shows the "not connected" note and ?unraid=down the "no answer" state.

// Same numbers every time, so screenshots do not change between runs.
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

type Spec = { name: string; host: string; kind: StationKind; ms: number; state?: StationState; note?: string; pattern?: 'steady' | 'blip' | 'outage' | 'new'; selfSigned?: boolean };

const SPECS: Spec[] = [
  { name: 'Nextcloud', host: 'cloud.example.net', kind: 'nextcloud', ms: 142 },
  { name: 'Plex', host: 'nas.local:32400', kind: 'plex', ms: 88 },
  { name: 'Sonarr', host: 'nas.local:8989', kind: 'sonarr', ms: 2380, state: 'slow', note: 'Slow: 2380 ms to answer.', pattern: 'blip' },
  { name: 'Radarr', host: 'nas.local:7878', kind: 'radarr', ms: 64 },
  { name: 'Prowlarr', host: 'nas.local:9696', kind: 'prowlarr', ms: 71 },
  { name: 'Immich', host: 'nas.local:2283', kind: 'immich', ms: 156 },
  { name: 'Home Assistant', host: 'ha.local:8123', kind: 'home-assistant', ms: 97, pattern: 'blip' },
  { name: 'Unraid', host: 'nas.local', kind: 'unraid', ms: 41, selfSigned: true },
  { name: 'Vaultwarden', host: 'nas.local:8000', kind: 'vaultwarden', ms: 0, state: 'down', note: 'Nothing answers on that port (connection refused).', pattern: 'outage' },
  { name: 'qBittorrent', host: 'nas.local:8090', kind: 'qbittorrent', ms: 52 },
  { name: 'Paperless', host: 'nas.local:8001', kind: 'paperless', ms: 213, pattern: 'new' },
];

function entry(spec: Spec, i: number, now: number): StationEntry {
  const rand = rng(1000 + i * 77);
  const state: StationState = spec.state ?? 'up';
  const history = Array.from({ length: 40 }, (_, k) => {
    const downNow = state === 'down' && k >= 34;
    const slowNow = state === 'slow' && k >= 36;
    const ms = downNow ? null : Math.round(slowNow ? spec.ms * (0.9 + rand() * 0.2) : spec.ms * (0.7 + rand() * 0.7));
    return { at: now - (40 - k) * 60_000, state: downNow ? ('down' as const) : slowNow ? ('slow' as const) : ('up' as const), ms };
  });
  // 96 blocks of 15 minutes, oldest first.
  const cells = Array.from({ length: 96 }, (_, k) => {
    if (spec.pattern === 'new' && k < 70) return '.';
    if (spec.pattern === 'outage') return k >= 88 ? 'd' : k === 87 ? 'p' : k === 52 ? 'p' : 'u';
    if (spec.pattern === 'blip') return k === 61 || k === 62 ? 's' : k === 30 ? 'p' : 'u';
    return k % 53 === 7 ? 's' : 'u';
  }).join('');
  const seen = [...cells].filter((c) => c !== '.').length;
  const downCells = [...cells].filter((c) => c === 'd').length;
  const partial = [...cells].filter((c) => c === 'p').length;
  const checks = seen * 3;
  const lostChecks = downCells * 3 + partial;
  return {
    id: `demo-${i}`,
    name: spec.name,
    url: `http://${spec.host}/`,
    kind: spec.kind,
    selfSigned: !!spec.selfSigned,
    skin: true,
    status: {
      state,
      ms: state === 'down' ? null : history[39].ms,
      code: state === 'down' ? null : 200,
      at: now - 20_000,
      lastUp: state === 'down' ? now - 11 * 60_000 : now - 20_000,
      note: spec.note ?? '',
      history,
    },
    day: { cells, checks, upPct: Math.round(((checks - lostChecks) / checks) * 1000) / 10, avgMs: state === 'down' ? Math.round(spec.ms || 120) : spec.ms },
  };
}

export function demoStation(): StationResponse {
  const now = Date.now();
  return { services: SPECS.map((s, i) => entry(s, i, now)), checking: false, everyMs: 60_000, slowMs: 2000 };
}

// ---------------------------------------------------------------- Unraid

const TB = (n: number) => Math.round((n * 1e12) / 1024); // decimal TB -> Unraid's KiB

const disk = (o: Partial<UnraidDisk> & Pick<UnraidDisk, 'name' | 'device' | 'role'>): UnraidDisk => ({
  ssd: false, tempC: 36, sizeKb: TB(12), usedKb: null, fsKb: null, errors: 0, smart: 'ok', spin: 'up', status: 'ok', statusText: '', ...o,
});
const data = (name: string, device: string, tb: number, usedTb: number, o: Partial<UnraidDisk> = {}) =>
  disk({ name, device, role: 'data', sizeKb: TB(tb), fsKb: TB(tb * 0.98), usedKb: TB(usedTb), ...o });

export function demoUnraid(mode = new URLSearchParams(location.search).get('unraid')): UnraidResponse {
  const now = Date.now();
  if (mode === 'off') return { configured: false, problem: '', state: 'loading', note: '', at: 0, okAt: null, checking: false, everyMs: 60_000, summary: null, alerts: [], gaps: [] };
  const containers = [
    ['plex', true], ['sonarr', true], ['radarr', true], ['prowlarr', true], ['qbittorrent', true], ['nextcloud', true], ['immich', true], ['home-assistant', true],
    ['vaultwarden', true], ['paperless', true], ['uptime-kuma', true], ['tautulli', true], ['overseerr', true], ['syncthing', true], ['dozzle', false], ['old-test', false],
  ] as const;
  const stopped = new Set(['nextcloud', 'old-test']);
  const summary: UnraidSummary = {
    host: 'Tower',
    version: '7.2.0',
    uptimeSec: 12 * 86400 + 3 * 3600,
    array: { state: 'STARTED', started: true, usedKb: TB(31.6), totalKb: TB(58.8) },
    parity: { running: true, paused: false, correcting: false, progress: 38, speed: '101.5', errors: 0, last: { at: Date.parse('2026-10-01T04:20:00'), result: 'ok', errors: 0, durationSec: 52440, speed: '89.2' } },
    disks: [
      disk({ name: 'parity', device: 'sdb', role: 'parity', sizeKb: TB(16), tempC: 34, spin: 'down' }),
      disk({ name: 'parity2', device: 'sdc', role: 'parity', sizeKb: TB(16), tempC: 35, spin: 'down' }),
      data('disk1', 'sdd', 12, 8.4, { tempC: 36 }),
      data('disk2', 'sde', 12, 11.1, { tempC: 47 }),
      data('disk3', 'sdf', 4, 1.2, { tempC: null, spin: 'down' }),
      data('disk4', 'sdg', 4, 2.9, { tempC: 38, errors: 12, smart: 'unknown' }),
      data('disk5', 'sdh', 8, 5.6, { tempC: 33 }),
      data('disk6', 'sdi', 8, 2.4, { tempC: 33, spin: 'down' }),
    ],
    pools: [disk({ name: 'cache', device: 'nvme0n1', role: 'pool', ssd: true, sizeKb: TB(2), fsKb: TB(1.9), usedKb: TB(0.64), tempC: 41 }), disk({ name: 'apps', device: 'nvme1n1', role: 'pool', ssd: true, sizeKb: TB(1), fsKb: TB(0.95), usedKb: TB(0.31), tempC: 44 })],
    cpuPct: 12.4,
    mem: { pct: 41.7, usedBytes: 13.4e9, totalBytes: 32.2e9 },
    containers: containers.map(([name, autoStart]) => ({
      name,
      state: stopped.has(name) ? ('stopped' as const) : name === 'dozzle' ? ('paused' as const) : ('running' as const),
      autoStart,
      detail: stopped.has(name) ? (name === 'old-test' ? 'Exited (0) 3 weeks ago' : 'Exited (137) 5 minutes ago') : 'Up 3 days',
      stoppedAt: name === 'nextcloud' ? now - 5 * 60_000 : null,
    })),
    vms: [
      { name: 'Windows 11', state: 'running' },
      { name: 'Home Assistant', state: 'stopped' },
    ],
    notices: { warning: 1, alert: 0, latest: [{ level: 'warning', text: 'Warning [TOWER] - disk 4 in error state (sdg)', at: now - 3 * 3600_000 }] },
    ups: [{ name: 'Back-UPS', status: 'Online', chargePct: 100, runtimeSec: 2400, loadPct: 18, onBattery: false }],
    hotC: 45,
    maxC: 55,
  };
  const alerts: UnraidAlert[] = [
    { id: 'disk-errors:disk4', level: 'alert', kind: 'disk-errors', text: 'DISK4 HAS 12 ERRORS', detail: 'Unraid counted read or write errors on it.' },
    { id: 'disk-hot:disk2', level: 'warn', kind: 'disk-hot', text: 'DISK2 IS 47 C', detail: 'Over 45 C.' },
    { id: 'container-stopped:nextcloud', level: 'warn', kind: 'container-stopped', text: 'NEXTCLOUD HAS STOPPED', detail: 'Set to start with the array. Exited (137) 5 minutes ago' },
    { id: 'unread:warning', level: 'warn', kind: 'unread', text: '1 UNREAD UNRAID WARNING', detail: 'Warning [TOWER] - disk 4 in error state (sdg)' },
  ];
  if (mode === 'down') return { configured: true, problem: '', state: 'down', note: 'Nothing answers at that address (connection refused). Is the address right?', at: now - 30_000, okAt: now - 12 * 60_000, checking: false, everyMs: 60_000, summary, alerts, gaps: [] };
  return { configured: true, problem: '', state: 'ok', note: '', at: now - 4000, okAt: now - 4000, checking: false, everyMs: 60_000, summary, alerts, gaps: [] };
}
