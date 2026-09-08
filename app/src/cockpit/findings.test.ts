import { describe, expect, test } from 'vitest';
import { blocking, emptyRun, reduce } from './model';
import type { Run } from './model';
import type { Frame } from '../host';

/**
 * A round's findings, and what the gate made of them (`1e`, `4c`, #223).
 *
 * The claim this file protects is the one the design states in its own words:
 * the question at a gate is not *how many findings* but *why did the loop choose
 * to fix again rather than finish*. That is a comparison of four counts against
 * a tolerance, and every part of it has to survive the wire intact - including
 * the zeros, which are a measurement here and not an absence.
 */

function say(id: string | null, data: Record<string, unknown> | null): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const census = (over: Record<string, unknown> = {}): Frame =>
  say('findings_reported', {
    phase: 'review',
    counts: { P0: 0, P1: 2, P2: 1, P3: 0 },
    tolerance: 1,
    pass: false,
    reason: '2 P1 finding(s), above the tolerance of 1',
    tolerated: [],
    findings: [],
    ...over,
  });

describe('the counts are the gate’s decision, carried whole', () => {
  test('all four arrive, zeros included', () => {
    // Zeros are a measurement where a gate decision is being made. The design's
    // four-chip form shows them on purpose and this is that rule in data.
    const run = fold([census()]);
    expect(run.censuses).toHaveLength(1);
    expect(run.censuses[0]?.counts).toEqual({ P0: 0, P1: 2, P2: 1, P3: 0 });
    expect(run.censuses[0]?.tolerance).toBe(1);
    expect(run.censuses[0]?.pass).toBe(false);
  });

  test('a census missing a severity is dropped rather than zero-filled', () => {
    // Filling the gap would be a count nobody took, presented as one - and it
    // would be presented at the exact moment somebody is reading the row to
    // decide whether the loop was right to block.
    const run = fold([census({ counts: { P0: 0, P1: 2, P3: 0 } })]);
    expect(run.censuses).toHaveLength(0);
  });

  test('a phase this build does not know is dropped, not guessed into a cycle', () => {
    // A critique census drawn as a review one would put the plan cycle's
    // argument in the review cycle's block.
    const run = fold([census({ phase: 'archaeology' })]);
    expect(run.censuses).toHaveLength(0);
  });

  test('a passing gate carries a null reason, which is an answer', () => {
    const run = fold([census({ pass: true, reason: null, counts: { P0: 0, P1: 0, P2: 3, P3: 1 } })]);
    expect(run.censuses[0]?.pass).toBe(true);
    expect(run.censuses[0]?.reason).toBeNull();
  });

  test('carried P1s are named, because carried is not forgiven', () => {
    const run = fold([
      census({ pass: true, reason: null, tolerated: ['slow-path', 'naming'] }),
    ]);
    expect(run.censuses[0]?.tolerated).toEqual(['slow-path', 'naming']);
  });
});

describe('a finding says who raised it and whether it points anywhere', () => {
  test('an unattributed finding names nobody', () => {
    // #141's rule. Every finding in every archive written before that field
    // existed has none, and naming the role that probably wrote it would put a
    // claim in somebody's mouth.
    const run = fold([
      census({ findings: [{ id: 'a', severity: 'P1', title: 'A thing', evidence: 2 }] }),
    ]);
    expect(run.censuses[0]?.findings[0]?.raisedBy).toBeNull();
    expect(run.censuses[0]?.findings[0]?.evidence).toBe(2);
  });

  test('a finding citing nothing is the ungrounded case, and reads as zero', () => {
    const run = fold([
      census({
        findings: [{ id: 'a', severity: 'P1', title: 'A thing', evidence: 0, raisedBy: 'critic' }],
      }),
    ]);
    expect(run.censuses[0]?.findings[0]?.evidence).toBe(0);
    expect(run.censuses[0]?.findings[0]?.raisedBy).toBe('critic');
  });

  test('a guard’s downgrade and a person’s move are two fields, never one', () => {
    // #142: one says a guard fired and why, the other says how this reached the
    // severity it has. Overwriting the first on a restore erases the fact the
    // guard fired, which is what #48 added it for.
    const run = fold([
      census({
        findings: [
          {
            id: 'a',
            severity: 'P0',
            title: 'A thing',
            evidence: 1,
            downgraded: { from: 'P1', reason: 'cited nothing that resolves' },
            severityChanges: [{ from: 'P2', to: 'P0', by: 'human', reason: 'it is real' }],
          },
        ],
      }),
    ]);
    const f = run.censuses[0]?.findings[0];
    expect(f?.downgraded).toEqual({ from: 'P1', reason: 'cited nothing that resolves' });
    expect(f?.severityChanges).toEqual([
      { from: 'P2', to: 'P0', by: 'human', reason: 'it is real' },
    ]);
  });

  test('no moves is null, not an empty list', () => {
    // "Nobody moved this" and "this build could not read the list" are
    // different, and the whole point of #142's record is saying who made which
    // claim.
    const run = fold([census({ findings: [{ id: 'a', severity: 'P3', title: 'x' }] })]);
    expect(run.censuses[0]?.findings[0]?.severityChanges).toBeNull();
    expect(run.censuses[0]?.findings[0]?.downgraded).toBeNull();
  });

  test('one unreadable row does not cost the other findings', () => {
    // Per-entry rather than whole-list, unlike the gate attempts. Losing a
    // person's view of a whole round over one bad row is worse than showing the
    // rest, and the gate's own counts are carried separately - so the pane can
    // still say it is not showing everything.
    const run = fold([
      census({
        findings: [
          { id: 'a', severity: 'P1', title: 'kept' },
          { severity: 'P1', title: 'no id' },
          { id: 'c', severity: 'P2', title: 'also kept' },
        ],
      }),
    ]);
    expect(run.censuses[0]?.findings.map((f) => f.id)).toEqual(['a', 'c']);
  });

  test('a finding with no title falls back to its id, never to a blank', () => {
    const run = fold([census({ findings: [{ id: 'the-id', severity: 'P2' }] })]);
    expect(run.censuses[0]?.findings[0]?.title).toBe('the-id');
  });
});

describe('the blocking count is the latest round’s, and it is decided here', () => {
  test('P0 and P1 of the most recent census', () => {
    const run = fold([
      census({ counts: { P0: 1, P1: 3, P2: 0, P3: 0 } }),
      census({ counts: { P0: 0, P1: 1, P2: 4, P3: 2 } }),
    ]);
    // Not 5. A running total would move for reasons that change nothing, and
    // the number that decides whether the loop fixes again is this round's.
    expect(blocking(run)).toBe(1);
  });

  test('no rounds is zero, and that is a real zero', () => {
    expect(blocking(emptyRun())).toBe(0);
  });
});
