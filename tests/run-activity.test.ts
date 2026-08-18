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
  concurrent = false,
): ActivityObservation {
  return {
    source,
    at: at(atMs),
    lastLineAt: lastLineMs === null ? null : at(lastLineMs),
    concurrent,
  };
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
  markActivity(state, observation('start', 10_000, null));

  const reloaded = loadRun(state.targetDir, state.id);

  assert.equal(reloaded.lastActivityAt, at(10_000).toISOString());
  assert.equal(reloaded.turnStartedAt, at(10_000).toISOString());
});

test('a new turn rebases the pulse and clears the previous turn output time', () => {
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  markActivity(state, observation('start', 60_000, null));

  const file = persisted(state);
  assert.equal(file.turnStartedAt, at(60_000).toISOString());
  assert.equal(file.lastActivityAt, at(60_000).toISOString());
  assert.equal(file.lastOutputAt, undefined, 'the previous turn wrote that line, not this one');
});

test('a turn that fails before producing output cannot show the previous turn pulse', () => {
  // The case the whole rebase exists for: a new child dies before its first
  // line, so nothing else in the turn ever writes. What a watcher reads must
  // describe this turn - and this turn has said nothing.
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  markActivity(state, observation('start', 60_000, null));
  // No 'final': the adapter threw.

  const file = persisted(state);
  assert.equal(file.lastOutputAt, undefined);
  assert.equal(file.lastActivityAt, file.turnStartedAt);
});

test('the turn boundary is not subject to the write throttle', () => {
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  markActivity(state, observation('start', 1_000, null));

  assert.equal(persisted(state).turnStartedAt, at(1_000).toISOString());
});

test('a rotation starting mid-Codex-turn does not erase the live turn output time', () => {
  // withConcurrentCompaction: the Codex turn is still talking, so clearing its
  // output time would report a live child as having gone silent.
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  markActivity(state, observation('start', 60_000, null, true));

  const file = persisted(state);
  assert.equal(file.turnStartedAt, at(60_000).toISOString());
  assert.equal(file.lastOutputAt, T0.toISOString());
});

test('the older turn keeps reporting liveness after the newer one starts', () => {
  // Filtering by heartbeat generation would freeze this: the Codex turn runs for
  // minutes past the short rotation that overlapped it, and dropping its
  // observations would report a healthy turn as gone.
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));
  markActivity(state, observation('start', 60_000, null, true));

  markActivity(state, observation('stdout', 66_000, 66_000, true));

  const file = persisted(state);
  assert.equal(file.lastActivityAt, at(66_000).toISOString());
  assert.equal(file.lastOutputAt, at(66_000).toISOString());
});

test('a late observation from the older turn cannot wind either field backwards', () => {
  const state = scratchRun();
  markActivity(state, observation('stdout', 66_000, 66_000));

  // The older heartbeat's end-of-turn flush, which skips the throttle.
  markActivity(state, observation('final', 61_000, 30_000, true));

  const file = persisted(state);
  assert.equal(file.lastActivityAt, at(66_000).toISOString());
  assert.equal(file.lastOutputAt, at(66_000).toISOString());
});
