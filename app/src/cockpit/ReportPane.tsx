import { useEffect, useRef, useState } from 'react';
import { SeverityChip } from '../design';
import { Markdown } from '../design/Markdown';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { Counts } from './Counts';
import { Caret, Section } from './Disclosure';
import {
  CONSENSUS_WORDS,
  confirmedBy,
  consensusFilters,
  disagreedFiles,
  foundByLine,
  inConsensus,
  mergedAs,
  nearLines,
  ofKind,
  outcomeEntries,
  panelLine,
  priorLines,
  readConfirmations,
  readDispositions,
  readNearPairs,
  readReport,
  readSeatReport,
  revisionRan,
  scopeLine,
  seatLabel,
  seatSlots,
  votesLine,
} from './artifacts';
import { SEVERITIES, gateSentence } from './model';
import { DOCUMENT, EMPTY, FILE, HEAD, LABEL, NOTE, PANE } from './pane';
import { useArtifact, useArtifactReads, useArtifacts, noText } from './useArtifacts';
import type { Loaded } from './useArtifacts';
import { sizeOf } from './PlansPane';
import type { Severity } from '../design';
import type { Answerer, Classified, Consensus, FullFinding, JudgedFile, NearPair, SeatReport, SeatSlot } from './artifacts';
import type { Census, FinderMerge, FindingRow, FixDispositionsFrame } from './model';
import type { RoundCard } from './rounds';
import { shownRound } from './rounds';

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
const CAPTION = cn(LABEL, 'mt-2 mb-0 font-bold');
/**
 * Prose the report carried, drawn as the Markdown the judge wrote it in (#530).
 * It was a `pre-wrap` paragraph, so `**foo**` and backticks showed literally.
 */
