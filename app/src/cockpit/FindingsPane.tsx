import { useState } from 'react';
import { Card, MetaChip, SeverityChip, StateKicker } from '../design';
import { SEVERITIES } from './model';
import type { Severity } from '../design';
import type { Census, FindingRow } from './model';

/**
 * The findings, and why the gate decided what it decided (`1e`, `4c`, #223).
 *
 * **The design's own framing, and it is what makes this different from a list.**
 * The question at a review boundary is not *how many findings* but *why did the
 * loop choose to fix again rather than finish*, and that is a comparison of four
 * counts against a tolerance. So the counters come first and the tolerance is
 * stated beside them, in a sentence rather than as a number to be inferred.
 *
 * Two density rules from the design travel with it:
 *
 * - **Four chips, zeros shown**, because a gate decision is being made here and
 *   an absence is information. Everywhere a verdict is a *status* rather than a
 *   decision it collapses to one chip; this is not one of those places.
 * - **Severity reads by weight, not by hue** - P0 solid, P1 accent, P2 tint, P3
 *   outline, zero dashed and grey. That is `SeverityChip`'s job and none of it
 *   is decided here.
 *
 * What is deliberately absent is the **disposition column** from `4c`: Accept,
 * Decline, Defer, Downgrade. Every one of those is a decision that mutates run
 * state, and `src/host.ts` is explicit that each needs its own validator before
 * it is offered. A row of buttons that produced no frame would be the `proposed`
 * chip shipped as though it were behaviour.
 */

/** A severity this build knows how to weight, or null for the zero variant. */
function weight(severity: string): Severity | null {
  return (SEVERITIES as readonly string[]).includes(severity) ? (severity as Severity) : null;
}

/**
 * The four chips, zeros included.
 *
 * A count of zero is drawn with `severity: null`, which is the dashed grey
 * variant - present, legible, and visibly not a quantity. That is the design's
 * rule and it is the opposite of hiding it: at a gate, *no P0s* is the most
 * important thing on the row.
 */
function Counts({ counts }: { counts: Readonly<Record<string, number>> }) {
  return (
    <div className="v-find__chips">
      {SEVERITIES.map((s) => {
        const n = counts[s] ?? 0;
        return <SeverityChip key={s} severity={n === 0 ? null : weight(s)} label={s} count={n} />;
      })}
    </div>
  );
}

/**
 * The consequence, in words, which is the line `5a` asks for by name.
 *
 * *"Nothing is blocking. Next decision is the verify gate, after this turn."* -
 * the open-findings block states the consequence rather than only the counts,
 * because counts are what a person then has to do arithmetic on.
 */
function consequence(census: Census): string {
  if (census.pass && census.tolerated.length === 0) {
    return census.phase === 'plan'
      ? 'Nothing is blocking, so the plan was approved and the loop moved to implementation.'
      : 'Nothing is blocking, so the review approved and the loop is finishing.';
  }
  if (census.pass) {
    return (
      `Nothing blocks, and ${String(census.tolerated.length)} P1 ` +
      `${census.tolerated.length === 1 ? 'finding is' : 'findings are'} carried into the next ` +
      'phase rather than argued about here — carried, not forgiven.'
    );
  }
  // The loop's own sentence, not one composed here. `gate()` writes it and it
  // names the exact arithmetic that stopped the round.
  return census.reason ?? 'The gate blocked this round.';
}

/**
 * The two severity histories, kept apart (#142).
 *
 * A guard's downgrade and a person's restore are different facts and must never
 * share a line: one says *a guard fired, and why*, the other says *how this
 * reached the severity it has*. Collapsing them would erase the first, which is
 * exactly what #48 added it for.
 */
function History({ finding }: { finding: FindingRow }) {
  const changes = finding.severityChanges ?? [];
  if (finding.downgraded === null && changes.length === 0) return null;
  return (
    <ul className="v-find__history">
      {finding.downgraded !== null && (
        <li>
          <MetaChip>guard</MetaChip> downgraded from {finding.downgraded.from} — {' '}
          {finding.downgraded.reason}
        </li>
      )}
      {changes.map((c, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <li key={`${c.from}-${c.to}-${String(i)}`}>
          {/* `by` is `FindingAuthor`, the same vocabulary #141 put on the
              record - not a second enum that would eventually disagree about
              what `human` means. */}
          <MetaChip>{c.by ?? 'unattributed'}</MetaChip> moved {c.from} → {c.to}
          {c.reason !== undefined && ` — ${c.reason}`}
        </li>
      ))}
    </ul>
  );
}

