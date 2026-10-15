import ical, { type EventInstance, type ParameterValue, type VEvent } from 'node-ical';
import type { CalendarEvent } from '../shared/protocol.ts';
import { editUrl, type Gcal } from './gcal.ts';

// ICS text -> flat list of event occurrences in a time window. Pure (no files, no network), so the test can feed it a fixture.
// Library: node-ical (RRULE, EXDATE, RECURRENCE-ID overrides, IANA time zones and all-day events built in).
// Output times are ISO strings in UTC; all-day events run from local midnight to local midnight (end excluded).

// The span the server keeps: SYNC_BACK_DAYS before today up to SYNC_AHEAD_DAYS after it (the month view pages through it).
export const SYNC_BACK_DAYS = 31;
export const SYNC_AHEAD_DAYS = 92;

// [from, to) in local midnights around `today` (a local midnight): to is the midnight after the last kept day.
export function syncWindow(today: Date): { from: Date; to: Date } {
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();
  return { from: new Date(y, m, d - SYNC_BACK_DAYS), to: new Date(y, m, d + SYNC_AHEAD_DAYS + 1) };
}

// Events that touch [from, to) (ms). An end-less or zero-length event counts by its start.
export function eventsBetween(events: CalendarEvent[], from: number, to: number): CalendarEvent[] {
  return events.filter((e) => {
    const s = new Date(e.start).getTime();
    return s < to && (new Date(e.end).getTime() > from || s >= from);
  });
}

const text = (v: ParameterValue | undefined): string => (v == null ? '' : typeof v === 'string' ? v : String(v.val ?? '')).trim();

// A date-only value: node-ical gives the instant of that date at midnight in the event's zone (UTC if floating).
// What matters is the calendar day, so read the day in that zone and rebuild it as local midnight.
function dayStart(d: Date & { tz?: string }): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: d.tz ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return new Date(n('year'), n('month') - 1, n('day'));
}

// `fallbackName` labels the events when the feed has no name of its own. `gcal`: a Google calendar, whose events get an `edit` link.
export function expandIcs(ics: string, from: Date, to: Date, fallbackName: string, gcal: Gcal | null = null): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const data = ical.parseICS(ics);
  const calendar = text(data.vcalendar?.['WR-CALNAME' as keyof typeof data.vcalendar] as ParameterValue | undefined) || fallbackName;
  for (const comp of Object.values(data)) {
    if (!comp || comp.type !== 'VEVENT') continue;
    const ev = comp as VEvent;
    if (ev.status === 'CANCELLED' || !ev.start) continue;
    let instances: EventInstance[] = [];
    try {
      instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    } catch {
      continue; // one broken event must not hide the others
    }
    for (const i of instances) {
      if (i.event.status === 'CANCELLED') continue;
      const allDay = i.isFullDay;
      const start = allDay ? dayStart(i.start) : i.start;
      let end = i.end ? (allDay ? dayStart(i.end) : i.end) : start;
      if (allDay && end <= start) end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1); // one-day event with no DTEND
      if (end < from || start >= to) continue;
      out.push({
        start: start.toISOString(),
        end: end.toISOString(),
        allDay,
        title: text(i.summary) || '(no title)',
        location: text(i.event.location),
        description: text(i.event.description),
        calendar,
        ...(gcal && {
          edit: editUrl(gcal, {
            uid: i.event.uid ?? '',
            recurring: i.isRecurring || i.isOverride,
            allDay,
            originalStart: allDay ? dayStart((i.isOverride && i.event.recurrenceid) || i.start) : ((i.isOverride && i.event.recurrenceid) || i.start),
            day: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
          }),
        }),
      });
    }
  }
  return out.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}
