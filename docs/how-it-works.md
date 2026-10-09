# How the loop works

vibe runs two phases. In **planning**, the planner (Claude, by default) writes a plan and the critic (Codex) attacks it, until the plan has no blocking findings. In **implementation**, the implementer (Claude, in the same session that planned) writes the code, vibe runs your verification gates itself, and the reviewer (Codex) reviews the diff, until that has no blocking findings either. Which agent holds each job is the [role table](./configuration#roles).

The planner plans in Claude's read-only plan mode. The implementer then resumes **the same session** with permissions bypassed, so it starts with the plan and the whole investigation in context. That is also why vibe works on a branch of its own.

## Severities, and when a phase moves on

Both CLIs are pinned to JSON schemas, so every finding has a typed severity and a stable id, and the loop never decides anything by reading prose.

| Severity | Meaning |
|---|---|
| P0 | Unshippable. Always blocks, however few there are, and is never carried forward. A failing verification gate is filed as a P0. |
| P1 | Blocking, but a phase may carry up to `loop.p1Tolerance` of them (default 1) instead of fixing them. |
| P2, P3 | Never block. |

A phase moves on when there are **no P0s and at most `loop.p1Tolerance` P1s.** The tolerance exists because demanding a spotless verdict is unmeetable on hard work: one plan went eight rounds without reaching implementation, every finding legitimate and every one answerable by a test suite nobody had run yet.

A P1 carried out of planning goes into the implementation prompt as a known open issue. A P1 carried out of review gets one final fix round, which is committed and re-verified but deliberately not re-reviewed, because a fresh review could reopen the argument the tolerance just settled. Those findings are listed in `OUTSTANDING.md` as worked on but unconfirmed.

## A plan says how you would know it worked

Every plan carries **acceptance criteria**: each has an id, the observable criterion, the kind of check that settles it, and how to run it. A revision restates the whole list, so dropping a criterion is visible and has to be explained.

The criteria are **frozen when the plan is approved**. The implementer and the reviewer both work against that copy, so the bar cannot be quietly lowered later. The implementer's report is keyed to the same ids, so a reviewer can check a claim against the criterion it answers.

## Why the loop terminates

The brakes are independent, and any one of them can stop a run:

| Brake | What it does |
|---|---|
| **Round caps** | `loop.maxPlanRounds` and `loop.maxReviewRounds` (5 each), `loop.maxVerifyRounds` (3) and `loop.maxQuestionRounds` (3). Verification fixes have their own counter, so a stubborn test suite cannot use up the reviewer's rounds. Exit 3. |
| **Oscillation** | The set of blocking finding ids is fingerprinted every round. The same set `loop.oscillationThreshold` rounds running (3) means nothing new is being produced. Exit 3. |
| **Convergence trend** | Late in the round budget, over the last `loop.convergenceWindow` rounds, a blocking count that is not falling stops the run. A flat count whose findings keep changing is work being done, and is allowed one more window. Exit 3. |
| **Persistent finding** | A single finding that keeps coming back while the rest change is **reported, not stopped on**. Persistence is not evidence that it cannot be fixed. |
| **Plan share** | Planning may use at most `budget.planShare` (40%) of the token ceiling. Planning that will not converge is the most expensive way to fail, because it produces nothing. Exit 4. |
| **Token ceiling** | `budget.maxTokens` (25M), counted across both agents. Checked as each turn is charged (exit 4), and also during a turn: a single runaway turn that crosses it is stopped, and the run ends as a stopped turn does (exit 2). |
| **Cost ceiling** | `budget.maxCostUsd` ($25 API-equivalent), Claude only, since Codex reports no cost. Exit 4. |
| **Quiet turn** | A turn that produces no output for `progress.maxQuietMs` (10 minutes) is stopped and the run ends resumably. A healthy turn is rarely silent for more than a few minutes. Exit 2. |
| **Rate limits** | When Claude's window is reached, the run waits for the reset, up to `budget.maxWaitMinutes`. Before each Codex turn vibe reads Codex's window, waits if it is reached, and stops resumably at `budget.codexLimitPercent` (95%) rather than start a turn the window would cut off. Exit 5. |

Every one of these exits resumably. Raise the cap or ceiling (in `vibe.config.json`, or with a flag) and `vibe resume`.

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

### Changes to the run's own judge

The tests and `vibe.config.json` decide whether a run passed, so a round that edits them is grading its own work. When a round changes a file matching `verify.testPaths`, or `vibe.config.json`, the reviewer is shown each one and must say whether the change was justified. A change is justified only when the test's claim is no longer the contract, and never because it makes the gate pass. Each file's status, its lines added and removed, and the verdict are recorded in `state.json` and the round's `code-review-<n>.json`. A file the reviewer did not address is recorded as `unjudged`. None of this stops the run, but the end-of-run summary names any file that was not judged justified.

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

## Questions

A headless planner cannot ask you anything, so vibe makes its questions data: the plan must list its open questions and the assumptions it made.

1. **Non-blocking questions** proceed on the planner's own recommended answer. The choice is recorded as an assumption, and the critic is pointed at it, so a wrong assumption comes back as a finding.
2. **Blocking questions** go to the answerer (Codex) first, which reads the code and answers what it can.
3. **Anything the answerer will not guess**, such as product intent, priorities or taste, comes to you, and so does any answer it gives with low confidence. The run exits 2 with the questions in `NEEDS-INPUT.md`.

A round of answered questions does not use up one of the plan's critique rounds; `loop.maxQuestionRounds` bounds it separately. A question that only rephrases one already answered is not asked again, and `REPHRASED.md` records each such match so you can check it. The [`questions`](./configuration#questions) settings change who is asked.

## Context compaction

`/compact` does not work in headless mode: it is a Claude Code command, not something a model can be told to do. So vibe compacts explicitly. After every Claude turn it reads the prompt's real size against the model's context window. Once that passes `context.compactAboveRatio` (half, by default), it:

1. asks the outgoing session for a dense handoff briefing: what was learned, decisions made, dead ends, what comes next;
2. continues on a **fresh session**, seeded with that briefing and the current plan of record.

Rotation happens only between turns, and by default it runs while Codex is busy critiquing or reviewing, so it costs no extra time. Each briefing is saved as `handoff-<n>.md`. If compaction fails, the run carries on in the existing session.

Codex conversations cannot be compacted: `codex exec resume` has no way to start a new thread from a summary. The critic and answerer share one Codex thread, and the reviewer has its own, so the conversation reviewing the code is not the one that approved the plan. Codex never reports its context window to `codex exec`, so occupancy is shown in tokens unless you set `codex.contextWindow`.

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
