import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import {
  agents,
  BLOCKING,
  branchOf,
  commits,
  committedFiles,
  committing,
  config,
  freshRun,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * The whole loop, once through: plan, critique, implement, verify, review.
 *
 * Every other loop test enters partway - at a stall, or at the review phase -
 * because there was nowhere to keep the git repo and the neutered config a
 * fresh run needs. This is the case that proves the phases hand off to each
 * other in the order the run claims, on a real repo, with real commits.
 */

const RUN = { prefix: 'vibe-full-', task: 'full loop' } as const;

/** A run that will not stop after planning, in a repo it can commit to. */
function fullRun(): RunState {
  return freshRun({ ...RUN, planOnly: false, git: true, commit: true });
}

/**
 * The agents a clean pass needs: a plan, an approving judge, and an
 * implementation that actually changes the tree - `commitAll` asks what is
 * staged, so a turn that writes nothing makes every commit a no-op.
 */
function passing(state: RunState): Handlers {
  return {
    // A planning turn returns a plan; every other Claude turn is a writing turn.
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-')
        ? planFixture()
        : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

test('a fresh run plans, critiques, implements and reviews in one pass', async () => {
  const state = fullRun();
  const calls: string[] = [];

  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(passing(state), calls),
  );

  assert.deepEqual(calls, ['plan', 'critique-0', 'implement', 'review-0']);
  assert.equal(state.phase, 'complete');
  assert.equal(state.status, 'done');
  assert.equal(existsSync(path.join(state.dir, 'PLAN.md')), true);
  assert.equal(existsSync(path.join(state.dir, 'implementation-report.md')), true);
  // The gate ran between the implementation and the review, exactly once.
  assert.ok(state.events.some((e) => e.type === 'verify_passed'));
});

test('the run is isolated on its own branch and commits what it wrote', async () => {
  const state = fullRun();

  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(passing(state), []),
  );

  assert.equal(state.branch, `vibe/${state.id}`);
  assert.equal(branchOf(state), `vibe/${state.id}`);
  assert.deepEqual(commits(state), ['vibe: implement approved plan', 'base']);

  const files = committedFiles(state);
  assert.ok(files.includes('implement.txt'), files.join(', '));
  // `.vibe` ignores itself, so the plan, the artifacts and the transcript never
  // land in the user's history - which is the whole reason it does.
  assert.equal(
    files.some((f) => f.startsWith('.vibe')),
    false,
    files.join(', '),
  );
});

test('the same run with commitEachRound off commits nothing', async () => {
  // The control for the case above: `maybeCommit` returns before touching git,
  // so a commit assertion cannot be passing for some reason other than the
  // config that asked for it. Worth stating because `DEFAULTS` has this on and
  // the harness turns it off.
  const state = fullRun();

  await orchestrate(state, config({}, verifying(state)), false, agents(passing(state), []));

  assert.deepEqual(commits(state), ['base']);
  assert.equal(state.phase, 'complete');
});

test('a run that stalls in the plan phase resumes and finishes', async () => {
  const state = fullRun();
  const first: string[] = [];

  await assert.rejects(
    () =>
      orchestrate(
        state,
        config({ maxPlanRounds: 1 }, verifying(state)),
        false,
        agents({ claude: () => planFixture(), codex: () => report(BLOCKING) }, first),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.NO_CONVERGENCE,
  );
  assert.deepEqual(first, ['plan', 'critique-0']);
  assert.equal(state.pendingFindings?.phase, 'plan');

  const second: string[] = [];
  await orchestrate(
    state,
    config({ maxPlanRounds: 5 }, { ...committing(), ...verifying(state) }),
    true,
    agents(passing(state), second),
  );

  // The resume revises against the findings the stall left behind rather than
  // re-buying the critique, and then carries on through the phases it never
  // reached the first time.
  assert.deepEqual(second, ['revise-1', 'critique-1', 'implement', 'review-0']);
  assert.equal(state.phase, 'complete');
  assert.equal(state.pendingFindings, null);
  assert.equal(commits(state)[0], 'vibe: implement approved plan');
});
