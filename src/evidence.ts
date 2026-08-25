import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fromAgentPath } from '@src/pathstyle.js';
import type { PathStyle } from '@src/pathstyle.js';
import type { Evidence, Finding, FindingsReport, Severity } from '@src/types.js';
import { readEvidenceEntry } from '@src/validate.js';

/**
 * Is a finding grounded - does it point at something that exists?
 *
 * Not whether it is *correct*. Nothing here can judge a claim; it can only
 * check that the claim names a real place. That is the whole of the guarantee,
 * and README.md says so in the same words.
 *
 * Why it exists: a blocking finding used to be able to cite nothing at all. The
 * #44 reviewer ran **zero** `command_execution` events and still produced P1s
 * that forced a fix round - an assertion about code nobody had read, costing
 * the same as one somebody had. A P0 or P1 with no evidence entry that passes
 * its check is downgraded to P2 before anything reads its severity: it stops
 * forcing a round, it stays in the artifact, and the downgrade is recorded with
 * its reason (#48).
 *
 * Absent evidence and broken evidence are deliberately the same case. One rule,
 * not two, because `parseFindings` is tolerant by design and making it throw on
 * a missing field would destroy a whole round's output over one finding in ten.
 *
 * Its own module rather than a corner of `src/run.ts`: it is the only
 * filesystem-reading validator in the codebase, and the only one that has to
 * think about which shell a path came from.
 */

/** Nothing here writes, copies, or surfaces file content. See `resolveInside`. */
interface Resolution {
  /** Host-native absolute path, or null when the citation does not resolve. */
  absolute: string | null;
  /**
   * The same place as a `/`-separated path relative to the root it was checked
   * against - what a citation should have said, and what every prompt renders.
   */
  relative: string | null;
}

const NOT_RESOLVED: Resolution = { absolute: null, relative: null };

/**
 * Resolve a cited path against a root, and refuse anything that leaves it.
 *
 * Two steps, in this order and never the other way round.
 *
 * **Convert, then contain.** A path arrives in the *reporting agent's*
 * convention, not the host's. `src/pathstyle.ts` documents the split this
 * repo is developed on: Claude executes tool calls in Git Bash (`/c/...`,
 * msys) while Codex executes them in PowerShell (`C:\...`, win32), both at
 * the same time on the same machine. So a reviewer's perfectly good citation
 * of a file inside the repo arrives in a form `path.resolve` alone would
 * place nowhere near it, and would be downgraded for being right.
 * `fromAgentPath` returns its input unchanged when it does not match, so this
 * is safe on ordinary relative paths and is idempotent.
 *
 * **Containment is the boundary; `fromAgentPath` is not.** It is a string
 * rewrite with a pass-through default and can neither reject nor guarantee
 * anything, so the lexical check is applied to its *output* and is never
 * skipped - the same check #23 added for run ids. An absolute path inside the
 * root therefore resolves; `..`, `../escape`, and any absolute path outside it
 * do not.
 *
 * Symlinks are deliberately not resolved - #53 owns that decision - and it is
 * safe to leave here because this code only ever *reads* to answer a yes/no
 * question. It writes nothing, copies nothing, and puts no file content into
 * any artifact or any prompt.
 */
function resolveInside(root: string, cited: string, style: PathStyle | null): Resolution {
  if (cited.trim() === '') return NOT_RESOLVED;
  // No style means no probe on this run - a legacy state, or `--no-preflight`.
  // Guessing one would be inventing a fact the run never observed, so the
  // citation is read host-native and an agent-flavoured path simply fails to
  // resolve. That costs one entry, not the report, and one passing entry is
  // enough.
  const native = style === null ? cited : fromAgentPath(cited, style);
  const base = path.resolve(root);
  const absolute = path.resolve(base, native);
  // The separator is appended only when `base` does not already end in one. A
  // repo at a filesystem root - `/` on POSIX, `C:\` on Windows - resolves to a
  // base that already does, and `base + path.sep` would then look for `//` or
  // `C:\\` and reject every real child of it.
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (absolute !== base && !absolute.startsWith(prefix)) return NOT_RESOLVED;
  const relative = path.relative(base, absolute).split(path.sep).join('/');
  return { absolute, relative: relative === '' ? '.' : relative };
}

