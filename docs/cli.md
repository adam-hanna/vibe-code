# CLI reference

```
vibe <command> [options]
```

Every command takes `-C <dir>` to work on a repository other than the current directory. `vibe --help` prints the same summary as this page.

## `vibe run`

```bash
vibe run "<task>" [options]
vibe run "$(cat brief.md)" -C ../my-service
```

Runs the whole loop: plan, critique until the plan has no blocking findings, implement, verify, then review until the code has none either. It works on its own branch, `vibe/<run-id>`, and commits after every round. It stops only when it finishes or needs you; see [Exit codes](./exit-codes).

`vibe run` refuses to start outside a git repository (exit 6), because the review reads a diff that git produces.

## `vibe plan`

```bash
vibe plan "<task>" [options]
```

Runs the planning half only: plan and critique until the plan is approved, then exit 0 with the plan in `PLAN.md`. Nothing is implemented. It works outside a git repository.

To take a finished plan into implementation later, use `vibe resume <run-id> --implement`.

## `vibe resume`

```bash
vibe resume <run-id> [options]
vibe resume <run-id> --max-tokens 40000000
vibe resume <run-id> --implement
```

Continues a run that stopped: one that asked for input (exit 2), hit a cap or a ceiling (3, 4), was rate limited (5), or was interrupted. A resume reads `NEEDS-INPUT.md` first, so answer it before you resume.

Resume reads the project's `vibe.config.json` again and lays it over the run's stored settings, so raising a cap in the file applies. Flags you pass are saved with the run, so a later resume without them does not silently go back.

| Flag | Meaning |
|---|---|
| `--max-tokens <n>` | Raise the token ceiling, usually because the run stopped on it. |
| `--implement` | Take a finished `vibe plan` run into implementation. The approved plan, its acceptance criteria and its carried findings come with it. Refused for a run that was not plan-only, or whose plan has not cleared critique. |
| `--force` | Resume a run whose lock says another process may still own it: a live pid, another host, or an unreadable lock. The spend that process recorded is reported but not charged, because a forced resume cannot tell whose it is. |

If the run records a branch and something else is checked out, resume refuses and names the `git checkout` to run.

## `vibe fork`

```bash
vibe fork <run-id>            # list the points this run can be forked from
vibe fork <run-id> --at <n>   # create a new run from checkpoint n, and stop
```

Every run writes a checkpoint at each phase and round boundary. `vibe fork --at <n>` creates a new run from one of them, with the same plan, the same approved criteria and the same history up to that point, and a branch at the commit that boundary recorded.

It does **not** touch your working tree: the branch is created but not checked out, and the original run stays resumable. It also does **not** start the run. `vibe resume <new-run-id>` does that, and that is when your checkout moves. The fork's token totals start from the checkpoint's, so its ceilings count what the original had already spent.

## `vibe list`

```bash
vibe list
```

