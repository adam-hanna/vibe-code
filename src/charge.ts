import * as log from '@src/log.js';
import { recordEvent, saveState } from '@src/run.js';
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
  /**
   * A precondition of the phases ahead is not satisfied: the agents' execution
   * environments do not meet the toolchain contract, or the target directory
   * cannot host those phases at all - `vibe run` outside a git repository, whose
   * review phase has no diff to read (#71).
   */
  PREFLIGHT: 6,
  /**
   * The loop finished and a required verification gate never ran.
   *
   * Not an error and not a stall: the work is done, reviewed and committed, and
   * its artifacts are worth having. What is missing is the evidence that it
   * runs, and 0 has always been documented to mean verification passed (#47).
   */
  UNVERIFIED: 7,
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
  /**
   * Which agent spent it, stated rather than inferred (#77).
   *
   * The share used to be routed on `costUsd === null`, which was a proxy that
   * held only while every null-cost charge was Codex's. It stopped holding the
   * moment a Claude turn could be charged with no cost figure - a turn recovered
   * from a killed process, or one charged from the stream after a failure - and
   * a proxy that is right by coincidence is one that misreports both agents when
   * the coincidence ends. `codexTokens` is documented as the Codex share and
   * `summary()` renders `tokensUsed - codexTokens` as Claude's.
   */
  provider: 'claude' | 'codex';
  /** The turn this pays for, which is how its in-flight record is found. */
  label: string;
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
 *
 * A spend of nothing is not recorded, and that is the contract every reader
 * gets: `spendOf` returning null means "nothing to charge", whether the turn
 * reported no usage at all or reported none worth charging. The two are
 * indistinguishable to the accounting - neither moves a total and neither
 * deserves an event - so they are not distinguished here either, rather than
 * leaving each call site to decide whether a zero is worth attaching.
 */
