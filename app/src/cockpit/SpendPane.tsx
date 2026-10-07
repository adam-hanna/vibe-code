import { Bar } from '../design';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
import { clock, tokens as fmtTokens } from './format';
import { LABEL, PANE } from './pane';
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

/** One block of the pane: a heading and what it measured. */
const BLOCK = 'flex flex-col gap-2';
const H = cn(LABEL, 'm-0 text-body-sm');
const NOTE = 'm-0 text-body-sm text-secondary';
/** A named absence, never a blank and never a zero. */
const ABSENT = 'm-0 text-body-sm text-tertiary';
const FIGURE = 'm-0 font-mono text-mono-sm tabular-nums text-primary';
/** The per-phase and per-compaction rows: a name, a figure, a note. */
const ROWS = 'm-0 flex list-none flex-col gap-1 p-0';
const ROW = 'flex items-baseline gap-3 border-b border-rule-inner py-1';

export function SpendPane({ run }: { run: Run }) {
  const { spend } = run;
  const beat = run.running?.beat ?? null;
  const phases = byPhase(spend.charges);

  return (
    <div className={cn(PANE, 'gap-5')}>
      <section className={BLOCK}>
        <h3 className={H}>run total</h3>
        {spend.tokens === null ? (
          <p className={ABSENT}>
            No turn has reported a charge yet. This is the one honest ceiling the tool has and it
            covers both loop agents — it is not drawn until one of them has spent something.
          </p>
        ) : (
          <>
            <p className="m-0 text-title font-medium tracking-tight text-display">{fmtTokens(spend.tokens)} tokens</p>
            {/* No bar. There is no denominator: `budget.maxTokens` is config and
                is not on the wire, and a bar against a ceiling nobody set would
                be the invented denominator this repo refuses. */}
            <p className={NOTE}>
              Across {spend.charges.length} turn{spend.charges.length === 1 ? '' : 's'}, covering
              both loop agents.
              {spend.codexTokens !== null && (
                <> {fmtTokens(spend.codexTokens)} of it is Codex.</>
              )}
            </p>
            {spend.costUsd !== null && spend.costUsd > 0 && (
              <p className={NOTE}>
                ~${spend.costUsd.toFixed(2)} <Badge>Claude-side only</Badge> — Codex reports
                no cost from any output mode, so this is not a run total and is never presented as
                one.
              </p>
            )}
          </>
        )}
      </section>

      <section className={BLOCK}>
        <h3 className={H}>per phase</h3>
        {phases.length === 0 ? (
          <p className={ABSENT}>nothing charged yet</p>
        ) : (
          <ul className={ROWS}>
            {phases.map((p) => (
              <li key={p.phase} className={ROW}>
                <span className="flex-1 text-body-sm text-primary">{p.phase}</span>
                <span className={FIGURE}>{fmtTokens(p.tokens)}</span>
                <span className={NOTE}>
                  {p.turns} turn{p.turns === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={BLOCK}>
        <h3 className={H}>context</h3>
        {/* The one bar in the product, drawn only when both halves are real.
            A known window with a prompt size of zero would draw a bar at 0%, and
            a bar at 0% and a bar that cannot be measured look identical while
            meaning opposite things. */}
        {beat !== null && beat.contextWindow !== null && beat.promptTokens > 0 ? (
          <>
            <Bar segments={[{ share: beat.promptTokens / beat.contextWindow, step: 1 }]} />
            <p className={FIGURE}>
              {fmtTokens(beat.promptTokens)} of {fmtTokens(beat.contextWindow)}
            </p>
            <p className={NOTE}>
              Claude&apos;s conversation, as of the last heartbeat.
            </p>
          </>
        ) : (
          <p className={ABSENT}>
            {run.running === null
              ? 'no turn is running, so there is no live conversation to measure'
              : 'this turn has not reported both a prompt size and a window, so there is no fraction to draw'}
          </p>
        )}

        {/* Never 0%, never blank — an absence with its reason. Two reasons, and
            both are settled decisions rather than gaps. */}
        <div className="mt-3 flex items-baseline gap-3">
          <Badge>codex</Badge>
          <span className="text-body-sm text-tertiary">
            n/a — Codex reports no per-request usage, and its window size is a setting rather than
            something vibe can derive. Neither is a measurement this build is missing.
          </span>
        </div>
      </section>

      <section className={BLOCK}>
        <h3 className={H}>compaction</h3>
        {/* `5e` asks for these by name and gives the reason: it is the moment the
            agent starts forgetting, so it cannot be silent. The wire has carried
            `session_compacting` since #133 and nothing drew it until now — the
            same failure as #198, where the mechanism landed and the two halves
            were never connected. */}
        {run.compactions.length === 0 ? (
          <p className={ABSENT}>
            Nothing has been compacted. A rotation happens when Claude&apos;s conversation grows
            past <code>context.compactAbove</code>, and it is Claude-only — Codex reports no
            per-request usage, so there is no occupancy to rotate on.
          </p>
        ) : (
          <ul className={ROWS}>
            {run.compactions.map((c) => (
              <li key={`${c.slot}-${String(c.at)}`} className={ROW}>
                <span className="flex-1 text-body-sm text-primary">
                  {c.slot}
                  {c.model !== null && <span className="text-secondary"> · {c.model}</span>}
                </span>
                <span className={FIGURE}>
                  {/* The ratio it fired at, or the reason there is none. Null on
                      the baseline branch, and drawn as null rather than as a
                      percentage nobody took. */}
                  {c.measured === null ? '—' : `${(c.measured * 100).toFixed(0)}%`}
                </span>
                <span className={NOTE}>{clock(c.at)}</span>
              </li>
            ))}
          </ul>
        )}
        {run.compactions.some((c) => c.measured === null) && (
          <p className={ABSENT}>
            A dash means the occupancy was measured under a different model, so the ratio would
            have been against the wrong window.
          </p>
        )}
      </section>

      <section className={BLOCK}>
        <h3 className={H}>not here</h3>
        <p className={ABSENT}>
          The pilot&apos;s tokens are its own books and are never summed into these — a
          conversation about the work is not the work. Provider headroom is the scarcity that
          actually matters on a subscription, and no frame carries it.
        </p>
      </section>
    </div>
  );
}
