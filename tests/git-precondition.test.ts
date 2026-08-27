import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute, REAL_GATE, runPreflight } from '@src/cli.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import { gitPrecondition, repoRequiredBy } from '@src/preflight.js';
import type { AgentPreflight, PreflightProbes } from '@src/preflight.js';
import { createRun, saveState } from '@src/run.js';
import type { Phase } from '@src/runtime.js';
import type { RunState } from '@src/types.js';
import { agents, config, initGit, reviewingRun, work } from './helpers/loop-harness.js';

/**
 * A run that cannot review is refused before it buys anything (#71).
 *
 * The defect: `prepareGit` and `maybeCommit` both guard on `git.isRepo` and
 * degrade quietly, but `runReview` called `git.diffChunks` straight away. So
 * preflight warned "Not a git repository - running without branch isolation or
 * commits", the run continued, and it died at the last phase - 30,277,210
 * tokens and 70.7 minutes in, with the plan converged, the implementation
 * written and the verification gate passed three times. Outside a repository
 * `git diff` falls back to `--no-index`, which has no `--cached`, so the run's
 * dying words were a git usage message about a flag vibe passed.
 *
 * Two gates are pinned here, and they are not the same gate. The precondition
 * in `runPreflight` is the decision, made before a token is spent and not
 * skippable by `--skip-probe`. The throw in `runReview` is the backstop for
 * what that gate cannot see: a resume, a hand-edited state, or a repository
 * that stopped being one mid-run.
 *
 * Nothing here spawns an agent: `runPreflight` takes injected probes, `execute`
 * takes an injected gate and loop, and the review cases run the real loop with
 * the harness's fake turns.
 */

const FULL: readonly Phase[] = ['plan', 'implement', 'review'];

/** A directory that is not a repository, and has none above it - see `plainDir`. */
function plainDir(): string {
  // `mkdtemp` under the OS temp directory, which is where every other suite
  // puts its fixtures and is not inside this repo's working tree. If it were,
  // `rev-parse --git-dir` would resolve to *this* repository and the case would
  // pass for the wrong reason.
  return mkdtempSync(path.join(tmpdir(), 'vibe-nogit-'));
}

function runIn(dir: string, task: string, planOnly: boolean): RunState {
  return createRun(dir, task, planOnly);
}

function ok(): AgentPreflight {
  return { runtime: null, violations: [], prepared: null, probeError: null };
}

/** Probes that record whether they were reached, so "nothing ran" is observable. */
function countingProbes(): { probes: PreflightProbes; calls: () => number } {
  let calls = 0;
  return {
    probes: {
      claude: () => {
        calls += 1;
        return Promise.resolve(ok());
      },
      codex: () => {
        calls += 1;
        return Promise.resolve(ok());
      },
    },
    calls: () => calls,
  };
}

