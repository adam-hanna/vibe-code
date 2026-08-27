import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRun, loadRun, markActivity } from '@src/run.js';
import { createHeartbeat, parseClaudeLine } from '@src/progress.js';
import type { ActivityObservation, RepeatingTimer, TimerApi } from '@src/progress.js';
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
const iso = (offsetMs: number): string => at(offsetMs).toISOString();

/**
 * One observation as the heartbeat layer produces it: `lastLineAt` and
 * `turnStartedAt` are already aggregated across the turns still running, which
 * is why they are given per observation rather than accumulated here.
 */
function observation(
  source: ActivityObservation['source'],
  atMs: number,
  lastLineMs: number | null,
  turnStartedMs: number | null = 0,
): ActivityObservation {
  return {
    source,
    at: at(atMs),
    lastLineAt: lastLineMs === null ? null : at(lastLineMs),
    turnStartedAt: turnStartedMs === null ? null : at(turnStartedMs),
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
  assert.equal(persisted(state).lastActivityAt, iso(6_000));
});

test('lastOutputAt is the time of the line, not of the write that published it', () => {
  const state = scratchRun();

  markActivity(state, observation('stdout', 0, 0));
  markActivity(state, observation('stdout', 4_000, 4_000)); // throttled away
  markActivity(state, observation('heartbeat', 6_000, 4_000));

  const file = persisted(state);
  assert.equal(file.lastActivityAt, iso(6_000));
  assert.equal(file.lastOutputAt, iso(4_000), 'the published time was stamped, not observed');
});

test('the end-of-turn flush persists a line that arrived inside the throttle', () => {
  const state = scratchRun();

  markActivity(state, observation('stdout', 0, 0));
  markActivity(state, observation('stdout', 1_000, 1_000)); // throttled away
  assert.equal(persisted(state).lastOutputAt, T0.toISOString());

  markActivity(state, observation('final', 1_000, 1_000));

  assert.equal(persisted(state).lastOutputAt, iso(1_000));
});

test('an unparseable lastActivityAt is treated as stale rather than wedging the field', () => {
  const state = scratchRun();
  state.lastActivityAt = 'not a date';

  assert.doesNotThrow(() => markActivity(state, observation('stdout', 0, 0)));

  assert.equal(persisted(state).lastActivityAt, T0.toISOString());
});

test('the three timestamps survive a reload', () => {
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  const reloaded = loadRun(state.targetDir, state.id);

  assert.equal(reloaded.lastActivityAt, T0.toISOString());
  assert.equal(reloaded.lastOutputAt, T0.toISOString());
  assert.equal(reloaded.turnStartedAt, T0.toISOString());
});

test('a new turn rebases the pulse and clears the previous turn output time', () => {
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  // Nothing else is running, so the boundary reports no live output at all.
  markActivity(state, observation('start', 60_000, null, 60_000));

  const file = persisted(state);
  assert.equal(file.turnStartedAt, iso(60_000));
  assert.equal(file.lastActivityAt, iso(60_000));
  assert.equal(file.lastOutputAt, undefined, 'the previous turn wrote that line, not this one');
});

test('a turn that fails before producing output cannot show the previous turn pulse', () => {
  // The case the whole rebase exists for: a new child dies before its first
  // line, so nothing else in the turn ever writes. What a watcher reads must
  // describe this turn - and this turn has said nothing.
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  markActivity(state, observation('start', 60_000, null, 60_000));
  // No 'final': the adapter threw.

  const file = persisted(state);
  assert.equal(file.lastOutputAt, undefined);
  assert.equal(file.lastActivityAt, file.turnStartedAt);
});

test('the turn boundary is not subject to the write throttle', () => {
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  markActivity(state, observation('start', 1_000, null, 1_000));

  assert.equal(persisted(state).turnStartedAt, iso(1_000));
});

test('lastActivityAt never moves backwards, even on an unthrottled source', () => {
  const state = scratchRun();
  markActivity(state, observation('stdout', 66_000, 66_000));

  markActivity(state, observation('final', 61_000, 30_000, 0));

  assert.equal(persisted(state).lastActivityAt, iso(66_000));
});

