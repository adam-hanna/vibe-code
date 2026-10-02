import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueIntoImplementation } from '@src/run.js';
import { StoredStateError } from '@src/stored.js';
import { freshRun, planFixture } from './helpers/loop-harness.js';
import type { Finding, RunState } from '@src/types.js';

/**
 * What happens after a plan-only run finishes (#223).
 *
 * Two defects, reported together, and they are the same misunderstanding from
 * opposite sides: *"It says I did plan only mode but then it seemed to stop,
 * even though it still had p1 issues. Also, after it stopped, I SHOULD have been
 * able to continue, either with more planning or move on to implementation, but
 * it didn't allow that. When I asked the pilot, it kicked off another run from
 * scratch."*
 *
 * The first is a false claim: the summary said *"Plan cleared critique with zero
 * P1s"* over a plan the tolerance had let through carrying one, contradicting
 * the `Plan accepted with 1 P1(s) carried into implementation` four lines above
 * it. That guard is in `cli.ts` and is covered by the summary cases; what is
 * pinned here is the field it was reading the wrong one of — **a plan-only run
 * carries its P1s in `carried`, and `outstanding` is the implementation-side
 * list it never reaches.**
 *
 * The second is this file's subject. A plan-only run *completes*, which is the
 * settled distinction AGENTS.md records — `planOnly` says there is no next
 * phase, a `stop` gate is the resumable halt — so `vibe resume` correctly
 * refused, and the only path left was a new run that re-derives a plan that
 * already exists. `continueIntoImplementation` is the named act that closes
 * that, and the whole of it is the three refusals plus what survives.
 */

/** A plan-only run that finished: what `runPhases` leaves behind. */
function planned(over: Partial<RunState> = {}): RunState {
  const state = freshRun({ prefix: 'vibe-continue-', task: 'plan then implement', planOnly: true });
  state.plan = planFixture();
  state.status = 'planned';
  state.phase = 'complete';
  return Object.assign(state, over);
}

const p1 = (id: string): Finding =>
  ({ id, severity: 'P1', title: id, evidence: [] }) as unknown as Finding;

// ---- the two lists are not the same list ------------------------------------

test('a plan-only run carries its P1s in `carried`, never in `outstanding`', () => {
  // The field the summary was reading. `outstanding` is written by the final fix
  // round, which a plan-only run never reaches — so it is empty on every one of
  // them, and a guard reading it reports "zero P1s" over a plan that carried
  // some. They are different lists about different phases and must stay so.
  const state = planned({ carried: [p1('valid-json-primitives-misclassified')] });

  assert.equal(state.outstanding, undefined, 'a plan-only run must not set `outstanding`');
  assert.equal(state.carried?.length, 1);
});

// ---- what it converts -------------------------------------------------------

test('a finished plan-only run becomes an implementing run', () => {
  const state = planned();

  continueIntoImplementation(state);

  assert.equal(state.planOnly, false, 'planOnly is what `runPhases` reads to stop');
  assert.equal(state.status, 'implementing');
  assert.equal(state.phase, 'implementing');
});

test('everything the plan phase settled travels with it', () => {
  // This is what makes it a continuation rather than a second run: the
  // implementer is told about all four, exactly as it would have been had the
  // run never been plan-only. A new run started from the same brief has none of
  // them, which is what "kicked off another run from scratch" cost.
  const plan = planFixture({ plan_md: '# the approved plan' });
  const carried = [p1('valid-json-primitives-misclassified')];
  const declined = [p1('deferred-thing')];
  const state = planned({ plan, carried, declined });
  state.acceptanceCriteria = [];
  const bar = state.acceptanceCriteria;

  continueIntoImplementation(state);

  assert.equal(state.plan?.plan_md, '# the approved plan');
  assert.deepEqual(state.carried, carried);
  assert.deepEqual(state.declined, declined);
  assert.equal(state.acceptanceCriteria, bar, 'the bar the critic passed must not move');
  // And the task is untouched, which is the same rule a rename obeys one layer
  // up: it is what the run was started with, written once.
  assert.equal(state.task, 'plan then implement');
});

test('converting twice is refused rather than repeated', () => {
  // The second call sees a run that is no longer plan-only, which is exactly the
  // first refusal. A conversion that was idempotent would be one somebody could
  // re-run after the implement phase had started and lose its place.
  const state = planned();
  continueIntoImplementation(state);

  assert.throws(() => continueIntoImplementation(state), StoredStateError);
});

// ---- what it refuses --------------------------------------------------------

test('a run that was never plan-only has nothing to convert', () => {
  const state = planned({ planOnly: false, status: 'implementing' });

  assert.throws(
    () => continueIntoImplementation(state),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError);
      assert.match(err.message, /not a plan-only run/);
      // It names where the run actually is, because the reasonable next action
      // depends on it and "no" alone does not say what to do instead.
      assert.match(err.message, /implementing/);
      return true;
    },
  );
});

test('a plan-only run that has not finished planning is an ordinary resume', () => {
  // Converting it would skip the critique the plan has not passed — which is the
  // one thing plan-only exists to guarantee happened.
  for (const status of ['planning', 'needs-input', 'error'] as const) {
    const state = planned({ status, phase: 'planning' });
    assert.throws(
      () => continueIntoImplementation(state),
      (err: unknown) => {
        assert.ok(err instanceof StoredStateError);
        assert.match(err.message, /has not finished planning/);
        assert.match(err.message, /Resume it normally/);
        return true;
      },
      `status ${status} was converted`,
    );
    // And nothing was changed on the way to refusing.
    assert.equal(state.planOnly, true);
    assert.equal(state.status, status);
  }
});

test('a run reporting a finished plan but storing none cannot implement one', () => {
  // `status: 'planned'` with no plan is a repaired state, and a run that
  // implemented from nothing would be the fabrication the model is arranged
  // against.
  const state = planned({ plan: null });

  assert.throws(
    () => continueIntoImplementation(state),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError);
      assert.match(err.message, /stored none/);
      assert.match(err.message, /Nothing was changed/);
      return true;
    },
  );
  assert.equal(state.planOnly, true, 'the refusal converted it anyway');
});

// ---- the flag that asks for it ----------------------------------------------

test('--implement is a resume flag, and the rule is not a second copy of itself', async () => {
  // The CLI's job is to ask; every refusal above belongs to `run.ts` so both
  // front ends check one rule. A `--implement` that decided any of this itself
  // would be the second definition `consistency.ts` exists to prevent.
  const { parseArgs } = await import('@src/cli.js');
  assert.equal(parseArgs(['r1', '--implement']).flags.implement, true);
  assert.equal(parseArgs(['r1']).flags.implement, undefined);
});
