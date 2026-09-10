import { describe, expect, test } from 'vitest';
import { blocking, blockingIn, emptyRun, persistence, reduce } from './model';
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

  test('a badge on a per-judge tab counts that judge’s round (#223)', () => {
    // `blocking` answers *the latest round, whichever judge produced it*, which
    // was exactly right while there was one Findings tab showing whichever spoke
    // last. With the critique and the review as separate panes it is wrong half
    // the time: a critique's P1s would badge `Code review`, and the reader would
    // open the pane and find nothing.
    const run = fold([
      census({ phase: 'plan', counts: { P0: 0, P1: 2, P2: 0, P3: 0 } }),
      census({ phase: 'review', counts: { P0: 1, P1: 0, P2: 0, P3: 0 } }),
    ]);
    expect(blockingIn(run, 'plan')).toBe(2);
    expect(blockingIn(run, 'review')).toBe(1);
    // And the latest of that judge's rounds, not a total across them - the same
    // rule `blocking` follows, applied one filter along.
    const twice = fold([
      census({ phase: 'plan', counts: { P0: 1, P1: 3, P2: 0, P3: 0 } }),
      census({ phase: 'plan', counts: { P0: 0, P1: 1, P2: 0, P3: 0 } }),
    ]);
    expect(blockingIn(twice, 'plan')).toBe(1);
    // A judge that has not reported is zero, and it is a real zero: the tab
    // shows no badge rather than borrowing the other judge's count.
    expect(blockingIn(twice, 'review')).toBe(0);
  });
});

describe('a finding that survived a fix round is the loop arguing with itself', () => {
  // `4c`: **persisted** is the state that matters, and it is what the
  // oscillation guard counts. What is asserted here is the narrower claim the
  // app can actually make - this id was in the previous round's census too -
  // because `persistentStreak` runs over `state.roundHistory`, which is not on
  // this wire.
  const round = (phase: string, ...ids: readonly string[]): Frame =>
    say('findings_reported', {
      phase,
      counts: { P0: 0, P1: ids.length, P2: 0, P3: 0 },
      tolerance: 1,
      pass: false,
      reason: 'blocked',
      tolerated: [],
      findings: ids.map((id) => ({ id, severity: 'P1', title: id })),
    });

  test('a finding in three consecutive rounds counts three', () => {
    const run = fold([
      round('review', 'a', 'b'),
      round('review', 'a'),
      round('review', 'a', 'c'),
    ]);
    const seen = persistence(run.censuses);
    expect(seen.get('a')).toBe(3);
    // `c` is new this round, so it has survived nothing.
    expect(seen.get('c')).toBe(1);
  });

  test('a gap ends the streak rather than being counted through', () => {
    // A finding that went away and came back is not the same as one that never
    // cleared - the second is the loop failing to fix it, and only the second
    // is what the guard is about.
    const run = fold([round('review', 'a'), round('review', 'b'), round('review', 'a')]);
    expect(persistence(run.censuses).get('a')).toBe(1);
  });

  test('the two cycles are counted apart', () => {
    // A plan finding and a review finding sharing an id are two claims about
    // two different artifacts, so a plan round must not extend a review streak.
    const run = fold([round('plan', 'a'), round('plan', 'a'), round('review', 'a')]);
    expect(persistence(run.censuses).get('a')).toBe(1);
  });

  test('no rounds is an empty map, not a zero for everything', () => {
    expect(persistence([]).size).toBe(0);
  });
});

/**
 * A finding is a claim with provenance, and #113's verdict is part of it (#223).
 *
 * Hi-fi 9 is explicit: *"Every other screen shows findings as facts. This one
 * shows them as claims with provenance — who said it, what it rests on, whether
 * that checked out, and which of two very different guards demoted it."* Four of
 * its five cases were already on the wire. The third — **grounded but
 * uncheckable** — was not: `reproducerOutcomes` has been durable since #113 and
 * was never narrated, so the pane could not tell a claim nobody could check from
 * a claim nobody tried to check.
 */
describe('what a finding says about itself', () => {
  const withFinding = (over: Record<string, unknown>): Frame =>
    census({ findings: [{ id: 'F-07', severity: 'P1', title: 'Token write is not atomic', ...over }] });

  test('a reproducer that ran is carried with its moment and its verdict', () => {
    const run = fold([
      withFinding({
        reproducer: [
          { verdict: 'reproduced', at: 'review', reason: null },
          { verdict: 'did-not-reproduce', at: 'final-fix', reason: null },
        ],
      }),
    ]);
    // Both, not the latest. They answer different questions - *does this
    // happen* and *is it gone* - and only the pair can close a carried finding.
    expect(run.censuses[0]?.findings[0]?.reproducer).toEqual([
      { verdict: 'reproduced', at: 'review', reason: null },
      { verdict: 'did-not-reproduce', at: 'final-fix', reason: null },
    ]);
  });

  test('unproven keeps its reason, which is the whole value of unproven', () => {
    // "The file could not be placed", "no gate could be resolved" and "it failed
    // with no observed baseline" need different responses from a reader.
    const run = fold([
      withFinding({
        reproducer: [{ verdict: 'unproven', at: 'review', reason: 'no gate could be resolved' }],
      }),
    ]);
    expect(run.censuses[0]?.findings[0]?.reproducer?.[0]?.reason).toBe(
      'no gate could be resolved',
    );
  });

  test('no reproducer is null, and that is not a strike against the finding', () => {
    // #113 is explicit that a finding without one behaves exactly as every
    // finding did before reproducers existed. The pane says so in words.
    expect(fold([withFinding({})]).censuses[0]?.findings[0]?.reproducer).toBeNull();
    expect(fold([withFinding({ reproducer: [] })]).censuses[0]?.findings[0]?.reproducer).toBeNull();
  });

  test('half a reproducer pair is none of it', () => {
    // Whole-list, unlike the findings themselves: these are two observations of
    // one test, and half of that pair is a claim nobody made.
    const run = fold([
      withFinding({
        reproducer: [{ verdict: 'reproduced', at: 'review' }, { at: 'final-fix' }],
      }),
    ]);
    expect(run.censuses[0]?.findings[0]?.reproducer).toBeNull();
  });

  test('deferred is a disposition and defaults to no', () => {
    // Hi-fi 9's fifth case. A core that never sends the field is not read as
    // having said no - it happens to mean the same thing, and `=== true` is the
    // coercion that cannot become wrong later.
    expect(fold([withFinding({})]).censuses[0]?.findings[0]?.deferred).toBe(false);
    expect(fold([withFinding({ deferred: true })]).censuses[0]?.findings[0]?.deferred).toBe(true);
  });

  test('the other four cases still arrive intact', () => {
    // Grounded-and-blocking, ungrounded, a guard's downgrade and a person's
    // restore. Nothing about #113 was allowed to disturb them.
    const run = fold([
      withFinding({
        raisedBy: 'human',
        evidence: 0,
        downgraded: { from: 'P0', reason: 'cites nothing that resolves' },
        severityChanges: [{ from: 'P2', to: 'P0', by: 'human', reason: 'the citation is real' }],
      }),
    ]);
    const f = run.censuses[0]?.findings[0];
    expect(f?.raisedBy).toBe('human');
    expect(f?.evidence).toBe(0);
    expect(f?.downgraded?.from).toBe('P0');
    expect(f?.severityChanges?.[0]?.to).toBe('P0');
  });
});
