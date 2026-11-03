import { gitBin, resolveCommit } from '@src/git.js';
import { redact } from '@src/heldkeys.js';
import * as log from '@src/log.js';
import { run } from '@src/proc.js';
import { artifact, removeArtifact } from '@src/run.js';
import type { Plan, RunState } from '@src/types.js';
import { planNamedFiles } from '@src/work.js';

/**
 * Which paths a plan names that do not exist at the commit the run started
 * from (#491). **A record and nothing else**: no prompt reads it, no guard
 * reads it, and the critic is told nothing new.
 *
 * Why it is worth recording at all: of 276 critique findings across 25 archived
 * runs, 75% dispute a fact about the existing code and 52% would be settled by
 * one command or one file read (the measurement `planInspectionNote` in
 * `src/prompts.ts` was written for). A path the plan cites that the start
 * commit does not hold is the cheapest such fact there is, and the only
 * harness-side check on a plan's content so far is `refusePlaceholderPlan`.
 *
 * Why it is not yet shown to the critic: a plan legitimately names files it
 * will create, so an absent path is not a defect, and rendering the list into
 * the critique prompt - as a note in the `planInspectionNote` pattern, never as
 * a finding - is a later PR, once this record's census has shown what it
 * yields. Until then every prompt stays byte-identical.
 */
export interface PlanPathsRecord {
  /** `plan-<round>.json`, which this describes. */
  round: number;
  /** The full id of the commit the paths were resolved against: `state.start.sha`. */
  commit: string;
  /**
   * Every path `planNamedFiles` returned, in its order, resolved at `commit`.
   * `type` is git's object type for a present path - `blob`, `tree`, or
   * `commit` for a submodule - so "the plan named a directory" stays visible.
   */
  paths: PlanPath[];
  /**
   * Paths that were not asked about, because no answer git gives would be
   * about this commit's tree: one with a `..` segment, or one that is empty
   * once normalised. Listed rather than dropped, and never marked absent.
   */
  notChecked: { path: string; reason: string }[];
}

export type PlanPath = { path: string; present: true; type: string } | { path: string; present: false };

export type PlanPathsRead = { kind: 'resolved'; record: PlanPathsRecord } | { kind: 'unreadable'; reason: string };

/** The artifact's name, beside `plan-<round>.json`. */
export function planPathsFile(round: number): string {
  return `plan-paths-${round}.json`;
}

const OUTSIDE = 'it has a `..` segment, so it does not name a path inside the commit';
const EMPTY = 'it is empty once normalised';

function notCheckable(p: string): string | null {
  if (p === '') return EMPTY;
  return p.split('/').includes('..') ? OUTSIDE : null;
}

/** `<oid> <type> <size>` for an object, `<what> missing` for none. */
const FOUND = /^[0-9a-f]{40,64} (\w+) \d+$/;

/**
 * Resolve `paths` at `sha`. Never throws.
 *
 * **One `git cat-file --batch-check`, after `resolveCommit` has said the id is
 * a commit** - the object-read half of the path `readReviewMd` takes, asked
 * about many paths at once rather than spawning `ls-tree` per path. The order
 * matters: batch-check answers `missing` for every path under an id that does
 * not exist, so without the commit check first a commit that could not be
 * read would be recorded as a plan whose every path is absent.
 *
 * Each path is asked twice, as `<sha>:./<path>` (relative to `cwd`, as
 * `readReviewMd`'s `ls-tree` is) and `<sha>:<path>` (from the repository's
 * root), and it is present if either names an object. A plan is entitled to
 * write `app/src/x.ts` for a run rooted at `app/`, and to write `src/x.ts`;
 * both are the file, so neither spelling alone may call it absent. When `cwd`
 * is the root the two questions are the same one.
 *
 * Any failure - git not runnable, a non-zero exit, a line count or a line
 * shape it did not expect - answers `unreadable` and records nothing: a path is
 * never marked absent because a read failed. Both reads skip `run`'s
 * redaction, as `readReviewMd`'s do, because a held key occurring inside an
 * object id or a path would change a line this parses; the reasons returned
 * are redacted at the one exit.
 */
