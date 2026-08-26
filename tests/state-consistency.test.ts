import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStoredConsistency } from '@src/consistency.js';
import type { ConsistencyFields } from '@src/consistency.js';
import { orchestrate } from '@src/orchestrator.js';
import { createRun, loadRun, resumePhase } from '@src/run.js';
import { StoredStateError } from '@src/stored.js';
import type { RunPhase, RunState, RunStatus } from '@src/types.js';
import { agents, config, freshRun, planFixture, report, work } from './helpers/loop-harness.js';

/**
 * What `loadRun` does with three fields that are each legal and together
 * impossible (#54).
 *
 * `tests/stored-state.test.ts` pins what the per-field validator decides; this
 * file pins the cross-field pass that runs immediately after it. The rules are
 * derived in `src/consistency.ts` from the ten writers of `status`, `phase` and
 * `planOnly`, and the two things they must NOT fire on are as important as the
 * three they must - a rule that "repairs" a terminal status beside a completed
 * phase re-runs a finished run, which is worse than the bug being fixed.
 *
 * Nothing cleans up its temp directory, for the reason `loop-harness.ts` gives:
 * `rmSync` over a directory a child process has just touched is a Windows flake
 * source in a suite that has to pass three times running.
 */

const RUNS = path.join('.vibe', 'runs');

/** The `state_normalised` events a load recorded. */
function normalisations(state: RunState): Record<string, unknown>[] {
  return state.events.filter((e) => e.type === 'state_normalised');
}

/** The `state_repaired` events a load recorded, by field. */
function repairs(state: RunState): string[] {
  return state.events.filter((e) => e.type === 'state_repaired').map((e) => String(e['field']));
}

/**
 * Lines a load printed. `log.warn` writes through `console.log`, and cases 10
 * and 11 turn on whether a warning was emitted at all.
 *
 * The pattern `tests/failure-accounting.test.ts` already uses, kept synchronous
 * because `loadRun` is.
 */
function captureLog<T>(work_: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    return { result: work_(), lines };
  } finally {
    console.log = original;
  }
}

const NORMALISED = /holds a combination no run could have written/;

// ---- two fixture builders, and the difference matters -----------------------

/**
 * A healthy `state.json`, as a plain record, with `over` applied.
 *
 * Seeded from a real `createRun` rather than hand-written, so every per-field
 * reader is satisfied by construction and the only thing under test is the
 * relationship between the three fields. A key set to `undefined` in `over`
 * disappears from the file, which is how the absent-phase cases are built.
 */
function healthyRaw(id: string, over: Record<string, unknown>): Record<string, unknown> {
  const seed = mkdtempSync(path.join(tmpdir(), 'vibe-consistency-seed-'));
  const state = createRun(seed, 'consistency fixture', false);
  const raw = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return { ...raw, id, ...over };
}

interface Planted {
  targetDir: string;
  id: string;
  file: string;
  /** Exactly what was written, so a refusal can be shown to have changed nothing. */
  text: string;
}

/**
 * A run directory built WITHOUT `createRun`.
 *
 * This is the only builder a refusal case may use. `createRun` calls
 * `ensureVibeIgnored` (`src/run.ts`), so a run made that way already has
 * `.vibe/.gitignore` on disk - and a test that asserts the marker is absent
 * after a refusal would pass against an implementation that creates it, because
 * the file was there before the load began.
 */
function plantedState(over: Record<string, unknown>, id = 'planted-run'): Planted {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-consistency-'));
  const dir = path.join(targetDir, RUNS, id);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  const text = JSON.stringify(healthyRaw(id, over), null, 2);
  writeFileSync(file, text, 'utf8');
  assert.equal(
    existsSync(path.join(targetDir, '.vibe', '.gitignore')),
    false,
    'the fixture itself must not create the marker, or the assertion is vacuous',
  );
  return { targetDir, id, file, text };
}

/** A run made the ordinary way, then rewritten. Fine for every non-refusal case. */
function viaCreateRun(over: Record<string, unknown>): { targetDir: string; id: string } {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-consistency-ok-'));
  const state = createRun(targetDir, 'consistency fixture', false);
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...raw, ...over }, null, 2), 'utf8');
  return { targetDir, id: state.id };
}