/** Both streams: `log.fail` writes to stderr, and the refusal under test is a fail. */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    return { result: await work(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// ---- the precondition itself -----------------------------------------------

test('a plain directory cannot host a review phase, and the reason says what to do', async () => {
  const dir = plainDir();

  const blocked = await gitPrecondition(dir, FULL);

  assert.notEqual(blocked, null);
  const said = String(blocked);
  assert.match(said, /not a git repository/);
  assert.match(said, /review phase/);
  assert.match(said, /git init/);
  assert.ok(said.includes(dir), 'the directory is named, so the user knows which one');
  // The remedy must never be the flag: it does not skip this check, and if it
  // did the run would still die at the review phase.
  assert.doesNotMatch(said, /--skip-probe/);
});

test('a plan-only run is not refused: nothing it does needs a repository', async () => {
  assert.equal(await gitPrecondition(plainDir(), ['plan']), null);
});

test('a repository with no commits is not refused', async () => {
  // The measurement this pins (2026-08-27, #71): `git init` with nothing
  // committed reviews FINE, because `diffSince`'s null-base path does `add -A`
  // then `diff --cached`. A check that demanded `hasCommits` would refuse a
  // working case, which is why the condition is `isRepo`.
  const dir = plainDir();
  initGit(dir);

  assert.equal(await gitPrecondition(dir, FULL), null);
});

test('an ordinary repository with a commit is not refused', async () => {
  const dir = plainDir();
  initGit(dir, { commit: true });

  assert.equal(await gitPrecondition(dir, FULL), null);
});

test('only the review phase requires a repository', () => {
  // `plan` needs nothing from git, and `implement` degrades honestly:
  // `markBase` returns null through `hasCommits`, and `maybeCommit` answers
  // `not-a-repo`. Widening this to those phases would refuse `vibe plan`.
  assert.equal(repoRequiredBy(['plan']), false);
  assert.equal(repoRequiredBy(['plan', 'implement']), false);
  assert.equal(repoRequiredBy(['review']), true);
  assert.equal(repoRequiredBy(FULL), true);
});

// ---- the gate, before anything is spent ------------------------------------

test('preflight refuses a full run in a plain directory, before either probe', async () => {
  const state = runIn(plainDir(), 'refused', false);
  const { probes, calls } = countingProbes();

  const { result: code, lines } = await captureLog(() =>
    runPreflight(state, config(), probes),
  );

  assert.equal(code, EXIT.PREFLIGHT);
  assert.equal(calls(), 0, 'a refusal that probed anything is a refusal that cost something');
  assert.equal(state.tokensUsed, 0);
  assert.equal(state.costUsd, 0);
  assert.equal(state.status, 'error');
  assert.equal(state.events.filter((e) => e.type === 'preflight-failed').length, 1);
  const said = lines.join('\n');
  assert.match(said, /not a git repository/);
  assert.match(said, /git init/);
  assert.doesNotMatch(said, /--skip-probe/);
});

test('--skip-probe does not skip the precondition', async () => {
  // The flag is documented as skipping the *agent environment* preflight. This
  // check is neither an agent nor a probe: it is deterministic, free, and there
  // is no configuration in which refusing is wrong.
  const state = runIn(plainDir(), 'refused anyway', false);
  const { probes, calls } = countingProbes();

  const code = await captureLog(() => runPreflight(state, config(), probes, { skipProbe: true }));

  assert.equal(code.result, EXIT.PREFLIGHT);
  assert.equal(calls(), 0);
  assert.equal(state.tokensUsed, 0);
});

test('a plan-only run in the same directory still passes the gate', async () => {
  const dir = plainDir();

  const probed = countingProbes();
  const withProbes = await captureLog(() =>
    runPreflight(runIn(dir, 'plan only', true), config(), probed.probes),
  );
  assert.equal(withProbes.result, null, 'vibe plan is untouched by this change');
  assert.equal(probed.calls(), 2, 'and is still probed exactly as before');

  const skipped = countingProbes();
  const withoutProbes = await captureLog(() =>
    runPreflight(runIn(dir, 'plan only skipped', true), config(), skipped.probes, {
      skipProbe: true,
    }),
  );
  assert.equal(withoutProbes.result, null);
  assert.equal(skipped.calls(), 0);
});

test('a greenfield repository passes the gate for a full run', async () => {
  const dir = plainDir();
  initGit(dir);
  const { probes, calls } = countingProbes();

  const { result: code } = await captureLog(() =>
    runPreflight(runIn(dir, 'greenfield', false), config(), probes),
  );

  assert.equal(code, null);
  assert.equal(calls(), 2);
});

test('the run exits 6 with nothing spent and no turn dispatched', async () => {
  // The whole path, through the real gate: `--skip-probe` is set, so nothing
  // here can reach a real probe even by mistake - the precondition returns
  // before `REAL_PROBES` is consulted.
  const state = runIn(plainDir(), 'end to end', false);
  let looped = false;

  const { result: code } = await captureLog(() =>
    execute(state, config(), false, true, REAL_GATE, () => {
      looped = true;
      return Promise.resolve();
    }),
  );

  assert.equal(code, EXIT.PREFLIGHT);
  assert.equal(looped, false, 'refused before the first agent turn is dispatched');
  assert.equal(state.tokensUsed, 0);
  assert.equal(state.costUsd, 0);
});

test('a finished run is not refused: it has no phase ahead to need a repository', async () => {
  // The gate asks about the phases *ahead*, not the phases the run has. A run
  // that already completed dispatches none - `runPhases` returns on
  // `resumePhase(state) === 'complete'` before any phase runs - so refusing it
  // for want of a repository would stop a resume that was never going to review
  // anything. Found in review round 1 of #71.
  const state = runIn(plainDir(), 'already finished', false);
  state.status = 'done';
  state.phase = 'complete';
  saveState(state);
  const calls: string[] = [];

  const { result: code } = await captureLog(() =>
    execute(state, config(), true, true, REAL_GATE, (s, c, r) =>
      orchestrate(s, c, r, agents({}, calls)),
    ),
  );

  assert.equal(code, EXIT.OK);
  assert.deepEqual(calls, [], 'and it still dispatched nothing');
});

test('a run still short of the review phase is refused, finished or not', async () => {
  // The other side of the exemption above: narrowing it to "complete" must not
  // let a run that has an implementation still to review through.
  for (const phase of ['planning', 'implementing', 'reviewing'] as const) {
    const state = runIn(plainDir(), `parked at ${phase}`, false);
    state.phase = phase;
    saveState(state);

    const { result: code } = await captureLog(() =>
      runPreflight(state, config(), countingProbes().probes, { skipProbe: true }),
    );

    assert.equal(code, EXIT.PREFLIGHT, `a run parked at ${phase} still needs a repository`);
  }
});

// ---- the backstop, for what the gate cannot see -----------------------------

test('a review phase in a directory that is not a repository names that fact', async () => {
  // Reachable past the gate by a resume, a hand-edited state, or a repository
  // that disappeared mid-run. What must not happen is the failure the issue
  // reported: `error: unknown option 'cached'`.
  const state = reviewingRun({ prefix: 'vibe-nogit-review-', task: 'gone', git: false });
  const calls: string[] = [];

  await assert.rejects(
    () => orchestrate(state, config(), true, agents({}, calls)),
    (err: unknown) => {
      assert.ok(err instanceof Escalation, 'a refusal, not a git usage error');
      assert.equal(err.code, EXIT.PREFLIGHT);
      assert.match(err.message, /not a git repository/);
      assert.match(err.message, /review phase/);
      assert.doesNotMatch(err.message, /unknown option/);
      return true;
    },
  );
  assert.deepEqual(calls, [], 'and no reviewer turn was bought first');
});

test('the same loop reviews a greenfield repository to completion', async () => {
  // The control for the case above, and for the gate: with a repository - even
  // one with no commits - the review round runs exactly as it always has.
  const state = reviewingRun({ prefix: 'vibe-greenfield-review-', task: 'greenfield' });
  const calls: string[] = [];
  work(state, 'reviewed.txt', 'a line to review\n');

  await orchestrate(state, config(), true, agents({}, calls));

  assert.deepEqual(calls, ['review-0']);
  assert.equal(state.reviewCoverage?.files.includes('reviewed.txt'), true);
});
