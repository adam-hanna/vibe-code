import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gitBin, isRepo } from '@src/git.js';
import { livenessOf, lockPath, probePid } from '@src/lock.js';
import type { LivenessVerdict, PidProbe } from '@src/lock.js';
import { entryVerdict, RUNS_DIR, runEntryLinkage } from '@src/run.js';
import type { RunEntryLinkage } from '@src/run.js';
import { run } from '@src/proc.js';
import { runUserCommand } from '@src/verify.js';
import type { RunState } from '@src/types.js';

/**
 * A checkout of its own for the run to work in (#223).
 *
 * ## What this separates
 *
 * `vibe` has always run where it was pointed. Working in a git worktree is a
 * thing `AGENTS.md` tells a *human* to do — one per issue under `.worktrees/`,
 * so the tool changing the code is a published build rather than the tree it is
 * editing — and doing it by hand is four commands and a cleanup nobody
 * remembers. Asked for as *"the pilot should automatically start a worktree for
 * the vibe session to run in"*.
 *
 * The decision that makes it work is **which directory means what**:
 *
 * - `state.targetDir` is the run's **home**. The archive, the lock and the
 *   planner's past-run index all live there, and none of them move.
 * - `workDirOf(state)` is where the **work** happens: every git operation, the
 *   verification gate, and the cwd of every agent child.
 *
 * Both are the same directory unless this run has a worktree, which is what
 * makes the whole feature inert when it is off.
 *
 * **Putting the archive in the worktree was the obvious shape and is the wrong
 * one.** A run's record would land in a tree somebody is about to prune — and
 * `AGENTS.md` carries a hand-written `cp -r` recipe for exactly that loss,
 * because `git worktree remove` takes `.vibe/` with it. Worse, the next run's
 * planner reads `.vibe/runs` in the tree it is given, so every auto-worktree run
 * would start blind to a history it had itself produced. Keeping the archive at
 * home costs one indirection and deletes that whole class of problem.
 *
 * ## The path is derived and never stored
 *
 * `loadRun` re-derives `dir` and `targetDir` rather than trusting what is on
 * disk, because a repository legitimately moves and a stored absolute path is
 * the thing that breaks when it does. The same reasoning applies here, so what
 * `state` keeps is the **decision** — `worktree: true` — and the location comes
 * back out of `worktreePath`.
 *
 * That is also why a custom script is *handed* its target rather than asked for
 * one. A script that printed its own path would be a path this run would have to
 * store, and the stored-path problem would arrive with it.
 *
 * ## Where the branch is decided, and it is not here
 *
 * The worktree is created **detached**. `prepareGit` owns every branch question
 * in this product — seven call sites settle it and `run_branch` says which — so
 * a `git worktree add -b` here would be a second answer to it, and the two would
 * disagree the first time somebody set `git.branchPrefix` or passed
 * `--no-branch`. This decides *where*; `prepareGit` still decides *which
 * branch*, inside it, exactly as it does in a plain checkout.
 *
 * **A custom script is told that branch, and it is still one answer** (#223).
 * Asked for directly — the setup command needed *"a placeholder for the
 * directory path and branch name"* — because a project's own worktree script
 * usually wants `git worktree add <dir> <branch>`, not a detached head it then
 * has to fix up. So the caller computes the branch with `runBranch`, the same
 * expression `prepareGit` uses, creates the **ref** before the script runs, and
 * passes it as `VIBE_BRANCH`. `prepareGit` then finds the branch already
 * existing and adopts it instead of creating it again. The script never names a
 * branch; it is told one, and only when branch isolation is on.
 *
 * **And it never chooses a commit** (#249). The branch is made at `git.baseRef`,
 * or at HEAD when that is unset, and the default path detaches at that same
 * commit. A script that put the worktree somewhere else used to be overridden
 * in silence by `prepareGit`'s checkout - which is how the #169 run started from
 * a stale tip - and is now refused there instead, naming both commits.
 */

/** Where worktrees live, relative to the repository. */
export const WORKTREES_DIR = '.worktrees';

/**
 * The checkout for one run.
 *
 * Inside the repository rather than beside it: a sibling directory is a write
 * outside the tree somebody pointed at, which is a surprise, and `.vibe/` has
 * already settled that question the other way. The cost is that it shows up as
 * untracked in the main checkout, which `ensureWorktreesIgnored` answers the
 * same way `ensureVibeIgnored` does.
 */
