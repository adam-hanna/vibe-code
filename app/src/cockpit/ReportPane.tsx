import { useEffect, useRef, useState } from 'react';
import { SeverityChip } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { Counts } from './Counts';
import { Caret, Section } from './Disclosure';
import { ofKind, readReport } from './artifacts';
import { SEVERITIES } from './model';
import { DOCUMENT, EMPTY, FILE, HEAD, LABEL, NOTE, PANE } from './pane';
import { useArtifact, useArtifacts, noText } from './useArtifacts';
import { sizeOf } from './PlansPane';
import type { Severity } from '../design';
import type { Classified, FullFinding } from './artifacts';
import type { Census, FindingRow } from './model';
import type { RoundCard } from './rounds';

/**
 * What a judge said about a round, and what each finding actually claims
 * (`1e`, `4c`, hi-fi 9, #223).
 *
 * **One component for the critique and for the review, because they are one
 * screen.** `plan-critique-<n>.json` and `code-review-<n>.json` are the same
 * shape written by two roles at two boundaries; two panes would be two places to
 * fix the same rendering bug, and the design draws them identically.
 *
 * ## This is the drill-down the Findings tab could not have
 *
 * The old pane showed the latest round only, and for each finding a severity, a
 * title and its provenance — because that is all the wire carries. A frame
 * holding every finding in full would put a review's whole report on the wire
 * every round, so the detail and the suggested fix stayed in the artifact and
 * nothing could open the artifact.
 *
 * Now the artifact is what this reads, so a finding opens onto **what is wrong,
 * what would fix it, and every place it says to look** — which is the whole of
 * what a person needs in order to disagree with it. The Findings tab is gone: it
 * was one round of one of these two, and a reader looking for *why did the loop
 * fix again* was being shown half the evidence.
 *
 * ## The gate's counts are the gate's, and the list is the file's
 *
 * A section draws `Counts` from the **census** the loop narrated, because those
 * four numbers are what the gate decided on. The findings below them come from
 * the artifact. Where the two disagree — an older archive, a build that could
 * not place a row — the pane says so rather than letting the shorter list read as
 * the whole of what the round found. Nothing here recounts the file and presents
 * it as the gate's arithmetic.
 */

/** A severity this build knows how to weight, or null for the zero variant. */
function weight(severity: string): Severity | null {
  return (SEVERITIES as readonly string[]).includes(severity) ? (severity as Severity) : null;
}

/** Where a finding says to look, in the form a person can go and check. */
function citation(c: FullFinding['citations'][number]): string {
  if (c.path !== null) return c.line === null ? c.path : `${c.path}:${String(c.line)}`;
  return c.ref ?? c.kind;
}

/** A list of one-line facts about a finding: its history, its reproducer. */
const FACTS = 'm-0 flex list-none flex-col gap-1 p-0 text-body-sm text-secondary';
/** A caption over prose behind the fold: label weight, because it is not a title of its own. */
const CAPTION = cn(LABEL, 'mt-2 mb-0');
/** Prose the report carried. `pre-wrap`, because a reviewer's paragraphs are its own. */
const PROSE = 'm-0 whitespace-pre-wrap text-body text-secondary';
/** A field the report did not carry, named as absent rather than left blank. */
const ABSENT = 'm-0 text-body-sm text-tertiary';

/**
 * The two severity histories, kept apart (#142).
 *
 * A guard's downgrade and a person's restore are different facts and must never
 * share a line: one says *a guard fired, and why*, the other says *how this
 * reached the severity it has*. Collapsing them would erase the first, which is
 * exactly what #48 added it for.
 *
 * **From the wire, not from the artifact, and that asymmetry is the point.**
 * `AGENTS.md` is explicit that the round's own `code-review-<n>.json` is not
 * rewritten when a severity moves — it is the record of what the reviewer
 * produced, and editing it afterwards makes it a record of something else. So
 * the file has the prose and the census has what happened to the finding since,
 * and a pane that read only one of them would be missing half.
 */
