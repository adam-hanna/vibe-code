import { classifyDeferred } from '@src/questions.js';
import { artifactText } from '@src/run.js';
import type { Answer, Config, Plan, RiskFacts, RunState } from '@src/types.js';
import { planNamedFiles } from '@src/work.js';

/**
 * The run's risk facts at plan approval (#492). Records only.
 *
 * From the CLI a `step` gate never holds, so a run on the default gates passes
 * `plan-approved` with nobody seeing what it decided on its own: the P1s it
 * carried, the questions it left on the planner's fallback, the answers a model
 * gave in a person's place. Each of those is already somewhere in the record;
 * this collects them, as counts, at the one boundary where they are all final.
 *
 * **No threshold, no gate.** Nothing here is compared with anything and nothing
 * in the loop reads the result. The `auto-unless` gate mode - hold at
 * `plan-approved` only when a named fact is non-zero - is deliberately not in
 * this change: whether it is worth building is what a census of these answers,
 * and a mode built before the census would be built on a guess.
 */

/**
 * Whether the run declined an answer rather than using it.
 *
 * `resolveQuestions` and the count below share it, so "a model answered this"
 * means exactly what the loop acted on: an answer the `questions.escalateOn*`
 * settings refused went to `deferredQuestions` or to a person instead.
 */
export function answerDeclined(cfg: Config, a: Pick<Answer, 'defer_to_human' | 'confidence'>): boolean {
  return (
    (cfg.questions.escalateOnDefer && a.defer_to_human) ||
    (cfg.questions.escalateOnLowConfidence && a.confidence === 'low')
  );
}

/**
 * Answers a model gave that the run used, over every question round so far, or
 * undefined when the record cannot say.
 *
 * Counted from `answers-<n>.json`, `n` from 1 to `questionRound`, because that
 * is where an answer is durable: `pendingAnswers` is consumed by the revision
 * and `advisoryAnswers` by the next findings revision, and both are subsets of
 * these files anyway, so adding them would count an answer twice.
 *
 * **One missing, linked or malformed file makes the whole count absent.** A
 * round with no file is a killed answerer turn, a disabled answerer, or a fork
 * whose parent holds the files - and a sum over the rounds that happen to be
 * there would be a smaller number presented as the whole.
 */
export function countModelAnswers(state: RunState, cfg: Config): number | undefined {
  let used = 0;
  for (let n = 1; n <= state.questionRound; n++) {
    const text = artifactText(state, `answers-${n}.json`);
    if (text === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;
    for (const entry of parsed as unknown[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
      const rec = entry as Record<string, unknown>;
      const defer = rec['defer_to_human'];
      const confidence = rec['confidence'];
      if (typeof defer !== 'boolean' || typeof confidence !== 'string') return undefined;
      if (!answerDeclined(cfg, { defer_to_human: defer, confidence: confidence as Answer['confidence'] })) {
        used += 1;
      }
    }
  }
  return used;
}

/**
 * The facts, read from the state and the approved plan. Writes nothing.
 *
 * Called on the save that moves the phase to `implementing`, which is before
 * `planStalls` is reset and after `approvePlan` has set `carried`.
 */
export function riskFactsAt(state: RunState, cfg: Config, plan: Plan): RiskFacts {
  const modelAnswers = countModelAnswers(state, cfg);
  return {
    // `approvePlan` writes `carried` only when it tolerated something, so its
    // absence on an approved plan is a recorded nothing, not a missing record.
    carriedP1s: (state.carried ?? []).length,
    assumptions: plan.assumptions.length,
    deferredQuestions: classifyDeferred(state).remaining.length,
    ...(modelAnswers === undefined ? {} : { modelAnswers }),
    // Absent on a run that never stalled - this build always writes a stall.
    planStalls: (state.planStalls ?? []).length,
    planRounds: state.planRound,
    namedFiles: planNamedFiles(plan.plan_md).length,
  };
}
