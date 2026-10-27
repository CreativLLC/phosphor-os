import type { NoulQuestion } from '../shared/decide.ts';
import type { CueAsk, CueDecide } from '../shared/prompter.ts';
import { askDecision, decideConfig } from './decide.ts';

// PROMPTER's one question to the decision model (server/decide.ts, docs/LOCAL-MODEL.md "Decision model"): the recent
// words and the open points in, how sure (0..1) the speaker has started each point out. Everything else in PROMPTER
// only sees `prompterDecider`.
//
// The wording is the one the decision model was measured with (DECIDE-API: 15 points on a 20 s chunk in about 1.1 s
// on the CPU; "no" answers sit around 0.2 to 0.5, which is why the tick rule in shared/prompter.ts starts at 0.75).

const TIMEOUT_MS = 2500; // about 1.1 s warm, +0.7 s after a long idle
const DOWN_NOTE_MS = 15_000; // a 'down' this recent: the screen says the engine is not running
const SETUP = 'bash scripts/setup-decide-model.sh';

export type PrompterDecider = { label: string; ready: boolean; note: string; decide: CueDecide | null };
type Ask = typeof askDecision;

// The words, as the decision model reads them: the chunk, after one short line naming the points already covered.
export function askState(a: CueAsk): string {
  return a.covered.length ? `(Points already covered: ${a.covered.join('; ')}.)\n\n${a.heard}` : a.heard;
}

// One yes/no question per open point. By idea ("in any words"); starting the point is enough.
export function askQuestion(p: CueAsk['points'][number]): NoulQuestion {
  return { type: 'noul', instructions: `Has the speaker started talking about this point, in any words: "${p.text}"${p.note ? ` (${p.note})` : ''}?` };
}

let downAt = 0;

// A decider over a decision client (tests pass a fake one).
export function makePrompterDecider(ask: Ask, now: () => number = Date.now): CueDecide {
  return async (a, signal) => {
    const questions = Object.fromEntries(a.points.map((p) => [p.id, askQuestion(p)]));
    const r = await ask(askState(a), questions, { timeoutMs: TIMEOUT_MS, signal });
    if (!r.ok) {
      if (r.reason === 'down') downAt = now();
      throw new Error(
        r.reason === 'down' ? `The decision engine is not running. On the PC: ${SETUP}`
        : r.reason === 'timeout' ? 'The decision model took too long.'
        : r.reason === 'off' ? 'The decision engine is off (PHOSPHOR_DECIDE=off).'
        : `The decision model failed${r.error ? `: ${r.error}` : '.'}`,
      );
    }
    downAt = 0;
    return a.points.map((p) => ({ id: p.id, yes: r.answers[p.id].p }));
  };
}

const live = makePrompterDecider(askDecision);

// The decider PROMPTER uses, and what the screens say about it. Swapped by tests (server/prompter.ts `engine`).
export function prompterDecider(): PrompterDecider {
  const cfg = decideConfig();
  if (!cfg.on) return { label: '', ready: false, note: 'The decision engine is off (PHOSPHOR_DECIDE=off): tick points by hand.', decide: null };
  const label = cfg.model ? cfg.model.toUpperCase() : 'DECISION MODEL';
  if (downAt && Date.now() - downAt < DOWN_NOTE_MS) return { label, ready: false, note: `The decision engine is not running (on the PC: ${SETUP}). Tick points by hand.`, decide: live };
  return { label, ready: true, note: '', decide: live };
}
