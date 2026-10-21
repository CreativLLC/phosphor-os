// Reply times in the chat (web/src/when.ts). Plain functions, no browser.
//   npx tsx tests/when.ts

import { whenText } from '../web/src/when.ts';

let pass = 0;
let fail = 0;
const eq = (what: string, got: unknown, want: unknown) => {
  if (got === want) {
    pass++;
    console.log(`PASS: ${what}`);
  } else {
    fail++;
    console.log(`FAIL: ${what}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
};

const now = new Date(2026, 9, 20, 14, 30).getTime(); // Tue Oct 20 2026, 2:30 PM local
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();

eq('under a minute', whenText(now - 20_000, now), 'JUST NOW');
eq('minutes', whenText(now - 5 * 60_000, now), '5 MIN AGO');
eq('59 minutes', whenText(now - 59 * 60_000, now), '59 MIN AGO');
eq('earlier today', whenText(at(2026, 9, 20, 8, 17), now), '6 H AGO · 8:17 AM');
eq('yesterday', whenText(at(2026, 9, 19, 23, 5), now), 'YESTERDAY 11:05 PM');
eq('this week', whenText(at(2026, 9, 16, 9, 0), now), 'FRI 9:00 AM');
eq('older', whenText(at(2026, 9, 2, 13, 45), now), 'OCT 2 1:45 PM');
eq('last year', whenText(at(2025, 11, 31, 7, 0), now), 'DEC 31, 2025 7:00 AM');
eq('clock a bit ahead', whenText(now + 5_000, now), 'JUST NOW');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
