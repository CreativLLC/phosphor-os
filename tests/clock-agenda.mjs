// The clock popup's event list (os/omarchy/clock/Agenda.js) against a made-up cache. Pure, no files.
//   node tests/clock-agenda.mjs      (tests/pack.sh runs it)
// The clock is pinned: events are local times, so the zone is fixed.
process.env.TZ = 'America/New_York';
import { readFileSync } from 'node:fs';
// Agenda.js is plain QML-style JS (the repo's package type would make node read it as a module), so run it as a script.
const mod = { exports: {} };
new Function('module', readFileSync(new URL('../os/omarchy/clock/Agenda.js', import.meta.url), 'utf8'))(mod);
const A = mod.exports;

let fail = 0;
const check = (what, cond, detail = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${what}${cond ? '' : ` ${detail}`}`);
};
const iso = (s) => new Date(s).toISOString(); // local time in the pinned zone

const cache = JSON.stringify({
  updated: new Date('2026-10-14T08:00:00').getTime(),
  calendars: ['Work', 'Home'],
  events: [
    { start: iso('2026-10-14T13:30:00'), end: iso('2026-10-14T14:00:00'), allDay: false, title: 'Lunch', location: 'Cafe', description: '', calendar: 'Home' },
    { start: iso('2026-10-14T00:30:00'), end: iso('2026-10-14T01:00:00'), allDay: false, title: 'Early', location: '', description: '', calendar: 'Work' },
    { start: iso('2026-10-14T00:00:00'), end: iso('2026-10-15T00:00:00'), allDay: true, title: 'Holiday', location: '', description: '', calendar: 'Home' },
    { start: iso('2026-10-14T12:00:00'), end: iso('2026-10-14T12:45:00'), allDay: false, title: 'Noon', location: '', description: '', calendar: 'Work' },
    { start: iso('2026-10-16T22:00:00'), end: iso('2026-10-17T02:00:00'), allDay: false, title: 'Late', location: '', description: '', calendar: 'Work' },
    { start: iso('2026-10-18T00:00:00'), end: iso('2026-10-20T00:00:00'), allDay: true, title: 'Trip', location: 'Far', description: '', calendar: 'Work' },
    { start: iso('2026-10-15T09:05:00'), end: iso('2026-10-15T09:05:00'), allDay: false, title: 'Zero', location: '', description: '', calendar: 'Other' },
  ],
});
const c = A.load(cache);
const day = (k) => (c.days[k] || []).map((r) => `${r.time}|${r.title}`);

check('calendars in file order, unknown one appended', JSON.stringify(c.calendars) === '["Work","Home","Other"]');
check('all-day first, then by start', JSON.stringify(day('2026-10-14')) === '["all day|Holiday","12:30 AM|Early","12:00 PM|Noon","1:30 PM|Lunch"]', JSON.stringify(day('2026-10-14')));
check('location and calendar index kept', c.days['2026-10-14'][3].location === 'Cafe' && c.days['2026-10-14'][3].calendar === 1);
check('a day with nothing has no key', c.days['2026-10-13'] === undefined);
check('all-day end is excluded', c.days['2026-10-15'].every((r) => r.title !== 'Holiday'));
check('past midnight: start day shows the time, next day "until"', day('2026-10-16')[0] === '10:00 PM|Late' && day('2026-10-17')[0] === 'until 2:00 AM|Late');
check('multi-day all-day covers each day, not the end day', ['2026-10-18', '2026-10-19'].every((k) => day(k)[0] === 'all day|Trip') && c.days['2026-10-20'] === undefined);
check('dots: calendars once each, in order', JSON.stringify(A.calendarsOn(c.days['2026-10-14'])) === '[0,1]');
check('12-hour clock: midnight and noon', A.clock(new Date('2026-10-14T00:05:00')) === '12:05 AM' && A.clock(new Date('2026-10-14T12:00:00')) === '12:00 PM');
check('fresh cache: no note', A.staleNote(c.updated, c.updated + 3600000, 3600000) === '');
check('old cache: "updated HH:MM"', A.staleNote(c.updated, c.updated + 3600001, 3600000) === 'updated 8:00 AM');
check('never written: no note', A.staleNote(0, Date.now(), 3600000) === '');
for (const bad of ['', 'not json', '{}', '{"events":5}', 'null']) {
  const e = A.load(bad);
  check(`broken file (${JSON.stringify(bad)}) is no events`, Object.keys(e.days).length === 0 && e.calendars.length === 0);
}
const odd = A.load(JSON.stringify({ events: [{ start: 'x', end: 'y' }, { start: iso('2026-10-14T10:00:00'), end: iso('2026-10-14T09:00:00'), title: 'Backwards' }, { start: iso('2026-01-01T00:00:00'), end: iso('2030-01-01T00:00:00'), allDay: true, title: 'Forever' }] }));
check('bad dates skipped, backwards end tolerated, runaway end bounded', odd.days['2026-10-14'].some((r) => r.title === 'Backwards') && Object.keys(odd.days).length <= 63 + 1);

// Links into Google Calendar (EDIT / + NEW): only Google Calendar addresses survive.
const G = 'https://calendar.google.com/calendar/event?eid=abc&authuser=me%40example.com';
const lk = A.load(JSON.stringify({ newUrl: 'https://calendar.google.com/calendar/r/eventedit?authuser=me%40example.com&dates=', events: [
  { start: iso('2026-10-14T10:00:00'), end: iso('2026-10-14T11:00:00'), title: 'Linked', calendar: 'Work', edit: G },
  { start: iso('2026-10-14T12:00:00'), end: iso('2026-10-14T13:00:00'), title: 'Evil', calendar: 'Work', edit: 'https://evil.example/calendar/x' },
  { start: iso('2026-10-14T14:00:00'), end: iso('2026-10-14T15:00:00'), title: 'Odd', calendar: 'Work', edit: 'https://calendar.google.com/calendar/x y' },
  { start: iso('2026-10-14T16:00:00'), end: iso('2026-10-14T17:00:00'), title: 'None', calendar: 'Work' },
] }));
const rowOf = (t) => lk.days['2026-10-14'].find((r) => r.title === t);
check('a Google Calendar link is kept', rowOf('Linked').edit === G);
check('another host, a space, or no link gives ""', rowOf('Evil').edit === '' && rowOf('Odd').edit === '' && rowOf('None').edit === '');
check('+ NEW: the base plus the day and the day after', A.newEventUrl(lk.newUrl, '2026-10-31') === lk.newUrl + '20261031/20261101', A.newEventUrl(lk.newUrl, '2026-10-31'));
check('+ NEW across a year end', A.newEventUrl(lk.newUrl, '2026-12-31').endsWith('20261231/20270101'));
check('+ NEW: no address or a bad day gives ""', A.newEventUrl('', '2026-10-31') === '' && A.newEventUrl(lk.newUrl, 'x') === '' && A.load('{"newUrl":"https://evil.example/","events":[]}').newUrl === '');

process.exit(fail ? 1 : 0);
