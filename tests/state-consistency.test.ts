import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStoredConsistency } from '@src/consistency.js';
import type { ConsistencyFields, PhaseNormalisation } from '@src/consistency.js';
import { resumePhase } from '@src/run.js';
import { StoredStateError } from '@src/stored.js';
import type { RunPhase, RunState, RunStatus } from '@src/types.js';

/**
 * The cross-field rules over `status`, `phase` and `planOnly` (#54).
 *
 * `tests/stored-state.test.ts` pins what the per-field validator decides; this
 * file pins what the three fields say TOGETHER. The rules are derived in
 * `src/consistency.ts` from the ten writers of those fields, and the two states
 * they must NOT fire on matter as much as the three they must - a rule that
 * "repairs" a terminal status beside a completed phase re-runs a finished run,
 * which is worse than the bug being fixed.
 *
 * Everything here drives `checkStoredConsistency` directly, because nothing
 * calls it yet: the module ships as groundwork, for the reason its header gives.
 * Every case is therefore a statement about the rule rather than about a resume,
 * and the resolved phase each one is judged against is computed by the real
 * `resumePhase` - never by a reimplementation of it, which is the whole point of
 * checking the resolution rather than the stored field.
 *
 * Nothing cleans up its temp directory, for the reason `loop-harness.ts` gives:
 * `rmSync` over a directory a child process has just touched is a Windows flake
 * source in a suite that has to pass three times running.
 */

/** A state to judge, and the phase `resumePhase` makes of it. */
function stateOf(
  status: RunStatus,
  phase: RunPhase | undefined,
  planOnly: boolean,
  over: Partial<ConsistencyFields> = {},
): { state: ConsistencyFields; resolved: RunPhase } {
  const base: ConsistencyFields = { id: 'a-run', dir: 'nowhere', status, planOnly, ...over };
  const state = phase === undefined ? base : { ...base, phase };
  // The real function. `resumePhase` reads only `status` and `phase`, and the
  // cast is what lets a five-field literal stand in for a whole RunState.
  return { state, resolved: resumePhase(state as RunState) };
}

/** Judge a triple. `rawPhase` defaults to the validated phase, as a healthy state's does. */
function check(
  status: RunStatus,
  phase: RunPhase | undefined,
  planOnly: boolean,
  rawPhase?: unknown,
): PhaseNormalisation | null {
  const { state, resolved } = stateOf(status, phase, planOnly);
  return checkStoredConsistency(state, resolved, rawPhase === undefined ? phase : rawPhase);
}

/** A triple that must be refused, returning the message so a case can read it. */
function refusal(
  status: RunStatus,
  phase: RunPhase | undefined,
  planOnly: boolean,
  rawPhase?: unknown,
  dir = 'nowhere',
): string {
  const { state, resolved } = stateOf(status, phase, planOnly, { dir });
  let message = '';
  assert.throws(
    () => checkStoredConsistency(state, resolved, rawPhase === undefined ? phase : rawPhase),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError, 'refused with the stored-state error type');
      message = err.message;
      return true;
    },
  );
  return message;
}

// ---- rule B: the issue's own case ------------------------------------------

test('a full run wearing a plan-only status is sent back to planning', () => {
  // The state the issue opens with. `resumePhase` maps status 'planned' to
  // 'complete' REGARDLESS of planOnly, so left alone this run reports success
  // without having implemented anything.
  const verdict = check('planned', 'complete', false);

  assert.equal(verdict?.rule, 'B');
  assert.equal(verdict?.phase, 'planning', 'toward redoing work, never toward skipping it');
  assert.equal(verdict?.storedPhase, 'complete');
  assert.equal(verdict?.resolvedPhase, 'complete');
  assert.equal(verdict?.status, 'planned', 'the status is the record of how it ended - untouched');
  assert.equal(verdict?.planOnly, false, 'planOnly is never rewritten either');
  assert.match(String(verdict?.why), /plan-only/);
});

// ---- rule A: refuses, and says what would have happened --------------------

test('a plan-only run parked at an implementing phase is refused', () => {
  // The WORK_PHASES arm: the stored phase is the thing a plan-only run can
  // never hold, and `resumePhase` returns it because it is present.
  const message = refusal('planning', 'implementing', true);

  assert.match(message, /planOnly is true/);
  assert.match(message, /status is "planning"/);
  assert.match(message, /phase is "implementing"/);
  assert.match(message, /would have started at the implementing phase/);
  assert.match(message, /no file has been rewritten/);
});

