# AGENTS.md

Working notes for anyone — human or agent — making changes in this repo. `README.md` is for
people *using* `vibe`; this file is for people *changing* it.

## What this is

A TypeScript CLI that automates the plan → critique → implement → review loop between the
Claude Code CLI and the Codex CLI. It installs neither; it shells out to both and inherits
whatever you are already logged into. There is no server, no daemon and no network code of
its own — every external call is a child process.

## Commands

```bash
npm install
npm run build       # tsc && tsc-alias — emits to dist/
npm run typecheck   # tsc --noEmit, no emit, fastest correctness check
npm test            # builds first (pretest), then node --test dist/tests/**/*.test.js
npm run doctor      # builds, then runs `vibe doctor` against this repo
npm run watch       # tsc --watch
```

**`npm test` runs the compiled output, not the sources.** `pretest` builds, so a stale `dist/`
is never what you tested — but if you invoke `node --test` directly, build first or you are
testing the last change rather than this one.

There is **no linter and no formatter**, and no CI. `npm run typecheck && npm test` before
every commit is the whole gate, and it is on you to run it. Node 20+ (`engines`).

## Repo map

```
src/main.ts          bin entry point — the thing package.json points at
src/cli.ts           argument parsing, the five commands, run summary
src/orchestrator.ts  the loop: planPhase, reviewPhase, the guards, the prompt dispatch
src/run.ts           run state, artifacts, convergence maths (assessConvergence et al)
src/roles.ts         who does what: the role table, refusals, warnings
src/config.ts        DEFAULTS, config merge, validation
src/consistency.ts   cross-field rules over status/phase/planOnly (groundwork, not yet wired)
src/types.ts         shared types, including RunState
src/prompts.ts       every prompt the agents receive
src/claude.ts        Claude Code adapter (stream-json)
src/codex.ts         Codex adapter (codex exec --json)
src/appserver.ts     Codex app-server JSON-RPC client (rate limits only)
src/ratelimits.ts    rate-limit windows and the brake
src/charge.ts        the one seam every token and dollar is charged through
src/slots.ts         session-slot lifecycle (main = Claude, judge + review = Codex)
src/context.ts       context measurement, compaction, session rotation
src/preflight.ts     toolchain contract enforcement, `vibe doctor`
src/verify.ts        the verification gates — resolves the list, runs each command
src/progress.ts      in-turn heartbeat
src/schemas.ts       the JSON schemas both CLIs are pinned to
src/validate.ts      parser vocabulary for model output
src/proc.ts          child-process plumbing
src/git.ts           branch and commit operations
tests/               node:test, one file per concern
```

`src/orchestrator.ts` is the biggest file by a wide margin and is where most changes land.
Read the phase you are touching end to end before editing it; the guards interact.

## Code style

