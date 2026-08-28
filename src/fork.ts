import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { applyOverrides, loadConfig } from '@src/config.js';
import { checkStoredConsistency, checkTokenShare } from '@src/consistency.js';
import type { TokenShareClamp } from '@src/consistency.js';
import * as git from '@src/git.js';
import { acquireLock, describeLiveness, livenessOf } from '@src/lock.js';
import * as P from '@src/prompts.js';
import {
  artifact,
  claimRunDir,
  linkedRunReason,
  listCheckpoints,
  mintRunId,
  resumePhase,
  saveState,
  stageEvent,
  statePresence,
} from '@src/run.js';
import { forkedSlotFields } from '@src/slots.js';
import {
  assertUsableRunId,
  isRecord,
  isReportBasename,
  parseStoredState,
  validateStoredState,
} from '@src/stored.js';
import type {
  Config,
  ConfigOverrides,
  ForkOrigin,
  RunCheckpointMeta,
  RunState,
} from '@src/types.js';

/**
 * `vibe fork <run-id> --at <n>`: seed a new run from a point in an old one (#78).
 *
 * Split into two phases with a hard line between them, because the guarantees
 * are different on each side of it:
 *
 * - **`planFork` reads and refuses.** It creates nothing, writes nothing, moves
 *   no ref and touches no working tree. Every refusal below can therefore say
 *   truthfully that the repository is exactly as it was.
 * - **`commitFork` creates**, in one order, with the child's `state.json` last -
 *   so a kill leaves either no run at all (a directory with no state.json, which
 *   `listRuns` already treats as not-a-run since #77) or a complete one whose
 *   artifacts are already correct.
 *
 * **The fork never checks anything out.** It creates the branch REF with
 * `git branch <name> <sha>` and stops; HEAD, the index and the working tree are
 * exactly as they were, so the parent stays resumable and the user's uncommitted
 * work is untouched. The forked run gets onto its branch when it is actually
 * resumed - `prepareGit` in `src/orchestrator.ts`, gated on `branchPending`.
 */

const RUNS_DIR = path.join('.vibe', 'runs');

/** A refusal a user can act on. Never thrown after anything has been created. */
export class ForkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForkError';
  }
}

export interface ForkPlan {
  source: { id: string; dir: string };
  /** The checkpoint, validated and rehydrated exactly as `loadRun` does it. */
  checkpointState: RunState;
  meta: RunCheckpointMeta;
  /** Resolved AND validated - the same bar `resumeConfig` holds a resume to. */
  cfg: Config;
  /** The canonical 40-hex commit, already resolved against this repo, or null. */
  commit: string | null;
  /**
   * Rule D's verdict on the checkpoint's token share (#87), or null when there
   * was nothing to clamp. `checkpointState` above already carries the clamped
   * value; this is the record of what it held, which `commitFork` stages on the
   * child so the figure is not lost with the plan object.
   */
  tokenShare: TokenShareClamp | null;
  /** What the fork will not carry, stated rather than left to be assumed. */
  losses: string[];
}

const runsRootOf = (targetDir: string): string => path.join(targetDir, RUNS_DIR);

/**
 * The checkpoints a run can be forked from. Reads only, and never throws for a
 * damaged snapshot - one bad checkpoint must not hide the good ones.
 *
 * The id is asserted **before any path is constructed**, which is why this has
 * its own entry point rather than being reached through `planFork`: `vibe fork
 * ../other` with no `--at` takes the listing path, and a positional argument
 * must never reach `readdirSync` unchecked.
 */
export function listForkPoints(targetDir: string, sourceId: string): { n: number; meta: RunCheckpointMeta | null }[] {
  const root = runsRootOf(targetDir);
  assertUsableRunId(sourceId, root);
  // Before `listCheckpoints`, which `readdirSync`s inside the entry: a linked
  // entry would have its target enumerated (#53).
  const linked = linkedRunReason(root, sourceId);
  if (linked !== null) throw new ForkError(linked);
  return listCheckpoints(path.join(root, sourceId)).map(({ n, meta }) => ({ n, meta }));
}

/**
 * Everything that can refuse, before anything can be created.
 *
 * The bar here is **stricter than a resume's** on purpose. `loadRun` repairs
 * what it can because the alternative is a user who cannot get back to their own
 * run; a fork has no such pressure - the parent is right there, untouched - and
 * a snapshot whose fields had to be corrected is not one whose boundary, round
 * numbers or commit can be trusted under a new identity. So: no repairs, no
 * phase normalisations, metadata required, and `meta.n` must agree with the
 * number asked for.
 *
 * **Rule D is the one documented exception**, and it is narrow: a Codex share
 * larger than the checkpoint's own total is clamped rather than refused, and
 * disclosed in `losses`. See the call to `checkTokenShare` below for why that
 * field is not one the bar above is protecting.
 */
