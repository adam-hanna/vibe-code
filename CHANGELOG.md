# Changelog

Notable changes per release. Versions follow [semver](https://semver.org): the minor
number moves for new capability, the patch number for fixes, and the major number only
for a change that breaks an existing config or an existing run.

Each entry links the pull request that made it and, where there is one, the issue it
closes.

## 1.5.0 - 2026-10-08

Forty pull requests since 1.4.0. **Nothing here breaks an existing config:** no key was renamed or removed, no flag was removed, and every new key has a default. Six behaviours a running setup can notice are listed under Upgrading. The first one, that runs no longer reach your MCP servers, is the one most likely to matter.

The theme is running more than one thing at once. The app can now run several runs side by side, each in its own host process, and each draft keeps its own pilot conversation. The sidebar shows which rows are working and which are waiting on you. Underneath, a run's agents get your shell's environment and no longer get your MCP servers, a verification gate runs on the toolchain your `PATH` names, and a failing gate can be read.

### Added

- **Several runs at once in the window.** Each run gets its own host process, and frames are routed by a handle the window assigns. A machine-wide cap limits how many run together, and quitting lists the runs that would be stopped.
  (#246, [#291](https://github.com/adam-hanna/vibe-code/pull/291), [#304](https://github.com/adam-hanna/vibe-code/pull/304))
- **The sidebar shows which rows are working and which need you.** A row's dot pulses while a turn runs. A badge marks a held gate, a run stopped on a question, at a limit or by a failure, and a draft whose pilot replied or proposed something.
  (#307, [#311](https://github.com/adam-hanna/vibe-code/pull/311))
- **Each role can be granted MCP servers by name.** `roles.<role>.mcpServers` takes a list of server names in the object form of a role setting, and is empty by default. `vibe doctor` prints each role's servers and how each provider enforces them: Claude is *replaced* (`--strict-mcp-config`), and Codex is *disabled by name*, with the caveat that a server Codex does not list cannot be disabled. A grant that does not resolve stops the run before its first turn, naming the role and the server.
  (#138, [#288](https://github.com/adam-hanna/vibe-code/pull/288))
- **Standing instructions.** `instructions.text` is one text given to every agent and to the pilot on every run. It is set once in Settings, in the global file or a project's, and `configDiff` names it so a run's record says what its agents were told.
  (#273, [#275](https://github.com/adam-hanna/vibe-code/pull/275))
- **`git.baseRef` chooses the commit a fresh run starts from.** A remote-tracking ref is fetched first. A worktree that a setup script left on a different commit is refused before the first turn, rather than silently checked back over.
  (#249, [#269](https://github.com/adam-hanna/vibe-code/pull/269))
- **A change to the run's own judge is recorded and judged.** When a review round's diff touches test files or `vibe.config.json`, the reviewer is given the files and must give a verdict on each one, and the verdicts are recorded. It never blocks. `verify.testPaths` replaces the built-in list of test paths.
  (#112, [#266](https://github.com/adam-hanna/vibe-code/pull/266))
- **The window and the pilot can read the run archive.** A `stats` read frame, a rounds fingerprint on each run (`p2 v1 r2`) and token comparisons against comparable turns.
  (#114, [#289](https://github.com/adam-hanna/vibe-code/pull/289))
- **Verification gates are edited as a list in Settings,** one row per gate with its own name, command, runs, timeout and `required` flag.
  (#240, [#283](https://github.com/adam-hanna/vibe-code/pull/283))
- **The pilot's effort is chosen beside its model.**
  (#296, [#297](https://github.com/adam-hanna/vibe-code/pull/297))
- **A run can be named when it is started,** and keeps that name once it begins.
  (#262, [#263](https://github.com/adam-hanna/vibe-code/pull/263))
- **Copy a message out of the pilot chat,** yours or the pilot's, with one click. The pilot's reply is copied as its Markdown source.
  (#256, [#257](https://github.com/adam-hanna/vibe-code/pull/257))
- **A pause can be taken back** before the run reaches it.
  (#276, [#278](https://github.com/adam-hanna/vibe-code/pull/278))
- **The run output is a main tab again,** right of Pilot.
  (#284, [#286](https://github.com/adam-hanna/vibe-code/pull/286))

### Fixed

- **A failing verification gate can be read.** The fix round is drawn as live, each attempt's log can be opened, and the fixer sees the failures rather than a truncated tail.
  (#248, [#281](https://github.com/adam-hanna/vibe-code/pull/281))
- **The verification gate runs on the Node your `PATH` names,** not the system's. One gate failed a suite that passed in a terminal, and kept failing on every resume.
  (#251, [#252](https://github.com/adam-hanna/vibe-code/pull/252))
- **Agents get your login shell's environment,** so `gh` is logged in and a push uses your ssh agent instead of asking for a passphrase.
  (#272, [#274](https://github.com/adam-hanna/vibe-code/pull/274))
- **A stopped run can be resumed from the window.** A run that stopped at a limit replayed with no exit code, so its footer stuck on "ending" and offered no resume.
  (#309, [#310](https://github.com/adam-hanna/vibe-code/pull/310))
- **After a resume, the turn the run stopped on no longer stays RUNNING.**
  (#302, [#303](https://github.com/adam-hanna/vibe-code/pull/303))
- **Two drafts' pilot conversations no longer cross.** Each conversation has its own pane, so a reply lands where it was asked for.
  (#305, [#306](https://github.com/adam-hanna/vibe-code/pull/306))
- **Each pilot chat shows the round cards of the run it is about,** not the live run's.
  (#247, [#250](https://github.com/adam-hanna/vibe-code/pull/250))
- **A new run with the same brief as an earlier one no longer gets a blank pilot chat.**
  (#270, [#271](https://github.com/adam-hanna/vibe-code/pull/271))
- **A new run's draft draws an empty run column,** not the last run on screen.
  (#294, [#295](https://github.com/adam-hanna/vibe-code/pull/295))
- **An answerer's answers are kept when a run stops before the revision that uses them.** There were four ways to lose them, and a resume then critiqued a plan whose questions nothing had resolved.
  (#169, [#255](https://github.com/adam-hanna/vibe-code/pull/255))
- **A question round whose questions are all advisory skips the planner revision.** The critic reads the answers with the plan instead.
  (#277, [#279](https://github.com/adam-hanna/vibe-code/pull/279))
- **A fix round is drawn as a code round,** so the column reads code, review, code, review.
  (#280, [#282](https://github.com/adam-hanna/vibe-code/pull/282))
- **A replayed run keeps its severity counts,** and a verify-fix stays in its code round.
  (#292, [#293](https://github.com/adam-hanna/vibe-code/pull/293))
- **A critique's findings are drawn on the critique,** not on the revision it caused, when the two frames arrive together.
  (#285, [#287](https://github.com/adam-hanna/vibe-code/pull/287))
- **An opened run shows the spend its record holds,** instead of "no turn reported a charge".
  (#235, [#243](https://github.com/adam-hanna/vibe-code/pull/243))
- **The judge is no longer told a P1 threshold the loop does not apply.**
  (#115, [#244](https://github.com/adam-hanna/vibe-code/pull/244))
- **Stopping and pausing say plainly what they do.** A stop that is waiting is shown, and a pause ends with its run.
  (#253, [#254](https://github.com/adam-hanna/vibe-code/pull/254))
- **One set of run controls is drawn at a time,** not two stacked in the corner.
  (#264, [#265](https://github.com/adam-hanna/vibe-code/pull/265))
- **A quiet turn is said in the status bar,** so the window no longer jumps as the strip comes and goes.
  (#267, [#268](https://github.com/adam-hanna/vibe-code/pull/268))
- **The new-run dialog's settings are drawn as chips under your brief,** not as your words.
  (#258, [#259](https://github.com/adam-hanna/vibe-code/pull/259))
- **"Open full activity" opens the output,** and panes are opened only by name.
  (#260, [#261](https://github.com/adam-hanna/vibe-code/pull/261))
- **An opened run's way back sits in the column's title row,** and it stops saying "reading" once it has loaded.
  (#236, [#245](https://github.com/adam-hanna/vibe-code/pull/245))
- **The tagline above the main heading is gone.**
  (#300, [#301](https://github.com/adam-hanna/vibe-code/pull/301))

### Internal

- **The test suite runs inside a temp root it removes,** and fails on anything that escapes it. Each run used to leave about 1,600 directories in `/tmp`.
  (#234, [#241](https://github.com/adam-hanna/vibe-code/pull/241))
- **The UI rework is finished:** the old stylesheets and the gallery are deleted, and Tailwind's preflight is imported.
  (#237, [#290](https://github.com/adam-hanna/vibe-code/pull/290))
- **The dead `applog::path` is removed,** so an app build no longer warns.
  (#238, [#242](https://github.com/adam-hanna/vibe-code/pull/242))

### Upgrading

No config change is required. Six behaviours a running setup can notice:

- **Runs no longer reach any MCP server.** Before this change, every `claude` and `codex` child that a run spawned loaded your own MCP configuration. That gave every role, the read-only critic and reviewer included, every server you had set up for yourself. Now every `claude` child runs with `--strict-mcp-config`. Every `codex` child has each server that `codex mcp list` reports switched off with `-c mcp_servers.<name>.enabled=false`. This covers every turn, resume, fork and preflight probe. To give a role a server back, name it in `roles.<role>.mcpServers`. Claude re-reads it from `~/.claude.json` or the repository's `.mcp.json`. claude.ai connectors (`claude.ai Gmail` and the like) cannot be granted, because their definitions are in no file vibe can read. A `codex mcp list` that fails now refuses the Codex turn rather than running it with your servers open.
- **On Linux and macOS, `claude`, `codex` and `node` resolve from `PATH` first,** before the fallback directories (`~/.local/bin`, `/usr/local/bin`), which is what a terminal runs. `VIBE_CLAUDE_BIN`, `VIBE_CODEX_BIN` and the `cli.*` settings still win over both.
- **A worktree that a setup script moved is refused.** If `git.worktreeCommand` leaves the worktree on a different commit from the run branch, the run stops before its first turn and names both shas. Check out `$VIBE_BRANCH` in the script, or choose the base with `git.baseRef`.
- **An all-advisory question round no longer revises the plan.** The answers go to the critic with the plan, and an answer that does change something comes back as a finding.
- **The terminal prints a heading for each fix round:** `=== Implementing (fix round N) ===`.
- **The app's host takes your login shell's environment.** It runs `$SHELL -l -i` once at start-up, for at most 10 seconds, and falls back to the app's own environment if that fails.

## 1.4.0 - 2026-10-07

Fifty-seven pull requests since 1.3.0. **Nothing here breaks an existing config:** no key was renamed or removed, no flag was removed, and every new section has a default. Five behaviours a running setup can notice are listed under Upgrading.

The theme is a second front end. 1.3.0's loop could only be watched from a terminal. 1.4.0 adds the desktop app, built on the same core: the loop narrates to a pipe, holds at boundaries a window can answer, and can be paused, stopped and resumed from it. A **pilot** chat proposes each run and starts nothing on its own. The app ships as a Tauri bundle, not in the npm package; everything else below applies to the CLI as well.

### Added

- **The desktop app.** A window, tray and single instance in Rust. It supervises a host process that runs the same `main()` the CLI does and dies when the app does. The cockpit draws the loop column, the round cards, the plans, critiques, reviews, code, questions and verification, and an opened past run is replayed through the same reducer that drew it live. Redrawn in Tailwind for this release.
  (#146, #153, #154, #157, #159, #186, #189, #190, #201, #204, #205, #207, #223, [#147](https://github.com/adam-hanna/vibe-code/pull/147), [#156](https://github.com/adam-hanna/vibe-code/pull/156), [#158](https://github.com/adam-hanna/vibe-code/pull/158), [#160](https://github.com/adam-hanna/vibe-code/pull/160), [#187](https://github.com/adam-hanna/vibe-code/pull/187), [#194](https://github.com/adam-hanna/vibe-code/pull/194), [#195](https://github.com/adam-hanna/vibe-code/pull/195), [#203](https://github.com/adam-hanna/vibe-code/pull/203), [#213](https://github.com/adam-hanna/vibe-code/pull/213), [#216](https://github.com/adam-hanna/vibe-code/pull/216), [#217](https://github.com/adam-hanna/vibe-code/pull/217), [#219](https://github.com/adam-hanna/vibe-code/pull/219), [#224](https://github.com/adam-hanna/vibe-code/pull/224), [#225](https://github.com/adam-hanna/vibe-code/pull/225), [#226](https://github.com/adam-hanna/vibe-code/pull/226), [#227](https://github.com/adam-hanna/vibe-code/pull/227), [#231](https://github.com/adam-hanna/vibe-code/pull/231))
- **A host protocol.** `vibe`'s narration has stable ids and a second destination besides the terminal. The heartbeat is sent as numbers, durable facts are said once, and a host can hold the loop at a boundary and answer it. Read frames return the archive, the config, diffs, artifacts and replays while a run is going.
  (#133, #134, [#148](https://github.com/adam-hanna/vibe-code/pull/148), [#149](https://github.com/adam-hanna/vibe-code/pull/149), [#150](https://github.com/adam-hanna/vibe-code/pull/150), [#151](https://github.com/adam-hanna/vibe-code/pull/151), [#152](https://github.com/adam-hanna/vibe-code/pull/152), [#155](https://github.com/adam-hanna/vibe-code/pull/155))
- **Gates are a setting.** `gates.<boundary>` is `auto`, `step` or `stop` for each of six boundaries, and `--gate <boundary>=<mode>` sets them from the command line. `stop` gives a terminal a resumable halt. `vibe doctor` prints the effective table.
  (#140, #106, [#170](https://github.com/adam-hanna/vibe-code/pull/170))
- **Pause and stop.** A run can be held at its next boundary for free, and the turn in flight can be killed. A stop ends the run the same way a round cap does: resumable, with `NEEDS-INPUT.md` saying why.
  (#209, #210, [#220](https://github.com/adam-hanna/vibe-code/pull/220), [#221](https://github.com/adam-hanna/vibe-code/pull/221))
- **The pilot.** A chat that reads the repository and proposes runs and commands for a person to press. It runs on an API key or on your existing Claude subscription, and keeps its own books, separate from the run's ceiling.
  (#143, #144, #145, #188, #191, #193, #211, [#161](https://github.com/adam-hanna/vibe-code/pull/161), [#165](https://github.com/adam-hanna/vibe-code/pull/165), [#166](https://github.com/adam-hanna/vibe-code/pull/166), [#167](https://github.com/adam-hanna/vibe-code/pull/167), [#174](https://github.com/adam-hanna/vibe-code/pull/174), [#192](https://github.com/adam-hanna/vibe-code/pull/192), [#196](https://github.com/adam-hanna/vibe-code/pull/196), [#197](https://github.com/adam-hanna/vibe-code/pull/197), [#200](https://github.com/adam-hanna/vibe-code/pull/200), [#222](https://github.com/adam-hanna/vibe-code/pull/222), [#229](https://github.com/adam-hanna/vibe-code/pull/229))
- **`vibe stats` reads the run archive.** It reports what the loop's own record says about convergence, with each rate's denominator stated, and names what the archive cannot answer.
  (#47, #53, #66, #85, [#171](https://github.com/adam-hanna/vibe-code/pull/171))
- **A person can join the argument.** A finding can be raised from `NEEDS-INPUT.md`, and a severity a guard moved can be moved back. Every finding records who raised it.
  (#113, #141, #142, [#175](https://github.com/adam-hanna/vibe-code/pull/175), [#177](https://github.com/adam-hanna/vibe-code/pull/177))
- **A blocking finding can prove it reproduces.** The reviewer supplies a test file, not a command. vibe places it, runs your own gate, and removes it.
  (#113, [#178](https://github.com/adam-hanna/vibe-code/pull/178))
- **A flaky gate is told apart from a broken one.** A failing gate now runs its remaining attempts. `flaky` (some passes, some failures) gets a different fix prompt from `failing`.
  (#135, [#176](https://github.com/adam-hanna/vibe-code/pull/176))
- **A write turn says how far it has got,** as a count of the files the plan names, worded so it can't be read as a step number.
  (#136, #198, [#173](https://github.com/adam-hanna/vibe-code/pull/173), [#199](https://github.com/adam-hanna/vibe-code/pull/199))
- **Settings for every project** in `~/.config/vibe/config.json`, layered beneath each project's `vibe.config.json`. `VIBE_GLOBAL_CONFIG` overrides the path, or switches the file off.
  ([#225](https://github.com/adam-hanna/vibe-code/pull/225))
- **Editable prompts.** The standing instruction blocks can be overridden under `prompts.<block>`, and a name the build doesn't have is refused by name.
  (#137, [#225](https://github.com/adam-hanna/vibe-code/pull/225))
- **A run can work in a git worktree of its own.** `git.worktree` and `git.worktreeCommand` do this, while the archive stays in the repository.
  (#208, [#225](https://github.com/adam-hanna/vibe-code/pull/225))
- **`vibe resume <id> --implement`** takes a finished plan-only run into implementation, carrying its approved plan.
  ([#225](https://github.com/adam-hanna/vibe-code/pull/225))
- **A stalled turn is stopped.** `progress.maxQuietMs`, 10 minutes by default, ends a turn that has produced no output for that long.
  ([#225](https://github.com/adam-hanna/vibe-code/pull/225))

### Fixed

- **A question round is a checkpoint, and no longer spends a plan round.** Revising a plan against its own answers advanced `planRound`, so every question round used up one of the rounds the run had for the critic.
  (#78, #139, [#168](https://github.com/adam-hanna/vibe-code/pull/168))
- **A Codex implementer no longer costs the judges their threads.** It runs one-shot on a slot of its own, because a resumed Codex turn cannot write. The critic and reviewer keep their conversations, and the old refusal still applies to any table that puts a writer on a carried thread.
  ([#231](https://github.com/adam-hanna/vibe-code/pull/231))
- **Adversarial planning and review stay within the original task.**
  ([#228](https://github.com/adam-hanna/vibe-code/pull/228))
- **How a run ended is recorded and said.** `ending.json` sits beside the lock, so a dead pid no longer looks like a kill, and the footer has one sentence for each of the eight exit codes.
  (#131, #162, [#163](https://github.com/adam-hanna/vibe-code/pull/163), [#172](https://github.com/adam-hanna/vibe-code/pull/172))
- **An artifact that is a link is refused** on both paths a live run reads one, and a run that never resumes reports what it still holds.
  (#129, #130, [#179](https://github.com/adam-hanna/vibe-code/pull/179), [#180](https://github.com/adam-hanna/vibe-code/pull/180))
- **Quitting during a run no longer waits five seconds and kills.** A closed stdin abandons the request, and the process leaves under its own control.
  (#206, [#212](https://github.com/adam-hanna/vibe-code/pull/212))
- **A held gate is drawn as held, and a settled card shows absolute times** rather than times that keep counting.
  (#202, [#214](https://github.com/adam-hanna/vibe-code/pull/214), [#218](https://github.com/adam-hanna/vibe-code/pull/218))
- **Preflight says what it is doing** instead of nothing.
  (#205, [#215](https://github.com/adam-hanna/vibe-code/pull/215))

### Internal

- **The test harness reports more clearly when it fails.** It tells a child that never started from one that stalled, says what git said when a fixture fails, and states a dead pid instead of arranging for one.
  (#164, #181, #182, [#183](https://github.com/adam-hanna/vibe-code/pull/183), [#184](https://github.com/adam-hanna/vibe-code/pull/184), [#185](https://github.com/adam-hanna/vibe-code/pull/185))
- **The design corpus is in the repo:** `app/src/design/HANDOFF.md` and `AUDIT.md`.
  ([#216](https://github.com/adam-hanna/vibe-code/pull/216))
- **The README is a short quick start** with screenshots; the long material moves to a docs site.
  (#230, [#231](https://github.com/adam-hanna/vibe-code/pull/231))

### Upgrading

No config change is required. Five behaviours a running setup can notice:

- **Default models follow each CLI's own default.** `claude.model` and `codex.model` default to `default`, which sends no model flag, where they used to be `opus` and `gpt-5.6-luna`. If you never set a model, your runs now use whatever your CLI is configured with. Set `claude.model`, `codex.model` or `roles.<role>.model` to pin one.
- **Gates hold in four places by default:** `plan-approved`, `implemented`, `verify-round` and `review-round`. Only the desktop app holds there; a terminal can't answer, so `vibe run` goes straight through. A `stop` row ends a CLI run resumably.
- **A global settings file is read** at `~/.config/vibe/config.json` if it exists. Set `VIBE_GLOBAL_CONFIG=` (empty) to ignore it.
- **Question rounds no longer use up plan rounds,** and the answerer's file is numbered by question round (`answers-1.json` is the first). A run that asks questions gets more critique rounds within the same caps.
- **A failing gate runs every attempt** in `verify.runs`, rather than stopping at the first failure, so a red gate takes longer to report. A passing gate still stops at its first pass.

## 1.3.0 - 2026-09-02

Twenty-four issues since 1.2.0. **Nothing here breaks an existing config**: no key was renamed or
removed, and every new key has a default that reproduces 1.2.0's behaviour. Five behaviours a
running setup can notice are listed under Upgrading.

The theme is what a killed process leaves behind. 1.2.0 could tell a dead run from a live one and
recover what it spent; this release recovers the session it was talking through, the artifacts it
wrote, the evidence a failing gate produced and — where an implementer had stashed to get a clean
test run — the work itself. Alongside it, the role table finally reaches the command line, and the
guards that decide whether a run is making progress stopped taking a model's word for it.

Almost every change here was preceded by a measurement, and in five cases the measurement
contradicted the issue that asked for the work. Those are called out in the entries rather than
quietly corrected.

### Added

- **A failing gate's evidence is preserved.** `verify.gates[].artifacts` names project-relative
  paths to copy into `<run>/artifacts/<gate>/round-<n>/` when that gate fails, one directory per
  round, with the size always reported. Every link on the way in is refused and named — measured
  against all four shapes at once, because `cpSync` preserves a symlink as a pointer out of the
  archive and copies a junction's bytes *in*.
  (#62, #104, [#110](https://github.com/adam-hanna/vibe-code/pull/110))
- **The role table has a command line.** `--role <role>:<key>=<value>`, repeatable, last wins, on
  `vibe run`, `vibe resume` and `vibe fork`. It **patches** a role rather than replacing it, so
  `--role reviewer:effort=max` keeps the model the file named — and the toolchain contract is
  re-derived when a flag moves a seat to another agent. This is what #2, #46 and #60 each deferred.
  (#89, [#105](https://github.com/adam-hanna/vibe-code/pull/105))
- **A role can name its own turn timeout.** `roles.<role>.timeoutMs`, resolved request → role →
  provider, and a turn that dies under one now says which key set it.
  (#84, [#103](https://github.com/adam-hanna/vibe-code/pull/103))
- **`vibe doctor` previews the run those flags would give you.** It takes the same options
  `vibe run` does and reports the configuration they produce, not the file's version of it; where a
  flag moved something the config line names what. Since 1.2.0 it honoured `--role` and nothing
  else, which meant reporting a subset with no way to tell which parts the flags had reached.
  (#106, [#128](https://github.com/adam-hanna/vibe-code/pull/128))
- **Every turn records what it actually did** — a per-kind tally of the items it emitted and the
  tools it used, for every role on both agents. A **review** turn that emitted items and used no
  tool has its blocking findings downgraded to P2 through the existing evidence mechanism. The
  threshold was not chosen: Codex's own rollouts made it possible to reconstruct the tally for
  every turn vibe had ever run here, 263 of them going back to 2026-08-12.
  (#66, [#109](https://github.com/adam-hanna/vibe-code/pull/109))

### Fixed

- **A failed first Claude turn no longer burns the session id.** A turn that died after the CLI
  registered its session but before vibe saw it succeed left the run *permanently unresumable* —
  every later attempt refused with `Session ID ... is already in use`, with no flag that cleared it.
  Measured against the real CLI: the id is spent on **attempt**, and the dead session is
  **resumable and still holds that turn's work**, which ruled out minting a fresh id as the whole
  answer.
  (#74, [#90](https://github.com/adam-hanna/vibe-code/pull/90))
- **A rate limit no longer costs the session it never damaged.** The first Claude turn of a run is
  the plan turn; a limit there used to wait as much as `budget.maxWaitMinutes` and then redo the
  work in a fresh conversation. A `RateLimitError` is raised only from a complete result envelope,
  so the conversation behind it is intact; the retry now resumes it. Every other failure class
  still gives the spent id up.
  (#91, [#126](https://github.com/adam-hanna/vibe-code/pull/126))
- **A killed turn's work is no longer silently stranded in a git stash.** An implementer that
  stashes to check whether a failing test predates its change, and is killed before the matching
  pop, leaves its entire output where nothing can see it — the tree reads clean, there are no
  commits, and the accounting correctly says the turn ran. One run lost 11.3M tokens that way. A
  run with a branch now reads `git stash list` before dispatching anything and reports any entry
  made on that branch. It notices and does nothing else: a pop can conflict, and a stash a human
  made is not vibe's to take.
  (#96, [#127](https://github.com/adam-hanna/vibe-code/pull/127))
- **Every run artifact is written whole or not at all.** `artifact()` was the last plain
  `writeFileSync` in the run directory. The failure mode is not a splice: `'w'` is `O_TRUNC`, so a
  kill in that window leaves a **zero-byte** file — reproduced 5 times in 40 on a 17KB `PLAN.md`.
  (#88, [#99](https://github.com/adam-hanna/vibe-code/pull/99))
- **A run entry under `.vibe/runs/` can no longer be a link out of the archive.** The traversal
  guard was lexical, so a single-component entry that was a symlink or junction passed every check
  and was followed by `loadRun`, `listRuns`, `cmdResume` and all three fork entry points. Measured
  on 1.2.0: `vibe resume` completed with exit 0, **rewrote the target's `state.json`** and created
  files in it.
  (#53, [#101](https://github.com/adam-hanna/vibe-code/pull/101))
- **Nor can a checkpoint inside one**, which is the file that *becomes* a run when it is forked
  from. Reported as linked rather than as unreadable, and refused before the check that would
  follow it.
  (#102, [#125](https://github.com/adam-hanna/vibe-code/pull/125))
- **A killed artifact preservation no longer strands its staging directory** in the run record.
  Swept at the top of each pass, naming what it removed and what it left. This also collected a
  second shape nothing had ever removed: a `.partial-<i>` **file**, left when the copied entry was
  a single file rather than a directory.
  (#111, [#124](https://github.com/adam-hanna/vibe-code/pull/124))
- **A run whose review phase has no git to read is refused at minute zero**, instead of dying at
  the last phase — 30,277,210 tokens and 70.7 minutes into the run that prompted it, with the plan
  converged, the implementation written and the gate passed three times. Exactly one call in the
  whole run was unguarded. `vibe plan` still works anywhere.
  (#71, [#92](https://github.com/adam-hanna/vibe-code/pull/92))
- **The summary can no longer print a negative Claude share.** Nothing enforced
  `codexTokens <= tokensUsed`, and `summary()` renders Claude's share by subtraction; a state where
  it was larger printed `Claude -4,988,787 tok` as the run's accounting.
  (#87, [#95](https://github.com/adam-hanna/vibe-code/pull/95))
- **A Codex turn's heartbeat is no longer handed Claude's context window.** Latent rather than
  visible — counted across 2,480 archived heartbeat lines, no Codex heartbeat has ever rendered a
  `ctx%`, because Codex reports no per-request usage. What is removed is the trap, and the issue's
  claim that it rendered a wrong figure was wrong.
  (#86, [#94](https://github.com/adam-hanna/vibe-code/pull/94))
- **The past-run index no longer stats the whole archive to render ten rows.** At 2,000 runs the
  pre-slice stat sweep was 74.40ms of a 77.03ms call — 97% of it. Reordered; no cache, no index
  file, nothing else on the path needed touching.
  (#85, [#98](https://github.com/adam-hanna/vibe-code/pull/98))
- **Resuming a finished run no longer spends ~60,000 tokens** probing agent environments for phases
  it does not have.
  (#97, [#120](https://github.com/adam-hanna/vibe-code/pull/120))
- **A plan whose body is a pointer is refused.** One run implemented a `plan_md` of 13 characters:
  the critique raised it, and `p1Tolerance` carried it through the gate anyway. It is now a P0 the
  tolerance cannot carry.
  (#108, [#121](https://github.com/adam-hanna/vibe-code/pull/121))
- **A finding's identity means its claim, not its label.** The convergence guards keyed on `id`
  alone, so a model that renamed a finding looked like progress and one that recycled a label
  looked like repetition. Across 25 archived runs — 276 findings, 61 rounds — a recycled label was
  measured to change the title far more often than not, and replaying every history through both
  builds changed no round-level verdict while removing two false persistence notices.
  (#116, [#122](https://github.com/adam-hanna/vibe-code/pull/122))
- **The critic is told when the plan turn never looked at anything** — a plan turn that answered
  from the conversation, inspecting no file and running no command, no longer arrives
  indistinguishable from one that read the code.
  (#63, [#123](https://github.com/adam-hanna/vibe-code/pull/123))
- **`ASSUMED.md` no longer calls a human decision a guess**, and one question is no longer asked
  four times. The identity rule was measured rather than chosen: 115 open questions across 22 runs,
  335 within-run pairs, with a clean gap in the distribution where the threshold went.
  (#65, [#107](https://github.com/adam-hanna/vibe-code/pull/107))

### Internal

- **One readiness wait for the kill-sweep helpers, with a third way out.** There were two identical
  copies and neither could time out, so a helper that never said ready hung the whole suite.
  (#100, [#118](https://github.com/adam-hanna/vibe-code/pull/118))
- **`changedFiles` is deleted.** Left behind with no caller, still diverging from the packer it was
  extracted beside, and still answering `[]` where it meant "I could not look".
  (#93, [#119](https://github.com/adam-hanna/vibe-code/pull/119))

### Upgrading

No config change is required. Five behaviours a running setup can notice:

- **`vibe doctor` honours every flag now, including an invalid one.** A flag it used to ignore
  starts mattering, so `vibe doctor --codex-context-window 0` fails the config check where it was
  previously dropped. That is the point — the same flag stops `vibe run` — but if you script on
  doctor's exit code with flags that were being ignored, check them.
  (#106)
- **A review turn that emitted items and used no tool has its blocking findings downgraded to P2.**
  A review round that used to block can now pass. The downgrade is recorded on the finding with its
  reason, as every other evidence-based downgrade is.
  (#66)
- **A run entry or checkpoint under `.vibe/runs/` that is a symlink or a junction is refused**,
  unopened, and reported as *linked* rather than as unreadable. If you keep run directories
  elsewhere and link them into the archive, those runs will no longer load; move them in, or point
  `-C` at where they actually are.
  (#53, #102)
- **`vibe run` outside a git repository exits 6 before the first turn**, rather than warning and
  then dying in the review phase. `vibe plan` is unaffected and still works anywhere.
  (#71)
- **A plan whose body carries no plan is refused as a P0** and `loop.p1Tolerance` will not carry it
  past the gate, however high it is set.
  (#108)

## 1.2.0 - 2026-08-27

Seventeen issues since 1.1.0. **Nothing here breaks an existing config**: every new key has a
default that reproduces 1.1.0's behaviour and no key was renamed or removed. Three things a
running setup can notice are listed under Upgrading.

The theme is evidence. A plan now says how you would know it worked, a finding has to cite
something, a verification gate that never ran can no longer report success, and a run that is
killed can be told from one that is working — and can be resumed without losing what it spent.

### Added

- **A plan has a structured definition of done.** `acceptance_criteria` on every plan: a stable
  id, the observable condition, the check that settles it and how to run it. Frozen as a copy at
  the instant the plan is approved, so the bar cannot be lowered after the gate, and the
  implementer's report is keyed to the same ids.
  (#44, [#58](https://github.com/adam-hanna/vibe-code/pull/58))
- **Named verification gates.** `verify.gates` replaces a single command with an ordered list,
  each with its own name, command and `required` flag. A required gate that never ran now exits
  **7** instead of reporting success. A config with `verify.command` still works and is
  synthesised into one legacy gate.
  (#47, [#64](https://github.com/adam-hanna/vibe-code/pull/64))
- **A finding has to cite something.** Every finding carries `evidence` naming what kind of claim
  it makes and where. A P0 or P1 whose citations do not resolve is downgraded to P2, with the
  reason recorded on it, rather than buying a fix round on an assertion nobody checked.
  (#48, [#67](https://github.com/adam-hanna/vibe-code/pull/67))
- **The implementer's report reaches the next reviewer**, framed as an untrusted and
  non-exhaustive self-report rather than as evidence. Five fixed headings, keyed to the plan's
  acceptance-criterion ids, rendered into every turn of the next review round.
  (#50, [#72](https://github.com/adam-hanna/vibe-code/pull/72))
- **The planner reads what past runs decided.** `.vibe/runs/` is named in the planning prompt as
  evidence and explicitly not as instruction — bounded to ten rows, every field truncated, and
  sanitised where the prompt is rendered rather than where it is read.
  (#52, [#73](https://github.com/adam-hanna/vibe-code/pull/73))
- **A role can name its own effort**, and then its own model. `roles.<role>` accepts
  `{ "provider", "model", "effort" }`, so the critic and the reviewer no longer have to be one
  mind in two conversations. A model is accepted on trust — no allowlist, no substitution — and
  surfaced early in the `Roles:` line and by name when a turn fails.
  (#46, [#61](https://github.com/adam-hanna/vibe-code/pull/61); #60,
  [#79](https://github.com/adam-hanna/vibe-code/pull/79))
- **`vibe list` and `vibe resume` can tell a dead run from a live one.** A run holds `run.lock`
  while it works, naming its pid, host and start time. Six verdicts, and only a genuinely absent
  lock permits a second writer; a resume over a live or unprobeable lock is refused, with
  `--force` as the way out.
  (#77, [#80](https://github.com/adam-hanna/vibe-code/pull/80))
- **A killed turn's spend is recovered.** vibe watches its own stream, so a Claude turn
  interrupted mid-flight is charged on the next resume and the ceilings see it. An interrupted
  Codex turn is named as unattributed rather than counted, because `codex exec --json` reports
  usage only when a turn completes.
  (#77, [#80](https://github.com/adam-hanna/vibe-code/pull/80))
- **A run's state has a history, and `vibe fork`.** Each run writes a `checkpoint-<n>.json` at
  every phase and round boundary — the whole state, valid on its own — and records the commit
  that round produced. `vibe fork <run-id> --at <n>` seeds a new run from one of them, creating
  its branch with `git branch` so the working tree, HEAD and the parent run are untouched.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))
- **The reviewer has its own Codex conversation**, separate from the thread that argued the plan
  into shape and approved it.
  (#45, [#59](https://github.com/adam-hanna/vibe-code/pull/59))
- **The reviewer is told what deferring is for, and what not deferring costs.** Across nine runs
  the critic deferred twice while plan revisions moved 46 items out of scope — the mechanism was
  not unused, it was being routed around at the price of a full round.
  (#56, [#76](https://github.com/adam-hanna/vibe-code/pull/76))

### Fixed

- **A change too large for one review turn is reviewed in as many turns as it takes.** Above 400k
  characters the diff is packed into whole-file parts, each its own reviewer turn, merged into one
  findings report and one round. A single file whose own diff exceeds the limit is still cut, but
  the reviewer is told which one and the run says so.
  (#49, [#70](https://github.com/adam-hanna/vibe-code/pull/70))
- **Stored run state is validated rather than cast.** A record is repaired to the empty value its
  type implies and the repair is logged; a promise the run cannot keep is refused with the run
  named and nothing rewritten.
  (#23, [#55](https://github.com/adam-hanna/vibe-code/pull/55))
- **`status`, `phase` and `planOnly` are checked together, not just individually.** A combination
  no writer could have produced is refused or normalised toward repeating work rather than
  skipping it.
  (#54, [#75](https://github.com/adam-hanna/vibe-code/pull/75))
- **Codex no longer rejects the findings schema with a 400.** Every critique and review turn was
  failing; the rule is now asserted offline so it cannot regress silently.
  (#68, [#69](https://github.com/adam-hanna/vibe-code/pull/69))
- **A critique round that only defers reaches the planner.** The approving round's deferrals used
  to be cleared without ever being stated to the implementer.
  (#22, [#57](https://github.com/adam-hanna/vibe-code/pull/57))
- **`state.json` is written whole or not at all.** Write-to-temp then rename, so a process killed
  during the write leaves either the previous file or the new one. It was truncate-then-write, on
  a ~96KB file rewritten every five seconds for the length of a run.
  (#77, [#80](https://github.com/adam-hanna/vibe-code/pull/80))
- **The in-turn token figure matches what the turn is charged.** It counted a message once per
  content block, overstating by up to 99%.
  (#77, [#80](https://github.com/adam-hanna/vibe-code/pull/80))
- **A resume no longer commits to whatever branch is checked out.** See Upgrading.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))
- **Two runs started in the same second on the same task no longer share a directory.** The
  allocator claimed it with a recursive `mkdir`, which succeeds on one that already exists, so the
  second run overwrote the first.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))
- **A stored report pointer is checked against the names vibe actually writes.** It was a
  character whitelist, so a stored `lastReport` of `state.json` rendered the whole state file into
  the reviewer's prompt.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))

### Internal

- **A full-loop integration harness**, so the phase loop itself is testable: `orchestrate` end to
  end with injected agents, a real git repo and a real verification command. Every phase feature
  in this release was tested through it.
  (#43, [#51](https://github.com/adam-hanna/vibe-code/pull/51))
- `AGENTS.md`, the working guide for changing this repo, and the README gaps 1.1.0 left.
  ([#40](https://github.com/adam-hanna/vibe-code/pull/40),
  [#41](https://github.com/adam-hanna/vibe-code/pull/41),
  [#42](https://github.com/adam-hanna/vibe-code/pull/42))

### Upgrading

No config change is required. Three behaviours a running setup can notice:

- **A required verification gate that never ran now exits 7** instead of 0. The work, its
  artifacts and its commits are all there; what is missing is the evidence that it runs. If you
  script on the exit code, treat 7 as "finished, unverified".
  (#47)
- **`vibe resume` refuses when the run records a branch that exists and something else is checked
  out**, naming the `git checkout` to run, where it used to proceed. Those commits were landing on
  whichever branch happened to be current. `--no-branch` skips the check.
  (#78)
- **A `state.json` that is internally contradictory can now be refused on load** rather than
  resumed. Only combinations no writer could have produced are refused; everything that is merely
  damaged is repaired to the empty value its type implies and logged.
  (#23, #54)

## 1.1.0 - 2026-08-20

Nineteen changes since 1.0.1. **Nothing here breaks an existing setup**: every new config
key has a default that reproduces 1.0.1's behaviour, no key was renamed or removed, and a
`state.json` written by 1.0.1 resumes unchanged.

### Added

- **Configurable agent roles.** `roles` names which agent holds each of `planner`,
  `implementer`, `critic`, `answerer` and `reviewer`. The default is the assignment every
  1.0.1 run made - Claude plans and implements, Codex critiques, answers and reviews - so
  a config without the section behaves identically. Assignments that cannot work are
  refused rather than silently degraded, and ones that work with a cost say so.
  (#2, [#34](https://github.com/adam-hanna/vibe-code/pull/34))
- **Codex thread context measurement.** `codex.contextWindow` turns the thread's occupancy
  into a ratio and warns above `context.compactAboveRatio`. It defaults to null, because
  the window is not obtainable from a `codex exec` thread: `modelContextWindow` exists only
  on an app-server push notification, and vibe spawns Codex as a separate process. With no
  window configured the occupancy is reported as a token count and never as a fraction.
  (#30, [#38](https://github.com/adam-hanna/vibe-code/pull/38))
- **Codex rate-limit awareness.** Reads Codex's rate-limit window over the app-server and
  stops before a turn that the window would kill partway through.
  `budget.codexLimitPercent`, `budget.waitOnRateLimit`, `budget.maxWaitMinutes`.
  (#1, [#5](https://github.com/adam-hanna/vibe-code/pull/5))
- **In-turn progress.** A heartbeat during a turn rather than silence until it returns.
  `progress.enabled`, `progress.intervalMs`.
  (#4, [#7](https://github.com/adam-hanna/vibe-code/pull/7))
- **A way to decline out-of-scope work.** A plan states what it is deliberately not doing,
  and a critique finding outside that boundary can be deferred to `FOLLOW-UPS.md` instead
  of being absorbed or argued away.
  (#18, [#19](https://github.com/adam-hanna/vibe-code/pull/19); #20,
  [#21](https://github.com/adam-hanna/vibe-code/pull/21))
- **`codex.implementTimeoutMs`**, so a Codex role that writes gets the implementing figure
  rather than the reviewing one.
  ([#34](https://github.com/adam-hanna/vibe-code/pull/34))

### Fixed

- **Turns that escaped token accounting.** Session rotation, preflight probes and failed
  turns all spent tokens that no ceiling counted. All three now charge through the same
  seam, and a ceiling crossed by a failed turn is enforced before the retry.
  (#16, [#24](https://github.com/adam-hanna/vibe-code/pull/24),
  [#25](https://github.com/adam-hanna/vibe-code/pull/25),
  [#26](https://github.com/adam-hanna/vibe-code/pull/26))
- **A stall discarded the findings it had just paid for.** The guard threw between buying a
  critique and consuming it, so a resumed run re-entered at the turn that bought it and
  re-derived the same answer - 7.5M tokens, observed twice. The findings are now carried
  and consumed on resume.
  (#32, [#35](https://github.com/adam-hanna/vibe-code/pull/35),
  [#36](https://github.com/adam-hanna/vibe-code/pull/36))
- **The convergence guard could not see finding turnover.** A flat P1 count with completely
  different findings each round is convergence, not deadlock, and was being stopped as
  deadlock. A flat count now excuses one window when no finding survives it; a rising
  count, a persistent core and an alternating set all still stop the run.
  (#33, [#37](https://github.com/adam-hanna/vibe-code/pull/37))
- **Preflight enforced against the wrong thing.** It keyed off which agent was running
  rather than what that agent may do, so a Codex that could write was only warned about.
  (#13, [#17](https://github.com/adam-hanna/vibe-code/pull/17))
- **A single persistent finding ended runs that would have converged.** The stop became a
  report of the streak instead.
  (#3, [#11](https://github.com/adam-hanna/vibe-code/pull/11))
- **Context measurements had no model provenance**, so a ratio measured under one model
  could be read under another. Resume overrides are now persisted too.
  (#6, [#9](https://github.com/adam-hanna/vibe-code/pull/9))
- **Heartbeat liveness, flush boundary and rotation measurement.**
  (#8, [#10](https://github.com/adam-hanna/vibe-code/pull/10))

### Internal

Groundwork with no user-visible change, each shipped separately so that the role table
stayed hardcoded until the last step:

- One role-aware dispatch seam behind Claude and Codex turns.
  (#14, [#15](https://github.com/adam-hanna/vibe-code/pull/15))
- Six sites that inferred a role from a provider name now ask the role table.
  (#27, [#28](https://github.com/adam-hanna/vibe-code/pull/28))
- Both managed conversations given the same explicit lifecycle - an id, and a separate
  marker for whether a turn has ever succeeded on it.
  (#29, [#31](https://github.com/adam-hanna/vibe-code/pull/31))

### Upgrading

Nothing is required. To use the new capability:

```jsonc
{
  "roles": {
    "planner": "codex",      // claude | codex, per role
    "implementer": "codex",
    "critic": "claude",
    "answerer": "claude",
    "reviewer": "claude"
  },
  "codex": {
    "contextWindow": 200000, // null (default) reports tokens, never a ratio
    "implementTimeoutMs": 5400000,
    "persistSession": false  // required when a Codex role writes
  }
}
```

Two things to know before swapping roles. A writing Codex role is **refused** while
`codex.persistSession` is true, because `codex exec resume` takes no `-s` flag and every
resumed turn would silently revert to read-only. And with the implementer on Codex there is
no session rotation or compaction, because that thread has no rotation mechanism - the run
warns and continues.

Models and effort remain per provider (`claude.model`, `codex.model`), not per role.

## 1.0.1

First published release.