/** Load a state built by one set of overrides. */
function load(over: Record<string, unknown>): RunState {
  const run = viaCreateRun(over);
  return loadRun(run.targetDir, run.id);
}

/** A load that must refuse, returning the message and proving nothing was written. */
function refusal(planted: Planted): string {
  let message = '';
  assert.throws(
    () => loadRun(planted.targetDir, planted.id),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError, 'refused with the stored-state error type');
      message = err.message;
      return true;
    },
  );

  assert.deepEqual(
    readdirSync(path.dirname(planted.file)),
    ['state.json'],
    'the refusal wrote nothing into the run directory',
  );
  assert.equal(
    readFileSync(planted.file, 'utf8'),
    planted.text,
    'state.json is byte-for-byte what it was',
  );
  assert.equal(
    existsSync(path.join(planted.targetDir, '.vibe', '.gitignore')),
    false,
    'no .vibe/.gitignore was created for a run vibe refused',
  );
  return message;
}

// ---- 1. the issue's own case ------------------------------------------------

test('a full run wearing a plan-only status is set back to planning, and implements', async () => {
  // The state the issue opens with. `resumePhase` maps status 'planned' to
  // 'complete' REGARDLESS of planOnly, so left alone this run reports success
  // without having implemented anything.
  const state = freshRun({
    prefix: 'vibe-consistency-loop-',
    task: 'planned but not plan-only',
    planOnly: false,
    git: true,
    commit: true,
  });
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({ ...raw, status: 'planned', phase: 'complete' }, null, 2),
    'utf8',
  );

  const loaded = loadRun(state.targetDir, state.id);
  assert.equal(loaded.phase, 'planning', 'normalised toward redoing work');
  assert.equal(loaded.status, 'planned', 'the status is the record of how it ended - untouched');
  assert.equal(loaded.planOnly, false, 'planOnly is never rewritten either');

  const events = normalisations(loaded);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.['rule'], 'B');
  assert.equal(events[0]?.['storedPhase'], 'complete');
  assert.equal(events[0]?.['resolvedPhase'], 'complete');
  assert.equal(events[0]?.['phase'], 'planning');

  const calls: string[] = [];
  await orchestrate(
    loaded,
    config(),
    true,
    agents(
      {
        claude: (label) => (label === 'plan' ? planFixture() : work(loaded, `${label}.txt`)),
        codex: () => report([]),
      },
      calls,
    ),
  );

  assert.ok(calls.includes('implement'), `the resume implemented - got ${calls.join(', ')}`);
  assert.deepEqual(calls, ['plan', 'critique-0', 'implement', 'review-0']);
});

// ---- 2-4. Rule A refuses, and writes nothing --------------------------------

test('a plan-only run parked at an implementing phase is refused', () => {
  // The WORK_PHASES arm: the stored phase is the thing a plan-only run can
  // never hold, and `resumePhase` returns it because it is present.
  const planted = plantedState({ planOnly: true, status: 'planning', phase: 'implementing' });
  const message = refusal(planted);

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
  const planted = plantedState({ planOnly: true, status: 'implementing', phase: 'planning' });
  const message = refusal(planted);

  assert.match(message, /status is "implementing"/);
  assert.match(message, /phase is "planning"/);
  assert.match(message, /would have started at the planning phase/);
  assert.doesNotMatch(
    message,
    /would have started at the implementing phase/,
    'the message must not restate the status as the resume phase',
  );
});

test('a refusal beats a repair, and says what state.json actually holds', () => {
  // Both wrong at once: the phase is not a phase this version knows, and the
  // triple is impossible. The validator turns 'banana' into ABSENCE plus a
  // pending repair, `resumePhase` then falls back to status 'done' and resolves
  // 'complete', and Rule A refuses - so the repair is discarded unwritten. The
  // message must therefore describe the file, which still says banana, rather
  // than the projection, which says nothing.
  const planted = plantedState({ planOnly: true, status: 'done', phase: 'banana' });
  const message = refusal(planted);

  assert.match(message, /status is "done"/);
  assert.match(message, /would have started at the complete phase/);
  assert.match(message, /banana/, 'the malformed field is named, not reported as missing');
  assert.doesNotMatch(
    message,
    /phase is not recorded/,
    'state.json still holds the value, so it is not "not recorded"',
  );
  assert.ok(readFileSync(planted.file, 'utf8').includes('banana'));
});

