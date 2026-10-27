// AUTO model: pure parts of the router (server/router.ts asks the decision model, else Haiku; this file reads the
// answer and decides what is applied). Type imports only, so tests/router.ts runs it headless.
import type { Answers, Questions } from './decide.ts';

export const ROUTE_MODELS = ['haiku', 'sonnet', 'opus'] as const; // low to high
export const ROUTE_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type RouteModel = (typeof ROUTE_MODELS)[number];
export type RouteEffort = (typeof ROUTE_EFFORTS)[number];

// What the router answers.
export type RoutePick = { model: RouteModel; effort: RouteEffort; newTopic: boolean; reason: string };

// What the tab uses now (model as the picker names it: "opus", "default", "claude-sonnet-5-5"; effort may be '').
export type RouteCurrent = { model: string; effort: string };

export type RouteDecision = { model: string; effort: string; reason: string };

// Picker model values rank by family. Unknown names (a local model) rank -1: the router's pick replaces them.
export function modelRank(model: string): number {
  if (/haiku/i.test(model)) return 0;
  if (/sonnet|^default$/i.test(model)) return 1;
  if (/opus/i.test(model)) return 2;
  if (/fable|mythos/i.test(model)) return 3;
  return -1;
}

const EFFORT_RANK = ['low', 'medium', 'high', 'xhigh', 'max'];

// Haiku's answer: the first {...} in the text, checked field by field. null = unusable.
export function parsePick(text: string): RoutePick | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const model = String(o.model ?? '').toLowerCase();
  const effort = String(o.effort ?? '').toLowerCase();
  if (!ROUTE_MODELS.includes(model as RouteModel) || !ROUTE_EFFORTS.includes(effort as RouteEffort)) return null;
  const reason = String(o.reason ?? '').trim().split(/\s+/).slice(0, 12).join(' ');
  return { model: model as RouteModel, effort: effort as RouteEffort, newTopic: o.newTopic === true, reason: reason || 'no reason given' };
}

// Switching model re-reads the whole chat at full price (prompt cache), and so does changing the thinking
// level; so going UP is always applied and going DOWN only when the router says the topic is new. A new model
// already costs the cache, so then the thinking level follows the pick freely.
// pick null = the router failed: keep what the tab has, or Opus/high when it has nothing yet.
export function decide(pick: RoutePick | null, current: RouteCurrent | null, failure = ''): RouteDecision {
  if (!pick) {
    return current && modelRank(current.model) >= 0
      ? { ...current, reason: `Router failed (${failure}); kept ${current.model}.` }
      : { model: 'opus', effort: 'high', reason: `Router failed (${failure}); used Opus, high.` };
  }
  const cur = current && modelRank(current.model) >= 0 ? current : null;
  if (!cur) return { model: pick.model, effort: pick.effort, reason: pick.reason };

  const up = modelRank(pick.model) > modelRank(cur.model);
  const down = modelRank(pick.model) < modelRank(cur.model);
  const model = up || (down && pick.newTopic) ? pick.model : cur.model;
  const held = down && !pick.newTopic;

  const have = EFFORT_RANK.indexOf(cur.effort);
  const want = EFFORT_RANK.indexOf(pick.effort);
  const effortFree = model !== cur.model || pick.newTopic || have < 0 || want > have;
  const effort = effortFree ? pick.effort : cur.effort;
  const heldEffort = !effortFree && want < have;

  const note = held ? ` (kept ${cur.model}: same topic)` : heldEffort ? ` (kept ${cur.effort}: same topic)` : '';
  return { model, effort, reason: pick.reason + note };
}

// The pick's thinking level held to what the chosen model supports (its efforts in the models list): the nearest
// level at or below it, else the lowest. A model with no levels gets none ('').
export function clampEffort(effort: string, supported: string[]): string {
  if (!effort || supported.includes(effort)) return effort;
  const ranked = supported.filter((e) => EFFORT_RANK.includes(e)).sort((a, b) => EFFORT_RANK.indexOf(a) - EFFORT_RANK.indexOf(b));
  const want = EFFORT_RANK.indexOf(effort);
  return [...ranked].reverse().find((e) => EFFORT_RANK.indexOf(e) <= want) ?? ranked[0] ?? '';
}

// The same rubric as typed questions for a decision model (server/decide.ts). The state is the text Haiku reads.
export const ROUTE_QUESTIONS = {
  model: {
    type: 'choice',
    instructions: 'Which Claude model should handle the new message in a coding and ops assistant? A pick that is too low costs quality, one too high only costs tokens.',
    criteria: {
      opus: 'planning, architecture, design; debugging or why something is broken; multi-file or multi-step code work; agentic tasks that run tools for a while; ambiguous or high-stakes work; writing meant for other people',
      sonnet: 'well-specified edits; single-file changes; explanations; summaries; routine ops like git, installs, config tweaks; questions answerable with a few tool calls',
      haiku: 'trivial only: yes or no, tiny lookups, rename, reformat short text, chit-chat',
    },
  },
  effort: {
    type: 'choice',
    instructions: 'How much thinking does the new message need?',
    criteria: { low: 'trivial', medium: 'routine', high: 'real work', xhigh: 'only hard design or debugging' },
  },
  newTopic: {
    type: 'noul',
    instructions: 'Does the new message start a different task or subject than the chat so far?',
    criteria: { true: 'a different task or subject, or the first message of the chat', false: 'it continues, refines or answers the current work' },
  },
} as const satisfies Questions;
export type RouteQuestions = typeof ROUTE_QUESTIONS;
