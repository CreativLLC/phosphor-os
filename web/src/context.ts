import { send } from './net.ts';
import { store, watchActive } from './store.ts';
import { button, confirmBox, el, toast } from './ui.ts';

// Context window: how full Claude's memory of this chat is, and COMPRESS (Claude Code's /compact),
// which replaces the chat so far with a summary to free up room.

const SEGS = 5;
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

// Fullness of the active tab: { pct (null when the window size is not known yet), used, win }.
export function contextOf(): { pct: number | null; used: number; win: number } {
  const s = store.current()?.stats;
  const used = s?.contextTokens ?? 0;
  const win = s?.contextWindow ?? 0;
  return { pct: win > 0 ? Math.min(100, Math.round((used / win) * 100)) : null, used, win };
}

export async function askCompact(): Promise<void> {
  const tab = store.current();
  if (!tab) return;
  if (tab.meta.busy) return toast('Claude is working. Compress when it is done, or press STOP first.');
  const { pct, used, win } = contextOf();
  const now = pct === null ? (used ? `${k(used)} tokens` : 'unknown') : `${pct}% (${k(used)} of ${k(win)} tokens)`;
  const ok = await confirmBox(
    'COMPRESS CONTEXT?',
    `Claude replaces this chat's history with a short summary, so it has room to keep working. The chat on screen stays. Context now: ${now}.`,
    'COMPRESS',
  );
  if (ok) send({ t: 'send', tab: tab.meta.id, text: '/compact' });
}

// Small gauge for the right end of the progress bar. Tap to compress.
export function contextGauge(progressRoot: HTMLElement): HTMLElement {
  const g = el('button', 'pg-ctx');
  g.type = 'button';
  const segs = el('span', 'pg-ctx-bar');
  const cells = Array.from({ length: SEGS }, () => el('i'));
  segs.append(...cells);
  const label = el('span', 'pg-ctx-pct');
  g.append(el('span', 'pg-ctx-k', 'CTX'), segs, label);
  g.onclick = (e) => {
    e.stopPropagation(); // the progress row itself opens the mission panel
    void askCompact();
  };
  watchActive(['stats'], () => {
    const { pct, used, win } = contextOf();
    progressRoot.classList.toggle('has-ctx', used > 0);
    g.hidden = used === 0;
    const lit = pct === null ? 0 : Math.round((pct / 100) * SEGS);
    cells.forEach((c, i) => c.classList.toggle('on', i < lit));
    label.textContent = pct === null ? k(used) : `${pct}%`;
    g.classList.toggle('hot', (pct ?? 0) >= 80);
    g.title = `Context: ${pct === null ? `${k(used)} tokens` : `${pct}% full (${k(used)} of ${k(win)} tokens)`}. Tap to compress.`;
  });
  return g;
}

// COMPRESS button for the right panel's CONTEXT row.
export function compressButton(): HTMLButtonElement {
  const b = button('COMPRESS', () => void askCompact(), 'ms-toggle');
  b.title = 'Summarize the chat so far to free up context (/compact)';
  return b;
}