export async function planFork(
  targetDir: string,
  sourceId: string,
  n: number,
  overrides: ConfigOverrides,
): Promise<ForkPlan> {
  const root = runsRootOf(targetDir);
  // First, before a path exists. `../other` never reaches the filesystem.
  assertUsableRunId(sourceId, root);
  // Then the filesystem question the lexical one cannot answer, before
  // `statePresence` (a `statSync`, which follows a link) and before `livenessOf`
  // (which reads the lock inside it). A preflight that only reads must still
  // refuse rather than read (#53).
  const linked = linkedRunReason(root, sourceId);
  if (linked !== null) throw new ForkError(linked);
  const sourceDir = path.join(root, sourceId);

  const statePath = path.join(sourceDir, 'state.json');
  if (statePresence(statePath) === 'absent') {
    throw new ForkError(`No run "${sourceId}" under ${RUNS_DIR}. Run "vibe list" to see the runs in this repo.`);
  }

  // A checkpoint from a live run is a moving target, and the fork must not take
  // the parent's lock to find out - that would be a write to the parent. There
  // is deliberately no --force: the answer to "it might still be running" is to
  // wait, not to copy a state mid-flight.
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
  } catch {
    raw = undefined;
  }
  const verdict = livenessOf(sourceDir, raw);
  if (verdict.liveness === 'running' || verdict.liveness === 'unknown') {
    throw new ForkError(
      `Run ${sourceId} cannot be forked: ${describeLiveness(verdict)} Nothing was read further ` +
        'and nothing was written. Wait for it to finish, then fork.',
    );
  }

  const file = path.join(sourceDir, `checkpoint-${n}.json`);
  if (!existsSync(file)) {
    throw new ForkError(`Run ${sourceId} has no checkpoint ${n}. Run "vibe fork ${sourceId}" to see its fork points.`);
  }

  const parsed = parseStoredState(readFileSync(file, 'utf8'), sourceId, sourceDir);
  const { state: checked, repairs } = validateStoredState(parsed, sourceId, sourceDir);
  if (repairs.length > 0) {
    throw new ForkError(
      `Checkpoint ${n} of run ${sourceId} needed ${repairs.length} field(s) repaired to be read ` +
        `(${repairs.map((r) => r.field).join(', ')}), so it is not a state vibe will fork. ` +
        'Nothing was created. A resume repairs what it must; a fork copies uncertainty forward ' +
        'under a new identity, and will not.',
    );
  }

  // The two paths the validator does not decide, rehydrated exactly as `loadRun`
  // does it - it returns `StoredRunState`, which omits both.
  const checkpointState: RunState = { ...checked, dir: sourceDir, targetDir };

  const normalisation = checkStoredConsistency(
    checkpointState,
    resumePhase(checkpointState),
    isRecord(parsed) ? parsed['phase'] : undefined,
  );
  if (normalisation !== null) {
    throw new ForkError(
      `Checkpoint ${n} of run ${sourceId} is internally inconsistent: ${normalisation.why}. ` +
        'Nothing was created.',
    );
  }

  // Rule D (#87), clamped rather than refused - the one exception to the bar in
  // this function's header. The bar exists to protect the fields a fork's
  // identity rests on: the boundary, the round numbers and the commit. This is
  // none of them. `codexTokens` is read by `summary()` and by the inherited-share
  // line and by nothing else, the damage is one-directional, and the clamp only
  // ever LOWERS it - `tokensUsed` and `costUsd` are inherited untouched, so the
  // child's ceilings are exactly what they would have been. Refusing would stand
  // a forkable run down over a display defect.
  //
  // Only the in-memory `checkpointState` is changed. Nothing under the parent's
  // directory is written by this function, and `checkpoint-${n}.json` still holds
  // what it held - which is why the losses line below says so.
  const tokenShare = checkTokenShare(checkpointState);
  if (tokenShare !== null) checkpointState.codexTokens = tokenShare.codexTokens;

  const meta = checkpointState.checkpoint;
  if (meta === undefined) {
    throw new ForkError(
      `Checkpoint ${n} of run ${sourceId} carries no checkpoint metadata, so vibe cannot say ` +
        'which boundary it was taken at. Nothing was created.',
    );
  }
  if (meta.n !== n) {
    throw new ForkError(
      `Checkpoint ${n} of run ${sourceId} says it is checkpoint ${meta.n}. The file and its ` +
        'contents disagree, so neither is trusted. Nothing was created.',
    );
  }

  // The same validation `resumeConfig` performs, and for the same reason:
  // `state.config` is the one field `validateStoredState` deliberately does not
  // check, so this is where a stored config that no longer validates refuses.
  const cfg =
    checkpointState.config === undefined
      ? loadConfig(targetDir, overrides)
      : applyOverrides(checkpointState.config, overrides);

  const losses: string[] = [];
  // First, so it sits with the inherited totals rather than after the branch
  // talk: this one is about the numbers the `Inherited:` line prints.
  if (tokenShare !== null) {
    losses.push(
      `checkpoint ${n} recorded ${tokenShare.storedCodexTokens.toLocaleString()} Codex tokens ` +
        `against a run total of ${tokenShare.tokensUsed.toLocaleString()}, which no writer ` +
        `produces - the fork carries the Codex share clamped to ` +
        `${tokenShare.codexTokens.toLocaleString()}, and the parent's files were not changed`,
    );
  }
  const isRepo = await git.isRepo(targetDir);
  let commit: string | null = null;

  if (meta.commit !== null) {
    if (!isRepo) {
      throw new ForkError(
        `Checkpoint ${n} names commit ${meta.commit}, but ${targetDir} is not a git repository. ` +
          'Nothing was created.',
      );
    }
    // Compared to what was stored, never adopted: an abbreviation or a branch
    // name would resolve to *something*, and that something is not the commit
    // the round produced.
    const resolved = await git.resolveCommit(targetDir, meta.commit);
    if (resolved !== meta.commit) {
      throw new ForkError(
        `Checkpoint ${n} names commit ${meta.commit}, which this repository cannot resolve to ` +
          'that exact commit. Nothing was created.',
      );
    }
    commit = resolved;
  }

  // Exactly the condition `commitFork` creates a branch under, so what is said
  // here is what will actually be true afterwards.
  const willBranch = cfg.git.useBranch && isRepo && commit !== null;

  if (cfg.git.useBranch) {
    if (!isRepo) {
      losses.push('this is not a git repository, so the fork gets no branch of its own');
      losses.push(
        'without a branch, the fork will run on whatever is checked out when you resume it',
      );
    } else if (commit === null) {
      const withCommits = listCheckpoints(sourceDir)
        .filter((c) => c.meta?.commit != null)
        .map((c) => c.n);
      throw new ForkError(
        `Checkpoint ${n} of run ${sourceId} recorded no commit (${meta.commitNote}), so there is ` +
          'no point in the history to branch from. Nothing was created.\n' +
          (withCommits.length > 0
            ? `  Checkpoints with a commit: ${withCommits.join(', ')}\n`
            : '  No checkpoint of this run recorded a commit.\n') +
          '  Or fork with --no-branch to run on whatever is checked out.',
      );
    }
  } else {
    losses.push(
      'no branch was created (--no-branch), so the fork will run on whatever is checked out ' +
        'when you resume it',
    );
  }

  // Only when there will BE a branch. Under `--no-branch` - or outside a
  // repository - both of these describe a ref that is never created, and a
  // losses list that states things about a result it did not produce is worse
  // than one that says less: `notInherited` is read as a record of what actually
  // happened.
  if (willBranch) {
    losses.push(
      'the repository may have moved on since the checkpoint - the fork branches from the ' +
        "commit the checkpoint recorded, not from today's HEAD",
    );
    losses.push(
      "the fork's branch is a new ref at the same commit, not a copy of the parent's branch",
    );
  }
  losses.push(
    'only PLAN.md and the last report are copied; every other artifact stays with the parent',
  );

  return {
    source: { id: sourceId, dir: sourceDir },
    checkpointState,
    meta,
    cfg,
    commit,
    tokenShare,
    losses,
  };
}

