import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelRequested, clearCancel } from '@src/cancel.js';
import { DEFAULTS } from '@src/config.js';
import { createHeartbeat, heartbeatData, progressOptions } from '@src/progress.js';
import type { LineParser, ProgressSnapshot, RepeatingTimer, TimerApi } from '@src/progress.js';
import type { Config, RunState } from '@src/types.js';

/**
 * A ceiling that can reach a turn already spending, and the measurements that
 * would have shown the run that killed a host (#211).
 *
 * `applyCharge` enforces `budget.maxTokens` **between** turns: it charges what a
 * turn spent once the turn returns, and raises `EXIT.BUDGET` when the total is
 * past the ceiling. A turn that never returns is invisible to it, and one was -
 * a 27-minute implement turn reporting 8.8M tokens against a 25M ceiling, whose
 * host then died with no stack, no narration, and nothing on stderr. That
 * turn's whole spend is absent from `state.json`, because it was never charged.
 *
 * The heartbeat is the only thing that watches a turn while it spends, so the
 * ceiling now reaches it from there - and the same beat carries this process's
 * memory and the size of the buffer it is holding, so the next silent death has
 * a curve behind it instead of a guess.
 */

const idle: TimerApi = { repeat: (): RepeatingTimer => ({ unref: () => {}, cancel: () => {} }) };

/** A parser that reports whatever token total the case wants, once per line. */
const parser = (tokens: number): LineParser => {
  return (snapshot: ProgressSnapshot) => {
    snapshot.tokens = tokens;
    snapshot.activities += 1;
    return true;
  };
};

function state(tokensUsed: number): RunState {
  return { dir: '/nowhere', events: [], tokensUsed } as unknown as RunState;
}

function config(maxTokens: number): Config {
  return {
    ...DEFAULTS,
    progress: { ...DEFAULTS.progress, intervalMs: 0 },
    budget: { ...DEFAULTS.budget, maxTokens },
  };
}

/** Drive one beat with a turn that has spent `tokens`, and report the cancel. */
function beat(runTokens: number, turnTokens: number, ceiling: number): string | null {
  clearCancel();
  const options = progressOptions(state(runTokens), config(ceiling), 'implement', 'opus', 'claude');
  assert.ok(options, 'progress was disabled, so this case proves nothing');
  const heartbeat = createHeartbeat({
    ...options,
    parse: parser(turnTokens),
    unit: 'tool use',
    provider: 'claude',
    emit: () => undefined,
    timers: idle,
    now: () => 0,
  });
  heartbeat.onLine('{}');
  heartbeat.stop();
  const why = cancelRequested();
  clearCancel();
  return why;
}

test('a turn that spends past the ceiling is stopped without waiting to be charged', () => {
  // The case that could not happen before: the ceiling only ever saw a turn
  // after it returned, and this one is stopped while it is still running.
  const why = beat(1_000_000, 9_000_000, 5_000_000);
  assert.ok(why !== null, 'the turn was allowed to keep spending past the ceiling');
  // Both figures, because "over budget" with neither is the sentence nobody can
  // check - and the ceiling named is the user's own setting.
  assert.match(why, /10\.0M|10M/);
  assert.match(why, /5\.0M|5M/);
  assert.match(why, /budget\.maxTokens/);
});

test('the run total counts, not just this turn', () => {
  // The arithmetic is `applyCharge`'s, not a new one: what the run has spent
  // plus what this turn has spent so far. A turn small on its own can still be
  // the one that crosses the line, and it is stopped for it.
  assert.ok(beat(4_900_000, 200_000, 5_000_000) !== null);
  // And the same turn against a run that has spent nothing is fine.
  assert.equal(beat(0, 200_000, 5_000_000), null);
});

test('a turn under the ceiling is left alone', () => {
  assert.equal(beat(1_000_000, 1_000_000, 5_000_000), null);
});

test('no ceiling means no ceiling here either', () => {
  // `maxTokens: 0` is documented as disabled, and a guard that fired anyway
  // would be a limit nobody set - the exact shape of an invented number.
  assert.equal(beat(0, 500_000_000, 0), null);
});

test('the beat reports what this process is holding, and what of it is output', () => {
  // Neither is a threshold and neither is acted on: nothing here has measured
  // what "too large" is on this platform, so what is shipped is the ability to
  // look. The two are separate because "the process is large" and "the process
  // is large BECAUSE of this buffer" are different findings, and only the
  // second names a fix.
  const data = heartbeatData({
    label: 'implement',
    elapsedMs: 1_000,
    snapshot: { ...emptyish(), tokens: 8_800_000 },
    unit: 'tool use',
    rssBytes: 1_234_567,
    outputBytes: 890_123,
  });
  assert.equal(data['rssBytes'], 1_234_567);
  assert.equal(data['outputBytes'], 890_123);

  // Omitted rather than zeroed, as every other optional field here is: a build
  // that did not measure and a process holding nothing are different facts.
  const without = heartbeatData({
    label: 'implement',
    elapsedMs: 1_000,
    snapshot: emptyish(),
    unit: 'tool use',
  });
  assert.equal('rssBytes' in without, false);
  assert.equal('outputBytes' in without, false);
});

test('a real turn measures its own memory rather than reporting nothing', () => {
  // `progressOptions` supplies the reader, so the loop's turns carry it without
  // every caller remembering to. The value is this process's, which is the one
  // that dies.
  const options = progressOptions(state(0), config(0), 'implement', 'opus', 'claude');
  const rss = options?.measure?.();
  assert.equal(typeof rss, 'number');
  assert.ok((rss ?? 0) > 0, 'a process that is running is holding something');
});

function emptyish(): ProgressSnapshot {
  return {
    activities: 0,
    items: new Map(),
    toolItems: 0,
    lastActivity: null,
    tokens: 0,
    promptTokens: 0,
    countedMessages: new Set(),
    itemisedMessages: new Set(),
  };
}
