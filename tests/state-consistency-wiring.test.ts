import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRun, loadRun, resumePhase } from '@src/run.js';
import { StoredStateError } from '@src/stored.js';
import type { RunState } from '@src/types.js';

/**
 * The cross-field rules as `loadRun` applies them (#54).
 *
 * `state-consistency.test.ts` tests `checkStoredConsistency` directly - every
 * triple, every message, and the two refutations. This file tests the other
 * half: that `loadRun` actually calls it, that a normalisation reaches the
 * returned state and the event log, that a refusal leaves the file untouched,
 * and that the resume a normalisation produces is the one the issue asked for.
 *
 * Separate file rather than more cases in `stored-state.test.ts`, whose subject
 * is per-field repair. The rule the two files test is different, and
 * `src/stored.ts`'s header says so as its rule 5.
 */

function on(disk: (raw: Record<string, unknown>) => void): {
  targetDir: string;
  id: string;
  file: string;
} {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-wiring-'));
  const created = createRun(targetDir, 'cross-field wiring', true);
  const file = path.join(created.dir, 'state.json');
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(raw !== null && typeof raw === 'object' && !Array.isArray(raw));
  const rec = raw as Record<string, unknown>;
  disk(rec);
  writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
  return { targetDir, id: created.id, file };
}

const normalisations = (state: RunState): Record<string, unknown>[] =>
  state.events.filter((e) => e.type === 'state_normalised') as unknown as Record<string, unknown>[];

test('loadRun sends a full run wearing a plan-only status back to planning', () => {
  // The issue's first case. Left alone, `resumePhase` reads 'complete' and
  // `runPhases` takes its early exit: the user asked for a full run and gets a
  // plan, with the run reporting success.
  const run = on((raw) => {
    raw['planOnly'] = false;
    raw['status'] = 'planned';
    raw['phase'] = 'complete';
  });

  const loaded = loadRun(run.targetDir, run.id);

  assert.equal(loaded.phase, 'planning');
  assert.equal(resumePhase(loaded), 'planning', 'the resume implements rather than exiting');
  assert.equal(loaded.status, 'planned', 'the status is the record of how it ended - untouched');
  assert.equal(loaded.planOnly, false);

  const events = normalisations(loaded);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.['rule'], 'B');
  assert.equal(events[0]?.['resolvedPhase'], 'complete', 'what it would have done');
  assert.equal(events[0]?.['phase'], 'planning', 'what it will do instead');
});

test('loadRun refuses a plan-only run parked at an implementing phase', () => {
  // The issue's second case. Neither repair is defensible, so it refuses - and
  // the refusal has to be true when it says nothing was rewritten.
  const run = on((raw) => {
    raw['planOnly'] = true;
    raw['status'] = 'planning';
    raw['phase'] = 'implementing';
  });
  const before = readFileSync(run.file, 'utf8');

  assert.throws(
    () => loadRun(run.targetDir, run.id),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError, 'the stored-state refusal type');
      assert.match(err.message, /planOnly/);
      return true;
    },
  );

  assert.equal(readFileSync(run.file, 'utf8'), before, 'state.json is byte-for-byte unchanged');
});

test('a finished run whose preflight later failed still resumes as finished', () => {
  // THE regression. `execute` runs preflight before the loop and a failure sets
  // status 'error' without touching the phase, so a healthy done/complete run
  // resumed once persists error/complete. The rule that was proposed twice and
  // refuted twice would drop that phase, `resumePhase` would infer 'planning'
  // from the terminal status, and the resume would re-plan and re-implement work
  // that was already finished - worse than the defect being fixed.
  const run = on((raw) => {
    raw['planOnly'] = false;
    raw['status'] = 'error';
    raw['phase'] = 'complete';
  });

  const loaded = loadRun(run.targetDir, run.id);

  assert.equal(loaded.phase, 'complete', 'the phase survives');
  assert.equal(resumePhase(loaded), 'complete', 'so the resume reports it already finished');
  assert.deepEqual(normalisations(loaded), [], 'and nothing claims to have corrected it');
});

test('both mid-flight disagreements survive a real load', () => {
  // `advancePhase` saves immediately, so each of these is a state a process
  // killed in the window between two writes actually leaves. "status and phase
  // must agree" is the obvious rule and would break both.
  for (const [status, phase] of [
    ['planning', 'implementing'],
    ['implementing', 'reviewing'],
  ] as const) {
    const run = on((raw) => {
      raw['planOnly'] = false;
      raw['status'] = status;
      raw['phase'] = phase;
    });

    const loaded = loadRun(run.targetDir, run.id);

    assert.equal(loaded.phase, phase, `${status}/${phase} keeps its phase`);
    assert.deepEqual(normalisations(loaded), [], `${status}/${phase} is not corrected`);
  }
});

test('rule B keeps warning on every load but records its event once', () => {
  // Rule B's predicate reads `status`, which is deliberately never rewritten, so
  // it matches again on every later load of the same run. Warning each time is
  // right; appending an identical event each time would grow the log without
  // adding a fact.
  const run = on((raw) => {
    raw['planOnly'] = false;
    raw['status'] = 'planned';
    raw['phase'] = 'complete';
  });

  assert.equal(normalisations(loadRun(run.targetDir, run.id)).length, 1);
  const second = loadRun(run.targetDir, run.id);
  assert.equal(second.phase, 'planning', 'still corrected');
  assert.equal(normalisations(second).length, 1, 'and still exactly one event');
});

test('a healthy run loads with nothing said about it at all', () => {
  const run = on(() => {});

  const loaded = loadRun(run.targetDir, run.id);

  assert.equal(loaded.phase, 'planning');
  assert.deepEqual(normalisations(loaded), []);
});
