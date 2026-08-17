import { randomUUID } from 'node:crypto';
import { claudeTurn } from '@src/claude.js';
import * as log from '@src/log.js';
import { progressOptions } from '@src/progress.js';
import { handoffPrompt } from '@src/prompts.js';
import { artifact, recordEvent, saveState } from '@src/run.js';
import type { Config, RunState } from '@src/types.js';

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
  return state.contextRatio >= cfg.context.compactAboveRatio;
}

/**
 * Summarise and rotate. Safe to run concurrently with a Codex turn: it only
 * touches the outgoing Claude session, which nothing else is using.
 */
export async function rotateSession(state: RunState, cfg: Config): Promise<void> {
  const ratioPct = (state.contextRatio * 100).toFixed(0);
  log.step(`Compacting Claude session (context at ${ratioPct}%)`);

  const result = await claudeTurn({
    prompt: handoffPrompt(),
    sessionId: state.sessionId,
    resume: true,
    permissionMode: 'plan',
    model: cfg.claude.model,
    effort: 'low',
    cwd: state.targetDir,
    tools: ['Read'],
    timeoutMs: cfg.claude.planTimeoutMs,
    progress: progressOptions(state, cfg, 'compact'),
  });

  state.costUsd = Number((state.costUsd + result.costUsd).toFixed(4));
  state.sessionRotations += 1;
  state.handoff = result.text;
  state.sessionId = randomUUID();
  state.sessionStarted = false;
  state.contextRatio = 0;

  artifact(state, `handoff-${state.sessionRotations}.md`, result.text);
  recordEvent(state, 'session_rotated', {
    rotation: state.sessionRotations,
    costUsd: result.costUsd,
    newSessionId: state.sessionId,
  });
  saveState(state);

  log.ok(`Rotated to a fresh session (handoff-${state.sessionRotations}.md)`);
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
      // Compaction is an optimisation; losing it must not fail the run.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Compaction failed, continuing on the existing session: ${message}`);
    }),
  ]);
  return result;
}
