import './unraid.css';
import type { UnraidAlert, UnraidDisk, UnraidLinkState, UnraidResponse, UnraidSummary } from '../../shared/unraid.ts';
import { button, el, timeAgo } from './ui.ts';
import { segBar } from './usage.ts';
import { fmtBytes, fmtDay, fmtKb, fmtSpan, fmtSpeed, fmtUptime, pctOf } from './unraidfmt.ts';

// STATION > Unraid: the health of the owner's Unraid server, drawn from GET /api/station/unraid (server/unraid.ts,
// shared/unraid.ts): alerts on top, then array and parity, CPU and RAM, every disk, cache pools, Docker, VMs, unread
// Unraid notices, UPS and what is known about backups. Not connected: a short note with the steps. The server does the
// asking; this file only draws what it was given (as text, never as HTML). Nothing from here goes to a chat.

const HIDE_KEY = 'phosphor.station.unraid.hide';
const BAR_SEGS = 20;

const LAMP: Record<Exclude<UnraidLinkState, 'ok'>, string> = { loading: 'WAIT…', down: 'NO ANSWER', auth: 'KEY REFUSED', wrong: 'NOT UNRAID?', error: 'ERROR' };

export type UnraidPanel = { root: HTMLElement; set(r: UnraidResponse | null): void };

export function mountUnraid(): UnraidPanel {
  const root = el('section', 'un');
  root.hidden = true;
  const hide = () => {
    try {
      localStorage.setItem(HIDE_KEY, '1');
    } catch {
      /* storage blocked: it comes back next time */
    }
    root.hidden = true;
  };
  return {
    root,
    set(r) {
      root.hidden = !r || (!r.configured && isHidden());
      if (root.hidden || !r) return;
      root.className = `un${r.state === 'ok' ? '' : ' un-stale'}${r.configured ? '' : ' un-setup'}`;
      root.replaceChildren(...(r.configured ? panel(r) : [setupNote(r.problem, hide)]));
    },
  };
}

function isHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- not connected

function setupNote(problem: string, hide: () => void): HTMLElement {
  const box = el('div', 'un-note');
  const head = el('div', 'un-head');
  head.append(el('span', 'un-lamp', 'NOT CONNECTED'), el('span', 'un-host', 'UNRAID'));
  const steps = el('ol', 'un-steps');
  for (const t of [
    'In Unraid: Settings > Management Access > API Keys. Create a key with the VIEWER role (read-only) and copy it.',
    'On this PC, in the .env file, add PHOSPHOR_UNRAID_URL=http://your-server-address and PHOSPHOR_UNRAID_KEY=the key.',
    'Run: systemctl --user restart phosphor-os-server',
  ]) steps.append(el('li', '', t));
  box.append(
    head,
    el('p', 'un-dim', 'Connect your Unraid server to see its array, disks, temperatures, parity, Docker, VMs and alerts here. Read-only: the key can only look.'),
    steps,
    el('p', 'un-dim', 'Needs Unraid 7.2 or newer, or the Unraid Connect plugin. The key stays on this PC. Details: docs/STATION.md.'),
  );
  if (problem) box.append(el('p', 'un-problem', `.env: ${problem}`));
  const row = el('div', 'un-row');
  row.append(button('HIDE THIS', hide));
  box.append(row);
  return box;
}

// ---------------------------------------------------------------- the panel

function panel(r: UnraidResponse): HTMLElement[] {
  const s = r.summary;
  const out: HTMLElement[] = [head(r, s)];
  if (r.state !== 'ok') out.push(banner(r));
  if (!s) return out;

  const ids = new Set(r.alerts.map((a) => a.id));
  out.push(alertRows(r.alerts, r.state === 'ok'));

  const grid = el('div', 'un-grid');
  grid.append(arrayCard(s), systemCard(s));
  if (s.disks.length) grid.append(disksCard('DISKS', s.disks, ids, true));
  if (s.pools.length) grid.append(disksCard('CACHE AND POOLS', s.pools, ids, false));
  if (s.containers) grid.append(containersCard(s.containers, ids));
  if (s.vms) grid.append(vmsCard(s.vms, ids));
  if (s.notices) grid.append(noticesCard(s.notices));
  if (s.ups.length) grid.append(upsCard(s));
  grid.append(backupsCard(s));
  out.push(grid);
  if (r.gaps.length) out.push(el('p', 'un-dim un-gaps', `NOT ANSWERED: ${r.gaps.join(' · ')}`));
  return out;
}

