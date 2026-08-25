import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { EXIT, orchestrate } from '@src/orchestrator.js';
import { saveState, unverifiedGates } from '@src/run.js';
import {
  agents,
  config,
  freshRun,
  gateScript,
  p1,
  planFixture,
  report,
  reviewingRun,
} from './helpers/loop-harness.js';
import type { AgentTurns } from '@src/orchestrator.js';
import type { Config, RunState, VerifyGate } from '@src/types.js';

/**
 * What the end of a run SAYS and RETURNS when a gate did not run.
 *
 * Driven through `execute`, not `orchestrate`: the exit code and the `Done`
 * block are the two contracts a user actually consumes - one for a wrapper
 * script, one for a human - and both live above the loop. `execute` already
 * takes an injected preflight gate and loop (src/cli.ts), so the real loop runs
 * with fake agents and nothing is spawned.
 *
 * The rule under test throughout: a run may finish with a gate that never ran,
 * but it may not claim that verification passed while doing so.
 */

/** Console output of one run, so a case can assert on what was said. */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    return { result: await work(), lines };
  } finally {
    console.log = original;
  }
}

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

/** `execute` around the real loop, with the preflight probe skipped. */
function run(state: RunState, cfg: Config, turns: AgentTurns): Promise<number> {
  return execute(
    state,
    cfg,
    true,
    true,
    () => Promise.resolve(null),
    (s, c, r) => orchestrate(s, c, r, turns),
  );
}

const claims = (lines: readonly string[]): string[] =>
  lines.filter((l) => /verification (still )?pass|Verification passed/i.test(l));

const outstandingOf = (state: RunState): string =>
  readFileSync(path.join(state.dir, 'OUTSTANDING.md'), 'utf8');

test('a required gate with no command finishes the run and refuses exit 0', async () => {
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'unverified', commit: true });
  const calls: string[] = [];

  const { result: code, lines } = await captureLog(() =>
    run(
      state,
      config({}, gated([{ name: 'test', command: null }])),
      agents({ codex: () => report([]) }, calls),
    ),
  );

  // The review is still bought: stopping at the gate would throw away work the
  // run has not yet paid for, and a resume walks back into the same missing
  // command anyway. What changes is the exit code, not the loop.
  assert.deepEqual(calls, ['review-0']);
  assert.equal(state.status, 'done');
  assert.equal(code, EXIT.UNVERIFIED);
  assert.ok(state.events.some((e) => e.type === 'verify_unavailable'));
  assert.deepEqual(unverifiedGates(state), ['test']);
  assert.deepEqual(claims(lines), []);
});

test('a legacy config that can detect nothing exits 7 rather than 0', async () => {
  // The compatibility break, stated rather than discovered: a project with no
  // `test` script and no configured command used to finish at 0 while README
  // documented 0 as "verification passes". It was not passing - it was never
  // running. The target tree here has no package.json, so detection finds
  // nothing, exactly as such a project does.
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'legacy undetected', commit: true });

  const { result: code } = await captureLog(() =>
    run(
      state,
      config({}, { verify: { ...DEFAULTS.verify, enabled: true, runs: 1, timeoutMs: 30_000 } }),
      agents({ codex: () => report([]) }, []),
    ),
  );

  assert.equal(code, EXIT.UNVERIFIED);
  assert.deepEqual(unverifiedGates(state), ['verification']);
});

test('the same gate marked optional finishes at exit 0', async () => {
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'optional gate', commit: true });

  const { result: code } = await captureLog(() =>
    run(
      state,
      config({}, gated([{ name: 'qa', command: null, required: false }])),
      agents({ codex: () => report([]) }, []),
    ),
  );

  // `required: false` says only "no command here is a decision, not a hole".
  assert.equal(code, EXIT.OK);
  assert.deepEqual(unverifiedGates(state), []);
  assert.ok(state.events.some((e) => e.type === 'verify_unavailable'));
});

