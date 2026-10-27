import type { CueAsk, CueDecide, CueVerdict } from '../shared/prompter.ts';

// PROMPTER's one question to a decision model: the recent words and the open points in, how sure (0..1) the speaker
// has started each point out. Everything else in PROMPTER only sees this file's `prompterDecider`.

export type PrompterDecider = { label: string; ready: boolean; note: string; decide: CueDecide | null };

// The words, as the decision model reads them.
export function askState(a: CueAsk): { recent_speech: string; points_already_covered: string[] } {
  return { recent_speech: a.heard, points_already_covered: a.covered };
}

// One yes/no question per open point. By idea, not by exact words; starting the point is enough.
export function askQuestion(p: CueAsk['points'][number]): { type: 'noul'; instructions: string; criteria: { true: string; false: string } } {
  return {
    type: 'noul',
    instructions: `The speaker is recording a video and works through a list of points. Has the speaker started talking about this point: "${p.text}"${p.note ? ` (their notes: ${p.note})` : ''}?`,
    criteria: {
      true: 'The recent speech starts or covers this point, even in other words or only its first part.',
      false: 'The recent speech is about something else, or only names the point in passing (a list of what is coming, "later I will...").',
    },
  };
}

export const notSetUp = (): PrompterDecider => ({
  label: '',
  ready: false,
  note: 'The decision engine is not set up: tick points by hand.',
  decide: null,
});

export const toVerdicts = (ids: string[], p: (id: string) => number | undefined): CueVerdict[] =>
  ids.flatMap((id) => {
    const yes = p(id);
    return yes === undefined ? [] : [{ id, yes }];
  });

// The decider PROMPTER uses. Swapped by tests (server/prompter.ts `engine`).
export const prompterDecider = (): PrompterDecider => notSetUp();
