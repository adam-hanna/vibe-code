import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRun, loadRun, markActivity } from '@src/run.js';
import type { ActivityObservation } from '@src/progress.js';
import type { RunState } from '@src/types.js';

/** A run in a throwaway directory, so state.json can be read back from disk. */
function scratchRun(): RunState {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-activity-'));
  return createRun(dir, 'progress fixture', true);
}

function persisted(state: RunState): Partial<RunState> {
  return JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Partial<RunState>;
}

const T0 = new Date('2026-08-17T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

function observation(
  source: ActivityObservation['source'],
  atMs: number,
  lastLineMs: number | null,
): ActivityObservation {
  return { source, at: at(atMs), lastLineAt: lastLineMs === null ? null : at(lastLineMs) };
}

test('output from the child records both timestamps', () => {
  const state = scratchRun();

  markActivity(state, observation('stdout', 0, 0));

  const file = persisted(state);
  assert.equal(file.lastActivityAt, T0.toISOString());
  assert.equal(file.lastOutputAt, T0.toISOString());
});

test('a silent turn still advances lastActivityAt, and leaves lastOutputAt alone', () => {
  const state = scratchRun();

  // The tick-only case: this is what makes a healthy silent turn
  // distinguishable from a hung one without reading the process table.
  markActivity(state, observation('heartbeat', 0, null));

  const file = persisted(state);
  assert.equal(file.lastActivityAt, T0.toISOString());
  assert.equal(file.lastOutputAt, undefined);
});

test('writes are throttled, then resume once the window has passed', () => {
  const state = scratchRun();

  markActivity(state, observation('stdout', 0, 0));
  markActivity(state, observation('stdout', 1_000, 1_000));
  assert.equal(persisted(state).lastActivityAt, T0.toISOString());

  markActivity(state, observation('stdout', 6_000, 6_000));
  assert.equal(persisted(state).lastActivityAt, at(6_000).toISOString());
});

test('lastOutputAt is the time of the line, not of the write that published it', () => {
  const state = scratchRun();

  markActivity(state, observation('stdout', 0, 0));
  markActivity(state, observation('stdout', 4_000, 4_000)); // throttled away
  markActivity(state, observation('heartbeat', 6_000, 4_000));

  const file = persisted(state);
  assert.equal(file.lastActivityAt, at(6_000).toISOString());
  assert.equal(file.lastOutputAt, at(4_000).toISOString(), 'the published time was stamped, not observed');
});

test('the end-of-turn flush persists a line that arrived inside the throttle', () => {
  const state = scratchRun();

  markActivity(state, observation('stdout', 0, 0));
  markActivity(state, observation('stdout', 1_000, 1_000)); // throttled away
  assert.equal(persisted(state).lastOutputAt, T0.toISOString());

  markActivity(state, observation('final', 1_000, 1_000));

  assert.equal(persisted(state).lastOutputAt, at(1_000).toISOString());
});

test('an unparseable lastActivityAt is treated as stale rather than wedging the field', () => {
  const state = scratchRun();
  state.lastActivityAt = 'not a date';

  assert.doesNotThrow(() => markActivity(state, observation('stdout', 0, 0)));

  assert.equal(persisted(state).lastActivityAt, T0.toISOString());
});

test('both timestamps survive a reload', () => {
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  const reloaded = loadRun(state.targetDir, state.id);

  assert.equal(reloaded.lastActivityAt, T0.toISOString());
  assert.equal(reloaded.lastOutputAt, T0.toISOString());
});