test('the Done block names the gates that did not run, and what they cost', async () => {
  const required = reviewingRun({ prefix: 'vibe-exit-', task: 'report line', commit: true });
  const { lines: requiredLines } = await captureLog(() =>
    run(
      required,
      config({}, gated([{ name: 'test', command: null }, { name: 'qa', command: null, required: false }])),
      agents({ codex: () => report([]) }, []),
    ),
  );

  const line = requiredLines.find((l) => l.includes('Verification incomplete'));
  assert.ok(line !== undefined, 'the Done block said nothing about the gates that did not run');
  assert.match(line, /`test`/);
  assert.match(line, /required/);
  assert.match(line, new RegExp(`exits ${EXIT.UNVERIFIED}`));
  // Both halves, and which is which: the optional gate is named as well, and
  // said not to affect the code.
  assert.match(line, /`qa`/);
  assert.match(line, /optional/);

  // Before the summary, which is spend and rounds - the gate report belongs
  // with the other statements about what the run established.
  const reportAt = requiredLines.findIndex((l) => l.includes('Verification incomplete'));
  const summaryAt = requiredLines.findIndex((l) => l.includes('Cost'));
  assert.ok(summaryAt === -1 || reportAt < summaryAt);

  const optional = reviewingRun({ prefix: 'vibe-exit-', task: 'optional only', commit: true });
  const { result: code, lines: optionalLines } = await captureLog(() =>
    run(
      optional,
      config({}, gated([{ name: 'qa', command: null, required: false }])),
      agents({ codex: () => report([]) }, []),
    ),
  );
  const optionalLine = optionalLines.find((l) => l.includes('Verification incomplete'));
  assert.equal(code, EXIT.OK);
  assert.ok(optionalLine !== undefined);
  assert.match(optionalLine, /does not affect the exit code/);
  assert.doesNotMatch(optionalLine, new RegExp(`exits ${EXIT.UNVERIFIED}`));
});

test('a run whose gates all passed says nothing about gates at all', async () => {
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'all passed', commit: true });
  const { result: code, lines } = await captureLog(() =>
    run(
      state,
      config({}, gated([{ name: 'test', command: gateScript(state, 'test') }])),
      agents({ codex: () => report([]) }, []),
    ),
  );

  assert.equal(code, EXIT.OK);
  assert.equal(lines.some((l) => l.includes('Verification incomplete')), false);
});

test('a disabled section is distinguishable from an unavailable gate, and exits 0', async () => {
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'disabled', commit: true });

  const { result: code, lines } = await captureLog(() =>
    run(state, config(), agents({ codex: () => report([]) }, [])),
  );

  assert.equal(code, EXIT.OK);
  assert.ok(state.events.some((e) => e.type === 'verify_disabled'));
  // Before #47 the disabled path recorded nothing, which was indistinguishable
  // from a gate that never ran. Both facts are now on the record, and only one
  // of them costs the exit code.
  assert.equal(state.events.some((e) => e.type === 'verify_unavailable'), false);
  assert.deepEqual((state.gateOutcomes ?? []).map((o) => o.status), ['disabled']);
  assert.equal(lines.some((l) => l.includes('Verification incomplete')), false);
});

test('a plan-only run exits 0 with no gate outcomes at all', async () => {
  const state = freshRun({ prefix: 'vibe-exit-', task: 'plan only', planOnly: true, git: true });

  const { result: code, lines } = await captureLog(() =>
    run(
      state,
      config({}, gated([{ name: 'test', command: null }])),
      // The planner has to return a parseable plan: this run goes through the
      // plan phase for real, and stops before implementation.
      agents({ claude: () => planFixture(), codex: () => report([]) }, []),
    ),
  );

  // No gate ran, so nothing is unverified: `vibe plan` stops before the loop
  // ever reaches one, and absent is not the same as "there were none".
  assert.equal(code, EXIT.OK);
  assert.equal(state.gateOutcomes, undefined);
  assert.equal(lines.some((l) => l.includes('Verification incomplete')), false);
});

