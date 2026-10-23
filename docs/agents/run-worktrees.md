# A run in a worktree of its own

Part of the working notes for this repo; [AGENTS.md](../../AGENTS.md) is the core and links here.
Moved out of AGENTS.md word for word on 2026-10-20, so where a note says *this file* it means
AGENTS.md and these companions together. Read this before changing the code it describes, and
update it in the same PR when that code changes.

**A run can work in a worktree of its own, and the archive deliberately stays at home** (#223).
Working in `.worktrees/<issue>` is a thing this file has told a *human* to do since the repo was
developed on itself — so the tool changing the code is a published build rather than the tree it
is editing — and doing it by hand is four commands plus a cleanup nobody remembers. Asked for as
*"the pilot should automatically start a worktree for the vibe session to run in"*, with a toggle
and a custom script.

**The whole feature is one distinction**, and `src/worktree.ts` holds it:

- **`state.targetDir` is the run's home.** The archive, the lock and the planner's past-run index
  all live there, and none of them move.
- **`workDirOf(state)` is where the work happens** — every git operation, the verification gate,
  and the cwd of every agent child.

They are the same directory unless the run has a worktree, which is what makes this inert when it
is off. In the loop it costs **one line**: `runPhases` resolves `cwd` once and threads it to
ninety-odd call sites, and that comment — *"resolved once and threaded"* — is why redirecting a
run into another tree is a one-line change rather than an audit.

**Putting the archive in the worktree was the obvious shape and is the wrong one.** It was
offered and declined: a run's record would land in a tree somebody is about to prune, and this
file carries a hand-written `cp -r` recipe for exactly that loss because `git worktree remove`
takes `.vibe/` with it. Worse, the next run's planner reads `.vibe/runs` in the tree it is given,
so every auto-worktree run would start blind to a history it had itself produced — #52 going
quietly dead. Keeping the archive at home costs one indirection and deletes the whole class.

Five things are load-bearing:

- **A decision is stored; the path is derived.** `state.worktree` is a boolean and the location
  comes back out of `worktreePath(targetDir, id)`, for the reason `loadRun` re-derives `dir` and
  `targetDir`: a repository legitimately moves, and a stored absolute path is the thing that
  breaks when it does. What cannot be re-derived is whether the run *started* with the setting
  on, since it may have been toggled since — so that is what is kept, in the **first** state
  write, because `allocateRun` requires it: a run that came back believing it had no worktree
  would work in the repository while its branch is checked out elsewhere.
- **It is created detached, and `prepareGit` still names the branch.** `git worktree add -b`
  here would be a second answer to a question seven call sites and `run_branch` already settle,
  and the two would disagree the first time somebody set `git.branchPrefix` or passed
  `--no-branch`. This decides *where*; that decides *which branch*, inside it.

  **The name can come from `--branch`, and then an existing branch is refused** (#356). The
  pilot proposes a name on its `start_run` card; `cmdRun` checks it with `git check-ref-format
  --branch`, records it as `state.requestedBranch` in the first state write, and `runBranch`
  reads it after `state.branch` and before `branchPrefix + id` - so `VIBE_BRANCH`, the branch
  `prepareGit` makes and `run_branch` are still one answer. It is a separate field because
  `state.branch` stays null until the run is on its branch, and three sites read that null as
  *fresh*. Adopting an existing branch was safe only because a run id is unique; a chosen name is
  not, so on a fresh run a name that is already a branch - including one checked out in another
  worktree - is refused by name, in `cmdRun` before anything is allocated and again in the
  preflight gate before the worktree's ref is made. A resume still adopts its own branch.

  **The script is told the branch, and it is still one answer** (#223). It was given
  `VIBE_WORKTREE`, `VIBE_REPO` and `VIBE_RUN_ID` and deliberately no branch, and that left a
  project's own script unable to do the obvious thing — *"we need to be able to have a
  placeholder for the directory path and branch name"*. So `runBranch` in `src/git.ts` is the
  one expression for the run's branch, the worktree site creates it as a **ref** from HEAD
  before the script runs and passes it as `VIBE_BRANCH`, and `prepareGit`'s fresh path
  **adopts** a branch that already exists instead of `checkout -b`-ing it again. Creating the
  ref first is what makes one line of script right on a fresh run and a resume alike: `git
  worktree add "$VIBE_WORKTREE" "$VIBE_BRANCH"`. With branch isolation off the variable is
  **unset**, not empty, because an empty string is a name a script could hand to git; a
  repository with no commit has no HEAD to put the ref at, so it is unset there too and
  `prepareGit` makes the branch as it always has. They are environment variables rather than
  `{dir}`-style text substitution because a path pasted into a shell line breaks on a space,
  and a quoted variable does not.

  **A run starts from the base it was told, and a worktree is never moved silently** (#249).
  The #169 run started from the root checkout's stale `fix/223` tip instead of
  `origin/develop`: its script detached at the commit it wanted, and `prepareGit` checked the
  branch — made at HEAD — out over it without a word. Four decisions, all the owner's:

  - **A base is a setting.** `git.baseRef` (project-only, default null) is resolved **once**,
    in the preflight gate, on a fresh run only, before anything is spent. A remote-tracking ref
    is fetched first. **A fetch that fails or outlives `git.worktreeTimeoutMs` refuses the run
    — there is no fallback to the local tracking ref**, because a possibly stale base is the
    defect. The bound is the existing setup budget rather than a new number, and it is needed
    at all because a `git fetch` hung for over 120s on the owner's machine and a `git` child is
    never interruptible under `cancel.ts`. `--no-branch` with a base, an unresolvable ref, and
    a dirty repository with no worktree whose base is not HEAD are each refused by name. **Null
    is today's behaviour**: the branch at HEAD. A resume never resolves, fetches or moves
    anything, and a fork's branch comes from its checkpoint.
  - **Refuse, never move.** When `prepareGit` adopts a pre-made branch it compares the
    worktree's HEAD with the branch's commit: equal is the default path and the checkout moves
    nothing; different is an `Escalation` naming both shas. This holds with `baseRef` unset,
    and it is the one behaviour change when it is: a script should check `$VIBE_BRANCH` out,
    not choose a commit. The default `git worktree add --detach` now detaches at the branch's
    commit rather than HEAD, so it passes.
  - **One creation site per path, and nothing durable in preflight.** With a worktree the ref
    is made in preflight (the script must be told it); with none, `prepareGit` makes the branch
    with `checkout -b <branch> <sha>`. The sha travels from the gate to `prepareGit` through a
    run-id-keyed module latch (`chooseBase`), not a state field and not a second read of the
    ref — a fetch in between would otherwise start the branch at a commit the dirty check never
    saw, and a stored base would outlive a run stopped before it took its branch.
  - **The start is recorded.** `state.start = { sha, ref }` (ref null for HEAD) is written by
    `prepareGit` in the **same save** as `state.branch`, so neither is on disk without the
    other; `run_branch` carries `startSha`/`startRef` on that path only, the sentence says
    `from origin/develop (a7b5f9b)`, and the summary prints a `Start:` line when the field
    exists. Absent on older runs and never back-filled; a fork drops its parent's.
- **The script goes through a shell, and that is `verify.command`'s rule rather than a hole in
  `commands.ts`'s.** `verify.ts` states it at the one place a shell is used at all — *"Model-
  authored text is never passed to a shell"* — and this is the same category: a line a **person**
  wrote into a file they commit, whose whole purpose is to be a sequence, because a worktree
  nobody installed into cannot run the gate. `runUserCommand` is **exported and shared** rather
  than copied, so "a shell is used in exactly one place" stays true and the hard-won Windows
  branch — `cmd.exe /d /c` with `windowsVerbatimArguments`, because `shell: true` adds a layer of
  quoting that mangles an already-quoted argument — is not written twice. No model can reach the
  key: there is no config tool (#144 decision 3).
- **A script that reports success is checked anyway.** `createWorktree` asks git whether there is
  a working tree at the path afterwards, because a script that exits 0 and leaves nothing would
  otherwise hand the loop a directory that is not a checkout, and every git command after it
  would fail one at a time with nothing naming the cause. It refuses before the first turn, where
  a refusal costs a sentence — the same bargain `gitPrecondition` strikes four lines below it,
  and for the reason #71 records: that run spent 30M tokens before the review phase discovered
  its own directory could not host it.
- **Creation lives in the preflight gate, which is the one site a resume also passes.** So a run
  whose worktree was pruned between sessions gets it back, and `createWorktree` is idempotent by
  asking whether the tree is usable rather than whether the directory exists — a half-made one is
  what a killed creation leaves, and reusing that would put the run somewhere git does not know
  about.

**Off by default, and that is not timidity.** A bare `git worktree add` produces a checkout with
no dependencies installed, so on most projects the verification gate cannot run in it — turning
it on without `git.worktreeCommand` would break runs that work today. The feature is only useful
*with* its setup command, so the default cannot be on; this file states the general rule as
*"groundwork ships separately, with no behaviour change"*, and the proof it was followed is that
the threading landed with 1870 tests green and `worktree` never set.

**What it costs is disk, and nothing here reclaims it.** This file already measures a worktree
that has built the app at gigabytes, and auto-creating one per run makes that faster rather than
different. Nothing deletes them and nothing pretends to — the directory is named after the run so
the ones worth pruning can be told apart, and the section on the settings screen says so in the
same words rather than leaving somebody to find out.

**`.worktrees/` is self-ignoring wherever it sits.** `ensureWorktreesIgnored` is
`ensureVibeIgnored`'s shape and its reason: this repo's own `.gitignore` lists `.worktrees/`, but
a directory vibe creates in **somebody else's** checkout cannot rely on that, and a tree full of
untracked worktrees is a `git status` nobody can read. It never overwrites an existing file.

**And `workDir` reaches the window, because the pilot reads a directory.** `run_started` carries
it beside `repo`, which is this file's own rule about a fact the run holds and never says: with a
worktree the loop writes in a subdirectory and the repository root still holds whatever was there
before, so a pilot pointed at the root would describe a tree the run is not touching and report
that nothing is changing while a great deal is. The root is its permission boundary and the
worktree is inside it, so `--restricted` already allowed the read — what was missing was any
reason to look. The prompt says it **only when the two differ**, since a sentence about working in
the repository would be noise on every run that has no worktree, which is all of them by default.
