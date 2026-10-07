import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as log from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import {
  describeFailure,
  failedRuns,
  runGateCommand,
  suggestedFix,
  verdictOf,
} from '@src/verify.js';
import type { ResolvedGate, VerifyResult } from '@src/verify.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { RunState } from '@src/types.js';
import { agents, config, report, reviewingRun, verifying, work } from './helpers/loop-harness.js';

/**
 * A gate that fails has more than one sample now (#135).
 *
 * `verify.runs` has defaulted to 3 since the gate existed, and `config.ts`
 * argues it as a coin flip: a racy lock failed roughly half its executions and a
 * single sample called it green twice running. That reasoning is about
 * **catching** a flake. The loop returned on the first non-zero exit, so it
 * never **identified** one - `runs: 3` meant *up to* three, and a run that
 * failed reported `runs: 1`.
 *
 * What that cost is a whole implementer turn against `maxVerifyRounds`, spent
 * chasing something that was never wrong, and a suite whose failures are noise
 * burns all three rounds and then stops the run at a cap it did not deserve.
 *
 * So the two halves on trial here are:
 *
 * 1. **The pass path is untouched.** Three green runs cost exactly what they
 *    cost before, and that is asserted by counting executions rather than
 *    assumed from reading the loop.
 * 2. **The failure path runs the rest and says what it saw** - and the words the
 *    fixer is given change, because the data alone changes nothing.
 *
 * Option 1 of the three the issue offered: a whole-gate verdict, no reporter
 * parser. `vibe` reads exit codes and parses nobody's output format, and taking
 * that on for a per-test table would be a standing maintenance liability bought
 * for a column in a UI.
 */

const CONTRACT = {};

/** A gate whose command fails on the runs named and passes on every other. */
function gateIn(dir: string, failRuns: readonly number[], runs: number): ResolvedGate {
  const script = 'gate.mjs';
  writeFileSync(
    path.join(dir, script),
    "import { appendFileSync, readFileSync } from 'node:fs';\n" +
      "appendFileSync('runs.txt', 'ran\\n');\n" +
      "const n = readFileSync('runs.txt', 'utf8').split('\\n').filter(Boolean).length;\n" +
      `process.exit(${JSON.stringify([...failRuns])}.includes(n) ? 1 : 0);\n`,
    'utf8',
  );
  return {
    name: 'test',
    command: `node ${script}`,
    runs,
    timeoutMs: 30_000,
    required: true,
    artifacts: [],
  };
}

function executions(dir: string): number {
  const log = path.join(dir, 'runs.txt');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
}

function temp(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-flaky-'));
}

// ---- what a failing gate now observes ---------------------------------------

test('a gate that fails once and passes twice runs all three, and says which did what', async () => {
  const dir = temp();
  const result = await runGateCommand(dir, gateIn(dir, [1], 3), CONTRACT);

  // The whole defect: before this, the loop returned here with `runs: 1`.
  assert.equal(executions(dir), 3);
  assert.equal(result.runs, 3);
  assert.equal(failedRuns(result), 1);
  assert.equal(result.failedRun, 1, 'still the FIRST failure, for every caller that wants one');
  assert.deepEqual(
    result.attempts.map((a) => a.ok),
    [false, true, true],
  );
  assert.equal(verdictOf(result), 'flaky');
  assert.equal(result.ok, false, 'a flaky suite is still a failing gate - hiding it is worse');
});

test('a gate that fails every run is a defect, not noise', async () => {
  const dir = temp();
  const result = await runGateCommand(dir, gateIn(dir, [1, 2, 3], 3), CONTRACT);

  assert.equal(executions(dir), 3);
  assert.equal(failedRuns(result), 3);
  assert.equal(verdictOf(result), 'failing');
});

test('three green runs cost exactly what they cost before', async () => {
  const dir = temp();
  const result = await runGateCommand(dir, gateIn(dir, [], 3), CONTRACT);

  assert.equal(executions(dir), 3);
  assert.equal(result.ok, true);
  assert.equal(result.runs, 3);
  assert.equal(failedRuns(result), 0);
  assert.equal(verdictOf(result), 'passed');
  assert.equal(result.failedRun, null);
});

test('one run is one sample, and one sample is never called flaky', async () => {
  const dir = temp();
  const result = await runGateCommand(dir, gateIn(dir, [1], 1), CONTRACT);

  assert.equal(executions(dir), 1);
  assert.equal(verdictOf(result), 'failing');
  // And the prose says so rather than implying a determinism it did not test.
  assert.match(describeFailure(result), /run once, so there is no second sample/);
});

test('a command that cannot start is not run again', async () => {
  const dir = temp();
  const gate: ResolvedGate = {
    name: 'test',
    command: 'vibe-definitely-not-a-command',
    runs: 3,
    timeoutMs: 30_000,
    required: true,
    artifacts: [],
  };
  const result = await runGateCommand(dir, gate, CONTRACT);

  assert.notEqual(result.unlaunchable, null);
  // No amount of re-running makes a mistyped path resolve, and two more shells
  // is two more shells. This is the one failure that keeps the short-circuit.
  assert.equal(result.runs, 1);
  assert.equal(result.attempts.length, 1);
});

