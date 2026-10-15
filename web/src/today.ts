import type { CalendarEvent, TodayResponse } from '../../shared/protocol.ts';
import { clock, dayLabel, dayStart, DAY_MS, extLink, newHref, plain, rangeLabel } from './calfmt.ts';
import { openCalendar } from './calendar.ts';
import { demoToday } from './demo.ts';
import { store } from './store.ts';
import { el } from './ui.ts';

// TODAY section under CREW in the left column (agents.ts mounts it). From GET /api/today (server/calendar.ts): today's
// remaining calendar events (all-day first; finished ones are hidden), the next event when today is empty, and the
// owner's pending Omarchy reminders. Tap an event for its time range, place and description (like crew cards).
// Refresh: every minute while the page is visible (six times slower in GAME MODE), and on coming back into view.
// Without a calendar address in .env it shows the reminders and a one-line hint.
// Clicking the TODAY heading opens the month view (calendar.ts).

const EVERY_MS = 60_000;
const NEXT_DAYS = 7;
const gaming = () => document.documentElement.dataset.game === 'on';

type Heading = { el: HTMLElement; extra: HTMLElement };

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

// Time column: start time today, "…" + end time for an event that began before today, ALL DAY for all-day ones.
function timeLabel(e: CalendarEvent, today: number): string {
  if (e.allDay) return 'ALL DAY';
  const start = new Date(e.start).getTime();
  return start < today ? `… ${clock(new Date(e.end).getTime())}` : clock(start);
}

class EventRow {
  readonly el = el('article', 'today-ev');
  private time = el('div', 'today-time');
  private title = el('div', 'today-title');
  private detail = el('div', 'today-detail');
  readonly key: string;

  constructor(readonly e: CalendarEvent, prefix: string, open: boolean) {
    this.key = `${e.start}|${e.title}|${e.calendar}`;
    const range = el('div', 'today-range', rangeLabel(e));
    this.detail.append(range);
    if (e.location) this.detail.append(el('div', 'today-place', e.location));
    const note = plain(e.description);
    if (note) this.detail.append(el('div', 'today-note', note));
    if (e.edit) this.detail.append(extLink('EDIT', e.edit, 'today-edit', 'Open in Google Calendar'));
    if (prefix) this.time.textContent = prefix;
    setText(this.title, e.title);
    this.el.title = e.title;
    this.el.append(this.time, this.title, this.detail);
    this.el.tabIndex = 0;
    this.el.classList.toggle('open', open);
    this.el.onclick = () => this.el.classList.toggle('open');
    this.el.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this.el.classList.toggle('open');
      }
    };
  }

  get isOpen(): boolean {
    return this.el.classList.contains('open');
  }
}

export function mountToday(root: HTMLElement, head: Heading): void {
  root.classList.add('today');
  // The heading opens the month view.
  head.el.classList.add('crew-h-link');
  head.el.title = 'Open calendar';
  head.el.tabIndex = 0;
  head.el.setAttribute('role', 'button');
  head.el.onclick = () => openCalendar();
  head.el.onkeydown = (ev) => {
    if (ev.target === head.el && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      openCalendar();
    }
  };
  const list = el('div', 'today-list');
  const rem = el('div', 'today-rem-list');
  const note = el('div', 'today-note-line');
  let newLink: HTMLAnchorElement | undefined; // + NEW in the heading, kept in step with the day and the server's address
  const body = el('div', 'today-body'); // scrolls when there are many events
  body.append(list, rem);
  root.replaceChildren(head.el, body, note);
  root.hidden = true; // until the server has answered once

  let data: TodayResponse | undefined;
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const opened = new Set<string>(); // events left open stay open when the list redraws

  function render(): void {
    if (!data) return;
    root.hidden = false;
    const now = Date.now();
    const today = dayStart(now);
    const tomorrow = today + DAY_MS;
    const base = data.newUrl;
    if (!base) newLink?.remove();
    else if (!newLink?.isConnected || newLink.dataset.base !== base || newLink.dataset.day !== String(today)) {
      newLink?.remove();
      newLink = extLink('+ NEW', newHref(base, today), 'today-new', 'New event in Google Calendar');
      newLink.dataset.base = base;
      newLink.dataset.day = String(today);
      head.el.append(newLink);
    }
    setText(head.extra, new Date(now).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase());

    // Remaining today: not over yet, and starting before tomorrow. All-day first (the server sorts them first).
    const left = data.events.filter((e) => new Date(e.start).getTime() < tomorrow && new Date(e.end).getTime() > now);
    const rows: HTMLElement[] = [];
    const keep = new Set<string>();
    const add = (e: CalendarEvent, prefix: string, cls = ''): void => {
      const row = new EventRow(e, prefix, opened.has(`${e.start}|${e.title}|${e.calendar}`));
      if (cls) row.el.classList.add(cls);
      row.el.addEventListener('click', () => (row.isOpen ? opened.add(row.key) : opened.delete(row.key)));
      keep.add(row.key);
      rows.push(row.el);
    };
    for (const e of left) {
      const started = new Date(e.start).getTime() <= now;
      add(e, timeLabel(e, today), !e.allDay && started ? 'now' : e.allDay ? 'allday' : '');
    }
    if (data.configured && !left.length) {
      rows.push(el('div', 'today-empty', 'Nothing else today.'));
      // The next event after today (all-day events sort first, then by start).
      const next = data.events.filter((e) => new Date(e.start).getTime() >= tomorrow).sort((a, b) => a.start.localeCompare(b.start))[0];
      if (next && new Date(next.start).getTime() < tomorrow + NEXT_DAYS * DAY_MS) {
        const wrap = el('div', 'today-next');
        wrap.append(el('div', 'today-next-h', `Next: ${dayLabel(new Date(next.start).getTime())}`));
        add(next, next.allDay ? 'ALL DAY' : clock(new Date(next.start).getTime()));
        wrap.append(rows.pop()!);
        rows.push(wrap);
      } else rows.push(el('div', 'today-empty', `Nothing in the next ${NEXT_DAYS} days.`));
    }
    for (const k of opened) if (!keep.has(k)) opened.delete(k);
    list.replaceChildren(...rows);

    const rems = data.reminders.filter((r) => r.at > now);
    rem.replaceChildren(
      ...(rems.length ? [el('div', 'today-sub', 'REMINDERS')] : []),
      ...rems.map((r) => {
        const row = el('div', 'today-rem');
        row.append(el('div', 'today-time', clock(r.at)), el('div', 'today-title', r.label));
        row.title = r.label;
        return row;
      }),
    );
    rem.hidden = !rems.length;

    setText(note, !data.configured ? 'Add your calendar: see docs' : data.offline ? 'calendar offline' : '');
    note.hidden = !note.textContent;
  }

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      if (store.demo) data = demoToday();
      else {
        const r = await fetch('/api/today', { cache: 'no-store' });
        if (r.ok) data = (await r.json()) as TodayResponse;
      }
    } catch {
      /* server not reachable: keep what is on screen */
    }
    loading = false;
    render();
    schedule();
  }

  function schedule(): void {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(() => void load(), EVERY_MS * (gaming() ? 6 : 1));
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void load();
  });
  setTimeout(() => void load(), 0); // main.ts decides demo mode after the panels are mounted
  // Finished events drop off and the day rolls over without a server call.
  setInterval(() => {
    if (!document.hidden) render();
  }, 30_000);
}
