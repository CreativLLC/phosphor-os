import type { CalendarEvent } from '../../shared/protocol.ts';

// Text helpers shared by the TODAY panel (today.ts) and the month view (calendar.ts).

export const DAY_MS = 86_400_000;
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const dayStart = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
export const dayLabel = (ms: number) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();

// Google descriptions can carry HTML. Shown as plain text only (textContent), tags dropped.
export function plain(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 800);
}

// "9:30 AM - 10:00 AM", across midnight "Wed 11:00 PM - Thu 1:00 AM", all-day "Wed 14 Oct" or "Wed 14 Oct - Thu 15 Oct".
export function rangeLabel(e: CalendarEvent): string {
  const s = new Date(e.start).getTime();
  const en = new Date(e.end).getTime();
  if (e.allDay) {
    const last = en - DAY_MS; // end is the midnight after the last day
    return last > s ? `${dayLabel(s)} - ${dayLabel(last)}` : dayLabel(s);
  }
  if (dayStart(s) === dayStart(en) || en === dayStart(en)) return `${clock(s)} - ${clock(en)}`;
  return `${dayLabel(s)} ${clock(s)} - ${dayLabel(en)} ${clock(en)}`;
}

// Links into Google Calendar (EDIT, + NEW). A plain link with target _blank: the desktop app hands it to the default
// browser (setWindowOpenHandler), a phone opens a new tab. Nothing is changed from here.
export function extLink(label: string, href: string, cls: string, title: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = `ext-link ${cls}`;
  a.textContent = label;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = title;
  a.addEventListener('click', (e) => e.stopPropagation()); // not a click on the row or heading behind it
  return a;
}

// The draft address for an all-day event on a day (`base` is the server's newUrl; it ends in "dates=").
export function newHref(base: string, dayMs: number): string {
  const ymd = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };
  const d = new Date(dayMs);
  return `${base}${ymd(dayMs)}/${ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime())}`;
}