test('an absent phase reads as absent in the message, and only then', () => {
  const planted = plantedState({ planOnly: true, status: 'reviewing', phase: undefined });
  const message = refusal(planted);

  assert.match(message, /phase is not recorded/);
  assert.match(message, /would have started at the reviewing phase/);
});

// ---- 5-6. the states that look wrong and are not ----------------------------

test('a completed run that later failed preflight is left alone and stops', async () => {
  // The refutation the issue records. `execute` runs preflight before the loop
  // and a failed one sets status 'error' without touching the phase, so this
  // pair is writer-generated. Normalising it would re-run a finished run.
  const state = freshRun({
    prefix: 'vibe-consistency-done-',
    task: 'finished, then preflight failed',
    planOnly: false,
    git: true,
    commit: true,
  });
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({ ...raw, status: 'error', phase: 'complete' }, null, 2),
    'utf8',
  );

  const loaded = loadRun(state.targetDir, state.id);
  assert.equal(loaded.phase, 'complete', 'the phase is untouched');
  assert.deepEqual(normalisations(loaded), []);
  assert.deepEqual(repairs(loaded), []);

  const calls: string[] = [];
  await orchestrate(
    loaded,
    config(),
    true,
    agents({ claude: () => assert.fail('no turn should run') }, calls),
  );
  assert.deepEqual(calls, [], 'the run reported itself finished and bought nothing');
});

test('the two mid-flight disagreements load untouched', () => {
  // `advancePhase` saves immediately, so a process killed between the phase
  // write and the status write leaves exactly these. Neither may be touched.
  for (const [status, phase] of [
    ['planning', 'implementing'],
    ['implementing', 'reviewing'],
  ] as const) {
    const loaded = load({ planOnly: false, status, phase });
    assert.equal(loaded.status, status);
    assert.equal(loaded.phase, phase, `${status}/${phase} is kept`);
    assert.deepEqual(normalisations(loaded), [], `${status}/${phase} is not normalised`);
  }
});

// ---- 7. what checking the RESOLVED phase buys ------------------------------

test('the rules reach a run that stored no phase at all', () => {
  // Decision 1: a rule written against the stored field alone misses every
  // legacy run, because `resumePhase` collapses absence into a phase derived
  // from `status` and THAT is what the loop branches on.
  const normalisedRun = load({ planOnly: false, status: 'planned', phase: undefined });
  assert.equal(normalisedRun.phase, 'planning');
  assert.equal(normalisedRun.status, 'planned');
  assert.equal(normalisations(normalisedRun).length, 1);
  assert.equal(normalisations(normalisedRun)[0]?.['storedPhase'], undefined);
  assert.equal(normalisations(normalisedRun)[0]?.['resolvedPhase'], 'complete');

  // And a legacy plan-only run with no phase is still perfectly ordinary.
  const legacy = load({ planOnly: true, status: 'planning', phase: undefined });
  assert.equal('phase' in legacy, false, 'absence is not filled in');
  assert.deepEqual(normalisations(legacy), []);
});

