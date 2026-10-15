import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CalendarEvent, CalendarRangeResponse, TodayReminder, TodayResponse } from '../shared/protocol.ts';
import './config.ts'; // loads .env
import { gcalOf, newUrlBase } from './gcal.ts';
import { eventsBetween, expandIcs, syncWindow } from './icsexpand.ts';

// TODAY panel data. GET /api/today -> TodayResponse (shared/protocol.ts). Authed requests only.
// PHOSPHOR_CALENDAR_ICS in .env: one or more ICS addresses (Google's "secret address in iCal format"), comma or space
// separated. The address is a password: it is taken out of the environment here (Claude's processes must not inherit it)
// and is never logged or sent to the page; logs only say "calendar 1/2".
// Fetches every 10 minutes (and once at start), expands 31 days back to 92 days ahead (icsexpand.ts), and writes the cache file below
// (the clock popup reads it). The TODAY panel gets only today and the next week; the month view (GET /api/calendar?from=&to=,
// ms) gets any slice of the kept span. A failed fetch keeps the last events and sets `offline`.
// Reminders: the owner's pending Omarchy reminders, from `omarchy-reminder show --json` (cached 10 s).
// Event alerts: a desktop notice (the bell) PHOSPHOR_CALENDAR_REMIND minutes (default 10, 0 = off) before each timed
// event. Google's iCal address leaves out most reminders set in Google, so one lead time is used for all.

const EVERY_MS = 10 * 60_000;
const FETCH_MS = 20_000;
const MAX_BYTES = 30 * 1024 * 1024;
const TODAY_DAYS = 8; // the TODAY panel: today + 7
const RANGE_MAX_MS = 70 * 86_400_000; // longest slice /api/calendar returns (a 6-week month grid)
const NOTE_MAX = 1000; // description length in the month view
const REMINDERS_MS = 10_000;
const REMIND_MS = Math.max(0, Number(process.env.PHOSPHOR_CALENDAR_REMIND ?? 10) || 0) * 60_000;

const urls = (process.env.PHOSPHOR_CALENDAR_ICS ?? '')
  .split(/[\s,]+/)
  .filter(Boolean)
  .map((u) => u.replace(/^webcal:/i, 'https:'));
delete process.env.PHOSPHOR_CALENDAR_ICS;
// Google calendars (id only, never the address). EDIT links and + NEW use them; other addresses get no links.
const gcals = urls.map(gcalOf);
const first = gcals.find((g) => g?.account) ?? gcals.find(Boolean); // calendar 1's account, else the first Google one
const NEW_URL = first ? newUrlBase(first) : null;

export const CACHE_FILE = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'phosphor-os', 'calendar.json');

type Cache = { updated: number; calendars: string[]; newUrl?: string | null; events: CalendarEvent[] };

const perCal: CalendarEvent[][] = urls.map(() => []);
const names: string[] = urls.map((_, i) => `calendar ${i + 1}`);
let updated: number | null = null;
let offline = false;
let busy: Promise<void> | undefined;

// Start from the last cache, so the panel is full before the first fetch is done (and when offline).
try {
  const c = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Cache;
  if (Array.isArray(c.events) && Array.isArray(c.calendars)) {
    updated = Number(c.updated) || null;
    urls.forEach((_, i) => {
      names[i] = c.calendars[i] ?? names[i];
      perCal[i] = c.events.filter((e) => e.calendar === c.calendars[i]);
    });
  }
} catch {
  /* no cache yet */
}

function startOfToday(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

async function download(url: string): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { Accept: 'text/calendar, */*' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > MAX_BYTES) throw new Error('too big');
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not a calendar');
  return text;
}

async function refresh(): Promise<void> {
  const { from, to } = syncWindow(startOfToday());
  let failed = 0;
  for (const [i, url] of urls.entries()) {
    try {
      const ics = await download(url);
      perCal[i] = expandIcs(ics, from, to, `calendar ${i + 1}`, gcals[i]);
      names[i] = perCal[i][0]?.calendar ?? `calendar ${i + 1}`;
      console.log(`  calendar ${i + 1}/${urls.length}: ${perCal[i].length} events`);
    } catch (e) {
      failed++;
      // Only a short reason (status or error code), never the message: it could contain the address.
      const why = e instanceof Error && /^(HTTP \d+|too big|not a calendar)$/.test(e.message) ? e.message : e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'no answer';
      console.log(`  calendar ${i + 1}/${urls.length}: failed (${why}), keeping the last events`);
    }
  }
  offline = failed > 0;
  if (failed < urls.length) {
    updated = Date.now();
    save();
  }
}

