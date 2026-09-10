import type { Census, CycleKind, PhaseGroup, Run, Turn, VerifyPass, Work } from './model';

/**
 * A round, as one card (hi-fi 5, #223).
 *
 * **The object the design's log is made of, and the app did not have it.** Hi-fi
 * 5 is explicit about what the pilot pane is for: *"It has to be a usable log of
 * the run on its own — every round leaves a card, and a card carries what
 * happened, what it found and what you can do about it."*
 *
 * ## One card per phase group, at the owner's decision
 *
 * Hi-fi 5 draws the card as the **pair** — `plan v.b · claude/opus · 4m 40s ·
 * accepted after 1 critique` — and this module was built that way: a plan round's
 * producer and its critique merged into one card, keyed by the round they share.
 *
 * That is no longer what it does, and the reason is measured rather than
 * aesthetic. Once the loop column gave the critique a heading of its own, the
 * pilot's log was the only surface still pairing — and a merged card is placed at
 * the round's *start*, so a critique beginning twenty minutes later updated a card
 * that was already off the top of the scroll. The report was exact: *"it moved to
 * Group 2 · Plan Critique but that never updated the pilot chat like the plan
 * rounds did."* A log that does not move when the loop moves is not a log.
 *
 * **The cost is stated rather than argued away.** Hi-fi 5's sentence names one
 * round and two halves, and two cards cannot say *accepted after 1 critique* in
 * one line. What carries the pairing instead is the **round chip**, which both
 * halves now carry because the core says the round on `planning` as well as on
 * `critique` — the same thing that pairs the two groups in the column. If the
 * pairing ever needs to be a sentence again, it belongs in a summary above the
 * cards and not in a card that hides half its own arrival.
 *
 * Three things used to be wrong here and all three were the same mistake —
 * grouping by phase where the loop converges by round:
 *
 * - A cycle counting its phase groups called two plan rounds **three rounds**.
 * - `revisePlan` announced no phase, so the planner turn that produces the *next*
 *   version landed inside the **critique that caused it** — round 2's producer
 *   under round 1's judge.
 * - `planning` carried no round at all, so the first row was unnumbered beside
 *   numbered siblings.
 *
 * All three are fixed in the core, and all three stay fixed under this grouping:
 * the counting is per phase group either way, and the round chip is only readable
 * because the core now states it on both halves.
 *
 * ## It is a re-shaping, never a second source
 *
 * Everything here is already on `Run`, put there by `reduce` from a frame. This
 * groups it; it measures nothing, infers no phase from a sentence, and fills in
 * no field a frame did not carry.
 */

export interface RoundCard {
  /** Stable across re-renders: the phase id `reduce` allocated and never reuses. */
  key: string;
  /** The column group this card belongs to. The same four the column draws. */
  cycle: CycleKind;
  /** The archive's round — the number that names the artifact. Null when none came. */
  round: number | null;
  /** The phase this card is, as the loop announced it. */
  phase: string;
  /** The phase group's id, so a caller can key its own map by the same thing. */
  phaseId: number;
  /**
   * Every turn in the phase, oldest first.
   *
   * The `Turn` off `Run`, not a reduced copy of one. The loop column hands a
   * live turn straight to `RunningRow`, which needs the heartbeat and the work
   * reading — and a second shape here would mean the two surfaces disagreed
   * about a turn the moment either grew a field.
   */
  turns: readonly Turn[];
  /** Verification gates opened during the phase, by name, in order. */
  gates: readonly string[];
  startedAt: number;
  /**
   * When the last turn of this phase ended, or null.
   *
   * Null while any turn in it is still open, **and** on a phase whose turns all
   * ended but which the loop has not moved on from — because nothing on the wire
   * says a phase ended. So this is the honest half: *the work here is finished*,
   * which is not the same claim as *the round is closed*.
   */
  endedAt: number | null;
  /**
   * The last work reading taken during this phase, or null (#136).
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
 * not the plan or review round a card is keyed by — so matching on a number would
 * be matching two different countings. Both clocks here are this window's own
 * arrival clock, set by `reduce`, so comparing them compares like with like.
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

/** Every phase group on the run, in the order they were announced. */
function announced(run: Run): { cycle: CycleKind; phase: PhaseGroup }[] {
  const out: { cycle: CycleKind; phase: PhaseGroup }[] = [];
  for (const cycle of run.cycles) {
    for (const phase of cycle.phases) out.push({ cycle: cycle.kind, phase });
  }
  // `Cycle`s are stored in the order they first appeared, so a run that
  // alternates between two groups has its phases interleaved across them. Sorted
  // rather than concatenated, because the log is read top to bottom as a history.
  out.sort((a, b) => a.phase.startedAt - b.phase.startedAt);
  return out;
}

/**
 * Every round this run has reached, oldest first.
 *
 * Ordered by when each phase started, because the log is read top to bottom as a
 * history and the loop re-enters the code group on every review fix — grouping by
 * cycle would put a fix round from twenty minutes ago above the review that asked
 * for it.
 */
export function rounds(run: Run): readonly RoundCard[] {
  const cards: RoundCard[] = announced(run).map(({ cycle, phase }) => ({
    key: `p${String(phase.id)}`,
    cycle,
    round: phase.round,
    phase: phase.phase,
    phaseId: phase.id,
    turns: [...phase.turns],
    gates: [...phase.gates],
    startedAt: phase.startedAt,
    endedAt: settledAt(phase.turns),
    work: lastWork(phase.turns),
    verify: null,
    census: null,
  }));

  // Attached after the cards exist, so `during` indexes the same order a reader
  // sees.
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
 * Which census belongs to which **phase**, for the loop column.
 *
 * Built from `rounds()` rather than beside it, so "by arrival" has one definition
 * and the column and the pilot's log cannot disagree about which round a census
 * describes.
 *
 * Keyed by phase id, which `reduce` allocates and never reuses.
 */
export function censusByPhase(run: Run): ReadonlyMap<number, Census> {
  const out = new Map<number, Census>();
  for (const card of rounds(run)) {
    // A census that predates every phase attaches to nothing, exactly as it does
    // on a card: a resumed run's history can land before this session's first
    // phase, and filing it under one would credit the wrong session's work.
    if (card.census !== null) out.set(card.phaseId, card.census);
  }
  return out;
}

/**
 * The phase the question round opened during, or null.
 *
 * **By arrival, through `during()`, for the same reason a census is.**
 * `questions_opened` carries the *question* round, which counts separately from
 * the plan round a phase is numbered by, so matching on a number would match two
 * different countings.
 *
 * Null when no questions have opened, and null when they opened before any phase
 * of this session did — a real state on a resumed run, where attaching them to
 * the first phase in view would file an earlier session's questions under this
 * session's first round.
 */
export function questionsPhase(run: Run): number | null {
  if (run.questions === null) return null;
  const cards = rounds(run);
  const i = during(
    cards.map((c) => c.startedAt),
    run.questions.at,
  );
  return cards[i]?.phaseId ?? null;
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

/** What a whole card is called: the phase it is, in the design's vocabulary. */
export function roundTitle(card: RoundCard): string {
  return title(card.phase);
}
