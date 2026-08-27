import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import {
  agents,
  config,
  gateRuns,
  gateScript,
  report,
  reviewingRun,
  verifying,
  verifyRuns,
  withTestScript,
} from './helpers/loop-harness.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { Config, RunState, VerifyGate } from '@src/types.js';

/**
 * The gate LIST, driven through the real loop.
 *
 * `verification-gate.test.ts` covers the single anonymous command and is left
 * exactly as it was - that config is still legal and still behaves identically,
 * which is what case 5 here asserts from the other side. What is new is
 * everything a list can express and one command could not: order, a failure that
 * stops the sequence, an unavailable gate that does not, and a finding id per
 * gate so the oscillation guard can tell two failing checks apart (#47).
 *
 * The commands are real, as in the file this one sits beside: one `.mjs` script
 * per gate, run by `src/verify.ts` exactly as a project's own would be.
 */

const RUN = { prefix: 'vibe-gates-', task: 'verification gates' } as const;

function gatesRun(): RunState {
  return reviewingRun({ ...RUN, commit: true });
}

/** A config whose gates are exactly these, with the harness's fast timings. */
function gated(gates: readonly VerifyGate[]): Partial<Config> {
  return {
    verify: {
      ...DEFAULTS.verify,
      enabled: true,
      command: null,
      runs: 1,
      timeoutMs: 30_000,
      gates: [...gates],
    },
  };
}

const statuses = (state: RunState): [string, string][] =>
  (state.gateOutcomes ?? []).map((o) => [o.name, o.status]);

test('gates run in list order, and a failure stops the sequence', async () => {
  const state = gatesRun();
  const calls: string[] = [];
  const typecheck = gateScript(state, 'typecheck', { failures: 1 });
  const suite = gateScript(state, 'test');

  await orchestrate(
    state,
    config(
      { maxVerifyRounds: 3 },
      gated([
        { name: 'typecheck', command: typecheck },
        { name: 'test', command: suite },
      ]),
    ),
    true,
    agents({ codex: () => report([]) }, calls),
  );

  // The fixer is handed one problem. Running the suite against code that does
  // not typecheck buys an opinion about the wrong thing, so `test` waits.
  assert.deepEqual(calls, ['verify-fix-1', 'review-0']);
  assert.equal(gateRuns(state, 'typecheck'), 2);
  // Once, on the pass after the fix - never during the failing pass.
  assert.equal(gateRuns(state, 'test'), 1);
});

test('an unavailable gate does not stop the sequence, and nothing is detected for it', async () => {
  const state = gatesRun();
  // A detectable `npm test` in the tree: without it, "the gate stayed
  // unavailable" would also be true of an implementation that auto-detects.
  withTestScript(state);
  const suite = gateScript(state, 'test');

  await orchestrate(
    state,
    config(
      {},
      gated([
        { name: 'typecheck', command: null },
        { name: 'test', command: suite },
      ]),
    ),
    true,
    agents({ codex: () => report([]) }, []),
  );

  const unavailable = state.events.filter((e) => e.type === 'verify_unavailable');
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0]?.['gate'], 'typecheck');
  assert.equal(gateRuns(state, 'test'), 1);
  assert.deepEqual(statuses(state), [
    ['typecheck', 'unavailable'],
    ['test', 'passed'],
  ]);
  // Null, not `npm test`: a gate nobody configured must not inherit the
  // project's test command just because there is one.
  assert.equal(state.gateOutcomes?.[0]?.command, null);
});

test('each gate files its failure under its own id', async () => {
  const state = gatesRun();
  const calls: string[] = [];
  // typecheck fails the first pass; test fails the second (its own first run).
  const typecheck = gateScript(state, 'typecheck', { failRuns: [1] });
  const suite = gateScript(state, 'test', { failRuns: [1] });

  await orchestrate(
    state,
    config(
      { maxVerifyRounds: 3 },
      gated([
        { name: 'typecheck', command: typecheck },
        { name: 'test', command: suite },
      ]),
    ),
    true,
    agents({ codex: () => report([]) }, calls),
  );

  // The point is not any particular verdict: it is that the guard can now tell
  // the two rounds apart, where one shared id made them look identical and read
  // as a fixer going in circles.
  assert.deepEqual(state.verifyRounds[0]?.ids, ['typecheck-failing']);
  assert.deepEqual(state.verifyRounds[1]?.ids, ['test-failing']);
  assert.notDeepEqual(state.verifyRounds[0]?.ids, state.verifyRounds[1]?.ids);
});

test('the fix prompt names the gate that failed', async () => {
  const state = gatesRun();
  const prompts: string[] = [];

  await orchestrate(
    state,
    config(
      { maxVerifyRounds: 3 },
      gated([{ name: 'typecheck', command: gateScript(state, 'typecheck', { failures: 1 }) }]),
    ),
    true,
    agents(
      {
        claude: (_label, options: ClaudeTurnOptions) => {
          prompts.push(options.prompt);
          return 'fixed it';
        },
        codex: () => report([]),
      },
      [],
    ),
  );

  const fix = prompts.find((p) => p.includes('does not pass'));
  assert.ok(fix !== undefined, 'the fixer was never asked to repair the gate');
  assert.match(fix, /typecheck/);
});

