# How a run's branch gets its name (#356)

Status: design only, for agreement before any brief. No code changes with this note.

The owner chose option 5 on the issue: the planner proposes a name and vibe renames the branch at
plan approval. The owner also asked whether the project's agent instructions should carry the
convention instead. This note answers that question, says what a rename touches, and proposes a
PR sequence that follows "groundwork ships separately, with no behaviour change".

## 1. What the name is today, and who reads it

The name is one expression. `runBranch` in `src/git.ts` returns `state.branch`, or
`git.branchPrefix + state.id` for a fresh run, or null when `git.useBranch` is off.
`git.branchPrefix` defaults to `vibe/` (`src/config.ts`). One site spells it out by hand:
`commitFork` in `src/fork.ts` builds `${cfg.git.branchPrefix}${claimed.id}`.

These places read or write it:

- **Preflight** (`src/cli.ts`, the worktree block after `git.baseRef` is resolved). With
  `git.worktree` on, it creates the branch as a ref before the setup script runs and passes the
  name to the script as `VIBE_BRANCH`.
- **`prepareGit`** (`src/orchestrator.ts`). It runs before the plan phase, on every pass. On a
  fresh run it adopts the pre-made ref or runs `checkout -b`, then writes `state.branch` and
  `state.start` in one save. On a resume it refuses when another branch is checked out, warns
  when the recorded branch no longer exists, and checks out a fork's branch while
  `branchPending` is set.
- **`run_branch` narration** (`sayBranch`). This is narration only, with no recorded event. The
  window's reducer (`app/src/cockpit/model.ts`) replaces `run.branch` on every `run_branch` it
  receives, and the loop column shows it (`LoopColumn.tsx`). `src/replay.ts` rebuilds one
  `run_branch` from the final `state.branch`, stamped at `createdAt`.
- **The stranded-stash notice** (`noticeStrandedWork`, `namesBranch` in `src/git.ts`). It
  matches stash subjects against the branch name, and it accepts the leaf alone on the
  argument that "`git.branchPrefix` supplies the only `/`, so the leaf IS the run id".
- **Forks** (`src/fork.ts`). A fork creates `branchPrefix + <fork-id>` at the checkpoint
  commit, refuses if that name exists, and sets `branchPending`.
- **The summary and `vibe fork` output** (`src/cli.ts`, the `Branch:` lines).
- **Not the worktree path.** `worktreePath(targetDir, id)` is `.worktrees/<run-id>`, derived
  from the id, so a rename leaves the directory alone.