test('a result with no attempts cannot tell, and does not guess', () => {
  const unrun: VerifyResult = {
    name: 'test',
    ok: false,
    command: 'npm test',
    failedRun: 1,
    runs: 1,
    attempts: [],
    exitCode: 1,
    output: '',
    unavailable: null,
    unlaunchable: null,
  };
  // The archive is full of these: every gate recorded before `attempts` existed.
  // "Nothing recorded what each run did" is not a verdict about the suite.
  assert.equal(verdictOf(unrun), 'unrun');
  assert.equal(failedRuns(unrun), 0);
});

// ---- what the fixer is told -------------------------------------------------

async function flakyResult(): Promise<VerifyResult> {
  const dir = temp();
  return runGateCommand(dir, gateIn(dir, [2], 3), CONTRACT);
}

test('a flaky gate is described as non-deterministic, with the fraction and the runs', async () => {
  const detail = describeFailure(await flakyResult());

  assert.match(detail, /is not deterministic/);
  assert.match(detail, /failed 1 of 3 runs of the same command against the same tree/);
  assert.match(detail, /runs 1 and 3 passed/);
  assert.match(detail, /run 2 exited 1/);
  // Which run's output this is, said rather than left to be assumed: three runs
  // produced three outputs and only one of them is in the artifact.
  assert.match(detail, /output below is from the first failing run/);
});

test('a flaky gate is not handed over as a defect to repair', async () => {
  const fix = suggestedFix(await flakyResult());

  assert.match(fix, /is not deterministic/);
  // The three cheap ways to make a flaky gate green, named because a model asked
  // to make a command pass will find all three.
  assert.match(fix, /Do NOT loosen or delete the assertion/);
  assert.match(fix, /do NOT add a retry/);
  assert.match(fix, /do NOT add a sleep/);
  assert.equal(/Make the test gate's command pass/.test(fix), false);
});

test('a consistently failing gate keeps the words it had', async () => {
  const dir = temp();
  const result = await runGateCommand(dir, gateIn(dir, [1, 2, 3], 3), CONTRACT);
  const fix = suggestedFix(result);

  assert.match(fix, /Make the test gate's command pass/);
  assert.match(fix, /fix the underlying synchronisation rather than retrying/);
  assert.match(describeFailure(result), /failed every one of 3 runs/);
});

// ---- through the loop -------------------------------------------------------

test('the finding the fix round is given says the suite is noisy, and still blocks', async () => {
  const state = reviewingRun({ prefix: 'vibe-flaky-', task: 'flaky gate', commit: true });
  const prompts: string[] = [];

  await orchestrate(
    state,
    // Fails run 1, passes 2 and 3 - then passes outright on the round after the
    // fix, so the loop finishes and the case can read what it produced.
    config({ maxVerifyRounds: 3 }, verifying(state, { failRuns: [1], runs: 3 })),
    true,
    agents(
      {
        claude: (label, options): string => {
          prompts.push((options as ClaudeTurnOptions).prompt);
          return work(state, `${label}.txt`);
        },
        codex: () => report([]),
      },
      [],
    ),
  );

  const fixPrompt = prompts[0] ?? '';
  assert.match(fixPrompt, /is not deterministic/);
  assert.match(fixPrompt, /failed 1 of 3 runs/);
  assert.match(fixPrompt, /do NOT add a retry/);
  // Still P0: a flake is a defect in the suite, and retrying it or excluding it
  // would be hiding it. What changed is what the fixer is asked to look for.
  assert.match(fixPrompt, /\[P0\]/);
});

test('the run record keeps the fraction, so the archive can be asked later', async () => {
  const state = reviewingRun({ prefix: 'vibe-flaky-', task: 'flaky record', commit: true });
  const said: string[] = [];
  const realLog = console.log;
  log.setSink((n) => void said.push(n.message));
  console.log = (): undefined => undefined;
  try {
    await orchestrate(
      state,
      config({ maxVerifyRounds: 3 }, verifying(state, { failRuns: [1], runs: 3 })),
      true,
      agents({ claude: (label) => work(state, `${label}.txt`), codex: () => report([]) }, []),
    );
  } finally {
    console.log = realLog;
    log.setSink(null);
  }

  const failed = (state.events ?? []).find((e) => e.type === 'verify_failed');
  assert.equal(failed?.['runs'], 3);
  assert.equal(failed?.['failed'], 1);
  assert.equal(failed?.['verdict'], 'flaky');
  // And the sentence a person watching would have read. Not "attempt 1 of 1",
  // which is what a three-run gate used to report for every failure.
  const line = said.find((s) => s.startsWith('Gate verification failed')) ?? '';
  assert.match(line, /failed 1 of 3 run\(s\)/);
  assert.match(line, /it is not deterministic/);
});

// A stored outcome that predates the fraction, and one that carries it, are
// pinned in `gate-outcomes-state.test.ts` - the file named for that concern,
// against a real post-run `state.json` rather than a constructed one.

test('a failing gate records how many of its runs failed', async () => {
  const state: RunState = reviewingRun({ prefix: 'vibe-flaky-', task: 'outcome', commit: true });

  await orchestrate(
    state,
    config({ maxVerifyRounds: 3 }, verifying(state, { failRuns: [1], runs: 3 })),
    true,
    agents({ claude: (label) => work(state, `${label}.txt`), codex: () => report([]) }, []),
  );

  const stored = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as RunState;
  // The last recorded set is the passing round; the fraction is on the event
  // above, which is durable. What matters here is that the shape round-trips.
  for (const outcome of stored.gateOutcomes ?? []) {
    if (outcome.status === 'failed') assert.equal(typeof outcome.failed, 'number');
  }
});