These are enforced by `tsconfig.json` (`strict`, plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals`,
`verbatimModuleSyntax`) and are not negotiable:

- **No `any` in `src/`.** Use `unknown` and narrow. `src/validate.ts` has the vocabulary.
- **Internal imports go through `@src/*`**, rewritten to relative paths at build time by
  `tsc-alias`. No `../../` chains anywhere.
- **`import type` for type-only imports** — `verbatimModuleSyntax` requires it.
- **Explicit `.js` extensions** on relative/aliased imports (NodeNext ESM).

Beyond the compiler:

- **Never invent a number.** This is the repo's one recurring rule. An unknown context window
  stays `null` rather than being guessed from a model name; Codex cost is reported as absent
  rather than derived from a price table; a missing progress field is omitted rather than
  filled in. Partial information beats a convincing fabrication, and most of the design notes
  in `README.md` exist to explain a place this rule was applied.
- **Comments explain *why*, and cite the run that taught it.** The defaults in
  `src/config.ts` are the model: each non-obvious number says what was measured to pick it.
  Do not strip these; they are the institutional memory.
- **Fail closed.** A measurement that cannot be attributed is not recorded. A guard that
  cannot read its input treats it as absent, not as zero.

## Tests

`node:test` with `node:assert/strict`. One file per concern, named for the concern rather
than the module (`convergence.test.ts`, `failure-accounting.test.ts`,
`preflight-enforcement.test.ts`).

- **Add tests; do not edit existing ones.** A change that needs an existing test rewritten is
  a behaviour change, and it needs saying out loud in the PR rather than absorbing quietly.
- **No wall-clock fixtures.** A test that hardcodes an epoch timestamp passes until it
  doesn't — one in `ratelimits-monitor.test.ts` went off in August 2026 and made `develop`
  look broken. Compute times relative to now.
- **No network, no real agent invocations.** `tests/helpers/fake-transport.ts` and
  `tests/helpers/stub-server.ts` are the injection points.

The phase loop **is** drivable from a test: `tests/helpers/loop-harness.ts` runs `orchestrate`
end to end with injected agents that record every turn's label in order, a run state in a
temp directory, a real `git` repo it can commit to, and a `verify.command` the case controls
— so the verification gate, the carried-P1 final round, the per-round commits and the
question/escalation/resume path are all reachable. `full-loop.test.ts`,
`verification-gate.test.ts`, `final-fix-round.test.ts`, `question-escalation.test.ts` and
`pending-findings.test.ts` are the callers; start from whichever is closest to the phase you
are changing. Git and verification are deliberately real, not seams — see the harness header
for why. Anything it still cannot reach (a rate-limit wait, a session rotation) gets a
throwaway script against `dist/`, with the results in the PR body.

## Branches, commits and pull requests

**`main` is the default branch and only ever receives release merges. `develop` is where
work integrates.** Branch off `develop`, PR back into `develop`.

```
feat/<issue>-<slug>     new capability          feat/22-deferred-only-rounds
fix/<issue>-<slug>      defect                  fix/23-validate-stored-state
docs/<slug>             documentation only      docs/agents-and-readme
release/<version>       release into main       release/1.2.0
vibe/<run-id>           created by vibe itself  vibe/20260820-002345-implement-…
```

**Never stack a PR on another feature branch.** It was tried once: PR #35 was based on
`feat/role-table`, its parent merged into `develop` three hours before it did, and the fix
landed on a branch nobody was running from — `develop` stayed broken and the work had to be
cherry-picked onto #36. If the work genuinely depends on unmerged work, wait, or target
`develop` and rebase.

### Closing issues automatically

**GitHub only auto-closes on a merge into the *default* branch, which here is `main`.** A PR
into `develop` with `Closes #12` in its body closes nothing, ever. So:

- **Per-issue PRs (into `develop`) use `Refs #12`.** It cross-links without making a promise
  the merge cannot keep.
- **The release PR (into `main`) does the closing**, and lists every issue the release
  contains.

**Repeat the keyword before every number.** GitHub parses `Closes #1, #2, #3` as closing
`#1` and nothing else — the release of 1.1.0 named sixteen issues and closed zero, and all
nine outstanding ones had to be closed by hand afterwards.

```markdown
Closes #2, closes #16, closes #18, closes #20, closes #27
```

Commit messages: imperative mood, describing the behaviour change rather than the edit —
"Charge what failed turns spend, and enforce before retrying", not "update charge.ts".
Commits written by `vibe` itself are titled `vibe: implement approved plan`.

## Working in `.worktrees/`

This repo is developed on itself. Each issue gets a git worktree under `.worktrees/`, and
`vibe` is run inside it — so the tool changing the code is a *published* build, not the
working tree it is editing.

```bash
git worktree add .worktrees/issue-22 -b feat/22-deferred-only-rounds develop
cd .worktrees/issue-22 && npm install && npm run build
vibe run "$(cat ../../brief.md)" -C .
```

`.worktrees/` is in `.gitignore` — worktrees live inside the repo and must never be tracked
by it. So is `.vibe/`, which is where each run's artifacts land inside the worktree:
`PLAN.md`, every plan revision and critique, `FOLLOW-UPS.md`, `state.json`, `transcript.log`.
**Those artifacts are the record of why a change is shaped the way it is** — read
`FOLLOW-UPS.md` from a related run before proposing work, because it usually already says
whether the idea was considered and declined, and why.

A few things learned the expensive way:

- **Write the brief to a file and pass it in full.** The runs that converged had briefs that
  stated the decisions already made and said "do not re-derive them". The runs that stalled
  had briefs that left the design open.
- **A stall is not a failure.** Exit code 2 writes `NEEDS-INPUT.md`; answer inline under
  **Your answer:** (a `### ` heading and `> ` blockquote lines — the parser needs both) and
  `vibe resume <run-id>`, usually with a raised `--max-tokens`.
- **The run commits to `vibe/<run-id>`, not to your branch.** Point the branch at the run's
  final commit before opening the PR: `git branch -f feat/22-… <sha>`.
- **Archive the run record before pruning the worktree.** `git worktree remove` takes `.vibe/`
  with it, and since #52 the planner reads `.vibe/runs/` in the repo it is run against — so a
  pruned worktree destroys the record the next run would have read. `vibe` only ever creates
  `.vibe/` under the directory it ran in (`createRun`), which is the worktree, so the main
  checkout's copy has to be made:

  ```bash
  # from the main checkout
  mkdir -p .vibe/runs
  [ -f .vibe/.gitignore ] || printf '*\n' > .vibe/.gitignore   # never overwrite an existing one
  cp -r .worktrees/issue-52/.vibe/runs/<run-id> .vibe/runs/
  git worktree remove .worktrees/issue-52
  ```

  Seed a new worktree from the archive when the past matters:

  ```bash
  mkdir -p .worktrees/issue-N/.vibe/runs
  [ -f .worktrees/issue-N/.vibe/.gitignore ] || printf '*\n' > .worktrees/issue-N/.vibe/.gitignore
  cp -r .vibe/runs/. .worktrees/issue-N/.vibe/runs/
  ```

  The `.vibe/.gitignore` containing `*` is what `ensureVibeIgnored` writes, and it is why the
  archive is self-ignoring wherever it sits — this repo's `.gitignore` also lists `.vibe/`, but
  a copy made by hand cannot rely on that in someone else's checkout. The archive survives
  because the main checkout is long-lived, not because it is tracked. The seven runs up to #50
  were preserved this way by hand. There is no command for this and there is not meant to be:
  for an ordinary user `.vibe/runs/` already persists in their repo across runs.
- **What the past-run index reaches.** The planner is the only role *given* the index, but
  Claude has one conversation — the implementer resumes `main` and inherits the planner's
  history, that section included, exactly as it already inherits the plan prompt. The
  Codex-seated roles (critic, answerer, reviewer) never see it.
- **Prune when done**, after archiving the run above:
  `git worktree remove .worktrees/issue-22`.

## Releases

1. Branch `release/<version>` off `develop`.
2. Bump `version` in `package.json`. Semver as stated in `CHANGELOG.md`: minor for new
   capability, patch for fixes, major only for a change that breaks an existing config or an
   existing run.
3. Add the `CHANGELOG.md` section — grouped Added / Fixed / Internal / Upgrading, every entry
   linking its PR and issue.
4. PR into `main`, with the `closes` keyword repeated per issue (see above).
5. Verify from a clean checkout: `npm run typecheck`, `npm test`, `npm pack --dry-run`.
6. Merge, then tag: `git tag -a v<version> -m "..." && git push origin v<version>`.
7. `npm publish`. **This needs a real interactive terminal** — the OTP flow hands off to a
   browser and cannot be driven from a headless shell. A granular automation token in
   `.npmrc` avoids the prompt.
8. **Merge `main` back into `develop`.** The release PR is squash-merged, so the version bump
   and the changelog exist only on `main` until you do. After 1.1.0 this was missed and
   `develop` sat at version 1.0.1 with no `CHANGELOG.md` — which is the branch the next
   release would have been cut from.

Anything added to the published package must be listed in `files` in `package.json`;
`CHANGELOG.md` was nearly shipped missing for exactly this reason.

## Settled decisions — do not re-litigate

Each of these was argued once, at length, and the reasoning is recorded. Reopening them
needs new evidence, not a fresh opinion.

- **Codex cost is not reported and will not be estimated.** No output mode returns one, and
  no app-server endpoint returns money. `budget.maxTokens` is the ceiling that covers both
  agents. See "Notes and limitations" in `README.md`.
- **The Codex context window is a setting, not a derivation.** `modelContextWindow` exists
  only on an app-server push notification, and `vibe` drives Codex as a plain child process.
- **A persisted Codex thread cannot hold a writing role.** `codex exec resume` takes no `-s`
  flag, so the sandbox silently reverts after the first turn. The config is refused, not
  repaired.
- **`/compact` does not work headless.** It is a CLI command, not a model instruction.
  Compaction is explicit session rotation with a handoff briefing.
- **Prompts go over stdin, never argv.** Claude's variadic flags swallow positional
  arguments.
- **Groundwork ships separately, with no behaviour change.** The role table took four
  preparatory PRs (#15, #17, #28, #31), each landing with the table still hardcoded so that
  nothing about a default run changed until the last step. It is the pattern that works here;
  use it for anything touching the loop.