function History({ row }: { row: FindingRow }) {
  const changes = row.severityChanges ?? [];
  if (row.downgraded === null && changes.length === 0) return null;
  return (
    <ul className={FACTS}>
      {row.downgraded !== null && (
        <li>
          <Badge>guard</Badge> downgraded from {row.downgraded.from} — {row.downgraded.reason}
        </li>
      )}
      {changes.map((c, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <li key={`${c.from}-${c.to}-${String(i)}`}>
          {/* `by` is `FindingAuthor`, the same vocabulary #141 put on the
              record - not a second enum that would eventually disagree about
              what `human` means. */}
          <Badge>{c.by ?? 'unattributed'}</Badge> moved {c.from} → {c.to}
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
 *   **not** a strike against the finding: the reason is what a reader acts on.
 *
 * `at` travels with each, because the same test run after the final fix answers
 * a different question from the same test run at review — *does this happen* and
 * *is it gone*. One line each, never merged into a latest verdict.
 */
function Reproducer({ outcomes }: { outcomes: FindingRow['reproducer'] }) {
  if (outcomes === null) return null;
  return (
    <ul className={FACTS}>
      {outcomes.map((o, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <li key={`${o.at}-${o.verdict}-${String(i)}`}>
          <Badge
            variant={
              o.verdict === 'reproduced'
                ? 'alarm'
                : o.verdict === 'did-not-reproduce'
                  ? 'live'
                  : 'quiet'
            }
          >
            {o.verdict}
          </Badge>{' '}
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
 * One finding, opened.
 *
 * **The three things behind the fold are the three a reader came for**: what is
 * wrong, what would fix it, and the places it cites. What stays out is the
 * severity, the title and the id — the three that make a list scannable, and the
 * ones `4c` puts first.
 *
 * A field the report did not carry is named as absent rather than left blank. An
 * empty `detail` under a heading reads as a rendering bug; *"the report carried
 * no detail"* reads as what it is, which is a reviewer that wrote a title and
 * stopped.
 */
function Finding({ finding, row }: { finding: FullFinding; row: FindingRow | null }) {
  const [open, setOpen] = useState(false);
  const w = weight(finding.severity);
  return (
    <div className="rounded-sm border border-rule-inner bg-panel">
      <button
        type="button"
        className="group flex w-full cursor-pointer flex-wrap items-baseline gap-3 border-0 bg-transparent p-3 text-left text-inherit outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Caret open={open} />
        <SeverityChip severity={w} label={finding.severity} />
        <span className="text-body font-medium text-primary group-hover:text-display">{finding.title}</span>
        <code className={cn(FILE, 'ml-auto')}>{finding.id}</code>
      </button>
      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <div className="flex flex-wrap gap-2">
            {finding.raisedBy === null ? (
              <Badge>author not recorded</Badge>
            ) : (
              <Badge>raised by {finding.raisedBy}</Badge>
            )}
            {finding.deferred && <Badge>deferred — real, and for separate work</Badge>}
            {/* The guards' downgrade, which is a fact about the severity above
                and has to be readable beside it. Never rewritten and never
                cleared, including by a person restoring the severity (#142). */}
            {finding.downgraded !== null && (
              <Badge variant="alarm">
                guard downgraded it from {finding.downgraded.from}
              </Badge>
            )}
            {/* Said out loud rather than left as an empty row. *Nobody tried to
                prove this* is part of the provenance - it is not a mark against
                the finding, and #113 is explicit that a finding without one
                behaves exactly as every finding did before reproducers. */}
            {row !== null && row.reproducer === null && (
              <Badge>no reproducer was written</Badge>
            )}
          </div>

          <h5 className={CAPTION}>What is wrong</h5>
          {finding.detail === null ? (
            <p className={ABSENT}>The report carried no detail for this finding.</p>
          ) : (
            <p className={PROSE}>{finding.detail}</p>
          )}

          <h5 className={CAPTION}>What would fix it</h5>
          {finding.suggestedFix === null ? (
            <p className={ABSENT}>The report suggested no fix.</p>
          ) : (
            <p className={PROSE}>{finding.suggestedFix}</p>
          )}

          <h5 className={CAPTION}>
            Where it says to look
            {finding.citations.length > 0 && ` · ${String(finding.citations.length)}`}
          </h5>
          {finding.citations.length === 0 ? (
            // `4c`'s ungrounded flag, in the pane that can now show what the
            // alternative looked like. The reviewer is held to the same standard
            // as the implementer: a claim that points nowhere is displayed as one.
            <p className={ABSENT}>
              Nothing. A blocking finding that cites nothing that resolves is carried as a P2 with
              the reason recorded.
            </p>
          ) : (
            <ul className={cn(FACTS, 'gap-2')}>
              {finding.citations.map((c, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <li key={`${c.kind}-${citation(c)}-${String(i)}`}>
                  <Badge>{c.kind}</Badge> <code className="font-mono text-mono-sm text-primary">{citation(c)}</code>
                  {c.excerpt !== null && (
                    <pre className="mt-1 mb-0 whitespace-pre-wrap border-l-2 border-rule-inner bg-card px-3 py-2 font-mono text-mono-sm text-tertiary [overflow-wrap:anywhere]">
                      {c.excerpt}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* What happened to this finding AFTER the report was written. The
              file cannot carry it - it is not rewritten when a severity moves -
              so this half comes off the census and is absent on a round this
              window did not watch. */}
          {row !== null && (row.downgraded !== null || (row.severityChanges ?? []).length > 0) && (
            <>
              <h5 className={CAPTION}>How it reached this severity</h5>
              <History row={row} />
            </>
          )}
          {row !== null && row.reproducer !== null && (
            <>
              <h5 className={CAPTION}>What the reviewer’s own test observed</h5>
              <Reproducer outcomes={row.reproducer} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The round's report, once its section is open. */
function ReportBody({
  dir,
  runId,
  name,
  census,
  revision,
}: {
  dir: string;
  runId: string;
  name: string;
  /** What the gate made of this round, or null when nothing narrated one. */
  census: Census | null;
  revision: number;
}) {
  const { read, failure, loading } = useArtifact(dir, runId, name, revision);
  const missing = noText(read, failure);

  if (loading && read === null && missing === null) {
    return <p className={NOTE}>reading {name}…</p>;
  }
  if (missing !== null) {
    return (
      <p className={NOTE}>
        <Badge>no report</Badge> {missing}
      </p>
    );
  }
  if (read === null || read.kind !== 'text') return null;

  const report = readReport(read.text);
  if (report === null) {
    return (
      <>
        <p className={NOTE}>
          <Badge variant="alarm">unreadable</Badge> This file is not the report shape this
          build understands. It is shown as it is on disk.
        </p>
        <pre className={DOCUMENT}>{read.text}</pre>
      </>
    );
  }

  const listed = report.findings.length;
  const counted =
    census === null ? null : SEVERITIES.reduce((n, s) => n + (census.counts[s] ?? 0), 0);

  return (
    <>
      {/* The gate's four counts, and the tolerance stated rather than left to be
          inferred from two numbers. Drawn from the census because that is what
          the gate decided on; a tally of the list below would be this pane's
          arithmetic wearing the gate's clothes. The loop's own sentence where it
          blocked, never one composed from the counts. */}
      {census !== null && (
        <>
          <Counts counts={census.counts} tolerance={census.tolerance} compact />
          <p className="m-0 text-body text-primary">
            {census.pass
              ? 'The gate passed.'
              : (census.reason ?? 'The gate blocked this round.')}
          </p>
        </>
      )}
      {census === null && report.verdict !== null && (
        // The report's own word, when no census was narrated for this round -
        // which is every round of a run this window joined late. It is the
        // judge's verdict and not the gate's decision, and it says which.
        <p className="m-0 text-body text-primary">
          <Badge>{report.verdict}</Badge> the judge’s own verdict. No gate decision was
          narrated to this window for this round.
        </p>
      )}

      {/* The summary is the paragraph a person reads before any individual
          finding, and no frame has ever carried it. */}
      {report.summary !== null && <p className={PROSE}>{report.summary}</p>}

      {listed === 0 ? (
        <p className={NOTE}>This round reported no findings at all.</p>
      ) : (
        report.findings.map((f) => (
          <Finding
            key={f.id}
            finding={f}
            // The census's row for the same finding, matched on the id both
            // carry. Null on a round this window did not watch, which is every
            // round of an earlier session - the prose is still there, and what
            // is missing is what happened to the finding afterwards.
            row={census?.findings.find((r) => r.id === f.id) ?? null}
          />
        ))
      )}

      {/* The gate's counts are the authority. If the list is shorter than they
          say, the pane admits it rather than letting the list read as the whole
          of what the round found. */}
      {counted !== null && listed < counted && (
        <p className={NOTE}>
          The counts above are the gate’s and are what decided the round; this build could read{' '}
          {listed} of the {counted} findings behind them.
        </p>
      )}
    </>
  );
}

/** What the two kinds are called, on screen and in the empty state. */
const WORDS = {
  critique: {
    title: 'critique',
    who: 'The critic judges each version of the plan and writes plan-critique-<round>.json.',
  },
  review: {
    title: 'review',
    who: 'The reviewer judges the implementation and writes code-review-<round>.json.',
  },
} as const;

export function ReportPane({
  dir,
  runId,
  kind,
  rounds,
  openAt,
  revision = 0,
}: {
  dir: string;
  runId: string | null;
  kind: 'critique' | 'review';
  /**
   * This session's round cards, so a section can show the gate's own counts.
   *
   * Not the source of the sections - those come from the listing, which covers
   * every round including the ones an earlier session ran. This only supplies
   * the census where there is one, which is why a round with no card still gets
   * a section and says what it does not have.
   */
  rounds: readonly RoundCard[];
  openAt?: number | null;
  /**
   * How many artifacts the run has said it wrote (#223).
   *
   * The complaint this answers was exact: *"when plan critique round 1 finished
   * I was already on the plan critique tab and it didn't automatically update"*.
   * Every section here is read from disk, so the pane cannot know a round landed
   * unless the run says so.
   */
  revision?: number;
}) {
  const { entries, failure, loading, reload } = useArtifacts(dir, runId, revision);
  const reports = ofKind(entries, kind);
  const [open, setOpen] = useState<string | null>(null);
  /** See `PlansPane`: the pane follows the run until the reader touches it. */
  const touched = useRef(false);
  const words = WORDS[kind];

  // The census for a round, from the card that carries it. Matched on the
  // ROUND rather than on position: a resumed run's listing holds rounds this
  // session never saw, so the two lists are different lengths and lining them
  // up by index would put round 0's counts under round 3.
  const censusFor = (round: number | null): Census | null => {
    if (round === null) return null;
    const card = rounds.find((c) => c.cycle === kind && c.round === round);
    return card?.census ?? null;
  };

  useEffect(() => {
    if (reports.length === 0) return;
    const wanted =
      openAt === null || openAt === undefined
        ? null
        : (reports.find((r) => r.round === openAt)?.name ?? null);
    if (wanted === null && touched.current) return;
    setOpen(wanted ?? latest(reports));
  }, [entries, openAt]);

  if (runId === null) {
    return (
      <div className={EMPTY}>
        <Badge>no run</Badge>
        <p className="m-0 max-w-md">A {words.title} is read out of a run’s own directory, so there has to be a run.</p>
      </div>
    );
  }

  if (failure !== null) {
    return (
      <div className={EMPTY}>
        <Badge variant="alarm">no {words.title}</Badge>
        <p className="m-0 max-w-md">{failure}</p>
        <Button variant="secondary" size="sm" onClick={reload}>
          try again
        </Button>
      </div>
    );
  }

  if (reports.length === 0) {
    return (
      <div className={EMPTY}>
        <Badge>{loading ? 'reading' : `no ${words.title} yet`}</Badge>
        <p className="m-0 max-w-md">{loading ? 'asking the host what this run has written…' : words.who}</p>
      </div>
    );
  }

  return (
    <div className={PANE}>
      <div className={HEAD}>
        <span>
          {reports.length} round{reports.length === 1 ? '' : 's'} of {words.title}
        </span>
        <Button variant="quiet" size="sm" onClick={reload}>
          reread
        </Button>
      </div>
      {reports.map((report) => (
        <Section
          key={report.name}
          id={report.round === null ? undefined : `${kind}-round-${String(report.round)}`}
          reveal={openAt !== null && openAt !== undefined && report.round === openAt}
          open={open === report.name}
          onToggle={() => {
            touched.current = true;
            setOpen((cur) => (cur === report.name ? null : report.name));
          }}
          title={
            report.round === null
              ? words.title
              : `${words.title} · round ${String(report.round)}`
          }
          meta={<Summary report={report} census={censusFor(report.round)} />}
        >
          <ReportBody
            dir={dir}
            runId={runId}
            name={report.name}
            census={censusFor(report.round)}
            revision={revision}
          />
        </Section>
      ))}
    </div>
  );
}

/**
 * What a shut section says about itself.
 *
 * The counts, because they are the reason to open one - hiding the summary
 * behind the fold hides the answer. Where no census was narrated the file name
 * and its size are all this can honestly say, and it says that rather than
 * counting the file it has not read yet.
 */
function Summary({ report, census }: { report: Classified; census: Census | null }) {
  return (
    <>
      {census !== null && <Counts counts={census.counts} compact className="my-0" />}
      <code className={FILE}>{report.name}</code>
      {report.bytes !== null && <Badge className="normal-case tracking-normal">{sizeOf(report.bytes)}</Badge>}
    </>
  );
}

/** The newest round, which is the one a reader almost always wants. */
function latest(reports: readonly Classified[]): string | null {
  const last = reports[reports.length - 1];
  return last?.name ?? null;
}
