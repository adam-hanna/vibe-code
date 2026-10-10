# Design notes

Some of vibe's behaviour looks like a missing feature until you know why it is that way. This page explains those choices.

## Never invent a number

One rule runs through most of what follows: when vibe does not know a figure, it says so instead of showing a plausible guess. An unknown context window stays unknown rather than being guessed from a model name. A progress line leaves out what the stream did not report. A `vibe stats` rate that no run recorded is shown as absent, not as `0%`. Partial information beats a convincing fabrication, because a fabricated number is the one you have no reason to doubt.

## Codex cost is not reported

The Codex CLI reports tokens but no cost, in any output mode. A subscription is metered in a percentage of a rate-limit window, not in dollars, and no Codex interface returns money for a run. A dollar figure for a Codex turn would have nothing to be an estimate *of*, so vibe reports Codex tokens and no cost.

That is why there are two ceilings. `budget.maxCostUsd` is Claude only, and on a subscription it is a measure of work, not a bill. **`budget.maxTokens` counts both agents**, so it is the one that actually bounds a run. The run summary reports each agent's tokens separately for the same reason.

The desktop pilot does show a dollar figure when it runs on an API key, because there money really moves. It is labelled *estimated*, carries the date its price was read, and is never added to a run's totals.

## The Codex context window is a setting

vibe drives Codex as `codex exec`, and nothing that interface returns says how large the model's context window is. So `codex.contextWindow` is a setting, and it is empty by default. With it empty, a Codex thread's occupancy is shown in tokens, never as a percentage. vibe does not keep a table mapping model names to window sizes: models are renamed faster than such a table could be kept right, and a wrong denominator looks just as convincing as a right one.

## Models default to each CLI's own choice

`claude.model` and `codex.model` default to `"default"`, which sends no model flag at all. Each CLI then uses the model it recommends for your account today, and a new model reaches your runs without a vibe release. Name a model to pin one. vibe does not check that a name exists, because a list of valid names would go stale; a typo shows up in the `Roles:` line before the first turn, and in the error from the first turn that uses it.

## Agreement is not proof

A clean run means two different models agreed and your tests passed several times. Both models can still be wrong in the same way, and a test suite only checks what it checks. That is why vibe does not stop at agreement:

- it runs your **verification gates itself** rather than believing a report that they passed;
- it runs them **more than once**, to catch a race that won the first time;
- a blocking finding must **cite something real**, and come from a turn that **looked at something**;
- a reviewer can be asked to **prove** a finding with a test, run by your own gate;
- and an edit to the tests or to `vibe.config.json` is **judged**, because a round that changes its own judge is grading its own work.

None of that makes a clean run correct. It makes it harder to be wrong without anyone noticing.

## No network code of its own

vibe has no server, no daemon and no HTTP client. Every external call is a child process: `claude`, `codex` and `git`. It installs neither agent CLI, and it uses whatever you are logged into. The published package has no runtime dependencies. The only network code anywhere is in the desktop app: the pilot's API-key mode, and the check for a newer version of the app, which fetches one public file from GitHub and can be switched off.

## Prompts go over stdin

Every prompt is written to the CLI's standard input, never passed as an argument. Claude Code's list-taking flags would otherwise swallow a prompt passed on the command line. Stdin also avoids the command-line length limits a long brief would hit on some platforms.

## A severity only goes up by a person

The automatic guards only ever **lower** a finding's severity: an ungrounded P1 becomes a P2, and a reproducer that passes against the unfixed code demotes its finding. Nothing automatic ever raises one. Raising a finding, or restoring one a guard demoted, is something only you do, through `NEEDS-INPUT.md` or the app. Every change is recorded with who made it.

## Your working branch is never the run's

Implementation runs with permissions bypassed, so by default a run works on `vibe/<run-id>` and commits every round. A bad run is a branch to delete. `vibe fork` creates a branch without checking it out, and `vibe resume` refuses to write a run's commits onto whatever branch you happen to have checked out.

## Plan-only is not a stop

`vibe plan` and a `stop` gate at `plan-approved` look alike, and are different. `vibe plan` asks for a plan, so a run that produces one has **finished** (exit 0). A `stop` gate pauses a full run, which **needs you** (exit 2) and continues with `vibe resume`. A finished plan-only run can still be taken into implementation with `vibe resume --implement`.