function save(): void {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    const cache: Cache = { updated: updated ?? Date.now(), calendars: names, newUrl: NEW_URL, events: perCal.flat() };
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 }); // titles are private
    chmodSync(tmp, 0o600);
    renameSync(tmp, CACHE_FILE);
  } catch {
    /* the panel still works from memory */
  }
}

function refreshOnce(): Promise<void> {
  busy ??= refresh().finally(() => (busy = undefined));
  return busy;
}

export function startCalendar(): void {
  if (!urls.length) return;
  void refreshOnce();
  setInterval(() => void refreshOnce(), EVERY_MS).unref();
  if (REMIND_MS) setInterval(alertSoon, 30_000).unref();
}

// ---------- event alerts ----------

const alerted = new Set<string>(); // events already announced (start + title), so each alerts once
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function alertSoon(): void {
  const now = Date.now();
  for (const e of perCal.flat()) {
    if (e.allDay) continue;
    const start = new Date(e.start).getTime();
    const key = `${start} ${e.title}`;
    if (start <= now || start - now > REMIND_MS || alerted.has(key)) continue;
    alerted.add(key);
    const mins = Math.max(1, Math.round((start - now) / 60_000));
    const body = [`In ${mins} min, at ${clock(start)}`, e.location].filter(Boolean).join(' · ');
    // App name Phosphor-OS: clicking the notice brings the app (and its TODAY panel) forward.
    execFile('notify-send', ['--app-name', 'Phosphor-OS', '--icon', 'x-office-calendar', e.title || 'Event', body], () => {});
  }
  for (const k of alerted) if (Number(k.slice(0, k.indexOf(' '))) < now) alerted.delete(k); // past: no longer needed
}

// ---------- reminders ----------

let reminders: TodayReminder[] = [];
let remindersAt = 0;

function readReminders(): Promise<TodayReminder[]> {
  if (Date.now() - remindersAt < REMINDERS_MS) return Promise.resolve(reminders);
  remindersAt = Date.now();
  return new Promise((resolve) => {
    execFile('omarchy-reminder', ['show', '--json'], { timeout: 3000, windowsHide: true }, (err, out) => {
      if (!err) {
        try {
          const j = JSON.parse(String(out)) as { reminders?: { label?: unknown; at?: unknown }[] };
          reminders = (j.reminders ?? [])
            .filter((r) => typeof r.label === 'string' && Number.isFinite(r.at))
            .map((r) => ({ label: String(r.label), at: Number(r.at) * 1000 }))
            .sort((a, b) => a.at - b.at);
        } catch {
          reminders = [];
        }
      } else reminders = []; // no Omarchy (or no reminder tool) here
      resolve(reminders);
    });
  });
}

export async function today(): Promise<TodayResponse> {
  const t = startOfToday();
  const events = eventsBetween(perCal.flat(), t.getTime(), new Date(t.getFullYear(), t.getMonth(), t.getDate() + TODAY_DAYS).getTime());
  return { configured: urls.length > 0, offline, updated, newUrl: NEW_URL, events, reminders: await readReminders() };
}

// GET /api/calendar?from=<ms>&to=<ms>: the events touching that slice (at most 70 days), plus the span the server keeps.
export function calendarRange(fromMs: number, toMs: number): CalendarRangeResponse {
  const { from, to } = syncWindow(startOfToday());
  const f = Number.isFinite(fromMs) ? fromMs : from.getTime();
  const t = Math.min(Number.isFinite(toMs) ? toMs : to.getTime(), f + RANGE_MAX_MS);
  const events = eventsBetween(perCal.flat(), f, t).map((e) => (e.description.length > NOTE_MAX ? { ...e, description: e.description.slice(0, NOTE_MAX) } : e));
  return { configured: urls.length > 0, offline, updated, calendars: names, newUrl: NEW_URL, rangeFrom: from.getTime(), rangeTo: to.getTime(), events };
}
