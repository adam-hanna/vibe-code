import { describe, expect, test } from 'vitest';
import { foundByLine, readReport } from './artifacts';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import { rounds } from './rounds';
import type { Frame } from '../host';

/**
 * A finding's provenance across review finders (#388 Part B).
 *
 * Two halves, read from two places: who found a finding is in the round's own
 * `code-review-<n>.json`, and how many finders reported that round is in the
 * `review_finders_merged` frame. The denominator is only ever the second - the
 * configured count would count a seat that failed as one that looked.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const MERGED = { round: 0, finders: 3, parts: 1, reported: 2, findings: 5, merged: 4, byCitation: 1, byTitle: 0 };

describe('foundBy, read off the report', () => {
  test('each entry is carried, and one this build cannot read is dropped alone', () => {
    const report = readReport(
      JSON.stringify({
        findings: [
          {
            id: 'a',
            severity: 'P1',
            foundBy: [
              { seat: 'roles.reviewer', provider: 'codex', model: 'gpt-5.5', id: 'a' },
              { seat: 'review.finders[0]', provider: 'claude' },
              { seat: 'review.finders[1]', provider: 'claude', model: 'default', id: 'a-x' },
            ],
          },
        ],
      }),
    );
    expect(report?.findings[0]?.foundBy).toEqual([
      { seat: 'roles.reviewer', provider: 'codex', model: 'gpt-5.5', id: 'a' },
      { seat: 'review.finders[1]', provider: 'claude', model: 'default', id: 'a-x' },
    ]);
  });

  test('a finding without it reads as null, as every default run does', () => {
    const report = readReport(JSON.stringify({ findings: [{ id: 'a', severity: 'P1' }] }));
    expect(report?.findings[0]?.foundBy).toBeNull();
    const junk = readReport(JSON.stringify({ findings: [{ id: 'a', severity: 'P1', foundBy: [7, null] }] }));
    expect(junk?.findings[0]?.foundBy).toBeNull();
  });
});

describe('the provenance line', () => {
  const two = [
    { seat: 'roles.reviewer', provider: 'codex', model: 'gpt-5.5', id: 'a' },
    { seat: 'review.finders[1]', provider: 'claude', model: 'default', id: 'b' },
  ];

  test('with a merge frame, the denominator is the finders that reported', () => {
    expect(foundByLine(two, 3)).toBe('found by 2 of 3 finders: codex/gpt-5.5, claude/default');
  });

  test('without one, it states who found it and claims no denominator', () => {
    expect(foundByLine(two, null)).toBe('found by 2 finders: codex/gpt-5.5, claude/default');
    expect(foundByLine(two.slice(0, 1), null)).toBe('found by 1 finder: codex/gpt-5.5');
  });
});

describe('review_finders_merged, folded', () => {
  test('the frame is kept with its counts and attached to its review round', () => {
    const run = fold([
      say('phase_started', { phase: 'review', round: 0 }),
      say('turn_started', { role: 'reviewer', kind: 'review', round: 0 }),
      say('turn_started', { role: 'reviewer', kind: 'review', round: 0, finder: 1, seat: 'review.finders[0]' }),
      say('review_finders_merged', MERGED),
    ]);
    expect(run.finderMerges).toHaveLength(1);
    expect(run.finderMerges[0]).toMatchObject({ round: 0, finders: 3, reported: 2, findings: 5, merged: 4 });
    const card = rounds(run).find((c) => c.cycle === 'review');
    expect(card?.finders?.reported).toBe(2);
  });

  test('a frame missing either count is dropped rather than guessed', () => {
    const { reported: _reported, ...noReported } = MERGED;
    const { finders: _finders, ...noFinders } = MERGED;
    const run = fold([
      say('review_finders_merged', noReported),
      say('review_finders_merged', noFinders),
      say('review_finders_merged', { ...MERGED, reported: 'two' }),
    ]);
    expect(run.finderMerges).toEqual([]);
  });

  test('a run with no finders has no merge and no card carries one', () => {
    const run = fold([
      say('phase_started', { phase: 'review', round: 0 }),
      say('turn_started', { role: 'reviewer', kind: 'review', round: 0 }),
    ]);
    expect(run.finderMerges).toEqual([]);
    expect(rounds(run).every((c) => c.finders === null)).toBe(true);
  });
});
