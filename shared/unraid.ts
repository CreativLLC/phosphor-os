// STATION > Unraid: the cleaned summary the server keeps (server/unraid.ts) and the page draws (web/src/unraid.ts).
// Built by server/unraidapi.ts from Unraid's own GraphQL API (read-only questions). These shapes never hold the
// server's address or the API key, and no chat tool, MCP tool or prompt is given any of this: it goes to the screen only.

// loading: first answer not in yet. down: no answer from the address. auth: the key was refused (or reads nothing).
// wrong: the address answers but is not Unraid's API. error: Unraid answered, but nothing the page can use.
export type UnraidLinkState = 'loading' | 'ok' | 'down' | 'auth' | 'wrong' | 'error';

export type UnraidDisk = {
  name: string; // the slot as Unraid names it: parity, disk1, cache
  device: string; // sdb, nvme0n1 ('' unknown)
  role: 'parity' | 'data' | 'pool';
  ssd: boolean;
  tempC: number | null;
  sizeKb: number | null; // the disk
  usedKb: number | null; // used on its file system (null: parity, or not mounted)
  fsKb: number | null; // size of that file system
  errors: number; // read/write errors Unraid counted
  smart: 'ok' | 'unknown' | 'off'; // Unraid's API only says OK or UNKNOWN; off = not asked (PHOSPHOR_UNRAID_SMART is not set)
  spin: 'up' | 'down' | null;
  status: 'ok' | 'new' | 'bad';
  statusText: string; // DISABLED, MISSING, WRONG DISK, INVALID; '' when ok
};

export type UnraidParity = {
  running: boolean;
  paused: boolean;
  correcting: boolean;
  progress: number | null; // percent
  speed: string; // MB/s as Unraid says it ('' unknown)
  errors: number | null; // found so far
  last: { at: number | null; result: 'ok' | 'errors' | 'cancelled' | 'failed'; errors: number | null; durationSec: number | null; speed: string } | null;
};

export type UnraidContainer = {
  name: string;
  state: 'running' | 'paused' | 'stopped';
  autoStart: boolean;
  detail: string; // Docker's own words: "Up 3 hours", "Exited (137) 5 minutes ago"
  stoppedAt: number | null; // when this page's server saw it stop (null: not seen running)
};

export type UnraidVm = { name: string; state: 'running' | 'paused' | 'stopped' | 'crashed' };

export type UnraidNotices = {
  warning: number; // unread
  alert: number; // unread
  latest: { level: 'alert' | 'warning'; text: string; at: number | null }[];
};

export type UnraidUps = { name: string; status: string; chargePct: number | null; runtimeSec: number | null; loadPct: number | null; onBattery: boolean };

export type UnraidSummary = {
  host: string;
  version: string;
  uptimeSec: number | null;
  array: { state: string; started: boolean; usedKb: number | null; totalKb: number | null } | null;
  parity: UnraidParity | null;
  disks: UnraidDisk[]; // parity first, then data disks, in slot order
  pools: UnraidDisk[]; // cache and other pools
  cpuPct: number | null;
  mem: { pct: number; usedBytes: number | null; totalBytes: number | null } | null;
  containers: UnraidContainer[] | null; // null: Docker did not answer
  vms: UnraidVm[] | null; // null: VMs did not answer
  notices: UnraidNotices | null;
  ups: UnraidUps[];
  hotC: number; // hard disks warn here, as Unraid's own display settings say (45 if they did not come)
  maxC: number; // and are in trouble here (55)
};

export type UnraidAlertKind = 'array-stopped' | 'disk-bad' | 'disk-errors' | 'disk-hot' | 'parity-errors' | 'container-stopped' | 'vm-crashed' | 'ups-battery' | 'unread';

export type UnraidAlert = {
  id: string; // kind plus what it is about, stable between answers
  level: 'warn' | 'alert';
  kind: UnraidAlertKind;
  text: string;
  detail: string;
};

// GET /api/station/unraid. Not configured: only `configured: false` and, when half set up, what is missing.
export type UnraidResponse = {
  configured: boolean;
  problem: string; // not configured, but a line is half set up: "PHOSPHOR_UNRAID_KEY is empty."
  state: UnraidLinkState;
  note: string; // plain words about why state is not ok
  at: number; // last try (0 = none yet)
  okAt: number | null; // last answer with data
  checking: boolean; // a poll runs now: ask again soon
  everyMs: number; // polled this often while STATION is on screen
  summary: UnraidSummary | null; // the last good answer; stale when state is not ok
  alerts: UnraidAlert[];
  gaps: string[]; // parts that did not answer: "DOCKER: not allowed for this key"
};
