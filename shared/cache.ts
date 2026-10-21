// Prompt cache of a chat. Claude keeps what it has already read for a while (5 minutes or 1 hour, renewed on every
// call). While warm, the next message re-reads the chat cheaply; once cold, it pays full price for all of it.

const MIN = 60_000;
export const TTL_5M = 5 * MIN;
export const TTL_1H = 60 * MIN;

type Usage = {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
};

// How long the cache lives after this call. A call that only reads the cache does not say: keep the last known
// value, else assume the shorter one (warns early rather than late). 0 = no cache used (a local model).
export function ttlFromUsage(u: Usage, prev: number): number {
  const c = u.cache_creation;
  if ((c?.ephemeral_1h_input_tokens ?? 0) > 0) return TTL_1H;
  if ((c?.ephemeral_5m_input_tokens ?? 0) > 0) return TTL_5M;
  if ((u.cache_read_input_tokens ?? 0) > 0 || (u.cache_creation_input_tokens ?? 0) > 0) return prev || TTL_5M;
  return 0;
}

// ms left before the cache goes cold (0 = cold), or null when there is nothing to show.
export function cacheLeft(s: { cacheAt: number | null; cacheTtlMs: number }, now: number): number | null {
  if (!s.cacheAt || !s.cacheTtlMs) return null;
  return Math.max(0, s.cacheAt + s.cacheTtlMs - now);
}

// Short label for the bar: "42M", "<1M", "COLD".
export function cacheShort(left: number): string {
  if (left <= 0) return 'COLD';
  return left < MIN ? '<1M' : `${Math.ceil(left / MIN)}M`;
}

// True near the end of a warm cache (last 5 minutes of 1 hour, last minute of 5): send now or it goes cold.
export const cacheEnding = (left: number, ttl: number) => left > 0 && left <= Math.min(TTL_5M, ttl / 5);
