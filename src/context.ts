import { applyCharge, chargeFailure, Escalation, fmtTokens } from '@src/charge.js';
import { claudeTurn } from '@src/claude.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import * as log from '@src/log.js';
import { progressOptions, rememberContextWindow } from '@src/progress.js';
import { handoffPrompt } from '@src/prompts.js';
import { rolesFor, rotatesConcurrentlyWith, rotatingSlot } from '@src/roles.js';
import type { Role, RoleTable } from '@src/roles.js';
import {
  ensureSlotId,
  resetSlot,
  slotContextWindow,
  slotId,
  slotOccupancy,
  slotRotatable,
  slotStarted,
  SLOTS,
} from '@src/slots.js';
import type { SlotName } from '@src/slots.js';
import {
  artifact,
  measuredRatio,
  recordContextMeasurement,
  recordEvent,
  recordMeasuredWindow,
  resetContextMeasurement,
} from '@src/run.js';
import type { ClaudeTurnResult, Config, ContextUsage, RunState } from '@src/types.js';

/**
 * Context control for the Claude side of the loop.
 *
 * `/compact` is a Claude Code CLI command, not a model instruction: piped into
 * `claude -p` it is received as an ordinary user turn and does nothing. So
 * compaction is done explicitly here - ask the outgoing session for a dense
 * handoff briefing, then rotate to a fresh session id seeded with it. The plan
 * of record is re-attached from disk, so the new session starts small without
 * losing the two things that matter: the plan, and the hard-won knowledge of
 * the codebase.
 *
 * This is a *client-origin* slot operation: vibe mints the replacement id and
 * spawns the next turn under it. A slot whose id the provider mints has no such
 * mechanism - `codex exec resume` has no session-id flag, so starting a fresh
 * thread with a briefing is a different operation, not this one with another
 * provider behind it. `SLOTS.judge.reset` is therefore null, and everything
 * below refuses to rotate a slot that cannot be reset rather than half-doing it.
 */

export function shouldRotate(state: RunState, cfg: Config, roles: RoleTable = rolesFor(cfg)): boolean {
  if (!cfg.context.enabled) return false;

  const slot = rotatingSlot(roles);
  // A slot with no reset mechanism cannot be rotated, so nothing may decide it
  // is time to: `withConcurrentCompaction` would otherwise permit concurrent
  // work on the strength of a rotation that cannot happen.
  if (!slotRotatable(slot)) return false;
  // `started`, not `hasMemory`: the question is whether a conversation has
  // accumulated anything, which is a fact about turns rather than about whether
  // the run is configured to carry it.
  if (!slotStarted(state, slot)) return false;

  const ratio = measuredRatio(state, cfg.claude.model);
  // An unattributable ratio is unknown, not a number. A non-zero one is still
  // evidence that a real session accumulated somewhere - under a window this
  // process cannot name, because `--claude-model` may have changed on resume.
  // Against a smaller window the stored figure understates occupancy, which is
  // how compaction got deferred past the turn that overflowed. Rotating
  // establishes a baseline; `resetContextMeasurement` tags it with this model,
  // so it is asked for once rather than at every turn boundary. A zero ratio is
  // no evidence of anything, so it buys nothing.
  if (ratio === null) return state.contextRatio > 0;
  return ratio >= cfg.context.compactAboveRatio;
}

/** Injectable for the rotation tests, which must not spawn a real `claude`. */
export type ClaudeTurnFn = (options: ClaudeTurnOptions) => Promise<ClaudeTurnResult>;

/**
 * The one place an ordinary completed Claude turn's context measurement lands.
 *
 * Both stores are written together on purpose. They were written by one call
 * site and forgotten by the other, which is exactly how the rotation turn ended
 * up measuring a window and recording it nowhere - leaving the next turn without
 * a `ctx%` it could have shown.
 */
export function recordTurnContext(
  state: RunState,
  model: string,
  usage: ContextUsage | null,
): void {
  if (usage === null) return;
  recordContextMeasurement(state, model, usage.ratio, usage.contextWindow);
  rememberContextWindow(model, usage.contextWindow);
}

/**
 * What is known about a conversation's occupancy.
 *
 * `tokens` is always a real measurement; `ratio` is null whenever this run
 * cannot name the window it would be a fraction of, and `over` is false with it.
 * Unknown is never quietly turned into a number - that is the one rule the Codex
 * side of this exists to keep.
 */