export interface ForkResult {
  state: RunState;
  branch: string | null;
  /** Everything the fork could not carry, including anything found while creating. */
  losses: string[];
}

/**
 * Create the run. The only phase that creates anything, and the state write is
 * last.
 *
 * `rollback()` undoes what THIS call made - files in a directory that has never
 * held a `state.json`, and a branch ref minted seconds ago at a known sha that
 * nothing has checked out. It is deliberately not the general "clean up a stray
 * branch some killed process left" that this change declines to build: a process
 * that died cannot run its own rollback, and deleting a ref on the user's behalf
 * afterwards is its own decision.
 */
export async function commitFork(targetDir: string, plan: ForkPlan): Promise<ForkResult> {
  // Once more, immediately before anything is created: the preflight is
  // read-only and the parent could have been picked up in between. The residual
  // window is milliseconds and closing it entirely would mean taking the
  // parent's lock, which is a write to the parent.
  // `plan` is a parameter on an exported function, and `ForkPlan` is an exported
  // interface, so `plan.source.dir` is a caller's string rather than a path this
  // module resolved - there is no runtime provenance that it came from
  // `planFork`. Re-derive it, check the pair agrees, and classify it, all before
  // `livenessOf`, which reads the source's lock through whatever path it is
  // given (#53). A plan that did come from `planFork` produces exactly this
  // directory and passes unchanged.
  const root = runsRootOf(targetDir);
  assertUsableRunId(plan.source.id, root);
  const sourceDir = path.join(root, plan.source.id);
  if (path.resolve(plan.source.dir) !== path.resolve(sourceDir)) {
    throw new ForkError(
      `The fork plan names run ${plan.source.id} but points at ${plan.source.dir}, which is not ` +
        `its directory under ${RUNS_DIR}. Nothing was created.`,
    );
  }
  const linkedSource = linkedRunReason(root, plan.source.id);
  if (linkedSource !== null) throw new ForkError(linkedSource);

  const verdict = livenessOf(sourceDir);
  if (verdict.liveness === 'running' || verdict.liveness === 'unknown') {
    throw new ForkError(
      `Run ${plan.source.id} cannot be forked: ${describeLiveness(verdict)} Nothing was created.`,
    );
  }

  const cfg = plan.cfg;
  const losses = [...plan.losses];
  const task = plan.checkpointState.task;

  const id = mintRunId(task);
  let claimed = null;
  for (let attempt = 1; attempt <= 9 && claimed === null; attempt++) {
    claimed = claimRunDir(targetDir, attempt === 1 ? id : `${id}-${attempt}`);
  }
  if (claimed === null) {
    throw new ForkError(
      `Could not allocate a run directory for the fork: ${id} and every suffixed variant of it ` +
        'already exist. Nothing was written.',
    );
  }

  const created: string[] = [];
  let branchCreated: string | null = null;
  const rollback = async (): Promise<void> => {
    for (const file of created) {
      try {
        rmSync(file, { force: true });
      } catch {
        // Nothing useful to say over the real failure.
      }
    }
    try {
      rmSync(claimed.dir, { recursive: true, force: true });
    } catch {
      // Same.
    }
    if (branchCreated !== null) await git.deleteBranchRef(targetDir, branchCreated);
  };

  let release: (() => void) | null = null;
  try {
    // Only when a branch will actually be created. Under --no-branch nothing
    // will read, write or move that ref, so an unrelated branch of the derived
    // name is not this fork's problem.
    const wantsBranch = cfg.git.useBranch && plan.commit !== null && (await git.isRepo(targetDir));
    const branchName = `${cfg.git.branchPrefix}${claimed.id}`;
    if (wantsBranch && (await git.branchExists(targetDir, branchName))) {
      await rollback();
      throw new ForkError(
        `Branch ${branchName} already exists, so the fork has nowhere to put its history. ` +
          'Nothing was created. Delete it, or fork with --no-branch.',
      );
    }

    if (statePresence(path.join(claimed.dir, 'state.json')) !== 'absent') {
      await rollback();
      throw new ForkError(`Run ${claimed.id} already holds a state.json. Nothing was created.`);
    }
    const lock = acquireLock(claimed.dir, claimed.id, false);
    if (!lock.ok || lock.handle === null) {
      await rollback();
      throw new ForkError(`Run ${claimed.id} is already locked: ${describeLiveness(lock.verdict)}`);
    }
    release = lock.handle.release;

    let branch: string | null = null;
    if (wantsBranch && plan.commit !== null) {
      const made = await git.createBranchRef(targetDir, branchName, plan.commit);
      if (!made.ok) {
        await rollback();
        throw new ForkError(
          `Could not create branch ${branchName} at ${plan.commit}: ${made.error}\nNothing was created.`,
        );
      }
      branchCreated = branchName;
      branch = branchName;
    }

    // The child state, in memory. Everything not named here is the checkpoint
    // verbatim - `baseSha`, `checkpoint`, `tokensUsed`, `costUsd`, `codexTokens`
    // included, with rule D the single exception: `planFork` clamps a Codex
    // share larger than the checkpoint's own total before handing the state
    // over, and records what it clamped in `plan.tokenShare` (#87). The totals
    // are inherited on purpose: a fork's ceilings read them exactly as an
    // unforked run's do, and pretending otherwise would be a second, quieter
    // accounting.
    const slots = forkedSlotFields(plan.checkpointState, cfg);
    const child: RunState = {
      ...plan.checkpointState,
      ...slots.fields,
      id: claimed.id,
      dir: claimed.dir,
      targetDir,
      branch,
      config: cfg,
    };
    for (const key of slots.clear) delete child[key];
    if (branch === null) delete child.branchPending;
    else child.branchPending = true;

    // The artifacts BEFORE the state write, so there is no moment in which the
    // child exists and points at a file that is not there.
    if (child.plan !== null) {
      // `renderPlanDoc`, never bare `plan_md`: this repo treats the plan
      // document as the plan plus its out-of-scope and acceptance sections, and
      // half of it on disk under a new run id is a plan nobody approved.
      created.push(artifact(child, 'PLAN.md', P.renderPlanDoc(child.plan)));
    }

    const report = child.lastReport;
    if (report !== undefined) {
      // Checked on both sides. The reader already applies `isReportBasename` on
      // the way in; this is the call that turns the value into two paths.
      // `sourceDir`, the re-derived path, not `plan.source.dir` - the check at
      // the top of this function proved the two agree, and using the derived one
      // keeps that true for every read this function makes (#53).
      const source = path.join(sourceDir, report);
      if (!isReportBasename(report) || !existsSync(source)) {
        delete child.lastReport;
        losses.push(`the last report (${report}) is not in the parent's directory, so it was not copied`);
      } else {
        try {
          const dest = path.join(child.dir, report);
          copyFileSync(source, dest);
          created.push(dest);
        } catch (err: unknown) {
          delete child.lastReport;
          losses.push(
            `the last report (${report}) could not be copied: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    for (const conversation of slots.conversations) {
      if (conversation.why === 'not-persisted') {
        losses.push(`the ${conversation.slot} conversation is not persisted by this config, so there was none to fork`);
      } else if (conversation.why === 'never-started') {
        losses.push(`the ${conversation.slot} conversation never ran in the parent, so there was none to fork`);
      }
    }

    const origin: ForkOrigin = {
      runId: plan.source.id,
      checkpoint: plan.meta.n,
      checkpointAt: plan.meta.at,
      boundary: plan.meta.boundary,
      forkedAt: new Date().toISOString(),
      inheritedTokens: plan.checkpointState.tokensUsed,
      inheritedCostUsd: plan.checkpointState.costUsd,
      // The checkpoint's value, and ABSENT when the checkpoint had none. Not
      // classified and not defaulted to zero: an absent Codex share may mean no
      // Codex turn ran or that none was recorded, and nothing here decides
      // which.
      //
      // Read from the clamped `checkpointState`, so when rule D fired this is
      // the NORMALISED figure rather than the raw one - a provenance field that
      // exceeded the `inheritedTokens` beside it would be the same defect one
      // layer down. The raw figure survives in the staged rule-D event below and
      // in `notInherited` (#87).
      ...(plan.checkpointState.codexTokens === undefined
        ? {}
        : { inheritedCodexTokens: plan.checkpointState.codexTokens }),
      branchFrom: branch === null ? null : plan.commit,
      conversations: slots.conversations,
      notInherited: [...losses],
    };
    child.forkedFrom = origin;

    // Staged rather than recorded: `recordEvent` saves, and the child's state
    // write has to stay last so a kill leaves either no run at all or a complete
    // one. The payload is the same shape `loadRun` writes for rule D, so an
    // audit of "which stored fields did something alter" reads the two paths
    // identically (#87).
    if (plan.tokenShare !== null) {
      const share = plan.tokenShare;
      stageEvent(child, 'state_repaired', {
        field: 'codexTokens',
        found: String(share.storedCodexTokens),
        replacedWith: String(share.codexTokens),
        droppedCount: 0,
        droppedPaths: [],
        rule: share.rule,
        against: 'tokensUsed',
        storedCodexTokens: share.storedCodexTokens,
        tokensUsed: share.tokensUsed,
        why: share.why,
      });
    }

    // The last write. Before it, the directory is not a run; after it, the run
    // is complete and its artifacts already correct.
    saveState(child);
    return { state: child, branch, losses };
  } catch (err: unknown) {
    if (!(err instanceof ForkError)) await rollback();
    throw err;
  } finally {
    // Idempotent by contract, and never removes a lock this handle did not
    // write - so a rollback that already deleted the directory is harmless.
    release?.();
  }
}
