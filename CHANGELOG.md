# Changelog

Notable changes per release. Versions follow [semver](https://semver.org): the minor
number moves for new capability, the patch number for fixes, and the major number only
for a change that breaks an existing config or an existing run.

Each entry links the pull request that made it and, where there is one, the issue it
closes.

## 1.9.0 - 2026-10-26

Fifteen pull requests since 1.8.0. **Nothing here breaks an existing config:** no key was renamed or removed, no flag was added or removed, and `PROTOCOL_VERSION` is still 2. One section was added to `vibe.config.json` (`critique`), one key under `review` (`maxParallel`), and one block name under `prompts` (`plan dispositions`). One default changed: a review now seats one cross-vendor finder when no settings file names `review.finders`, so a default run spends more. Upgrading says how much and how to turn it off.

The theme is the panel. 1.8.0 gave the review extra finders and a vote. 1.9.0 gives the plan critique the same, lets the seats of either run at once, records what the planner did with each critique finding, and makes one extra finder the default. The decisions were made on a bench built for them: 45 review loops on a throwaway TypeScript library, with planted bugs on some runs. The measurements are in the entries below.

### Added

- **Finders and a vote for the plan critique.** A new `critique` section takes the same keys as `review`: `finders`, `verifiers`, `quorum`, `unconfirmedP0` and `maxParallel`. Extra finders read the plan after `roles.critic`, findings they share are merged, and each blocking critique finding can be put to a fail-closed vote before it buys a plan revision. A P1 the vote does not confirm moves to P2: it goes to the implementer as a non-blocking finding under `loop.fixNonBlocking`, and into `FOLLOW-UPS.md` as *Unconfirmed by vote* either way. The section is in Settings, `vibe doctor`, the pre-run lines and the summary, and the Plan critique tab shows who found each finding and how the vote went. Both lists are empty by default, and then a run does what it did before. Nothing has measured how often a critique finding is wrong, so the docs make no claim about accuracy.
  (#405, [#451](https://github.com/adam-hanna/vibe-code/pull/451), [#456](https://github.com/adam-hanna/vibe-code/pull/456))
- **Finders and verifiers can run at once.** `review.maxParallel` and `critique.maxParallel` cap how many seat turns run together. `roles.reviewer` and `roles.critic` still go first, alone. Then the finders run together, and then every ballot of the round runs as one pool. Results are put in config order before they are merged and tallied, so every artifact is the same at any setting. When one seat fails, its live siblings are stopped, and Stop stops every live seat. The window draws each live seat, for example `verifiers voting · alpha: v1, v3 running`. Both default to `1`, which runs exactly as before. Codex reports no tokens until a turn ends, so concurrent Codex seats can pass `budget.maxTokens` by up to `maxParallel` turns. On a script with 200 ms turns and 13 seat turns, the round took 2,625 ms at 1, 1,411 ms at 2 and 857 ms at 4.
  (#403, #452, [#450](https://github.com/adam-hanna/vibe-code/pull/450), [#455](https://github.com/adam-hanna/vibe-code/pull/455))
- **A record of what the planner did with each critique finding.** A plan revision against findings now answers with a disposition for each one: fixed, rebutted, deferred or not addressed. Each is written to `plan-dispositions-<n>.json`, and the plan itself is unchanged. `vibe stats` has a new section that scores the critic by that record, as 1.8.0 scores the reviewer by the fixer. It is labelled *rebutted by the planner*, and it counts a rebutted finding the next critique raises again under the same id. A finder's renamed ids are not matched, so for those that count is low, and the scorecard says so. The Plan critique tab shows the planner's answer beside each finding, for example *planner: rebutted - <reason> (plan round 2)*. An answer that cannot be read records nothing for that round, and the plan stands. The prompt sentence is a new block, `plan dispositions`.
  (#453, #457, [#454](https://github.com/adam-hanna/vibe-code/pull/454), [#458](https://github.com/adam-hanna/vibe-code/pull/458))
- **Every finder's verdict on a change to the run's own judge is kept.** With finders seated, each seat that reports gives its verdict on each changed test file and on `vibe.config.json`. The file's verdict combines them and fails closed: not justified if any seat says so, unjudged if any seat left it unjudged, and justified only when every seat agrees. A finder that failed counts for nothing. The end-of-run warning names who said what, and how many files the seats disagreed on. As before, a verdict never blocks. Without finders, `state.json` and `code-review-<n>.json` are unchanged.
  (#404, [#459](https://github.com/adam-hanna/vibe-code/pull/459))
- **The fixer is told which findings from different seats may be one defect.** When the reviewer and a finder report under two ids and cite the same file within 3 lines, the fix prompt lists the pair under `## Findings that may be one defect`. It asks the fixer to fix a duplicate once and say which it duplicates. Nothing is merged: in 31 pairs measured on the bench and in the archive, 2 at a gap of one line were different defects, and a merge would have hidden one from the fixer. A fix turn with no such pair gets the prompt it always did.
  (#462, [#467](https://github.com/adam-hanna/vibe-code/pull/467))
- **Settle the run's assumptions in `NEEDS-INPUT.md`.** When a run stops for you while it is carrying questions it continued past on the planner's fallback, the file lists them under `## Assumptions the run is already making`, each with a `**Your decision:**` block. Write a decision to record it as your answer to that exact question: every later turn sees it, and `ASSUMED.md` stops calling it a guess. Leave it empty to keep the fallback. This works on every kind of stop, and it never replaces answering a blocking question. A partly filled block, a block for a question the run did not defer, or a `**Your answer:**` written inside the section stops the resume before anything is spent. `ASSUMED.md` now also ends with `## Your answers in this run`, listing your answers beside the assumptions without matching them, so you can see whether one already settles an assumption. The similarity threshold is unchanged: the rewording that prompted this scored 0.395, below the measured 0.6.
  (#465, [#471](https://github.com/adam-hanna/vibe-code/pull/471))

### Fixed

- **The reviewer no longer passes a test the run weakened as a new test.** A test file the run created is listed as *added* in every review round, so the reviewer judged it by "adding tests is not suspicious", even after a later fix round loosened it to agree with the code. The judge section now says that a test this run added and then changed is an edit, and tells the reviewer to read the file's history on the branch. On the bench's planted weakenings, the reviewer caught 3 of 4, against 0 of 4 before. It flagged none of 4 legitimate in-run edits. The one it missed did not read the history.
  (#463, [#468](https://github.com/adam-hanna/vibe-code/pull/468))
- **Text in `NEEDS-INPUT.md` can no longer steer how the resume reads it.** The resume reads the file by its markers, and most of the file is the agents' own words. A finding that quoted `**Your answer:**` sent a findings stop down the answers path, which then refused with *No answers found*. Of 501 findings in the archive and the bench, 5 did. Every marker in agent- or brief-written text now has its asterisks escaped, and a `#`, `>` or `*` at the start of a line gets a backslash. Both render the same to a reader. That covers the task, the stop message, the questions, the findings, the vote reasons and the severity-move section. Text holding none of these is written byte for byte as before.
  (#472, [#473](https://github.com/adam-hanna/vibe-code/pull/473))
- **The review seat tables fit in the Settings pane.** The pane is wider, and the tables no longer clip their minutes and remove columns. The role table's Codex model select no longer gives the pane a horizontal scroll. A finder's focus is a labelled text field with example phrases. A blank minutes field shows the inherited timeout and the key it comes from, and the quorum shows the count it resolves to, such as `2 of 3 (a majority)`. A quorum the core would refuse is marked beside the field. Removing verifiers below a saved quorum resets the quorum to a majority in the same save, and says so; before, the save was refused.
  (#448, [#449](https://github.com/adam-hanna/vibe-code/pull/449))

### Internal

- **The non-code evidence entries keep their field order.** #416 left the `external` and `absence` evidence entries ending on null fields. Across 152 Codex outputs since then (35 in this repo's archive, 117 on the bench), 62 such entries had no blank run before their content, and the longest blank run anywhere was 2. The schema stays as it is, and its comments say why.
  (#429, [#461](https://github.com/adam-hanna/vibe-code/pull/461))
- **The reviewer keeps its conversation across review rounds, and the other finders start fresh**, now as a decision rather than an open question. On the bench, the reviewer re-raised 2 of 12 later-round findings under the same id after they were fixed. A fresh finder never has the old id, so its re-raises cannot be counted, and the measurement cannot settle it. The default stays.
  (#435, [#466](https://github.com/adam-hanna/vibe-code/pull/466))
- **The review loop gets no stall detector.** On the bench, 45 review loops ran 1 to 3 rounds, and in every round the blocking ids were all new, so the plan loop's detector would never have fired on a review loop. #432 is closed without a change.

### Upgrading

- **A default review now has one extra finder, so it spends more.** With no `review.finders` in any settings file, the review seats one finder on the agent `roles.reviewer` is not on: Claude at effort `high` under the default roles, or Codex at `codex.effort` when the reviewer is on Claude, with no model named and a focus on error handling, fail-closed paths and tests that assert what the change claims. It costs one extra turn per diff part per review round. On the bench that measured it (45 review loops) it added 6.9M tokens to the reviewer's 29.6M, about 23%, and it caught 3 bugs the reviewer missed. There is still no vote by default. When every role is on one agent there is no default finder. A run started before this change resumes with the finders it stored, which is none. To opt out, set `"review": { "finders": [] }`. `vibe doctor` and the line before the first turn mark the default finder `(default)`, and the settings screen shows it, with a "use the default" control when a file names the list.
  (#447, [#470](https://github.com/adam-hanna/vibe-code/pull/470))
- **With that finder, three features that need finders are on by default:** the merged findings with who found them, the combined test-change verdicts with a `verdicts` field on each judge file, and the fix prompt's note on findings that may be one defect. A run with `"review": { "finders": [] }` has none of them.
- **A plan revision against critique findings sends a new output schema.** It is the plan's schema followed by a required `dispositions` array, and the stored plan has no new key. A revision against answers alone, and the first plan, send the schema they did before.
- **`NEEDS-INPUT.md` may show backslashes** where an agent's text started a line with `#`, `>` or `*`, or quoted one of the file's own markers. A Markdown viewer renders them away.
- **The host protocol gained fields and events, not a version.** `turn_started` carries `label` for a seat turn when `maxParallel` is above 1, and the loop records `plan_dispositions`, `plan_dispositions_unreadable`, `critique_rebuttal_disputed`, `critique_finder_failed`, `critique_finders_merged` and `critique_votes_tallied`. `test_changes_judged` may carry `seats` and `disagreed`. The window and the host ship together, so this matters only to something else speaking the protocol.

## 1.8.0 - 2026-10-23

Thirty-two pull requests since 1.7.1. **Nothing here breaks an existing config:** no key was renamed or removed, no flag was removed, and `PROTOCOL_VERSION` is still 2. Two sections were added to `vibe.config.json` (`review` and `updates`), two keys under `loop` (`stallAfter` and `fixNonBlocking`), four block names under `prompts` (`stall` and three for the pilot), and one flag (`--branch`). What a running setup can notice is listed under Upgrading.

The theme is the review. A review can now have more than one finder, and a blocking finding can be put to a vote before it blocks. The reviewer reads the repository's own `REVIEW.md`. What the fixer did with each finding is recorded and counted per reviewer seat, and a Codex answer that stalls at its output limit is retried instead of ending the run. Non-blocking findings of a passing review or plan critique are now worked on rather than dropped, and a plan loop that stops converging asks the planner to step back, then asks a person. Those last two are on by default, so a run can take a turn more than it did in 1.7.1; Upgrading says when.

### Added

- **More review finders, and a vote before a finding blocks.** A new `review` section takes `finders`, `verifiers`, `quorum` and `unconfirmedP0`. Each finder is an extra reviewer that reads the whole diff after `roles.reviewer`, optionally with a `focus`, and findings that two finders share are merged into one, with a note of who found them. Each P0 and P1 that no reproducer confirmed then goes to every verifier, a fresh read-only seat that sees one finding and votes `real`, `not-real` or `cannot-tell`. The tally fails closed: a finding blocks unless enough verifiers call it not real. An unconfirmed P1 moves to P2 and into FOLLOW-UPS. An unconfirmed P0 follows `unconfirmedP0`: `block` (the default), `demote`, or `halt` for a person to decide. The section is in Settings and `vibe doctor`, the summary gives what the finders and the vote cost in turns and tokens, and the findings pane shows who found a finding and how the vote went. With `finders` and `verifiers` empty, which is the default, a run does what it did before.
  (#388, [#395](https://github.com/adam-hanna/vibe-code/pull/395), [#401](https://github.com/adam-hanna/vibe-code/pull/401), [#406](https://github.com/adam-hanna/vibe-code/pull/406))
- **The summary names each blocking finding the review vote did not confirm.** Beside the `Votes:` line, a warning lists each finding the vote moved to `FOLLOW-UPS.md`, with its tally and the severity it had, or *votes unreadable* when the recorded votes do not add up. The list is built with the same filter as the file it points to, so the two cannot disagree. With no verifiers, or with every vote confirmed, nothing is printed.
  (#436, [#442](https://github.com/adam-hanna/vibe-code/pull/442))
- **The reviewer reads the repository's `REVIEW.md`.** The reviewer, every finder and the verifiers are given the `REVIEW.md` at the root of the repository, read from the commit the run started at and never from the working tree, so a run cannot weaken its own review. An edit to the file takes effect on the next run, and an edit made by a run shows as a judge-file change. A file that is a symlink or holds a stored key is refused rather than sent. `vibe doctor` and Settings show which `REVIEW.md` the next run would read. With no file, the review prompt is unchanged.
  (#389, [#417](https://github.com/adam-hanna/vibe-code/pull/417))
- **A record of what the fixer did with each finding.** A review fix turn now answers with a disposition for each finding: fixed, rebutted, deferred or not addressed. Each round writes `fix-dispositions-<n>.json`, the findings pane shows the outcome beside a finding, and `vibe stats` reports the outcomes per reviewer seat and by severity, each out of its total. A finding the fixer leaves out counts as not addressed. A reply that cannot be read records nothing for that round and says so; the turn is not failed. The figure is labelled *rebutted by the fixer*, not precision, because it is the fixer's judgement, not a measurement of whether the finding was real.
  (#393, [#407](https://github.com/adam-hanna/vibe-code/pull/407), [#411](https://github.com/adam-hanna/vibe-code/pull/411))
- **A passing review or plan critique no longer drops its non-blocking findings.** A finding that passed the gate and was not deferred, which in practice is every non-deferred P2 and P3, is now worked on. After a passing review with at least one such P2, the run takes one final fix round, the same round tolerated P1s already got: it is not re-reviewed, and the gates run after it. The fixer still judges each finding against the task, and whatever it did not fix goes into a new *Left by the final fix round* section of `FOLLOW-UPS.md` with its reason. A pass whose only such findings are P3s runs no turn, and they go straight to that section. A plan gets no extra round: an approved plan hands its non-blocking findings to the implementer in a *Non-blocking findings from the plan critique* section of the prompt. `loop.fixNonBlocking: false` turns both off.
  (#425, [#440](https://github.com/adam-hanna/vibe-code/pull/440))
- **The plan loop notices when it stops converging.** When the last `loop.stallAfter` critiques (3 by default) keep finding new blocking problems instead of fewer, the next revision asks the planner to step back, in a `## Stepping back` section of its prompt. A second stall since a person last steered stops the run with exit 2 and a `NEEDS-INPUT.md` that gives the counts and asks one question: narrow the brief, accept the remaining P1s, or continue. A stall is judged before convergence and wins over it, and `loop.maxPlanRounds` still ends the run with exit 3. The advice is a new prompt block, `stall`; the line of counts above it is written by code, so an edited block cannot drop the measurement. The detector counts the critiques' finding ids. Replayed over the archived runs with three or more critiques, it fires on two, which went 15 and 19 critiques, and on none of the others. Only the plan loop is checked; the review loop is #432. Settings → Limits shows `stallAfter` beside `maxPlanRounds`, and the summary prints `Step-backs:` when there was one.
  (#394, [#426](https://github.com/adam-hanna/vibe-code/pull/426), [#439](https://github.com/adam-hanna/vibe-code/pull/439))
- **`vibe run --branch <name>`, and the pilot names the branch.** `vibe run` and `vibe plan` take `--branch <name>` for the run's branch in place of `vibe/<run-id>`. git checks the name, and a name that is already a branch is refused before anything is created. The flag is refused on `vibe resume`, `vibe fork`, with `--no-branch`, with `git.useBranch` off and outside a git repository. In the app, the pilot proposes a branch name on its *run it* card; ask it for a different name and it proposes again. vibe enforces no naming convention; put yours in the pilot's prompt. This replaces the design note in `docs/plans/` where the planner would have renamed the branch.
  (#356, [#398](https://github.com/adam-hanna/vibe-code/pull/398), [#423](https://github.com/adam-hanna/vibe-code/pull/423))
- **The pilot's own prompt can be edited in Settings → Prompts.** Three of its blocks (*who*, *intake*, *how to read*) are listed under a **pilot** heading and edited the way the core blocks are, stored as `prompts."pilot: who"`, `prompts."pilot: intake"` and `prompts."pilot: how to read"`. The parts that describe the run, its sandbox and its tools stay built by code. An edited block replaces the built-in one whole and no longer receives later improvements to it; *use the default* brings them back.
  (#420, [#421](https://github.com/adam-hanna/vibe-code/pull/421))
- **The CLI says when a newer vibe is on npm.** A terminal `vibe run`, `vibe plan` or `vibe doctor` ends with one line when npm has a newer version. It checks at most once a day. It is off under `CI`, when stdout is not a terminal, with `VIBE_NO_UPDATE_CHECK=1` and with the new `updates.check: false`. The desktop app's host never runs it. See Upgrading for what is sent.
  (#323, [#419](https://github.com/adam-hanna/vibe-code/pull/419))
- **One macOS build for Apple Silicon and Intel.** The release carries a universal `Vibe-macos-universal.dmg`, so an Intel Mac no longer has to build from source. The same file is also uploaded as `Vibe-macos-arm64.dmg`, the name earlier pages link. Existing Apple Silicon installs update to the universal app in place.
  (#325, [#402](https://github.com/adam-hanna/vibe-code/pull/402))
- **The window says when a phone started a run or saved a setting.** A run started or resumed from a phone shows *Started from \<name\>* or *Resumed from \<name\>* above the Now card. A settings save from a phone shows *saved from \<name\>, and reread from the file*, and stays until the next save to that file.
  (#365, [#418](https://github.com/adam-hanna/vibe-code/pull/418))
- **The window shows where the run is.** While a verification gate runs, the Now card says *Verifying · Running the core gate* with a clock, instead of *between turns*, and Code is live on the run path. The tab of the running stage carries a pulsing mark, and the round in flight is drawn at the foot of its tab.
  (#409, [#413](https://github.com/adam-hanna/vibe-code/pull/413))
- **The docs describe the review stage as it now runs:** finders and the vote, what the fixer did with each finding, and `REVIEW.md`, in the README, `how-it-works.md`, `artifacts.md`, `exit-codes.md` and `app.md`. They also say that the reviewer keeps its conversation from round to round while the other finders start fresh each round. Whether that should change is still open, because no archived run has used finders yet.
  (#388, #389, #393, [#430](https://github.com/adam-hanna/vibe-code/pull/430), #435, [#443](https://github.com/adam-hanna/vibe-code/pull/443))

### Fixed

- **A Codex answer that stalls into blank space is retried.** A Codex answer could fill with blank space until it reached `max_output_tokens`, and the run ended with the turn's work lost. It happened twice in 16 hours. The finding, evidence and reproducer schemas now put the fields that are usually `null` before the content, which removes the spot where the stall started. If a read-only seat (critic, answerer, reviewer, finder or verifier) is cut off anyway, it is retried once on the same thread, unless a ceiling has been reached. Findings the cut-off answer wrote in full are passed to the retry as unverified, never acted on, laid out in the turn's own schema. A writer is never retried. Long runs of blank space are collapsed in the log. Each cut-off keeps its own record, `codex/<label>.cutoff.json` and then `.cutoff-2.json` and on, so a second cut-off no longer overwrites the first. When the turn sent no final message, or its last message was followed by more work, the error says so and quotes no count. A cut-off that a token ceiling stops says it was not tried again. An answerer's or verifier's retry note no longer mentions findings it never had.
  (#416, #429, [#424](https://github.com/adam-hanna/vibe-code/pull/424), [#431](https://github.com/adam-hanna/vibe-code/pull/431), [#434](https://github.com/adam-hanna/vibe-code/pull/434))
- **The first implementation is called *implementation*, and the window counts rounds from one.** The Code stage listed the first implementation as *unnumbered pass* while it ran and *round 0* in an opened run. The chips, cards and pane titles drew the archive's 0-based round while the terminal's headings count from one, so *round 0* in the window was `Plan critique (round 1)` in the terminal. Every round the window shows now counts from one, and a fix round reads *fix round N*, as `Implementing (fix round N)` does. The terminal's own revision line said `Plan round 1` just before `Plan critique (round 2)`; it now says `Plan round 2`. The pilot's wake sentence described every plan gate by the review count, so `plan-approved` read *round 0*; it now names the count of the gate it is held at.
  (#428, [#433](https://github.com/adam-hanna/vibe-code/pull/433))
- **An opened run's round card no longer says *tolerance P1≤0 · the gate blocked* for a review that passed.** A replayed census carries the counts alone, because `code-review-<n>.json` holds the report and not the gate's decision, and the window filled the missing tolerance with 0 and the missing decision with a block. A census that reported neither now draws no tolerance and no gate sentence, and the Review pane shows the judge's own verdict with its label. A live run's card is unchanged.
  (#437, [#441](https://github.com/adam-hanna/vibe-code/pull/441))
- **The pilot reads the run its conversation is about.** A read the pilot asked for while a run was going could settle after the run had ended, against a blank run, before the opened run's record had loaded. The pilot then reported an empty run and guessed it was still starting. Each conversation is now bound to its own run, by id and repository: the launch it made, the run it is filed under, or the run its draft became. `read_run` and `read_output` say which run they read, its state and how it ended. A read that comes before the record waits for it, and a conversation with no run says so and names the last run it started. With two runs in one window, each chat reads only its own.
  (#438, [#444](https://github.com/adam-hanna/vibe-code/pull/444))
- **Typing in the command palette no longer freezes the window.** The palette scored every run with cmdk's fuzzy matcher, whose cost grows steeply with the length of the text, and each run's text is its whole brief. It now matches by substring, case-insensitively. An out-of-order abbreviation that used to match no longer does.
  (#397, [#399](https://github.com/adam-hanna/vibe-code/pull/399))
- **An in-app update of a moved or deleted AppImage is offered as a download.** The app offered *Install* whenever `APPIMAGE` was set, and the install failed after the download, once the runs had been stopped, when the file it replaces had gone. It now offers *Install* only when that file is there and its folder is writable, and otherwise *Download*, with a sentence naming the path. It also asks again after the download and before any host is stopped.
  (#390, [#400](https://github.com/adam-hanna/vibe-code/pull/400))
- **A run whose process has gone is drawn as lost.** A run opened after its host died, for example after a reboot at a gate, showed its last turn running, with Pause and Stop that did nothing and no Resume. The window now asks the run's lock, as `vibe list` does, and draws a run with no live process the way it draws a dead host, with a button that opens the runs list where it can be reopened. A lock it cannot judge, such as one held on another machine, is still drawn as running.
  (#396, [#408](https://github.com/adam-hanna/vibe-code/pull/408))
- **A finished run offers the next run.** The top of a finished run's column said *waiting for the brief*, above the run that had just finished. A card after the run now says *Next run* and *This run has ended*; the empty column keeps its own wording.
  (#410, [#412](https://github.com/adam-hanna/vibe-code/pull/412))
- **A draft shows no counts from the last run.** While a new run was being drafted with the pilot, the tab bar kept the last run's Code, Verify and Questions counts and its token total. Each badge now counts what its pane draws, and the usage readout says *No run yet*. An opened past run's Code and Questions counts were wrong the same way, and are fixed too.
  (#414, [#415](https://github.com/adam-hanna/vibe-code/pull/415))
- **The README and the docs describe the role split as the default.** They said Claude plans and Codex critiques and reviews, as if that were how vibe works. Every role can be seated on either provider; the pages now describe the loop, then the default, and link `roles`. Several timeout and answerer descriptions in `docs/configuration.md` and `docs/cli.md` were corrected to what the code reads.
  ([#422](https://github.com/adam-hanna/vibe-code/pull/422))
- **`vibe --help` names the setting each timeout flag changes.** It described them by job. `--codex-timeout` sets `codex.timeoutMs`, which only read-only Codex turns use, `--plan-timeout` covers every read-only Claude turn, not only planning, and a role's own `timeoutMs` overrides all three flags.
  ([#427](https://github.com/adam-hanna/vibe-code/pull/427))

### Internal

- **A race in a Rust host test is fixed.** The test took the host's `deaf` frame as proof that nothing could read its stdin, but a child being forked on another test thread briefly holds a copy of every descriptor, and under full load it failed about 1 run in 10. It now waits for the kernel to report that the pipe has no reader. The same PR adds `scripts/replay-plan-stall.mjs`, which replays the stall detector over a run archive.
  (#394, [#426](https://github.com/adam-hanna/vibe-code/pull/426))
- **`REVIEW.md` at the root of this repository**, written from `AGENTS.md`'s code style and test rules, so this repo's own runs are reviewed against it.
  (#389, [#417](https://github.com/adam-hanna/vibe-code/pull/417))
- **A guard on network code in `src/`.** `tests/update-check-guard.test.ts` fails on any `fetch(` or network module outside `src/updatecheck.ts`, and `AGENTS.md` records the one exception to "no network code in the core".
  (#323, [#419](https://github.com/adam-hanna/vibe-code/pull/419))
- **Tested with claude `2.1.307`** (was `2.1.303`) and codex `0.163.0`, with a recorded fixture for each.

### Upgrading

- **The CLI now makes one network request of its own.** This changes the rule that every external call the core makes is a child process. At most once a day, a terminal `vibe run`, `vibe plan` or `vibe doctor` sends one GET to `https://registry.npmjs.org/@adam-hanna/vibe-code/latest`, with only an `Accept` header and no identifier, cookie or credential, and a 2-second timeout. The result is cached in `update-check.json` next to the global config. Turn it off with `updates.check: false` or `VIBE_NO_UPDATE_CHECK=1`; it is already off under `CI` and when stdout is not a terminal.
- **`loop.fixNonBlocking` is on by default, so a run can take one turn more than in 1.7.1.** A passing review with at least one non-deferred P2 now runs one final fix turn before the gates, where it used to end the review. That includes a P1 a guard moved to P2, because it was uncited or came from a review turn that ran nothing. A pass with only P3s runs no turn. Non-blocking findings the fixer did not fix, and the P3s of a pass with only P3s, are listed in `FOLLOW-UPS.md`, and an approved plan's non-blocking findings are now in the implementer's prompt. `loop.fixNonBlocking: false` restores 1.7.1: no extra turn, and nothing handed on.
- **`loop.stallAfter` is new, default 3.** A plan loop whose last three critiques keep finding new blocking problems now gets a step-back revision, and on a second stall it stops with exit 2 to ask you. `0` turns detection off. Neither new `loop` key has a CLI flag.
- **Demoting plan findings and resuming now approves the plan when the gate passes**, with no turn, instead of buying another revise-and-critique round. This applies to every plan stop, not only a stall. A plan-phase `NEEDS-INPUT.md` with a severity moved under *Change a severity* now resumes with the answer left empty. An answer written beside the moves still wins, and the plan is revised against it as before. The demoted findings go to the implementer as non-blocking findings, unless `loop.fixNonBlocking` is false. A stall that stops the run on the `maxPlanRounds` round asks its question too, so to raise the cap and carry on, answer *continue*.
- **The window counts rounds from one.** The first plan, critique and review are *round 1*, the first implementation is *implementation*, and the footer at the first plan gate says `plan 1 of 5`. File names, artifact links and the frames' `data.round` stay 0-based, so the *round 1* chip opens `plan-critique-0.json`. The terminal's plan revision line, and the census line an opened run is replayed with, moved up by one to match.
- **The end-of-run summary has new lines.** `Step-backs:` appears when the planner was asked to step back. A list of the blocking findings the vote did not confirm follows `Votes:`. After a final fix round for non-blocking findings, the summary says how many are in `FOLLOW-UPS.md`. A run where none of these happened prints the summary it did before.
- **A repository with a `REVIEW.md` at its root has it sent to the reviewer**, the finders and the verifiers, from the next run on. Rename or remove it if it was not written for that.
- **Runs started from the app's pilot now usually get a branch the pilot named**, not `vibe/<run-id>`: its prompt tells it to name one on every proposal, though the field is optional. The name is on the *run it* card before the run starts. A run started from a terminal without `--branch` still gets `vibe/<run-id>`. A `--branch` name that is already a branch stops the run with exit 6 before anything is created.
- **The command palette matches by substring**, not fuzzily.
- **The Codex output schemas list their fields in a new order** (finding, evidence entry and reproducer). No name, type or required field changed, and files from older runs still load, but something that reads those files by field position will see the change.
- **The macOS download is `Vibe-macos-universal.dmg`** and needs macOS 11.0 or later. `Vibe-macos-arm64.dmg` is the same file under the old name.
- **The host protocol gained fields, not a version.** The `replay` frame carries `liveness` and `lost`, `run_started` may carry `origin`, and there is a `review_md` read frame. The loop also records a new `plan_stalled` event, and `plan_approved` may carry `nonBlocking` and `byPerson`. The window and the host ship together, so this matters only to something else speaking the protocol.

## 1.7.1 - 2026-10-20

Seven pull requests since 1.7.0, all fixes. **Nothing here breaks an existing config:** no key was added, renamed or removed, and `PROTOCOL_VERSION` is still 2.

### Fixed

- **The app shows its own version.** The status bar, the diagnostics and the log read the Rust crate's `0.1.0`. They now read the version from `package.json`, the same place the installers and the updater take it from.
  (#336, [#380](https://github.com/adam-hanna/vibe-code/pull/380))
- **Settings for all projects opens on an install with no project.** The window asked the host for the configuration of an empty directory, and the host refused it, so a fresh install could not store a key or switch on remote access. A global read no longer needs a project, the project view says *add a project first*, and the parts of the screen that never read `vibe.config.json` draw without it.
  (#385, [#386](https://github.com/adam-hanna/vibe-code/pull/386))
- **Scrolling up while a reply streams stays where you put it.** The pilot chat and the run output decided from the scroll position alone whether to follow the end, and a streaming chunk could land between a scroll and its event and pull the view back. They now stop following on the intent to scroll up (a wheel, a key, a finger or the scrollbar), start again only when you scroll back to the end, and show a button that jumps there.
  (#366, [#384](https://github.com/adam-hanna/vibe-code/pull/384))
- **A local Linux build makes its AppImage again.** linuxdeploy's bundled `strip` cannot read the `.relr.dyn` sections newer distributions ship, so `npm run app:build` failed on Fedora 44. A local build now bundles unstripped; CI still strips.
  (#324, [#383](https://github.com/adam-hanna/vibe-code/pull/383))

### Internal

- **The phone launch checks run on every `v*` tag**, so an rc is checked on an emulator and a simulator before anybody installs it, not only on the release PR.
  (#378, [#382](https://github.com/adam-hanna/vibe-code/pull/382))
- **The back-merge from `main` into `develop` is a merge commit**, and the release checklist says why: a squashed back-merge made the next release PR conflict in 47 files.
  (#379, [#381](https://github.com/adam-hanna/vibe-code/pull/381))
- **`AGENTS.md` is a core under 32 KiB**, with the design notes moved word for word into `docs/agents/`. Claude Code warned that the file was too large to load, and Codex reads only the first 32 KiB.
  ([#387](https://github.com/adam-hanna/vibe-code/pull/387))
- **Tested with codex `0.163.0`** (was `0.157.1`) and claude `2.1.303`, with a recorded fixture for each.

## 1.7.0 - 2026-10-19

Seventeen pull requests since 1.6.1. **Nothing here breaks an existing config:** no key was renamed or removed, no flag was removed, and no key was added to `vibe.config.json`. What a running setup can notice is listed under Upgrading.

The theme is vibe on your phone. The release now carries an Android app and an iPhone app. A phone pairs with a desktop by scanning a QR code, reaches it by key over iroh wherever either one is, and draws the same cockpit, laid out for a phone: runs, gates, the pilot, settings and all. One phone can pair with several desktops, and one desktop with several phones. Remote access is off until you turn it on.

### Added

- **The phone apps.** A Tauri 2 shell for Android and iOS that draws the same cockpit as the desktop window, built from the same `app/src`. Its calls go to the desktop's own command bodies, so a phone can do what the window can.
  (#345, [#363](https://github.com/adam-hanna/vibe-code/pull/363))
- **Pairing a phone, and taking it back.** The desktop has a device key in the OS keychain and shows a QR code that expires after five minutes and works once. A scan still needs a yes on the desktop, so a photographed code is not enough. Either end can unpair, and a removed phone is refused before anything is read.
  (#341, [#360](https://github.com/adam-hanna/vibe-code/pull/360))
- **The desktop is reachable by key, wherever it is.** An iroh endpoint that a paired phone dials by the desktop's key, so a reboot or a new IP needs nothing from you. Only paired phones get past the handshake.
  (#342, [#361](https://github.com/adam-hanna/vibe-code/pull/361))
- **A phone is another window onto the hosts.** It joins a run that is already going and draws what the window draws, with no gap and no duplicate. Every client sees every answer, and the desktop stamps a phone's frames with its name, so a phone cannot claim to be the desktop.
  (#343, [#364](https://github.com/adam-hanna/vibe-code/pull/364))
- **Remote access has a switch, in Settings.** It is off by default. Beside it are start at login, keep the machine awake while a run is going, and an optional relay. A chip shows when a phone is connected, and diagnostics list each phone. Turning it off closes every phone's connection, and a phone can turn it off too.
  (#344, [#368](https://github.com/adam-hanna/vibe-code/pull/368))
- **Pair, connect and reconnect from the phone.** The phone scans the QR code, keeps a list of paired desktops and opens one at a time. It reconnects when it comes back to the foreground, when the network changes and when a connection drops, without drawing a run twice. Each way a connection can fail has its own sentence.
  (#346, [#371](https://github.com/adam-hanna/vibe-code/pull/371), [#374](https://github.com/adam-hanna/vibe-code/pull/374))
- **The cockpit laid out for a phone.** The side panels are sheets over the main pane, one at a time. The chrome fits on one row. A held gate is decided from a sheet. Commands, Settings, Diagnostics and *This phone* are screens of their own, and the folder chooser takes the whole screen. Each phone keeps its own place and text size.
  (#347, [#367](https://github.com/adam-hanna/vibe-code/pull/367), [#372](https://github.com/adam-hanna/vibe-code/pull/372))
- **A light palette**, for the desktop as well as the phone.
  (#347, [#372](https://github.com/adam-hanna/vibe-code/pull/372))
- **The phone apps are on the release, with no app store.** `Vibe-android.apk` is signed with the release key. `Vibe-ios-unsigned.ipa` is signed on your own machine through AltStore, SideStore or Sideloadly with a free Apple ID. Both carry attestations and are in `SHA256SUMS`. The new [docs/phone.md](docs/phone.md) covers installing, updating, pairing and moving between desktops, and the README has an "On your phone" section.
  (#348, #349, [#373](https://github.com/adam-hanna/vibe-code/pull/373), [#374](https://github.com/adam-hanna/vibe-code/pull/374))
- **Every write is announced to every client, and a run or a setting records who made it.** The service host sends `changed` after a memory, chat or config write, and each window and phone re-reads rather than overwriting. An invoke or a config write can carry an `origin`, recorded once on a run as `run_origin`.
  (#354, [#359](https://github.com/adam-hanna/vibe-code/pull/359))

### Fixed

- **The app no longer freezes when started from a terminal.** The login-shell probe ran `bash -l -i` in the app's process group, and an interactive bash in the background of a terminal stops its whole group with `SIGTTIN`. The window, the hosts and any running turn stopped until `fg` was typed. The probe now runs in its own session.
  (#357, [#358](https://github.com/adam-hanna/vibe-code/pull/358))

### Internal

- **The product spec and the engineering design for vibe on your phone**, in `docs/plans/`.
  (#338, [#353](https://github.com/adam-hanna/vibe-code/pull/353), #340, [#355](https://github.com/adam-hanna/vibe-code/pull/355))
- **CI runs on `main` and by hand, not on `develop`,** to save Actions minutes. The local gates are the check before a merge into `develop`.
  ([#369](https://github.com/adam-hanna/vibe-code/pull/369))
- **`develop` is the default branch.** Per-issue PRs close their issues, and the release PR lists them with `Refs`.
  ([#337](https://github.com/adam-hanna/vibe-code/pull/337))
- **The suite fails on two files that differ only in case.** `Pair.tsx` and `pair.ts` built on Linux and failed on macOS, Windows and iOS. `pair.ts` is now `pairing.ts`, and `tests/case-collisions.test.ts` guards every path.
  ([#375](https://github.com/adam-hanna/vibe-code/pull/375))
- **The APK signing step says what failed.** It had exited 1 in silence because build-tools 37's `apksigner` prints its signer lines differently.
  ([#374](https://github.com/adam-hanna/vibe-code/pull/374), [#375](https://github.com/adam-hanna/vibe-code/pull/375))
- **Tested with claude `2.1.303`** (was `2.1.294`) and codex `0.157.1`, with a recorded fixture for each.

### Upgrading

- **`PROTOCOL_VERSION` is 2.** The window and the host ship together in the app, so this matters only to something else speaking the host protocol, which must now expect `changed` frames.
- **Remote access is off until you turn it on** in Settings → Remote access. With it off, the desktop binds nothing and reaches no relay.
- **Install the APK fresh.** This is the first signed APK. A build you made yourself is signed with a different key, and Android will not update one with the other; uninstall it first.

## 1.6.1 - 2026-10-11

Two pull requests since 1.6.0, both fixes to the desktop builds. **Nothing here breaks an existing config.** 1.6.0 was published only as a pre-release, because its Linux AppImage and its macOS app did not work, so this is the first release of everything listed under 1.6.0 below.

### Fixed

- **The Linux AppImage draws its window on current distributions.** It bundled the build machine's (Ubuntu 22.04's) `libwayland-client`, `-cursor` and `-egl`. On Fedora, Arch and openSUSE Tumbleweed, WebKit could not create an EGL display against them with the system's newer Mesa, aborted, and left a white window over a running process. The release now repacks the AppImage without them and re-signs the update bundle. `libwayland-server` stays bundled.
  (#331, [#332](https://github.com/adam-hanna/vibe-code/pull/332))
- **The macOS app connects.** The bundled `node` is signed with the hardened runtime, and without `com.apple.security.cs.allow-jit` it died on its first line of JavaScript, so the window sat on `connecting` with "no host service is running". `bundle.macOS.entitlements` now grants that one entitlement.
  ([#333](https://github.com/adam-hanna/vibe-code/pull/333))

### Internal

- **The release checks its own builds before uploading them.** On Linux, `app/scripts/smoke-appimage.sh` launches the AppImage under Xvfb on Ubuntu 22.04 and 24.04, Debian 12, Fedora, Arch and openSUSE Tumbleweed, and fails on an abort, an early exit or a blank screen. On macOS, the release starts the host from the signed `.app` and fails unless it says `ready`, because `node --version` passed on the broken 1.6.0 bundle.
  (#331, [#332](https://github.com/adam-hanna/vibe-code/pull/332), [#333](https://github.com/adam-hanna/vibe-code/pull/333))

### Upgrading

- **If you installed the 1.6.0 pre-release, install 1.6.1 over it.** The broken 1.6.0 Linux and macOS apps may not be able to draw or reach the update control. A 1.6.0 macOS install that you want to keep can be repaired by hand: `codesign --force --deep -s - -o runtime --entitlements app/src-tauri/Entitlements.plist /Applications/Vibe.app`.
- **The AppImage now uses the system's `libwayland-client`, `-cursor` and `-egl`.** Every distribution that runs GTK 3 apps has them.

## 1.6.0 - 2026-10-09

Nine pull requests since 1.5.0. **Nothing here breaks an existing config:** no key was renamed or removed, no flag was removed, and no config key was added. Three behaviours a running setup can notice are listed under Upgrading.

The theme is shipping. The desktop app is now built by CI on every release tag, for Windows, macOS (Apple Silicon) and Linux. Each installer is downloadable under a name that never changes, carries a build attestation, and is listed in a checksums file. The app tells you when a newer version is out and can update itself. The long-form docs are a site on GitHub Pages, and vibe now checks the `claude` and `codex` CLIs against the versions it was tested with.

### Added

- **The desktop app is a download.** On every `v*` tag, `release.yml` builds the `.msi` and NSIS `.exe` on Windows, the `.dmg` on macOS (Apple Silicon) and the `.deb` and `.AppImage` on Linux into one draft release. Each installer is uploaded under its versioned name and a stable name (`Vibe-macos-arm64.dmg`, `Vibe-windows-x64-setup.exe`, `Vibe-windows-x64.msi`, `Vibe-linux-x86_64.AppImage`, `Vibe-linux-amd64.deb`), so `releases/latest/download/<name>` always serves the newest. Bundles carry the CLI's version. Windows builds are unsigned and macOS builds are ad-hoc signed until certificates are added as secrets.
  (#239, [#316](https://github.com/adam-hanna/vibe-code/pull/316), [#318](https://github.com/adam-hanna/vibe-code/pull/318))
- **The app tells you when a new version is out, and updates and restarts itself.** A ⬆ tool appears above ⚙ when an update exists, with the version, notes, **Update & restart** and **Skip this version**. It checks at launch and every 6 hours. Updates are signed and checked against a public key built into the app. A `.deb` install is offered **Download** instead, and runs going are confirmed and stopped resumably before an install. Settings has a toggle to turn the check off.
  (#299, [#327](https://github.com/adam-hanna/vibe-code/pull/327))
- **Every release can be verified.** Each file gets a build provenance attestation (`gh attestation verify <file> --repo adam-hanna/vibe-code`), and a `SHA256SUMS` file lists every asset. `docs/app.md` says how to check a download on each platform, and prints the updater's public key.
  (#317, [#326](https://github.com/adam-hanna/vibe-code/pull/326))
- **vibe checks the agent CLIs against the versions it was tested with.** `TESTED_CLI_VERSIONS` records claude `2.1.294` and codex `0.157.1`. Preflight and `vibe doctor` warn, and name the command to move, when an installed CLI differs. A run is refused only when a CLI's own `--help` shows a flag vibe passes is missing. Each run records the versions it ran under, and a resume under different versions records the change.
  (#298, [#314](https://github.com/adam-hanna/vibe-code/pull/314))
- **A docs site.** The long-form docs are a VitePress site at https://adam-hanna.github.io/vibe-code/, deployed from `main`. It covers getting started, the CLI and configuration references, the app, the loop, artifacts, exit codes and design notes.
  (#230, [#308](https://github.com/adam-hanna/vibe-code/pull/308), [#315](https://github.com/adam-hanna/vibe-code/pull/315))

### Fixed

- **While a new run is being drafted, Code, Verify and Spend say there is no run,** instead of showing the previous run.
  (#319, [#321](https://github.com/adam-hanna/vibe-code/pull/321))
- **The pilot chat's copy buttons are at the foot of each message,** so a long message no longer has to be scrolled back up to copy it.
  (#320, [#322](https://github.com/adam-hanna/vibe-code/pull/322))
- **The app reads your whole login environment when your shell is `dash`.** `dash` exports `_` as the opening marker, which cut the environment off mid-list, leaving no `PATH`. It hit anyone whose login shell is `/bin/sh` on Debian or Ubuntu, or whose `SHELL` is unset.
  (#239, [#316](https://github.com/adam-hanna/vibe-code/pull/316))

### Internal

- **CI.** `ci.yml` runs the core gate, the app gate and the Rust tests on every push and PR into `develop` and `main`. Five test files that passed only where `claude` and `codex` were installed now pin both to `process.execPath`.
  (#239, [#316](https://github.com/adam-hanna/vibe-code/pull/316))
- **Contract tests over recorded CLI output.** `scripts/record-cli-fixtures.mjs` records one real turn of each CLI, and `cli-fixtures-contract.test.ts` runs the recordings through the real parsers.
  (#298, [#314](https://github.com/adam-hanna/vibe-code/pull/314))
- **Tests pin the docs to the source:** every config key, exit code and command must appear in the reference pages, download links must match the names the workflow uploads, and the published public key must match the app's.
  (#230, [#308](https://github.com/adam-hanna/vibe-code/pull/308), [#316](https://github.com/adam-hanna/vibe-code/pull/316), [#326](https://github.com/adam-hanna/vibe-code/pull/326))

### Upgrading

No config change is required. Three behaviours a running setup can notice:

- **Preflight and `vibe doctor` may warn about your CLI versions.** A `claude` or `codex` other than the tested version warns and still runs. A run now stops before its first turn if the CLI's help no longer lists a flag vibe passes.
- **The desktop app makes a network request of its own.** It fetches `releases/latest/download/latest.json` from GitHub at launch and every 6 hours, a plain HTTPS GET with no identifiers. Turn it off with **Check for updates** in Settings. The CLI still makes no network call of its own.
- **This is the first release whose app can update itself,** so an app built from an earlier version has no updater and must be replaced by hand once.

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
