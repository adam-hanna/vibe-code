import { lstatSync, mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveInside } from '@src/evidence.js';
import type { PathStyle } from '@src/pathstyle.js';
import type { ToolchainContract } from '@src/runtime.js';
import type { Finding, Reproducer, ReproducerOutcome } from '@src/types.js';
import { slug } from '@src/validate.js';
import { runGateCommand } from '@src/verify.js';
import type { ResolvedGate } from '@src/verify.js';

/**
 * The executable witness: place the test a reviewer wrote, run the gate the user
 * configured, and say what was observed (#113).
 *
 * ## The rule this design exists to keep
 *
 * `src/verify.ts` states it at the one place a shell is used at all: *"this
 * string comes from configuration the user wrote, not from model output.
 * Model-authored text is never passed to a shell."* The obvious implementation
 * of this feature - and the one the research review's own schema example
 * proposed - is a reviewer-supplied `reproducer.command`, which would let a
 * Codex turn choose a command vibe executes with the user's privileges, on the
 * user's machine, outside any sandbox. That is a far larger change than it looks
 * and it is not smuggled in here as a detail of a findings schema.
 *
 * So: **the reviewer writes a file and vibe runs a command the user already
 * wrote.** Every string that reaches a shell in this module came out of
 * `resolveGates`, unchanged, and `sameCommand` in the tests asserts exactly
 * that.
 *
 * ## What is new authority and what is not
 *
 * Writing a model-authored *file* into the working tree is not new: the
 * implementer does it every round and the gate runs what it wrote. What is new
 * is that **vibe** does the writing, on behalf of a role that is read-only, so
 * the judgement an agent would have applied has to be written down instead -
 * containment, no overwrite, no symlinked ancestor, and removal afterwards.
 *
 * ## Fail closed, in the direction the issue names
 *
 * Every way this can go wrong lands on `unproven`, which changes no severity in
 * either direction: a path that will not resolve, a gate name that matches
 * nothing, a gate with no command, a command that could not start, a file that
 * could not be written. *"A reproducer that does not compile is unproven, not
 * blocking, recorded"* - and a compile failure is indistinguishable from any
 * other non-zero exit, which is why the baseline below is what carries the
 * weight rather than the exit code alone.
 */

/** What was written, and what has to be undone afterwards. */
export interface Placement {
  /** Host-native, where the file actually went. */
  absolute: string;
  /** Repo-relative and `/`-separated - what every record and prompt shows. */
  relative: string;
  /**
   * Directories this created, deepest first.
   *
   * Tracked rather than derived on the way out: removing every empty ancestor
   * would delete a directory the project already had and happened to leave
   * empty, and this file's job is to leave the tree exactly as it found it.
   */
  created: string[];
}

/**
 * Segments a reproducer may never be written under, whatever the containment
 * check says about them.
 *
 * `.git` because a write into the object store is the one containment-passing
 * path that can destroy the repository this run is meant to be improving, and
 * `.vibe` for the reason `refuseArtifactPath` refuses it in #62: the run's own
 * record is not somewhere a model gets to put files. Neither is a place a test
 * runner would look, so refusing them costs nothing real.
 */
const REFUSED_ROOTS = new Set(['.git', '.vibe']);

/**
 * Write the file, or say why not. Never throws.
 *
 * Four refusals, and the last two are what `resolveInside` deliberately does not
 * do - see its header, whose safety argument rests on only ever reading:
 *
 * - **Outside the repository.** The same containment every citation gets, so
 *   `..`, an absolute path elsewhere, and a Git Bash path from a PowerShell
 *   reviewer all get the answer they get everywhere else in the product.
 * - **Under `.git` or `.vibe`.** See `REFUSED_ROOTS`.
 * - **Already exists.** Refused, never overwritten. An overwrite is a change to
 *   the user's own code that nothing planned, nothing reviewed and nothing would
 *   put back - and a reviewer that names an existing test file is describing a
 *   test that is already there rather than writing a new one.
 * - **A symlinked ancestor.** `resolveInside` does not resolve symlinks (#53
 *   owns that decision) and says it is safe not to *because it only reads*.
 *   Writing through one leaves the repository by following a link rather than by
 *   naming a path, so the lexical check alone would not hold. Checked with
 *   `lstat` walking down from the root, so a link at any depth is caught.
 */