// ---- the carried-P1 artifact -----------------------------------------------

/** A review that carries exactly one P1, which is inside the default tolerance. */
function carrying(): AgentTurns & { calls: string[] } {
  const calls: string[] = [];
  const turns = agents(
    {
      claude: (label) => `did ${label}`,
      codex: (() => {
        let asked = 0;
        return (): unknown => {
          asked += 1;
          return asked === 1 ? report([p1('tolerated-one')]) : report([]);
        };
      })(),
    },
    calls,
  );
  return { ...turns, calls };
}

test('a carried P1 beside a required-unavailable gate claims nothing about a pass', async () => {
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'carried + unavailable', commit: true });
  const turns = carrying();

  const { result: code, lines } = await captureLog(() =>
    run(state, config({}, gated([{ name: 'test', command: null }])), turns),
  );

  assert.equal(code, EXIT.UNVERIFIED);
  const doc = outstandingOf(state);
  assert.match(doc, /tolerated-one/);
  // The tolerance sentence is untouched; only the clause about the gate moves.
  assert.match(doc, /not reviewed again/);
  assert.doesNotMatch(doc, /verification still passed/);
  assert.match(doc, /required gate\(s\) `test` could not run/);
  // And the pre-gate wording is gone: the gate has run by the time the run ends.
  assert.doesNotMatch(doc, /has not run yet/);
  assert.deepEqual(claims(lines), []);

  // The gate is not smuggled in as a finding: this artifact is the carried-P1
  // record, and nothing fixed an unavailable gate.
  const headings = [...doc.matchAll(/^## .*`([^`]+)`$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ['tolerated-one']);
});

test('a carried P1 beside an optional-unavailable gate still exits 0, and says which', async () => {
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'carried + optional', commit: true });

  const { result: code } = await captureLog(() =>
    run(state, config({}, gated([{ name: 'qa', command: null, required: false }])), carrying()),
  );

  assert.equal(code, EXIT.OK);
  const doc = outstandingOf(state);
  assert.match(doc, /every required gate passed/);
  assert.match(doc, /`qa`/);
  assert.doesNotMatch(doc, /verification still passed/);
});

test('a carried P1 with verification disabled says so rather than claiming a pass', async () => {
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'carried + disabled', commit: true });

  const { result: code } = await captureLog(() => run(state, config(), carrying()));

  assert.equal(code, EXIT.OK);
  const doc = outstandingOf(state);
  assert.match(doc, /verification is disabled/);
  assert.doesNotMatch(doc, /verification still passed/);
});

test('the artifact settles to the gate outcome once the gate has run', async () => {
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'settled', commit: true });
  const command = gateScript(state, 'test');

  const { result: code } = await captureLog(() =>
    run(state, config({}, gated([{ name: 'test', command }])), carrying()),
  );

  assert.equal(code, EXIT.OK);
  const doc = outstandingOf(state);
  // Written before the gate, rewritten after it: the file a user reads states
  // the outcome, not the moment it was first published.
  assert.match(doc, /verification still passed/);
  assert.doesNotMatch(doc, /has not run yet/);
});

test('a run stopped at the gate leaves a record of the failure, not of a gate that never ran', async () => {
  // The pre-gate record says verification has not run - true when it is written,
  // and false the moment the gate reports. The run does not COMPLETE over a
  // failing gate, but it stops over one at `maxVerifyRounds`, so the correction
  // cannot wait for the completion branch.
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'stopped at gate', commit: true });
  // Passes before the review, fails on the run that follows the final fix - the
  // same shape `final-fix-round.test.ts` uses to stop a run at the gate.
  const command = gateScript(state, 'test', { failRuns: [2] });

  await captureLog(async () => {
    try {
      await orchestrate(
        state,
        config({ maxVerifyRounds: 1 }, gated([{ name: 'test', command }])),
        true,
        carrying(),
      );
    } catch {
      // The escalation is the point: it stops the run with the record on disk.
    }
  });

  const stopped = outstandingOf(state);
  assert.doesNotMatch(stopped, /has not run yet/);
  assert.doesNotMatch(stopped, /verification still passed/);
  assert.match(stopped, /gate\(s\) `test` did not pass/);
});

