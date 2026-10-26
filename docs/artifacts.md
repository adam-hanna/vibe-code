# Artifacts

Everything a run produces lands in `.vibe/runs/<run-id>/`, inside the repository it worked on. That directory contains a `.gitignore` holding `*`, so nothing in it is ever committed, whatever your own ignore rules say. Each run's record survives the run, and the next run's planner can read it.

## What a run directory holds

Most files are conditional: a missing one means the run had nothing to put in it.

| File | What it is |
|---|---|
| `PLAN.md` | The approved plan. |
| `plan-<n>.json` | Each plan round: the plan, its declared assumptions, open questions, out-of-scope list and acceptance criteria. |
| `plan-critique-<n>.json` | The critic's findings on each plan round. |
| `plan-dispositions-<n>.json` | What the plan revision of round `<n>` said it did with each critique finding it was given: `fixed`, `rebutted`, `deferred` or `not-addressed`, with its reason, the seats that raised the finding, and the finding's vote outcome when it was voted on. It answers `plan-critique-<n-1>.json`. Missing when the planner's answer could not be read, and for a revision that answered only questions. |
| `answers-<n>.json` | The answerer's answers to the planner's questions, one file per question round. |
| `implementation-report.md` | What the implementer says it did, under five fixed headings. It is handed to the reviewer as a claim, not as evidence. |
| `fix-report-<n>.md`, `verify-fix-<n>.md` | The same report after a review fix round, or after a verification repair. |
| `code-review-<n>.json` | The reviewer's findings on each round, including its verdict on any test or config file the round changed. With [finders](./configuration#review), each finding also says which seats raised it (`foundBy`). With verifiers, each finding that was voted on carries its `votes`. |
| `fix-dispositions-<n>.json` | What review fix round `<n>` said it did with each finding it was given: `fixed`, `rebutted`, `deferred` or `not-addressed`, with its reason and the seats that raised the finding. It answers `code-review-<n-1>.json`. Missing when the fixer's answer could not be read. |
| `verify-<review>-<verify>-<gate>-<attempt>.log` | The full output of every attempt of a gate that did not pass cleanly. |
| `artifacts/<gate>/round-<n>/` | Files a failing gate's `artifacts` setting copied. |
| `reproducers/<finding-id>/` | A reviewer's reproducer test, kept after it is removed from the working tree. |
| `NEEDS-INPUT.md` | Written when the run stops for you. Renamed `answered-<n>.md` once a resume has read your answers, or `stalled-<n>.md` when the stop reported findings. When the run is carrying assumptions (questions it continued past on the planner's fallback), it lists them under `## Assumptions the run is already making`: write your decision under an assumption's **Your decision:** to settle it, or leave it empty to keep the fallback. |
| `ASSUMED.md` | Questions the run proceeded on with the planner's own answer, which you did not answer or decide yourself. When you answered anything during the run, it ends with `## Your answers in this run`, listing those answers without matching them to the assumptions, so you can check whether one already settles an assumption. |
| `REPHRASED.md` | Questions the run treated as ones already asked or answered, with the score that matched them. If two entries are not the same question, that is worth reporting as a bug. |
| `OUTSTANDING.md` | P1 findings carried under `loop.p1Tolerance`: fixed in a final round that is deliberately not re-reviewed. |
| `FOLLOW-UPS.md` | Findings the critic or the reviewer said belong in a different change, review findings the verifiers' vote moved to P2 (marked *Unconfirmed by vote*), and the plan's declared out-of-scope work. **The file to read after a clean run.** |
| `handoff-<n>.md` | The briefing carried across each session rotation. |
| `state.json` | The run's resumable state: phase, rounds, findings, token and cost totals, the configuration, and the event log. |
| `transcript.log` | Everything the run printed. |
| `checkpoint-<n>.json` | The state as it stood at each phase and round boundary. This is what `vibe fork` reads. |
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

`vibe stats` reads every run in the archive and reports how the loop has behaved: rounds per run, turns and their tokens, and questions. Every rate carries its denominator, because older runs predate newer fields, and a dimension no run recorded is shown as absent rather than as zero. `vibe stats --json` prints the same document. Neither command writes anything.

## Branches and commits

With `git.useBranch` on, the run works on `vibe/<run-id>` and commits after every implement and fix round. To keep the work, merge that branch. To throw a run away, delete it.
