import path from 'node:path';
import type { AgentProvider } from '@src/runtime.js';
import { REPHRASE_THRESHOLD, similarity } from '@src/similarity.js';
import type { Evidence, Finding, FindingsReport, FoundBy } from '@src/types.js';
import { readEvidence, readEvidenceEntry, SEVERITY_RANK } from '@src/validate.js';

/**
 * One review round's reports, one per finder, read as one report (#388 Part B).
 *
 * Pure: no state, no log, no filesystem. Everything a guard decided has already
 * happened per turn by the time this runs (`groundAndRecord`), and everything
 * the round decides afterwards - reproducers, the artifact, pending findings -
 * runs on what this returns.
 *
 * ## The rule: by claim, and on doubt keep both
 *
 * Two findings from **different** finders are one defect when they cite the
 * same `code` location (same normalised path, same line, both present), or when
 * their titles say the same thing by `similarity >= REPHRASE_THRESHOLD`.
 * Anything short of that is two findings. Merging two real defects into one
 * would hide one of them from the fix turn; keeping a duplicate costs a fix item
 * that says the same thing twice. Only the second is recoverable.
 *
 * **The threshold was not measured for this.** `REPHRASE_THRESHOLD` was set
 * from two censuses: questions the planner asked twice in other words, and
 * finding ids recycled across rounds onto a different claim (see
 * `src/similarity.ts`). Neither population is "two finders describing one
 * defect", and this module deliberately reuses the constant rather than tuning
 * it or adding another: a number for this population needs its own census,
 * which the archive cannot have until runs with several finders exist.
 *
 * A finder is never merged with itself here. Its own chunks were merged by
 * `mergeReviewReports` before this, by id, and two different ids from one
 * finder are two claims that finder chose to make separately.
 */

/** One finder's merged report, with who it was. */
export interface FinderReport {
  /** 0 for `roles.reviewer`, else the 1-based index into `review.finders`. */
  k: number;
  /** The config path: `roles.reviewer` or `review.finders[<k-1>]`. */
  seat: string;
  provider: AgentProvider;
  /** The configured model, or `"default"` - never a resolved guess. */
  model: string;
  report: FindingsReport;
}

export interface FinderMerge {
  report: FindingsReport;
  /** Findings that joined an earlier finder's group by a shared citation. */
  byCitation: number;
  /** Findings that joined an earlier finder's group by a similar title. */
  byTitle: number;
}

interface Member {
  finder: FinderReport;
  finding: Finding;
}

/**
 * A cited path as text, so `./src/a.ts`, `src\a.ts` and `src//a.ts` compare
 * equal. Textual only: resolving an absolute path against a repo-relative one
 * needs the cwd and the agent's path style, and a near-miss here costs only a
 * duplicate - the direction this module leans on doubt.
 */
function normalisePath(p: string): string {
  const posix = path.posix.normalize(p.replace(/\\/g, '/'));
  return posix.startsWith('./') ? posix.slice(2) : posix;
}

/** The `code` locations a finding cites, as comparable keys. */
function codeSites(f: Finding): Set<string> {
  const out = new Set<string>();
  for (const e of readEvidence(f.evidence)) {
    if (e.kind !== 'code' || e.path === undefined || e.line === undefined) continue;
    out.add(`${normalisePath(e.path)}:${String(e.line)}`);
  }
  return out;
}

function sharesCitation(a: Finding, b: Finding): boolean {
  const left = codeSites(a);
  for (const site of codeSites(b)) if (left.has(site)) return true;
  return false;
}

/** How a finding matches a group, or null when it does not. Citation first. */
function matchOf(group: readonly Member[], candidate: Member): 'citation' | 'title' | null {
  if (group.some((m) => m.finder.k === candidate.finder.k)) return null;
  if (group.some((m) => sharesCitation(m.finding, candidate.finding))) return 'citation';
  if (group.some((m) => similarity(m.finding.title, candidate.finding.title) >= REPHRASE_THRESHOLD)) {
    return 'title';
  }
  return null;
}

