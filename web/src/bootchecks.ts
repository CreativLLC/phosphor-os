import type { BootCheckResponse, VoiceStatusResponse } from '../../shared/protocol.ts';
import { toast } from './ui.ts';

// Real checks on the boot screen (boot.ts shows the lines; server/bootcheck.ts runs most checks).
// The boot screen never waits for them: lines start as "...", fill in as answers arrive, and whatever
// has not arrived when the boot ends stays "...". Problems found also show as one toast after the boot.
// bootCheckLines() and onBootCheck() are all a boot screen needs (the LCARS boot can use them too).

export type CheckState = 'ok' | 'warn' | 'fail' | 'wait';
export type CheckLine = { id: string; label: string; state: CheckState; detail: string };

const TIMEOUT_MS = 4000; // the server answers in under 2 s; later than this it is stuck

let lines: CheckLine[] = [
  { id: 'link', label: 'LINK TO HOST', state: 'wait', detail: '' },
  { id: 'login', label: 'LOGIN', state: 'wait', detail: '' },
  { id: 'voice', label: 'VOICE ENGINE', state: 'wait', detail: '' },
  { id: 'tailscale', label: 'TAILSCALE', state: 'wait', detail: '' },
  { id: 'disk', label: 'WORKSPACE DISK', state: 'wait', detail: '' },
];
let started = false;
let settled = 0; // answers in (of 2)
let reported = false;
const listeners = new Set<() => void>();

export function bootChecks(): readonly CheckLine[] {
  start();
  return lines;
}

export function onBootCheck(fn: () => void): void {
  listeners.add(fn);
}

function set(id: string, state: CheckState, detail = ''): void {
  lines = lines.map((l) => (l.id === id ? { ...l, state, detail } : l));
  changed();
}

function changed(): void {
  for (const fn of listeners) fn();
}

async function get<T>(url: string): Promise<{ status: number; data: T | null }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    return { status: r.status, data: r.ok ? ((await r.json()) as T) : null };
  } finally {
    clearTimeout(t);
  }
}

function start(): void {
  if (started) return;
  started = true;

  const done = () => {
    settled++;
    changed();
  };
  get<BootCheckResponse>('/api/bootcheck')
    .then(
      ({ status, data }) => {
        set('link', 'ok');
        if (status === 401) return set('login', 'fail', 'LOGIN NEEDED');
        set('login', 'ok');
        if (!data) {
          // An older server without this route: say so instead of leaving dots forever.
          lines = lines.map((l) => (l.state === 'wait' && l.id !== 'voice' ? { ...l, state: 'warn', detail: 'NOT CHECKED' } : l));
          return;
        }
        // Lines the server left out do not apply on this PC (no Nextcloud folder, no MCP answer).
        const known = new Set<string>(data.checks.map((c) => c.id));
        lines = lines.filter((l) => ['link', 'login', 'voice'].includes(l.id) || known.has(l.id));
        for (const c of data.checks) {
          const line: CheckLine = { id: c.id, label: c.label, state: c.state, detail: c.detail };
          const i = lines.findIndex((l) => l.id === c.id);
          if (i >= 0) lines[i] = line;
          else lines.push(line);
        }
      },
      // Aborted = the server is there but slow; a network error = no link.
      (e: unknown) => set('link', e instanceof DOMException && e.name === 'AbortError' ? 'warn' : 'fail', e instanceof DOMException && e.name === 'AbortError' ? 'SLOW' : 'NO ANSWER'),
    )
    .finally(done);

  get<VoiceStatusResponse>('/api/voice')
    .then(
      ({ data }) => {
        if (!data) return set('voice', 'warn', 'NO ANSWER');
        if (!data.installed) return set('voice', 'warn', 'NOT INSTALLED');
        set('voice', 'ok', data.loaded ? 'LOADED' : 'STANDBY');
      },
      () => {},
    )
    .finally(done);
}

// One boot line, aligned with the boot screen's own: "TAILSCALE .............. OK   MY-PC".
export function formatCheck(l: CheckLine, col = 24): string {
  const state = l.state === 'wait' ? '...' : l.state.toUpperCase();
  const lead = `${l.label} ${'.'.repeat(Math.max(2, col - l.label.length - 1))}`;
  return `${lead} ${state.padEnd(4)}${l.detail ? ` ${l.detail}` : ''}`.trimEnd();
}

export function bootCheckLines(): string[] {
  return bootChecks().map((l) => formatCheck(l));
}

// After the boot screen: one toast if anything needs a look. Answers that come later still get reported.
export function reportBootChecks(): void {
  const say = () => {
    if (reported || settled < 2) return;
    reported = true;
    const bad = lines.filter((l) => l.state === 'warn' || l.state === 'fail');
    if (bad.length) toast(`BOOT CHECK: ${bad.map((l) => `${l.label} ${l.detail || l.state.toUpperCase()}`).join(', ')}`, 9000);
  };
  say();
  if (!reported) onBootCheck(say);
}