export function placeReproducer(
  cwd: string,
  reproducer: Reproducer,
  style: PathStyle | null,
): { placement: Placement | null; reason: string | null } {
  const { absolute, relative } = resolveInside(cwd, reproducer.path, style);
  if (absolute === null || relative === null) {
    return { placement: null, reason: `${reproducer.path} does not resolve inside the repository` };
  }

  const segments = relative.split('/').filter((s) => s !== '');
  const first = segments[0];
  if (segments.length === 0 || first === undefined) {
    return { placement: null, reason: `${reproducer.path} names the repository itself, not a file` };
  }
  if (REFUSED_ROOTS.has(first)) {
    return { placement: null, reason: `${relative} is under ${first}, which is not writable here` };
  }

  const root = path.resolve(cwd);
  // Every ancestor, then the target itself. `lstat` and not `stat`, so a symlink
  // is seen as a symlink rather than as whatever it points at - which is the
  // entire question being asked.
  const created: string[] = [];
  let at = root;
  for (const [i, segment] of segments.entries()) {
    at = path.join(at, segment);
    const last = i === segments.length - 1;
    let kind: 'missing' | 'link' | 'dir' | 'other';
    try {
      const stat = lstatSync(at);
      kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'other';
    } catch {
      kind = 'missing';
    }

    if (kind === 'link') {
      return { placement: null, reason: `${relative} passes through a symlink and was not written` };
    }
    if (last) {
      if (kind !== 'missing') {
        return { placement: null, reason: `${relative} already exists and was not overwritten` };
      }
      break;
    }
    if (kind === 'other') {
      return { placement: null, reason: `${relative} is under ${segment}, which is a file` };
    }
    if (kind === 'missing') created.unshift(at);
  }

  try {
    // The directories are made in one call and recorded deepest-first above, so
    // the cleanup removes exactly what this created and stops at the first one
    // that is no longer empty.
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, reproducer.contents, 'utf8');
  } catch (err) {
    // Best effort at leaving nothing behind, then report. A half-created tree is
    // the one failure mode that would outlive the run.
    unplace({ absolute, relative, created });
    return {
      placement: null,
      reason: `${relative} could not be written (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  return { placement: { absolute, relative, created }, reason: null };
}

/**
 * Take the file back out of the working tree. Never throws.
 *
 * Called from a `finally`, always, whatever the gate did. Three reasons it is
 * not left behind, and the first is the one that matters:
 *
 * - A reproducer that **failed** is a failing test. Leaving it in the tree would
 *   break the verification gate on the very next iteration of the loop, for a
 *   reason nobody chose, and the fixer would be handed a failure whose cause is
 *   vibe.
 * - The round's commit would contain a file the plan never named and the
 *   reviewer never asked to keep. `src/work.ts` counts changed files against the
 *   plan; this would be one of them.
 * - The file is not lost by removing it: `archiveReproducer` has already put it
 *   in the run record, which is where every other thing a turn produced lives.
 *
 * Directories are removed only while they are empty, deepest first, so a `mkdir`
 * that raced with the project's own files takes nothing with it.
 */
export function unplace(placement: Placement): void {
  try {
    rmSync(placement.absolute, { force: true });
  } catch {
    // Nothing to do about it here. The file is named in the outcome and in the
    // event, so a leftover is findable rather than mysterious.
  }
  for (const dir of placement.created) {
    try {
      // `rmdirSync`, deliberately, and not `rmSync({recursive: true})`: this
      // must FAIL rather than delete a directory that has anything in it. If the
      // gate or the project put something under one of these while it ran, that
      // something is theirs and stays.
      rmdirSync(dir);
    } catch {
      break;
    }
  }
}

/**
 * Keep the file in the run record, under `<run>/reproducers/<finding-id>/`.
 *
 * Returns the run-relative path, or null when it could not be kept - which is
 * never fatal: an unarchived reproducer still runs, and losing the observation
 * because the archive write failed would be the side effect destroying the thing
 * it is about.
 *
 * The id is slugged before it becomes a directory name. It is model-authored and
 * `parseFindings` accepts whatever the reviewer sent, so `../../etc` is a
 * perfectly ordinary id as far as everything upstream is concerned - and `slug`
 * is the derivation the rest of the product already uses for exactly this.
 */
export function archiveReproducer(
  runDir: string,
  findingId: string,
  reproducer: Reproducer,
  relative: string,
): string | null {
  const dir = path.join(runDir, 'reproducers', slug(findingId));
  // The basename only. The point is to keep the file, not to rebuild the
  // project's directory layout inside the run record - and the path it was
  // placed at is on the outcome, which is where a reader looks for it.
  const name = path.basename(relative) || 'reproducer';
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), reproducer.contents, 'utf8');
  } catch {
    return null;
  }
  return `reproducers/${slug(findingId)}/${name}`;
}

/**
 * Which configured gate runs this file, or why none does.
 *
 * A **name matched against the run's own gate list**, never a command. The
 * reviewer chooses which of the user's existing gates observes the file and can
 * choose nothing else; a name that matches nothing is reported with the list it
 * was checked against, so the next round's reviewer can pick a real one.
 *
 * Absent resolves to the sole gate when there is exactly one, which is every
 * config that predates #47: `resolveGates` synthesizes a single gate named
 * `verification` from `verify.command`. With several gates and no name there is
 * nothing to choose from and nothing to guess - a `qa` gate silently running
 * because it was first in the list is the same mistake `resolveGates` refuses
 * when it declines to detect a command for a named gate.
 */
export function gateFor(
  reproducer: Reproducer,
  gates: readonly ResolvedGate[],
): { gate: ResolvedGate | null; reason: string | null } {
  const runnable = gates.filter((g) => g.command !== null);
  const named = reproducer.gate;

  if (named !== undefined) {
    const match = gates.find((g) => g.name === named);
    if (match === undefined) {
      const names = gates.map((g) => g.name).join(', ');
      return {
        gate: null,
        reason: `it named the gate "${named}", which this run does not have (${names || 'no gates are configured'})`,
      };
    }
    if (match.command === null) {
      return { gate: null, reason: `the ${named} gate has no command configured` };
    }
    return { gate: match, reason: null };
  }

  const [sole] = runnable;
  if (runnable.length === 1 && sole !== undefined) return { gate: sole, reason: null };
  if (runnable.length === 0) {
    return { gate: null, reason: 'this run has no verification gate with a command' };
  }
  return {
    gate: null,
    reason:
      `it named no gate and this run has ${runnable.length} ` +
      `(${runnable.map((g) => g.name).join(', ')}), so nothing chooses between them`,
  };
}

/** Everything the observation needs that is not the finding itself. */
export interface ObserveContext {
  cwd: string;
  /** `state.dir` - where the file is kept. */
  runDir: string;
  gates: readonly ResolvedGate[];
  contract: ToolchainContract;
  /**
   * The reviewer's path convention, for the same reason `checkEvidence` takes
   * one: a path arrives in the reporting agent's shell dialect, and with the
   * default table that is PowerShell while the host may be anything.
   */
  style: PathStyle | null;
  /**
   * Gates observed to have PASSED on this tree, immediately before this ran.
   *
   * The baseline, and the reason it is passed in rather than assumed: only an
   * observation can license `reproduced`, and this module is not the thing that
   * observed it. Empty is a legitimate value and produces `unproven` on any
   * failure, which is the honest answer.
   */
  passedGates: ReadonlySet<string>;
  at: ReproducerOutcome['at'];
}

/**
 * Place, run, record, remove - and answer the one question the guards in
 * `src/evidence.ts` cannot: does this finding describe something that actually
 * happens?
 *
 * **`runs: 1`, deliberately.** `verify.runs` defaults to 3 because three samples
 * catch a flake the project's own suite has (#135), and `config.ts` argues that
 * number from a measured coin flip. This is not that question: it is a yes/no
 * about one added file against a tree that just came back green, and the issue
 * names the cost directly - *"`verify.runs` is 3 by default; this must not
 * multiply it"*. A reproducer that is itself flaky reports whichever way it went,
 * and the outcome says it was run once so nothing here claims otherwise.
 *
 * The two verdicts need different evidence and that asymmetry is the whole
 * design - see `ReproducerVerdict`. A **pass** is self-certifying, because the
 * suite exited 0 with the file in it. A **failure** is not, because any other
 * test could be what failed; it needs a pass of the same gate on the same tree
 * without the file, and without one the honest answer is `unproven`.
 */
export async function observe(
  finding: Finding,
  reproducer: Reproducer,
  ctx: ObserveContext,
): Promise<ReproducerOutcome> {
  const base = {
    at: ctx.at,
    gate: null,
    command: null,
    baseline: 'not-observed',
    archived: null,
  } as const;

  const { gate, reason } = gateFor(reproducer, ctx.gates);
  if (gate === null || gate.command === null) {
    return { ...base, verdict: 'unproven', reason };
  }

  const { placement, reason: refused } = placeReproducer(ctx.cwd, reproducer, ctx.style);
  if (placement === null) {
    return { ...base, verdict: 'unproven', gate: gate.name, command: gate.command, reason: refused };
  }

  // Before the run, not after it. A process killed mid-gate leaves the file in
  // the tree, and the record of what was placed is the only thing that says
  // where to look for it.
  const archived = archiveReproducer(ctx.runDir, finding.id, reproducer, placement.relative);
  const baseline: ReproducerOutcome['baseline'] = ctx.passedGates.has(gate.name)
    ? 'gate-passed'
    : 'not-observed';

  try {
    const result = await runGateCommand(ctx.cwd, { ...gate, runs: 1 }, ctx.contract);
    const observed = {
      ...base,
      at: ctx.at,
      gate: gate.name,
      command: result.command,
      exitCode: result.exitCode,
      baseline,
      archived,
    };

    if (result.unlaunchable !== null) {
      // Not an escalation, unlike the same condition in `runGate`. There the
      // command is the run's own gate and a mistyped one has to stop everything;
      // here it has already run clean at least once this round, so a launch
      // failure now says something about this attempt rather than about the
      // configuration - and the run has a review to get on with.
      return { ...observed, verdict: 'unproven', reason: `the gate could not run: ${result.unlaunchable}` };
    }
    if (result.unavailable !== null) {
      return { ...observed, verdict: 'unproven', reason: result.unavailable };
    }
    if (result.ok) {
      // The self-certifying direction: the file was in the tree, the whole
      // command exited 0, so the test ran and passed.
      return { ...observed, verdict: 'did-not-reproduce', reason: null };
    }
    if (baseline !== 'gate-passed') {
      return {
        ...observed,
        verdict: 'unproven',
        reason:
          `the ${gate.name} gate failed with the reproducer in place, but nothing observed it ` +
          'passing without it, so the failure cannot be attributed to the reproducer',
      };
    }
    return { ...observed, verdict: 'reproduced', reason: null };
  } finally {
    unplace(placement);
  }
}

/**
 * One sentence about what was observed, for the record and the prompt.
 *
 * In this module rather than at either call site, for the reason `describeFailure`
 * and `suggestedFix` share one in `verify.ts` (#135): the sentence the fixer
 * reads and the sentence the archive keeps have to agree about which kind of
 * observation this was, and they cannot disagree if one function writes both.
 */
export function describeOutcome(outcome: ReproducerOutcome): string {
  const where =
    outcome.gate === null || outcome.command === null
      ? ''
      : ` (\`${outcome.command}\`, the ${outcome.gate} gate)`;

  switch (outcome.verdict) {
    case 'reproduced':
      return outcome.at === 'review'
        ? `The reviewer's own test for this fails against the code as it stands${where}, on a tree ` +
            'where that same gate had just passed. The defect is real and this is an observation ' +
            'of it, not an assertion about it.'
        : `The reviewer's own test for this still fails after the fix${where}.`;
    case 'did-not-reproduce':
      return outcome.at === 'review'
        ? `The reviewer's own test for this **passed** against the unfixed code${where}. Whatever ` +
            'the finding describes, that test does not show it happening.'
        : `The reviewer's own test for this failed before the fix and passes after it${where}. ` +
            'The finding is closed by evidence rather than by assertion.';
    case 'unproven':
      return (
        'The reviewer supplied a test for this, and nothing was observed from it: ' +
        `${outcome.reason ?? 'no reason was recorded'}. That says nothing either way about the ` +
        'finding, which stands exactly as it was raised.'
      );
  }
}
