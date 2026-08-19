import * as log from '@src/log.js';
import { recordEvent } from '@src/run.js';
import type { Config, Finding, OpenQuestion, RunState } from '@src/types.js';

/**
 * How a turn is paid for, and the ceilings that stop the run when it cannot be.
 *
 * A leaf, for the same reason `@src/roles.js` is one: the orchestrator owns the
 * loop but not the arithmetic, and `@src/context.js` has to charge a session
 * rotation through exactly this function. The orchestrator already imports
 * `context.js`, so leaving the accounting there and importing it back would be
 * a cycle - and a second, rotation-shaped definition of what a turn costs is
 * how rotation went unmetered in the first place.
 *
 * The orchestrator re-exports `EXIT`, `Escalation` and `applyCharge`, so its
 * callers and tests keep one import site.
 */

export const EXIT = {
  OK: 0,
  ERROR: 1,
  NEEDS_HUMAN: 2,
  NO_CONVERGENCE: 3,
  BUDGET: 4,
  RATE_LIMITED: 5,
  /** The agents' execution environments do not satisfy the toolchain contract. */
  PREFLIGHT: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class Escalation extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
    readonly questions: OpenQuestion[] | null = null,
    readonly findings: Finding[] | null = null,
  ) {
    super(message);
    this.name = 'Escalation';
  }
}

/**
 * What one turn cost the run, in the shape the shared accounting needs.
 *
 * `costUsd` is null where the provider reports no cost. Codex reports none, and
 * inventing a figure would make `state.costUsd` a number nobody could trace to
 * a source.
 */
export interface TurnCharge {
  costUsd: number | null;
  tokens: number;
  event: { type: string; data: Record<string, unknown> };
  /** Built after the totals are updated, so the line can quote the run total. */
  describe: () => string;
  /** Emitted after the detail line and before the ceilings, as both paths did. */
  warnings: readonly string[];
}

/**
 * The per-turn accounting every turn shares - both providers, and the session
 * rotation in `@src/context.js`.
 *
 * Deliberately synchronous, and deliberately called by each adapter in the same
 * continuation as its provider result rather than by `runTurn` after another
 * `await`. Critique and review run under `withConcurrentCompaction`, so a
 * rotation is completing on another promise chain while a Codex turn finishes;
 * an extra await boundary here would let `session_rotated` and its handoff cost
 * land between the Codex result and the Codex turn's own event and log line,
 * reordering the run record against what the two separate paths produced.
 */
export function applyCharge(state: RunState, cfg: Config, charge: TurnCharge): void {
  state.tokensUsed += charge.tokens;
  if (charge.costUsd === null) {
    state.codexTokens = (state.codexTokens ?? 0) + charge.tokens;
  } else {
    state.costUsd = Number((state.costUsd + charge.costUsd).toFixed(4));
  }

  recordEvent(state, charge.event.type, charge.event.data);
  log.detail(charge.describe());
  for (const warning of charge.warnings) log.warn(warning);

  enforceTokenCeiling(state, cfg);
  // Only where the provider reported a cost. The check has always lived on the
  // Claude path alone, and `state.costUsd` can rise during a Codex turn from a
  // concurrent rotation - so running it here unconditionally would end the run
  // one turn earlier than it does today, before the critique or review artifact
  // that turn just paid for had been written.
  if (charge.costUsd !== null) enforceCostCeiling(state, cfg);
}

/**
 * The one ceiling both agents answer to.
 *
 * Shared rather than duplicated per adapter because the Codex side has no cost
 * figure to fall back on: if this check were only wired into the Claude path,
 * a run whose expensive work sat with Codex would have no working brake at all.
 */
function enforceTokenCeiling(state: RunState, cfg: Config): void {
  if (cfg.budget.maxTokens <= 0 || state.tokensUsed <= cfg.budget.maxTokens) return;
  throw new Escalation(
    EXIT.BUDGET,
    `Token ceiling exceeded: ${fmtTokens(state.tokensUsed)} > ${fmtTokens(cfg.budget.maxTokens)}. ` +
      'Raise budget.maxTokens to continue.',
  );
}

/** The Claude-side ceiling. Codex reports no cost, so it can never trip this. */
function enforceCostCeiling(state: RunState, cfg: Config): void {
  if (state.costUsd <= cfg.budget.maxCostUsd) return;
  throw new Escalation(
    EXIT.BUDGET,
    `Work ceiling reached: ~$${state.costUsd.toFixed(2)} API-equivalent > $${cfg.budget.maxCostUsd}. ` +
      'On a subscription this is a volume brake, not a bill. Raise budget.maxCostUsd to continue.',
  );
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
