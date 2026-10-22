import { describe, expect, test } from 'vitest';
import { classify, outcomeLine, readDispositions } from './artifacts';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import type { Frame } from '../host';

/**
 * What the fixer did with a finding, in the findings pane (#393).
 *
 * The disposition is read from `fix-dispositions-<n+1>.json` for a finding in
 * `code-review-<n>.json`; that a round's dispositions could not be read is
 * only ever said by the `fix_dispositions_unreadable` frame. The text is
 * `outcomeLine`'s, and later evidence is its own badge, never folded in.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const entry = (disposition: string, reason = 'because') => ({ disposition, reason });

describe('the outcome line', () => {
  test('each disposition, with its reason and its round', () => {
    const at = (disposition: string, reason = 'because') =>
      outcomeLine({ kind: 'recorded', fixRound: 2, final: false, entry: entry(disposition, reason) }, null);
    expect(at('fixed')).toEqual(['fixer: fixed - because (fix round 2)']);
    expect(at('rebutted', 'the path is unreachable')).toEqual([
      'fixer: rebutted - the path is unreachable (fix round 2)',
    ]);
    expect(at('deferred')).toEqual(['fixer: deferred - because (fix round 2)']);
    // A finding the fixer left out has no reason, and says none.
    expect(at('not-addressed', '')).toEqual(['fixer: not addressed (fix round 2)']);
  });

  test('a round whose dispositions could not be read says so, and only that', () => {
    expect(outcomeLine({ kind: 'not-recorded' }, null)).toEqual(['dispositions not recorded for this round']);
  });

  test('raised again and not reviewed again are badges of their own', () => {
    expect(outcomeLine({ kind: 'recorded', fixRound: 1, final: false, entry: entry('fixed') }, 'raised-again')).toEqual([
      'fixer: fixed - because (fix round 1)',
      'same id raised again next round',
    ]);
    expect(
      outcomeLine({ kind: 'recorded', fixRound: 3, final: true, entry: entry('fixed') }, 'not-reviewed-again'),
    ).toEqual(['fixer: fixed - because (final fix round 3)', 'not reviewed again']);
  });

  test('nothing to say is nothing drawn', () => {
    expect(outcomeLine(null, null)).toEqual([]);
  });
});

describe('the dispositions file', () => {
  test('each entry is read by id, and one this build cannot read is dropped alone', () => {
    const file = readDispositions(
      JSON.stringify({
        round: 2,
        label: 'final-fix-2',
        answers: 1,
        dispositions: [
          { id: 'a', disposition: 'rebutted', reason: 'no' },
          { id: 'b', disposition: 'not-addressed', reason: '' },
          { id: 'c' },
          7,
          { id: 'a', disposition: 'fixed', reason: 'second' },
        ],
      }),
    );
    expect(file?.round).toBe(2);
    expect(file?.final).toBe(true);
    expect([...(file?.byId ?? new Map())]).toEqual([
      ['a', { disposition: 'rebutted', reason: 'no' }],
      ['b', { disposition: 'not-addressed', reason: '' }],
    ]);
    expect(readDispositions('{ not json')).toBeNull();
    expect(readDispositions(JSON.stringify({ label: 'fix-1' }))?.final).toBe(false);
  });

  test('is classified as its own kind, with the fix round as its round', () => {
    expect(classify({ name: 'fix-dispositions-2.json', kind: 'file', bytes: 10 })).toMatchObject({
      kind: 'dispositions',
      round: 2,
    });
  });
});

describe('fix_dispositions frames, folded', () => {
  test('a recorded round and an unreadable one are both carried, and told apart', () => {
    const run = fold([
      say('fix_dispositions', { round: 1, label: 'fix-1', answers: 0, dispositions: [] }),
      say('fix_dispositions_unreadable', { round: 2, label: 'fix-2', answers: 1, reason: 'x' }),
    ]);
    expect(run.fixDispositions).toHaveLength(2);
    expect(run.fixDispositions[0]).toMatchObject({ round: 1, answers: 0, label: 'fix-1', recorded: true });
    expect(run.fixDispositions[1]).toMatchObject({ round: 2, answers: 1, label: 'fix-2', recorded: false });
  });

  test('a frame missing a round is dropped rather than guessed', () => {
    expect(fold([say('fix_dispositions', { label: 'fix-1', answers: 0 })]).fixDispositions).toEqual([]);
    expect(fold([say('fix_dispositions_unreadable', { round: 1 })]).fixDispositions).toEqual([]);
    expect(emptyRun().fixDispositions).toEqual([]);
  });
});
