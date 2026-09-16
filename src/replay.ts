import type { Narration } from '@src/log.js';
import type { RunState } from '@src/types.js';

/**
 * A finished run, said again (#223).
 *
 * **Reported as a gap in the window and answered here rather than there:**
 * *"I want the right panel to look just as it would have when I click on an old
 * run as if I had run it myself."* The first attempt at that was a *summary* —
 * a different screen, drawn from a different shape — and it was the wrong
 * answer for exactly the reason the report gives: a person opening a run wants
 * the run, not a report about it.
 *
 * So this does not invent a second drawing. It reconstructs the **narration**,
 * and the window folds it through the same `reduce` a live run goes through —
 * so the column, the round cards and the log are the same components rendering
 * the same `Run`. There is no second definition of what a run looks like,
 * because there is no second builder.
 *
 * ## Why this is not the replay AGENTS.md warned against
 *
 * The standing objection was real and is answered rather than ignored:
 * synthesising frames for a finished run *"would report finished work as
 * running"*. That is true of a naive replay and false of this one, because
 * every turn in an archive is a turn that **ended** — `applyCharge` records it
 * at the moment it is charged, which is after it returned. So every
 * `turn_started` here is followed by the thing that closes it, the sequence
 * ends with the ending the run actually had, and `run.running` is null when the
 * fold finishes. Nothing pulses, because nothing is open.
 *
 * ## Everything here is read, and the two things that are not are said
 *
 * The labels are the loop's own ids — `plan`, `critique-0`, `revise-q2`,
 * `fix-3` — constructed by `orchestrator.ts` and read back here, in the same
 * repository, pinned by a test that fails on the commit that respells one. That
 * is not the English-matching #133 exists to prevent: #133 is about prose
 * written for a human and read for a decision, and these are identifiers.
 *
 * **A turn's duration is recorded only sometimes, and the rest say so.**
 * `state.turnStartedAt` is a single field describing the turn in flight, so the
 * only starts an archive keeps are the ones a checkpoint happened to freeze —
 * plus the last turn, in `state.json` itself. A turn whose start was never
 * written down is emitted with `unmeasured`, and the row draws no duration
 * rather than a zero. Inventing one from the gap between two charges would be a
 * proxy wearing another measurement's clothes: that interval includes every
 * gate the loop held at.
 *
 * **A heartbeat is not durable at all**, so no beat is synthesised. A replayed
 * turn therefore has no live token count and no activity count — those were
 * measurements of a turn in flight, and the run's totals are on the charge
 * events where they belong.
 */

/** One narration, and when it happened. */
export interface ReplayStep {
  /** Epoch milliseconds, from the run's own record. */
  at: number;
  narration: Narration;
}

/** A run said again, and how it ended. */
export interface Replay {
  steps: readonly ReplayStep[];
  /**
   * The exit code the run reported, or null if its record does not say.
   *
   * Separate from the steps because a `result` is not narration — it is the
   * frame that answers the request, and the window applies it as one. Null
   * rather than a guessed zero: a run whose status is unrecognised has not told
   * us it succeeded.
   */
  exit: number | null;
}

/**
 * What a checkpoint froze, as this module needs it.
 *
 * A narrow view rather than the whole `RunState`, because that is all this
 * reads and a wider parameter would invite a later edit to reach for a field
 * whose meaning at checkpoint time is not what it looks like.
 */
export interface CheckpointView {
  n: number;
  at: string;
  boundary: string;
  phase: string | null;
  planRound: number;
  reviewRound: number;
  verifyRound: number;
  questionRound: number;
  commit: string | null;
  /** The start of the turn that was in flight when this was frozen, if any. */
  turnStartedAt: string | null;
}

/** What a round's own artifact says, once somebody has read it. */
export interface RoundCensus {
  /** `plan` for a critique round, `review` for a review round. */
  phase: 'plan' | 'review';
  round: number;
  counts: { p0: number; p1: number; p2: number; p3: number };
}

/** How many questions a question round raised, from `answers-<n>.json`. */
export interface QuestionRoundSize {
  round: number;
  total: number;
  blocking: number;
}

/** Everything outside `state.json` that the reconstruction reads. */
export interface ReplaySources {
  checkpoints: readonly CheckpointView[];
  censuses: readonly RoundCensus[];
  questions: readonly QuestionRoundSize[];
}

/** Who ran, what kind of turn it was, and which phase it belongs in. */
interface Seat {
  role: string;
  kind: string;
  /** One of `CYCLE_OF`'s four, so the column can place it. */
  phase: 'planning' | 'critique' | 'implementing' | 'review';
  /** The round the label itself names, or null when it names none. */
  round: number | null;
}