function head(r: UnraidResponse, s: UnraidSummary | null): HTMLElement {
  const h = el('div', 'un-head');
  const ok = r.state === 'ok';
  const started = !!s?.array?.started;
  const word = !ok ? LAMP[r.state] : s?.array ? (started ? 'ARRAY STARTED' : `ARRAY ${s.array.state}`) : 'ONLINE';
  const lamp = el('span', `un-lamp ${ok && (started || !s?.array) ? 'un-up' : r.state === 'loading' ? 'un-wait' : 'un-down'}`, word);
  const when = r.okAt ? `${ok ? 'UPDATED' : 'LAST ANSWER'} ${timeAgo(r.okAt).toUpperCase()}` : '';
  const meta = [s?.version && `UNRAID ${s.version}`, s?.uptimeSec != null && `UP ${fmtUptime(s.uptimeSec)}`, when].filter(Boolean).join(' · ');
  h.append(lamp, el('span', 'un-host', (s?.host || 'UNRAID').toUpperCase()), el('span', 'un-meta', meta));
  return h;
}

function banner(r: UnraidResponse): HTMLElement {
  const b = el('div', 'un-banner');
  b.append(el('strong', '', r.state === 'loading' ? 'ASKING UNRAID…' : LAMP[r.state as Exclude<UnraidLinkState, 'ok'>]));
  if (r.note) b.append(el('span', '', ` ${r.note}`));
  if (r.summary) b.append(el('span', 'un-dim', ' Below is the last answer.'));
  return b;
}

function alertRows(alerts: UnraidAlert[], live: boolean): HTMLElement {
  const box = el('div', 'un-alerts');
  if (!alerts.length) {
    box.append(el('div', 'un-clear', live ? 'NO ALERTS' : 'NO ALERTS IN THE LAST ANSWER'));
    return box;
  }
  for (const a of alerts) {
    const row = el('div', `un-arow un-lv-${a.level}`);
    row.append(el('span', 'un-tag', a.level === 'alert' ? 'ALERT' : 'WARN'), el('span', 'un-atext', a.text));
    if (a.detail) row.append(el('span', 'un-adetail', a.detail));
    box.append(row);
  }
  return box;
}

// ---------------------------------------------------------------- cards

function card(label: string, extra = '', wide = false): HTMLElement {
  const c = el('section', `un-card${wide ? ' un-wide' : ''}`);
  const h = el('h3', 'ms-h');
  h.append(el('span', 'ms-h-label', label), el('span', 'ms-h-extra', extra));
  c.append(h);
  return c;
}

// "LABEL [bar] 26%" with a detail line under it.
function gauge(key: string, pct: number | null, detail = '', hot = false): HTMLElement {
  const g = el('div', `un-g${hot ? ' un-hot' : ''}`);
  g.append(el('span', 'un-k', key), segBar(pct ?? 0, BAR_SEGS), el('span', 'un-v', pct === null ? '--%' : `${Math.round(pct)}%`));
  if (detail) g.append(el('div', 'un-d', detail));
  return g;
}

function arrayCard(s: UnraidSummary): HTMLElement {
  const a = s.array;
  const c = card('ARRAY', a ? (a.started ? 'STARTED' : a.state) : '');
  if (a) {
    const used = pctOf(a.usedKb, a.totalKb);
    c.append(gauge('FULL', used, a.totalKb ? `${fmtKb(a.usedKb)} USED OF ${fmtKb(a.totalKb)}` : ''));
  } else c.append(el('div', 'un-dim', 'THE ARRAY DID NOT ANSWER'));
  const p = s.parity;
  if (p?.running) {
    const words = [p.paused ? 'PAUSED' : 'RUNNING', p.correcting ? 'CORRECTING' : 'CHECK ONLY', fmtSpeed(p.speed), p.errors ? `${p.errors} ERROR${p.errors === 1 ? '' : 'S'}` : ''].filter(Boolean).join(' · ');
    c.append(gauge('PARITY', p.progress, words, !!p.errors));
  } else if (p) c.append(el('div', 'un-line', 'PARITY CHECK: NOT RUNNING'));
  return c;
}

