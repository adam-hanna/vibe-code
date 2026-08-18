import { randomUUID } from 'node:crypto';
import { claudeTurn } from '@src/claude.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import * as log from '@src/log.js';
import { progressOptions, rememberContextWindow } from '@src/progress.js';
import { handoffPrompt } from '@src/prompts.js';
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
 * Codex needs no equivalent. Every Codex call is a one-shot `codex exec` with
 * no resumed session, so its context does not accumulate across the run.
 */

export function shouldRotate(state: RunState, cfg: Config): boolean {
  if (!cfg.context.enabled) return false;
  if (!state.sessionStarted) return false;

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
): Promise<void> {
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
  try {
    result = await turn({
      prompt: handoffPrompt(),
      sessionId: state.sessionId,
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
    if (!baseline) throw err;
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Handoff briefing failed (${message}); rotating to a fresh session without a new one.`);
  }

  state.sessionRotations += 1;
  state.sessionId = randomUUID();
  state.sessionStarted = false;
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

  if (result === null) {
    // The previous briefing is kept - it is the only account of the run the new
    // session can be given - but flagged, because it describes an earlier point
    // than the session just abandoned. The plan of record is attached by
    // handoffContext regardless of either, so a fresh session is never started
    // blind to what it is meant to be building.
    state.handoffStale = true;
  } else {
    state.costUsd = Number((state.costUsd + result.costUsd).toFixed(4));
    state.handoff = result.text;
    delete state.handoffStale;
    artifact(state, `handoff-${state.sessionRotations}.md`, result.text);
  }

  recordEvent(state, 'session_rotated', {
    rotation: state.sessionRotations,
    costUsd: result?.costUsd ?? 0,
    newSessionId: state.sessionId,
    contextModel: cfg.claude.model,
    baseline,
    handoffModel,
    handoff: result !== null,
  });

  log.ok(
    result === null
      ? 'Rotated to a fresh session (no handoff briefing)'
      : `Rotated to a fresh session (handoff-${state.sessionRotations}.md)`,
  );
}

/**
 * Run `work` and, if the session is over the threshold, compact concurrently.
 *
 * This is the point of doing it here: the summarisation happens while Codex is
 * already busy critiquing or reviewing, so it costs no extra wall-clock and
 * never interrupts a Claude turn mid-flight.
 */
export async function withConcurrentCompaction<T>(
  state: RunState,
  cfg: Config,
  work: () => Promise<T>,
): Promise<T> {
  if (!cfg.context.compactDuringCodex || !shouldRotate(state, cfg)) {
    return work();
  }

  const [result] = await Promise.all([
    work(),
    rotateSession(state, cfg).catch((err: unknown) => {
      // Compaction on a measured session is an optimisation; losing it must not
      // fail the run. A baseline rotation never lands here - it rotates even
      // when the briefing fails, because continuing on an unattributable
      // session is the thing it exists to prevent.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Compaction failed, continuing on the existing session: ${message}`);
    }),
  ]);
  return result;
}