test('a resume settles a record the process that wrote it never got to settle', async () => {
  // The state a process killed between the final fix and the gate leaves behind:
  // the flags are persisted, the fix report is on disk, and OUTSTANDING.md says
  // verification has not run. Nothing in THIS process wrote that file, so a
  // memory-only marker would skip it and the run would finish clean pointing at
  // a file claiming the gate never ran.
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'resumed pending', commit: true });
  const command = gateScript(state, 'test');
  const cfg = config({}, gated([{ name: 'test', command }]));

  // Produced by the loop, then rewound to exactly what a kill between the
  // pending write and the gate leaves behind: the pre-gate text, no gate
  // outcomes, and a run still parked in the review phase.
  await captureLog(() => run(state, cfg, carrying()));
  writeFileSync(
    path.join(state.dir, 'OUTSTANDING.md'),
    outstandingOf(state).replace(
      /A final fix round addressed them and verification still passed/,
      'A final fix round addressed them. **Verification has not run yet at the time of writing**',
    ),
    'utf8',
  );
  delete state.gateOutcomes;
  state.phase = 'reviewing';
  state.status = 'reviewing';
  saveState(state);
  assert.match(outstandingOf(state), /has not run yet/);

  const { result: code } = await captureLog(() => run(state, cfg, carrying()));

  assert.equal(code, EXIT.OK);
  const settled = outstandingOf(state);
  assert.doesNotMatch(settled, /has not run yet/);
  assert.match(settled, /verification still passed/);
  assert.match(settled, /tolerated-one/);
});

test('a record that already settled to a failure settles again when the fix lands', async () => {
  // The document settles more than once - stopped-at-a-failing-gate, then passed
  // after the fix - which is why the marker in it says "vibe owns this file"
  // rather than "this file is pending". A marker consumed by the first rewrite
  // would freeze the record at the failure it has since moved past.
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'settles twice', commit: true });
  const command = gateScript(state, 'test', { failRuns: [2] });

  await captureLog(async () => {
    try {
      await orchestrate(
        state,
        config({ maxVerifyRounds: 1 }, gated([{ name: 'test', command }])),
        true,
        carrying(),
      );
    } catch {
      // Stopped at the cap, with the failure on the record.
    }
  });
  assert.match(outstandingOf(state), /did not pass/);

  const { result: code } = await captureLog(() =>
    run(state, config({}, gated([{ name: 'test', command }])), carrying()),
  );

  assert.equal(code, EXIT.OK);
  const settled = outstandingOf(state);
  assert.match(settled, /verification still passed/);
  assert.doesNotMatch(settled, /did not pass/);
});

test('a settled record moves to an unavailable gate rather than staying at a pass', async () => {
  const state = reviewingRun({ prefix: 'vibe-exit-', task: 'resumed unavailable', commit: true });
  const command = gateScript(state, 'test');

  await captureLog(() => run(state, config({}, gated([{ name: 'test', command }])), carrying()));
  assert.match(outstandingOf(state), /verification still passed/);

  // Parked back at the review phase, as a resume of an unfinished run is, and
  // pointed at a config whose gate has lost its command: the record must follow
  // the gates rather than keep the last good thing it said.
  state.phase = 'reviewing';
  state.status = 'reviewing';
  saveState(state);
  const { result: code } = await captureLog(() =>
    run(state, config({}, gated([{ name: 'test', command: null }])), carrying()),
  );

  assert.equal(code, EXIT.UNVERIFIED);
  const settled = outstandingOf(state);
  assert.doesNotMatch(settled, /verification still passed/);
  assert.match(settled, /required gate\(s\) `test` could not run/);
});