const PROSE = 'text-secondary';
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
function History({
  row,
  byVote = false,
}: {
  row: FindingRow;
  /**
   * The downgrade was the review vote's (#388 Part C), which the report file
   * says and the census does not. Named as the vote rather than as *guard*: it
   * is the one move that rests on what other agents concluded, not on a
   * mechanical check, and a reader weighing an override needs to know which.
   */
  byVote?: boolean;
}) {
  const changes = row.severityChanges ?? [];
  if (row.downgraded === null && changes.length === 0) return null;
  return (
    <ul className={FACTS}>
      {row.downgraded !== null && (
        <li>
          <Badge>{byVote ? 'vote' : 'guard'}</Badge> downgraded from {row.downgraded.from} — {row.downgraded.reason}
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
function Finding({
  finding,
  row,
  reported,
  outcome,
  near = [],
  mergedInto = null,
}: {
  finding: FullFinding;
  row: FindingRow | null;
  /** How many finders reported this round, or null when no merge frame said. */
  reported: number | null;
  /**
   * What the fixer did with it and what came after, as `outcomeLine` says it
   * (#393), with the reason split off to be drawn as prose (#530).
   */
  outcome: readonly { line: string; head: string; reason: string | null }[];
  /**
   * The pairs the fix prompt named this finding in, as `nearLines` says them
   * (#462, #530): empty without `fix-near-pairs-<n>.json`, which adds nothing.
   */
  near?: readonly string[];
  /**
   * In a seat's own view (#530): the merged finding this one went into, or
   * null. Never set in the merged view, where it would name the finding itself.
   */
  mergedInto?: string | null;
}) {
  const [open, setOpen] = useState(false);
  // The report file says the vote moved it; the census row only says a guard did (#388 Part C).
  const movedByVote = finding.votes?.outcome === 'unconfirmed' && finding.downgraded !== null;
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
            {/* Who found it, behind the fold and never on the row (#388 Part B).
                A finding with no `foundBy` adds nothing here. */}
            {finding.foundBy !== null && <Badge>{foundByLine(finding.foundBy, reported)}</Badge>}
            {mergedInto !== null && <Badge>in the merged report as {mergedInto}</Badge>}
            {/* The vote, below who found it and never on the row (#388 Part C).
                A finding nobody voted on adds nothing here. */}
            {finding.votes !== null && <Badge>{votesLine(finding.votes)}</Badge>}
            {/* What the fixer did with it, below the vote and beside the
                severity history (#393). Later evidence is its own badge. */}
            {outcome.map((o) => (
              <Badge key={o.line}>{o.head}</Badge>
            ))}
            {finding.deferred && <Badge>deferred — real, and for separate work</Badge>}
            {/* The guards' downgrade, which is a fact about the severity above
                and has to be readable beside it. Never rewritten and never
                cleared, including by a person restoring the severity (#142). */}
            {finding.downgraded !== null && (
              <Badge variant="alarm">
                {movedByVote
                  ? `${finding.downgraded.reason}, moved from ${finding.downgraded.from}`
                  : `guard downgraded it from ${finding.downgraded.from}`}
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
          {/* The disposition's reason, under the badge that names it: prose
              the fixer or the planner wrote, so drawn as Markdown (#530). */}
          {outcome.some((o) => o.reason !== null) && (
            <ul className={cn(FACTS, 'gap-2')}>
              {outcome.map((o) =>
                o.reason === null ? null : (
                  <li key={o.line} className="flex flex-col gap-1">
                    <span>{o.head}</span>
                    <Markdown text={o.reason} className="text-body-sm text-secondary" />
                  </li>
                ),
              )}
            </ul>
          )}
          {/* One entry per ballot: the seat, its vote and its reason. Every
              verifier saw the same claim and none saw another's vote. The
              reason is the verifier's prose, drawn as Markdown (#530). */}
          {finding.votes !== null && finding.votes.ballots.length > 0 && (
            <ul className={cn(FACTS, 'gap-2')}>
              {finding.votes.ballots.map((b) => (
                <li key={b.seat} className="flex flex-col gap-1">
                  <span>
                    {b.seat}: {b.vote}
                    {b.counted === b.vote ? '' : ` (counted as ${b.counted})`}
                  </span>
                  <Markdown text={b.reason} className="text-body-sm text-secondary" />
                </li>
              ))}
            </ul>
          )}
          {/* What a seat declared this the same as, under the findings ledger
              (#498). Nothing at all without it. */}
          {finding.foundBy !== null && priorLines(finding.foundBy).length > 0 && (
            <ul className={FACTS}>
              {priorLines(finding.foundBy).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {/* The pairs the fixer was asked to tell apart (#462), on both
              findings of each pair. Nothing at all without the file. */}
          {near.length > 0 && (
            <ul className={FACTS}>
              {near.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          <h5 className={CAPTION}>What is wrong</h5>
          {finding.detail === null ? (
            <p className={ABSENT}>The report carried no detail for this finding.</p>
          ) : (
            <Markdown text={finding.detail} className={PROSE} />
          )}

          <h5 className={CAPTION}>What would fix it</h5>
          {finding.suggestedFix === null ? (
            <p className={ABSENT}>The report suggested no fix.</p>
          ) : (
            <Markdown text={finding.suggestedFix} className={PROSE} />
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
              <History row={row} byVote={movedByVote} />
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

/**
 * A round's counts and what the gate made of them, at the head of its report.
 *
 * The loop's own sentence where it blocked, never one composed from the counts.
 * Where no gate decision reached this window - no census at all, which is every
 * round of a run it joined late, or a census without a `pass`, which is every
 * replayed one (#437) - the report's own verdict stands in, labelled as the
 * judge's word and not the gate's. It was *"The gate blocked this round."*,
 * read off a missing field, over a review the loop called clean.
 */
export function GateHead({
  census,
  verdict,
}: {
  census: Census | null;
  verdict: string | null;
}) {
  const sentence = census === null ? null : gateSentence(census);
  return (
    <>
      {census !== null && <Counts counts={census.counts} tolerance={census.tolerance} compact />}
      {sentence !== null && <p className="m-0 text-body text-primary">{sentence}</p>}
      {sentence === null && verdict !== null && (
        <p className="m-0 text-body text-primary">
          <Badge>{verdict}</Badge> the judge’s own verdict. No gate decision was
          narrated to this window for this round.
        </p>
      )}
    </>
  );
}

/**
 * The round's panel in a line, under its head (#530): how many seats sat, how
 * many reported, what the merge did, and what the vote came to - and each seat
 * that failed, by its config path, with the error the core recorded.
 *
 * Nothing at all for a round with one seat and no vote, so a default round
 * draws exactly what it did before.
 */
function PanelSummary({ finders, findings }: { finders: FinderMerge | null; findings: readonly FullFinding[] }) {
  const line = panelLine(finders, findings);
  const failed = finders?.failed ?? [];
  if (line === null && failed.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {line !== null && <p className="m-0 text-body-sm text-secondary">{line}</p>}
      {failed.length > 0 && (
        <ul className={FACTS}>
          {failed.map((f) => (
            <li key={`${f.seat}-${String(f.seq)}`}>
              <Badge variant="alarm">seat failed</Badge> {f.seat}
              {/* Named by vendor and model where the event carried them; an
                  older run's event did not, and says the seat alone. */}
              {f.provider !== null && f.model !== null && ` ${f.provider}/${f.model}`}
              {f.finder !== null && ` (finder ${String(f.finder)})`}
              {f.label !== null && ` on ${f.label}`}
              {f.error !== null && ` — ${f.error}`}. It contributed no findings.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The filters over a panel round's findings (#530). Provenance stays off the
 * finding row (#388), so a reader asking *which of these did only one seat
 * see?* narrows the list here instead of opening every finding.
 */
function ConsensusBar({
  options,
  chosen,
  onChoose,
  count,
}: {
  options: readonly Consensus[];
  chosen: Consensus;
  onChoose: (c: Consensus) => void;
  count: (c: Consensus) => number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter the findings by the panel">
      <span className={LABEL}>show</span>
      {options.map((c) => (
        <Button
          key={c}
          size="sm"
          variant={c === chosen ? 'secondary' : 'quiet'}
          aria-pressed={c === chosen}
          onClick={() => onChoose(c)}
        >
          {CONSENSUS_WORDS[c]} · {count(c)}
        </Button>
      ))}
    </div>
  );
}

/**
 * The judge files on which the seats did not all say the same (#404, #530).
 * The combined verdict fails closed and is what the run acted on; this names
 * who dissented, which the combined verdict cannot. Nothing for a round whose
 * seats agreed, or that had one seat.
 */
function TestDisagreements({ files }: { files: readonly JudgedFile[] }) {
  if (files.length === 0) return null;
  return (
    <>
      <h5 className={CAPTION}>Where the seats disagreed about a change to the tests</h5>
      <ul className={cn(FACTS, 'gap-2')}>
        {files.map((f) => (
          <li key={f.path} className="flex flex-col gap-1">
            <span>
              <code className="font-mono text-mono-sm text-primary">{f.path}</code>
              {f.verdict !== null && (
                <>
                  {' '}
                  <Badge>{f.verdict}, combined</Badge>
                </>
              )}
            </span>
            <ul className={cn(FACTS, 'pl-3')}>
              {f.seats.map((v) => (
                <li key={v.seat}>
                  {v.seat} {v.provider}/{v.model}: <Badge variant={v.verdict === 'not justified' ? 'alarm' : 'quiet'}>{v.verdict}</Badge>
                  {v.reason !== null && ` — ${v.reason}`}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * What the check after the final fix said about each carried finding (#489,
 * #530), shown with the review round the final fix answered. A verdict here
 * never moved a severity or bought a round; it is a record for a person, and
 * the pane says which check made it - a seat, a reproducer, or none at all.
 */
function FinalFixChecks({
  dir,
  runId,
  file,
  revision,
}: {
  dir: string;
  runId: string;
  file: Classified;
  revision: number;
}) {
  const { read, failure } = useArtifact(dir, runId, file.name, revision);
  const missing = noText(read, failure);
  const confirmations = read?.kind === 'text' ? readConfirmations(read.text) : null;
  return (
    <>
      <h5 className={CAPTION}>After the final fix</h5>
      {missing !== null ? (
        <p className={NOTE}>
          <Badge>no record</Badge> {missing}
        </p>
      ) : read?.kind === 'text' && confirmations === null ? (
        <p className={NOTE}>
          <Badge variant="alarm">unreadable</Badge> {file.name} is not the shape this build understands.
        </p>
      ) : confirmations === null ? (
        <p className={NOTE}>reading {file.name}…</p>
      ) : (
        <>
          <p className={NOTE}>{scopeLine(confirmations.scope)}</p>
          {confirmations.findings.length === 0 ? (
            <p className={NOTE}>No carried finding has a verdict yet.</p>
          ) : (
            <ul className={cn(FACTS, 'gap-2')}>
              {confirmations.findings.map((c) => (
                <li key={c.id} className="flex flex-col gap-1">
                  <span>
                    <Badge variant={c.counted === 'fixed' ? 'live' : c.counted === 'still-present' ? 'alarm' : 'quiet'}>
                      {c.counted}
                    </Badge>{' '}
                    <code className="font-mono text-mono-sm text-primary">{c.id}</code> — {confirmedBy(c)}
                    {c.counted !== c.verdict && `; said ${c.verdict}, counted ${c.counted}`}
                    {c.countedReason !== null && ` (${c.countedReason})`}
                  </span>
                  {c.reason !== null && <Markdown text={c.reason} className="text-body-sm text-secondary" />}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

/**
 * Which report the round's section shows (#530): the merged one, which is what
 * the gate decided on, or one seat's own. Only drawn when the listing holds a
 * seat file for the round, so a round without finders has no switch at all.
 */
function SeatSwitch({
  labels,
  chosen,
  onChoose,
}: {
  labels: readonly { k: number; label: string }[];
  chosen: number | null;
  onChoose: (k: number | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Which report to show">
      <span className={LABEL}>report</span>
      <Button size="sm" variant={chosen === null ? 'secondary' : 'quiet'} aria-pressed={chosen === null} onClick={() => onChoose(null)}>
        merged
      </Button>
      {labels.map((l) => (
        <Button
          key={l.k}
          size="sm"
          variant={chosen === l.k ? 'secondary' : 'quiet'}
          aria-pressed={chosen === l.k}
          onClick={() => onChoose(l.k)}
        >
          {l.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * One seat's own report (#530), as it stood before the merge across seats: its
 * own words, severities and ids. The merge kept only the winning finding's
 * text, so this is the one place a merged-away seat's claim can be read.
 *
 * Drawn with the same `Finding` as the merged list, without what belongs to
 * the merged finding - the census row, the fixer's outcome, the near pairs -
 * because those were decided about the merged ids, not this seat's. A file the
 * listing does not hold, or that cannot be read, says so here.
 */
function SeatView({
  slot,
  loaded,
  label,
  seat,
  merged,
}: {
  slot: SeatSlot;
  loaded: Loaded | null;
  label: string;
  seat: SeatReport | null;
  merged: readonly FullFinding[];
}) {
  if (slot.name === null) {
    const f = slot.failure;
    return (
      <p className={NOTE}>
        <Badge>no report</Badge> No report of {label}’s is beside this round.{' '}
        {f === null
          ? 'The round’s merge counted this seat, and no file for it is in the run’s directory.'
          : `It failed${f.label === null ? '' : ` on ${f.label}`}${f.error === null ? '' : ` — ${f.error}`}, and contributed no findings.`}
      </p>
    );
  }
  const missing = loaded === null ? null : noText(loaded.read, loaded.failure);
  if (missing !== null) {
    return (
      <p className={NOTE}>
        <Badge>no report</Badge> {missing}
      </p>
    );
  }
  if (loaded === null || loaded.read === null || loaded.read.kind !== 'text') {
    return <p className={NOTE}>reading {slot.name}…</p>;
  }
  if (seat === null) {
    return (
      <>
        <p className={NOTE}>
          <Badge variant="alarm">unreadable</Badge> {slot.name} is not the report shape this build
          understands. It is shown as it is on disk.
        </p>
        <pre className={DOCUMENT}>{loaded.read.text}</pre>
      </>
    );
  }
  const own = seat.report;
  return (
    <>
      <p className={NOTE}>
        What {label} reported on its own, before the merge across seats. The counts above are the
        merged round’s, which is what the gate decided on.
      </p>
      {own.verdict !== null && (
        <p className="m-0 text-body text-primary">
          <Badge>{own.verdict}</Badge> this seat’s own verdict.
        </p>
      )}
      {own.summary !== null && <Markdown text={own.summary} className={PROSE} />}
      {own.findings.length === 0 ? (
        <p className={NOTE}>This seat reported no findings at all.</p>
      ) : (
        own.findings.map((f) => (
          <Finding
            key={f.id}
            finding={f}
            row={null}
            reported={null}
            outcome={[]}
            mergedInto={mergedAs(merged, seat.seat, f.id)}
          />
        ))
      )}
    </>
  );
}

/** The round's report, once its section is open. */
function ReportBody({
  dir,
  runId,
  name,
  census,
  finders,
  revision,
  dispositions = null,
  nextReview = null,
  notRecorded = false,
  by = 'fixer',
  finalChecks = null,
  seats = [],
  nearPairs = null,
}: {
  dir: string;
  runId: string;
  name: string;
  /** What the gate made of this round, or null when nothing narrated one. */
  census: Census | null;
  /** What this round's review finders came to, or null when nothing narrated one. */
  finders: FinderMerge | null;
  revision: number;
  /** The fix round's `fix-dispositions-<n+1>.json` answering this review, or null (#393). */
  dispositions?: Classified | null;
  /** The next review's `code-review-<n+1>.json`, or null. */
  nextReview?: Classified | null;
  /** The fix round answering this review ran and recorded no dispositions. */
  notRecorded?: boolean;
  /** Who answered the round: the fixer for a review, the planner for a critique (#457). */
  by?: Answerer;
  /** The `final-fix-confirm-<n+1>.json` of the final fix that answered this review, or null (#530). */
  finalChecks?: Classified | null;
  /** The round's seats, from `seatSlots`: empty when it left no seat file (#530). */
  seats?: readonly SeatSlot[];
  /** The `fix-near-pairs-<n+1>.json` of the fix round that answered this review, or null (#530). */
  nearPairs?: Classified | null;
}) {
  const [consensus, setConsensus] = useState<Consensus>('all');
  // Null is the merged report; a number is a seat's `k` (#530).
  const [view, setView] = useState<number | null>(null);
  const seatNames = seats.flatMap((slot) => (slot.name === null ? [] : [slot.name]));
  const seatReads = useArtifactReads(dir, runId, seatNames, revision);
  const near = useArtifact(dir, runId, nearPairs?.name ?? null, revision);
  const { read, failure, loading } = useArtifact(dir, runId, name, revision);
  const missing = noText(read, failure);
  const fixed = useArtifact(dir, runId, dispositions?.name ?? null, revision);
  const next = useArtifact(dir, runId, nextReview?.name ?? null, revision);
  const file = fixed.read?.kind === 'text' ? readDispositions(fixed.read.text) : null;
  const raised =
    next.read?.kind === 'text' ? new Set(readReport(next.read.text)?.findings.map((f) => f.id) ?? []) : null;
  const answering = {
    listed: dispositions?.round ?? null,
    file,
    unrecorded: notRecorded,
    raised,
    // Absent for the fixer, so a review's outcome is built exactly as before.
    ...(by === 'planner' ? { by } : {}),
  };

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

  // Each seat with what its file says, read once for the tab and the view.
  const seatViews = seats.map((slot) => {
    const i = slot.name === null ? -1 : seatNames.indexOf(slot.name);
    const loaded = i < 0 ? null : (seatReads[i] ?? null);
    const seat = loaded?.read?.kind === 'text' ? readSeatReport(loaded.read.text) : null;
    return { slot, loaded, seat, label: seatLabel(slot, seat) };
  });
  // A seat this round no longer offers (a reread that lost its file) reads as merged.
  const chosen = seatViews.find((v) => v.slot.k === view) ?? null;

  const nearMissing = noText(near.read, near.failure);
  const nearRead = near.read?.kind === 'text' ? readNearPairs(near.read.text) : null;
  const pairs: readonly NearPair[] = nearRead?.pairs ?? [];

  const listed = report.findings.length;
  const reported = finders?.reported ?? null;
  const filters = consensusFilters(report.findings, reported);
  // A filter this round does not offer (a reread that lost the votes) reads as all.
  const showing = filters.includes(consensus) ? consensus : 'all';
  const shown = report.findings.filter((f) => inConsensus(f, showing, reported));
  const counted =
    census === null ? null : SEVERITIES.reduce((n, s) => n + (census.counts[s] ?? 0), 0);

  return (
    <>
      {/* The gate's four counts, and the tolerance stated rather than left to be
          inferred from two numbers. Drawn from the census because that is what
          the gate decided on; a tally of the list below would be this pane's
          arithmetic wearing the gate's clothes. The loop's own sentence where it
          blocked, never one composed from the counts. */}
      <GateHead census={census} verdict={report.verdict} />
      {/* The panel under the gate's head (#530): nothing for a one-seat round. */}
      <PanelSummary finders={finders} findings={report.findings} />

      {/* Each seat's own report beside the merged one (#530): nothing for a
          round that left no seat file. */}
      {seatViews.length > 0 && (
        <SeatSwitch
          labels={seatViews.map((v) => ({ k: v.slot.k, label: v.label }))}
          chosen={chosen === null ? null : chosen.slot.k}
          onChoose={setView}
        />
      )}

      {chosen !== null ? (
        <SeatView slot={chosen.slot} loaded={chosen.loaded} label={chosen.label} seat={chosen.seat} merged={report.findings} />
      ) : (
        <>
          {/* The summary is the paragraph a person reads before any individual
              finding, and no frame has ever carried it. */}
          {report.summary !== null && <Markdown text={report.summary} className={PROSE} />}

          <TestDisagreements files={disagreedFiles(report.testChanges)} />

          {filters.length > 0 && listed > 0 && (
            <ConsensusBar
              options={filters}
              chosen={showing}
              onChoose={setConsensus}
              count={(c) => report.findings.filter((f) => inConsensus(f, c, reported)).length}
            />
          )}

          {listed === 0 ? (
            <p className={NOTE}>This round reported no findings at all.</p>
          ) : shown.length === 0 ? (
            <p className={NOTE}>No finding of this round is {CONSENSUS_WORDS[showing]}.</p>
          ) : (
            shown.map((f) => (
              <Finding
                key={f.id}
                finding={f}
                // The census's row for the same finding, matched on the id both
                // carry. Null on a round this window did not watch, which is every
                // round of an earlier session - the prose is still there, and what
                // is missing is what happened to the finding afterwards.
                row={census?.findings.find((r) => r.id === f.id) ?? null}
                reported={reported}
                outcome={outcomeEntries(f.id, answering)}
                near={nearLines(f.id, pairs)}
              />
            ))
          )}

          {/* A near-pairs file the listing holds and this build could not use is
              said, never dropped; no file at all says nothing. */}
          {nearPairs !== null && nearMissing !== null && (
            <p className={NOTE}>
              <Badge>no record</Badge> {nearPairs.name}: {nearMissing}
            </p>
          )}
          {nearPairs !== null && near.read?.kind === 'text' && nearRead === null && (
            <p className={NOTE}>
              <Badge variant="alarm">unreadable</Badge> {nearPairs.name} is not the shape this build
              understands, so no finding is marked as one the fixer was told may be the same defect.
            </p>
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

          {finalChecks !== null && <FinalFixChecks dir={dir} runId={runId} file={finalChecks} revision={revision} />}
        </>
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
  fixDispositions = [],
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
  /**
   * The run's fix-round dispositions frames (#393): what says a round's
   * dispositions could not be read, which no file on disk can say.
   */
  fixDispositions?: readonly FixDispositionsFrame[];
}) {
  const { entries, failure, loading, reload } = useArtifacts(dir, runId, revision);
  const reports = ofKind(entries, kind);
  // Classified out of the listing, never composed from a round: the fix round
  // that answers `code-review-<n>.json` is `n + 1`, and so is the next review.
  // A critique the same way (#457): the revision answering
  // `plan-critique-<n>.json` writes `plan-dispositions-<n + 1>.json`, and the
  // critique of that revision is `plan-critique-<n + 1>.json`.
  const answers = kind === 'review' ? 'dispositions' : 'plan-dispositions';
  // The final fix's confirmations answer the review before it, as its
  // dispositions do (#530): `final-fix-confirm-<n + 1>.json` with `code-review-<n>.json`.
  const finalChecksFor = (round: number | null): Classified | null =>
    kind !== 'review' || round === null
      ? null
      : (ofKind(entries, 'final-fix-confirm').find((c) => c.round === round + 1) ?? null);
  const answering = (round: number | null): Classified | null =>
    round === null ? null : (ofKind(entries, answers).find((c) => c.round === round + 1) ?? null);
  // The near pairs the fix answering a review was told about (#462, #530):
  // `recordNearPairs` numbers the file by the fix round, after the increment,
  // in the ordinary and the final fix alike, so `fix-near-pairs-<n + 1>.json`
  // goes with `code-review-<n>.json`. A plan revision writes none.
  const nearPairsFor = (round: number | null): Classified | null =>
    kind !== 'review' || round === null
      ? null
      : (ofKind(entries, 'near-pairs').find((c) => c.round === round + 1) ?? null);
  const nextReviewOf = (round: number | null): Classified | null =>
    round === null ? null : (reports.find((c) => c.round === round + 1) ?? null);
  // A round that ran and recorded nothing: the frame that says its answer could
  // not be read, or - for a run from before #393, or an archive opened without
  // its frames - the round's report with no dispositions file beside it.
  // A critique's, from the listing alone (`revisionRan`, #457).
  const unrecordedFor = (round: number | null): boolean => {
    if (round === null) return false;
    if (kind === 'critique') return revisionRan(entries, round);
    return (
      // The last frame for the round: a round redone after a stop says again.
      fixDispositions.filter((d) => d.answers === round).at(-1)?.recorded === false ||
      ofKind(entries, 'fix-report').some((c) => c.round === round + 1)
    );
  };
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
  // The finder merge for a round, matched the same way and for the same reason.
  const findersFor = (round: number | null): FinderMerge | null => {
    if (round === null) return null;
    const card = rounds.find((c) => c.cycle === kind && c.round === round);
    return card?.finders ?? null;
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
              // From one, as the headings count (#428); the id, the census
              // and the link keep the file's round.
              : `${words.title} · round ${String(shownRound(report.round))}`
          }
          meta={<Summary report={report} census={censusFor(report.round)} />}
        >
          <ReportBody
            dir={dir}
            runId={runId}
            name={report.name}
            census={censusFor(report.round)}
            finders={findersFor(report.round)}
            revision={revision}
            dispositions={answering(report.round)}
            nextReview={nextReviewOf(report.round)}
            notRecorded={unrecordedFor(report.round)}
            by={kind === 'review' ? 'fixer' : 'planner'}
            finalChecks={finalChecksFor(report.round)}
            nearPairs={nearPairsFor(report.round)}
            seats={report.round === null ? [] : seatSlots(entries, kind, report.round, findersFor(report.round))}
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