function systemCard(s: UnraidSummary): HTMLElement {
  const c = card('SYSTEM', s.uptimeSec != null ? `UP ${fmtUptime(s.uptimeSec)}` : '');
  c.append(gauge('CPU', s.cpuPct, '', (s.cpuPct ?? 0) >= 90));
  if (s.mem) c.append(gauge('RAM', s.mem.pct, s.mem.totalBytes ? `${fmtBytes(s.mem.usedBytes)} OF ${fmtBytes(s.mem.totalBytes)}` : '', s.mem.pct >= 90));
  else c.append(el('div', 'un-dim', 'CPU AND RAM DID NOT ANSWER'));
  return c;
}

function disksCard(label: string, disks: UnraidDisk[], ids: Set<string>, wide: boolean): HTMLElement {
  const asleep = disks.filter((d) => d.spin === 'down').length;
  const c = card(label, `${disks.length}${asleep ? ` · ${asleep} ASLEEP` : ''}`, wide);
  const list = el('div', 'un-disks');
  for (const d of disks) list.append(diskItem(d, ids));
  c.append(list);
  return c;
}

function diskItem(d: UnraidDisk, ids: Set<string>): HTMLElement {
  const bad = ids.has(`disk-bad:${d.name}`);
  const root = el('div', `un-disk${bad || ids.has(`disk-errors:${d.name}`) ? ' un-bad' : ids.has(`disk-hot:${d.name}`) ? ' un-warm' : ''}`);
  root.title = [d.device, d.status === 'bad' ? d.statusText : '', d.smart === 'ok' ? 'SMART OK' : 'SMART not reported'].filter(Boolean).join(' · ');
  const top = el('div', 'un-disk-top');
  const temp = d.tempC !== null ? `${d.tempC} C` : d.spin === 'down' ? 'ASLEEP' : '-- C';
  top.append(el('span', 'un-disk-name', d.name.toUpperCase()), el('span', 'un-disk-dev', d.device), el('span', `un-disk-temp${ids.has(`disk-hot:${d.name}`) ? ' un-hot' : ''}`, temp));
  root.append(top);
  const pct = pctOf(d.usedKb, d.fsKb);
  if (pct !== null) {
    const use = el('div', 'un-disk-use');
    use.append(segBar(pct, 16), el('span', 'un-v', `${fmtKb(d.usedKb)} / ${fmtKb(d.fsKb)}`));
    root.append(use);
  } else root.append(el('div', 'un-line', d.role === 'parity' ? `PARITY, ${fmtKb(d.sizeKb)}` : fmtKb(d.sizeKb)));
  const notes = [d.status === 'bad' ? d.statusText : '', d.smart === 'ok' ? 'SMART OK' : 'SMART ?', d.errors ? `${d.errors} ERROR${d.errors === 1 ? '' : 'S'}` : '0 ERRORS', d.spin === 'down' ? 'SPUN DOWN' : d.spin === 'up' ? 'SPINNING' : ''].filter(Boolean);
  root.append(el('div', 'un-disk-notes', notes.join(' · ')));
  return root;
}

function chip(text: string, cls: string, title: string): HTMLElement {
  const c = el('span', `un-chip ${cls}`, text);
  c.title = title;
  return c;
}

function containersCard(list: NonNullable<UnraidSummary['containers']>, ids: Set<string>): HTMLElement {
  const stopped = list.filter((c) => c.state === 'stopped').length;
  const c = card('DOCKER', list.length ? `${list.length - stopped} RUNNING${stopped ? ` · ${stopped} STOPPED` : ''}` : 'NONE');
  const row = el('div', 'un-chips');
  const rank = (x: (typeof list)[number]) => (ids.has(`container-stopped:${x.name}`) ? 0 : x.state === 'stopped' ? 1 : x.state === 'paused' ? 2 : 3);
  for (const x of [...list].sort((a, b) => rank(a) - rank(b))) {
    const cls = x.state === 'running' ? '' : x.state === 'paused' ? 'un-paused' : ids.has(`container-stopped:${x.name}`) ? 'un-badchip' : 'un-off';
    row.append(chip(x.name, cls, [x.state.toUpperCase(), x.detail, x.autoStart ? 'starts with the array' : ''].filter(Boolean).join(' · ')));
  }
  if (!list.length) row.append(el('span', 'un-dim', 'NO CONTAINERS'));
  c.append(row);
  return c;
}

