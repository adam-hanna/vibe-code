import { describe, expect, test } from 'vitest';
import { emptyRun } from './model';
import { rounds, roundTitle, title } from './rounds';
import type { Census, Cycle, PhaseGroup, Run, Turn, VerifyPass, Work } from './model';

/**
 * The round card, which is the object hi-fi 5's log is made of (#223).
 *
 * **A round is the pair**, and that is what changed here. This file previously
 * asserted one card per *phase group*, which was true of what the code did and
 * false about the domain: `CYCLE_OF` has said since it was written that *"a plan
 * round IS the pair - the planner produces a version, the critic judges it"*, and
 * grouping by phase made two plan rounds count as three, filed the planner's
 * revision under the critique that caused it, and left the critique looking like
 * a stage rather than the second half of every round.
 *
 * Every assertion that was about a **re-shaping** rather than about the grouping
 * is kept unchanged: the card carries what a frame put on `Run` and nothing else,
 * an open turn has no duration, and a census that predates every phase attaches
 * to nothing.
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

/** A plan round as the core narrates it: the planner's phase, then the critic's. */
const planRound = (n: number, at: number, ids: [number, number]): PhaseGroup[] => [
  phase({
    id: ids[0],
    phase: 'planning',
    round: n,
    startedAt: at,
    turns: [turn({ id: ids[0], role: 'planner', kind: n === 0 ? 'plan' : 'revise', startedAt: at, endedAt: at + 1_000 })],
  }),
  phase({
    id: ids[1],
    phase: 'critique',
    round: n,
    startedAt: at + 2_000,
    turns: [turn({ id: ids[1], role: 'critic', kind: 'critique', startedAt: at + 2_000, endedAt: at + 3_000 })],
  }),
];

describe('a round is the producer and the judge, together', () => {
  test('a plan round’s two phases are one card', () => {
    // The whole point. `Planning` and `Plan critique` arrive as two
    // `phase_started` frames carrying the same round, and one round is one card.
    const cards = rounds(run({ cycles: [cycle({ phases: planRound(0, 1_000, [1, 2]) })] }));
    expect(cards).toHaveLength(1);
    expect(cards[0]?.phases).toEqual(['planning', 'critique']);
    expect(cards[0]?.turns.map((t) => t.role)).toEqual(['planner', 'critic']);
  });

  test('two plan rounds are two cards, not four', () => {
    // The count the cycle header prints. Grouping by phase called this three -
    // `Planning` once plus a critique per round - which is off by one in a way
    // nobody would question on screen.
    const cards = rounds(
      run({
        cycles: [
          cycle({ phases: [...planRound(0, 1_000, [1, 2]), ...planRound(1, 10_000, [3, 4])] }),
        ],
      }),
    );
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.round)).toEqual([0, 1]);
  });

  test('the revision that opens a round is in that round, not the previous critique', () => {
    // `revisePlan` announces `planning` with the incremented round, so the turn
    // that produces the next version pairs with the critique that judges IT -
    // rather than landing inside the critique that asked for it.
    const cards = rounds(
      run({
        cycles: [
          cycle({ phases: [...planRound(0, 1_000, [1, 2]), ...planRound(1, 10_000, [3, 4])] }),
        ],
      }),
    );
    expect(cards[0]?.turns.map((t) => t.kind)).toEqual(['plan', 'critique']);
    expect(cards[1]?.turns.map((t) => t.kind)).toEqual(['revise', 'critique']);
  });

  test('the round starts when its producer did, and ends when its judge did', () => {
    const cards = rounds(run({ cycles: [cycle({ phases: planRound(0, 1_000, [1, 2]) })] }));
    expect(cards[0]?.startedAt).toBe(1_000);
    expect(cards[0]?.endedAt).toBe(4_000);
  });

  test('a round whose judge is still running has not ended', () => {
    const [producer, judge] = planRound(0, 1_000, [1, 2]);
    const cards = rounds(
      run({
        cycles: [
          cycle({
            phases: [
              producer as PhaseGroup,
              { ...(judge as PhaseGroup), turns: [turn({ id: 2, endedAt: null })] },
            ],
          }),
        ],
      }),
    );
    expect(cards[0]?.endedAt).toBeNull();
  });

  test('a card is named for what it produced, and the judge is a turn row', () => {
    // Not `critique` at the top. The heading names the round; the critique is
    // legible on its own turn row, on every round, which is the answer to
    // "where does plan critique live".
    const cards = rounds(run({ cycles: [cycle({ phases: planRound(0, 1_000, [1, 2]) })] }));
    expect(roundTitle(cards[0]!)).toBe('plan');
    expect(cards[0]?.turns.some((t) => t.kind === 'critique')).toBe(true);
  });

  test('a phase carrying no round is its own card, and never merges with another', () => {
    // `implementing` has never carried one, and neither does any phase from a
    // core older than the plan-round fix. Two of them are two rounds - merging
    // them on a shared `null` would draw two implement rounds as one.
    const cards = rounds(
      run({
        cycles: [
          cycle({
            kind: 'code',
            phases: [
              phase({ id: 1, phase: 'implementing', round: null, startedAt: 1_000, turns: [] }),
              phase({ id: 2, phase: 'implementing', round: null, startedAt: 9_000, turns: [] }),
            ],
          }),
        ],
      }),
    );
    expect(cards).toHaveLength(2);
    expect(new Set(cards.map((c) => c.key)).size).toBe(2);
  });
});

describe('what arrived during a round', () => {
  test('rounds are ordered by when each started, across cycles', () => {
    // Ordered by time and NOT by cycle: the loop re-enters cycle 2 on every
    // review fix, so grouping by cycle would put a fix round above the review
    // that asked for it - which is the opposite of a log.
    const cards = rounds(
      run({
        cycles: [
          cycle({ kind: 'plan', phases: [phase({ id: 1, startedAt: 1_000 })] }),
          cycle({
            kind: 'review',
            phases: [phase({ id: 3, phase: 'review', round: 0, startedAt: 9_000, turns: [] })],
          }),
          cycle({
            kind: 'code',
            phases: [
              phase({ id: 2, phase: 'implementing', round: null, startedAt: 5_000, turns: [] }),
            ],
          }),
        ],
      }),
    );
    expect(cards.map((c) => c.phases[0])).toEqual(['planning', 'implementing', 'review']);
  });

  test('the census is attached to the round it arrived during, by arrival', () => {
    // By arrival, because a census carries no round number of its own. The
    // alternative is matching on a number the frame never sent.
    const cards = rounds(
      run({
        cycles: [
          cycle({ phases: [...planRound(0, 1_000, [1, 2]), ...planRound(1, 10_000, [3, 4])] }),
        ],
        censuses: [census({ at: 11_000 })],
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
            phases: [
              phase({ phase: 'implementing', round: null, startedAt: 1_000, turns: [] }),
            ],
          }),
        ],
        verify: [pass({ at: 2_000 })],
      }),
    );
    expect(cards[0]?.verify?.round).toBe(1);
  });

  test('gates from both halves of a round are on the one card', () => {
    const [producer, judge] = planRound(0, 1_000, [1, 2]);
    const cards = rounds(
      run({
        cycles: [
          cycle({
            phases: [
              { ...(producer as PhaseGroup), gates: ['typecheck'] },
              { ...(judge as PhaseGroup), gates: ['test'] },
            ],
          }),
        ],
      }),
    );
    expect(cards[0]?.gates).toEqual(['typecheck', 'test']);
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
    expect(cards[0]?.turns[1]?.endedAt).toBeNull();
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
