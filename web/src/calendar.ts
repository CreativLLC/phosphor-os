import type { CalendarEvent, CalendarRangeResponse } from '../../shared/protocol.ts';
import { clock, dayStart, extLink, newHref, plain, rangeLabel } from './calfmt.ts';
import { demoMonth } from './demo.ts';
import { store } from './store.ts';
import { button, el } from './ui.ts';

// Month view (a <dialog> like the new-tab box), opened by clicking the TODAY heading (today.ts).
// Data: GET /api/calendar?from=&to= (server/calendar.ts) for the 6-week grid on screen; the server keeps 31 days back to
// 92 days ahead, and a day outside that span says so. Calendars are told apart by their place in `calendars`, as in the
// clock popup: a small numbered marker, shown only when there is more than one calendar. No names are built in.
// EDIT (per event) and + NEW (selected day) open Google Calendar in the browser (calfmt.ts extLink); nothing is changed here.
// Keys: arrows move the day, PageUp / PageDown the month, Esc closes. Narrow screens show markers and a count in the
// cells (titles do not fit) and the day's agenda below the grid.

const CELL_LINES = 3;
const GRID_DAYS = 42;

type Row = { e: CalendarEvent; cal: number; first: boolean; last: boolean; order: number; at: number };

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

// First day of the week: the locale's when the browser says (Mon=1 ... Sun=7), else Monday. Returns 0-6 (Sun=0).
function weekStart(): number {
  try {
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const fd = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay;
    if (fd) return fd % 7;
  } catch {
    /* unknown locale */
  }
  return 1;
}

// "9:30 AM" -> "9:30a" so a cell line keeps room for the title; 24-hour clocks stay as they are.
const shortClock = (ms: number) => clock(ms).replace(/\s?([AP])M$/i, (_, a: string) => a.toLowerCase());

function markColor(i: number): string {
  return i === 0 ? 'var(--ph-bright)' : i === 1 ? 'var(--accent)' : `hsl(${(i * 67) % 360} 60% 62%)`;
}

function marker(i: number): HTMLElement {
  const m = el('span', 'cal-mark', String(i + 1));
  m.style.setProperty('--cal-c', markColor(i));
  return m;
}

let openBox: HTMLDialogElement | undefined;

