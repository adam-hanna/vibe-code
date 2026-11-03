# Artifacts

Everything a run produces lands in `.vibe/runs/<run-id>/`, inside the repository it worked on. That directory contains a `.gitignore` holding `*`, so nothing in it is ever committed, whatever your own ignore rules say. Each run's record survives the run, and the next run's planner can read it.

## What a run directory holds

Most files are conditional: a missing one means the run had nothing to put in it.

| File | What it is |
|---|---|
| `PLAN.md` | The approved plan. It ends with `## Assumptions`, what the planner declared it was assuming, and `## Decided without you`: the answers the answerer gave to the planner's questions, the questions left on the planner's default, and the plan critique findings carried into implementation. |
| `DECISIONS.md` | The same four lists, one section each: `## Assumptions` (with why, and what changes if one is wrong), `## Answered by a model` (with confidence and rationale), `## Left on the planner's default` (with the default used) and `## Carried into implementation`. Written beside `PLAN.md` when the plan is approved, and by `vibe fork` from the fork's own state. vibe never reads it back. On runs started before it existed, the model answers say "not recorded for this run". |
| `plan-<n>.json` | Each plan round: the plan, its declared assumptions, open questions, out-of-scope list and acceptance criteria. |
| `plan-paths-<n>.json` | Which repository paths `plan-<n>.json` names, each marked present or absent at the commit the run started from (`state.start`), with git's object type for a present one. A path with a `..` segment is listed as not checked rather than absent. It is a record only: no prompt reads it, so the critic is not told about absent paths (a plan can name files it will create). Missing on a run with no start commit (not on a branch, or from before the start commit was recorded), and when git could not read that commit: a path is never marked absent because a read failed. |
| `plan-critique-<n>.json` | The critic's findings on each plan round. |
| `plan-dispositions-<n>.json` | What the plan revision of round `<n>` said it did with each critique finding it was given: `fixed`, `rebutted`, `deferred` or `not-addressed`, with its reason, the seats that raised the finding, and the finding's vote outcome when it was voted on. It answers `plan-critique-<n-1>.json`. Missing when the planner's answer could not be read, and for a revision that answered only questions. |
| `answers-<n>.json` | The answerer's answers to the planner's questions, one file per question round. |
| `implementation-report.md` | What the implementer says it did, under five fixed headings. It is handed to the reviewer as a claim, not as evidence. |
| `fix-report-<n>.md`, `verify-fix-<n>.md` | The same report after a review fix round, or after a verification repair. |
| `code-review-<n>.json` | The reviewer's findings on each round, including its verdict on any test or config file the round changed. With [finders](./configuration#review), each finding also says which seats raised it (`foundBy`). With verifiers, each finding that was voted on carries its `votes`. |
| `fix-dispositions-<n>.json` | What review fix round `<n>` said it did with each finding it was given: `fixed`, `rebutted`, `deferred` or `not-addressed`, with its reason and the seats that raised the finding. It answers `code-review-<n-1>.json`. Missing when the fixer's answer could not be read. |
| `verify-<review>-<verify>-<gate>-<attempt>.log` | The full output of every attempt of a gate that did not pass cleanly. |
| `gate-baseline.json` | Each gate, run once against the tree the run started from, before the implement turn: its status (`passed`, `failed`, `unavailable`, `unlaunchable` or `skipped`), exit code and log, with the start commit and whether the tree was clean. Missing when verification or `verify.baseline` is off, on a plan-only run, and on runs from before it existed; missing means unknown, not passed. |
| `gate-baseline-<gate>.log` | The whole output of a gate that failed, or could not start, at the start tree. |
| `artifacts/<gate>/round-<n>/` | Files a failing gate's `artifacts` setting copied. |
| `reproducers/<finding-id>/` | A reviewer's reproducer test, kept after it is removed from the working tree. |
| `NEEDS-INPUT.md` | Written when the run stops for you. Renamed `answered-<n>.md` once a resume has read your answers, or `stalled-<n>.md` when the stop reported findings. When the run is carrying assumptions (questions it continued past on the planner's fallback), it lists them under `## Assumptions the run is already making`: write your decision under an assumption's **Your decision:** to settle it, or leave it empty to keep the fallback. |
| `ASSUMED.md` | Questions the run proceeded on with the planner's own answer, which you did not answer or decide yourself. When you answered anything during the run, it ends with `## Your answers in this run`, listing those answers without matching them to the assumptions, so you can check whether one already settles an assumption. |
| `REPHRASED.md` | Questions the run treated as ones already asked or answered, with the score that matched them. If two entries are not the same question, that is worth reporting as a bug. |
| `OUTSTANDING.md` | P1 findings carried under `loop.p1Tolerance`: fixed in a final round that is deliberately not re-reviewed. With [`loop.confirmFinalFix`](./configuration#loop) on, each finding says what the check after the gates found, under *After the final fix:*: *confirmed fixed*, *still present* or *could not be confirmed*, who said it and why. A finding nobody checked still reads as worked on and unconfirmed. |
| `final-fix-confirm-<round>.json` | The check after the final fix round's gates passed: one verdict per carried or guard-downgraded P1, as said and as counted (a *fixed* whose evidence resolved to nothing counts as *could not be confirmed*), its source (a fresh read-only turn, or the finding's own reproducer), the seat's provider and `model` setting, its reason and evidence, and whether the diff it was shown was the change since the last review or the whole run. Missing when `loop.confirmFinalFix` is off or the round carried no such finding. |
| `FOLLOW-UPS.md` | Findings the critic or the reviewer said belong in a different change, review findings the verifiers' vote moved to P2 (marked *Unconfirmed by vote*), and the plan's declared out-of-scope work. **The file to read after a clean run.** Under *Left by the final fix round*, a P1 a guard moved to P2 carries the check's verdict, and one the fixer marked fixed is listed too when the check did not confirm it gone (marked *Raised as:* P1). |
| `handoff-<n>.md` | The briefing carried across each session rotation. |
| `state.json` | The run's resumable state: phase, rounds, findings, token and cost totals, the configuration, and the event log. From plan approval on it also holds `riskFacts`: counts of what the run decided without you up to then (P1s carried, planner assumptions, questions left on the planner's default, questions a model answered, plan stalls, plan rounds, files the plan names). A count the record cannot establish is left out, not written as 0. |
| `transcript.log` | Everything the run printed. |
| `checkpoint-<n>.json` | The state as it stood at each phase and round boundary. This is what `vibe fork` reads. The `plan-approved` checkpoint carries the run's `riskFacts`. |
| `run.lock` | Held while a process is working on the run. Names the pid, the host and when it started. |
| `ending.json` | How the last process to hold this run went away. A lock with a dead process and no `ending.json` means something killed it from outside. |
| `codex/` | Raw schema and output files from Codex turns. `<label>.cutoff.json` is an answer Codex cut off at its output limit: its text, with long runs of blank space shortened, and the findings it had written in full. |

## Reading the archive

`vibe list` shows the runs in the repository, with each one's status, spend and whether it is still alive. A run's liveness comes from its lock:

| The lock says | Verdict | `vibe resume` |
|---|---|---|
| no lock | not running | proceeds |
| this host, process alive | running | refused |
| this host, process gone | interrupted | proceeds, and charges what the dead process had spent |
| another host, or unreadable | unknown | refused; `--force` overrides it |

`vibe stats` reads every run in the archive and reports how the loop has behaved: rounds per run, turns and their tokens, questions, and the risk facts each run recorded at plan approval. Every rate carries its denominator, because older runs predate newer fields, and a dimension no run recorded is shown as absent rather than as zero. `vibe stats --json` prints the same document. Neither command writes anything.

## Branches and commits

With `git.useBranch` on, the run works on `vibe/<run-id>` and commits after every implement and fix round. To keep the work, merge that branch. To throw a run away, delete it.
