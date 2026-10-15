// Calendar expansion (server/icsexpand.ts) against a made-up fixture. Pure, no network, no files.
//   npm run test:calendar        (= npx tsx tests/calendar.ts)
// The clock is pinned: "now" is Wed 2026-10-14 08:00 in New York, whatever zone this PC is in.
process.env.TZ = 'America/New_York';

import { editUrl, gcalOf, newUrlBase } from '../server/gcal.ts';
import { eventsBetween, expandIcs, syncWindow } from '../server/icsexpand.ts';

let fail = 0;
const check = (what: string, cond: boolean, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:standup@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20260909T093000
DTEND;TZID=America/New_York:20260909T100000
RRULE:FREQ=WEEKLY;BYDAY=WE
EXDATE;TZID=America/New_York:20261021T093000
SUMMARY:Standup
LOCATION:Room 4
END:VEVENT
BEGIN:VEVENT
UID:standup@test
DTSTAMP:20260901T000000Z
RECURRENCE-ID;TZID=America/New_York:20261014T093000
DTSTART;TZID=America/New_York:20261014T110000
DTEND;TZID=America/New_York:20261014T113000
SUMMARY:Standup (moved)
DESCRIPTION:Moved for the demo\\, back next week
END:VEVENT
BEGIN:VEVENT
UID:holiday@test
DTSTAMP:20260901T000000Z
DTSTART;VALUE=DATE:20261015
DTEND;VALUE=DATE:20261016
SUMMARY:Day off
END:VEVENT
BEGIN:VEVENT
UID:long@test
DTSTAMP:20260901T000000Z
DTSTART;VALUE=DATE:20261013
DTEND;VALUE=DATE:20261015
SUMMARY:Conference
END:VEVENT
BEGIN:VEVENT
UID:deploy@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20261014T230000
DTEND;TZID=America/New_York:20261015T010000
SUMMARY:Late deploy
END:VEVENT
BEGIN:VEVENT
UID:london@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=Europe/London:20261014T150000
DTEND;TZID=Europe/London:20261014T160000
SUMMARY:London call
END:VEVENT
BEGIN:VEVENT
UID:utc@test
DTSTAMP:20260901T000000Z
DTSTART:20261016T140000Z
DTEND:20261016T150000Z
SUMMARY:UTC sync
END:VEVENT
BEGIN:VEVENT
UID:cancelled@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20261014T120000
DTEND;TZID=America/New_York:20261014T130000
STATUS:CANCELLED
SUMMARY:Cancelled lunch
END:VEVENT
BEGIN:VEVENT
UID:far@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20261120T100000
DTEND;TZID=America/New_York:20261120T110000
SUMMARY:Too far away
END:VEVENT
END:VCALENDAR
`.replace(/\n/g, '\r\n');

const from = new Date(2026, 9, 14); // today 00:00 local
const to = new Date(2026, 9, 22); // today + 8 days
const evs = expandIcs(ICS, from, to, 'test');
const local = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16);
const by = (t: string) => evs.filter((e) => e.title === t);

// Weekly event with an exception and an EXDATE
check('override replaces the 14th, no original 09:30', by('Standup').length === 0 && by('Standup (moved)').length === 1, JSON.stringify(by('Standup')));
check('override time 11:00-11:30', by('Standup (moved)')[0] && local(by('Standup (moved)')[0].start) === '2026-10-14 11:00' && local(by('Standup (moved)')[0].end) === '2026-10-14 11:30');
check('override keeps description (escaped comma)', by('Standup (moved)')[0]?.description === 'Moved for the demo, back next week');
check('EXDATE removes the 21st', !evs.some((e) => local(e.start).startsWith('2026-10-21')));

// All-day
const off = by('Day off')[0];
check('all-day flag', off?.allDay === true);
check('all-day runs local midnight to midnight', !!off && local(off.start) === '2026-10-15 00:00' && local(off.end) === '2026-10-16 00:00', off ? `${local(off.start)} ${local(off.end)}` : 'missing');
const conf = by('Conference')[0];
check('multi-day all-day that began yesterday is kept', !!conf && local(conf.start) === '2026-10-13 00:00' && local(conf.end) === '2026-10-15 00:00', conf ? `${local(conf.start)} ${local(conf.end)}` : 'missing');
check('all-day events sort first', evs[0]?.allDay === true);

// Cross-midnight
const late = by('Late deploy')[0];
check('cross-midnight event', !!late && local(late.start) === '2026-10-14 23:00' && local(late.end) === '2026-10-15 01:00', late ? `${local(late.start)} ${local(late.end)}` : 'missing');

// Time zones
const lon = by('London call')[0];
check('London 15:00 BST is 10:00 in New York', !!lon && local(lon.start) === '2026-10-14 10:00', lon ? local(lon.start) : 'missing');
const utc = by('UTC sync')[0];
check('UTC 14:00Z is 10:00 in New York', !!utc && local(utc.start) === '2026-10-16 10:00', utc ? local(utc.start) : 'missing');

// Left out
check('cancelled event skipped', by('Cancelled lunch').length === 0);
check('event past the window skipped', by('Too far away').length === 0);
check('calendar name carried', evs.every((e) => e.calendar === 'test'));
check('a broken feed gives no events, not a crash', expandIcs('not a calendar', from, to, 'x').length === 0);

// ---------- the wide sync window (month view): 31 days back to 92 days ahead ----------
const WIDE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:daily@test
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/New_York:20260101T080000
DTEND;TZID=America/New_York:20260101T083000
RRULE:FREQ=DAILY
SUMMARY:Daily
END:VEVENT
BEGIN:VEVENT
UID:back@test
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/New_York:20260913T100000
DTEND;TZID=America/New_York:20260913T110000
SUMMARY:First day back
END:VEVENT
BEGIN:VEVENT
UID:before@test
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/New_York:20260912T100000
DTEND;TZID=America/New_York:20260912T110000
SUMMARY:Day before the window
END:VEVENT
BEGIN:VEVENT
UID:ahead@test
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/New_York:20270114T100000
DTEND;TZID=America/New_York:20270114T110000
SUMMARY:Last day ahead
END:VEVENT
BEGIN:VEVENT
UID:after@test
DTSTAMP:20260101T000000Z
DTSTART;TZID=America/New_York:20270115T100000
DTEND;TZID=America/New_York:20270115T110000
SUMMARY:Day after the window
END:VEVENT
BEGIN:VEVENT
UID:trip@test
DTSTAMP:20260101T000000Z
DTSTART;VALUE=DATE:20260910
DTEND;VALUE=DATE:20260914
SUMMARY:Trip across the start
END:VEVENT
END:VCALENDAR
`.replace(/\n/g, '\r\n');
const win = syncWindow(from);
check('window starts 31 days back', win.from.getFullYear() === 2026 && win.from.getMonth() === 8 && win.from.getDate() === 13, win.from.toString());
check('window ends after day +92', win.to.getFullYear() === 2027 && win.to.getMonth() === 0 && win.to.getDate() === 15, win.to.toString());
const wide = expandIcs(WIDE, win.from, win.to, 'wide');
const wb = (t: string) => wide.filter((e) => e.title === t);
check('daily event: one per day, 124 days', wb('Daily').length === 124, String(wb('Daily').length));
check('event on the first day back kept', wb('First day back').length === 1);
check('event the day before the window dropped', wb('Day before the window').length === 0);
check('event on the last day ahead kept, the day after dropped', wb('Last day ahead').length === 1 && wb('Day after the window').length === 0);
check('multi-day all-day that began before the window is kept', wb('Trip across the start').length === 1);
const slice = eventsBetween(wide, new Date(2026, 9, 14).getTime(), new Date(2026, 9, 15).getTime());
check('eventsBetween: one day gets that day\'s daily event only', slice.length === 1 && slice[0].title === 'Daily', slice.map((e) => e.title).join());
check('eventsBetween: an event ending at the slice start is out', eventsBetween(wide, new Date(2026, 8, 14).getTime(), new Date(2026, 8, 15).getTime()).every((e) => e.title !== 'Trip across the start'));
const t0 = performance.now();
for (let i = 0; i < 20; i++) expandIcs(WIDE, win.from, win.to, 'wide');
check('wide expansion stays cheap (20 runs under 3 s)', performance.now() - t0 < 3000, `${Math.round(performance.now() - t0)} ms`);

// ---------- Google Calendar links (EDIT / + NEW): server/gcal.ts ----------
const b64 = (t: string) => Buffer.from(t).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const g1 = gcalOf('https://calendar.google.com/calendar/ical/me%40example.com/private-0123456789abcdef/basic.ics');
check('calendar id and account read from the address', g1?.calendarId === 'me@example.com' && g1.account === 'me@example.com', JSON.stringify(g1));
check('a group calendar id has no account', gcalOf('https://calendar.google.com/calendar/ical/abc123%40group.calendar.google.com/private-x/basic.ics')?.account === '');
check('a non-Google address has no links', gcalOf('https://example.org/cal.ics') === null && gcalOf('not a url') === null);
check('the gcal object never holds the private token', !JSON.stringify(g1).includes('0123456789abcdef'));
const day = new Date(2026, 9, 14);
const one = editUrl(g1!, { uid: 'abc123@google.com', recurring: false, allDay: false, originalStart: new Date('2026-10-14T14:00:00Z'), day });
check('single event: eid = base64url("<id> <calendar id>"), no padding', one === `https://calendar.google.com/calendar/event?eid=${b64('abc123 me@example.com')}&authuser=me%40example.com`, one);
check('eid has no padding or + /', !/[=+/]/.test(one.split('eid=')[1].split('&')[0]));
const rep = editUrl(g1!, { uid: 'abc123@google.com', recurring: true, allDay: false, originalStart: new Date('2026-10-14T14:00:00Z'), day });
check('timed repeat: id_<UTC start>', rep.includes(`eid=${b64('abc123_20261014T140000Z me@example.com')}`), rep);
const rad = editUrl(g1!, { uid: 'abc123@google.com', recurring: true, allDay: true, originalStart: new Date(2026, 9, 15), day });
check('all-day repeat: id_<date>', rad.includes(`eid=${b64('abc123_20261015 me@example.com')}`), rad);
const foreign = editUrl(g1!, { uid: '0400008200E00074C5@outlook.com', recurring: false, allDay: false, originalStart: day, day });
check('a UID that is not Google\'s falls back to the day view', foreign === 'https://calendar.google.com/calendar/r/day/2026/10/14?authuser=me%40example.com', foreign);
check('+ NEW base ends in dates=', newUrlBase(g1!) === 'https://calendar.google.com/calendar/r/eventedit?authuser=me%40example.com&dates=');
check('group calendar link has no authuser', !editUrl(gcalOf('https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/private-x/basic.ics')!, { uid: 'z@google.com', recurring: false, allDay: false, originalStart: day, day }).includes('authuser'));

const GICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:weekly1@google.com
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20260909T093000
DTEND;TZID=America/New_York:20260909T100000
RRULE:FREQ=WEEKLY;BYDAY=WE
SUMMARY:Weekly
END:VEVENT
BEGIN:VEVENT
UID:weekly1@google.com
DTSTAMP:20260901T000000Z
RECURRENCE-ID;TZID=America/New_York:20261014T093000
DTSTART;TZID=America/New_York:20261014T110000
DTEND;TZID=America/New_York:20261014T113000
SUMMARY:Weekly moved
END:VEVENT
BEGIN:VEVENT
UID:daily-off@google.com
DTSTAMP:20260901T000000Z
DTSTART;VALUE=DATE:20261015
DTEND;VALUE=DATE:20261016
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Off
END:VEVENT
BEGIN:VEVENT
UID:solo1@google.com
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20261016T100000
DTEND;TZID=America/New_York:20261016T110000
SUMMARY:Solo
END:VEVENT
BEGIN:VEVENT
UID:invite-9@elsewhere.example
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20261016T120000
DTEND;TZID=America/New_York:20261016T130000
SUMMARY:Invite
END:VEVENT
END:VCALENDAR
`.replace(/\n/g, '\r\n');
const ge = expandIcs(GICS, from, to, 'g', g1);
const eidOf = (t: string, n = 0) => ge.filter((e) => e.title === t)[n]?.edit?.split('eid=')[1]?.split('&')[0];
check('expanded repeat: eid names the base id and its ORIGINAL start (09:30 EDT = 13:30Z), not the moved one', eidOf('Weekly moved') === b64('weekly1_20261014T133000Z me@example.com'), String(eidOf('Weekly moved')));
check('expanded repeat: next week the same way', eidOf('Weekly') === b64('weekly1_20261021T133000Z me@example.com'), String(eidOf('Weekly')));
check('expanded all-day repeat: id_<date>', eidOf('Off', 1) === b64('daily-off_20261016 me@example.com'), String(eidOf('Off', 1)));
check('expanded single event: plain id', eidOf('Solo') === b64('solo1 me@example.com'), String(eidOf('Solo')));
check('foreign UID: day view link', ge.find((e) => e.title === 'Invite')?.edit === 'https://calendar.google.com/calendar/r/day/2026/10/16?authuser=me%40example.com');
check('no gcal: no links at all', expandIcs(GICS, from, to, 'g').every((e) => e.edit === undefined));

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
