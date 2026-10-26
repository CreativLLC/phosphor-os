import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { StationDay, StationState } from '../shared/station.ts';

// STATION: the last 24 hours of every service's checks, for the uptime strip on each tile. Checks are counted into
// 15-minute cells (checks, down, slow, milliseconds of the answered ones) and kept in data/station-health.json: about
// 2 KB per service, older cells are dropped on every save. No file given = memory only (tests).

export const CELL_MS = 15 * 60_000;
export const CELLS = 96; // 24 hours

type Cell = [checks: number, down: number, slow: number, ms: number];

export class Health {
  private rows = new Map<string, Map<number, Cell>>();
  private dirty = false;

  constructor(
    private readonly file: string | null,
    private readonly clock: () => number = Date.now,
  ) {
    this.load();
  }

  note(id: string, at: number, state: StationState, ms: number | null): void {
    if (state === 'unknown') return;
    let row = this.rows.get(id);
    if (!row) this.rows.set(id, (row = new Map()));
    const idx = Math.floor(at / CELL_MS);
    let cell = row.get(idx);
    if (!cell) row.set(idx, (cell = [0, 0, 0, 0]));
    cell[0]++;
    if (state === 'down') cell[1]++;
    else {
      if (state === 'slow') cell[2]++;
      cell[3] += ms ?? 0;
    }
    this.dirty = true;
  }

  // cells, oldest first, newest last: u all up, s some slow, p some down and some up, d all down, . no check.
  day(id: string, now = this.clock()): StationDay {
    const last = Math.floor(now / CELL_MS);
    const row = this.rows.get(id);
    let cells = '';
    let checks = 0;
    let down = 0;
    let ms = 0;
    for (let i = last - CELLS + 1; i <= last; i++) {
      const c = row?.get(i);
      if (!c?.[0]) {
        cells += '.';
        continue;
      }
      checks += c[0];
      down += c[1];
      ms += c[3];
      cells += c[1] === c[0] ? 'd' : c[1] ? 'p' : c[2] ? 's' : 'u';
    }
    const answered = checks - down;
    return { cells, checks, upPct: checks ? Math.round((answered / checks) * 1000) / 10 : null, avgMs: answered ? Math.round(ms / answered) : null };
  }

  forget(id: string): void {
    if (this.rows.delete(id)) this.dirty = true;
  }

  // Keeps only the services in `keep` and the last day; writes when something changed.
  save(keep: ReadonlySet<string>, now = this.clock()): void {
    const oldest = Math.floor(now / CELL_MS) - CELLS + 1;
    for (const [id, row] of this.rows) {
      if (!keep.has(id)) {
        this.rows.delete(id);
        this.dirty = true;
        continue;
      }
      for (const idx of row.keys()) {
        if (idx < oldest) {
          row.delete(idx);
          this.dirty = true;
        }
      }
      if (!row.size) this.rows.delete(id);
    }
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    const rows: Record<string, Record<number, Cell>> = {};
    for (const [id, row] of this.rows) rows[id] = Object.fromEntries(row);
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ rows }));
      renameSync(tmp, this.file);
    } catch {
      /* the strip is a nicety */
    }
  }

  private load(): void {
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { rows?: Record<string, Record<string, unknown>> };
      for (const [id, row] of Object.entries(raw.rows ?? {})) {
        const cells = new Map<number, Cell>();
        for (const [k, c] of Object.entries(row ?? {})) {
          if (Array.isArray(c) && c.length === 4 && c.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) && Number.isInteger(Number(k))) cells.set(Number(k), c as Cell);
        }
        if (cells.size) this.rows.set(id, cells);
      }
    } catch {
      /* none yet, or unreadable: start empty */
    }
  }
}