export interface ThreadOccupancy {
  /** Tokens occupying the conversation. */
  tokens: number;
  /** Occupancy over the configured window, or null when no window is known. */
  ratio: number | null;
  /** At or above `context.compactAboveRatio`. False whenever the ratio is unknown. */
  over: boolean;
}

function occupancyOf(tokens: number | null, cfg: Config, slot: SlotName): ThreadOccupancy | null {
  if (tokens === null || tokens <= 0) return null;
  const window = slotContextWindow(cfg, slot);
  const ratio = window === null ? null : tokens / window;
  // `>=`, matching `shouldRotate`: the threshold means the same thing on both
  // sides of the run, so a user who moved `compactAboveRatio` moved one line.
  return { tokens, ratio, over: ratio !== null && ratio >= cfg.context.compactAboveRatio };
}

/**
 * What a turn that reported `tokens` prompt tokens says about its conversation,
 * or null when it reported none.
 *
 * Deliberately not a reader of state: what gets displayed is what THIS turn
 * measured. `codexTurn` accepts a turn that wrote conformant output but emitted
 * no `turn.completed` usage block, and the figure such a turn leaves standing
 * describes the previous one - the same reason `claudeDispatch` gates its `ctx`
 * segment on `result.usage` rather than on the stored ratio.
 */
export function turnOccupancy(tokens: number, cfg: Config, slot: SlotName): ThreadOccupancy | null {
  return occupancyOf(tokens, cfg, slot);
}

/** What the stored record says about the slot's current conversation, or null. */
export function storedOccupancy(
  state: RunState,
  cfg: Config,
  slot: SlotName,
): ThreadOccupancy | null {
  return occupancyOf(slotOccupancy(state, slot), cfg, slot);
}

/**
 * Runs that have already been told their Codex context is large.
 *
 * In memory, keyed on the run, and never persisted. A stored flag would be a
 * second fact to keep in step with the measurement - stale when the thread
 * changes, and writable for a line that a dead console never printed. A resumed
 * run saying it again is correct: the condition is still true, and one line is
 * the whole cost. Keyed per run rather than per process so two runs driven from
 * one process do not silence each other, the same scoping the progress liveness
 * fields use.
 */
const warnedRuns = new WeakSet<RunState>();

/**
 * What to say about a conversation over the threshold, or null when there is
 * nothing to say - including when this run has already said it.
 *
 * Touches no persisted state, and does not mark: the caller marks after the line
 * has actually been emitted, so a warning that never reached the terminal cannot
 * silence the next turn.
 */
export function occupancyWarning(
  state: RunState,
  occupancy: ThreadOccupancy,
  cfg: Config,
  slot: SlotName,
): string | null {
  if (!occupancy.over || occupancy.ratio === null || warnedRuns.has(state)) return null;
  const window = slotContextWindow(cfg, slot);
  if (window === null) return null;

  const size = `${(occupancy.ratio * 100).toFixed(0)}% of codex.contextWindow ` +
    `(${fmtTokens(occupancy.tokens)} / ${fmtTokens(window)} tok)`;

  // A remedy the run has already applied is not a remedy. With persistSession
  // off there is no thread to start over - every judging turn already starts
  // empty - so the figure is the size of one prompt and the advice is different.
  return SLOTS[slot].persists(cfg)
    ? `codex thread at ${size}. Nothing can compact this thread: \`codex exec resume\` takes no ` +
        'session-id flag, so vibe cannot rotate it - only a fresh run starts it over. Raise ' +
        'codex.contextWindow if it is wrong, or use --no-codex-session so each judging turn ' +
        'starts empty.'
    : `codex prompt at ${size}. Each judging turn is already its own thread and nothing can ` +
        'compact one mid-turn, so this is the size of a single prompt. Raise codex.contextWindow ' +
        'if it is wrong, or reduce what the turn is given.';
}

/** Remember, for this process only, that this run has been warned. */
export function markOccupancyWarned(state: RunState): void {
  warnedRuns.add(state);
}

