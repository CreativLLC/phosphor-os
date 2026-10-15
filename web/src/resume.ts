import type { TabState } from '../../shared/protocol.ts';
import { send } from './net.ts';
import { watchActive } from './store.ts';
import { button, el } from './ui.ts';

// AUTO-CONTINUE banner (server/tab.ts): the plan's usage limit stopped this chat's work, and the chat will go
// on by itself after the reset. Shown above the progress row with CONTINUE NOW and CANCEL.

const LIMIT_NAME: Record<string, string> = { five_hour: '5-HOUR', seven_day: 'WEEKLY', seven_day_opus: 'WEEKLY OPUS', seven_day_sonnet: 'WEEKLY SONNET' };

function until(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}M`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}H ${m % 60}M` : `${Math.floor(h / 24)}D ${h % 24}H`;
}

export function mountResume(before: HTMLElement): void {
  const bar = el('div', 'resume-bar');
  bar.hidden = true;
  bar.setAttribute('role', 'status');
  const text = el('span', 'resume-text');
  let tabId = '';
  const now = button('CONTINUE NOW', () => send({ t: 'resume', tab: tabId, now: true }), 'resume-now');
  now.title = 'Send the continue message now (it may hit the limit again if it has not reset)';
  const cancel = button('CANCEL', () => send({ t: 'resume', tab: tabId, now: false }));
  cancel.title = 'Do not continue by itself';
  bar.append(text, now, cancel);
  before.before(bar);

  let current: TabState | undefined;
  const render = (tab: TabState | undefined) => {
    current = tab;
    const r = tab?.meta.resume;
    bar.hidden = !r;
    if (!r || !tab) return;
    tabId = tab.meta.id;
    const when = new Date(r.at).toLocaleString([], { weekday: r.at - Date.now() > 20 * 3600_000 ? 'short' : undefined, hour: 'numeric', minute: '2-digit' });
    const limit = LIMIT_NAME[r.limit] ? `${LIMIT_NAME[r.limit]} LIMIT` : 'USAGE LIMIT';
    const left = r.at - Date.now();
    const t = left > 0 ? `${limit} REACHED. AUTO-CONTINUE AT ${when.toUpperCase()} (IN ${until(left)})` : `${limit} RESET. CONTINUING…`;
    if (text.textContent !== t) text.textContent = t;
  };
  watchActive(['meta'], render);
  // The countdown only changes once a minute.
  setInterval(() => {
    if (!document.hidden && current?.meta.resume) render(current);
  }, 30_000);
}
