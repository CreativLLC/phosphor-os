// STATION > Unraid: number and time words for the panel (unraid.ts). No DOM here, so tests/station-unraid.ts can run it.
// Unraid's sizes are in KiB (1024 bytes); its disk sizes are shown the way disks are sold, in decimal TB and GB.

const UNITS = [
  ['PB', 1e15],
  ['TB', 1e12],
  ['GB', 1e9],
  ['MB', 1e6],
  ['KB', 1e3],
] as const;

export function fmtBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '--';
  for (const [name, size] of UNITS) {
    if (bytes >= size) {
      const v = bytes / size;
      return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${name}`;
    }
  }
  return `${Math.round(bytes)} B`;
}

export const fmtKb = (kb: number | null): string => fmtBytes(kb === null ? null : kb * 1024);

export const pctOf = (used: number | null, total: number | null): number | null => (used === null || total === null || total <= 0 ? null : Math.min(100, Math.max(0, Math.round((used / total) * 100))));

// 12D 3H, 5H 12M, 42M
export function fmtUptime(sec: number | null): string {
  if (sec === null || sec < 0) return '--';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}D ${h}H`;
  if (h) return `${h}H ${m}M`;
  return m ? `${m}M` : '<1M';
}

// 14H 34M, 34M 12S, 45S
export function fmtSpan(sec: number | null): string {
  if (sec === null || sec < 0) return '--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}H ${String(m).padStart(2, '0')}M`;
  return m ? `${m}M ${String(s).padStart(2, '0')}S` : `${s}S`;
}

// 2026-10-01 (this device's calendar day)
export function fmtDay(ms: number | null): string {
  if (ms === null) return '--';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "98.1" (MB/s, as Unraid's schema says), "98.1 MB/s", "1.2 GB/s", or a huge plain number (bytes a second) -> "98 MB/S";
// anything else -> ''
export function fmtSpeed(s: string): string {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:([KMGT])?B\/?s)?\s*$/i.exec(s);
  if (!m) return '';
  const unit = m[2]?.toUpperCase();
  let mb = Number(m[1]) * ({ K: 1e-3, M: 1, G: 1e3, T: 1e6 }[unit ?? 'M'] ?? 1);
  if (!unit && mb > 20000) mb /= 1e6; // no parity check runs at 20 GB/s: it is bytes a second
  return mb > 0 ? `${Math.round(mb)} MB/S` : '';
}
