import { describe, expect, test } from 'vitest';
import { comparableLine, emptyRun, nextRun, reduce, runningRow, statsEpoch } from './model';
import type { ArchiveTurns, Run } from './model';
import type { Frame } from '../host';

/**
 * The comparable-turns line, and when the window re-reads the archive (#114).
 *
 * Three rules are pinned here because each is a way to invent a number. The
 * line is **tokens, never time** - the archive records no durations, and a gap
 * between charges includes every gate held. It **always names n and always
 * says across models** - a turn event records no model, and hiding the line
 * under some sample size would be a threshold with nothing behind it. And the
 * scorecard is re-read **when a run ends**, never on a timer.
 */

const say = (id: string, data: Record<string, unknown>): Frame => ({
  type: 'narration',
  level: 'info',
  message: 'x',
  id,
  data,
});

const fold = (frames: readonly Frame[]): Run =>
  frames.reduce((run, frame, i) => reduce(run, frame, 1_000_000 + i), emptyRun());

const ARCHIVE: ArchiveTurns = {
  byKind: { critique: { turns: 41, median: 2_100_000, p90: 3_400_000 }, plan: { turns: 1, median: 900, p90: 900 } },
  unplaced: 0,
};

/** Anything that would let the line be read as a duration. */
const TIME = /\b(took|ms|sec|secs|seconds?|min|mins|minutes?|h|hrs?|hours?)\b|\d+m\d+s|\d+s\b/;

describe('the comparable-turns line', () => {
  test('with past turns it names n, the median and p90 in tokens, across models', () => {
    const line = comparableLine('critique', ARCHIVE);
    expect(line).toEqual({
      text: '41 past critique turns · median 2.10M tok · p90 3.40M tok · across models',
      measured: true,
    });
    expect(line.text).not.toMatch(TIME);
    // One is a sample size, and it is drawn rather than hidden.
    expect(comparableLine('plan', ARCHIVE).text).toBe('1 past plan turn · median 900 tok · p90 900 tok · across models');
  });

  test('with none of that kind it says so, and still says across models', () => {
    const line = comparableLine('final-fix', ARCHIVE);
    expect(line.measured).toBe(true);
    expect(line.text).toBe('this archive holds no past final-fix turns · across models');
    expect(line.text).not.toMatch(TIME);
  });

  test('before the archive is read it is absent with its reason', () => {
    const line = comparableLine('critique', null);
    expect(line.measured).toBe(false);
    expect(line.text).toMatch(/not been read/);
    expect(line.text).not.toMatch(TIME);
  });

  test('the row keys the archive by the live turn’s own kind', () => {
    const run = fold([say('turn_started', { role: 'critic', kind: 'critique', round: 0 })]);
    const row = runningRow(run.running!, 0, ARCHIVE);
    expect(row.comparable.text).toMatch(/^41 past critique turns/);
  });
});

describe('when the scorecard is re-read', () => {
  test('a run ending moves the epoch, a heartbeat does not, and a launch moves it again', () => {
    const live = fold([say('run_started', { runId: 'r1', dir: '/d', resumed: false })]);
    const before = statsEpoch(live);
    const beating = reduce(live, say('heartbeat', { label: 'plan', elapsedMs: 30_000 }), 2_000_000);
    expect(statsEpoch(beating)).toBe(before);

    const ended = reduce(beating, { type: 'result', id: 1, exit: 0 }, 3_000_000);
    const after = statsEpoch(ended);
    expect(after).not.toBe(before);

    expect(statsEpoch(nextRun(ended))).not.toBe(after);
  });
});
