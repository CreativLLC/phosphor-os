// Version rules for the Claude Agent SDK update check (server/sdkupdate.ts). Pure, tested in tests/sdkversion.ts.

export type Ver = [number, number, number];

// Plain X.Y.Z only. Pre-releases and anything odd are ignored on purpose (never auto-installed).
export function parseVer(v: unknown): Ver | null {
  const m = typeof v === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function cmpVer(a: Ver, b: Ver): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// Does a package.json range ("^0.3.296", "~1.2.3", "1.2.3") accept this version? Same rule npm uses for caret:
// the left-most non-zero part is fixed. Any other range form: no (then nothing is installed automatically).
export function inRange(range: string, version: string): boolean {
  const m = /^([\^~]?)(\d+\.\d+\.\d+)$/.exec(range.trim());
  const base = m && parseVer(m[2]);
  const v = parseVer(version);
  if (!m || !base || !v || cmpVer(v, base) < 0) return false;
  if (m[1] === '') return cmpVer(v, base) === 0;
  const fixed = m[1] === '~' ? 2 : base[0] > 0 ? 1 : base[1] > 0 ? 2 : 3;
  return base.slice(0, fixed).every((n, i) => n === v[i]);
}

// What the registry's newest version means for this install.
// pending: install it (newer and inside the range). bigger: newer but outside the range (needs a code check).
export function classify(range: string, installed: string, latest: string): { pending: string | null; bigger: string | null } {
  const have = parseVer(installed);
  const next = parseVer(latest);
  if (!have || !next || cmpVer(next, have) <= 0) return { pending: null, bigger: null };
  return inRange(range, latest) ? { pending: latest, bigger: null } : { pending: null, bigger: latest };
}

// The nightly run (04:00 hour, once per local day).
export function nightDue(now: Date, lastTried: string): boolean {
  return now.getHours() === 4 && dayKey(now) !== lastTried;
}

export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