/**
 * A charge label, read back into the turn that produced it.
 *
 * **The inverse of the label construction in `orchestrator.ts`**, and the only
 * place that inverse exists. Every arm corresponds to exactly one `label:` site
 * there, and `replay.test.ts` walks that file to fail on the commit that adds a
 * ninth label or respells one — which is the same guarantee `artifacts.ts` gets
 * from reading `orchestrator.ts` as source, for the same reason: two spellings
 * of one convention drift, and the one that drifts is the one on screen.
 *
 * A label this build does not know returns null and the turn is **left out of
 * the column** rather than filed under a guess — the rule `phase_started`
 * already follows for a phase it cannot place. It is still in the run's spend,
 * because the charge event is emitted either way.
 */
export function seatOf(label: string): Seat | null {
  const numbered = (prefix: string): number | null => {
    if (!label.startsWith(`${prefix}-`)) return null;
    const rest = label.slice(prefix.length + 1);
    // `review-2-part3` is one review turn split across chunks, so the round is
    // the first segment and the part is not a round at all.
    const head = rest.split('-')[0] ?? '';
    const n = Number.parseInt(head, 10);
    return Number.isInteger(n) ? n : null;
  };

  if (label === 'plan') return { role: 'planner', kind: 'plan', phase: 'planning', round: 0 };
  if (label === 'implement') {
    return { role: 'implementer', kind: 'implement', phase: 'implementing', round: null };
  }
  // Before `revise-`, because `revise-q2` also starts with it and means the
  // opposite thing: a revision answering the planner's own answers, which
  // `advancesRound` says is not the producer's side of a round.
  if (/^revise-q\d+$/.test(label)) {
    return { role: 'planner', kind: 'revise', phase: 'planning', round: null };
  }
  const revise = numbered('revise');
  if (revise !== null) return { role: 'planner', kind: 'revise', phase: 'planning', round: revise };
  const critique = numbered('critique');
  if (critique !== null) {
    return { role: 'critic', kind: 'critique', phase: 'critique', round: critique };
  }
  const answers = numbered('answers');
  // The answerer sits inside the plan cycle: a question round produces no
  // critique, so it cannot be a cycle of its own. Its round is the plan round it
  // happened under, which the checkpoint timeline supplies.
  if (answers !== null) return { role: 'answerer', kind: 'answer', phase: 'planning', round: null };
  const review = numbered('review');
  if (review !== null) return { role: 'reviewer', kind: 'review', phase: 'review', round: review };
  const fix = numbered('fix');
  if (fix !== null) {
    return { role: 'implementer', kind: 'review-fix', phase: 'implementing', round: fix };
  }
  const verifyFix = numbered('verify-fix');
  if (verifyFix !== null) {
    return { role: 'implementer', kind: 'verify-fix', phase: 'implementing', round: verifyFix };
  }
  const finalFix = numbered('final-fix');
  if (finalFix !== null) {
    return { role: 'implementer', kind: 'final-fix', phase: 'implementing', round: finalFix };
  }
  return null;
}

/** Epoch ms from a stored ISO string, or null when it is not one. */
function ms(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? null : at;
}

/** One turn as the archive holds it. */
interface ChargedTurn {
  at: number;
  label: string;
  type: 'claude_turn' | 'codex_turn';
  data: Record<string, unknown>;
  /** Whether the turn was charged after FAILING - stopped, timed out, or threw. */
  failed: boolean;
}

