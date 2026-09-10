import { describe, expect, test } from 'vitest';
import { emptyRun } from './model';
import { rounds, title } from './rounds';
import type { Census, Cycle, PhaseGroup, Run, Turn, VerifyPass, Work } from './model';

/**
 * The round card, which is the object hi-fi 5's log is made of (#223).
 *
 * Every assertion here is about a **re-shaping**: the card must carry what a
 * frame already put on `Run` and must not carry anything else. The two cases
 * worth the most are the ones where a number could be invented — a round whose
 * turns have not all ended, and a census that arrived before any phase did.
 */

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: 1,
  role: 'planner',
  kind: 'plan',
  round: 0,
  startedAt: 1_000,
  endedAt: 5_000,
  beat: null,
  work: null,
  ...over,
});

const phase = (over: Partial<PhaseGroup> = {}): PhaseGroup => ({
  id: 1,
  phase: 'planning',
  round: 0,
  startedAt: 1_000,
  turns: [turn()],
  gates: [],
  ...over,
});

const cycle = (over: Partial<Cycle> = {}): Cycle => ({
  kind: 'plan',
  phases: [phase()],
  ...over,
});

const census = (over: Partial<Census> = {}): Census => ({
  phase: 'plan',
  counts: { P0: 0, P1: 1, P2: 2, P3: 0 },
  tolerance: 1,
  pass: true,
  reason: null,
  tolerated: [],
  findings: [],
  at: 4_000,
  ...over,
});

const pass = (over: Partial<VerifyPass> = {}): VerifyPass => ({
  round: 1,
  gates: [],
  at: 4_000,
  ...over,
});

const work = (over: Partial<Work> = {}): Work => ({
  files: 11,
  insertions: 604,
  deletions: 71,
  uncounted: null,
  plan: null,
  at: 3_000,
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({ ...emptyRun(), ...over });

describe('a card is a phase group, with what arrived during it', () => {
  test('one card per phase, ordered by when each round started', () => {
    // Ordered by time and NOT by cycle: the loop re-enters cycle 2 on every
    // review fix, so grouping by cycle would put a fix round above the review
    // that asked for it - which is the opposite of a log.
    const cards = rounds(
      run({
        cycles: [
          cycle({ kind: 'plan', phases: [phase({ id: 1, startedAt: 1_000 })] }),
          cycle({
            kind: 'review',
            phases: [phase({ id: 3, phase: 'review', startedAt: 9_000, turns: [] })],
          }),
          cycle({
            kind: 'code',
            phases: [phase({ id: 2, phase: 'implementing', startedAt: 5_000, turns: [] })],
          }),
        ],
      }),
    );
    expect(cards.map((c) => c.phase)).toEqual(['planning', 'implementing', 'review']);
    // The key is the group's own identity, so two rounds of the same phase in
    // the same cycle are two cards rather than one drawn twice.
    expect(new Set(cards.map((c) => c.key)).size).toBe(3);
  });

  test('the census is attached to the round it arrived during, by arrival', () => {
    // By arrival, because a census carries no round number of its own. The
    // alternative is matching on a number the frame never sent.
    const cards = rounds(
      run({
        cycles: [
          cycle({
            phases: [
              phase({ id: 1, startedAt: 1_000 }),
              phase({ id: 2, phase: 'critique', startedAt: 6_000, turns: [] }),
            ],
          }),
        ],
        censuses: [census({ at: 7_000 })],
      }),
    );
    expect(cards[0]?.census).toBeNull();
    expect(cards[1]?.census?.counts['P1']).toBe(1);
  });

  test('a census that predates every phase is attached to nothing', () => {
    // A real state on a resumed run: `reduce` stamps arrival, and history can
    // land before the first phase of this session starts. Attaching it to the
    // first round it can find would file one session's verdict under another
    // session's work.
    const cards = rounds(
      run({
        cycles: [cycle({ phases: [phase({ startedAt: 9_000 })] })],
        censuses: [census({ at: 1_000 })],
      }),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.census).toBeNull();
  });

  test('a verification pass lands on the round that ran it', () => {
    const cards = rounds(
      run({
        cycles: [
          cycle({
            kind: 'code',
            phases: [phase({ phase: 'implementing', startedAt: 1_000, turns: [] })],
          }),
        ],
        verify: [pass({ at: 2_000 })],
      }),
    );
    expect(cards[0]?.verify?.round).toBe(1);
  });
});

describe('what a card refuses to say', () => {
  test('a round with an open turn has no end time', () => {
    // A round is not finished because its first turn is. Reporting the earlier
    // turn's end as the round's would date the round before work still running.
    const cards = rounds(
      run({
        cycles: [
          cycle({
            phases: [
              phase({
                turns: [turn({ id: 1, endedAt: 5_000 }), turn({ id: 2, endedAt: null })],
              }),
            ],
          }),
        ],
      }),
    );
    expect(cards[0]?.endedAt).toBeNull();
    // And the open turn's own duration is absent rather than measured to now.
    expect(cards[0]?.turns[1]?.ms).toBeNull();
    expect(cards[0]?.turns[0]?.ms).toBe(4_000);
  });

  test('a round with no work reading reports none, and never a zero', () => {
    expect(rounds(run({ cycles: [cycle()] }))[0]?.work).toBeNull();
  });

  test('the latest work reading wins, because git already reports cumulatively', () => {
    // Summing two readings would double-count every file: `workData` describes
    // the tree, not the delta since the last reading.
    const cards = rounds(
      run({
        cycles: [
          cycle({
            phases: [
              phase({
                turns: [
                  turn({ id: 1, work: work({ files: 4, at: 2_000 }) }),
                  turn({ id: 2, work: work({ files: 11, at: 3_000 }) }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
    expect(cards[0]?.work?.files).toBe(11);
  });

  test('a round nobody numbered carries a null round, not a zero', () => {
    const cards = rounds(run({ cycles: [cycle({ phases: [phase({ round: null })] })] }));
    expect(cards[0]?.round).toBeNull();
  });

  test('a run that has reached no phase has no cards', () => {
    expect(rounds(emptyRun())).toEqual([]);
  });
});

test('a phase this build does not know renders as itself', () => {
  // The rule `boundary()` and `ending()` follow. A confident label invented for
  // a phase a newer core announced would be worse than its own name.
  expect(title('implementing')).toBe('code');
  expect(title('reconciling')).toBe('reconciling');
});
