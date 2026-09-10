import type { Census, Cycle, CycleKind, PhaseGroup, Run, Turn, VerifyPass, Work } from './model';

/**
 * A round, as one card (hi-fi 5, #223).
 *
 * **The object the design's log is made of, and the app did not have it.** Hi-fi
 * 5 is explicit about what the pilot pane is for: *"It has to be a usable log of
 * the run on its own — every round leaves a card, and a card carries what
 * happened, what it found and what you can do about it."* The pane drew the
 * conversation and nothing else, so a round left no trace in the one place a
 * person is looking, and every question about what the loop had just done had to
 * be answered from a different tab.
 *
 * ## It is a re-shaping, never a second source
 *
 * Everything here is already on `Run`, put there by `reduce` from a frame. This
 * groups it; it measures nothing, infers no phase from a sentence, and fills in
 * no field a frame did not carry. A card whose round nobody stated has `round:
 * null` and says so, exactly as the loop column's does.
 *
 * ## Why a card is a phase group and not a "version"
 *
 * The design draws `plan v.b` — one card per version of the artifact. What the
 * wire carries is `phase_started`, so `planning` and `critique` arrive as two
 * groups, and a card per group is the shape of what was actually announced.
 * Collapsing the pair into one lettered version would mean deciding here which
 * critique belongs to which draft, and the frames do not say — the same
 * derivation `LoopColumn` declines to make.
 */

/** One turn inside a round, at the density a card shows it. */
export interface RoundTurn {
  id: number;
  role: string;
  kind: string;
  /** How long it took, or null while it is still open. Never a guess. */
  ms: number | null;
}

export interface RoundCard {
  /** Stable across re-renders: the phase group's own identity. */
  key: string;
  cycle: CycleKind;
  /** The phase the loop announced, verbatim. Never translated. */
  phase: string;
  /** The archive's round — the number that names the artifact. Null when none came. */
  round: number | null;
  turns: readonly RoundTurn[];
  startedAt: number;
  /**
   * When the last turn of this round ended, or null.
   *
   * Null while any turn in it is still open, **and** on a round whose turns all
   * ended but which the loop has not moved on from — because the phase is what
   * ends, and nothing on the wire says a phase ended. So this is the honest half:
   * *the work in this round is finished*, which is not the same claim as *the
   * round is closed*.
   */
  endedAt: number | null;
  /**
   * The last work reading taken during this round, or null (#136).
   *
   * A code round's `11 files · +604 −71`. Read off the turn rather than summed
   * across turns: `workData` reports the tree as git describes it, so it is
   * already cumulative and adding two readings would double-count the same
   * files.
   */
  work: Work | null;
  /** The verification pass this round ran, or null. `5d` has the detail. */
  verify: VerifyPass | null;
  /** What the gate made of this round's findings, or null. `1e` has the detail. */
  census: Census | null;
}

/** The work reading a round ends on: the latest one any of its turns reported. */
function lastWork(turns: readonly Turn[]): Work | null {
  let latest: Work | null = null;
  for (const turn of turns) {
    if (turn.work === null) continue;
    if (latest === null || turn.work.at >= latest.at) latest = turn.work;
  }
  return latest;
}

/**
 * When a round's work finished, or null.
 *
 * Every turn must have ended: a round with one turn still open is still running,
 * and reporting the previous turn's end as the round's would date it earlier than
 * the work still in flight.
 */
function settledAt(turns: readonly Turn[]): number | null {
  if (turns.length === 0) return null;
  let latest = 0;
  for (const turn of turns) {
    if (turn.endedAt === null) return null;
    if (turn.endedAt > latest) latest = turn.endedAt;
  }
  return latest;
}

/**
 * Which round something that arrived at `at` belongs to.
 *
 * **By arrival, and there is no other honest answer.** A census carries no round
 * number of its own and a verification pass carries the *verify* round, which is
 * not the plan or review round a phase group is keyed by — so matching on a
 * number would be matching two different countings. Both clocks here are this
 * window's own arrival clock, set by `reduce`, so comparing them compares like
 * with like.
 *
 * Returns the index of the last group that had started, or -1 when the thing
 * arrived before any of them — which is a real state on a resumed run and must
 * attach the record to nothing rather than to the first round it can find.
 */
function during(starts: readonly number[], at: number): number {
  let found = -1;
  for (let i = 0; i < starts.length; i += 1) {
    const started = starts[i];
    if (started !== undefined && started <= at) found = i;
  }
  return found;
}

function cardOf(cycle: Cycle, phase: PhaseGroup): RoundCard {
  return {
    key: `${cycle.kind}-${String(phase.id)}`,
    cycle: cycle.kind,
    phase: phase.phase,
    round: phase.round,
    turns: phase.turns.map((t) => ({
      id: t.id,
      role: t.role,
      kind: t.kind,
      ms: t.endedAt === null ? null : t.endedAt - t.startedAt,
    })),
    startedAt: phase.startedAt,
    endedAt: settledAt(phase.turns),
    work: lastWork(phase.turns),
    verify: null,
    census: null,
  };
}

/**
 * Every round this run has reached, oldest first.
 *
 * Ordered by when each round started rather than by cycle, because the log is
 * read top to bottom as a history and the loop re-enters cycle 2 on every review
 * fix — grouping by cycle would put a fix round from twenty minutes ago above the
 * review that asked for it.
 */
export function rounds(run: Run): readonly RoundCard[] {
  const cards: RoundCard[] = [];
  for (const cycle of run.cycles) {
    for (const phase of cycle.phases) cards.push(cardOf(cycle, phase));
  }
  cards.sort((a, b) => a.startedAt - b.startedAt);

  // Attached after the sort, so `during` indexes the same order a reader sees.
  const starts = cards.map((c) => c.startedAt);
  for (const pass of run.verify) {
    const i = during(starts, pass.at);
    const card = cards[i];
    // The latest pass wins a round that ran more than one, which is what `5d`
    // shows: the trend across passes is that pane's subject, and a card is the
    // round's summary rather than its archive.
    if (card !== undefined) cards[i] = { ...card, verify: pass };
  }
  for (const census of run.censuses) {
    const i = during(starts, census.at);
    const card = cards[i];
    if (card !== undefined) cards[i] = { ...card, census };
  }
  return cards;
}

/**
 * What a card says it is, in the design's own words where they exist.
 *
 * A closed map, and an unknown phase renders as itself — the rule `boundary()`
 * and `ending()` already follow. The loop is free to announce a phase this build
 * has never heard of, and the honest drawing of one is its own name.
 */
const TITLES: Readonly<Record<string, string>> = {
  planning: 'plan',
  critique: 'critique',
  implementing: 'code',
  review: 'review',
};

export function title(phase: string): string {
  return TITLES[phase] ?? phase;
}