/** Lines, counting a trailing newline as ending the last line rather than starting one. */
function lineCount(text: string): number {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * Whitespace-normalised, both sides, because a model re-indents what it quotes
 * as a matter of course. An excerpt that differs only in indentation is the
 * same excerpt; one that differs in wording is a paraphrase, and a paraphrase
 * is not a citation.
 */
function normalise(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** What one entry resolved to, for callers that need the place and not just the verdict. */
interface Inspection {
  /** Null when the entry resolves; a short human reason when it does not. */
  reason: string | null;
  /**
   * The canonical, root-relative form of a resolved `path` - absent for
   * `external`, and for anything that did not resolve.
   */
  canonical?: string;
}

function inspect(
  raw: unknown,
  cwd: string,
  runDir: string,
  style: PathStyle | null,
): Inspection {
  // Written against `unknown` for the reason `isDeferrable` is: `evidence` is
  // never validated on the way into state.json, and this function is exported
  // through `checkEvidence`, so it can be handed a stored `[null]` or an entry
  // naming a kind that does not exist. Unusable is not the same as absent, and
  // it is certainly not the same as passing - it is a citation that did not
  // resolve, counted like any other.
  const e = readEvidenceEntry(raw);
  if (e === null) return { reason: 'an unreadable citation' };

  if (e.kind === 'external') {
    // The one kind that touches no filesystem. Nothing here can check another
    // tool's CLI or a spec, and pretending otherwise would be inventing a
    // verdict - so this passes on having said what it is, which is what makes
    // the recorded `kinds` worth reading.
    if (typeof e.ref !== 'string' || e.ref.trim() === '') {
      return { reason: 'external evidence with no ref' };
    }
    return { reason: null };
  }

  if (typeof e.path !== 'string' || e.path.trim() === '') {
    return { reason: `${e.kind} evidence with no path` };
  }

  const root = e.kind === 'artifact' ? runDir : cwd;
  const where = e.kind === 'artifact' ? 'the run directory' : 'the repository';
  const { absolute, relative } = resolveInside(root, e.path, style);
  if (absolute === null || relative === null) {
    return { reason: `${e.path} does not resolve inside ${where}` };
  }
  if (!existsSync(absolute)) return { reason: `${e.path} does not exist` };

  let isFile: boolean;
  try {
    isFile = statSync(absolute).isFile();
  } catch {
    // Fail closed: a check that cannot read its input treats it as absent, not
    // as satisfied. The finding can still survive on another entry.
    return { reason: `${e.path} could not be read` };
  }

  if (e.kind === 'absence') {
    // A directory is the point. "No test covers the carried-P1 path" cites the
    // place the thing is missing *from*, so only existence of the place is
    // checked and any excerpt is ignored: checking that an excerpt is NOT found
    // would let a loose quotation downgrade a true finding, and a false
    // downgrade is worse than a missed one.
    return { reason: null, canonical: relative };
  }

  if (!isFile) return { reason: `${e.path} is not a file` };
  if (e.kind === 'artifact') return { reason: null, canonical: relative };

  const wantsLine = typeof e.line === 'number';
  const excerpt = typeof e.excerpt === 'string' ? normalise(e.excerpt) : '';
  if (!wantsLine && excerpt === '') return { reason: null, canonical: relative };

  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    return { reason: `${e.path} could not be read` };
  }

  if (typeof e.line === 'number') {
    const lines = lineCount(text);
    if (!Number.isInteger(e.line) || e.line < 1 || e.line > lines) {
      return { reason: `${e.path} has no line ${e.line} (${lines} lines)` };
    }
  }
  if (excerpt !== '') {
    // Somewhere in the file, not at or near `line`. A tolerance window would be
    // a number nobody measured, and the two facts that *are* checkable - the
    // line is inside the file, the quoted text is inside the file - are what
    // the citation was actually claiming.
    if (!normalise(text).includes(excerpt)) {
      return { reason: `the excerpt does not appear in ${e.path}` };
    }
  }
  return { reason: null, canonical: relative };
}

/**
 * Does one citation resolve? Null when it does, a short reason when it does not.
 *
 * `style` is the *reporting* agent's path convention, from
 * `state.environment.agents[].pathStyle`, or null when the run has no probe.
 */
export function checkEvidence(
  e: Evidence,
  cwd: string,
  runDir: string,
  style: PathStyle | null,
): string | null {
  return inspect(e, cwd, runDir, style).reason;
}

/** The citations a finding offered, however unusable, without assuming a list. */
function citedBy(f: Finding): unknown[] {
  return Array.isArray(f.evidence) ? f.evidence : [];
}

/**
 * Downgrade every blocking finding that cites nothing that resolves, and
 * canonicalise the citations that do.
 *
 * The canonicalisation is not cosmetic. A finding is written by one agent and
 * read by another: with the default table Codex reviews in PowerShell and
 * Claude fixes in Git Bash, so a reviewer's `C:\repo\src\run.ts` - a citation
 * this module now accepts - would reach the fixer's prompt in a form its shell
 * cannot open. Rewriting a *resolved* path to its repo-relative form is the
 * only rewrite that is true for every reader, and it happens here because this
 * is where the path has just been resolved. A path that did not resolve is left
 * exactly as the model wrote it: there is no basis to restate it, and the
 * reader should see what was actually claimed.
 *
 * Pure with respect to its input - a new report, new findings, new evidence
 * entries - because `state.pendingFindings` and the round artifact are written
 * from the same objects, and a mutation here would edit a record already made.
 */
export function groundFindings(
  report: FindingsReport,
  cwd: string,
  runDir: string,
  style: PathStyle | null,
): { report: FindingsReport; downgraded: Finding[] } {
  const downgraded: Finding[] = [];

  const findings = report.findings.map((f) => {
    const entries = citedBy(f);
    const seen = entries.map((e) => inspect(e, cwd, runDir, style));
    // Rewritten, never rebuilt: an entry comes back as it was given unless it
    // resolved to a different path. A malformed one is left exactly as it is -
    // erasing it here would take the record of what was claimed with it, and
    // the renderers already refuse to print one. `canonical` is set only for an
    // entry that parsed *and* resolved, so the spread below is over a record.
    const rewritten = entries.map((e, i) => {
      const canonical = seen[i]?.canonical;
      if (canonical === undefined) return e;
      const entry = e as Record<string, unknown>;
      return canonical === entry['path'] ? e : { ...entry, path: canonical };
    });
    // The one cast, and the same one `readFinding` makes: what was stored is
    // carried through unvalidated, because refusing it would delete a finding
    // over a bad citation.
    const evidence = rewritten as Evidence[];
    const cited = evidence.length > 0 ? { evidence } : {};

    // Severity is read after this, never before: the gate, the guards and the
    // tolerance all see the downgraded value and none of their rules change.
    if (f.severity !== 'P0' && f.severity !== 'P1') return { ...f, ...cited };
    if (seen.some((s) => s.reason === null)) return { ...f, ...cited };

    const from: Severity = f.severity;
    const reason =
      seen.length === 0
        ? 'it cited no evidence'
        : `no citation resolved: ${seen.map((s) => s.reason).join('; ')}`;
    // Kept, not deleted. The finding may well be right; what it is not is
    // grounded, and an ungrounded claim is not one the loop should stop for.
    const next: Finding = { ...f, ...cited, severity: 'P2', downgraded: { from, reason } };
    downgraded.push(next);
    return next;
  });

  return { report: { ...report, findings }, downgraded };
}
