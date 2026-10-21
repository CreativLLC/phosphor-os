import type { TabState } from '../../shared/protocol.ts';
import { cacheEnding, cacheLeft, cacheShort } from '../../shared/cache.ts';
import { send } from './net.ts';
import { store, watchActive } from './store.ts';
import { button, confirmBox, el, toast } from './ui.ts';

// Context window: how full Claude's memory of this chat is, and COMPRESS (Claude Code's /compact),
// which replaces the chat so far with a summary to free up room. Also the chat's prompt cache clock
// (shared/cache.ts): warm = the next message re-reads the chat cheaply, cold = at full price.

const SEGS = 5;
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

// Fullness of the active tab: { pct (null when the window size is not known yet), used, win }.
export function contextOf(): { pct: number | null; used: number; win: number } {
  const s = store.current()?.stats;
  const used = s?.contextTokens ?? 0;
  const win = s?.contextWindow ?? 0;
  return { pct: win > 0 ? Math.min(100, Math.round((used / win) * 100)) : null, used, win };
}

export type CacheView = { left: number; short: string; ending: boolean; line: string; tip: string };

// The active chat's cache, or null when there is nothing to show (no reply yet, a local model, Claude working).
export function cacheOf(tab: TabState | undefined, now = Date.now()): CacheView | null {
  if (!tab || tab.meta.busy) return null;
  const left = cacheLeft(tab.stats, now);
  if (left === null) return null;
  const used = tab.stats.contextTokens;
  const reread = used ? `all ${k(used)} tokens` : 'the whole chat';
  const min = Math.ceil(left / 60_000);
  return left > 0
    ? {
        left,
        short: cacheShort(left),
        ending: cacheEnding(left, tab.stats.cacheTtlMs),
        line: `WARM · ${min} MIN LEFT`,
        tip: `Cache warm for ${min} more min. After that, the next message re-reads ${reread} at full price.`,
      }
    : {
        left,
        short: cacheShort(left),
        ending: false,
        line: `COLD · NEXT MESSAGE RE-READS ${used ? `${k(used)} TOKENS` : 'THE CHAT'}`,
        tip: `Cache cold. The next message re-reads ${reread} at full price. COMPRESS first makes it cheaper.`,
      };
}

// Render now, on every change of the active chat, and every 15 s while the clock runs down.
export function watchCache(render: (tab: TabState | undefined) => void): void {
  watchActive(['stats', 'meta'], render);
  setInterval(() => render(store.current()), 15_000);
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
  const cache = el('span', 'pg-ctx-cache');
  g.append(el('span', 'pg-ctx-k', 'CTX'), segs, label, cache);
  g.onclick = (e) => {
    e.stopPropagation(); // the progress row itself opens the mission panel
    void askCompact();
  };
  watchCache((tab) => {
    const { pct, used, win } = contextOf();
    const c = cacheOf(tab);
    progressRoot.classList.toggle('has-ctx', used > 0);
    g.hidden = used === 0;
    const lit = pct === null ? 0 : Math.round((pct / 100) * SEGS);
    cells.forEach((c, i) => c.classList.toggle('on', i < lit));
    label.textContent = pct === null ? k(used) : `${pct}%`;
    g.classList.toggle('hot', (pct ?? 0) >= 80);
    cache.hidden = !c;
    cache.textContent = c?.short ?? '';
    cache.classList.toggle('cold', c?.left === 0);
    cache.classList.toggle('ending', !!c?.ending);
    g.title = `Context: ${pct === null ? `${k(used)} tokens` : `${pct}% full (${k(used)} of ${k(win)} tokens)`}. Tap to compress.${c ? `\n${c.tip}` : ''}`;
  });
  return g;
}

// COMPRESS button for the right panel's CONTEXT row.
export function compressButton(): HTMLButtonElement {
  const b = button('COMPRESS', () => void askCompact(), 'ms-toggle');
  b.title = 'Summarize the chat so far to free up context (/compact)';
  return b;
}