- **People.** AGENTS.md tells the owner to run `git branch -f feat/22-… <sha>` before opening a
  PR. Archived briefs say the same thing (the #341 and #354 runs' FOLLOW-UPS: "do not create,
  rename or check out any other branch … The owner points `feat/341-pairing` at the run's
  final commit"). No archived FOLLOW-UPS proposes or declines automatic naming.

## 2. The options

**(a) Keep `vibe/<run-id>`.** It costs nothing, and the hand step in AGENTS.md stays. The run's
own record then names a branch the PR does not use, which is the complaint in the issue.

**(b) The planner proposes, vibe validates and renames.** The plan schema gains a nullable
`branch` string. When the plan is approved, vibe checks the name and runs `git branch -m`.
Each case below has to have an answer:

- *An existing worktree.* `git branch -m` on a branch checked out in a linked worktree moves
  that worktree's HEAD with it. I checked this with git 2.55.0 in a scratch repository. The
  directory keeps its run-id name. The repo has documented git 2.31.1 elsewhere, so a test has
  to pin this behaviour rather than rely on it.
- *The window.* A second `run_branch` with the new name is enough, because the reducer
  replaces the field.
- *A resumed run.* `state.branch` holds the new name and `prepareGit` reads it. The danger is a
  process killed between `git branch -m` and `saveState`. In that case `state.branch` names a
  branch that has gone, and `prepareGit` would print "continuing on HEAD", which means
  committing to the wrong branch. So the rename needs a durable intent written before it
  (`state.branchRename = { from, to }`). A resume settles it by looking at which of the two
  refs exists.
- *A plan-only run.* It never reaches implementation. Doing the rename on the first pass into
  `implementing`, not inside the approval step, covers both paths: an ordinary run, and
  `vibe resume <id> --implement` on a plan-only run.
- *A forked run.* The fork already has a branch of its own, and the parent may already hold
  the proposed name. Forks never rename. They keep `vibe/<fork-id>` and say so.
- *A plan revised after approval.* No code path moves a run from `implementing` back to
  `planning`. `runPhases` only ever calls `advancePhase` forward, to `implementing`,
  `reviewing` and `complete`. A
  re-plan only happens in a fork from a pre-approval checkpoint, which is a different run with
  a different branch. So the name is settled once per run.
- *The worktree script.* It was given `VIBE_BRANCH` under the old name, because it ran before
  any plan existed. The worktree follows the rename. A script that copied the name somewhere
  else will be stale.
- *Stashes.* A stash made before the rename records the old name. After the rename the leaf is
  no longer the run id (`fix/356-x` has the leaf `356-x`, and `feat/team/x` has two slashes).
  The notice should match both names during the rename's lifetime, and the comment on
  `namesBranch` should be corrected.

**(c) Project instructions carry the convention.** On their own they cannot work, because
`prepareGit` creates the branch before any agent turn. They can, however, be the input to (b).
The planner's turn already sees the project's conventions: the planner runs with its working
directory in the checkout, so it reads this repo's AGENTS.md/CLAUDE.md as any turn does, and
`instructions.text` (#273) is put in front of every prompt by `withStanding`. So (c) is not a
replacement for (b). It is how a project tells (b) what to propose. The proposal is still
model-authored text, and it is still validated before vibe acts on it.

**(d) A template, e.g. `git.branchName: "{kind}/{issue}-{slug}"`.** vibe has neither the kind
nor the issue as a fact. Someone has to supply them, and that someone is the planner, so (d)
becomes (b) with structured fields. That gains one thing: vibe can check `issue` on its own.
It costs another schema shape and a template language. It is worth having only if the
free-form name turns out to drift, and nothing has measured drift yet.

## 3. Failure modes, and the fail-closed rule

**A proposal that does not pass keeps `vibe/<run-id>`.** vibe says why on the same line as the
`run_branch` that follows. The run is never refused over its name: the branch is only a label,
and the work is safe under either name. A rename is attempted only after every check below
passes:

- **Absent or blank.** No rename, and no sentence about it.
- **Not a valid ref.** `git check-ref-format --branch <name>` fails (spaces, `..`, a trailing
  `.lock`, and so on).
- **Taken.** A local branch, or a remote-tracking ref `refs/remotes/*/<name>`. Only what is
  already fetched is checked, with no new network call. The check is also case-insensitive,
  because loose refs on macOS and Windows collide when two names differ only in case.
- **Blocked by a directory/file conflict.** A branch `fix` makes `fix/…` impossible, and
  check-ref-format does not catch it. vibe treats a failed `git branch -m` as a refusal and
  keeps the default name.
- **An issue number nobody gave.** vibe never invents an issue number. If the name contains a
  number the task text and `extraContext` do not contain, as `#N` or as a `/issues/N` link, the
  whole name is refused. vibe does not remove the number and keep the rest, because a name with
  the number taken out is still a name the planner invented.
- **A prefix outside the project's list**, if the owner wants one (question 6 below).
- **The branch already holds commits past `state.start`.** This cannot happen on the ordinary
  path. If it does, something unexpected is going on, and the branch is left as it is.

## 4. Recommendation

**Ship (b), with (c) as its input. Defer (d). Off by default.**

- The planner's convention comes from where the project already writes it. In this repo that
  is AGENTS.md. A project without such a file can use `instructions.text`. vibe gains no
  template language and no second place to state a convention.
- vibe validates and renames, but it never invents. Every failure keeps a name that already
  works.
- The rename happens at the start of `implementing`, behind a durable intent, so a kill at any
  instant resumes on a branch that exists.
- `--branch <name>` (option 4 on the issue) is the explicit override. It goes through the same
  validator in preflight, before anything is spent, and when it is passed the planner is not
  asked.
- The schema field is present only when the setting is on, so a default run's plan turn is
  unchanged byte for byte. The field is `["string", "null"]` and listed in `required`, because
  Codex's strict schemas reject a `required` that does not cover every property (#68), and
  `roles.ts` allows the planner seat to change.

## 5. Questions only the owner can answer

1. **Is the proposed name shown on the plan-approved gate, and can a person edit it there?**
   Recommended: show it, read-only, in the first ship. The gate defaults to `step`
   (`src/gates.ts`), so it is seen. Editing it means a new kind of gate answer, which belongs in
   a later PR.
2. **Is there a template fallback when the planner proposes nothing?** Recommended: no. The
   fallback is `vibe/<run-id>`. A template needs facts vibe does not have.
3. **`--branch <name>`: does it win, and does it ship first?** Recommended: yes on both. It is
   small, it can be tested without a model, and the pilot's `start_run` can pass it later.
4. **Is a stale `VIBE_BRANCH` acceptable?** Recommended: yes, as long as it is documented in
   `run-worktrees.md`. The script's job is to check the branch out, and git carries that across
   a rename.
5. **On by default once shipped?** Recommended: off for one release and on in this repo's own
   `vibe.config.json`. Then decide from the runs that used it.
6. **Must the name start with one of a configured list of kinds (`feat/`, `fix/`, `docs/`)?**
   Recommended: an optional `git.branchKinds`, null by default, meaning any valid name. This
   repo would set `["feat/", "fix/", "docs/"]`.
7. **Is an issue number that appears in the task text enough proof?** Recommended: yes, from
   `task` or `extraContext` only. Never from the planner's reading of the repository.

## 6. How it ships

Each PR is green on `npm run typecheck && npm test`. The first three change nothing about a
default run.

1. **Groundwork: the rename primitive.** `git.renameBranch`, the `branchRename` intent in state
   with validation in `stored.ts`, resume reconciliation in `prepareGit`, and the stash notice
   matching both names. Nothing calls the rename yet. Tests cover a kill before and after
   `git branch -m`, and a rename inside a linked worktree.
2. **Groundwork: the validator.** `checkBranchName` covers every check in section 3. It is pure
   apart from git reads, it is tested, and nothing calls it yet.
3. **`--branch <name>`.** It is validated in preflight and refuses by name, since a person
   asked for exactly that name. It goes through `runBranch`, so `VIBE_BRANCH` and `run_branch`
   agree. `docs/cli.md` is updated in the same PR. Behaviour changes only when the flag is
   passed.
4. **The planner's proposal.** `git.branchFromPlan` (default false), the conditional schema
   field, the rename on the first pass into `implementing`, and the second `run_branch`. Also
   `docs/configuration.md`, `run-worktrees.md`, and the AGENTS.md PR workflow line, which
   becomes "point the branch only if the rename was refused".
5. **The gate card shows the name, and this repo turns the setting on.** The app's gate gets
   one line, and the app's gate checks run.
