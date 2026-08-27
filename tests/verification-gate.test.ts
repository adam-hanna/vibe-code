import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import {
  agents,
  config,
  report,
  reviewingRun,
  unlaunchableVerify,
  verifying,
  verifyRuns,
  work,
} from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * The verification gate, driven through the real loop.
 *
 * `runGate` is the only thing in the run that distinguishes code that works
 * from code that reads as though it does, and until the harness existed nothing
 * could reach it: both loop tests set `verify.enabled: false` because they were
 * testing something else. The command here is real - a one-line `.mjs` script
 * the case controls, run by `src/verify.ts` exactly as a project's own `npm
 * test` would be - so what is asserted is where the gate sits in the loop, not
 * what a fake said about it.
 */

const RUN = { prefix: 'vibe-gate-', task: 'verification gate' } as const;

function gateRun(): RunState {
  return reviewingRun({ ...RUN, commit: true });
}

test('a failing command becomes a P0 that the fix loop answers', async () => {
  const state = gateRun();
  const calls: string[] = [];

  await orchestrate(
    state,
    config({ maxVerifyRounds: 3 }, verifying(state, { failures: 1 })),
    true,
    agents({ claude: (label) => work(state, `${label}.txt`), codex: () => report([]) }, calls),
  );

  // The failure is fixed before anything is reviewed: spending a reviewer turn
  // on code that does not execute buys an opinion about the wrong thing.
  assert.deepEqual(calls, ['verify-fix-1', 'review-0']);
  assert.equal(state.verifyRound, 1);
  // The stable id is what oscillation detection needs to see an identical
  // failure across rounds, so it is asserted rather than assumed.
  assert.deepEqual(state.verifyRounds[0]?.ids, ['verification-failing']);
  assert.equal(existsSync(path.join(state.dir, 'verify-failure-0.txt')), true);
  assert.equal(existsSync(path.join(state.dir, 'verify-fix-1.md')), true);

  // Order, not just presence. The failure has to precede the proof of the fix,
  // and two `includes` checks are satisfied by the reverse sequence just as
  // happily - which would be a gate that passed and then started failing.
  const gate = state.events
    .map((e) => e.type)
    .filter((type) => type === 'verify_failed' || type === 'verify_passed');
  assert.deepEqual(gate, ['verify_failed', 'verify_passed']);
  // Twice: the run that failed, and the one that proved the fix.
  assert.equal(verifyRuns(state), 2);
});

test('the verification loop has its own round cap, and stops at it', async () => {
  const state = gateRun();
  const calls: string[] = [];

  await assert.rejects(
    () =>
      orchestrate(
        state,
        config({ maxVerifyRounds: 2 }, verifying(state, { failures: 99 })),
        true,
        agents({ claude: (label) => work(state, `${label}.txt`), codex: () => report([]) }, calls),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.NO_CONVERGENCE,
  );

  // One fix round, then the cap - and no review turn was ever bought, which is
  // the point of `maxVerifyRounds` being lower than `maxReviewRounds`.
  assert.deepEqual(calls, ['verify-fix-1']);
  assert.equal(state.verifyRounds.length, 2);
});

test('a command that never launched is a configuration error, not a defect to fix', async () => {
  const state = gateRun();
  const calls: string[] = [];

  await assert.rejects(
    () => orchestrate(state, config({}, unlaunchableVerify()), true, agents({}, calls)),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.PREFLIGHT,
  );

  // No source change makes a mistyped command path resolve. Entering the fix
  // loop here was observed burning two implementation-sized turns.
  assert.deepEqual(calls, []);
  assert.equal(existsSync(path.join(state.dir, 'verify-unlaunchable-0.txt')), true);
});

test('a passing gate costs one run and leaves the review order alone', async () => {
  const state = gateRun();
  const calls: string[] = [];

  await orchestrate(
    state,
    config({}, verifying(state)),
    true,
    agents({ codex: () => report([]) }, calls),
  );

  assert.deepEqual(calls, ['review-0']);
  assert.equal(verifyRuns(state), 1);
  assert.ok(state.events.some((e) => e.type === 'verify_passed'));
});

test('a disabled gate never launches the command at all', async () => {
  const state = gateRun();
  // Written but not configured: the file exists, so a gate that ran would
  // leave a count behind.
  verifying(state);

  await orchestrate(state, config(), true, agents({ codex: () => report([]) }, []));

  assert.equal(verifyRuns(state), 0);
  assert.equal(state.events.some((e) => e.type === 'verify_passed'), false);
});