test('the refusal names the phase the resume would really have started at', () => {
  // The WORK_STATUSES arm, and the regression guard for a message built from
  // `status` instead of the resolved phase. `resumePhase` returns the STORED
  // phase whenever it is present, so this run would have restarted at planning
  // - saying "implementing" would describe something that was not about to
  // happen.
  const message = refusal('implementing', 'planning', true);

  assert.match(message, /status is "implementing"/);
  assert.match(message, /phase is "planning"/);
  assert.match(message, /would have started at the planning phase/);
  assert.doesNotMatch(
    message,
    /would have started at the implementing phase/,
    'the message must not restate the status as the resume phase',
  );
});

test('the refusal describes the stored phase, not the validated projection', () => {
  // What `loadRun` would hand over for a state.json holding `"phase": "banana"`:
  // `validateStoredState` turns an unrecognised phase into ABSENCE plus a
  // PENDING repair, and on the refusal path that repair is discarded unwritten -
  // so the file still says banana while the checked state says nothing. A
  // message that reported the projection would hide the one field that is
  // visibly wrong.
  const message = refusal('done', undefined, true, 'banana');

  assert.match(message, /status is "done"/);
  assert.match(message, /would have started at the complete phase/);
  assert.match(message, /banana/, 'the malformed field is named, not reported as missing');
  assert.doesNotMatch(
    message,
    /phase is not recorded/,
    'state.json still holds the value, so it is not "not recorded"',
  );
});

test('an absent phase reads as absent, and only then', () => {
  const message = refusal('reviewing', undefined, true);

  assert.match(message, /phase is not recorded/);
  assert.match(message, /would have started at the reviewing phase/);
});

test('a refusal writes nothing at all', () => {
  // The claim the message makes about the run directory, made executable. The
  // module imports no filesystem API, so this can only pass - which is the
  // point: it fails the day someone adds one.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-consistency-'));
  refusal('implementing', 'planning', true, undefined, dir);
  assert.deepEqual(readdirSync(dir), [], 'the refusal created nothing');
});

// ---- the two states that look wrong and are not ----------------------------

test('a completed run whose preflight later failed is left alone', () => {
  // The refutation the issue records. `execute` runs preflight before the loop
  // and a failed one sets status 'error' without touching the phase, so this
  // pair is writer-generated. Normalising it would make `resumePhase` infer
  // planning and re-run a finished run.
  for (const status of ['error', 'stalled', 'needs-input'] as const) {
    assert.equal(check(status, 'complete', false), null, `${status}/complete is legitimate`);
    assert.equal(check(status, 'complete', true), null, `plan-only ${status}/complete too`);
  }
  assert.equal(check('done', 'complete', false), null);
  assert.equal(check('planned', 'complete', true), null, 'what a real plan-only run leaves');
});

test('the two mid-flight disagreements are untouched', () => {
  // `advancePhase` saves immediately, so a process killed between the phase
  // write and the status write leaves exactly these. Neither may be touched.
  assert.equal(check('planning', 'implementing', false), null, 'between W3 and W4');
  assert.equal(check('implementing', 'reviewing', false), null, 'between W5 and W6');
});

// ---- what checking the RESOLVED phase buys ---------------------------------

test('the rules reach a run that stored no phase at all', () => {
  // Decision 1: a rule written against the stored field alone misses every
  // legacy run, because `resumePhase` collapses absence into a phase derived
  // from `status` and THAT is what the loop branches on.
  const verdict = check('planned', undefined, false);
  assert.equal(verdict?.rule, 'B');
  assert.equal(verdict?.storedPhase, undefined, 'nothing was stored');
  assert.equal(verdict?.resolvedPhase, 'complete', 'and this is what the loop would have read');

  // A legacy plan-only run with no phase is perfectly ordinary.
  assert.equal(check('planning', undefined, true), null);
});

// ---- the whole matrix ------------------------------------------------------

