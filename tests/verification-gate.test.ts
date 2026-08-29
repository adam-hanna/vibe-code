import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import {
  agents,
  committing,
  config,
  gateScript,
  report,
  reviewingRun,
  unlaunchableVerify,
  verifying,
  verifyRuns,
  work,
} from './helpers/loop-harness.js';
import type { Config, RunState } from '@src/types.js';

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

// ---- what the failing command produced (#62) -------------------------------

/**
 * A config whose one gate names what it produces.
 *
 * Artifacts are a per-gate key, so these cases need a gate LIST where the rest
 * of this file drives the anonymous legacy command. That is the only reason the
 * shape differs; everything else about the loop is the same.
 */
function artifactGate(
  state: RunState,
  options: { failures?: number; maxBytes?: number | null } = {},
): Partial<Config> {
  const command = gateScript(state, 'qa', {
    ...(options.failures === undefined ? {} : { failures: options.failures }),
    produces: 'playwright-report',
  });
  return {
    verify: {
      ...DEFAULTS.verify,
      enabled: true,
      command: null,
      runs: 1,
      timeoutMs: 30_000,
      artifactMaxBytes: options.maxBytes ?? null,
      gates: [{ name: 'qa', command, artifacts: ['playwright-report'] }],
    },
  };
}

const artifactsAt = (state: RunState, round: number): string =>
  path.join(state.dir, 'artifacts', 'qa', `round-${round}`);

test('a failing gate leaves what it produced under the round that answers it', async () => {
  const state = reviewingRun({ ...RUN, commit: true });
  const calls: string[] = [];

  await orchestrate(
    state,
    config({ maxVerifyRounds: 3 }, { ...artifactGate(state, { failures: 1 }), ...committing() }),
    true,
    agents({ claude: (label) => work(state, `${label}.txt`), codex: () => report([]) }, calls),
  );

  // Round 1's evidence, from round 1's execution - not the passing round's,
  // which rewrote the same directory in the project tree afterwards. That
  // rewriting is exactly why the path could not simply be recorded.
  assert.equal(readFileSync(path.join(artifactsAt(state, 1), 'playwright-report', 'report.txt'), 'utf8'), 'run 1');

  // The event, not `state.gateOutcomes`: that field is RESET on every runGate
  // call and describes the most recent pass, so the passing round above has
  // already replaced the failing round's record (#47). The event is the part of
  // the history that survives, and it carries the same record.
  const event = state.events.find((e) => e.type === 'gate_artifacts');
  assert.ok(event !== undefined);
  // `stageEvent` spreads the payload onto the event itself, so these are the
  // event's own keys rather than a nested record.
  assert.equal(event['dir'], 'artifacts/qa/round-1');
  assert.equal(event['round'], 1);
  const entries = event['entries'] as { status: string }[];
  assert.equal(entries[0]?.status, 'copied');
  assert.ok((event['bytes'] as number) > 0);

  // `.vibe` ignores itself, so none of this can reach the round's commit -
  // which is what makes a destination inside the user's repo acceptable at all.
  const status = execFileSync('git', ['status', '--short'], {
    cwd: state.targetDir,
    encoding: 'utf8',
  });
  assert.equal(/\.vibe/.test(status), false);
  const tracked = execFileSync('git', ['ls-files', '--', '.vibe'], {
    cwd: state.targetDir,
    encoding: 'utf8',
  });
  assert.equal(tracked.trim(), '');
});

test('each failing round keeps its own evidence, and a later pass deletes none of it', async () => {
  const state = reviewingRun({ ...RUN, commit: true });
  const calls: string[] = [];

  await orchestrate(
    state,
    config({ maxVerifyRounds: 3 }, artifactGate(state, { failures: 2 })),
    true,
    agents({ claude: (label) => work(state, `${label}.txt`), codex: () => report([]) }, calls),
  );

  assert.deepEqual(calls, ['verify-fix-1', 'verify-fix-2', 'review-0']);
  // Per round rather than overwriting: a run that failed the gate twice keeps
  // two pieces of evidence, and each holds the execution that produced it.
  assert.equal(readFileSync(path.join(artifactsAt(state, 1), 'playwright-report', 'report.txt'), 'utf8'), 'run 1');
  assert.equal(readFileSync(path.join(artifactsAt(state, 2), 'playwright-report', 'report.txt'), 'utf8'), 'run 2');
  // The third execution passed. A passing gate preserves nothing, and it must
  // not tidy away what the failing ones left.
  assert.equal(existsSync(artifactsAt(state, 3)), false);
});

test('the gate outcome carries its artifacts while the failure is the current one', async () => {
  const state = reviewingRun({ ...RUN, commit: true });

  // A gate that never passes, so the last runGate call is the failing one and
  // `state.gateOutcomes` still describes it when the run stops.
  await assert.rejects(
    () =>
      orchestrate(
        state,
        config({ maxVerifyRounds: 1 }, artifactGate(state, { failures: 99 })),
        true,
        agents({ claude: (label) => work(state, `${label}.txt`), codex: () => report([]) }, []),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.NO_CONVERGENCE,
  );

  const outcome = state.gateOutcomes?.[0];
  assert.equal(outcome?.status, 'failed');
  assert.equal(outcome?.artifacts?.dir, 'artifacts/qa/round-1');
  assert.equal(outcome?.artifacts?.entries[0]?.status, 'copied');
  assert.ok((outcome?.artifacts?.bytes ?? 0) > 0);
});

test('a gate that only ever passes leaves no artifacts directory at all', async () => {
  const state = reviewingRun({ ...RUN, commit: true });

  await orchestrate(
    state,
    config({}, artifactGate(state)),
    true,
    agents({ codex: () => report([]) }, []),
  );

  // Absence, not an empty record: a passing report is evidence nothing
  // consumes, and "always" would turn every green run into a copy.
  assert.equal(existsSync(path.join(state.dir, 'artifacts', 'qa')), false);
  assert.equal(state.gateOutcomes?.[0]?.artifacts, undefined);
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