test('a rotation starting mid-Codex-turn does not erase the live turn output time', () => {
  // withConcurrentCompaction: the Codex turn is still talking, so its line is
  // still part of what is running and the boundary carries it through.
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));

  markActivity(state, observation('start', 60_000, 0, 60_000));

  const file = persisted(state);
  assert.equal(file.turnStartedAt, iso(60_000));
  assert.equal(file.lastOutputAt, T0.toISOString());
});

test('the older turn keeps reporting liveness after the newer one starts', () => {
  // Filtering by heartbeat generation would freeze this: the Codex turn runs for
  // minutes past the short rotation that overlapped it, and dropping its
  // observations would report a healthy turn as gone.
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0));
  markActivity(state, observation('start', 60_000, 0, 60_000));

  markActivity(state, observation('stdout', 66_000, 66_000, 60_000));

  const file = persisted(state);
  assert.equal(file.lastActivityAt, iso(66_000));
  assert.equal(file.lastOutputAt, iso(66_000));
});

test('a finished overlapping turn takes its pulse with it', () => {
  // The rotation spoke last and started last, then ended while the Codex turn
  // carried on. Leaving its values in place would show a completed turn's output
  // as the live turn's progress.
  const state = scratchRun();
  markActivity(state, observation('stdout', 0, 0)); // codex turn, started at 0
  markActivity(state, observation('start', 60_000, 0, 60_000)); // rotation begins
  markActivity(state, observation('stdout', 66_000, 66_000, 60_000)); // rotation speaks

  markActivity(state, observation('end', 70_000, 0, 0)); // rotation ends, codex lives

  const file = persisted(state);
  assert.equal(file.turnStartedAt, T0.toISOString(), 'back to the turn still running');
  assert.equal(file.lastOutputAt, T0.toISOString(), 'the rotation took its output with it');
  assert.equal(file.lastActivityAt, iso(70_000), 'vibe did observe something just now');
});

/** A timer that never fires on its own: nothing here waits for wall-clock. */
function idleTimers(): TimerApi {
  return { repeat: (): RepeatingTimer => ({ unref: () => {}, cancel: () => {} }) };
}

const TOOL_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
});

test('a rotation overlapping a Codex turn leaves state describing the Codex turn', () => {
  // End to end over the real heartbeats: withConcurrentCompaction's shape, with
  // both turns reporting into one run's state.json.
  const state = scratchRun();
  let clock = T0.getTime();
  // Labelled and attributed per turn since #77: the in-flight record is keyed by
  // label plus provider, and the two turns this case overlaps are a Codex turn
  // and a Claude rotation - which is what the case has always been about. The
  // parser stays parseClaudeLine for both, because what is asserted here is the
  // timestamp arithmetic and TOOL_LINE has to be recognised by whatever parses it.
  const heartbeat = (
    label: string,
    provider: 'claude' | 'codex',
  ): ReturnType<typeof createHeartbeat> =>
    createHeartbeat({
      label,
      intervalMs: 30_000,
      parse: parseClaudeLine,
      unit: 'tool use',
      provider,
      scope: state,
      now: () => clock,
      emit: () => {},
      timers: idleTimers(),
      onActivity: (o) => markActivity(state, o),
    });

  const codex = heartbeat('review-0', 'codex');
  codex.begin();
  codex.onLine(TOOL_LINE);

  clock += 60_000;
  const rotation = heartbeat('compact', 'claude');
  rotation.begin();
  assert.equal(persisted(state).lastOutputAt, T0.toISOString(), 'the Codex line is still live');

  clock += 6_000;
  rotation.onLine(TOOL_LINE);
  assert.equal(persisted(state).lastOutputAt, iso(66_000));

  clock += 4_000;
  rotation.flush();
  rotation.stop();

  const file = persisted(state);
  assert.equal(file.turnStartedAt, T0.toISOString(), 'the Codex turn is what is running');
  assert.equal(file.lastOutputAt, T0.toISOString(), 'and it has not spoken since');
  codex.stop();
});

