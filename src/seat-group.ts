import { inTurnGroup, newTurnGroup, stopTurnGroup } from '@src/cancel.js';
import { Escalation, EXIT, fmtTokens } from '@src/charge.js';
import type { RunState } from '@src/types.js';

/**
 * Run a round's finder or verifier turns, at most `limit` at once (#403).
 *
 * ## What it decides, and what it deliberately does not
 *
 * It decides **when** each task starts and **what happens to the others when
 * one fails the round**. It does not decide what is recorded: every task writes
 * into a slot its caller owns, indexed by config order, and the caller reads the
 * slots in that order once the group is done. That is what makes the round's
 * artifacts the same whichever turn finished first (decision 3) - completion
 * order reaches nothing but the events, which describe what happened and so
 * stay in real time.
 *
 * At `limit` 1 each task starts once the previous one has settled, so the
 * effects arrive in exactly the order the sequential loops this replaced
 * produced, and a run that never raises the setting is unchanged.
 *
 * ## A task that rejects ends the group
 *
 * A task absorbs what costs only itself - a finder's failure, a verifier's
 * `cannot-tell` - so a rejection is something that ends the round: a ceiling, a
 * stop, a rate limit waited out past its cap. On the first one the group is
 * stopped (`stopTurnGroup`: every live sibling is killed, every sibling wait
 * woken, nothing new starts) and **every sibling is waited for** before the
 * first error is rethrown - `withConcurrentCompaction`'s `allSettled` rule, for
 * its reason: a sibling still charging and recording into a run whose ending has
 * begun would leave the record incoherent at the moment the error propagates.
 * Each killed sibling is charged on the way out by `withRateLimitRetry`, which
 * already calls `chargeFailure` before it rethrows, so its events land before
 * the escalation `cli.ts` records.
 *
 * It is never the run's latch. A ceiling is not a stop, and `requestCancel`
 * would end the run under the wrong sentence and the wrong exit code.
 */
export async function runSeatGroup(
  state: RunState,
  limit: number,
  tasks: readonly (() => Promise<void>)[],
): Promise<void> {
  // Fail closed: a bound that is not a whole number from 1 would start no
  // worker at all, and the round would go on as though every seat had run.
  // `validateReview` keeps this off every supported path; this is the backstop.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`review.maxParallel is ${String(limit)}; it must be a whole number of turns from 1`);
  }
  const group = newTurnGroup();
  let next = 0;
  let running = 0;
  let failure: { err: unknown; live: number } | null = null;

  const worker = async (): Promise<void> => {
    while (failure === null && next < tasks.length) {
      const task = tasks[next];
      next += 1;
      if (task === undefined) continue;
      running += 1;
      try {
        await inTurnGroup(group, task);
      } catch (err: unknown) {
        // The first is the one rethrown; a sibling killed by the stop below
        // rejects too, and that is the stop working rather than a second cause.
        if (failure === null) {
          failure = { err, live: running };
          stopTurnGroup(group, describe(err));
        }
      } finally {
        running -= 1;
      }
    }
  };

  // Workers never reject - every task's rejection is caught above - so this is
  // `allSettled` in effect: it returns once every started task has settled.
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));

  const failed = failure as { err: unknown; live: number } | null;
  if (failed === null) return;
  throw withGroupFigure(state, failed.err, failed.live);
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `a seat turn beside this one ended the round (${message.split(/\r?\n/)[0] ?? ''})`;
}

/**
 * A ceiling crossed with siblings live, said with the group's figures.
 *
 * `enforceCeilings` speaks for the one charge that crossed the line, and by the
 * time the group rethrows, every sibling it stopped has been charged on top of
 * it - so its figure is no longer the run's. The sentence is kept and the
 * group's measurement is added: how many seat turns were live, counting the one
 * that crossed, and the run's totals after every one of them was charged. A
 * Codex turn stopped mid-flight reports nothing and is charged nothing, and the
 * sentence says so rather than guessing at it. With no sibling live the error is
 * returned untouched, which is every ceiling at `maxParallel` 1.
 */
function withGroupFigure(state: RunState, err: unknown, live: number): unknown {
  if (!(err instanceof Escalation) || err.code !== EXIT.BUDGET || live <= 1) return err;
  return new Escalation(
    err.code,
    `${err.message} ${live} seat turns were live in this round's group when it was crossed: ` +
      `this one and ${live - 1} beside it, which were stopped and each charged what it had ` +
      'reported or been observed to spend (a Codex turn reports nothing in flight, so one stopped ' +
      `mid-flight counts as zero). Combined, the run now stands at ${fmtTokens(state.tokensUsed)} tokens` +
      ` / ~$${state.costUsd.toFixed(2)}.`,
    err.questions,
    err.findings,
  );
}
