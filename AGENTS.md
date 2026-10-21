# AGENTS.md

Working notes for anyone — human or agent — making changes in this repo. `README.md` is for
people *using* `vibe`; this file is for people *changing* it.

## What this is

A TypeScript CLI that automates the plan → critique → implement → review loop between the
Claude Code CLI and the Codex CLI. It installs neither; it shells out to both and inherits
whatever you are already logged into. There is no server, no daemon and no network code in
the core — every external call `src/` makes is a child process. The desktop app has two
network clients of its own, both in Rust under `app/`: the pilot's vendor adapters and the
updater (#299).

## Commands

```bash
npm install
npm run build       # tsc && tsc-alias — emits to dist/
npm run typecheck   # tsc --noEmit, no emit, fastest correctness check
npm test            # builds first (pretest), then scripts/test.mjs runs node --test dist/tests/**/*.test.js
npm run doctor      # builds, then runs `vibe doctor` against this repo
npm run watch       # tsc --watch
```

**`npm test` runs with the global settings layer switched off.** `scripts/test.mjs` sets
`VIBE_GLOBAL_CONFIG` empty before it starts `node --test`, because `loadConfig` reads
`~/.config/vibe/config.json` under every project and a suite that read the developer's own file
would pass or fail by machine. A case about the global layer points the variable at a file of
its own and puts it back (`global-config.test.ts`). Running `node --test` directly skips this.

**`npm test` also owns where the suite's temporary files go, and removes them** (#234). The
suite makes about 1,600 temporary directories a run, 411 of them git repositories, and for a
long time removed none: on the Linux dev machine's tmpfs that used up a million inodes in about
thirty runs, and the next run failed 673 tests with `ENOSPC`, which looks like a broken suite
rather than a full disk. The fix is where a directory comes from, not 225 `mkdtempSync` sites
each remembering `rmSync`: `scripts/test.mjs` points `TMPDIR`, `TMP` and `TEMP` at one
`vibe-test-run-*` root, so `os.tmpdir()` answers that root in every test file and every child,
and the root is removed when the run ends. Three rules travel with it, pinned by
`test-sandbox.test.ts`:

- **`GIT_TEMPLATE_DIR` is an empty directory**, so a fixture repository holds 9 entries
  rather than 27. The sample hooks were two-thirds of what a test repository cost, and no test
  runs one. A run fell from about 30,000 inodes and 174 MB to about 22,800 and 148 MB; most of
  what is left is the deliberately large states in `fork-kill` and the chat-store cases.
- **Ctrl-C, SIGTERM and a closed terminal still remove the root**; the script waits for the runner and then cleans up. **A SIGKILL or a crash is swept by the next run**: each root holds the pid that made it,
  and a root whose pid has gone is removed at the start of the next run.
- **Anything that appears in the real temp directory fails the run, by name.** That is a test
  writing to a hard-coded `/tmp` or spawning a child with a hand-built environment, and it would
  otherwise bring the leak back silently. Put a new fixture under `os.tmpdir()` and it is
  covered without any cleanup of its own; `VIBE_KEEP_TEST_TMP=1` keeps the root and prints it.

**`npm test` runs the compiled output, not the sources.** `pretest` builds, so a stale `dist/`
is never what you tested — but if you invoke `node --test` directly, build first or you are
testing the last change rather than this one.

**`npm test` fails until the agent CLIs' fixtures are recorded** (#298).
`cli-fixtures-contract.test.ts` feeds a real turn of each CLI, recorded under
`tests/fixtures/cli/<cli>-<version>/`, through the real parsers, and a missing fixture for a
version in `TESTED_CLI_VERSIONS` fails by name. Recording spawns real agents, so it is done by
hand and never by the suite:

```bash
node scripts/record-cli-fixtures.mjs           # writes tests/fixtures/cli/claude-<v>/ and codex-<v>/
node scripts/record-cli-fixtures.mjs --force   # re-record a version that already has one
```

`VIBE_CLI_FIXTURES=pending` skips those tests, and says so; it exists for the run that
introduced them, which could not record fixtures from inside a sandboxed turn. There is no
other way past the check.

There is **no linter and no formatter**. There are four workflows. `pages.yml` deploys the
docs site from `main`. `ci.yml` runs on every push and pull request into `main`, and by hand
(`workflow_dispatch`): the core gate (`npm run typecheck && npm test`), the app gate
(typecheck, vitest, `audit:contrast`) and the Rust tests, all on Ubuntu 22.04 with Node 22.
`mobile.yml` builds the phone app and launches it on an Android emulator and an iOS simulator,
on a pull request into `main` that touches it, on every `v*` tag, and by hand (#378: `release.yml`
builds the phone apps and never launches them, so without it an rc could be green while the
phone opened on nothing). `release.yml` builds the desktop
bundles and the phone apps on a `v*` tag into a draft GitHub release (#239, #348). What CI does **not** run: a linter or
formatter, the tests on macOS or Windows, `npm publish` - and **anything on `develop`**.
Actions minutes are a budget, so at the owner's decision a merge into `develop` runs nothing:
**the gates are run locally before every merge into `develop`**, and CI runs in full on the
release PR into `main`. So **`npm run typecheck && npm test`, and the app's and the Rust gates
when you touch them, before every commit is the rule**, and nothing else will catch a miss
until the release PR. `gh workflow run ci.yml --ref <branch>` runs CI on a branch when a
change needs a clean machine sooner. A test that fails only on CI is a finding about the test or the code,
never something to retry past or skip. Node 20+ (`engines`).

**What a release carries** — the stable installer names, the updater files and the phone
apps — is in [`docs/agents/releases.md`](docs/agents/releases.md). Two keys there can never be
replaced: the updater signing key and the Android keystore.

### The docs site — `docs/`

```bash
cd docs
npm install
npm run docs:build     # vitepress build - fails on a dead link, and that check stays on
npm run docs:dev       # vitepress dev - the site with live reload
npm run docs:preview   # serve the built site, under its real base path
```

**`docs/` has its own `package.json` and lockfile**, the arrangement `app/` has: the root
package gains no dependency, `docs/` is not in `files`, and the root gate neither builds it nor
sees it. It is a VitePress site published at `https://adam-hanna.github.io/vibe-code/` by the
Pages workflow, which builds from `main` so the site describes the latest release. `BASE` in
`docs/.vitepress/config.mts` is the only place the path is written; a custom domain is a
`docs/public/CNAME` and that one line. `docs/images/` is shared with `README.md`, and
`docs/plans/` and `docs/agents/` are internal and excluded from the site (`srcExclude`).

**The reference pages are hand-written, and guarded only for what is missing.**
`tests/docs-drift.test.ts`, run by `npm test`, fails when a `DEFAULTS` key path, a section,
a `verify.gates[]` field, an `EXIT` code or a command `src/cli.ts` dispatches is absent from
`docs/configuration.md`, `docs/exit-codes.md` or `docs/cli.md` (and when the last two name one
the source lacks). It checks no description, no default value and no flag, so a green run
means nothing is missing, never that the page is right. A change to any of those in `src/`
updates the page in the same PR, written against the code rather than an older page.

### The desktop app — `app/`

```bash
cd app
npm install
npm run typecheck      # tsc --noEmit, same strictness as the core
npm run build          # typecheck, then vite build
npm run dev            # vite on :1420 — the webview alone, no host
npm run dev:mobile:browser # the phone build on :1421 in a browser tab, answered by the recorded mock desktop - use device mode
npm run audit:contrast # the design system's own gate
npm run app:test       # vitest + cargo test — both sides
npm run test:web       # vitest — the cockpit's reducer
npm run test:rust      # cargo test — the shell
npm run stage:sidecar  # copy `dist/src` + a node runtime into the bundle
npm run app:build      # the whole thing: vite, staging, cargo, installer
```

**`dev:mobile:browser` does not reload `app/mobile/`.** Vite's watcher ignores that directory,
so an edit to `mobile/browser-mock.ts` takes effect only after the server is restarted. Its
`?live` query plays a desktop run held at a gate, for working on the run screens.

**The app has its own `package.json` and its own gate.** `npm run typecheck && npm test` at
the root still covers the core and does not see `app/`; run the app's commands as well when
you touch it. `app/` is *not* in `files`, so it never ships to npm — the published package
stays the CLI, and the app ships as a Tauri bundle.

## Design notes — read the one for the area you are changing

The reasoning behind most of the code is in `docs/agents/`, one file per area, so this file stays
small enough to be loaded whole: Claude Code warns above 40k characters and Codex reads only the
first 32 KiB of an `AGENTS.md`. Those notes are not loaded for you. **Before changing an area,
read its note**; when the code moves, the note moves with it in the same PR; a new note goes in the
file for its area, not here. Keep this file to rules that apply to every change.

- [`docs/agents/releases.md`](docs/agents/releases.md) — `release.yml`: the stable installer names, the updater files, and the phone apps.
- [`docs/agents/app-build.md`](docs/agents/app-build.md) — verifying a bundle, the platform traps, the contrast audit, the palettes, Tailwind over the tokens, `HANDOFF.md`.
- [`docs/agents/cockpit.md`](docs/agents/cockpit.md) — what the window may and may not decide: the round cards, the sidebar, runs and drafts, the pilot pane, replays, settings, what is kept between launches.
- [`docs/agents/core-and-window.md`](docs/agents/core-and-window.md) — narration promoted from events, the read frames, sync between clients, artifacts, spend and silence ceilings, how a run ends and how a death is told apart.
- [`docs/agents/run-worktrees.md`](docs/agents/run-worktrees.md) — `src/worktree.ts`: home versus work directory, the setup script, `git.baseRef`.
- [`docs/agents/phone.md`](docs/agents/phone.md) — iroh, the bridge and the hub, `remote.json`, the phone app, pairing and reconnecting.
- [`docs/agents/processes.md`](docs/agents/processes.md) — two front ends over one core, one host per run, several live runs in one window, one run per checkout, no shell in the webview.
- [`docs/agents/pilot.md`](docs/agents/pilot.md) — commands it may run, its tools, keys, the two backends and two roads per vendor, its context, its sandbox, the network code, its ledger.
- [`docs/agents/loop.md`](docs/agents/loop.md) — gates and pauses, stop, question rounds, findings and severities, verification gates, reproducers, judge files, links under `.vibe/runs`, the scorecard, CLI versions.
- [`docs/agents/updater-and-host-lifecycle.md`](docs/agents/updater-and-host-lifecycle.md) — `update.rs`, the reaper, a closed stdin, where the logs are.
- [`docs/agents/worktree-cleanup.md`](docs/agents/worktree-cleanup.md) — what a worktree costs on disk, and the rules for reclaiming it.
- [`docs/agents/repo-map.md`](docs/agents/repo-map.md) — one line per file that matters.

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
  in this file exist to explain a place this rule was applied.
- **A proxy is allowed; a proxy wearing another measurement's clothes is not.** `src/work.ts`
  is the worked example. The wireframes draw `step 9/14` over an implement turn and no such
  number exists, so what ships is *"9 of the 14 files the plan names"* — every part of it
  measured, and worded as a count of files so it cannot be read as a position in the plan's
  list of steps. The words are the labelling, and `implement-progress.test.ts` asserts the
  line contains no `step` and no `%`. If you add a proxy, the sentence has to say what it
  actually counted.
- **Comments explain *why*, and cite the run that taught it.** The defaults in
  `src/config.ts` are the model: each non-obvious number says what was measured to pick it.
  Do not strip these; they are the institutional memory.
- **Fail closed.** A measurement that cannot be attributed is not recorded. A guard that
  cannot read its input treats it as absent, not as zero.

## Tests

`node:test` with `node:assert/strict`. One file per concern, named for the concern rather
than the module (`convergence.test.ts`, `failure-accounting.test.ts`,
`preflight-enforcement.test.ts`).

- **Prefer adding tests. Editing an existing one is allowed, but never to make it pass.**
  When a test breaks, the failure is evidence and the first job is to find out what of. There
  are only two answers and they need opposite responses:

  1. **The change broke something.** The test is right and the code is wrong. Fix the code.
  2. **The test's claim is no longer the contract.** The behaviour genuinely moved, or - as in
     #54 - the test asserted more than the thing it was guarding and part of what it pinned was
     the defect. Then rewrite it, keeping every part of the claim that still holds.

  Deciding which of the two it is *is* the work. A test edited into green without that
  investigation destroys the one signal that would have caught the regression, and it does it
  silently. So: say in the PR which existing tests you changed, which of the two cases each was,
  and what evidence settled it. If coverage moves to another file, say where. Never delete a
  case because it is inconvenient; if it is genuinely wrong, the reason it was ever written is
  worth understanding before it goes.
- **No wall-clock fixtures.** A test that hardcodes an epoch timestamp passes until it
  doesn't — one in `ratelimits-monitor.test.ts` went off in August 2026 and made `develop`
  look broken. Compute times relative to now.
- **No network, no real agent invocations.** `tests/helpers/fake-transport.ts` and
  `tests/helpers/stub-server.ts` are the injection points.
- **A wait on a child process must be able to say which way it failed.** The suite spawns
  around a hundred children per run, and "the child printed nothing" covered two opposite
  states: one that had not begun running, and one that stalled after it did (#181). They
  need opposite responses — the first can simply be spawned again, the second is the hang
  `startKillHelper`'s timeout exists to diagnose and must never be retried past — so the
  child prints a first line before it reads argv, and `retryable()` is the one place that
  rule lives. **Raising the timeout is not the fix**: it is already 25× the worst loaded
  start-up measured, and every second added is a second a real hang looks like a slow
  machine, times the 24 children one case spawns.
- **A fixture that shells out says what the command said.** `initGit` ran four `git`
  invocations under `stdio: 'ignore'`, so the day two of them failed the suite went red
  with `Command failed: git config user.email …`, `stderr: null`, and no way to choose
  between an index lock, a held handle and a scanner (#182). Capturing stderr is the
  prerequisite for deciding anything else on evidence. **A retry is allowed only where
  running the command twice leaves the same repository** — `gitRetryable` is that rule, and
  `commit` is deliberately outside it — and a retry that fires **says so on stderr**, because
  a suite that went green because of one has to admit it. Note the direction this points:
  `commitAll` already tolerates a git failure, so the harness was stricter than the product.
- **A test that starts a process which never exits must stop it in a hook, not at the end of
  the body.** `command-runner.test.ts` slept a fixed 120ms and then asserted its child had
  ticked. Under the full suite — which spawns around a hundred children — that is not enough
  for `node -e` to boot, so the assertion failed; and because the `stopCommand` was the last
  line of the body, a failure skipped it. The live child then kept that file's event loop
  alive, so **an ordinary assertion failure arrived as a hang with the real failure buffered
  behind it**, and the whole suite sat there. It cost three cycles before anybody read the
  process tree, and both times before that it was written off as a teardown race.

  Two rules come out of it and they are the same two the bullets above already state. The wait
  is a **poll with a deadline** that says which way it failed — *ended before it wrote* and
  *wrote nothing within* are different findings — because a fixed sleep is a guess about the
  machine, made while ninety-nine other children are starting. And the cleanup is `t.after`,
  which runs whatever happened, including a throw from the spawn itself. Diagnosing it is
  `Get-CimInstance Win32_Process -Filter "ParentProcessId=<runner>"`: a runner with one live
  child that has a live grandchild is this shape, and killing the grandchild releases the
  buffered failure immediately, which is how it was confirmed rather than guessed.

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

**`develop` is the default branch and where work integrates. `main` only ever receives
release merges.** Branch off `develop`, PR back into `develop`. `develop` became the default
on 2026-10-12, after 1.6.1; until then it was `main`, which is why every PR before that says
`Refs #N` and the release PRs did the closing.

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

**GitHub only auto-closes on a merge into the *default* branch, which here is `develop`.**
A PR into `main` with `Closes #12` in its body closes nothing, ever. So:

- **Per-issue PRs (into `develop`) use `Closes #12`.** The issue closes when the fix merges,
  which is before it ships; the issue's **milestone** is what says which release it went out
  in, so set one. Use `Refs #12` for a PR that only touches an issue without finishing it.
- **The release PR (into `main`) closes nothing.** It still lists every issue the release
  contains, with `Refs`, so the release has one place naming them; check that each one is
  already closed, and close any a per-issue PR left open.

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

### Clean up after yourself — a worktree that built the app costs gigabytes

Nothing in the tooling does this for you; the measurements are in
[`docs/agents/worktree-cleanup.md`](docs/agents/worktree-cleanup.md).

- **A `target/debug` here is always residue**: nothing in this repo uses one. Delete it.
- **Delete a worktree's `app/src-tauri/target` when its issue lands**, after checking it holds
  `CACHEDIR.TAG`. Then archive its runs and prune the worktree.
- **`git branch --merged develop` says *no* for every squash-merged branch.** Check the
  changelog, the issue or a diff before deleting a branch.

## Releases

1. Branch `release/<version>` off `develop`.
2. Bump `version` in `package.json`. Semver as stated in `CHANGELOG.md`: minor for new
   capability, patch for fixes, major only for a change that breaks an existing config or an
   existing run.
3. Add the `CHANGELOG.md` section — grouped Added / Fixed / Internal / Upgrading, every entry
   linking its PR and issue.
4. PR into `main`, listing every issue the release contains with `Refs #N` (see above). The
   merge closes nothing, so check the milestone has no open issues left.
5. Re-measure the agent CLIs this release was tested against: `claude --version` and
   `codex --version`. Bump `TESTED_CLI_VERSIONS` in `src/config.ts` to what they print, and
   re-record the fixtures with `node scripts/record-cli-fixtures.mjs` (#298). Commit both.
6. Verify from a clean checkout: `npm run typecheck`, `npm test`, `npm pack --dry-run`.
7. Merge, then tag: `git tag -a v<version> -m "..." && git push origin v<version>`.
8. **When `release.yml` has finished on the tag, verify the draft before publishing it:**
   `gh release download v<version> --pattern 'Vibe-macos-universal.dmg' --pattern SHA256SUMS`, then
   `gh attestation verify Vibe-macos-universal.dmg --repo adam-hanna/vibe-code` and
   `sha256sum -c SHA256SUMS --ignore-missing`. An attestation is stored against a file's digest,
   not against the release, so it verifies while the release is still a draft.
9. **Wait for `release.yml` and `mobile.yml` on the tag, install the draft on at least one machine and both
   phone apps on a phone, then publish the draft release.** The APK from the draft must install
   *over* the previous release's (same key, higher `versionCode`), and the `.ipa` must sign and
   open through AltStore or Sideloadly; then pair each with the desktop. The workflow builds the Windows, macOS (universal) and Linux bundles
   into one draft and never publishes it. A tag that is not `package.json`'s version still
   builds, with a warning, and the bundles carry `package.json`'s version - so a throwaway
   `v<version>-rc.N` tag is how to try the workflow, and it yields a draft pre-release. A tag
   whose release is already published is refused rather than uploaded into.
10. `npm publish`. **This needs a real interactive terminal** — the OTP flow hands off to a
   browser and cannot be driven from a headless shell. A granular automation token in
   `.npmrc` avoids the prompt.
11. **Merge `main` back into `develop`.** The release PR is squash-merged, so the version bump
   and the changelog exist only on `main` until you do. After 1.1.0 this was missed and
   `develop` sat at version 1.0.1 with no `CHANGELOG.md` — which is the branch the next
   release would have been cut from.

   **Merge this one with a merge commit (`gh pr merge --merge`), never a squash.** It is the
   one PR in this repo that is not squashed. A squash copies `main`'s changes into `develop`
   without `main`'s commits, so git finds no shared history. The next release PR then
   conflicts in every file both branches touched, even where the content is identical. After
   1.6.1 the back-merge (#335) was squashed, and #376 conflicted in 47 files (#379). A merge
   commit makes `main` an ancestor of `develop`, and the next release PR merges cleanly.

   If a release PR does conflict that way, check before resolving anything:
   `git diff --stat origin/main <develop's last back-merge commit>` is empty when everything on
   `main` is already in `develop`. Then `git merge -s ours origin/main` on the release branch
   records the history and changes no file.

Anything added to the published package must be listed in `files` in `package.json`;
`CHANGELOG.md` was nearly shipped missing for exactly this reason.

## Settled decisions — do not re-litigate

Each of these was argued once, at length, and the reasoning is recorded. Reopening them
needs new evidence, not a fresh opinion.

- **Codex cost is not reported and will not be estimated.** No output mode returns one, and
  no app-server endpoint returns money. `budget.maxTokens` is the ceiling that covers both
  agents. See "Notes and limitations" in `README.md`. **The pilot's price table is not a
  counter-example** (#145): a subscription bills nothing at all, so a dollar figure for a
  Codex turn has no quantity to be an estimate *of*, while a pilot turn on an API key does.
  The rule stands and is the reason the pilot's figure says *estimated* and carries the date
  its price was read.
- **The Codex context window is a setting, not a derivation.** `modelContextWindow` exists
  only on an app-server push notification, and `vibe` drives Codex as a plain child process.
- **A persisted Codex thread cannot hold a writing role.** `codex exec resume` takes no `-s`
  flag, so the sandbox silently reverts after the first turn. What changed is where a writer
  sits, not the rule: a Codex implementer used to be *refused* while `codex.persistSession`
  was on, so choosing one cost the critic and the reviewer their threads too, and the
  settings screen had no way to say why (*"explain this keeping session between turns?!"*).
  It is now seated on `SLOTS.write`, which never carries a thread — every writer turn is a
  fresh `codex exec` with its sandbox set, handed the plan of record like any memoryless
  generative seat — and the read-only seats keep theirs. `roleRefusals` still refuses a
  table that puts a writer on a carried thread, asked of the slot rather than the setting.
- **`/compact` does not work headless.** It is a CLI command, not a model instruction.
  Compaction is explicit session rotation with a handoff briefing.
- **Prompts go over stdin, never argv.** Claude's variadic flags swallow positional
  arguments.
- **Groundwork ships separately, with no behaviour change.** The role table took four
  preparatory PRs (#15, #17, #28, #31), each landing with the table still hardcoded so that
  nothing about a default run changed until the last step. It is the pattern that works here;
  use it for anything touching the loop.