export function worktreePath(targetDir: string, id: string): string {
  return path.join(targetDir, WORKTREES_DIR, id);
}

/**
 * Where this run's work happens: its worktree, or the repository itself.
 *
 * **The one place the two directories are resolved**, for the reason `shownDir`
 * is one expression in the app: a second answer to "which tree" is how the
 * reviewer comes to read a diff from one checkout while the gate runs in
 * another, and that failure is silent in both directions.
 */
export function workDirOf(state: RunState): string {
  return state.worktree === true ? worktreePath(state.targetDir, state.id) : state.targetDir;
}

/**
 * Make `.worktrees/` self-ignoring, wherever it sits.
 *
 * Exactly `ensureVibeIgnored`'s shape and for its stated reason: this repo's own
 * `.gitignore` lists `.worktrees/`, but a directory vibe creates in **somebody
 * else's** checkout cannot rely on that, and a tree full of untracked worktrees
 * is a `git status` nobody can read. Never overwrites an existing file.
 */
export function ensureWorktreesIgnored(targetDir: string): void {
  const dir = path.join(targetDir, WORKTREES_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.gitignore');
  if (!existsSync(file)) writeFileSync(file, '*\n', 'utf8');
}

/** What a worktree attempt produced: the path it made, or why it made none. */
export type WorktreeResult =
  | { ok: true; dir: string; how: 'git' | 'command'; created: boolean }
  | { ok: false; reason: string };

/**
 * Whether `dir` is already a usable worktree, so a resume does not re-create it.
 *
 * A resume runs this again — `prepareGit` is re-run on every pass for the same
 * reason — and `git worktree add` on an existing path fails. Checked as *is this
 * a working tree* rather than *does the directory exist*, because a half-made
 * one is the state a killed creation leaves and reusing that would put the run
 * in a directory git does not know about.
 */
async function usable(dir: string): Promise<boolean> {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return isRepo(dir);
}

/**
 * Create this run's worktree, or say why not.
 *
 * **Refuses rather than repairs, and nothing has been spent when it does.** This
 * runs before the first agent turn, so a failure here costs a refusal and a
 * sentence — which is the same bargain `gitPrecondition` strikes, and for the
 * same reason: the run that produced #71 spent 30M tokens before the review
 * phase discovered its own directory could not host it.
 *
 * The verification after the custom script is the half that matters. A script
 * that exits 0 and leaves nothing usable behind would otherwise hand the loop a
 * directory that is not a checkout, and every git operation afterwards would
 * fail one at a time with no sentence naming the cause.
 */
export async function createWorktree(args: {
  /** The repository. The worktree is made from here, and `cwd` for the script. */
  targetDir: string;
  /** This run's id, which names the directory. */
  id: string;
  /** The user's own command, run instead of `git worktree add`. */
  command: string | null;
  timeoutMs: number;
  /**
   * The branch the run will be on, already created as a ref at `git.baseRef` or
   * HEAD, or null when branch isolation is off. Passed to a custom script as
   * `VIBE_BRANCH`; the default `git worktree add --detach` detaches at its commit
   * and leaves it to `prepareGit` to check out (#249).
   */
  branch: string | null;
}): Promise<WorktreeResult> {
  const dir = worktreePath(args.targetDir, args.id);

  if (await usable(dir)) return { ok: true, dir, how: 'git', created: false };

  try {
    ensureWorktreesIgnored(args.targetDir);
  } catch (err: unknown) {
    return {
      ok: false,
      reason:
        `Could not create ${path.join(args.targetDir, WORKTREES_DIR)} ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    };
  }

  if (args.command !== null) {
    const ran = await runSetup(args, dir);
    if (ran !== null) return ran;
    // The script said it worked. Whether it did is a separate question, and the
    // check below is the one that answers it.
  } else {
    // `--detach` is what keeps `prepareGit` the only thing that names a branch.
    // The commit-ish is explicit rather than defaulted: a worktree created from
    // an unstated one is one whose starting point depends on git's version. It
    // is the branch's commit rather than HEAD (#249), because with `git.baseRef`
    // set the two differ, and a worktree detached at HEAD would then be refused
    // by `prepareGit` for not being where its branch is. `refs/heads/` so a tag
    // of the same name cannot answer instead.
    const added = await run(gitBin(), [
      '-C',
      args.targetDir,
      'worktree',
      'add',
      '--detach',
      dir,
      args.branch !== null ? `refs/heads/${args.branch}` : 'HEAD',
    ]);
    if (added.code !== 0) {
      return {
        ok: false,
        reason:
          `git worktree add failed (exit ${String(added.code)}): ` +
          `${(added.stderr || added.stdout).trim() || 'it printed nothing'}. ` +
          'A repository with no commits has no HEAD to branch a worktree from, which is the ' +
          'usual cause on a brand-new project - commit once, or turn git.worktree.enabled off.',
      };
    }
  }

  if (!(await usable(dir))) {
    return {
      ok: false,
      reason:
        `${dir} is not a git working tree after ${args.command === null ? 'git worktree add' : 'the git.worktree.command script'} ` +
        'reported success, so the run has nowhere to work. Nothing has been spent.',
    };
  }
  return { ok: true, dir, how: args.command === null ? 'git' : 'command', created: true };
}

/**
 * Run the user's own setup command. Null when it succeeded.
 *
 * **Through a shell, and that is not the rule `commands.ts` enforces.** The one
 * place in this product a shell is used at all is `verify.command`, and
 * `verify.ts` states why the rule holds there: *"Model-authored text is never
 * passed to a shell."* This is the same category as `verify.command` and not the
 * same as `run_command` — it is a line a **person** wrote into their own
 * `vibe.config.json`, a file they commit, and the whole point of it is to be a
 * sequence (`git worktree add … && npm ci && npm run build`), which is what a
 * shell is for. A model cannot reach it: there is no config tool (#144 decision
 * 3) and `writeConfigPatch` is the window's own form.
 *
 * What it is told arrives as environment rather than as arguments, so a path with
 * a space in it cannot be re-split by the shell into two words.
 */
async function runSetup(
  args: { targetDir: string; id: string; timeoutMs: number; command: string | null; branch: string | null },
  dir: string,
): Promise<WorktreeResult | null> {
  const command = args.command;
  if (command === null) return null;
  const result = await runUserCommand(command, args.targetDir, {
    ...process.env,
    // The target, which the script is required to honour. vibe owns this path so
    // a resume can re-derive it; see the header.
    VIBE_WORKTREE: dir,
    VIBE_REPO: args.targetDir,
    VIBE_RUN_ID: args.id,
    // The branch `prepareGit` will use, computed by the same `runBranch` and
    // already created as a ref at `git.baseRef` or HEAD, so the script is told
    // the answer rather than asked for one - and should check it out rather than
    // choose a commit, which `prepareGit` refuses (#249). Absent when branch isolation is off: an empty string would
    // be a branch name a script could pass to git.
    ...(args.branch !== null ? { VIBE_BRANCH: args.branch } : {}),
  }, args.timeoutMs);
  if (result.code === 0) return null;
  return {
    ok: false,
    reason:
      `git.worktree.command failed (exit ${result.code === null ? 'none - it was killed' : String(result.code)}): ` +
      `${result.output.trim() || 'it printed nothing'}. ` +
      'The command runs in the repository with VIBE_WORKTREE, VIBE_REPO, VIBE_RUN_ID and ' +
      '(when branch isolation is on) VIBE_BRANCH set, ' +
      'and must leave a git working tree at VIBE_WORKTREE.',
  };
}

/**
 * Whether a run on disk was started with a worktree of its own (#246).
 *
 * Read straight off `state.json` rather than through `loadRun`, because `loadRun`
 * writes - it records repairs and ensures the ignore file - and this is asked of
 * runs that belong to some other process. **Any failure is `false`**: a run
 * whose record cannot be read cannot be shown to be working anywhere but the
 * repository itself, and that is the answer that refuses.
 */
export function storedWorktree(runDir: string): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    return typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>)['worktree'] === true;
  } catch {
    return false;
  }
}

/** What one entry under `.vibe/runs` contributes to the refusal. */
export type EntryConflict =
  /** Not a live run here, or one that cannot collide: nothing to say. */
  | null
  /** A live run, or one vibe cannot rule out, and the clause naming it. */
  | { clause: string; worktree: boolean };

/**
 * The per-entry half of `sameRepositoryRefusal`, pure so the branches no portable
 * fixture can reach - an `lstat` that throws - are tested directly, the way
 * `entryVerdict`'s own test does it.
 *
 * - A **link** is skipped and nothing is read through it (#53). vibe never
 *   makes one, so it is not a run this process could be racing.
 * - Everything else is asked of its lock, **a plain file included**: `entryVerdict`
 *   calls it `readable`, and its lock read fails with `ENOTDIR`, which
 *   `livenessOf` calls `unknown`. vibe never writes a file into `.vibe/runs`, so
 *   one there is something nobody can account for - and the settled rule is that
 *   only an absent root and a measured link are passed over.
 * - An entry `lstat` could not classify **counts, with no worktree**: it cannot
 *   be ruled out as a live run, which is `lock.ts`'s fail-closed rule.
 * - Otherwise the lock's verdict decides: `running` and `unknown` count,
 *   `interrupted` and `not-running` do not. An `unknown` names its lock file,
 *   because that is the file a person has to go and look at.
 */
export function entryConflict(
  id: string,
  dir: string,
  linkage: RunEntryLinkage,
  verdict: () => LivenessVerdict,
  worktree: () => boolean,
): EntryConflict {
  const kind = entryVerdict(linkage);
  if (kind === 'linked') return null;
  if (kind === 'unverified') {
    return { clause: `${id} (vibe could not classify this entry, so it cannot rule out a live run)`, worktree: false };
  }
  const v = verdict();
  if (v.liveness === 'running') {
    return { clause: `${id} (running, pid ${v.lock?.pid ?? 'unknown'})`, worktree: worktree() };
  }
  if (v.liveness === 'unknown') {
    return {
      clause:
        `${id} (its lock at ${lockPath(dir)} could not be read or was written on another machine, ` +
        'so vibe cannot rule out a live run)',
      worktree: worktree(),
    };
  }
  return null;
}

/**
 * Why a run may not start or resume here, or null (#246).
 *
 * The app runs one host process per run, so two runs can now be going at once -
 * and two runs working in **one checkout** would edit the same files and move
 * the same branch under each other. That is the case refused here, and only that
 * case: a live run with no worktree, or a new run that would not get one. When
 * both work in worktrees of their own nothing is shared but the archive, which
 * was always written to by one run per directory.
 *
 * It reads every other run's lock under this repository's `.vibe/runs` through
 * `livenessOf`, so a run started from a terminal is seen as well as one the app
 * started. **It fails closed**: a runs directory that exists but cannot be read
 * refuses, and so does an entry that cannot be classified. Only an absent
 * directory and an entry measured to be a link are passed over.
 *
 * Never writes and never throws. It is a refusal, never a queue - a queue would
 * leave somebody waiting with no way to know they were waiting.
 *
 * `probe` is `livenessOf`'s seam, for the reason `PidProbe` gives.
 */
export function sameRepositoryRefusal(
  targetDir: string,
  opts: { self: string | null; worktree: boolean; probe?: PidProbe },
): string | null {
  const root = path.join(targetDir, RUNS_DIR);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch (err: unknown) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return null;
    return (
      `vibe could not read ${root} (${typeof code === 'string' ? code : 'unknown error'}), so it cannot ` +
      'rule out another run working in this repository. Nothing was created.'
    );
  }
  const probe = opts.probe ?? probePid;
  const clauses: string[] = [];
  for (const id of entries.sort()) {
    if (id === opts.self) continue;
    const dir = path.join(root, id);
    const found = entryConflict(
      id,
      dir,
      runEntryLinkage(root, id),
      () => livenessOf(dir, undefined, probe),
      () => storedWorktree(dir),
    );
    if (found === null) continue;
    if (!found.worktree || !opts.worktree) clauses.push(found.clause);
  }
  if (clauses.length === 0) return null;
  return (
    `Another run is working in this repository: ${clauses.join('; ')}. Two runs working in one ` +
    'checkout would edit the same files and branch at once. Wait for it to finish or stop it, or set ' +
    'git.worktree to true so each run works in a checkout of its own. Nothing was created.'
  );
}
