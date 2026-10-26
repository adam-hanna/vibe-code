# How the loop works

vibe runs two phases. In **planning**, the planner writes a plan and the critic attacks it, until the plan has no blocking findings. In **implementation**, the implementer writes the code, vibe runs your verification gates itself, and the reviewer reviews the diff, until that has no blocking findings either. A fifth role, the answerer, answers the planner's questions.

By default Claude is the planner and the implementer, and Codex is the critic, the answerer and the reviewer. Each role can be seated on either Claude or Codex, with its own model and effort; which agent holds each job is the [role table](./configuration#roles). The review can also seat more finders and verifiers, under [`review`](./configuration#review), and so can the plan critique, under [`critique`](./configuration#critique); see [More finders, and a vote](#more-finders-and-a-vote).

Under the default table the planner plans in Claude's read-only plan mode, and the implementer then resumes **the same session** with permissions bypassed, so it starts with the plan and the whole investigation in context. An implementer that does not share the planner's conversation, such as one on Codex, starts without that history and works from the approved plan, which every implement prompt carries. Either way implementation writes to your checkout, which is also why vibe works on a branch of its own.

## Severities, and when a phase moves on

Both CLIs are pinned to JSON schemas, so every finding has a typed severity and a stable id, and the loop never decides anything by reading prose.

| Severity | Meaning |
|---|---|
| P0 | Unshippable. Always blocks, however few there are, and is never carried forward. A failing verification gate is filed as a P0. |
| P1 | Blocking, but a phase may carry up to `loop.p1Tolerance` of them (default 1) instead of fixing them. |
| P2, P3 | Never block. |

A phase moves on when there are **no P0s and at most `loop.p1Tolerance` P1s.** The tolerance exists because demanding a spotless verdict is unmeetable on hard work: one plan went eight rounds without reaching implementation, every finding legitimate and every one answerable by a test suite nobody had run yet.

A P1 carried out of planning goes into the implementation prompt as a known open issue. A P1 carried out of review gets one final fix round, which is committed and re-verified but deliberately not re-reviewed, because a fresh review could reopen the argument the tolerance just settled. Those findings are listed in `OUTSTANDING.md` as worked on but unconfirmed.

A pass is not the end of the non-blocking findings. A review that passes with a P2 it did not defer gets the same one final fix round, also not reviewed again. The fixer fixes what belongs to the task and says what it did with each finding; whatever it did not fix goes to `FOLLOW-UPS.md` with its reason. A pass whose only such findings are P3s runs no round and records them there. A plan that passes hands its non-deferred P2s and P3s to the implementer, to address what belongs to the task. Deferred findings go to `FOLLOW-UPS.md` either way. `loop.fixNonBlocking: false` turns this off.

## A plan says how you would know it worked

Every plan carries **acceptance criteria**: each has an id, the observable criterion, the kind of check that settles it, and how to run it. A revision restates the whole list, so dropping a criterion is visible and has to be explained.

The criteria are **frozen when the plan is approved**. The implementer and the reviewer both work against that copy, so the bar cannot be quietly lowered later. The implementer's report is keyed to the same ids, so a reviewer can check a claim against the criterion it answers.

## Why the loop terminates

The brakes are independent, and any one of them can stop a run:

| Brake | What it does |
|---|---|
| **Round caps** | `loop.maxPlanRounds` and `loop.maxReviewRounds` (5 each) and `loop.maxVerifyRounds` (3). Verification fixes have their own counter, so a stubborn test suite cannot use up the reviewer's rounds. Exit 3. |
| **Question rounds** | `loop.maxQuestionRounds` (3) bounds how many times the planner may answer its own questions. A question round does not use up a plan round. A planner still asking after the cap stops the run for you to answer them directly: exit 2, not 3, because what is missing is a decision rather than agreement. |
| **Oscillation** | The set of blocking finding ids is fingerprinted every round. The same set `loop.oscillationThreshold` rounds running (3) means nothing new is being produced. Exit 3. |
| **Convergence trend** | Late in the round budget, over the last `loop.convergenceWindow` rounds, a blocking count that is not falling stops the run. A flat count whose findings keep changing is work being done, and is allowed one more window. Exit 3. |
| **Plan stall** | In the plan loop, from `loop.stallAfter` (3) critiques on: when the number of blocking findings is not falling and most of them are new, the critic is finding new problems faster than old ones go away. The first time, the run does not stop: the planner is told the counts and asked to step back and reconsider its approach. The next time, the run stops and asks you (exit 2). See [A plan loop that stops converging](#a-plan-loop-that-stops-converging). |
| **Persistent finding** | A single finding that keeps coming back while the rest change is **reported, not stopped on**. Persistence is not evidence that it cannot be fixed. |
| **Plan share** | Planning may use at most `budget.planShare` (40%) of the token ceiling. Planning that will not converge is the most expensive way to fail, because it produces nothing. Exit 4. |
| **Token ceiling** | `budget.maxTokens` (25M), counted across both agents. Checked as each turn is charged (exit 4), and also during a turn: a single runaway turn that crosses it is stopped, and the run ends as a stopped turn does (exit 2). |
| **Cost ceiling** | `budget.maxCostUsd` ($25 API-equivalent), Claude only, since Codex reports no cost. Exit 4. |
| **Quiet turn** | A turn that produces no output for `progress.maxQuietMs` (10 minutes) is stopped and the run ends resumably. A healthy turn is rarely silent for more than a few minutes. Exit 2. |
| **Rate limits** | When Claude's window is reached, the run waits for the reset, up to `budget.maxWaitMinutes`. Before each Codex turn vibe reads Codex's window, waits if it is reached, and stops resumably at `budget.codexLimitPercent` (95%) rather than start a turn the window would cut off. Exit 5. |

Every one of these exits resumably. Raise the cap or ceiling (in `vibe.config.json`, or with a flag) and `vibe resume`.

### A plan loop that stops converging

Two long plan loops in vibe's own history went this way. The critic found new blocking problems almost every round. Each time the run stopped, the only lever offered was "raise the limit". That changes nothing about what the planner does, so they stopped again.

vibe now notices this shape, a blocking count that is not falling and is mostly new, and responds in two steps:

1. **It asks the planner to step back.** The next revision is told how many blocking findings each of the last three critiques found and how many were new. It is asked to say what they have in common and to reconsider the approach rather than patch each one. If the brief itself is the problem, the planner is asked to say so in its open questions. The instruction is the `stall` prompt block, and you can replace it; the counts are always kept.
2. **If that changes nothing, it asks you.** The run stops with exit 2, and `NEEDS-INPUT.md` gives the counts since the step-back, lists the outstanding findings, and asks one question with three answers:
   - **Narrow the brief**: write what to narrow it to. The planner receives it.
   - **Continue**: write that, with any steer. The planner receives it.
   - **Accept the remaining P1s**: demote each finding under *Change a severity* and leave the answer empty, then `vibe resume`. The plan is approved when the demoted findings pass the gate, with no further revision or critique (see [Moving a severity](#moving-a-severity)).

Whatever you answer, the round after the resume is not judged, so your steer gets a full round to work. The next stall after that asks the planner to step back again. `loop.stallAfter: 0` turns all of this off. On the round where `loop.maxPlanRounds` is reached, the cap still stops the run (exit 3), and the file still asks the question.

One failed turn is not a brake, and is tried again once. A Codex critique, answer, review or vote whose answer was cut off at its output limit, before it was whole, runs again on the same conversation. The retry is told which findings the cut-off attempt had written, as unverified. The run log warns when this happens, and the summary counts it. A turn that writes code is never retried, because it may already have edited files. A second cut-off fails the turn, as one did before. A cut-off answer is never used as the turn's verdict.

## Verification gates

The loop used to finish when the reviewer found nothing, which is a statement about reading, not about working. So vibe runs your project's own commands itself rather than believing a report about them. With no configuration, the gate is `npm test` if `package.json` has a `test` script. Configure more with [`verify.gates`](./configuration#named-gates).

A gate runs `verify.runs` times (default 3), because the first run that reached implementation shipped a concurrency fix that failed about half the time, and a single green run had called it working.

### Flaky versus failing

When a gate fails, vibe runs the remaining attempts, and classifies the result:

| Verdict | What happened |
|---|---|
| **failing** | It failed every attempt: a defect. |
| **flaky** | The same command, on the same tree, both passed and failed. The outcome depends on something other than the code. |
| **unrun** | It never ran. |

The fixer is told which. A flaky gate is described as not deterministic, and the fixer is told to find the ordering, the shared port, the clock or the unawaited promise, and **not** to loosen the assertion, add a retry or add a sleep. Those all turn the gate green while leaving the race in the product. A flaky gate still blocks.

Passing costs nothing extra: three green runs stop as before. A command that could not start at all is not retried.

The full output of every attempt that did not pass is kept in the run directory, and the fixer is shown the start and the end of it and told where the full log is. vibe reads exit codes and parses no test reporter, so the verdict is about the whole gate, not which test.

A gate with no command is **unavailable**. If it is required, the run finishes with exit 7: the work is done and reviewed, but nothing showed that it runs.

## Findings and evidence

### A finding has to cite something

Every finding carries `evidence`: at least one entry saying what kind of claim it makes, and where.

| Kind | Cites | Checked against |
|---|---|---|
| `code` | a file, optionally a line and an excerpt | the repository: the file exists, the line is inside it, the excerpt appears in it |
| `artifact` | a run artifact such as `PLAN.md` | the run directory |
| `absence` | the file or directory something is missing from | the repository: that the place exists |
| `external` | a URL, a spec, another tool's behaviour | nothing |

**A P0 or P1 whose evidence does not resolve is downgraded to P2.** It stops forcing a round, but it is kept, with the reason, and may still be right. The check is that a finding is grounded, not that it is correct.

### And the turn that raised it has to have looked

Every turn records how many things it did, and how many of those were tool uses. **A P0 or P1 from a review turn that used no tools at all is downgraded to P2** in the same way: a reviewer that read nothing can still cite a file that exists. This inert-turn guard does not apply to the plan critic, whose job is to read the plan, or to a turn nothing measured.

### Reproducers

Neither guard can tell whether a finding is **true**. So a reviewer may attach a **reproducer**: a test file that fails because of the defect it describes, and would pass once it is fixed.

The reviewer supplies a path and the file's contents, never a command. vibe writes the file, runs **your own configured gate, unchanged**, and removes the file again; a copy is kept in the run directory. The reviewer only chooses which of your gates runs it.

| Outcome | Result |
|---|---|
| The reproducer failed, on a tree the gate had just passed | Reproduced: the defect is real. |
| The reproducer passed against the unfixed code | Did not reproduce: downgraded to P2. |
| Anything else | Unproven: nothing changes. |

A reproducer that failed before a final fix and passes after it closes the finding by evidence, and `OUTSTANDING.md` says so. `verify.reproducers: false` turns this off.

### More finders, and a vote

By default one reviewer reviews each round. [`review`](./configuration#review) can add two kinds of seat, each on Claude or Codex with its own model and effort, and each a fresh, read-only turn that never resumes a conversation:

- **Finders** review the same diff after the reviewer, each without seeing what the others found. Their findings are merged by claim: two findings are one defect when they cite the same file and line or say the same thing in their titles, and otherwise both are kept. A finder whose turn fails, other than by a stop or a ceiling, contributes nothing, and the round goes on with the rest.

  The reviewer keeps its conversation from round to round, so it remembers what it raised and how the fixer answered; the other finders start fresh every round, which makes them more independent of earlier rounds. A Codex reviewer keeps its thread under `codex.persistSession`, and with that off (`--no-codex-session`) it starts fresh too, as every Codex role then does. A Claude reviewer shares the planner's and implementer's session, and no setting changes that. See [what the reviewer remembers](./configuration#review).
- **Verifiers** vote on each P0 and P1 once the findings are merged and any reproducers have run. A finding whose own reproducer reproduced blocks without a vote. Each verifier sees the claim, the plan, the parts of the diff the claim cites and the repository, never who raised it or how the others voted, and answers `real`, `not-real` or `cannot-tell`.

The vote is fail-closed. A finding is confirmed when `review.quorum` verifiers say `real` (a majority, by default). It is unconfirmed only when enough say `not-real` that the quorum is out of reach. Otherwise it is undecided and keeps blocking. A verifier whose turn failed counts as `cannot-tell`, so too few usable votes never let a finding through. An unconfirmed P1 is moved to P2 with the tally as its reason, and listed in `FOLLOW-UPS.md`. An unconfirmed P0 keeps blocking by default; `review.unconfirmedP0` can instead stop the run for you (exit 2) or move it to P2. Every vote is recorded on its finding in `code-review-<n>.json`.

By default the finders run one after another, and so do the votes. Set `review.maxParallel` to let up to that many finder or verifier turns run at once: the reviewer still goes first and alone, and the round records the same findings and votes in the same order whichever turn finishes first. See [running seats at once](./configuration#review) for what it costs against the token ceiling.

Both cost turns inside `budget.maxTokens`, and the run summary's `Finders:` and `Votes:` lines say what they cost in turns and tokens. Beside the `Votes:` line, the summary names each blocking finding the vote did not confirm: its id, its title, how many verifiers did not confirm it (for example *2 of 3 verifier(s) did not confirm*, with the `not-real` and `cannot-tell` counts and the quorum), the severity it had, and the path to `FOLLOW-UPS.md`. The tally is read from the votes recorded on the finding; if they cannot be read, the line says *votes unreadable* instead of giving a count. A run with no verifiers, or one where every vote confirmed, prints nothing extra.

#### For the plan critique

[`critique`](./configuration#critique) seats the same two kinds for the plan, as a panel of its own, and is empty by default. In each plan round the critic critiques the plan first; then each finder critiques the same plan, one turn per finder per round, and their findings are merged as the review's are; then every P0 and P1 goes to each verifier. A verifier sees the claim, the task, the plan with its assumptions, scope and acceptance criteria, and the repository, and is asked whether the defect exists in this plan, not how severe it is. Only then is `plan-critique-<n>.json` written and the gate asked, so the gate, `loop.p1Tolerance`, the stall check and `loop.maxPlanRounds` all see what the vote left blocking. A P1 the vote did not confirm is moved to P2: the next revision is shown it as non-blocking with its tally, an approved plan hands it to the implementer under `loop.fixNonBlocking`, and it is listed in `FOLLOW-UPS.md` as unconfirmed by vote. Under `critique.unconfirmedP0: "halt"` the run stops for you; leave the P0 alone and the resume revises the plan, or demote it and the resume approves the plan if the gate then passes.

A critique finder starts fresh every round, as a review finder does, and every round's vote is fresh: a finding raised again in a later round is voted on again, by verifiers that know nothing of the earlier tally. Finder and verifier turns are not plan rounds, and they cost turns inside `budget.maxTokens`; the summary's `Critique finders:` and `Critique votes:` lines say how many and how many tokens. They run one after another by default; `critique.maxParallel`, the critique's own setting and not the review's, lets up to that many run at once, as `review.maxParallel` does for the review.

### What the fixer did with each finding

A review fix round, including the final one, returns its report and, for every finding it was given, one of `fixed`, `rebutted`, `deferred` or `not-addressed`, with a reason. A finding it leaves out is recorded as `not-addressed`. The answers go in `fix-dispositions-<n>.json`, credited to the seats that raised each finding. If the answer cannot be read, nothing is recorded for that round, rather than recording every finding as ignored, and the run log says so. The report itself is kept and handed to the next reviewer as before.

`vibe stats` totals these per reviewer seat and by severity, and the app shows each finding's outcome in the Code review tab. A `rebutted` is what the fixer said, not a verdict on the finding.

### What the planner did with each critique finding

A plan revision that answers a critique returns the revised plan and, for every finding it was shown, one of `fixed`, `rebutted`, `deferred` or `not-addressed`, with a reason. A rebuttal is still explained in the plan itself, because the plan is what the implementer reads. The answers go in `plan-dispositions-<n>.json`, credited to the seats that raised each finding and carrying the finding's vote outcome when [critique verifiers](./configuration#critique) voted on it. `plan-<n>.json` is the plan alone, as before. If the answers cannot be read, the plan is kept and nothing is recorded for that revision. A revision that answers only the planner's own questions is not asked.

When the next critique raises a rebutted finding again under the same id, the run records it as disputed. `vibe stats` totals the planner's answers per critic seat, by severity and by vote outcome, and says how many rebutted findings were raised again. That count only notices the same id: a finding raised again under a new id, which a critique finder's always is, is not noticed, so it undercounts. A `rebutted` is what the planner said, not a verdict on the finding. The app does not show these yet.

### Changes to the run's own judge

The tests and `vibe.config.json` decide whether a run passed, so a round that edits them is grading its own work. When a round changes a file matching `verify.testPaths`, or `vibe.config.json`, the reviewer is shown each one and must say whether the change was justified. A change is justified only when the test's claim is no longer the contract, and never because it makes the gate pass. A test file the run itself added counts as an edit too when a later round changes it: the reviewer is told to read its history on the branch, so a fix round that loosens a test it wrote earlier is judged like any other edit. Each file's status, its lines added and removed, and the verdict are recorded in `state.json` and the round's `code-review-<n>.json`. A file the reviewer did not address is recorded as `unjudged`. None of this stops the run, but the end-of-run summary names any file that was not judged justified.

### The repository's review standards (REVIEW.md)

A `REVIEW.md` at the root of your repository is how its owners add their own standards to the review: the things a reviewer should flag here that it would not flag everywhere. Examples: an invented number is a P1, or a finding about behaviour must cite a file and line.

- **It is read from the commit the run started at, never the working tree.** That is the commit recorded as `state.start`, or the diff base when the run has no start. A run that adds or edits `REVIEW.md` changes the next run's review, never its own, so a change cannot weaken the review it is about to get.
- **Only `REVIEW.md` at the root counts.** A `review.md`, or a `REVIEW.md` in a subdirectory, is not read.
- **Some files are refused rather than read.** A `REVIEW.md` committed as a symbolic link or a submodule is refused, because following the link would read a file that was never committed as `REVIEW.md`. So is one that contains an API key vibe holds. One that git cannot read is warned about and skipped. In each case the run log and the end-of-run summary say so, and the review goes ahead without it.
- **The reviewer, every additional finder and the verifiers get it.** No other role does: not the planner, the critic, the implementer, the fixer or the answerer. Verifiers are told that any severity rules in it are not their question.
- **It adds to vibe's own review instructions and never replaces them.** It is placed after them, under a heading that names it as the repository's. Replacing vibe's text is still `prompts.<block>`, which is separate and does not touch `REVIEW.md`.
- **It is a judge file.** Like `vibe.config.json`, a round that edits it is shown to the reviewer, which must say whether the plan called for the change.
- **It is sent whole, with no cap.** Over 32 KiB, the run log, the summary and `vibe doctor` warn that it is long. That is a warning, not a limit.

`vibe doctor` and the note under the reviewer's settings only preview `REVIEW.md` at the commit the *next* run would start from: `git.baseRef` if set, else `HEAD`. A run reads it from the commit it actually starts at.

- `vibe doctor` fetches a remote-tracking `git.baseRef` first, as the run would.
- The settings note never fetches, so for a remote-tracking ref it says "as last fetched".

### Raising a finding yourself

Every `NEEDS-INPUT.md` ends with a **Raise a finding** block. Fill it in and resume, and your finding enters the loop like a reviewer's:

- It is **grounded**: give it a `*File:*` citation such as `src/run.ts:120` if you want a P0 or P1 to block. Without one it is carried as P2, exactly as a reviewer's would be.
- The inert-turn guard does not apply, because there is no turn behind it.
- The gate counts it, so you can block your own run.
- It is attributed to you, and the fixer is told it came from you.

A block left partly filled in stops the resume and says what is missing. Nothing is spent until it is complete.

### Moving a severity

The same file lists the findings the next round will act on, each with a `*Move to:*` line. Write `P0`, `P1`, `P2` or `P3`, and why, and the severity moves.

This is how you overrule a guard. Both guards are deliberately blunt, so a finding that was right but cited a file from memory is downgraded for the same reason a wrong one is, and only you can tell them apart. The guard's own record is never rewritten, and the fixer is told both: that the severity is deliberate, and why the guard fired. A restored P0 blocks whatever `loop.p1Tolerance` says.

**On a plan stop, demoting is accepting.** If the findings you leave after demoting pass the gate (no P0, and no more P1s than `loop.p1Tolerance`), `vibe resume` approves the plan straight away. It does not revise and critique it again. Any P1s within the tolerance are carried into implementation, as on any approval. The answer blocks can stay empty. If you also write an answer, the answer wins: the plan is revised against it and critiqued as usual, and nothing is approved on the strength of the demotion. A plain resume, with nothing moved, revises and critiques as before. On a review or verification stop, a move changes the severity the next round acts on, as before.

## Questions

A headless planner cannot ask you anything, so vibe makes its questions data: the plan must list its open questions and the assumptions it made.

1. **Non-blocking questions** proceed on the planner's own recommended answer. The choice is recorded as an assumption, and the critic is pointed at it, so a wrong assumption comes back as a finding.
2. **Blocking questions** go to the answerer (Codex, by default) first, which reads the code and answers what it can.
3. **Anything the answerer will not guess**, such as product intent, priorities or taste, comes to you, and so does any answer it gives with low confidence. The run exits 2 with the questions in `NEEDS-INPUT.md`.

A round of answered questions does not use up one of the plan's critique rounds; `loop.maxQuestionRounds` bounds it separately. A question that only rephrases one already answered is not asked again, and `REPHRASED.md` records each such match so you can check it. The [`questions`](./configuration#questions) settings change who is asked.

## Context compaction

`/compact` does not work in headless mode: it is a Claude Code command, not something a model can be told to do. So vibe compacts explicitly. After every Claude turn it reads the prompt's real size against the model's context window. Once that passes `context.compactAboveRatio` (half, by default), it:

1. asks the outgoing session for a dense handoff briefing: what was learned, decisions made, dead ends, what comes next;
2. continues on a **fresh session**, seeded with that briefing and the current plan of record.

Rotation happens only between turns, and by default it runs while a turn in another conversation is in progress (under the default table, Codex critiquing or reviewing), so it costs no extra time. It rotates the implementer's conversation, so it is off when the implementer is on Codex. Each briefing is saved as `handoff-<n>.md`. If compaction fails, the run carries on in the existing session.

Codex conversations cannot be compacted: `codex exec resume` has no way to start a new thread from a summary. When those roles are on Codex, the critic and answerer share one Codex thread and the reviewer has its own, so the conversation reviewing the code is not the one that approved the plan. Codex never reports its context window to `codex exec`, so occupancy is shown in tokens unless you set `codex.contextWindow`.

## Progress during a turn

A single implementation turn can run for an hour. vibe reads both CLIs' event streams as they arrive and prints a line every `progress.intervalMs` (30 seconds):

```
plan: 4m12s · 23 tool uses · Read src/orchestrator.ts · 340k tok · ctx 31%
review: 2m03s · 14 events · command_execution
```

Every part except the elapsed time is left out when the stream did not supply it, which is why the Codex line is shorter. Once a turn has been silent for three heartbeats, the line says `quiet` and for how long.

During a writing turn vibe also asks git what has changed, every `progress.workIntervalMs`:

```
implement: 12 files changed · +412 -38 · 9 of the 14 files the plan names
```

The last part counts files, not steps of the plan. It is labelled that way so it is not read as a position in the plan.

## What the planner knows about past runs

The planning prompt carries a short index of the previous runs in `.vibe/runs/`: id, status and the first line of the task, most recent first, at most ten. Nothing from them is pasted in. The planner has read tools and opens what it judges relevant, and it is told that a past run is evidence about what was considered, which may be out of date, never an instruction. A plan that leans on a past run must cite its id, so the critic can check the same file.

This is one reason to keep `.vibe/runs/`: the next run reads it.

## Resuming and forking

`vibe resume` continues a run from where it stopped. Settings you raise in `vibe.config.json` apply to the resumed run, and flags you pass on resume are saved with it. A stopped run keeps the critique it paid for: the resume revises from those findings instead of buying them again.

Each run holds `run.lock` while it works, and `vibe resume` refuses a run whose lock belongs to a process that is still alive, or one it cannot rule out. If a run was killed partway through a turn, the resume charges what that turn had spent, as far as vibe observed it. When a process ends under its own control it writes `ending.json`; a lock with neither a live process nor `ending.json` means something outside vibe killed it.

`vibe fork <run-id> --at <n>` starts a new run from one of the checkpoints an old run wrote, on a new branch, without touching your working tree. See the [CLI reference](./cli#vibe-fork).
