import { useState } from 'react';
import { Card, MetaChip, SeverityChip, StateKicker } from '../design';
import { Counts } from './Counts';
import { SEVERITIES, persistence } from './model';
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
// The four counts are drawn identically here, in the loop column and on the
// pilot's round card, so they are one component in `./Counts`. `compact` and no
// `onOpen`: the tolerance is stated below in a sentence, and this pane IS the
// findings, so there is nowhere for a chip to send anybody.

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

/**
 * What the reviewer's own test observed (#113, hi-fi 9's third case).
 *
 * **The three verdicts are not three shades of the same thing**, which is why
 * they get three chips rather than one with a value in it:
 *
 * - `reproduced` — the gate passed on this tree without the file and failed
 *   with it. The finding points at something that actually happens, and this is
 *   the strongest evidence any finding in this product can carry.
 * - `did-not-reproduce` — the test the reviewer wrote to make its own finding
 *   fail did not fail. `toP2` demotes on this, so the demotion is in
 *   `downgraded` beside it and this is the evidence for it.
 * - `unproven` — nothing was observed. Grounded and still uncheckable, which is
 *   the state the pane could not draw at all before this landed, and it is
 *   **not** a strike against the finding: the reason is what a reader acts on.
 *
 * `at` travels with each, because the same test run after the final fix answers
 * a different question from the same test run at review — *does this happen* and
 * *is it gone*. One line each, never merged into a latest verdict.
 */
function Reproducer({ outcomes }: { outcomes: FindingRow['reproducer'] }) {
  if (outcomes === null) return null;
  return (
    <ul className="v-find__history">
      {outcomes.map((o, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <li key={`${o.at}-${o.verdict}-${String(i)}`}>
          <MetaChip
            kind={
              o.verdict === 'reproduced'
                ? 'alarm'
                : o.verdict === 'did-not-reproduce'
                  ? 'checkable'
                  : 'default'
            }
          >
            {o.verdict}
          </MetaChip>{' '}
          {o.at === 'review' ? 'before the fix' : 'after the final fix'}
          {/* The reason is the whole value of `unproven`: the file could not be
              placed, no gate could be resolved, or it failed with no baseline
              to attribute the failure to. Those need different responses. */}
          {o.reason !== null && ` — ${o.reason}`}
        </li>
      ))}
    </ul>
  );
}

/**
 * One finding, as a row that opens.
 *
 * **The row was already a `<button>` and the click did nothing.** It set an
 * `open` id that nothing rendered, so every finding drew its provenance, its
 * severity history and its reproducer outcomes at once and the cursor promised a
 * disclosure that was not there — reported as *"items in the findings page have a
 * hand pointing mouse but don't do anything when clicked"*.
 *
 * What is behind the fold is the **provenance**, which is the part a reader goes
 * looking for rather than scans: who raised it, how many citations it carries,
 * whether it survived a fix, and what the reviewer's own test observed. What
 * stays out is the severity, the title and the id — the three things that make a
 * list of findings scannable, and the ones `4c` puts first.
 */
function Finding({
  finding,
  rounds,
  open,
  onToggle,
}: {
  finding: FindingRow;
  rounds: number;
  open: boolean;
  onToggle: () => void;
}) {
  const w = weight(finding.severity);
  return (
    <Card severity={w ?? undefined}>
      <button
        type="button"
        className="v-find__head v-find__head--link"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="v-disclose" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <SeverityChip severity={w} label={finding.severity} />
        <span className="v-find__title">{finding.title}</span>
        <code className="v-find__id">{finding.id}</code>
      </button>
      {open && <FindingBody finding={finding} rounds={rounds} />}
    </Card>
  );
}

function FindingBody({ finding, rounds }: { finding: FindingRow; rounds: number }) {
  return (
    <>
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
        {/* `4c`'s persisted state, worded as what it actually is. A finding
            surviving a fix round is the loop arguing with itself, and it is
            what the oscillation guard counts — but the guard's own streak runs
            over `state.roundHistory`, which is not on this wire, so this says
            *seen in* rather than claiming the guard's verdict. */}
        {rounds > 1 && (
          <MetaChip kind="alarm">seen in the last {rounds} rounds — it survived a fix</MetaChip>
        )}
        {/* Hi-fi 9's fifth case: the reviewer declining to have it fixed here.
            Real, worth doing, separate work — a disposition rather than a
            severity, and `parseFindings` refuses a deferred P0 or P1, so this
            is never the reason a gate blocked. */}
        {finding.deferred && <MetaChip>deferred — real, and for separate work</MetaChip>}
        {/* Said out loud rather than left as an empty row. `4c` shows a finding
            as a claim with provenance, and *nobody tried to prove this* is part
            of the provenance - it is not a mark against the finding, and #113
            is explicit that a finding without one behaves exactly as every
            finding did before reproducers existed. */}
        {finding.reproducer === null && <MetaChip>no reproducer was written</MetaChip>}
      </div>
      <History finding={finding} />
      <Reproducer outcomes={finding.reproducer} />
    </>
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
  const surviving = persistence(censuses);

  return (
    <div className="v-find">
      <section className="v-find__gate">
        <h3 className="v-find__round">
          {latest.phase === 'plan' ? 'critique' : 'review'}
          <MetaChip>{latest.pass ? 'gate passed' : 'gate blocked'}</MetaChip>
        </h3>
        <Counts counts={latest.counts} compact />
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
            <Finding
              key={f.id}
              finding={f}
              rounds={surviving.get(f.id) ?? 1}
              open={open === f.id}
              onToggle={() => { setOpen((cur) => (cur === f.id ? null : f.id)); }}
            />
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
