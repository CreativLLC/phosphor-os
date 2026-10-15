# Calendar in the TODAY panel

The left column has a TODAY section: today's remaining events, the next event when today is empty, and your pending
Omarchy reminders. Tap an event for its time, place and description. It reads your Google Calendar through its
read-only secret address. Nothing is changed from here, and there is no Google login on this PC. **EDIT** on an event and **+ NEW** open Google Calendar in your browser (see Edit and new, below).

## Set up

1. Google Calendar on the web: hover the calendar in the left list, Settings and sharing, then
   **Integrate calendar**, then copy **Secret address in iCal format** (the long link ending in `basic.ics`).
   Work or school accounts may hide it: the admin has to allow it.
2. Add it to `.env` in the app folder:

   ```
   PHOSPHOR_CALENDAR_ICS=https://calendar.google.com/calendar/ical/.../basic.ics
   ```

   More than one calendar: separate the addresses with a comma or a space. `webcal://` addresses work too.
3. `systemctl --user restart phosphor-os-server` (when idle: it stops the running chats).

The address is a password: anyone who has it can read the whole calendar. Keep it out of chats and screenshots.
The app never logs it or sends it to the page (the log says only `calendar 1/2`). If it leaks, press **Reset** on the
same Google page and paste the new one.

## How it works

- The server fetches every 10 minutes (and once at start), expands recurring events (repeats, skipped dates,
  moved occurrences, time zones, all-day) from 31 days back to 92 days ahead (`SYNC_BACK_DAYS` / `SYNC_AHEAD_DAYS` in
  `server/icsexpand.ts`; about 130 ms for roughly 2500 events), and writes
  `~/.local/state/phosphor-os/calendar.json` (the clock popup reads it; `{updated, calendars, events:[{start,end,allDay,title,location,description,calendar}]}`,
  mode 600). Other tools, such as the bar, can read that file.
- The TODAY panel gets only today and the next 7 days (`GET /api/today`). The month view gets any slice of the kept
  span (`GET /api/calendar?from=<ms>&to=<ms>`, at most 70 days; descriptions cut to 1000 characters).
- Google refreshes its address slowly, often a few hours: a new event can take a while to show up.
- A failed fetch keeps the last events and shows a quiet "calendar offline" line.
- No address in `.env`: TODAY shows reminders only, plus "Add your calendar: see docs".
- Reminders come from `omarchy-reminder show --json`. Without Omarchy that list is just empty.

Library: [node-ical](https://github.com/jens-maus/node-ical), pinned in `package.json` (handles RRULE, EXDATE,
RECURRENCE-ID overrides and IANA time zones). Test: `npm run test:calendar`.

## Edit and new

Calendars read through a Google address get an **EDIT** button on each event (TODAY panel detail, month view agenda, the
clock popup agenda) and **+ NEW** (TODAY heading, month view toolbar for the selected day, under the clock popup agenda).
Both open Google Calendar in the browser (the desktop app hands the link to your default browser, a phone opens a new
tab); the event is changed there, with your own Google login. Other (non-Google) addresses get no buttons.

- The server reads the calendar id (usually the account email) from the address path and keeps only that id. The
  address and its secret token never reach the page, the cache file or the log. The cache file and the API carry the
  finished links (`edit` per event, `newUrl` once).
- EDIT opens `calendar.google.com/calendar/event?eid=...&authuser=<account>`. `eid` is base64url of `<event id> <calendar id>`
  (event id = the ICS UID without `@google.com`; a repeat adds `_<original start>`: UTC `YYYYMMDDTHHMMSSZ` for timed,
  `YYYYMMDD` for all-day, the Calendar API's instance-id form). An event whose UID is not Google's own (an invitation
  from elsewhere) opens Google's day view instead. Untested against a live Google login: if a link ever lands on the
  wrong page, check `server/gcal.ts`.
- + NEW opens an all-day draft on the day (`.../r/eventedit?authuser=<calendar 1 account>&dates=YYYYMMDD/YYYYMMDD+1`);
  time and calendar are set in Google.
- Calendars whose id is not an email (shared or group calendars) open without `authuser`; Google then picks the account.

## Month view

Click the **TODAY** heading (tooltip "Open calendar"): a month grid opens over the app. Each day lists up to 3 events
(all-day first, then "+N more"); with more than one calendar each event carries its calendar's number in a colour (the
same numbers as the clock popup). Click a day (EDIT on an event, + NEW in the toolbar), or move with the arrow keys (PageUp / PageDown change month), for that
day's times, place and description. Days outside the synced range say "Outside the synced range". Esc or CLOSE leaves.
On a phone the cells show markers and a count, with the day's agenda below the grid. `/?demo=1` shows sample data.

## Event alerts

A desktop notice (the bell) comes 10 minutes before each timed event. Change it with `PHOSPHOR_CALENDAR_REMIND=<minutes>` in `.env` (`0` = off). Google's iCal address leaves out most reminders set in Google, so one lead time is used for all events.