export function attachSpend<E>(err: E, spend: TurnSpend): E {
  if (spend.tokens <= 0 && (spend.costUsd ?? 0) <= 0) return err;
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
 * What the stream observed for a turn, removing the record. Null when there is
 * none, and null when there is one carrying no figure - a Codex entry, which
 * says a turn was in flight and nothing about what it spent.
 *
 * Removal without a caller-side save on purpose: every caller is about to write
 * anyway, and disposing of the record has to land in that same write. See
 * `RunState.inFlight` for why an entry must never outlive its own accounting.
 */
export function takeInFlight(
  state: RunState,
  label: string,
  provider: 'claude' | 'codex',
): number | null {
  const list = state.inFlight;
  if (list === undefined) return null;
  const index = list.findIndex((e) => e.label === label && e.provider === provider);
  if (index === -1) return null;
  const [entry] = list.splice(index, 1);
  // Absent is what a run with nothing in flight looks like, and `[]` would be a
  // second spelling of it for every reader to remember.
  if (list.length === 0) delete state.inFlight;
  return entry?.tokens ?? null;
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
 *
 * The ceilings are run either way. A failed write is a lost record; it must not
 * also be a lost brake, and the totals it failed to persist are in memory and
 * already over.
 *
 * Two figures, never summed (#77). The provider's, attached at the throw site,
 * and vibe's own, observed on the stream and persisted by the heartbeat. They
 * measure the same turn, so the larger is charged: the provider's is
 * structurally incomplete whenever the failure envelope carries no usage block
 * (`src/claude.ts` builds `tokens: 0` beside a real cost for exactly that case),
 * and the stream's is incomplete when the turn died between two throttled
 * writes. `tokensFrom` records which one was used, because a figure this repo
 * charges has to be traceable to the thing that measured it.
 */
export function chargeFailure(
  state: RunState,
  cfg: Config,
  err: unknown,
  meta: { label: string; provider: 'claude' | 'codex' },
): Escalation | null {
  // Null is the whole "nothing reported" answer - `attachSpend` never records a
  // spend of nothing - so there is no second zero test here. One definition.
  const spend = takeSpend(err);
  // Read and removed unconditionally: this failure is the turn's accounting, and
  // whatever it decides, the record must not outlive it. A turn that reported
  // nothing and observed nothing still has a `'start'` entry to dispose of, and
  // leaving that behind is what would make a later resume announce an ordinary
  // failed turn as a killed one.
  const observed = takeInFlight(state, meta.label, meta.provider) ?? 0;
  const reported = spend?.tokens ?? 0;
  const tokens = Math.max(reported, observed);
  const costUsd = spend?.costUsd ?? null;

  if (tokens <= 0 && (costUsd ?? 0) <= 0) {
    // Nothing observed and nothing reported: no event, because nothing happened
    // that a reader could act on - but the record above is gone, and that has to
    // reach disk. Swallowed for the same reason the accounting fault below is:
    // a write fault must never replace the failure already in flight.
    try {
      saveState(state);
    } catch {
      // A lost disposal is recovered as an interrupted turn at worst, which
      // reports honestly and charges nothing.
    }
    return null;
  }

  const message = err instanceof Error ? err.message : String(err);
  try {
    applyCharge(state, cfg, {
      costUsd,
      tokens,
      provider: meta.provider,
      label: meta.label,
      event: {
        type: 'turn_failed',
        data: {
          label: meta.label,
          provider: meta.provider,
          tokens,
          costUsd,
          tokensFrom: observed > reported ? 'stream' : 'provider',
          error: message.slice(0, 200),
        },
      },
      describe: () =>
        `${meta.label} (failed): ${fmtTokens(tokens)} tok` +
        (observed > reported ? ' observed on the stream' : '') +
        (costUsd === null ? ', cost not reported' : `, ~$${costUsd.toFixed(3)}`) +
        ` (run ${fmtTokens(state.tokensUsed)} tok / ~$${state.costUsd.toFixed(2)})`,
      warnings: [],
    });
  } catch (chargeErr: unknown) {
    if (chargeErr instanceof Escalation) return chargeErr;

    // The totals moved before the write or the log line failed, so the ceilings
    // still have something to check - and a run that has just crossed one must
    // not carry on because state.json could not be written. Enforced here rather
    // than left to the next charge, which may never come.
    let ceiling: Escalation | null = null;
    try {
      enforceCeilings(state, cfg, costUsd !== null);
    } catch (ceilingErr: unknown) {
      // `enforceCeilings` raises nothing else. Anything that is not a ceiling is
      // a fault in the accounting itself and belongs with the fault below.
      if (!(ceilingErr instanceof Escalation)) throw ceilingErr;
      ceiling = ceilingErr;
    }

    const why = chargeErr instanceof Error ? chargeErr.message : String(chargeErr);
    // Quietly, and last: a broken console is one of the ways to arrive here, and
    // it must not cost the run the ceiling that was just enforced.
    try {
      log.warn(
        `Could not record what the failed "${meta.label}" turn spent (${why}); ` +
          'the tokens are in the run totals and the ceilings were still enforced.',
      );
    } catch {
      // Reporting a lost record must never be what takes down the run.
    }
    return ceiling;
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
  // Two independent questions since #77, where one used to answer both: which
  // agent's share this is, and whether there is a cost figure at all.
  if (charge.provider === 'codex') {
    state.codexTokens = (state.codexTokens ?? 0) + charge.tokens;
  }
  if (charge.costUsd !== null) {
    state.costUsd = Number((state.costUsd + charge.costUsd).toFixed(4));
  }

  // Before the event, so `recordEvent`'s save carries the charge and the
  // disposal of what it paid for in one write. Split across two writes, a kill
  // between them would leave an entry the next run charges a second time.
  const observed = takeInFlight(state, charge.label, charge.provider);
  const data =
    observed !== null && observed > charge.tokens
      ? { ...charge.event.data, observedTokens: observed }
      : charge.event.data;

  recordEvent(state, charge.event.type, data);
  // Said out loud rather than dropped. The provider's own figure is what a
  // completed turn is charged - it is the authority, and re-charging the
  // difference would invent spend - but evidence that disagrees with it is a
  // fact about this run, and a silently discarded one is how a systematic
  // shortfall would go unnoticed.
  if (observed !== null && observed > charge.tokens) {
    log.warn(
      `${charge.label}: the stream observed ${fmtTokens(observed)} tok but the turn reported ` +
        `${fmtTokens(charge.tokens)}; charged what was reported, and recorded the difference.`,
    );
  }
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