Shows the runs in this repository: id, status, spend and the first line of the task, plus whether each one is still running, interrupted or unknown. It also names any scratch a killed gate-artifact copy left behind. See [Artifacts](./artifacts#reading-the-archive).

## `vibe stats`

```bash
vibe stats
vibe stats --json
```

Reads every run in the repository's archive and reports how the loop has behaved: plan revisions and question rounds per run, how often a final fix round was needed, the tokens each kind of turn took, and more. Each rate states how many runs could not answer it. `--json` prints the document instead of the table. Nothing is written.

## `vibe doctor`

```bash
vibe doctor [options]
```

Checks that `claude` and `codex` are installed, logged in and able to run the tools each role needs, and prints the configuration a run would use. It takes the same options `vibe run` does, so `vibe doctor --role reviewer:effort=max` shows the effect of that flag, and an invalid flag fails doctor exactly as it would fail a run. It also prints the gate table, including which `step` gates a terminal run will run through. Run it first.

## Options

Options apply to `run`, `plan`, `resume` and `doctor`, and override the configuration files. Each maps to a key in the [configuration reference](./configuration).

### Where and what

| Flag | Meaning |
|---|---|
| `-C`, `--cwd <dir>` | The target repository. Default: the current directory. |
| `--context <file>` | An extra file appended to the planning prompt. |
| `--at <n>` | `vibe fork` only: the checkpoint to fork from. |
| `--json` | `vibe stats` only: print JSON. |

### Agents

| Flag | Meaning |
|---|---|
| `--claude-model <m>` | Default: Claude Code's own choice (no `--model` is sent). |
| `--claude-effort <e>` | `low`, `medium`, `high`, `xhigh` or `max`. Default `medium`. |
| `--codex-model <m>` | Default: Codex's own choice (no `-m` is sent). |
| `--codex-effort <e>` | Default `xhigh`. |
| `--role <role>:<key>=<value>` | Set one key of one role, repeatable. Roles: `planner`, `implementer`, `critic`, `answerer`, `reviewer`. Keys: `provider`, `model`, `effort`, `timeoutMs`. It patches the role rather than replacing it, so `--role reviewer:effort=max` keeps a model your config named. Works on `resume` and `fork` too. |
| `--codex-context-window <n>` | The Codex model's context window in tokens. Unset, occupancy is shown in tokens only. |
| `--no-codex-session` | Run each Codex turn as a fresh one-shot, with no memory between turns. |

### Gates

| Flag | Meaning |
|---|---|
| `--gate <boundary>=<mode>` | Where the loop hands control back, repeatable. Boundaries: `plan-round`, `question-round`, `plan-approved`, `implemented`, `verify-round`, `review-round`. Modes: `auto`, `step` (desktop app only) or `stop`. See [gates](./configuration#gates). |

### Caps and ceilings

| Flag | Meaning |
|---|---|
| `--max-plan-rounds <n>` | Default 5. |
| `--max-review-rounds <n>` | Default 5. |
| `--max-verify-rounds <n>` | Fix rounds for a failing verification gate. Default 3. |
| `--max-question-rounds <n>` | Rounds of the planner's questions before they come to you. Default 3. |
| `--p1-tolerance <n>` | P1 findings a phase may carry forward rather than fix. Default 1; `0` demands a clean verdict. P0s are never carried. |
| `--budget <usd>` | Work ceiling in API-equivalent dollars, Claude only. Default 25. Not a bill on a subscription. |
| `--max-tokens <n>` | Token ceiling across both agents. Default 25,000,000; `0` turns it off. |
| `--no-wait-on-limit` | Exit on a rate limit instead of waiting for the reset. |
| `--codex-limit-percent <n>` | Stop before a Codex turn once its rate-limit window is this full. Default 95; `0` turns it off. |
| `--no-codex-limits` | Do not read Codex's rate-limit window. |

### Timeouts (minutes)

| Flag | Meaning |
|---|---|
| `--plan-timeout <min>` | Per planning turn. Default 30. |
| `--implement-timeout <min>` | Per implement or fix turn. Default 90. |
| `--codex-timeout <min>` | Per Codex turn. Default 45. |
| `--verify-timeout <min>` | Per verification command run. Default 15. |

### Context and progress

| Flag | Meaning |
|---|---|
| `--compact-above <ratio>` | Rotate Claude's session above this share of its context window. Default 0.5. |
| `--no-compact` | Never rotate the session. |
| `--progress-interval <sec>` | Heartbeat cadence during a turn. Default 30. |
| `--no-progress` | No in-turn heartbeat. |

### Questions

| Flag | Meaning |
|---|---|
| `--no-codex-answers` | Send every blocking question straight to you. |
| `--blocking-questions-only` | Send Codex only the questions marked blocking. |

### Git and verification

| Flag | Meaning |
|---|---|
| `--no-branch` | Do not create an isolated branch. Use only if you have your own isolation. |
| `--verify-command <cmd>` | The verification command. Default: `npm test` when there is a `test` script. Refused when `verify.gates` is configured. |
| `--verify-runs <n>` | Times it must pass. Default 3. |
| `--no-verify` | Do not run the verification gates. |
| `--skip-probe` | Skip the agent environment check before the first turn. |
| `--force` | `vibe resume` only: see above. |
| `--implement` | `vibe resume` only: see above. |
| `-h`, `--help` | Print the usage summary. |
