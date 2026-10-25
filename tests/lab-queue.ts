// The LAB queue rule (server/labrun.ts startable): a local model runs alone, after the cloud runs and page builds.
// npx tsx tests/lab-queue.ts
import type { LabApp } from '../shared/lab.ts';
const { startable } = await import('../server/labrun.ts');

let fails = 0;
const idle = { running: 0, localBusy: false, building: 0 };
const check = (what: string, apps: LabApp[], now: typeof idle, want: boolean[]) => {
  const got = startable(apps, now);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${what}${ok ? '' : ` (got ${JSON.stringify(got)})`}`);
  if (!ok) fails++;
};
check('cloud runs start, the local one waits for them', ['claude', 'codex', 'local', 'opencode'], idle, [true, true, false, true]);
check('local waits while cloud runs are going', ['local'], { ...idle, running: 2 }, [false]);
check('local waits for a page build', ['local'], { ...idle, building: 1 }, [false]);
check('local starts when nothing else is left', ['local'], idle, [true]);
check('a second local model waits for the first', ['local', 'local'], idle, [true, false]);
check('cloud runs wait while a local model runs', ['claude', 'codex'], { running: 1, localBusy: true, building: 0 }, [false, false]);
check('at most 8 at once', Array<LabApp>(10).fill('claude'), idle, [...Array(8).fill(true), false, false]);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
