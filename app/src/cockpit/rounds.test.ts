import { describe, expect, test } from 'vitest';
import { emptyRun } from './model';
import { censusByPhase, questionsPhase, rounds, roundTitle, title } from './rounds';
import type { Census, Cycle, PhaseGroup, Run, Turn, VerifyPass, Work } from './model';

/**
 * The round card, which is the object hi-fi 5's log is made of (#223).
 *
 * **One card per phase group, at the owner's decision.** This file previously
 * asserted the pair — a plan round's producer and its critique merged into one
 * card — which is what hi-fi 5 draws and what `rounds()` used to build. It stops
 * being the right shape once the *column* gives the critique a heading of its own:
 * a merged card is placed at the round's start, so a critique beginning twenty
 * minutes later silently updated a card already off the top of the scroll. The
 * report was exact — *"it moved to Group 2 · Plan Critique but that never updated
 * the pilot chat like the plan rounds did"* — and a log that does not move when
 * the loop moves is not a log.
 *
 * So the pairing assertions below are replaced, and what replaces them is the
 * round **chip**: both halves carry the same round, which is what a reader pairs
 * them by, and which the core only makes possible because it now says the round
 * on `planning` as well as on `critique`.
 *
 * Every assertion that was about a **re-shaping** rather than about the grouping
 * is kept unchanged: the card carries what a frame put on `Run` and nothing else,
 * an open turn has no duration, and a census that predates every phase attaches
 * to nothing. So is the one about the revision, which the core fix made true and
 * which holds under either grouping.
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

/**
 * A plan round as the core narrates it: the planner's phase, then the critic's.
 *
 * **Two phases in two column groups**, which is what `reduce` produces now that
 * the critique has a heading of its own — so the fixtures build them into
 * separate `Cycle`s and `rounds()` has to pair them across that boundary. A
 * fixture putting both in one cycle would test a shape the reducer cannot make.
 */
const planRound = (
  n: number,
  at: number,
  ids: [number, number],
): { produced: PhaseGroup; judged: PhaseGroup } => ({
  produced: phase({
    id: ids[0],
    phase: 'planning',
    round: n,
    startedAt: at,
    turns: [
      turn({
        id: ids[0],
        role: 'planner',
        kind: n === 0 ? 'plan' : 'revise',
        startedAt: at,
        endedAt: at + 1_000,
      }),
    ],
  }),
  judged: phase({
    id: ids[1],
    phase: 'critique',
    round: n,
    startedAt: at + 2_000,
    turns: [
      turn({
        id: ids[1],
        role: 'critic',
        kind: 'critique',
        startedAt: at + 2_000,
        endedAt: at + 3_000,
      }),
    ],
  }),
});

/** The two groups a list of plan rounds lands in. */
const planCycles = (...rs: { produced: PhaseGroup; judged: PhaseGroup }[]): Cycle[] => [
  cycle({ kind: 'plan', phases: rs.map((r) => r.produced) }),
  cycle({ kind: 'critique', phases: rs.map((r) => r.judged) }),
];

