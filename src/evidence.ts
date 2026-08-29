import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fromAgentPath } from '@src/pathstyle.js';
import type { PathStyle } from '@src/pathstyle.js';
import type { Evidence, Finding, FindingsReport, Severity, TurnActivity } from '@src/types.js';
import { readEvidenceEntry } from '@src/validate.js';

/**
 * Is a finding grounded - does it point at something that exists?
 *
 * Not whether it is *correct*. Nothing here can judge a claim; it can only
 * check that the claim names a real place. That is the whole of the guarantee,
 * and README.md says so in the same words.
 *
 * Why it exists: a blocking finding used to be able to cite nothing at all.
 * #44's reviewer emitted two or three stream items across seven minutes, every
 * sampled one an `agent_message` - it ran nothing - and its single P1 claimed
 * `noUnusedLocals` would reject a rest-destructured binding. It does not, and
 * `tsc --noEmit` says so in four seconds. Inside `p1Tolerance`, so it did not
 * block; it bought a final fix round that edited working code to satisfy a
 * false premise, in a round that is by design not re-reviewed.
 *
 * (It was stated as item counts, not as "zero `command_execution` events",
 * because the heartbeat counted every `item.started` AND `item.completed` and
 * reported only the *last* item's type, so it could not count commands. #66
 * made that signal precise - see `isInert` below, which is the second guard
 * this module now holds.)
 *
 * A P0 or P1 with no evidence entry that passes its check is downgraded to P2
 * before anything reads its severity: it stops forcing a round, it stays in the
 * artifact, and the downgrade is recorded with its reason (#48).
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
 * A blocking finding, kept but no longer blocking, with the reason on it.
 *
 * The one construction both guards share, so `downgraded.from` always names the
 * severity the model actually gave and the shape `groundAndRecord`,
 * `OUTSTANDING.md` and `FOLLOW-UPS.md` read cannot drift between them.
 */
function toP2(f: Finding, extra: Partial<Finding>, reason: string): Finding {
  const from: Severity = f.severity;
  return { ...f, ...extra, severity: 'P2', downgraded: { from, reason } };
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

    const reason =
      seen.length === 0
        ? 'it cited no evidence'
        : `no citation resolved: ${seen.map((s) => s.reason).join('; ')}`;
    // Kept, not deleted. The finding may well be right; what it is not is
    // grounded, and an ungrounded claim is not one the loop should stop for.
    const next = toP2(f, cited, reason);
    downgraded.push(next);
    return next;
  });

  return { report: { ...report, findings }, downgraded };
}

/**
 * Did the turn that produced this report emit items, none of which was a tool?
 *
 * Zero tool items exactly, with no threshold anywhere: `0` is the only number
 * here that was not invented, and anything above it would be. The census #66
 * was decided on is the whole argument. Every review turn vibe has ever run -
 * 29 of them, across 23 runs - ran between 5 and 154 commands, median 32, with
 * exactly one exception: the #44 run's reviewer on 2026-08-25, which emitted
 * three items, all `agent_message`, spent 41 reasoning items in the rollout, had
 * a shell and never used it. That one turn produced the only false blocking
 * finding in the archive. There is no near-boundary case in the data; the gap
 * between "ran nothing" and the next quietest review turn is 0 to 5.
 *
 * Orthogonal to `groundFindings` by construction, and the #44 finding is why
 * both are needed: it cited nothing because the schema then had no `evidence`
 * field, and today's reviewer would cite `tests/acceptance-criteria.test.ts`
 * with an excerpt that exists and resolves - so grounding would pass it and the
 * P1 would stand. Grounding asks whether a claim names a real place. This asks
 * whether the turn looked.
 *
 * Three answers, and two of them are false:
 * - `undefined` - nothing measured this turn (no heartbeat, or an injected
 *   agent). Never inert: an unobserved turn is not an idle one.
 * - items present, `tool > 0` - the turn used its tools. Not inert.
 * - items present, `tool === 0` - the turn talked or thought and did nothing
 *   else. Inert.
 *
 * An empty tally is the first case, not the third, for the same reason.
 */
export function isInert(activity: TurnActivity | undefined): boolean {
  if (activity === undefined) return false;
  const kinds = Object.keys(activity.items);
  if (kinds.length === 0) return false;
  return activity.tool === 0;
}

/** "3 items, none of them a tool: agent_message x3" - the fact, not a judgement. */
function describeActivity(activity: TurnActivity): string {
  // Sorted by kind so the recorded reason is deterministic: it lands in the
  // event log and in the artifact, and a reason that reorders between runs is a
  // diff nobody can read.
  const kinds = Object.entries(activity.items).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const total = kinds.reduce((sum, [, n]) => sum + n, 0);
  const listed = kinds.map(([kind, n]) => `${kind} x${n}`).join(', ');
  return `${total} item${total === 1 ? '' : 's'}, none of them a tool: ${listed}`;
}

/**
 * Downgrade a report's blocking findings when the turn that produced them used
 * no tools (#66).
 *
 * Option 1 of the three the issue offered, and it is the one that prevents the
 * measured cost: the #44 P1 was inside `p1Tolerance`, so it did not block - it
 * bought the final fix round, which `reviewPhase` buys *only* when
 * `decision.tolerated` is non-empty. A P2 is never tolerated, so
 * `tolerated.length === 0`, the loop ends clean, and the ~1.3M-token round that
 * edited working code to satisfy a false premise - in a round that is by design
 * not re-reviewed - never happens. Re-running the review instead would cost a
 * full reviewer turn (3M tokens on #47) and re-run the model that just declined
 * to use its shell; warning only would not have prevented anything.
 *
 * Applied by `groundAndRecord` to the **reviewer only**, and after grounding, so
 * a finding already downgraded for citing nothing is not downgraded twice.
 *
 * Pure with respect to its input, for the reason `groundFindings` gives: the
 * artifact and `state.pendingFindings` are written from these objects.
 */
export function downgradeInert(
  report: FindingsReport,
  activity: TurnActivity | undefined,
): { report: FindingsReport; downgraded: Finding[] } {
  if (!isInert(activity) || activity === undefined) return { report, downgraded: [] };

  const downgraded: Finding[] = [];
  const reason = `the turn that produced it used no tools (${describeActivity(activity)})`;
  const findings = report.findings.map((f) => {
    if (f.severity !== 'P0' && f.severity !== 'P1') return f;
    const next = toP2(f, {}, reason);
    downgraded.push(next);
    return next;
  });

  return { report: { ...report, findings }, downgraded };
}
