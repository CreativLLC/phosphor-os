// What the OPERATOR scene shows (scene.ts draws it; tests/scene.ts checks this file). No DOM here.
// The mascot acts out what Claude does now, read from the tab's activity line (server/tab.ts setActivity:
// "Read: server/x.ts", "Thinking", "Waiting for your answer", ...). Helpers (crew) walk in while they run,
// work beside the mascot, and walk out when they finish.

import type { Agent, Item, TabState } from '../../shared/protocol.ts';

export type Activity = 'idle' | 'think' | 'write' | 'read' | 'edit' | 'work' | 'shell' | 'web' | 'wait' | 'done' | 'error';

// Tool name (Claude Code's, or the labels a Gemini chat uses) -> what the mascot does. Unknown tools: 'work'.
export const TOOL_ACTIVITY: Record<string, Activity> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  LS: 'read',
  List: 'read',
  Find: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  Monitor: 'shell',
  PowerShell: 'shell',
  Run: 'shell',
  WebSearch: 'web',
  WebFetch: 'web',
  TodoWrite: 'think',
};

export function toolActivity(name: string): Activity {
  const a = TOOL_ACTIVITY[name];
  if (a) return a;
  // Connector tools (mcp__server__tool): browsers and web lookups get the binoculars.
  if (name.startsWith('mcp__') && /browser|playwright|chrome|fetch|web|search|navigate/i.test(name)) return 'web';
  return 'work';
}

// The activity line -> activity; '' (idle) -> null.
export function lineActivity(line: string): Activity | null {
  if (!line) return null;
  if (line.startsWith('Waiting for your')) return 'wait';
  if (line === 'Writing a reply') return 'write';
  if (/^(Thinking|Choosing a model|Told no)/.test(line)) return 'think';
  const tool = /^([\w.-]+): /.exec(line);
  return tool ? toolActivity(tool[1]) : 'work';
}

// How long the cheer (or the error face) stays after a turn ends.
export const DONE_MS = 6000;

// A turn that ended with an error note (server/tab.ts pump: "Error: ...").
export function endedInError(items: readonly Item[]): boolean {
  const last = items[items.length - 1];
  return last?.kind === 'note' && /^Error\b/.test(last.text);
}

// The newest item is a failed tool and the activity line still names it: Claude is looking at the failure.
function toolFailedNow(t: TabState): boolean {
  const last = t.items[t.items.length - 1];
  return last?.kind === 'tool' && !!last.error && t.activity.startsWith(`${last.name}: `);
}

// ended: when this tab's last turn ended in this page, and whether in an error (scene.ts keeps it).
export function sceneActivity(t: TabState | undefined, ended: { at: number; error: boolean } | null, now: number): Activity {
  if (!t) return 'idle';
  if (t.meta.attention) return 'wait';
  if (t.meta.busy) return toolFailedNow(t) ? 'error' : (lineActivity(t.activity) ?? 'think');
  if (ended && now - ended.at < DONE_MS) return ended.error ? 'error' : 'done';
  return 'idle';
}

// ---------- Crew on stage ----------

export const ENTER_MS = 1800; // walking in
export const POSE_MS = 1200; // the cheer or slump before walking out
export const LEAVE_MS = POSE_MS + 1800; // pose, then walking out
export const MAX_CREW = 4;

export type Phase = 'enter' | 'work' | 'leave';
export type Walker = { id: string; agent: Agent; slot: number; phase: Phase; since: number };

// Next roster from the last one. slots: how many fit on stage now (at most MAX_CREW). animate: false on a tab
// switch or first paint, so crew already at work just stand there and finished crew are simply gone.
export function planCrew(prev: readonly Walker[], agents: readonly Agent[], now: number, slots: number, animate: boolean): { walkers: Walker[]; extra: number } {
  slots = Math.max(0, Math.min(MAX_CREW, slots));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const walkers: Walker[] = [];
  for (const w of prev) {
    const a = byId.get(w.id);
    if (!a || w.slot >= slots) continue;
    if (w.phase === 'leave') {
      if (animate && now - w.since < LEAVE_MS) walkers.push({ ...w, agent: a });
    } else if (a.status !== 'running') {
      if (animate) walkers.push({ ...w, agent: a, phase: 'leave', since: now });
    } else {
      walkers.push({ ...w, agent: a, phase: w.phase === 'enter' && now - w.since >= ENTER_MS ? 'work' : w.phase });
    }
  }
  const used = new Set(walkers.map((w) => w.slot));
  const onStage = new Set(walkers.map((w) => w.id));
  const waiting = agents.filter((a) => a.status === 'running' && !onStage.has(a.id)).sort((a, b) => a.startedAt - b.startedAt);
  let extra = 0;
  for (const a of waiting) {
    let slot = 0;
    while (used.has(slot)) slot++;
    if (slot >= slots) {
      extra++;
      continue;
    }
    used.add(slot);
    walkers.push({ id: a.id, agent: a, slot, phase: animate ? 'enter' : 'work', since: now });
  }
  walkers.sort((a, b) => a.slot - b.slot);
  return { walkers, extra };
}

// When the roster next changes by itself (a walk ends), or Infinity.
export function nextCrewChange(walkers: readonly Walker[]): number {
  let t = Infinity;
  for (const w of walkers) {
    if (w.phase === 'enter') t = Math.min(t, w.since + ENTER_MS);
    if (w.phase === 'leave') t = Math.min(t, w.since + LEAVE_MS);
  }
  return t;
}

// Stage layout in grid cells: the operator's corner on the left, then one slot per helper.
export const STAGE_X = 46;
export const SLOT_W = 17;
export const crewSlots = (w: number): number => Math.max(0, Math.min(MAX_CREW, Math.floor((w - STAGE_X) / SLOT_W)));
export const slotX = (slot: number): number => STAGE_X + slot * SLOT_W;
