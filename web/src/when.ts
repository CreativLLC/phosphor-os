// Reply times: "JUST NOW", "5 MIN AGO", then the clock time, then the day, then the date.
// Plain functions (no browser), so tests/when.ts can check them.

const clock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function whenText(at: number, now = Date.now()): string {
  const d = new Date(at);
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return 'JUST NOW';
  if (mins < 60) return `${mins} MIN AGO`;
  const days = Math.round((dayStart(new Date(now)) - dayStart(d)) / 86_400_000);
  if (days <= 0) return `${Math.floor(mins / 60)} H AGO · ${clock(d)}`;
  if (days === 1) return `YESTERDAY ${clock(d)}`;
  if (days < 7) return `${d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} ${clock(d)}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return `${date.toUpperCase()} ${clock(d)}`;
}

// The full date and time, shown when the mouse rests on the time.
export const whenFull = (at: number) =>
  new Date(at).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