// ---- 8. the whole matrix, against the real resumePhase ---------------------

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
        const fields: ConsistencyFields = { id: 'matrix', dir: 'nowhere', status, planOnly };
        const state = phase === undefined ? fields : { ...fields, phase };
        // The real function, not a reimplementation of it: the whole point of
        // Decision 1 is that the rules and the loop read the same value.
        const resolved = resumePhase(state as RunState);
        const where = `${planOnly ? 'plan-only' : 'full'} ${status}/${phase ?? 'absent'}`;

        const refuses = planOnly && (WORK_PHASES.has(resolved) || WORK_STATUSES.has(status));
        if (refuses) {
          assert.throws(
            () => checkStoredConsistency(state, resolved, phase),
            (err: unknown) => err instanceof StoredStateError,
            `${where} is refused`,
          );
          continue;
        }

        const verdict = checkStoredConsistency(state, resolved, phase);
        const expected =
          !planOnly && status === 'planned'
            ? 'B'
            : resolved === 'complete' && !COMPLETION_STATUSES.has(status)
              ? 'C'
              : null;
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
  // F5, stated as its own case: W8 and W9 never touch `phase`, so any pairing
  // is legitimate. The only exception is Rule A's `done`, which no plan-only
  // run can reach.
  for (const status of ['error', 'stalled', 'needs-input', 'done', 'planned'] as const) {
    for (const phase of PHASES) {
      const fields: ConsistencyFields = { id: 'terminal', dir: 'nowhere', status, planOnly: true };
      const state = phase === undefined ? fields : { ...fields, phase };
      const resolved = resumePhase(state as RunState);
      const where = `plan-only ${status}/${phase ?? 'absent'}`;
      if (status === 'done' || WORK_PHASES.has(resolved)) {
        assert.throws(
          () => checkStoredConsistency(state, resolved, phase),
          (err: unknown) => err instanceof StoredStateError,
          `${where} is Rule A`,
        );
      } else {
        assert.equal(checkStoredConsistency(state, resolved, phase), null, `${where} is fine`);
      }
    }
  }
});

// ---- 9. the real states on record ------------------------------------------

const FIXTURES = [
  'oldest-planning',
  'stalled-planning',
  'done-pendingfindings-null',
  'done-widest',
] as const;

for (const name of FIXTURES) {
  test(`${name}.json needs no normalisation and no refusal`, () => {
    const file = fileURLToPath(new URL(`../../tests/fixtures/state/${name}.json`, import.meta.url));
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const id = String(stored['id']);

    const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-consistency-fixture-'));
    const dir = path.join(targetDir, RUNS, id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(file, path.join(dir, 'state.json'));

    const loaded = loadRun(targetDir, id);
    assert.deepEqual(normalisations(loaded), [], 'a real state file is not contradictory');
    assert.deepEqual(repairs(loaded), []);
    assert.equal(loaded.phase, stored['phase'], 'the stored phase survived the round trip');
    assert.equal(loaded.status, stored['status']);
  });
}

// ---- 10-11. what happens on the SECOND load --------------------------------

test('rule B keeps matching, and records its event once', () => {
  // Its predicate reads `status`, which is deliberately never rewritten, so a
  // run resumed twice warns twice - the state is still contradictory - while
  // `recordEvent` persists and must not append a duplicate every time.
  const run = viaCreateRun({ planOnly: false, status: 'planned', phase: 'complete' });

  const first = captureLog(() => loadRun(run.targetDir, run.id));
  assert.equal(first.result.phase, 'planning');
  assert.equal(normalisations(first.result).length, 1);
  assert.ok(first.lines.some((l) => NORMALISED.test(l)), 'the first load warned');

  const second = captureLog(() => loadRun(run.targetDir, run.id));
  assert.equal(second.result.phase, 'planning');
  assert.equal(normalisations(second.result).length, 1, 'no duplicate event on the second load');
  assert.ok(second.lines.some((l) => NORMALISED.test(l)), 'the second load warned again');
  assert.equal(second.result.status, 'planned', 'still not rewritten');
  assert.equal(second.result.planOnly, false);
});

test('rule C matches once, because the phase it writes settles the question', () => {
  // Unlike Rule B its predicate needs `resolved === 'complete'`, and the phase
  // it writes makes `resumePhase` return 'planning' - so the second load sees a
  // consistent state and says nothing at all.
  const run = viaCreateRun({ planOnly: false, status: 'reviewing', phase: 'complete' });

  const first = captureLog(() => loadRun(run.targetDir, run.id));
  assert.equal(first.result.phase, 'planning');
  assert.equal(normalisations(first.result).length, 1);
  assert.equal(normalisations(first.result)[0]?.['rule'], 'C');
  assert.ok(first.lines.some((l) => NORMALISED.test(l)));

  const second = captureLog(() => loadRun(run.targetDir, run.id));
  assert.equal(second.result.phase, 'planning');
  assert.equal(normalisations(second.result).length, 1, 'the first load is still the only one');
  assert.deepEqual(
    second.lines.filter((l) => NORMALISED.test(l)),
    [],
    'nothing left to warn about',
  );
  assert.equal(second.result.status, 'reviewing', 'the status is still the historical record');
});