const STATUSES: readonly RunStatus[] = [
  'planning',
  'implementing',
  'reviewing',
  'planned',
  'done',
  'needs-input',
  'stalled',
  'error',
];
const PHASES: readonly (RunPhase | undefined)[] = [
  'planning',
  'implementing',
  'reviewing',
  'complete',
  undefined,
];
const WORK_PHASES = new Set<RunPhase>(['implementing', 'reviewing']);
const WORK_STATUSES = new Set<RunStatus>(['implementing', 'reviewing', 'done']);
const COMPLETION_STATUSES = new Set<RunStatus>([
  'done',
  'planned',
  'error',
  'stalled',
  'needs-input',
]);

test('every status against every phase, for both planOnly values', () => {
  for (const status of STATUSES) {
    for (const phase of PHASES) {
      for (const planOnly of [true, false]) {
        const { resolved } = stateOf(status, phase, planOnly);
        const where = `${planOnly ? 'plan-only' : 'full'} ${status}/${phase ?? 'absent'}`;

        if (planOnly && (WORK_PHASES.has(resolved) || WORK_STATUSES.has(status))) {
          assert.throws(
            () => check(status, phase, planOnly),
            (err: unknown) => err instanceof StoredStateError,
            `${where} is refused`,
          );
          continue;
        }

        const expected =
          !planOnly && status === 'planned'
            ? 'B'
            : resolved === 'complete' && !COMPLETION_STATUSES.has(status)
              ? 'C'
              : null;
        const verdict = check(status, phase, planOnly);
        assert.equal(verdict?.rule ?? null, expected, `${where} verdict`);
        if (verdict !== null) {
          assert.equal(verdict.phase, 'planning', `${where} normalises toward redoing work`);
          assert.equal(verdict.status, status, `${where} does not touch status`);
          assert.equal(verdict.planOnly, planOnly, `${where} does not touch planOnly`);
        }
      }
    }
  }
});

test('a terminal status is accepted beside every phase unless the run is plan-only', () => {
  // F5 as its own case: W8 and W9 never touch `phase`, so any pairing is
  // legitimate. The only exception is Rule A's `done`, which no plan-only run
  // can reach.
  for (const status of ['error', 'stalled', 'needs-input', 'done', 'planned'] as const) {
    for (const phase of PHASES) {
      const { resolved } = stateOf(status, phase, true);
      const where = `plan-only ${status}/${phase ?? 'absent'}`;
      if (status === 'done' || WORK_PHASES.has(resolved)) {
        assert.throws(
          () => check(status, phase, true),
          (err: unknown) => err instanceof StoredStateError,
          `${where} is Rule A`,
        );
      } else {
        assert.equal(check(status, phase, true), null, `${where} is fine`);
      }
    }
  }
});

// ---- the real states on record ---------------------------------------------

const FIXTURES = [
  'oldest-planning',
  'stalled-planning',
  'done-pendingfindings-null',
  'done-widest',
] as const;

test('no state file this repo has ever written is contradictory', () => {
  // The canary. These four are unmodified `state.json` files from real runs, and
  // a rule that fires on one of them is wrong by construction.
  for (const name of FIXTURES) {
    const file = fileURLToPath(new URL(`../../tests/fixtures/state/${name}.json`, import.meta.url));
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const status = stored['status'] as RunStatus;
    const phase = stored['phase'] as RunPhase | undefined;
    const planOnly = stored['planOnly'] as boolean;

    assert.equal(
      check(status, phase, planOnly),
      null,
      `${name} (${status}/${phase ?? 'absent'}, planOnly ${planOnly}) needs no normalisation`,
    );
  }
});

// ---- what happens the SECOND time a state is judged ------------------------

test('rule B still matches once its phase has been corrected; rule C does not', () => {
  // The asymmetry a caller has to know about, because it decides whether an
  // event may be recorded unconditionally.
  //
  // Rule B's predicate reads `status`, which is deliberately never rewritten, so
  // it matches for the life of the run - a caller that recorded an event every
  // time would append a duplicate on every resume.
  assert.equal(check('planned', 'complete', false)?.rule, 'B');
  assert.equal(check('planned', 'planning', false)?.rule, 'B', 'still contradictory afterwards');

  // Rule C needs `resolved === 'complete'`, and the phase it writes makes that
  // false for every status it fires on. It is a true one-time correction.
  for (const status of ['planning', 'implementing', 'reviewing'] as const) {
    assert.equal(check(status, 'complete', false)?.rule, 'C', `${status}/complete is Rule C`);
    assert.equal(check(status, 'planning', false), null, `${status} is settled afterwards`);
  }
});
