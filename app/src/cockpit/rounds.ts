import type { Census, CycleKind, PhaseGroup, Run, Turn, VerifyPass, Work } from './model';

/**
 * A round, as one card (hi-fi 5, #223).
 *
 * **The object the design's log is made of, and the app did not have it.** Hi-fi
 * 5 is explicit about what the pilot pane is for: *"It has to be a usable log of
 * the run on its own — every round leaves a card, and a card carries what
 * happened, what it found and what you can do about it."*
 *
 * ## A round is the pair, and this module is where that survives
 *
 * A convergence cycle iterates over versions of an artifact: **a producer makes
 * one and a judge objects to it**, and one round is that pair. The plan round is
 * planner-then-critic, the code round is implementer-then-verify-gate, the review
 * round is reviewer-then-fix.
 *
 * **The loop column no longer groups that way and this still does**, which is a
 * deliberate split rather than a drift. `CycleKind` is what the *column* draws —
 * four peer groups, so the critique has a heading of its own — and `FAMILY` below
 * is what a *round* is. Hi-fi 5 draws the round card as the pair, in as many
 * words: `plan v.b · claude/opus · 4m 40s · accepted after 1 critique`. A card per
 * phase would put the planner's version and the critique of it in two cards and
 * lose the sentence the design is built around.
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
 * The core now says the round on both halves, so pairing them is reading rather
 * than guessing — which is what makes this a grouping and not a heuristic, and
 * what keeps it true after the column stopped pairing.
 *
 * ## It is a re-shaping, never a second source
 *
 * Everything here is already on `Run`, put there by `reduce` from a frame. This
 * groups it; it measures nothing, infers no phase from a sentence, and fills in
 * no field a frame did not carry.
 */

/**
 * Which convergence cycle a column group belongs to.
 *
 * Three, where `CycleKind` is four: the column gives the judge its own heading
 * and a *round* is still the pair, so `plan` and `critique` are one family here.
 * A closed map rather than a prefix rule — a fifth group would be a decision
 * about which cycle it converges in, not a name to pattern-match.
 */
export type RoundFamily = 'plan' | 'code' | 'review';

const FAMILY: Readonly<Record<CycleKind, RoundFamily>> = {
  plan: 'plan',
  critique: 'plan',
  code: 'code',
  review: 'review',
};

