import { query, type Query, type SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { UsageResponse, UsageShare, UsageStats, UsageWindow } from '../shared/protocol.ts';
import { config } from './config.ts';
import type { Tabs } from './tabs.ts';

// Plan usage meter. GET /api/usage[?details=1][&fresh=1] -> UsageResponse (shared/protocol.ts). Authed requests only.
// Asks Claude Code's experimental usage call (it may change or go away: every failure becomes "not available").
// Uses a tab's running Claude process when there is one, else a short-lived one of our own: no prompt is sent,
// no settings or MCP servers are loaded, started at most once a minute, closed after OWN_IDLE_MS unused.
// Plan limits are cached 60 s; the scan of this PC's saved chats (stats) 5 minutes. Failed tries wait too.

const LIMITS_MS = 60_000;
const STATS_MS = 5 * 60_000;
const SPAWN_GAP_MS = 60_000;
const OWN_IDLE_MS = 90_000;
const TIMEOUT_MS = 15_000;

type Raw = SDKControlGetUsageResponse;
type RawWindow = { utilization: number | null; resets_at: string | null } | null | undefined;

let limits: UsageResponse = { available: false, plan: null, fiveHour: null, week: null, models: [], extra: null, checkedAt: 0 };
let stats: UsageStats | null = null;
let limitsTried = 0;
let statsTried = 0;
let asking: Promise<void> | undefined;
let own: Query | undefined;
let ownTimer: ReturnType<typeof setTimeout> | undefined;
let spawnedAt = 0;

export async function usage(tabs: Tabs, details: boolean, fresh: boolean): Promise<UsageResponse> {
  // Two passes: a call already running may not have asked for what this one needs (stats).
  for (let pass = 0; pass < 2; pass++) {
    const now = Date.now();
    const needStats = details && now - statsTried >= (fresh ? LIMITS_MS : STATS_MS);
    if (now - limitsTried < LIMITS_MS && !needStats) break;
    if (!asking) asking = ask(tabs, needStats).finally(() => (asking = undefined));
    await asking;
  }
  return details ? { ...limits, stats } : limits;
}

async function ask(tabs: Tabs, withStats: boolean): Promise<void> {
  limitsTried = Date.now();
  if (withStats) statsTried = limitsTried;
  let q: Query | undefined;
  try {
    q = tabs.liveQuery() ?? ownQuery();
    if (typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') throw new Error('This Claude Code version has no usage call.');
    const raw = await inTime(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: !withStats }));
    limits = fromRaw(raw);
    if (withStats) stats = statsFromRaw(raw.behaviors);
  } catch (e) {
    // Keep the last numbers; the page says they could not be refreshed.
    limits = { ...limits, error: e instanceof Error ? e.message : String(e) };
    if (q && q === own) closeOwn();
  }
}

// Our own Claude process, for when no tab has one running.
function ownQuery(): Query {
  if (!own) {
    if (Date.now() - spawnedAt < SPAWN_GAP_MS) throw new Error('Asked too often. Try again in a minute.');
    spawnedAt = Date.now();
    const idle = (async function* (): AsyncGenerator<never> {
      await new Promise(() => {});
    })();
    own = query({ prompt: idle, options: { cwd: config.cwd, settingSources: [], strictMcpConfig: true, persistSession: false } });
  }
  clearTimeout(ownTimer);
  ownTimer = setTimeout(closeOwn, OWN_IDLE_MS);
  return own;
}

function closeOwn(): void {
  clearTimeout(ownTimer);
  own?.close();
  own = undefined;
}

function inTime<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Claude did not answer in time.')), TIMEOUT_MS))]);
}

function win(w: RawWindow): UsageWindow | null {
  if (!w || typeof w.utilization !== 'number') return null;
  const t = w.resets_at ? Date.parse(w.resets_at) : NaN;
  return { pct: Math.max(0, w.utilization), resetsAt: Number.isFinite(t) ? t : null };
}

function fromRaw(raw: Raw): UsageResponse {
  const rl = raw.rate_limits;
  const base = { plan: raw.subscription_type ?? null, models: [], extra: null, fiveHour: null, week: null, checkedAt: Date.now() };
  if (!raw.rate_limits_available || !rl) {
    const why = raw.subscription_type ? 'Plan limits are not available right now.' : 'Plan limits exist only for a claude.ai login (Pro, Max, Team). This PC uses an API key or another provider.';
    return { ...base, available: false, error: why };
  }
  const models: UsageResponse['models'] = [];
  const named: [string, RawWindow][] = [
    ['Opus', rl.seven_day_opus],
    ['Sonnet', rl.seven_day_sonnet],
    ...(rl.model_scoped ?? []).map((m): [string, RawWindow] => [m.display_name, m]),
  ];
  for (const [name, w] of named) {
    const x = win(w);
    if (x && name && !models.some((m) => m.name.toLowerCase() === name.toLowerCase())) models.push({ name, ...x });
  }
  // Extra usage amounts come in cents (minor units of the currency); the page gets whole dollars.
  const ex = rl.extra_usage;
  const unit = 10 ** ((ex as { decimal_places?: number } | null | undefined)?.decimal_places ?? 2);
  const money = (n: number | null | undefined) => (typeof n === 'number' ? n / unit : null);
  return {
    ...base,
    available: true,
    fiveHour: win(rl.five_hour),
    week: win(rl.seven_day),
    models,
    extra: ex?.is_enabled ? { pct: ex.utilization ?? null, used: money(ex.used_credits), limit: money(ex.monthly_limit), currency: (ex.currency || 'USD').toUpperCase() } : null,
  };
}

// The /usage dialog's scan of this PC's saved chats: counts, plus what took the most (rows overlap).
function statsFromRaw(b: Raw['behaviors']): UsageStats | null {
  if (!b?.day || !b.week) return null;
  const rows = new Map<string, UsageShare>();
  const add = (kind: UsageShare['kind'], name: string, when: 'day' | 'week', pct: number) => {
    const row = rows.get(`${kind}:${name}`) ?? { kind, name, day: 0, week: 0 };
    row[when] = Math.round(pct);
    rows.set(`${kind}:${name}`, row);
  };
  for (const when of ['day', 'week'] as const) {
    const w = b[when];
    for (const x of w.behaviors ?? []) add('trait', x.key, when, x.pct);
    for (const x of w.agents ?? []) add('agent', x.name, when, x.pct);
    for (const x of w.skills ?? []) add('skill', x.name, when, x.pct);
    for (const x of w.plugins ?? []) add('plugin', x.name, when, x.pct);
    for (const x of w.mcp_servers ?? []) add('mcp', x.name, when, x.pct);
  }
  return {
    day: { requests: b.day.request_count ?? 0, sessions: b.day.session_count ?? 0 },
    week: { requests: b.week.request_count ?? 0, sessions: b.week.session_count ?? 0 },
    shares: [...rows.values()].sort((x, y) => y.week - x.week || y.day - x.day).slice(0, 10),
  };
}
