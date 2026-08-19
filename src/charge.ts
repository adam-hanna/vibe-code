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
 * What a turn spent, in the shape `applyCharge` already takes.
 *
 * `costUsd` follows the same rule `TurnCharge` does: null where the provider
 * reports none.
 */
export interface TurnSpend {
  costUsd: number | null;
  tokens: number;
}

/**
 * What a failed turn spent, keyed by the error carrying it out.
 *
 * A side table rather than a field, and deliberately not a new error class:
 * every error raised today must still be raised with the same type and reach
 * the same handler in cli.ts, and the value has to ride on a `RateLimitError`
 * as readily as on a plain `Error` - the retry loop's `instanceof` check is
 * what decides whether a turn is retried at all. Nothing in `err.message`,
 * `err.stack`, `writeEscalation` or the `error` event changes.
 */
const SPENT = new WeakMap<object, TurnSpend>();

/**
 * Record what the turn this error ends spent. Returns `err`, so a throw site
 * can attach and throw in one expression.
 */
export function attachSpend<E>(err: E, spend: TurnSpend): E {
  if (typeof err === 'object' && err !== null) SPENT.set(err, spend);
  return err;
}

/** What a failed turn spent, without consuming it. For tests and diagnostics. */
export function spendOf(err: unknown): TurnSpend | null {
  if (typeof err !== 'object' || err === null) return null;
  return SPENT.get(err) ?? null;
}

/**
 * Read and clear, so the same failure cannot be charged twice as it unwinds
 * through more than one frame that knows how to pay.
 */
export function takeSpend(err: unknown): TurnSpend | null {
  const spend = spendOf(err);
  if (spend !== null) SPENT.delete(err as object);
  return spend;
}

/**
 * Charge what a failed turn spent, if it reported anything.
 *
 * Returns the `Escalation` a ceiling raised rather than throwing it: a failure
 * is already in flight, and it is the one that must reach cli.ts with its own
 * type and its own exit code, so each call site decides whether the ceiling may
 * displace it. The totals are updated either way, so a held ceiling is deferred
 * to the next check, not lost.
 *
 * An accounting fault - `recordEvent` persists state.json, so a full disk or a
 * deleted run directory can throw here - is reported and swallowed for the same
 * reason. It arrives *after* `state.tokensUsed` has been updated, so the spend
 * is still counted; letting it out would replace the run's real failure with a
 * write error, which is precisely what charging on the way out must never do.
 * This differs from `chargePreflight`, which propagates: nothing is in flight
 * there.
 */
export function chargeFailure(
  state: RunState,
  cfg: Config,
  err: unknown,
  meta: { label: string; provider: 'claude' | 'codex' },
): Escalation | null {
  const spend = takeSpend(err);
  if (spend === null) return null;
  // Nothing reported is nothing to charge: no totals to move, and no event
  // claiming a turn spent when it did not.
  if (spend.tokens <= 0 && (spend.costUsd ?? 0) <= 0) return null;

  const message = err instanceof Error ? err.message : String(err);
  try {
    applyCharge(state, cfg, {
      costUsd: spend.costUsd,
      tokens: spend.tokens,
      event: {
        type: 'turn_failed',
        data: {
          label: meta.label,
          provider: meta.provider,
          tokens: spend.tokens,
          costUsd: spend.costUsd,
          error: message.slice(0, 200),
        },
      },
      describe: () =>
        `${meta.label} (failed): ${fmtTokens(spend.tokens)} tok` +
        (spend.costUsd === null ? ', cost not reported' : `, ~$${spend.costUsd.toFixed(3)}`) +
        ` (run ${fmtTokens(state.tokensUsed)} tok / ~$${state.costUsd.toFixed(2)})`,
      warnings: [],
    });
  } catch (chargeErr: unknown) {
    if (chargeErr instanceof Escalation) return chargeErr;
    const why = chargeErr instanceof Error ? chargeErr.message : String(chargeErr);
    log.warn(
      `Could not record what the failed "${meta.label}" turn spent (${why}); ` +
        'the tokens are in the run totals but the ceilings were not consulted.',
    );
  }
  return null;
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

  // Only where the provider reported a cost. The check has always lived on the
  // Claude path alone, and `state.costUsd` can rise during a Codex turn from a
  // concurrent rotation - so running it here unconditionally would end the run
  // one turn earlier than it does today, before the critique or review artifact
  // that turn just paid for had been written.
  enforceCeilings(state, cfg, charge.costUsd !== null);
}

/**
 * The ceilings, without a charge.
 *
 * `includeCost` mirrors the routing `applyCharge` applies, because it is the
 * same rule and a second definition of what a ceiling means is how the session
 * rotation went unmetered in the first place. The retry loop needs this without
 * a charge: a failed attempt has already paid through `chargeFailure`, and what
 * is left to decide is whether the run may make another one.
 */
export function enforceCeilings(state: RunState, cfg: Config, includeCost: boolean): void {
  enforceTokenCeiling(state, cfg);
  if (includeCost) enforceCostCeiling(state, cfg);
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