test('a 1.1.0 config behaves identically: one gate, and the id it always had', async () => {
  const state = gatesRun();
  const calls: string[] = [];

  await orchestrate(
    state,
    config({ maxVerifyRounds: 3 }, verifying(state, { failures: 1 })),
    true,
    agents({ codex: () => report([]) }, calls),
  );

  assert.deepEqual(calls, ['verify-fix-1', 'review-0']);
  assert.deepEqual(state.verifyRounds[0]?.ids, ['verification-failing']);
  assert.equal(existsSync(path.join(state.dir, 'verify-failure-0.txt')), true);
  assert.deepEqual(
    state.events
      .map((e) => e.type)
      .filter((t) => t === 'verify_failed' || t === 'verify_passed'),
    ['verify_failed', 'verify_passed'],
  );
  assert.deepEqual(statuses(state), [['verification', 'passed']]);
});

test('a gate whose command cannot start still escalates as a configuration error', async () => {
  const state = gatesRun();
  const calls: string[] = [];
  const first = gateScript(state, 'typecheck');

  await assert.rejects(
    () =>
      orchestrate(
        state,
        config(
          {},
          gated([
            { name: 'typecheck', command: first },
            { name: 'test', command: 'vibe-definitely-not-a-command' },
          ]),
        ),
        true,
        agents({}, calls),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.PREFLIGHT,
  );

  assert.deepEqual(calls, []);
  assert.equal(existsSync(path.join(state.dir, 'verify-unlaunchable-0.txt')), true);
  // The gate that ran is recorded; the one that could not start is not - it is
  // a configuration error, not one of the four observed states.
  assert.deepEqual(statuses(state), [['typecheck', 'passed']]);
});

test('gates behind a failure record nothing at all', async () => {
  const state = gatesRun();
  const typecheck = gateScript(state, 'typecheck', { failures: 1 });
  const suite = gateScript(state, 'test');
  const seen: [string, string][][] = [];

  await orchestrate(
    state,
    config(
      { maxVerifyRounds: 3 },
      gated([
        { name: 'typecheck', command: typecheck },
        { name: 'test', command: suite },
      ]),
    ),
    true,
    agents(
      {
        // Sampled from inside the fix turn: by then the failing pass is behind
        // us and the record is the one it left.
        claude: () => {
          seen.push(statuses(state));
          return 'fixed it';
        },
        codex: () => report([]),
      },
      [],
    ),
  );

  assert.deepEqual(seen[0], [['typecheck', 'failed']]);
  // And the pass that followed describes itself, rather than accumulating.
  assert.deepEqual(statuses(state), [
    ['typecheck', 'passed'],
    ['test', 'passed'],
  ]);
});

test('a blank gate command is unavailable, not a pass', async () => {
  const state = gatesRun();
  withTestScript(state);
  const suite = gateScript(state, 'test');

  // Built directly rather than through `applyOverrides`: validation refuses a
  // blank command, and what is under test here is the second answer - that one
  // reaching the runtime anyway is never handed to a shell, where it would exit
  // 0 and be reported as a gate that passed.
  await orchestrate(
    state,
    config(
      {},
      gated([
        { name: 'typecheck', command: '   ' },
        { name: 'test', command: suite },
      ]),
    ),
    true,
    agents({ codex: () => report([]) }, []),
  );

  assert.deepEqual(statuses(state), [
    ['typecheck', 'unavailable'],
    ['test', 'passed'],
  ]);
});

test('a blank legacy command is unavailable, and does not fall back to detection', async () => {
  const state = gatesRun();
  withTestScript(state);
  // The script `verifying()` writes exists, so a run that reached a shell at all
  // would leave a count behind.
  verifying(state);

  await orchestrate(
    state,
    config(
      {},
      {
        verify: { ...DEFAULTS.verify, enabled: true, command: '  ', runs: 1, timeoutMs: 30_000 },
      },
    ),
    true,
    agents({ codex: () => report([]) }, []),
  );

  assert.deepEqual(statuses(state), [['verification', 'unavailable']]);
  assert.equal(state.gateOutcomes?.[0]?.command, null);
  assert.equal(verifyRuns(state), 0);
  assert.ok(state.events.some((e) => e.type === 'verify_unavailable'));
});

test('the gate events carry the gate name beside everything they carried before', async () => {
  const state = gatesRun();
  const typecheck = gateScript(state, 'typecheck', { failures: 1 });

  await orchestrate(
    state,
    config({ maxVerifyRounds: 3 }, gated([{ name: 'typecheck', command: typecheck, runs: 2 }])),
    true,
    agents({ codex: () => report([]) }, []),
  );

  const failed = state.events.find((e) => e.type === 'verify_failed');
  assert.equal(failed?.['gate'], 'typecheck');
  assert.equal(failed?.['command'], typecheck);
  assert.equal(failed?.['failedRun'], 1);
  assert.equal(failed?.['exitCode'], 1);

  const passed = state.events.find((e) => e.type === 'verify_passed');
  assert.equal(passed?.['gate'], 'typecheck');
  assert.equal(passed?.['command'], typecheck);
  // The per-gate `runs` override, not `verify.runs`.
  assert.equal(passed?.['runs'], 2);
});