function chargedTurns(state: RunState): ChargedTurn[] {
  const out: ChargedTurn[] = [];
  for (const event of state.events) {
    // **`turn_failed` counts too, and leaving it out was a hole** (#223). A turn
    // that was stopped, timed out or threw is charged through `chargeFailure`
    // under this type rather than as `claude_turn`, so a replay that took only
    // the successful ones drew a run *missing the turn it stopped on* - which is
    // the opposite of *"I want it to look as I just left it when I stopped the
    // run."* The killed implement turn of 2026-09-16 is the case: 14.2M tokens
    // and fourteen minutes of work, absent from its own replay.
    const failed = event.type === 'turn_failed';
    if (event.type !== 'claude_turn' && event.type !== 'codex_turn' && !failed) continue;
    const at = ms(typeof event['at'] === 'string' ? event['at'] : null);
    const label = event['label'];
    if (at === null || typeof label !== 'string') continue;
    // A failed turn records which agent ran it; a charged one is identified by
    // the event type itself. A provider this build does not know is skipped
    // rather than attributed to the wrong agent, which would put a Codex turn's
    // spend on Claude's side of the ledger.
    const provider = event['provider'];
    const type: 'claude_turn' | 'codex_turn' | null = failed
      ? provider === 'claude'
        ? 'claude_turn'
        : provider === 'codex'
          ? 'codex_turn'
          : null
      : event.type === 'claude_turn'
        ? 'claude_turn'
        : 'codex_turn';
    if (type === null) continue;
    const { at: _at, type: _type, ...rest } = event;
    out.push({ at, label, type, data: rest, failed });
  }
  // By time rather than by position. A resumed run appends to `events`, so
  // order is already chronological — sorting says so rather than assuming it.
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Which turn each recorded start belongs to.
 *
 * A checkpoint freezes `turnStartedAt` for whatever was in flight, so the start
 * it holds belongs to the **first turn charged at or after it** — a turn is
 * charged when it returns, and the checkpoint was taken during it. Each start is
 * claimed once: two checkpoints inside one turn would otherwise both claim it,
 * and the second would move a duration that was already right.
 */
function startsByTurn(turns: readonly ChargedTurn[], starts: readonly number[]): Map<number, number> {
  const owned = new Map<number, number>();
  for (const start of [...starts].sort((a, b) => a - b)) {
    const turn = turns.find((t) => t.at >= start && !owned.has(t.at));
    if (turn === undefined) continue;
    owned.set(turn.at, start);
  }
  return owned;
}

/** The checkpoint in force at a moment, or null before the first one. */
function contextAt(
  checkpoints: readonly CheckpointView[],
  at: number,
): CheckpointView | null {
  let found: CheckpointView | null = null;
  for (const c of checkpoints) {
    const cAt = ms(c.at);
    if (cAt === null || cAt > at) continue;
    found = c;
  }
  return found;
}

function say(id: string, message: string, data: Record<string, unknown>): Narration {
  // `detail` throughout: a replayed line is a record being read back, not the
  // loop speaking, and the output pane dims it exactly as it dims what a model
  // said. The id is what anything acts on, which is the whole point of #133.
  return { level: 'detail', message, id, data };
}

/**
 * Say a finished run again, in the order it happened.
 *
 * Pure, and that is what makes it testable at all: the app has no jsdom, so a
 * reconstruction living inside a component would be one nothing checks.
 */
export function replayRun(state: RunState, sources: ReplaySources): Replay {
  const steps: ReplayStep[] = [];
  const push = (at: number, narration: Narration): void => {
    steps.push({ at, narration });
  };

  const createdAt = ms(state.createdAt) ?? 0;
  push(
    createdAt,
    say('run_started', `Run ${state.id}`, {
      runId: state.id,
      repo: state.targetDir,
      task: state.task,
      dir: state.dir,
    }),
  );
  if (state.branch !== null) {
    push(createdAt, say('run_branch', `Branch ${state.branch}`, { branch: state.branch }));
  }

  const turns = chargedTurns(state);
  const recorded: number[] = [];
  for (const c of sources.checkpoints) {
    const start = ms(c.turnStartedAt);
    if (start !== null) recorded.push(start);
  }
  // The last turn's start, which no checkpoint holds because no boundary was
  // crossed after it. It is in `state.json` for the same reason it is in each
  // checkpoint: it describes the turn that was in flight when the file was
  // written, and for the final file that is the final turn.
  const lastStart = ms(state.turnStartedAt ?? null);
  if (lastStart !== null) recorded.push(lastStart);
  const starts = startsByTurn(turns, recorded);

  // What has already been announced, so a phase opens once per round rather
  // than once per turn. `reduce` merges a re-entered group only when both
  // rounds are stated, so the pair is what is compared.
  let openPhase: string | null = null;
  let openRound: number | null = null;
  let questionsSaid = 0;
  const censusSaid = new Set<string>();

  for (const turn of turns) {
    const seat = seatOf(turn.label);
    const context = contextAt(sources.checkpoints, turn.at);
    const start = starts.get(turn.at) ?? null;
    // The turn opens when it was measured to open, and otherwise at the moment
    // it was charged — which collapses its duration to nothing, so `unmeasured`
    // travels with it and the row draws no duration at all.
    const opened = start ?? turn.at;

    if (seat !== null) {
      const round =
        seat.round ??
        (seat.phase === 'review' || seat.phase === 'implementing'
          ? (context?.reviewRound ?? 0)
          : (context?.planRound ?? 0));

      if (openPhase !== seat.phase || openRound !== round) {
        push(
          opened,
          say('phase_started', `${seat.phase} ${String(round)}`, {
            phase: seat.phase,
            round,
          }),
        );
        openPhase = seat.phase;
        openRound = round;
      }

      // A question round's questions belong to the plan round that raised them,
      // and they are placed by arrival exactly as a live run places them — the
      // same `during()` a census goes through.
      const questionRound = context?.questionRound ?? 0;
      if (seat.kind === 'answer' && questionRound > questionsSaid) {
        const size = sources.questions.find((q) => q.round === questionRound);
        if (size !== undefined) {
          push(
            opened,
            say('questions_opened', `${String(size.total)} question(s)`, {
              total: size.total,
              blocking: size.blocking,
              round: size.round,
              cap: null,
            }),
          );
        }
        questionsSaid = questionRound;
      }

      push(
        opened,
        say('turn_started', `${seat.role} · ${seat.kind}`, {
          role: seat.role,
          kind: seat.kind,
          round,
          // Told, never inferred. A window that guessed which turns had a
          // measured start would guess wrong on the ones that matter.
          unmeasured: start === null,
        }),
      );
    }

    // Emitted whatever the label was. A turn this build cannot place in the
    // column still spent what it spent, and dropping the charge would make the
    // replayed total disagree with the run's own record.
    push(
      turn.at,
      say(turn.type, `${turn.label} ${turn.failed ? 'stopped' : 'charged'}`, turn.data),
    );

    // The judge's verdict, read from the round's own artifact rather than from
    // a census — a census is narration with no event, so the archive has the
    // report and not the counting of it.
    if (seat !== null && (seat.kind === 'critique' || seat.kind === 'review')) {
      const phase = seat.kind === 'critique' ? 'plan' : 'review';
      const round = seat.round ?? 0;
      const key = `${phase}-${String(round)}`;
      const census = sources.censuses.find((c) => c.phase === phase && c.round === round);
      if (census !== undefined && !censusSaid.has(key)) {
        censusSaid.add(key);
        push(
          turn.at,
          say('findings_reported', `${phase} round ${String(round)}`, {
            phase,
            counts: census.counts,
          }),
        );
      }
    }
  }

  for (const c of sources.checkpoints) {
    const at = ms(c.at);
    if (at === null || c.commit === null) continue;
    push(at, say('round_committed', `Committed ${c.commit}`, { sha: c.commit, since: null }));
  }

  // The ending, in the core's own words, selected by event type — never by
  // reading the transcript for the most alarming sentence, which is the
  // English-matching #133 exists to prevent.
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const event = state.events[i];
    if (event === undefined) continue;
    if (event.type !== 'escalation' && event.type !== 'error') continue;
    const at = ms(typeof event['at'] === 'string' ? event['at'] : null);
    const message = typeof event['message'] === 'string' ? event['message'] : '';
    push(
      at ?? createdAt,
      say(event.type === 'escalation' ? 'run_escalated' : 'run_failed', message, {
        reason: message,
      }),
    );
    break;
  }

  // **The offer a finished plan-only run needs**, and it is durable on
  // `RunState` rather than being read off the ending: `planOnly` has been set
  // since `createRun`, so a window could not otherwise tell a plan-only run that
  // FINISHED from any other run that finished, and the two want opposite next
  // actions. The last turn's time, because that is when there stopped being a
  // next phase.
  if (state.planOnly && state.status === 'planned') {
    const last = turns[turns.length - 1];
    push(
      last?.at ?? createdAt,
      say('plan_only_stopped', 'Plan only: nothing was built from it', {
        carried: state.carried?.length ?? 0,
      }),
    );
  }

  // Stable, and by time rather than by the order they were pushed: the commits
  // are appended after the turns and belong among them.
  steps.sort((a, b) => a.at - b.at);
  return { steps, exit: exitOf(state.status) };
}

/**
 * The exit code a run of this status reported.
 *
 * The four the archive can actually hold, and **null for anything else** — a
 * status this build does not recognise has not told us the run succeeded, and a
 * zero would say it had. `EXIT` is not imported because that is the *CLI's*
 * table for a run it just finished; this is a reading of a record, and the two
 * agreeing by coincidence is not the same as sharing a definition.
 */
function exitOf(status: string): number | null {
  if (status === 'done' || status === 'planned') return 0;
  if (status === 'needs-input') return 2;
  if (status === 'error') return 1;
  return null;
}