/**
 * Summarise and rotate. Safe to run concurrently with a Codex turn: it only
 * touches the outgoing Claude session, which nothing else is using.
 *
 * Two paths, because a rotation on an unattributable measurement is not the
 * same operation as one on a measured overflow. The baseline rotation exists
 * precisely when the outgoing conversation may not fit the model now
 * configured, so the handoff request - which has to load that conversation -
 * is the turn most likely to fail. Failing it must not leave the run on the
 * session it was trying to abandon, so the baseline path rotates anyway,
 * carrying whatever briefing it already had. A measured rotation still throws
 * to its caller: there the existing session is known to be usable, and
 * `withConcurrentCompaction` is right to keep working on it.
 */
export async function rotateSession(
  state: RunState,
  cfg: Config,
  turn: ClaudeTurnFn = claudeTurn,
  roles: RoleTable = rolesFor(cfg),
): Promise<void> {
  const slot = rotatingSlot(roles);
  // Before anything is spent. `shouldRotate` already refuses such a slot, so
  // reaching this means a caller decided to rotate on its own, and a handoff
  // turn charged against a conversation that cannot be replaced is worse than
  // the throw.
  if (!slotRotatable(slot)) {
    throw new Error(`slot "${slot}" has no rotation mechanism; nothing may compact it`);
  }

  const measured = measuredRatio(state, cfg.claude.model);
  const baseline = measured === null;
  log.step(
    baseline
      ? 'Compacting Claude session (context was measured under another model)'
      : `Compacting Claude session (context at ${(measured * 100).toFixed(0)}%)`,
  );

  // Ask the model that grew the conversation, not the one that is about to
  // inherit it: replaying a session recorded against a 1M window into a 200k
  // one is exactly the request that fails. Absent provenance leaves nothing
  // better than the configured model, which is why the failure path below is
  // not optional.
  const handoffModel = baseline && state.contextModel !== undefined ? state.contextModel : cfg.claude.model;

  let result: ClaudeTurnResult | null = null;
  // A ceiling crossed by a *failed* handoff, held until the rotation this
  // function exists to perform has actually happened. See the catch below.
  let held: Escalation | null = null;
  try {
    result = await turn({
      prompt: handoffPrompt(),
      sessionId: ensureSlotId(state, slot),
      // A literal, not `slotHasMemory`: a rotation is only ever entered on a
      // conversation that has started, and deriving it here would make the flag
      // depend on state a direct caller may have set by hand.
      resume: true,
      permissionMode: 'plan',
      model: handoffModel,
      effort: 'low',
      cwd: state.targetDir,
      tools: ['Read'],
      timeoutMs: cfg.claude.planTimeoutMs,
      progress: progressOptions(state, cfg, 'compact'),
    });
  } catch (err: unknown) {
    // A handoff that failed still spent. Charged through the seam a dispatched
    // turn pays through, and before the split below so both paths charge: a
    // handoff summarises a whole session, so these are among the largest turns
    // a run makes, and losing one of them to a failure is the same hole #24
    // closed for the ones that succeed. A briefing that reported nothing - the
    // usual case, and every existing test - charges nothing.
    const ceiling = chargeFailure(state, cfg, err, { label: 'compact', provider: 'claude' });
    // The measured path is unchanged, and the ceiling is deliberately dropped
    // here rather than raised: `err` must reach `withConcurrentCompaction` as
    // the same object of the same type it does today, or a swallowed compaction
    // failure becomes a run-ending escalation. The charge stays in the totals,
    // so the next one raises it.
    if (!baseline) throw err;
    held = ceiling;
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Handoff briefing failed (${message}); rotating to a fresh session without a new one.`);
  }

  state.sessionRotations += 1;
  // A fresh id and a cleared marker together: what a slot's fresh conversation
  // looks like is stated in one place, so the next turn cannot read the new id
  // as evidence that anything has run on it.
  resetSlot(state, slot);
  resetContextMeasurement(state, cfg.claude.model);

  // After the reset, which would otherwise wipe it. The handoff turn's *ratio*
  // describes the session just abandoned and stays discarded; its *window* is a
  // property of the model that measured it, and is read only by the `ctx%`
  // display. Recorded under `handoffModel` rather than the configured one, so a
  // baseline rotation that asked the outgoing model contributes nothing to the
  // incoming one. Without this, a rotation as the first Claude turn of a process
  // left the next ordinary turn with no window and no `ctx%`.
  if (result?.usage) {
    rememberContextWindow(handoffModel, result.usage.contextWindow);
    recordMeasuredWindow(state, handoffModel, result.usage.contextWindow);
  }

  // One operation, one event, whichever path it took - so `session_rotated`
  // still means "a rotation happened here" and nothing has to correlate two
  // records of the same one. `tokens` is the field that was missing: a handoff
  // summarises a whole session, so these are among the largest turns a run
  // makes and every one of them used to be invisible to `budget.maxTokens`.
  const rotationEvent = (costUsd: number, tokens: number): Record<string, unknown> => ({
    rotation: state.sessionRotations,
    costUsd,
    tokens,
    newSessionId: slotId(state, slot),
    contextModel: cfg.claude.model,
    baseline,
    handoffModel,
    handoff: result !== null,
  });

  if (result === null) {
    // The previous briefing is kept - it is the only account of the run the new
    // session can be given - but flagged, because it describes an earlier point
    // than the session just abandoned. The plan of record is attached by
    // handoffContext regardless of either, so a fresh session is never started
    // blind to what it is meant to be building.
    state.handoffStale = true;
    // Still 0/0: no briefing was produced, so the rotation delivered nothing,
    // and what the failed turn spent is recorded by its own `turn_failed` event
    // rather than folded into one that would then claim a handoff it does not
    // have. One operation, one `session_rotated` event, unchanged.
    recordEvent(state, 'session_rotated', rotationEvent(0, 0));
    log.ok('Rotated to a fresh session (no handoff briefing)');
    // Last, for the reason the successful path's charge is last: the rotation
    // has already happened - new session id, measurement reset - so the ceiling
    // stops what comes next rather than the rotation itself, and the run is
    // resumable on the session it just moved to.
    if (held !== null) throw held;
    return;
  }

  state.handoff = result.text;
  delete state.handoffStale;
  // The write cannot be allowed to cost the run the accounting for a turn it
  // has already paid for - the same reasoning that moved the critique and
  // review artifacts inside the callback in `orchestrator.ts`. A throw here
  // would skip the charge entirely, and under `withConcurrentCompaction` it
  // would then be swallowed as an ordinary compaction failure, leaving a
  // rotated session that no ceiling ever saw. The briefing is a record of a
  // rotation that has already happened; losing the record is the smaller loss,
  // and `state.handoff` is set above either way, so the next session still gets
  // it.
  try {
    artifact(state, `handoff-${state.sessionRotations}.md`, result.text);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Could not write handoff-${state.sessionRotations}.md (${message}); rotation still charged.`);
  }

  // Before the charge, not after: the charge can now end the run, and the
  // rotation it would be reporting has already happened - new session id,
  // measurement reset, briefing on disk. Suppressing the line would leave the
  // log claiming a rotation that is committed in state never completed.
  log.ok(`Rotated to a fresh session (handoff-${state.sessionRotations}.md)`);

  // Through the same seam an ordinary turn pays through, rather than the
  // hand-rolled cost line this replaced. That line added cost and nothing else,
  // so the tokens went uncounted and no ceiling was ever consulted. `applyCharge`
  // is synchronous, so this still cannot land inside the accounting of a Codex
  // turn running concurrently under `withConcurrentCompaction`.
  applyCharge(state, cfg, {
    costUsd: result.costUsd,
    tokens: result.tokens.total,
    event: { type: 'session_rotated', data: rotationEvent(result.costUsd, result.tokens.total) },
    describe: () =>
      `compact: ${fmtTokens(result.tokens.total)} tok, ~$${result.costUsd.toFixed(3)} ` +
      `(run ${fmtTokens(state.tokensUsed)} tok / ~$${state.costUsd.toFixed(2)})`,
    warnings: [],
  });
}