// ---- What a turn has spent, on the same write (#77) -------------------------

/** An observation carrying spend, in the shape the heartbeat layer builds. */
function spending(
  source: ActivityObservation['source'],
  atMs: number,
  turns: ActivityObservation['turns'],
  urgent = false,
): ActivityObservation {
  return { ...observation(source, atMs, atMs), turns, ...(urgent ? { urgent } : {}) };
}

test('an observation carrying turns persists what they have spent', () => {
  const state = scratchRun();

  markActivity(
    state,
    spending('start', 0, [
      { label: 'implement', provider: 'claude', tokens: 1_000 },
      { label: 'review-0', provider: 'codex' },
    ]),
  );

  const file = persisted(state);
  assert.deepEqual(file.inFlight, [
    { label: 'implement', provider: 'claude', tokens: 1_000 },
    // No `tokens` key at all: Codex reports no usage until a turn ends, and a
    // zero would say the turn spent nothing rather than that nobody knows.
    { label: 'review-0', provider: 'codex' },
  ]);
});

test('a later observation replaces the figure rather than adding to it', () => {
  const state = scratchRun();

  markActivity(state, spending('start', 0, [{ label: 'plan', provider: 'claude', tokens: 500 }]));
  // The heartbeat reports a running total, not a delta.
  markActivity(state, spending('final', 6_000, [{ label: 'plan', provider: 'claude', tokens: 900 }]));

  assert.deepEqual(persisted(state).inFlight, [
    { label: 'plan', provider: 'claude', tokens: 900 },
  ]);
});

test('an observation with no turns leaves an existing record alone', () => {
  const state = scratchRun();

  markActivity(state, spending('start', 0, [{ label: 'plan', provider: 'claude', tokens: 500 }]));
  // Absence is not a claim that nothing is in flight: only the accounting
  // removes an entry, and a timestamp-only observation is not accounting.
  markActivity(state, observation('final', 6_000, 6_000));

  assert.deepEqual(persisted(state).inFlight, [
    { label: 'plan', provider: 'claude', tokens: 500 },
  ]);
});

test('a failed turn persists its spend without moving the turn timestamps', () => {
  const state = scratchRun();
  markActivity(state, observation('start', 0, 0));
  assert.equal(persisted(state).lastOutputAt, T0.toISOString());

  // Inside the throttle window, and it still writes: this is the observation the
  // charge is about to read.
  markActivity(
    state,
    spending('failed', 1_000, [{ label: 'implement', provider: 'claude', tokens: 4_242 }]),
  );

  const file = persisted(state);
  assert.deepEqual(file.inFlight, [
    { label: 'implement', provider: 'claude', tokens: 4_242 },
  ]);
  assert.equal(file.lastActivityAt, iso(1_000), 'vibe did observe something');
  // Untouched: a failed turn has not completed its output, and `stop()` is what
  // rebases these across whatever is still running.
  assert.equal(file.lastOutputAt, T0.toISOString());
  assert.equal(file.turnStartedAt, T0.toISOString());
});

test('the first non-zero figure is written even inside the throttle window', () => {
  const state = scratchRun();
  markActivity(state, observation('start', 0, 0));

  // A throttled stdout observation one second in: without the urgent flag this
  // write is skipped, and a turn killed at four seconds recovers as a zero.
  markActivity(
    state,
    spending('stdout', 1_000, [{ label: 'plan', provider: 'claude', tokens: 700 }], true),
  );

  assert.deepEqual(persisted(state).inFlight, [{ label: 'plan', provider: 'claude', tokens: 700 }]);
});

test('an ordinary throttled observation still writes nothing', () => {
  const state = scratchRun();
  markActivity(state, observation('start', 0, 0));

  markActivity(state, spending('stdout', 1_000, [{ label: 'plan', provider: 'claude', tokens: 700 }]));

  assert.equal(persisted(state).inFlight, undefined, 'the throttle is otherwise unchanged');
});
