import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import {
  agents,
  commits,
  committing,
  config,
  p1,
  report,
  reviewingRun,
  verifying,
  verifyRuns,
  work,
} from './helpers/loop-harness.js';

/**
 * The branch the tolerance takes: one P1 under `loop.p1Tolerance` buys a final
 * fix round that is committed and re-verified, and deliberately not re-reviewed.
 *
 * `pending-findings.test.ts` already pins the artifacts this round writes and
 * the order it writes them in. What it cannot see - because it runs with
 * `verify` and `git.commitEachRound` off - is the other half of the contract:
 * the fix is committed like any other round, and the loop goes back to the top
 * once so the gate can prove the fix broke nothing. Both are what makes
 * OUTSTANDING.md's claim that "a final fix round addressed them and
 * verification still passed" true rather than decorative.
 */

const RUN = { prefix: 'vibe-final-', task: 'final fix round' } as const;

test('the tolerated P1 is fixed, committed and re-verified, but never re-reviewed', async () => {
  const state = reviewingRun({ ...RUN, commit: true });
  const calls: string[] = [];

  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    true,
    agents(
      {
        claude: (label) => work(state, `${label}.txt`),
        codex: (() => {
          let asked = 0;
          return (): unknown => {
            asked += 1;
            if (asked > 1) {
              assert.fail('the final fix round was reviewed again, which reopens the loop');
            }
            return report([p1('tolerated-one')]);
          };
        })(),
      },
      calls,
    ),
  );

  // Another review round could raise something new and the loop would never
  // end, which is the situation the tolerance exists to escape.
  assert.deepEqual(calls, ['review-0', 'final-fix-1']);
  assert.equal(state.finalFixDone, true);
  assert.deepEqual((state.outstanding ?? []).map((f) => f.id), ['tolerated-one']);

  const outstanding = readFileSync(path.join(state.dir, 'OUTSTANDING.md'), 'utf8');
  assert.match(outstanding, /tolerated-one/);
  assert.match(outstanding, /not reviewed again/);

  // The fix is a round like any other, so it is committed like any other.
  assert.equal(commits(state)[0], 'vibe: address carried review findings (final round)');
  // Once before the review, once after the fix. The second run is the whole
  // reason the loop continues rather than breaking out of the tolerated branch.
  assert.equal(verifyRuns(state), 2);
  assert.equal(state.pendingFindings, null);
});

test('a final fix that breaks the suite stops the run rather than finishing it', async () => {
  // The gate passes before the review and fails on the run that follows the
  // final fix. The tolerance ends the *argument* with the reviewer; it is not a
  // licence to finish over a suite that no longer passes, and `verifyRounds`
  // has its own cap so this cannot grind either.
  const state = reviewingRun({ ...RUN, commit: true });
  const calls: string[] = [];

  await assert.rejects(() =>
    orchestrate(
      state,
      config(
        { maxVerifyRounds: 1 },
        { ...committing(), ...verifying(state, { failRuns: [2] }) },
      ),
      true,
      agents(
        {
          claude: (label) => work(state, `${label}.txt`),
          codex: () => report([p1('tolerated-one')]),
        },
        calls,
      ),
    ),
  );

  assert.deepEqual(calls, ['review-0', 'final-fix-1']);
  assert.equal(state.finalFixDone, true);
  // Resumable, not done: the run stopped at the gate rather than reporting
  // success over a failing suite.
  assert.notEqual(state.phase, 'complete');
  assert.notEqual(state.status, 'done');
});
