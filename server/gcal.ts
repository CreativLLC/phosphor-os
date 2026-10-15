// Links into Google Calendar (the page and the clock popup open them in the browser; nothing here writes to Google).
// Pure: no files, no network. The calendar id comes from the calendar's ICS address (.../ical/<calendar id>/private-.../basic.ics).
// Only the id (an email address, not a secret) is kept; the address and its private token never leave calendar.ts.

const HOST = 'https://calendar.google.com/calendar';

export type Gcal = { calendarId: string; account: string }; // account: the email for ?authuser=, '' when the id is not one

// An ICS address -> its Google calendar, or null for any other address.
export function gcalOf(icsUrl: string): Gcal | null {
  try {
    const u = new URL(icsUrl);
    if (u.hostname !== 'calendar.google.com') return null;
    const m = u.pathname.match(/^\/calendar\/ical\/([^/]+)\/(?:private|public)/);
    if (!m) return null;
    const calendarId = decodeURIComponent(m[1]);
    const email = /^[^@\s/]+@[^@\s/]+$/.test(calendarId) && !/\.calendar\.google\.com$/i.test(calendarId);
    return { calendarId, account: email ? calendarId : '' };
  } catch {
    return null;
  }
}

const auth = (g: Gcal) => (g.account ? `authuser=${encodeURIComponent(g.account)}` : '');
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const ymd = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; // local date

// Day view: the fallback when the exact event cannot be named.
export function dayUrl(g: Gcal, day: Date): string {
  return `${HOST}/r/day/${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}${g.account ? `?${auth(g)}` : ''}`;
}

// The event's page. Google's event id is the ICS UID without "@google.com". A repeat is "<id>_<original start>": UTC
// YYYYMMDDTHHMMSSZ when timed, local YYYYMMDD when all-day (the Calendar API's instance id convention). The page address
// carries eid = base64url("<event id> <calendar id>"). An event whose UID is not Google's own (an invitation from
// elsewhere, an import) gets the day view instead.
export type Instance = { uid: string; recurring: boolean; allDay: boolean; originalStart: Date; day: Date }; // day: local midnight of the shown start
export function editUrl(g: Gcal, i: Instance): string {
  const m = i.uid.match(/^([^@\s]+)@google\.com$/);
  if (!m) return dayUrl(g, i.day);
  let id = m[1];
  if (i.recurring) id += `_${i.allDay ? ymd(i.originalStart) : i.originalStart.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const eid = Buffer.from(`${id} ${g.calendarId}`).toString('base64url');
  return `${HOST}/event?eid=${eid}${g.account ? `&${auth(g)}` : ''}`;
}

// + NEW: the start of a draft address; the page or popup appends "YYYYMMDD/YYYYMMDD" (the day and the day after: an all-day draft).
export function newUrlBase(g: Gcal): string {
  return `${HOST}/r/eventedit?${g.account ? `${auth(g)}&` : ''}dates=`;
}
