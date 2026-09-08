import { Bar, MetaChip, StateKicker } from '../design';
import { tokens as fmtTokens } from './format';
import type { Charge, Run } from './model';

/**
 * What the run has spent, and how much room the context has left (`5e`/`6e`).
 *
 * **Both accounts are subscriptions, so tokens are the only unit.** There is no
 * dollar mode and there will not be one: Codex returns no cost from any output
 * mode or endpoint, and estimating one from a price table is a settled, closed
 * decision - a dollar view could only ever show half the run. The one figure
 * that exists is Claude-side, and it says so wherever it appears rather than
 * sitting under a heading that implies it covers both.
 *
 * **The pilot is not on this screen at all.** Its tokens are the app's own
 * conversation rather than the run's, and #145 keeps the two sets of books
 * apart structurally - `ledger.ts` cannot reach `applyCharge` even by accident.
 * Quietly making one ceiling cover three parties would break it, and the design
 * says so in its own words. The pilot pane shows its own.
 *
 * ## The one bar in the app
 *
 * Context is drawn as a bar because `promptTokens / contextWindow` is a real
 * number over a known one. **Everything else here is a quantity with no
 * denominator**, and the rule is stated at the top of `format.ts`: if you cannot
 * name the denominator, it is not a bar. A run total has no ceiling unless
 * somebody set one, and `budget.maxTokens` is not on the wire.
 *
 * Codex gets a **named absence with its reason**, never 0% and never blank: it
 * reports no per-request usage and its window size is a setting rather than a
 * derivation, which is itself a settled decision.
 */

/** Group the charges by the phase they were stamped with. */
function byPhase(charges: readonly Charge[]): { phase: string; tokens: number; turns: number }[] {
  const out: { phase: string; tokens: number; turns: number }[] = [];
  for (const c of charges) {
    // A charge from before the first `phase_started` belongs to no phase, which
    // is a real state rather than a gap: preflight spends before any phase opens.
    const key = c.phase ?? 'before the first phase';
    const row = out.find((r) => r.phase === key);
    if (row === undefined) out.push({ phase: key, tokens: c.tokens, turns: 1 });
    else {
      row.tokens += c.tokens;
      row.turns += 1;
    }
  }
  return out;
}

export function SpendPane({ run }: { run: Run }) {
  const { spend } = run;
  const beat = run.running?.beat ?? null;
  const phases = byPhase(spend.charges);

  return (
    <div className="v-spend">
      <section className="v-spend__block">
        <h3 className="v-spend__h">run total</h3>
        {spend.tokens === null ? (
          <p className="v-spend__absent">
            No turn has reported a charge yet. This is the one honest ceiling the tool has and it
            covers both loop agents — it is not drawn until one of them has spent something.
          </p>
        ) : (
          <>
            <p className="v-spend__total">{fmtTokens(spend.tokens)} tokens</p>
            {/* No bar. There is no denominator: `budget.maxTokens` is config and
                is not on the wire, and a bar against a ceiling nobody set would
                be the invented denominator this repo refuses. */}
            <p className="v-spend__note">
              Across {spend.charges.length} turn{spend.charges.length === 1 ? '' : 's'}, covering
              both loop agents.
              {spend.codexTokens !== null && (
                <> {fmtTokens(spend.codexTokens)} of it is Codex.</>
              )}
            </p>
            {spend.costUsd !== null && spend.costUsd > 0 && (
              <p className="v-spend__note">
                ~${spend.costUsd.toFixed(2)} <MetaChip>Claude-side only</MetaChip> — Codex reports
                no cost from any output mode, so this is not a run total and is never presented as
                one.
              </p>
            )}
          </>
        )}
      </section>

      <section className="v-spend__block">
        <h3 className="v-spend__h">per phase</h3>
        {phases.length === 0 ? (
          <p className="v-spend__absent">nothing charged yet</p>
        ) : (
          <ul className="v-spend__phases">
            {phases.map((p) => (
              <li key={p.phase}>
                <span className="v-spend__phase">{p.phase}</span>
                <span className="v-spend__figure">{fmtTokens(p.tokens)}</span>
                <span className="v-spend__note">
                  {p.turns} turn{p.turns === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="v-spend__block">
        <h3 className="v-spend__h">context</h3>
        {/* The one bar in the product, drawn only when both halves are real.
            A known window with a prompt size of zero would draw a bar at 0%, and
            a bar at 0% and a bar that cannot be measured look identical while
            meaning opposite things. */}
        {beat !== null && beat.contextWindow !== null && beat.promptTokens > 0 ? (
          <>
            <Bar segments={[{ share: beat.promptTokens / beat.contextWindow, step: 1 }]} />
            <p className="v-spend__figure">
              {fmtTokens(beat.promptTokens)} of {fmtTokens(beat.contextWindow)}
            </p>
            <p className="v-spend__note">
              Claude&apos;s conversation, as of the last heartbeat. Compaction is an event in the
              output stream — the agent starting to forget cannot be silent.
            </p>
          </>
        ) : (
          <p className="v-spend__absent">
            {run.running === null
              ? 'no turn is running, so there is no live conversation to measure'
              : 'this turn has not reported both a prompt size and a window, so there is no fraction to draw'}
          </p>
        )}

        {/* Never 0%, never blank — an absence with its reason. Two reasons, and
            both are settled decisions rather than gaps. */}
        <div className="v-spend__codex">
          <StateKicker tone="quiet">codex</StateKicker>
          <span className="v-spend__absent">
            n/a — Codex reports no per-request usage, and its window size is a setting rather than
            something vibe can derive. Neither is a measurement this build is missing.
          </span>
        </div>
      </section>

      <section className="v-spend__block">
        <h3 className="v-spend__h">not here</h3>
        <p className="v-spend__absent">
          The pilot&apos;s tokens are its own books and are never summed into these (#145) — a
          conversation about the work is not the work. Provider headroom is the scarcity that
          actually matters on a subscription, and no frame carries it.
        </p>
      </section>
    </div>
  );
}
