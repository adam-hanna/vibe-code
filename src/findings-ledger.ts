import { readArtifact } from '@src/run.js';
import { hasFindingShape } from '@src/stored.js';
import type { Finding, FindingsReport, RunState, Severity } from '@src/types.js';
import { readEvidence, reproductionAt } from '@src/validate.js';

/**
 * The findings ledger for later review rounds (#498, groundwork).
 *
 * Under `loop.findingsLedger`, every review prompt from round 2 on lists what
 * each earlier round recorded, by id, so a seat can declare which one a finding
 * re-raises. #435 kept the reviewer's memory on a bench that could not count a
 * fresh finder's re-raises: matching by citation within ten lines merged
 * neighbouring bugs. A declared identity, checked against this list, is the
 * count it said reopening needs.
 *
 * **An identity list, not an argument.** Each entry is the round, the id, the
 * severity, the title, the first code location and the reproducer status at
 * review. It never carries the `detail`, the `suggested_fix`, the fixer's
 * disposition or any rebuttal, and `fix-dispositions-*.json` is never read: a
 * seat shown the fixer's case would be judging the argument, not the code.
 *
 * Rebuilt from the run directory on every round, so a resume needs no state of
 * its own and renders what an uninterrupted round would have.
 */

export interface LedgerEntry {
  id: string;
  severity: Severity;
  title: string;
  /** `path:line`, `path`, or `no code citation`. */
  site: string;
  /** The verdict at `review`, or `no reproducer`. */
  reproducer: string;
}

/**
 * One earlier round. Five kinds, because the ways a round can fail to be listed
 * are different facts and `docs/agents/loop.md` keeps "unreadable" and
 * "linked" apart: a file that was opened and could not be used is not one vibe
 * never looked inside, and neither is a round a fork left in its parent.
 */
export type LedgerRound =
  | {
      /** Numbered as the prompts and headings number rounds: the file index + 1. */
      round: number;
      file: string;
      kind: 'findings';
      entries: LedgerEntry[];
      /** Elements of `findings` that are not a finding this build can read. */
      unreadable: number;
    }
  /** `readArtifact` answered `absent`, and this run is not a fork. */
  | { round: number; file: string; kind: 'missing' }
  /** There was text, but it is not JSON, or has no `findings` list. */
  | { round: number; file: string; kind: 'unparseable' }
  /** A link: refused before any read, so it was never opened. */
  | { round: number; file: string; kind: 'linked' }
  /**
   * Absent from a fork's own directory. `commitFork` copies no
   * `code-review-*.json`, so a fork taken at a `review-round` checkpoint has
   * none of its parent's rounds - and the parent's directory is never read.
   */
  | { round: number; file: string; kind: 'in-parent'; parent: string };

export interface Ledger {
  rounds: LedgerRound[];
  /** Every id the rendered ledger lists - the only ids a `prior_id` may name. */
  ids: ReadonlySet<string>;
}

function siteOf(f: Finding): string {
  const code = readEvidence(f.evidence).find((e) => e.kind === 'code' && e.path !== undefined);
  if (code === undefined || code.path === undefined) return 'no code citation';
  return code.line === undefined ? code.path : `${code.path}:${String(code.line)}`;
}

/** The latest observation at `review`, the one that decided whether it blocked. */
function reproducerOf(f: Finding): string {
  return reproductionAt(f, 'review')?.verdict ?? 'no reproducer';
}

function entryOf(f: Finding): LedgerEntry {
  return {
    id: f.id,
    severity: f.severity,
    title: f.title.replace(/\s+/g, ' ').trim(),
    site: siteOf(f),
    reproducer: reproducerOf(f),
  };
}

/**
 * The earlier rounds of this run, oldest first.
 *
 * Round R's prompt is rendered while `state.reviewRound` is R - 1, and each
 * round's findings are written to `code-review-${reviewRound}.json` under the
 * heading `round ${reviewRound + 1}`. So this reads `code-review-0.json` up to
 * `code-review-(R-2).json` and labels each one with its index + 1: the number
 * the prompt that produced it said.
 */
export function readLedger(state: RunState): Ledger {
  const rounds: LedgerRound[] = [];
  const ids = new Set<string>();
  for (let k = 0; k < state.reviewRound; k += 1) {
    const file = `code-review-${String(k)}.json`;
    const round = k + 1;
    const read = readArtifact(state, file);
    if (read.kind === 'linked') {
      rounds.push({ round, file, kind: 'linked' });
      continue;
    }
    if (read.kind === 'absent') {
      rounds.push(
        state.forkedFrom === undefined
          ? { round, file, kind: 'missing' }
          : { round, file, kind: 'in-parent', parent: state.forkedFrom.runId },
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text) as unknown;
    } catch {
      rounds.push({ round, file, kind: 'unparseable' });
      continue;
    }
    const list =
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['findings'] : undefined;
    if (!Array.isArray(list)) {
      rounds.push({ round, file, kind: 'unparseable' });
      continue;
    }
    const entries: LedgerEntry[] = [];
    let unreadable = 0;
    for (const f of list as unknown[]) {
      if (!hasFindingShape(f)) {
        unreadable += 1;
        continue;
      }
      const entry = entryOf(f);
      entries.push(entry);
      ids.add(entry.id);
    }
    rounds.push({ round, file, kind: 'findings', entries, unreadable });
  }
  return { rounds, ids };
}

/**
 * Each parsed finding with the `prior_id` its turn declared, checked against
 * the ledger that turn was shown.
 *
 * Read from the turn's structured output by index rather than through
 * `parseFinding`, which the critique and the cut-off salvage share: only this
 * path ever writes the key, so a finding recorded with the setting off cannot
 * carry one. The index holds because `parseFindings` maps the array element by
 * element and throws on one it cannot read.
 *
 * A listed id is kept; anything else is recorded as null, so a guess never
 * counts as a re-raise. An unlisted string is handed back for the caller to
 * record - this function writes nothing.
 */
export function attachPriorIds(
  report: FindingsReport,
  structured: unknown,
  ids: ReadonlySet<string>,
): { report: FindingsReport; unknown: { finding: string; value: string }[] } {
  const raw =
    typeof structured === 'object' && structured !== null
      ? (structured as Record<string, unknown>)['findings']
      : undefined;
  const declared: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [];
  const unknown: { finding: string; value: string }[] = [];
  const findings = report.findings.map((f, i): Finding => {
    const item = declared[i];
    const value = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['prior_id'] : undefined;
    // A blank string declares nothing, the same as null: it names no id, so
    // there is nothing unknown to record.
    if (typeof value !== 'string' || value.trim() === '') return { ...f, prior_id: null };
    const trimmed = value.trim();
    if (ids.has(trimmed)) return { ...f, prior_id: trimmed };
    unknown.push({ finding: f.id, value });
    return { ...f, prior_id: null };
  });
  return { report: { ...report, findings }, unknown };
}