describe('each half of a round is its own card, paired by the round chip', () => {
  test('a plan round is two cards, and the second is the critique arriving', () => {
    // The whole point of the change: the critique is an *entry* in the log, not
    // an in-place update to one placed twenty minutes earlier. Both carry the
    // same round, which is what pairs them.
    const cards = rounds(run({ cycles: planCycles(planRound(0, 1_000, [1, 2])) }));
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.phase)).toEqual(['planning', 'critique']);
    expect(cards.map((c) => c.round)).toEqual([0, 0]);
    expect(cards.map((c) => c.cycle)).toEqual(['plan', 'critique']);
    expect(cards.map((c) => c.turns[0]?.role)).toEqual(['planner', 'critic']);
  });

  test('two plan rounds are four cards, two per round', () => {
    const cards = rounds(
      run({ cycles: planCycles(planRound(0, 1_000, [1, 2]), planRound(1, 10_000, [3, 4])) }),
    );
    expect(cards).toHaveLength(4);
    // The chip, in the order a reader sees it: round 0's pair, then round 1's.
    expect(cards.map((c) => c.round)).toEqual([0, 0, 1, 1]);
    expect(cards.map((c) => c.phase)).toEqual(['planning', 'critique', 'planning', 'critique']);
  });

  test('the revision that opens a round is in that round, not the previous critique', () => {
    // The core fix, and it holds under either grouping: `revisePlan` announces
    // `planning` with the incremented round, so the turn producing the next
    // version is a round 1 card rather than a row inside round 0's critique.
    const cards = rounds(
      run({ cycles: planCycles(planRound(0, 1_000, [1, 2]), planRound(1, 10_000, [3, 4])) }),
    );
    const revise = cards.find((c) => c.turns.some((t) => t.kind === 'revise'));
    expect(revise?.phase).toBe('planning');
    expect(revise?.round).toBe(1);
    // And round 0's critique holds only the critic's turn.
    expect(cards[1]?.turns.map((t) => t.kind)).toEqual(['critique']);
  });

  test('a card starts and ends with the phase it is', () => {
    const cards = rounds(run({ cycles: planCycles(planRound(0, 1_000, [1, 2])) }));
    expect(cards[0]?.startedAt).toBe(1_000);
    expect(cards[0]?.endedAt).toBe(2_000);
    expect(cards[1]?.startedAt).toBe(3_000);
    expect(cards[1]?.endedAt).toBe(4_000);
  });

  test('a critique still running has not ended, and the plan before it has', () => {
    // The plan card settles on its own turn rather than waiting for a judge, so
    // a finished half reads as finished. That is the half of the old merged
    // behaviour worth keeping and it is now free.
    const r = planRound(0, 1_000, [1, 2]);
    const cards = rounds(
      run({
        cycles: [
          cycle({ kind: 'plan', phases: [r.produced] }),
          cycle({
            kind: 'critique',
            phases: [{ ...r.judged, turns: [turn({ id: 2, endedAt: null })] }],
          }),
        ],
      }),
    );
    expect(cards[0]?.endedAt).toBe(2_000);
    expect(cards[1]?.endedAt).toBeNull();
  });

  test('a card is named for the phase it is', () => {
    const cards = rounds(run({ cycles: planCycles(planRound(0, 1_000, [1, 2])) }));
    expect(roundTitle(cards[0]!)).toBe('plan');
    expect(roundTitle(cards[1]!)).toBe('critique');
  });

  test('the halves land in start order however the two groups were opened', () => {
    // A resumed run can open the critique group before the plan one - it picks
    // up mid-cycle. `rounds()` sorts by start rather than trusting the order the
    // cycles happen to sit in, so the log still reads as a history.
    const r = planRound(0, 1_000, [1, 2]);
    const cards = rounds(
      run({
        cycles: [
          cycle({ kind: 'critique', phases: [r.judged] }),
          cycle({ kind: 'plan', phases: [r.produced] }),
        ],
      }),
    );
    expect(cards.map((c) => c.phase)).toEqual(['planning', 'critique']);
    expect(cards[0]?.startedAt).toBe(1_000);
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
    expect(cards.map((c) => c.phase)).toEqual(['planning', 'implementing', 'review']);
  });

  test('the census is attached to the round it arrived during, by arrival', () => {
    // By arrival, because a census carries no round number of its own. The
    // alternative is matching on a number the frame never sent.
    const cards = rounds(
      run({
        cycles: planCycles(planRound(0, 1_000, [1, 2]), planRound(1, 10_000, [3, 4])),
        censuses: [census({ at: 11_000 })],
      }),
    );
    // Round 0's pair started at 1_000 and 3_000; round 1's planning at 10_000.
    // A census at 11_000 is during round 1's planning card and no other.
    expect(cards.map((c) => c.census === null)).toEqual([true, true, false, true]);
    expect(cards[2]?.census?.counts['P1']).toBe(1);
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

  test('a gate stays on the half that opened it', () => {
    // Not summed across the round: a gate is a thing that happened during one
    // phase, and a card that listed both halves' gates would say the planner
    // ran a gate the critic ran.
    const r = planRound(0, 1_000, [1, 2]);
    const cards = rounds(
      run({
        cycles: [
          cycle({ kind: 'plan', phases: [{ ...r.produced, gates: ['typecheck'] }] }),
          cycle({ kind: 'critique', phases: [{ ...r.judged, gates: ['test'] }] }),
        ],
      }),
    );
    expect(cards[0]?.gates).toEqual(['typecheck']);
    expect(cards[1]?.gates).toEqual(['test']);
  });
});

describe('the column and the log agree about which round a census is in', () => {
  // `censusByPhase` is what the column uses and it is built from `rounds()`, so
  // "by arrival" has exactly one definition rather than two that can disagree.
  test('a critique’s counts land on the critique row, where they were measured', () => {
    const r = planRound(0, 1_000, [1, 2]);
    const byPhase = censusByPhase(
      run({
        cycles: [
          cycle({ kind: 'plan', phases: [r.produced] }),
          cycle({ kind: 'critique', phases: [r.judged] }),
        ],
        censuses: [census({ at: 3_500 })],
      }),
    );
    // The critique started at 3_000 and the census arrived at 3_500.
    expect(byPhase.get(2)?.counts['P1']).toBe(1);
    expect(byPhase.get(1)).toBeUndefined();
  });

  test('a census predating every phase lands on none of them', () => {
    const byPhase = censusByPhase(
      run({
        cycles: [cycle({ phases: [phase({ id: 1, startedAt: 9_000 })] })],
        censuses: [census({ at: 1_000 })],
      }),
    );
    expect(byPhase.size).toBe(0);
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

describe('the question round belongs to the round it opened during', () => {
  const asked = (at: number): NonNullable<Run['questions']> => ({
    total: 2,
    blocking: 1,
    round: 1,
    cap: 3,
    open: [],
    at,
  });

  test('questions opened in round 2 do not move under round 1, or the other way', () => {
    // The defect this closes: the group was drawn at the foot of the whole PLAN
    // cycle, so the moment a second plan round opened, round 1's questions were
    // beneath round 2's row.
    const cycles = planCycles(planRound(0, 1_000, [1, 2]), planRound(1, 10_000, [3, 4]));
    expect(questionsPhase(run({ cycles, questions: asked(1_500) }))).toBe(1);
    expect(questionsPhase(run({ cycles, questions: asked(10_500) }))).toBe(3);
  });

  test('a round that opened before any phase of this session attaches to nothing', () => {
    // Real on a resume. Filing it under the first phase in view would credit an
    // earlier session's questions to work that has not happened yet.
    const cycles = planCycles(planRound(0, 9_000, [1, 2]));
    expect(questionsPhase(run({ cycles, questions: asked(1_000) }))).toBeNull();
  });

  test('a run that has asked nothing has no phase for it', () => {
    expect(questionsPhase(run({ cycles: [cycle()] }))).toBeNull();
  });
});

test('a phase this build does not know renders as itself', () => {
  // The rule `boundary()` and `ending()` follow. A confident label invented for
  // a phase a newer core announced would be worse than its own name.
  expect(title('implementing')).toBe('code');
  expect(title('reconciling')).toBe('reconciling');
});