export async function resolvePlanPaths(
  cwd: string,
  sha: string,
  round: number,
  paths: readonly string[],
): Promise<PlanPathsRead> {
  const read = await resolveUnredacted(cwd, sha, round, paths);
  return read.kind === 'unreadable' ? { kind: 'unreadable', reason: redact(read.reason) } : read;
}

async function resolveUnredacted(
  cwd: string,
  sha: string,
  round: number,
  paths: readonly string[],
): Promise<PlanPathsRead> {
  let commit: string | null;
  try {
    commit = await resolveCommit(cwd, sha);
  } catch (err: unknown) {
    return { kind: 'unreadable', reason: `the start commit could not be resolved: ${message(err)}` };
  }
  if (commit !== sha) return { kind: 'unreadable', reason: `${sha.slice(0, 7)} does not resolve to a commit here` };

  const asked: string[] = [];
  const notChecked: PlanPathsRecord['notChecked'] = [];
  for (const p of paths) {
    const reason = notCheckable(p);
    if (reason === null) asked.push(p);
    else notChecked.push({ path: p, reason });
  }
  const record: PlanPathsRecord = { round, commit: sha, paths: [], notChecked };
  if (asked.length === 0) return { kind: 'resolved', record };

  const input = asked.map((p) => `${sha}:./${p}\n${sha}:${p}\n`).join('');
  let out: { code: number | null; stdout: string; stderr: string };
  try {
    out = await run(gitBin(), ['cat-file', '--batch-check'], { cwd, input, redact: false });
  } catch (err: unknown) {
    return { kind: 'unreadable', reason: `git cat-file --batch-check could not be run: ${message(err)}` };
  }
  if (out.code !== 0) {
    return {
      kind: 'unreadable',
      reason: `git cat-file --batch-check exited ${String(out.code)}: ${out.stderr.trim() || 'it printed nothing'}`,
    };
  }
  const lines = out.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
  if (lines.length !== asked.length * 2) {
    return {
      kind: 'unreadable',
      reason: `git cat-file --batch-check answered ${lines.length} lines for ${asked.length * 2} questions`,
    };
  }
  for (const [i, p] of asked.entries()) {
    const answers = [lines[2 * i] ?? '', lines[2 * i + 1] ?? ''].map((line) => {
      const found = FOUND.exec(line);
      if (found !== null) return found[1] ?? null;
      return line.endsWith(' missing') ? null : undefined;
    });
    if (answers.includes(undefined)) {
      return { kind: 'unreadable', reason: `git cat-file --batch-check printed a line vibe could not read for ${p}` };
    }
    const type = answers.find((a): a is string => typeof a === 'string');
    record.paths.push(type === undefined ? { path: p, present: false } : { path: p, present: true, type });
  }
  return { kind: 'resolved', record };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write `plan-paths-<round>.json` for the plan just written as
 * `plan-<round>.json`, or nothing. **Best-effort, and never throws**: nothing
 * about the run may depend on this record, so a failure here is narrated at
 * `detail` and the run goes on exactly as it would have without it.
 *
 * Nothing is recorded without `state.start` - a run from before #249, or one
 * not on a branch - because the only commit the paths may be resolved against
 * is the one the run started from, and guessing another (HEAD, `baseSha`)
 * would be a measurement of a tree nobody planned against. When nothing is
 * recorded, a file left by an earlier draft of the same round (a revision
 * answering the planner's own questions replaces `plan-<round>.json`) is
 * removed, so the record never describes a plan that is no longer on disk.
 */
export async function recordPlanPaths(state: RunState, cwd: string, plan: Plan): Promise<void> {
  const name = planPathsFile(state.planRound);
  try {
    const start = state.start?.sha;
    if (start === undefined) {
      removeArtifact(state, name);
      return;
    }
    const read = await resolvePlanPaths(cwd, start, state.planRound, planNamedFiles(plan.plan_md));
    if (read.kind === 'unreadable') {
      removeArtifact(state, name);
      log.detail(`${name} not written: ${read.reason}`);
      return;
    }
    artifact(state, name, read.record);
  } catch (err: unknown) {
    try {
      removeArtifact(state, name);
    } catch {
      // Already failing; the narration below is what is left to say.
    }
    log.detail(redact(`${name} not written: ${message(err)}`));
  }
}