function vmsCard(list: NonNullable<UnraidSummary['vms']>, ids: Set<string>): HTMLElement {
  const up = list.filter((v) => v.state === 'running').length;
  const c = card('VMS', list.length ? `${up} RUNNING · ${list.length} IN ALL` : 'NONE');
  const row = el('div', 'un-chips');
  for (const v of list) row.append(chip(v.name, v.state === 'running' ? '' : v.state === 'crashed' || ids.has(`vm-crashed:${v.name}`) ? 'un-badchip' : v.state === 'paused' ? 'un-paused' : 'un-off', v.state.toUpperCase()));
  if (!list.length) row.append(el('span', 'un-dim', 'NO VIRTUAL MACHINES'));
  c.append(row);
  return c;
}

function noticesCard(n: NonNullable<UnraidSummary['notices']>): HTMLElement {
  const c = card('UNRAID NOTICES', n.alert || n.warning ? `${n.alert} ALERT${n.alert === 1 ? '' : 'S'} · ${n.warning} WARNING${n.warning === 1 ? '' : 'S'} UNREAD` : 'NOTHING UNREAD');
  if (!n.latest.length) c.append(el('div', 'un-dim', n.alert || n.warning ? 'THE LIST OF TITLES DID NOT COME' : 'NO UNREAD WARNINGS OR ALERTS'));
  for (const x of n.latest.slice(0, 4)) {
    const row = el('div', `un-arow un-lv-${x.level === 'alert' ? 'alert' : 'warn'}`);
    row.append(el('span', 'un-tag', x.level === 'alert' ? 'ALERT' : 'WARN'), el('span', 'un-atext', x.text));
    if (x.at) row.append(el('span', 'un-adetail', timeAgo(x.at).toUpperCase()));
    c.append(row);
  }
  return c;
}

function upsCard(s: UnraidSummary): HTMLElement {
  const c = card('UPS', s.ups[0].status.toUpperCase());
  for (const u of s.ups) {
    c.append(gauge('CHARGE', u.chargePct, [u.name, u.runtimeSec != null ? `${Math.round(u.runtimeSec / 60)} MIN LEFT` : '', u.loadPct != null ? `LOAD ${u.loadPct}%` : ''].filter(Boolean).join(' · '), u.onBattery));
  }
  return c;
}

// What Unraid's API says about backups: the last parity check. It can start a flash backup but has no question that
// says when one last ran, so that line only says so.
function backupsCard(s: UnraidSummary): HTMLElement {
  const c = card('BACKUPS');
  const p = s.parity;
  const last = p?.last;
  const text = !p ? 'NOT KNOWN' : p.running ? `RUNNING NOW, ${p.progress ?? '?'}%` : !last ? 'NEVER RUN' : [{ ok: 'OK, 0 ERRORS', errors: `${last.errors ?? '?'} ERRORS`, cancelled: 'CANCELLED', failed: 'FAILED' }[last.result], fmtDay(last.at), last.durationSec != null ? fmtSpan(last.durationSec) : '', fmtSpeed(last.speed)].filter(Boolean).join(' · ');
  const row = (k: string, v: string, bad = false) => {
    const r = el('div', `un-kv${bad ? ' un-hot' : ''}`);
    r.append(el('span', 'un-k', k), el('span', 'un-kvv', v));
    return r;
  };
  c.append(row('PARITY CHECK', text, last?.result === 'errors' || last?.result === 'failed'));
  const flash = row('FLASH BACKUP', 'NOT SHOWN BY THE UNRAID API');
  flash.classList.add('un-dim');
  flash.title = 'Unraid\'s API can start a flash backup but has no way to say when one last ran. Look in Unraid Connect.';
  c.append(flash);
  return c;
}