export interface RoundCard {
  /** Stable across re-renders. See `keyOf` for what makes it stable. */
  key: string;
  /** The convergence cycle, which is three-valued. Not the column's group. */
  cycle: RoundFamily;
  /** The archive's round — the number that names the artifact. Null when none came. */
  round: number | null;
  /**
   * The phases this round is made of, in the order they were announced.
   *
   * Usually two — the producer and the judge — and sometimes one: a code round
   * is a single `implementing` phase whose judge is the verification gate, which
   * announces itself with `verify_started` rather than a phase of its own.
   */
  phases: readonly string[];
  /**
   * Every turn in the round, both halves, oldest first.
   *
   * The `Turn` off `Run`, not a reduced copy of one. The loop column hands a
   * live turn straight to `RunningRow`, which needs the heartbeat and the work
   * reading — and a second shape here would mean the two surfaces disagreed
   * about a turn the moment either grew a field.
   */
  turns: readonly Turn[];
  /** Verification gates opened during the round, by name, in order. */
  gates: readonly string[];
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

/**
 * What makes a card the same card between renders.
 *
 * The round where there is one, because that is the thing that persists: a plan
 * round's two phases arrive as two frames and must not be two cards, and the
 * round number is what says they are one. Where a phase carries no round — an
 * `implementing` phase never has, and every phase on a core older than #223's
 * plan-round fix — the group's **first phase id** stands in, which is unique per
 * frame and therefore never merges two rounds that only look alike.
 */
function keyOf(family: RoundFamily, round: number | null, firstPhaseId: number): string {
  return round === null ? `${family}-p${String(firstPhaseId)}` : `${family}-r${String(round)}`;
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

/**
 * The phase groups of one convergence cycle, gathered into rounds.
 *
 * **Across column groups, not within one.** Since the critique took a heading of
 * its own, a plan round's producer and judge sit in two different `Cycle`s — so
 * this walks the phases of a *family*, in the order they were announced, and
 * pairs them on the round they both carry.
 */
function cardsOf(family: RoundFamily, phases: readonly PhaseGroup[]): RoundCard[] {
  const out: RoundCard[] = [];
  const byRound = new Map<number, RoundCard>();

  for (const phase of phases) {
    const turns = phase.turns;
    const existing = phase.round === null ? undefined : byRound.get(phase.round);

    if (existing === undefined) {
      const card: RoundCard = {
        key: keyOf(family, phase.round, phase.id),
        cycle: family,
        round: phase.round,
        phases: [phase.phase],
        turns: [...turns],
        gates: [...phase.gates],
        startedAt: phase.startedAt,
        endedAt: settledAt(phase.turns),
        work: lastWork(phase.turns),
        verify: null,
        census: null,
      };
      out.push(card);
      if (phase.round !== null) byRound.set(phase.round, card);
      continue;
    }

    // The judge half of a round already open. Merged in place: `startedAt` stays
    // the producer's, because that is when the round began, and `endedAt` is
    // recomputed over both halves so a judge still running keeps the round open.
    const merged: RoundCard = {
      ...existing,
      phases: [...existing.phases, phase.phase],
      turns: [...existing.turns, ...turns],
      gates: [...existing.gates, ...phase.gates],
      endedAt: existing.endedAt === null ? null : settledAt(phase.turns),
      // The later reading wins, on `lastWork`'s own rule: git already reports
      // the tree cumulatively, so this is a replacement and never a sum.
      work: lastWork(phase.turns) ?? existing.work,
    };
    out[out.indexOf(existing)] = merged;
    byRound.set(phase.round as number, merged);
  }

  return out;
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
  // Gathered per family first, because a plan round's two halves now live in two
  // column groups and `Cycle` is no longer the thing a round is made of.
  const families = new Map<RoundFamily, PhaseGroup[]>();
  for (const cycle of run.cycles) {
    const family = FAMILY[cycle.kind];
    const list = families.get(family);
    if (list === undefined) families.set(family, [...cycle.phases]);
    else list.push(...cycle.phases);
  }

  const cards: RoundCard[] = [];
  for (const [family, phases] of families) {
    // In announcement order, so the producer is seen before the judge that
    // merges into it. `Cycle`s are stored in the order they first appeared, and
    // `critique` appears after `plan` - but a resumed run can open them in
    // either order, so this sorts rather than relying on that.
    cards.push(...cardsOf(family, [...phases].sort((a, b) => a.startedAt - b.startedAt)));
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
 * Which census belongs to which **phase**, for the loop column.
 *
 * The column draws four peer groups and therefore one row per phase, so it needs
 * the census on the phase that produced it — the critique's counts belong on the
 * critique row, which is where they were measured. `rounds()` answers the same
 * question for a *round*, and both go through `during()` so there is one
 * definition of "by arrival" rather than two that can disagree.
 *
 * Keyed by phase id, which `reduce` allocates and never reuses.
 */
export function censusByPhase(run: Run): ReadonlyMap<number, Census> {
  const phases = run.cycles
    .flatMap((c) => c.phases)
    .sort((a, b) => a.startedAt - b.startedAt);
  const starts = phases.map((p) => p.startedAt);
  const out = new Map<number, Census>();
  for (const census of run.censuses) {
    const i = during(starts, census.at);
    const phase = phases[i];
    // A census that predates every phase attaches to nothing, exactly as it does
    // on a round: a resumed run's history can land before this session's first
    // phase, and filing it under one would credit the wrong session's work.
    if (phase !== undefined) out.set(phase.id, census);
  }
  return out;
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

/**
 * What a whole round is called: its producer's name.
 *
 * The **first** phase, because a round is named for what it produced rather than
 * for what judged it — `plan`, `code`, `review` — and the judge is visible as the
 * second half of the card rather than in its heading. A round with no phase at
 * all cannot happen (a card exists because a phase started) but is answered
 * rather than thrown, because a renderer is the wrong place to find out.
 */
export function roundTitle(card: RoundCard): string {
  const first = card.phases[0];
  return first === undefined ? card.cycle : title(first);
}