/**
 * The union of the members' citations, first occurrence kept, one per
 * `kind|path|line`. Read as stored rather than through `readEvidence`, so an
 * entry this build cannot read is carried rather than deleted - the rule every
 * other reader of `evidence` follows.
 */
function unionEvidence(members: readonly Member[]): Evidence[] | undefined {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  let any = false;
  for (const { finding } of members) {
    const raw: unknown = finding.evidence;
    if (!Array.isArray(raw)) continue;
    any = true;
    for (const entry of raw as unknown[]) {
      const read = readEvidenceEntry(entry);
      const key =
        read === null
          ? `?${JSON.stringify(entry)}`
          : `${read.kind}|${read.path === undefined ? '' : normalisePath(read.path)}|${String(read.line ?? '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry as Evidence);
    }
  }
  return any ? out : undefined;
}

function provenance(m: Member): FoundBy {
  return { seat: m.finder.seat, provider: m.finder.provider, model: m.finder.model, id: m.finding.id };
}

/** An id no emitted finding holds yet: `<id>-f<k>`, then `-f<k>-2`, and so on. */
function freeId(id: string, k: number, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  const base = `${id}-f${String(k)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base}-${String(n)}`;
    if (!taken.has(next)) return next;
  }
}

export function mergeAcrossFinders(perFinder: readonly FinderReport[]): FinderMerge {
  const groups: Member[][] = [];
  let byCitation = 0;
  let byTitle = 0;

  // Greedy in finder order: each finding joins the first earlier group it
  // matches, or opens one. Finder order is config order, so the same reports
  // merge the same way on every run.
  for (const finder of perFinder) {
    for (const finding of finder.report.findings) {
      const member: Member = { finder, finding };
      let joined = false;
      for (const group of groups) {
        const how = matchOf(group, member);
        if (how === null) continue;
        group.push(member);
        if (how === 'citation') byCitation += 1;
        else byTitle += 1;
        joined = true;
        break;
      }
      if (!joined) groups.push([member]);
    }
  }

  const taken = new Set<string>();
  const findings = groups.map((group): Finding => {
    const [first] = group;
    if (first === undefined) throw new Error('an empty finder group cannot be produced');
    // The most blocking wins, a tie goes to the earliest finder - and its whole
    // text goes with it, so a title never describes a severity it did not give.
    let winner = first;
    for (const m of group) {
      if (SEVERITY_RANK[m.finding.severity] < SEVERITY_RANK[winner.finding.severity]) winner = m;
    }
    // Every field is the winner's, so `downgraded` is present only if the
    // winner was judged by a guard: a guard's record is never moved onto a
    // finding it did not see. The other members' own downgrade events stay in
    // the record under the ids those finders used.
    const { evidence: _evidence, foundBy: _foundBy, ...rest } = winner.finding;
    const evidence = unionEvidence(group);
    const id = freeId(first.finding.id, first.finder.k, taken);
    taken.add(id);
    const blocking = rest.severity === 'P0' || rest.severity === 'P1';
    return {
      ...rest,
      id,
      // `mergeReviewReports`' invariant, for the same reason: a P2 deferred by
      // one finder and raised to P1 by another must not arrive deferred.
      ...(blocking ? { defer: false } : {}),
      ...(evidence === undefined ? {} : { evidence }),
      foundBy: group.map(provenance),
    };
  });

  const [lead, ...others] = perFinder;
  const summary = [
    lead?.report.summary ?? '',
    ...others.map((f) => `Finder ${String(f.k)} (${f.provider}/${f.model}): ${f.report.summary}`),
  ]
    .filter((s) => s !== '')
    .join('\n\n');

  return {
    report: {
      verdict: perFinder.some((f) => f.report.verdict === 'REVISE') ? 'REVISE' : 'APPROVE',
      summary,
      findings,
    },
    byCitation,
    byTitle,
  };
}