export function openCalendar(): void {
  if (openBox?.isConnected) return;
  const first = weekStart();
  const d = el('dialog', 'cal-box');
  openBox = d;
  const title = el('div', 'cal-title');
  const dow = el('div', 'cal-dow');
  const grid = el('div', 'cal-grid');
  const pane = el('div', 'cal-pane');
  const foot = el('div', 'cal-foot');
  const newBtn = extLink('+ NEW', '#', 'cal-new', 'New event on the selected day in Google Calendar'); // address set on every render
  grid.setAttribute('role', 'grid');

  let today = dayStart(Date.now());
  let sel = new Date(today);
  let view = monthStart(sel);
  let data: CalendarRangeResponse | undefined;
  let failed = false;
  let seq = 0;
  const cache = new Map<number, CalendarRangeResponse>();

  const gridStart = () => addDays(view, -((view.getDay() - first + 7) % 7));
  const weeks = () => Math.ceil(((view.getDay() - first + 7) % 7 + new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate()) / 7);

  function setSel(day: Date): void {
    sel = day;
    const m = monthStart(day);
    const moved = m.getTime() !== view.getTime();
    view = m;
    if (moved) void load();
    else render();
  }

  // Same day number in another month, clamped to that month's length (31 Jan + 1 month = 28/29 Feb).
  function monthStep(n: number): Date {
    const last = new Date(sel.getFullYear(), sel.getMonth() + n + 1, 0).getDate();
    return new Date(sel.getFullYear(), sel.getMonth() + n, Math.min(sel.getDate(), last));
  }

  async function load(): Promise<void> {
    const from = gridStart().getTime();
    const to = addDays(gridStart(), GRID_DAYS).getTime();
    const mine = ++seq;
    const hit = cache.get(from);
    if (hit) data = hit;
    else {
      data = undefined;
      failed = false;
      render();
      try {
        const r = store.demo ? demoMonth(from, to) : await fetch(`/api/calendar?from=${from}&to=${to}`, { cache: 'no-store' }).then((x) => (x.ok ? (x.json() as Promise<CalendarRangeResponse>) : Promise.reject(new Error('bad answer'))));
        cache.set(from, r);
        if (mine === seq) data = r;
      } catch {
        if (mine === seq) failed = true;
      }
    }
    if (mine === seq) render();
  }

  // Events by local day (ms of its midnight). A multi-day event shows on each day it covers, end excluded.
  function byDay(): Map<number, Row[]> {
    const out = new Map<number, Row[]>();
    if (!data) return out;
    const lo = gridStart().getTime();
    const hi = addDays(gridStart(), GRID_DAYS).getTime();
    for (const e of data.events) {
      const s = new Date(e.start).getTime();
      const en = new Date(e.end).getTime();
      const cal = Math.max(0, data.calendars.indexOf(e.calendar));
      const lastDay = dayStart(en > s ? en - 1 : s);
      let day = new Date(dayStart(s));
      for (let n = 0; n < GRID_DAYS + 31 && day.getTime() <= lastDay; n++, day = addDays(day, 1)) {
        const k = day.getTime();
        if (k < lo || k >= hi) continue;
        const isFirst = k === dayStart(s);
        const isLast = k === lastDay;
        const flat = e.allDay || (!isFirst && !isLast);
        const row: Row = { e, cal, first: isFirst, last: isLast, order: flat ? 0 : 1, at: isFirst ? s : k };
        const list = out.get(k);
        if (list) list.push(row);
        else out.set(k, [row]);
      }
    }
    for (const list of out.values()) list.sort((a, b) => a.order - b.order || a.at - b.at || a.e.title.localeCompare(b.e.title));
    return out;
  }

  const outside = (k: number) => !!data && (k >= data.rangeTo || addDays(new Date(k), 1).getTime() <= data.rangeFrom);
  const multi = () => (data?.calendars.length ?? 0) > 1;

  function render(): void {
    today = dayStart(Date.now());
    title.textContent = view.toLocaleDateString([], { month: 'long', year: 'numeric' }).toUpperCase();
    const days = byDay();
    const rows = weeks();
    grid.style.setProperty('--rows', String(rows));
    const cells: HTMLElement[] = [];
    for (let i = 0; i < rows * 7; i++) {
      const day = addDays(gridStart(), i);
      const k = day.getTime();
      const list = days.get(k) ?? [];
      const cell = el('div', 'cal-day');
      cell.setAttribute('role', 'gridcell');
      cell.classList.toggle('other', day.getMonth() !== view.getMonth());
      cell.classList.toggle('now', k === today);
      cell.classList.toggle('sel', k === sel.getTime());
      cell.classList.toggle('out', outside(k));
      cell.setAttribute('aria-selected', String(k === sel.getTime()));
      cell.setAttribute('aria-label', `${day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}, ${list.length} events`);
      cell.append(el('div', 'cal-num', String(day.getDate())));
      const shown = list.slice(0, CELL_LINES);
      for (const r of shown) {
        const line = el('div', 'cal-ev');
        line.classList.toggle('allday', r.order === 0);
        if (multi()) line.append(marker(r.cal));
        line.append(el('span', 'cal-ev-t', r.order === 0 ? r.e.title : `${r.first ? '' : '→'}${shortClock(new Date(r.first ? r.e.start : r.e.end).getTime())} ${r.e.title}`));
        cell.append(line);
      }
      if (list.length > CELL_LINES) cell.append(el('div', 'cal-more', `+${list.length - CELL_LINES} more`));
      if (list.length) {
        // Narrow screens: markers and a count instead of the lines above.
        const dots = el('div', 'cal-count');
        if (multi()) for (const c of [...new Set(list.map((r) => r.cal))].slice(0, 3)) dots.append(marker(c));
        dots.append(el('span', '', String(list.length)));
        cell.append(dots);
      }
      cell.onclick = () => setSel(day);
      cells.push(cell);
    }
    grid.replaceChildren(...cells);
    renderPane(days.get(sel.getTime()) ?? []);
    newBtn.hidden = !data?.newUrl;
    if (data?.newUrl) newBtn.href = newHref(data.newUrl, sel.getTime());
    foot.textContent = failed ? 'Could not load the calendar.' : data && !data.configured ? '' : data?.offline ? 'calendar offline: showing the last sync' : '';
    foot.hidden = !foot.textContent;
  }

  function renderPane(list: Row[]): void {
    const k = sel.getTime();
    const head = el('div', 'cal-pane-h');
    head.append(el('div', 'cal-pane-day', sel.toLocaleDateString([], { weekday: 'long' }).toUpperCase()), el('div', 'cal-pane-date', sel.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })));
    const body = el('div', 'cal-pane-body');
    if (failed) body.append(el('div', 'cal-empty', 'Could not load the calendar.'));
    else if (!data) body.append(el('div', 'cal-empty', 'Loading...'));
    else if (!data.configured) body.append(el('div', 'cal-empty', 'No calendar yet: add your address to the app settings, see docs/CALENDAR.md.'));
    else if (outside(k)) body.append(el('div', 'cal-empty', 'Outside the synced range'));
    else if (!list.length) body.append(el('div', 'cal-empty', 'Nothing planned.'));
    for (const r of list) {
      const card = el('article', 'cal-card');
      const top = el('div', 'cal-card-top');
      if (multi()) top.append(marker(r.cal));
      top.append(el('span', 'cal-card-title', r.e.title));
      card.append(top, el('div', 'cal-card-time', rowRange(r)));
      if (r.e.location) card.append(el('div', 'cal-card-place', r.e.location));
      const note = plain(r.e.description);
      if (note) card.append(el('div', 'cal-card-note', note));
      if (r.e.edit) card.append(extLink('EDIT', r.e.edit, 'cal-edit', 'Open in Google Calendar'));
      if (multi() && data) card.title = data.calendars[r.cal] ?? '';
      body.append(card);
    }
    pane.replaceChildren(head, body);
  }

  // Time range of a row in the agenda: the whole range for the event, "ALL DAY" for a middle day.
  function rowRange(r: Row): string {
    if (r.order === 0 && !r.e.allDay) return 'ALL DAY';
    return rangeLabel(r.e);
  }

  function close(): void {
    d.close();
  }

  const bar = el('div', 'cal-bar');
  bar.append(button('<', () => setSel(monthStep(-1)), 'cal-nav'), title, button('>', () => setSel(monthStep(1)), 'cal-nav'), button('TODAY', () => setSel(new Date(dayStart(Date.now()))), 'cal-today'), newBtn, button('CLOSE', close, 'cal-close'));
  bar.children[0].setAttribute('aria-label', 'Previous month');
  bar.children[2].setAttribute('aria-label', 'Next month');
  for (let i = 0; i < 7; i++) dow.append(el('div', '', new Date(2024, 0, 7 + ((first + i) % 7)).toLocaleDateString([], { weekday: 'short' }).toUpperCase()));
  const left = el('div', 'cal-left');
  left.append(dow, grid);
  const main = el('div', 'cal-main');
  main.append(left, pane);
  d.append(el('h2', '', 'CALENDAR'), bar, main, foot);

  d.addEventListener('keydown', (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.isComposing) return;
    const step: Record<string, () => Date> = {
      ArrowLeft: () => addDays(sel, -1),
      ArrowRight: () => addDays(sel, 1),
      ArrowUp: () => addDays(sel, -7),
      ArrowDown: () => addDays(sel, 7),
      PageUp: () => monthStep(-1),
      PageDown: () => monthStep(1),
    };
    const f = step[ev.key];
    if (!f) return;
    ev.preventDefault();
    setSel(f());
  });
  d.addEventListener('click', (ev) => {
    if (ev.target === d) close(); // the backdrop
  });
  d.addEventListener('close', () => {
    d.remove();
    openBox = undefined;
  });
  document.body.append(d);
  d.showModal();
  void load();
}
