// Decision models ("system one"): typed questions about a state, answered in one forward pass. One wire format for
// all engines, `POST /v1/systemone` (TypeSafe's Jev in the cloud, llama.cpp's llama-server with a decision model on
// this PC). This file is the pure part: question and answer types and reading an engine's answer. No imports, so
// tests run it headless. The client is server/decide.ts; the setup is docs/LOCAL-MODEL.md "Decision model".

// noul: yes/no. criteria (optional) says what counts as yes (true) and as no (false).
export type NoulQuestion = { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };
// choice: one of the options. criteria maps each option to a description (null = the name says it all).
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string | null> };
// score: a level, 2 to 10 descriptions, lowest first.
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

// confidence: 0 = no idea (every answer equally likely), 1 = sure. For noul it is |2p - 1|.
export type NoulAnswer = { type: 'noul'; yes: boolean; p: number; confidence: number };
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
// score: the expected level (may lie between two); level: the most likely one (index into the criteria).
export type ScoreAnswer = { type: 'score'; score: number; level: number; probabilities: number[]; confidence: number };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type AnswerFor<Q extends Question> = Q extends NoulQuestion ? NoulAnswer : Q extends ChoiceQuestion ? ChoiceAnswer : ScoreAnswer;
export type Answers<Q extends Questions> = { [K in keyof Q]: AnswerFor<Q[K]> };

// Why there is no answer. off: PHOSPHOR_DECIDE=off. down: no engine at the URL (or it failed a moment ago and is
// left alone for a few seconds). timeout, aborted: the caller's limits. error: the engine refused or answered nonsense.
export type DecideFailure = 'off' | 'down' | 'timeout' | 'aborted' | 'error';

export type DecideResult<Q extends Questions> =
  | { ok: true; answers: Answers<Q>; model: string; inputTokens: number; ms: number }
  | { ok: false; reason: DecideFailure; error: string; ms: number };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// TypeSafe's confidence formulas (llama.cpp uses the same), for an engine that sends none.
// choice: how far the top option stands above all-equal. score: how close the levels sit around the most likely one.
export function choiceConfidence(probs: number[]): number {
  if (probs.length < 2) return 1;
  const uniform = 1 / probs.length;
  return Math.max(0, (Math.max(...probs) - uniform) / (1 - uniform));
}
export function scoreConfidence(probs: number[]): number {
  const n = probs.length;
  if (n < 2) return 1;
  const mode = probs.indexOf(Math.max(...probs));
  const dist = probs.reduce((s, p, i) => s + p * Math.abs(i - mode), 0);
  const uniform = probs.reduce((s, _, i) => s + Math.abs(i - (n - 1) / 2) / n, 0);
  return Math.max(0, 1 - dist / uniform);
}

// An engine's `answers` object read against the questions asked: every question must have a well-formed answer of
// its type, else null (the caller treats the whole call as failed; half an answer is not worth trusting).
export function parseAnswers<Q extends Questions>(raw: unknown, questions: Q): Answers<Q> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = (raw as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object') return null;
    if (q.type === 'noul') {
      const p = num(a.noul);
      if (p === null) return null;
      out[id] = { type: 'noul', p: clamp01(p), yes: p >= 0.5, confidence: Math.abs(2 * clamp01(p) - 1) };
    } else if (q.type === 'choice') {
      const probs = a.probabilities && typeof a.probabilities === 'object' ? (a.probabilities as Record<string, unknown>) : {};
      const probabilities = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, num(probs[k]) ?? 0]));
      const best = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0];
      const choice = typeof a.choice === 'string' && a.choice in q.criteria ? a.choice : best && best[1] > 0 ? best[0] : '';
      if (!choice) return null;
      out[id] = { type: 'choice', choice, probabilities, confidence: clamp01(num(a.confidence) ?? choiceConfidence(Object.values(probabilities))) };
    } else {
      const probs = a.probabilities && typeof a.probabilities === 'object' ? (a.probabilities as Record<string, unknown>) : {};
      const probabilities = q.criteria.map((_, i) => num(probs[String(i)]) ?? 0);
      const score = num(a.score);
      if (score === null) return null;
      const level = probabilities.some((p) => p > 0) ? probabilities.indexOf(Math.max(...probabilities)) : Math.round(score);
      out[id] = { type: 'score', score, level, probabilities, confidence: clamp01(num(a.confidence) ?? scoreConfidence(probabilities)) };
    }
  }
  return out as Answers<Q>;
}