function Finding({ finding }: { finding: FindingRow }) {
  const w = weight(finding.severity);
  return (
    <Card severity={w ?? undefined}>
      <div className="v-find__head">
        <SeverityChip severity={w} label={finding.severity} />
        <span className="v-find__title">{finding.title}</span>
        <code className="v-find__id">{finding.id}</code>
      </div>
      <div className="v-find__meta">
        {/* Absent means absent. A finding from before #141 has no author and
            this says so rather than naming the role that probably wrote it. */}
        {finding.raisedBy === null ? (
          <MetaChip>author not recorded</MetaChip>
        ) : (
          <MetaChip>raised by {finding.raisedBy}</MetaChip>
        )}
        {/* `4c`'s ungrounded flag. The reviewer is held to the same standard as
            the implementer: a claim that points nowhere is displayed as one. */}
        {finding.evidence === 0 ? (
          <MetaChip kind="alarm">ungrounded — cites nothing</MetaChip>
        ) : (
          <MetaChip kind="checkable">
            {finding.evidence} citation{finding.evidence === 1 ? '' : 's'}
          </MetaChip>
        )}
      </div>
      <History finding={finding} />
    </Card>
  );
}

/** `blocking 2 → 0`, from the censuses behind this one. */
function Trend({ censuses }: { censuses: readonly Census[] }) {
  if (censuses.length < 2) return null;
  const blocking = censuses.map((c) => (c.counts['P0'] ?? 0) + (c.counts['P1'] ?? 0));
  return (
    <p className="v-find__trend">
      blocking {blocking.join(' → ')} over {censuses.length} rounds
    </p>
  );
}

export function FindingsPane({ censuses }: { censuses: readonly Census[] }) {
  const [open, setOpen] = useState<string | null>(null);

  if (censuses.length === 0) {
    return (
      <div className="v-find v-find--empty">
        <StateKicker tone="quiet">no rounds yet</StateKicker>
        <p>
          A census arrives when the critic or the reviewer reports. Nothing has reached a gate in
          this run.
        </p>
      </div>
    );
  }

  const latest = censuses[censuses.length - 1];
  if (latest === undefined) return null;
  const sameCycle = censuses.filter((c) => c.phase === latest.phase);

  return (
    <div className="v-find">
      <section className="v-find__gate">
        <h3 className="v-find__round">
          {latest.phase === 'plan' ? 'critique' : 'review'}
          <MetaChip>{latest.pass ? 'gate passed' : 'gate blocked'}</MetaChip>
        </h3>
        <Counts counts={latest.counts} />
        {/* The tolerance, stated rather than left to be inferred from two
            numbers. It is the whole reason the counts are legible as a
            decision. */}
        <p className="v-find__tolerance">
          The gate carries up to {latest.tolerance} P1
          {latest.tolerance === 1 ? '' : 's'} forward; a P0 is never carried.
        </p>
        <p className="v-find__consequence">{consequence(latest)}</p>
        <Trend censuses={sameCycle} />
      </section>

      <section className="v-find__list">
        {latest.findings.length === 0 ? (
          <p className="v-find__none">This round reported no findings at all.</p>
        ) : (
          latest.findings.map((f) => (
            <button
              key={f.id}
              className="v-find__row"
              onClick={() => setOpen((cur) => (cur === f.id ? null : f.id))}
              aria-expanded={open === f.id}
            >
              <Finding finding={f} />
            </button>
          ))
        )}
        {/* The gate's own counts are the authority. If the list is shorter than
            they say, the pane admits it rather than letting the list read as
            the whole of what the round found. */}
        {latest.findings.length <
          SEVERITIES.reduce((n, s) => n + (latest.counts[s] ?? 0), 0) && (
          <p className="v-find__none">
            The counts above are the gate&apos;s and are what decided the round; this build could
            not read every finding behind them.
          </p>
        )}
      </section>
    </div>
  );
}
