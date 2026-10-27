import { parseAnswers, type DecideFailure, type DecideResult, type Questions } from '../shared/decide.ts';

// Decision engine client: typed questions about a state, typed answers with confidence, in well under a second.
// Any engine that speaks `POST /v1/systemone` (TypeSafe's format): the local llama-server with a decision model
// (scripts/setup-decide-model.sh, docs/LOCAL-MODEL.md "Decision model"), TypeSafe's Jev in the cloud, others.
//
//   const r = await askDecision(transcript, {
//     started: { type: 'noul', instructions: 'Has the speaker started talking about: pricing?' },
//     topic: { type: 'choice', instructions: 'What is this about?', criteria: { billing: null, bugs: 'errors, crashes' } },
//   }, { timeoutMs: 800, signal });
//   if (r.ok) r.answers.started.p;   // 0..1, .yes, .confidence; choice: .choice, .probabilities, .confidence
//   else r.reason;                   // 'off' | 'down' | 'timeout' | 'aborted' | 'error': fall back, never throws
//
// Settings (.env): PHOSPHOR_DECIDE_URL (default the local decision server, 127.0.0.1:8090; a base URL or the full
// endpoint), PHOSPHOR_DECIDE_KEY (sent as a Bearer token; the cloud needs one, the local server none),
// PHOSPHOR_DECIDE_MODEL (the request's `model`: the cloud needs one, e.g. jev-latest), PHOSPHOR_DECIDE=off.
// All questions of one call share the state; send them together (one pass reads the state once).
// An engine that is not there answers 'down' at once, and is left alone for DOWN_RETRY_MS so a caller that asks
// every second does not wait on it each time.

export const DECIDE_DEFAULT_URL = 'http://127.0.0.1:8090';
export const DECIDE_TIMEOUT_MS = 2000;
export const DOWN_RETRY_MS = 5000;

export type DecideConfig = { on: boolean; url: string; key: string; model: string };
export type DecideOptions = { timeoutMs?: number; signal?: AbortSignal };

export const decideConfig = (env: NodeJS.ProcessEnv = process.env): DecideConfig => ({
  on: env.PHOSPHOR_DECIDE !== 'off',
  url: env.PHOSPHOR_DECIDE_URL || DECIDE_DEFAULT_URL,
  key: env.PHOSPHOR_DECIDE_KEY ?? '',
  model: env.PHOSPHOR_DECIDE_MODEL ?? '',
});

// A base URL gets the endpoint path; a URL that already names it is used as it is.
export const endpoint = (url: string): string => {
  const u = url.replace(/\/+$/, '');
  return /\/systemone$/.test(u) ? u : /\/v1$/.test(u) ? `${u}/systemone` : `${u}/v1/systemone`;
};

export type Deps = { config: () => DecideConfig; fetch: typeof fetch; now: () => number };

export function makeDecider(deps: Deps) {
  let downUntil = 0;
  return async function ask<Q extends Questions>(state: string | object, questions: Q, opts: DecideOptions = {}): Promise<DecideResult<Q>> {
    const t0 = deps.now();
    const fail = (reason: DecideFailure, error = ''): DecideResult<Q> => ({ ok: false, reason, error, ms: deps.now() - t0 });
    const cfg = deps.config();
    if (!cfg.on) return fail('off');
    if (opts.signal?.aborted) return fail('aborted');
    if (deps.now() < downUntil) return fail('down', 'not reachable a moment ago');
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), opts.timeoutMs ?? DECIDE_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timer.signal]) : timer.signal;
    const why = () => (opts.signal?.aborted ? 'aborted' : 'timeout');
    try {
      const res = await deps.fetch(endpoint(cfg.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
        body: JSON.stringify({ ...(cfg.model ? { model: cfg.model } : {}), state, questions }),
        signal,
      });
      const text = await res.text();
      if (!res.ok) return fail('error', `HTTP ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 120)}`.trim());
      let body: { answers?: unknown; model?: unknown; usage?: { input_tokens?: unknown } };
      try {
        body = JSON.parse(text);
      } catch {
        return fail('error', 'not JSON');
      }
      const answers = parseAnswers(body.answers, questions);
      if (!answers) return fail('error', 'answers missing or malformed');
      const tokens = body.usage?.input_tokens;
      return { ok: true, answers, model: typeof body.model === 'string' ? body.model : cfg.model, inputTokens: typeof tokens === 'number' ? tokens : 0, ms: deps.now() - t0 };
    } catch (e) {
      if (signal.aborted) return fail(why());
      downUntil = deps.now() + DOWN_RETRY_MS; // refused, no route, reset: nobody home
      return fail('down', e instanceof Error ? String((e.cause as Error | undefined)?.message ?? e.message).slice(0, 120) : 'error');
    } finally {
      clearTimeout(t);
    }
  };
}

export const askDecision = makeDecider({ config: () => decideConfig(), fetch: (...a) => fetch(...a), now: Date.now });