/**
 * Run `work` and, if the session is over the threshold, compact concurrently.
 *
 * This is the point of doing it here: the summarisation happens while Codex is
 * already busy critiquing or reviewing, so it costs no extra wall-clock and
 * never interrupts a Claude turn mid-flight.
 *
 * What makes that safe is not that the concurrent turn is Codex's: it is that
 * the agent working alongside the rotation is not the agent whose session is
 * being rotated. `rotatesConcurrentlyWith` states that, against `ROTATING_ROLE`,
 * so a table that seated `workRole` on the rotating agent would fall through to
 * a plain `work()` instead of compacting the session mid-turn.
 */
export async function withConcurrentCompaction<T>(
  state: RunState,
  cfg: Config,
  work: () => Promise<T>,
  /** The seam `rotateSession` already has, for the same reason: this wrapper's
   * escalation path cannot be exercised against a real `claude`. */
  turn: ClaudeTurnFn = claudeTurn,
  /** Who is doing the concurrent work. Defaulted so the existing callers and
   * their tests keep their four-argument shape; both real call sites pass it. */
  workRole: Role = 'reviewer',
  roles: RoleTable = rolesFor(cfg),
): Promise<T> {
  if (
    !cfg.context.compactDuringCodex ||
    !rotatesConcurrentlyWith(workRole, roles) ||
    // The same table both decisions above used: asking whether it is time to
    // rotate under `ROLES` while the guard consulted an injected table is how
    // the wrapper came to permit concurrent work beside a rotation of the very
    // conversation that work was being done through.
    !shouldRotate(state, cfg, roles)
  ) {
    return work();
  }

  // A box rather than a `let`, so the check below is not narrowed to `null` by
  // the assignment living inside a closure.
  const escalated: { err: Escalation | null } = { err: null };

  // `allSettled`, not `all`: `Promise.all` rejects the moment `work` does,
  // leaving the rotation running - charging, logging and mutating state - into a
  // run whose failure handling has already begun, and leaving `escalated.err`
  // never read. Settling both first makes the run record coherent at the moment
  // the error propagates. On the path where nothing fails the two are
  // indistinguishable: both await both.
  const [outcome, compaction] = await Promise.allSettled([
    work(),
    rotateSession(state, cfg, turn, roles).catch((err: unknown) => {
      // A budget escalation is the run being told to stop, not a lost
      // optimisation, so it is held and rethrown below rather than swallowed.
      // Held rather than rejected straight into Promise.all: `work` is a turn
      // already paid for, and abandoning it mid-flight would discard the
      // critique or review the run just bought - the same reasoning applyCharge
      // records for not running the cost ceiling during a Codex turn.
      if (err instanceof Escalation) {
        escalated.err = err;
        return;
      }
      // Compaction on a measured session is an optimisation; losing it must not
      // fail the run. A baseline rotation whose *briefing* fails never lands
      // here either - it rotates anyway and returns, because continuing on an
      // unattributable session is the thing it exists to prevent. A baseline
      // rotation that succeeds is charged like any other and can trip either
      // ceiling, which is why the escalation branch above is not conditional on
      // the rotation having been a measured one.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Compaction failed, continuing on the existing session: ${message}`);
    }),
  ]);

  // A `work` that throws wins: the run is ending either way, and its own error
  // says more about why than the ceiling does. The escalation is outranked, not
  // lost - `rotateSession` charged before it raised, so the totals are right and
  // the next charge raises it again - but it is said out loud, because a ceiling
  // enforced and then passed over in silence is the failure mode this whole
  // change is about.
  if (outcome.status === 'rejected') {
    if (escalated.err !== null) {
      try {
        log.warn(
          `Compaction hit a budget ceiling (${escalated.err.message}) while the turn beside it ` +
            'failed; that failure is what ends the run, and the rotation is already charged.',
        );
      } catch {
        // Reporting the outranked ceiling must not cost the run the failure it
        // is reporting alongside. Same rule as `chargeFailure`'s.
      }
    }
    throw outcome.reason;
  }

  // After `work` has resolved and its caller-owned records have been written by
  // the callback itself.
  if (escalated.err !== null) throw escalated.err;

  // The catch above absorbs everything the rotation can raise, so this rejects
  // only if the absorbing itself failed - a console that has gone away, an
  // `err.message` that throws. Read rather than assumed: "the second slot cannot
  // reject" is exactly the assumption that lost the escalation in the first
  // place. An escalation that got that far is still the run being told to stop;
  // anything else is a compaction failure, which must not fail the run.
  if (compaction.status === 'rejected') {
    const reason: unknown = compaction.reason;
    if (reason instanceof Escalation) throw reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    log.warn(`Compaction failed and could not report why (${message}); continuing.`);
  }
  return outcome.value;
}
