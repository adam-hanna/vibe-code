# Configuration

vibe reads its settings from up to two JSON files, and then from the flags on the command line. Every key has a default, so both files are optional, and a file only needs the keys it changes.

## Where settings live

| File | Where | Meant for |
|---|---|---|
| The project's file | `vibe.config.json` in the repository | How this repository is built, tested and worked on. Usually committed. |
| The settings for all projects | `$XDG_CONFIG_HOME/vibe/config.json`, else `~/.config/vibe/config.json`. On Windows, `%APPDATA%\vibe\config.json`. | Your own models, budgets and round caps, and the machine-only sections below. Never committed. |

The order is: **the defaults, then the settings for all projects, then the project's `vibe.config.json`, then flags.** A later layer wins key by key, so a project file that names one round cap leaves the others as they were. Set `VIBE_GLOBAL_CONFIG` to read the global file from another path, or to an empty string to ignore it. `vibe doctor` prints which files it read and which keys the command line changed.

**On resume** the run's own stored configuration takes the place of the defaults. The project file is laid over it, and the flags over that. That is how you resume a run past a cap: raise the cap in `vibe.config.json`, or pass the flag, and resume.

`vibe.config.example.json` in the repository is a worked example.

### Keys only a project may set

How a repository builds and tests is a fact about that repository, so these are refused in the global file:

- all of `verify`
- `git.worktree`, `git.worktreeCommand`, `git.worktreeTimeoutMs` and `git.baseRef`

### Sections only the global file may set

A project file is committed, and a repository you clone must not decide who pays, what the pilot may run or which executable every turn starts. So these four sections are refused in `vibe.config.json`:

| Key | Default | Meaning |
|---|---|---|
| `auth.anthropic` | `"subscription"` | How vibe reaches Anthropic, for every `claude` child (run turns, probes and the pilot). `"subscription"` uses the CLI's own login and removes `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from what it sees, because the CLI would otherwise prefer the key. `"api"` bills a key: the one stored in the desktop app, or `ANTHROPIC_API_KEY` from your environment. With neither, the turn is refused before anything starts. |
| `auth.openai` | `"subscription"` | The same for every `codex` child. `"api"` sets `CODEX_API_KEY`, from the app's stored key or from `CODEX_API_KEY`/`OPENAI_API_KEY`. |
| `cli.claude` | `null` | Path to the `claude` executable. `VIBE_CLAUDE_BIN` wins over it; `null` searches your `PATH` and the usual install locations. |
| `cli.codex` | `null` | Path to the `codex` executable. `VIBE_CODEX_BIN` wins over it. |
| `pilot.yolo` | `false` | The desktop pilot runs every command without asking, and may read any disk. Starting a run and answering a gate still need your press. |
| `pilot.safeCommands` | `ls`, `cat`, `echo`, `pwd`, `head`, `tail`, `wc`, `grep`, `diff`, `cp`, `mkdir`, and read-only git plus `git add`/`git commit` | Commands the pilot runs without a card. Each is a program and its leading arguments, so `git commit` covers `git commit -m "…"`. There is no shell. A command that reaches outside the allowed directories or touches `.git` still gets a card. |
| `pilot.dirs` | `[]` | Absolute directories, beyond the project, that the pilot may read and run commands in. |
| `pilot.timeoutMs` | `1800000` (30 min) | How long one pilot turn may take. At least one minute. |
| `runs.maxConcurrent` | `0` | How many runs the desktop app may host at once. `0` is no limit. A start beyond it is refused, never queued. Runs started from a terminal are not counted. |

## `roles`

`roles` decides which agent does each job. The default is Claude for `planner` and `implementer`, and Codex for `critic`, `answerer` and `reviewer`. Name only the roles you want to change.

A role takes a provider name, or an object:

```json
{
  "roles": {
    "critic": "codex",
    "reviewer": { "provider": "codex", "model": "gpt-5.6-pro", "effort": "max", "timeoutMs": 5400000 },
    "implementer": { "provider": "claude", "model": "sonnet", "mcpServers": ["github"] }
  }
}
```

| Key in a role object | Meaning |
|---|---|
| `provider` | `"claude"` or `"codex"`. Required in the object form, so that adding an effort can never silently move a role back to the default agent. |
| `model` | This role's model, instead of `claude.model` or `codex.model`. Any non-empty name. vibe does not check that a model exists; the `Roles:` line printed before the first turn shows what you asked for, and a turn that fails names `roles.<role>.model`. |
| `effort` | One of `low`, `medium`, `high`, `xhigh`, `max`. |
| `timeoutMs` | A positive number of milliseconds for this role's turns, instead of the provider's timeout. |
| `mcpServers` | MCP server names this role may reach. By default every role reaches **none** of the servers you have configured for yourself. For Claude the configuration is replaced outright; for Codex every server Codex lists and you did not grant is switched off by name, so a server Codex does not list cannot be switched off. |

A role's value is replaced whole when files are layered: a project that writes `"reviewer": {"provider": "codex", "effort": "max"}` drops any model the global file named for the reviewer. The `--role` flag is different: it patches one key.

What a role does not choose is decided by its job. Writing roles get a writable sandbox; Codex's reading roles get `codex.sandbox`. Claude roles share one session. The Codex critic and answerer share one thread, the Codex reviewer keeps a separate thread, and a Codex implementer runs each turn fresh, because a resumed Codex turn cannot write. Some tables run with a warning rather than a refusal, for example a reviewer on the same provider as the implementer, which loses the independent second opinion.

## `gates`

`gates` decides where the loop hands control back to you. Each boundary takes one of three modes:

| Mode | What happens |
|---|---|
| `auto` | The loop runs straight through. |
| `step` | The loop holds and asks. **Desktop app only**: a terminal cannot answer, so from `vibe run` a `step` boundary runs through. Holding is free, because the agent sessions stay warm. |
| `stop` | The run ends there, resumably: exit code 2, a `NEEDS-INPUT.md`, and `vibe resume` carries on. This one behaves the same from a terminal and from the app. |

The six boundaries, and their defaults:

| Boundary | Default | When |
|---|---|---|
| `plan-round` | `auto` | After the planner revises against a critique. The critic reads the revision anyway. |
| `question-round` | `auto` | After the planner's questions are answered. |
| `plan-approved` | `step` | The plan cleared critique; the last point before code is written. |
| `implemented` | `step` | The first implementation is committed. |
| `verify-round` | `step` | A verification gate failed. |
| `review-round` | `step` | A code review raised findings. |

**Two boundaries have no gate and cannot be given one.** `complete`, because there is nothing after it to hold before. `final-fix`, because the loop goes straight back to the verification gate to prove the final fix broke nothing. Naming either is refused, with the reason.

**`vibe plan` is not a gate.** It says the run has one phase, so the run completes with exit 0 and the plan you asked for. `"plan-approved": "stop"` says a full run halts before implementing, and `vibe resume` finishes it.

`vibe doctor` prints the effective table, including which rows a terminal run will honour. From the command line: `--gate implemented=stop`.

## `claude`

| Key | Default | Meaning |
|---|---|---|
| `claude.model` | `"default"` | `"default"` sends no `--model`, so Claude Code uses its own default for your account and a new model reaches your runs with no change to vibe. Name a model to pin one. |
| `claude.effort` | `"medium"` | Reasoning effort: `low`, `medium`, `high`, `xhigh` or `max`. |
| `claude.planTimeoutMs` | `1800000` (30 min) | Per planning turn, and for the session-handoff turn. |
| `claude.implementTimeoutMs` | `5400000` (90 min) | Per implement or fix turn. |

## `codex`

| Key | Default | Meaning |
|---|---|---|
| `codex.model` | `"default"` | `"default"` sends no `-m`, so Codex uses its own default. |
| `codex.effort` | `"xhigh"` | Reasoning effort. |
| `codex.sandbox` | `"read-only"` | Sandbox for Codex's reading roles: `read-only`, `workspace-write` or `danger-full-access`. A writing role always gets a writable sandbox. |
| `codex.timeoutMs` | `2700000` (45 min) | Per critique, answer or review turn. |
| `codex.implementTimeoutMs` | `5400000` (90 min) | Per writing turn, when a table seats the implementer on Codex. |
| `codex.persistSession` | `true` | Continue each Codex conversation across the run, so a judge remembers what it already raised. `false` (`--no-codex-session`) makes every turn a fresh one-shot. |
| `codex.contextWindow` | `null` | The Codex model's context window, in tokens. Codex never reports it to `codex exec`, so vibe does not guess. Unset, occupancy is shown in tokens with no percentage. |
| `codex.readRateLimits` | `true` | Read Codex's rate-limit window from `codex app-server` before each Codex turn. If that is unavailable the run continues and says so. |

## `loop`

| Key | Default | Meaning |
|---|---|---|
| `loop.maxPlanRounds` | `5` | Plan critique rounds before the run stops and asks. A round answering the planner's own questions does not count. |
| `loop.maxReviewRounds` | `5` | Code review rounds. |
| `loop.maxVerifyRounds` | `3` | Fix rounds for a failing verification gate. Counted separately from review. |
| `loop.maxQuestionRounds` | `3` | Rounds of the planner's questions answered by Codex before they come to you. |
| `loop.p1Tolerance` | `1` | How many P1 findings a phase may carry forward instead of fixing. `0` demands a clean verdict. A P0 is never carried. |
| `loop.oscillationThreshold` | `3` | Stop when the same set of blocking findings comes back this many rounds running. |
| `loop.convergenceWindow` | `3` | How many recent rounds the convergence trend looks at, late in the round budget. |

## `budget`

| Key | Default | Meaning |
|---|---|---|
| `budget.maxCostUsd` | `25` | A work ceiling in API-equivalent dollars, **Claude only**. Codex reports no cost. On a subscription this is not a bill; it is a measure of work volume. |
| `budget.maxTokens` | `25000000` | Cumulative tokens across **both** agents: the ceiling that bounds the whole run. `0` turns it off. Hitting it ends the run resumably (exit 4); raise it with `vibe resume --max-tokens`. |
| `budget.waitOnRateLimit` | `true` | Wait for a rate-limit window to reset instead of exiting. |
| `budget.maxWaitMinutes` | `360` | The longest such wait. |
| `budget.codexLimitPercent` | `95` | Stop resumably before a Codex turn once Codex's rate-limit window is this full, rather than start a turn the window would cut off. `0` turns it off. |
| `budget.planShare` | `0.4` | The fraction of `budget.maxTokens` planning may use. A plan that has eaten more has not left enough to build what it describes. |

## `questions`

| Key | Default | Meaning |
|---|---|---|
| `questions.askCodex` | `true` | Send the planner's blocking questions to Codex (the answerer) first. `false` (`--no-codex-answers`) sends every one straight to you. |
| `questions.answerNonBlocking` | `true` | Send non-blocking questions to Codex too. `false` (`--blocking-questions-only`) lets the planner proceed on its own answer, recorded as an assumption. |
| `questions.escalateOnDefer` | `true` | A question Codex marks as product intent, priority or taste comes to you. |
| `questions.escalateOnLowConfidence` | `true` | A question Codex answers with low confidence comes to you. |

## `git`

| Key | Default | Meaning |
|---|---|---|
| `git.useBranch` | `true` | Work on a branch of the run's own. Implementation runs with permissions bypassed, so this keeps it off your branch. `--no-branch` turns it off. |
| `git.branchPrefix` | `"vibe/"` | The branch is this prefix plus the run id. |
| `git.commitEachRound` | `true` | Commit after every implement and fix round, so you get a history to bisect. |
| `git.worktree` | `false` | Run in a git worktree of its own, at `.worktrees/<run-id>`. See [Worktrees](#worktrees). Project only. |
| `git.worktreeCommand` | `null` | Your own command for making that worktree, instead of `git worktree add`. Project only. |
| `git.worktreeTimeoutMs` | `900000` (15 min) | How long the worktree command, and a `git.baseRef` fetch, may take. Project only. |
| `git.baseRef` | `null` | The commit a new run's branch starts from, such as `origin/develop`. `null` means the repository's HEAD. Project only. |

### Worktrees

With `git.worktree` on, the run works in `.worktrees/<run-id>` inside the repository, and the `.worktrees/` directory ignores itself. The run's record still lives in the repository's own `.vibe/runs/`, so removing a worktree never takes the record with it. Nothing removes worktrees for you. A worktree that has built a large project can take gigabytes.

A bare worktree has no dependencies installed, so the verification gate usually cannot run in one. That is why `git.worktree` is off by default, and why it is normally paired with `git.worktreeCommand`. The command runs through your shell, in the repository, with these variables set:

| Variable | Value |
|---|---|
| `VIBE_WORKTREE` | The directory the worktree must be created at. |
| `VIBE_REPO` | The repository. |
| `VIBE_RUN_ID` | The run id. |
| `VIBE_BRANCH` | The run's branch, which already exists at `git.baseRef` (or HEAD). **Unset** when branch isolation is off, or when the repository has no commit yet. |

It must leave a git working tree at `VIBE_WORKTREE`; vibe checks, and refuses the run before the first turn if it did not. Check the branch out rather than choosing a commit, because a worktree left on a different commit from its branch is refused:

```json
{
  "git": {
    "worktree": true,
    "worktreeCommand": "git worktree add \"$VIBE_WORKTREE\" \"$VIBE_BRANCH\" && cd \"$VIBE_WORKTREE\" && npm ci"
  }
}
```

**`git.baseRef`** is resolved once, when a new run starts. A remote ref such as `origin/develop` is fetched first, and a fetch that fails or runs past `git.worktreeTimeoutMs` refuses the run rather than starting from a stale copy. A resume never moves its branch.

Two runs may not both work in the repository itself at once. Two runs that each have a worktree may.

## `context`

| Key | Default | Meaning |
|---|---|---|
| `context.enabled` | `true` | Rotate Claude's session when its context fills. `--no-compact` turns it off. |
| `context.compactAboveRatio` | `0.5` | Rotate once the prompt passes this share of the model's context window. |
| `context.compactDuringCodex` | `true` | Do the rotation while a Codex turn is running, so it costs no extra wall-clock. |

See [Context compaction](./how-it-works#context-compaction).

## `verify`

The verification gate is how vibe knows the code works rather than that a reviewer liked it. All of `verify` is project only.

| Key | Default | Meaning |
|---|---|---|
| `verify.enabled` | `true` | Run the gates. `--no-verify` turns them off. |
| `verify.command` | `null` | The one test command. `null` detects `npm test` when `package.json` has a `test` script. Refused alongside `verify.gates`. |
| `verify.timeoutMs` | `900000` (15 min) | Per run of the command. |
| `verify.runs` | `3` | How many times a passing command must pass. A single run cannot tell working code from a race that happened to win. |
| `verify.gates` | `null` | A list of named gates, in the order they run. See below. |
| `verify.artifactMaxBytes` | `null` | A ceiling on what a failing gate's `artifacts` may copy into the run directory. `null` is no ceiling. Over it, nothing is copied and the run says so. |
| `verify.reproducers` | `true` | Let a reviewer prove a blocking finding with a test file, run by your own gate. See [Reproducers](./how-it-works#reproducers). |
| `verify.testPaths` | `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/test_*.py`, `**/*_test.py`, `**/*_test.go` | Which changed files count as tests when the reviewer is asked whether a round edited its own judge. Replaces the built-in list. `vibe.config.json` always counts. |

### Named gates

One command can only fail one way. `verify.gates` names as many as the project needs:

```json
{
  "verify": {
    "gates": [
      { "name": "typecheck", "command": "npm run typecheck", "runs": 1 },
      { "name": "test", "command": "npm test", "runs": 3 },
      { "name": "e2e", "command": "npx playwright test", "runs": 1, "timeoutMs": 1800000,
        "artifacts": ["playwright-report"] }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `verify.gates[].name` | Kebab-case and unique. A failure is filed as the finding `<name>-failing`. |
| `verify.gates[].command` | The shell command. Required, but may be `null`: a gate with nothing to run is *unavailable*. Nothing is guessed for a named gate. |
| `verify.gates[].runs` | Defaults to `verify.runs`. |
| `verify.gates[].timeoutMs` | Defaults to `verify.timeoutMs`. |
| `verify.gates[].required` | Defaults to `true`. An unavailable required gate makes a finished run exit 7. A gate that runs and fails always blocks, whatever this says. |
| `verify.gates[].artifacts` | Project-relative files or directories (not globs) to copy into the run directory when this gate fails, one copy per round. Links are refused. |

A failure stops the sequence, so the fixer gets one problem at a time. An unavailable gate does not. `gates: []` is refused: `enabled: false` is how you turn verification off.

## `progress`

| Key | Default | Meaning |
|---|---|---|
| `progress.enabled` | `true` | The in-turn heartbeat. `--no-progress` turns it off. |
| `progress.intervalMs` | `30000` | How often the heartbeat line is printed. `--progress-interval` takes seconds. |
| `progress.workIntervalMs` | `60000` | How often a writing turn's changes are measured with git. |
| `progress.maxQuietMs` | `600000` (10 min) | Stop a turn that has produced no output for this long, and end the run resumably. `0` turns it off. Must not be shorter than `progress.intervalMs`. |

## `prompts`

`prompts` replaces a standing instruction block by name. These are the parts of a prompt every turn of a kind receives unchanged; the brief, the plan, the findings and the diff are assembled per turn and cannot be overridden.

```json
{ "prompts": { "simple solution": "Prefer the smallest change that is correct." } }
```

The block names are `respond with JSON`, `review breadth`, `fix breadth`, `simple solution` and `a deferred finding`. A blank value is ignored, so you get the default back. An unknown name is refused, so a typo cannot silently do nothing. A changed block is recorded in the run's configuration, so a run that used a different instruction says so. The desktop app's settings screen shows each block's default text.

## `instructions`

| Key | Default | Meaning |
|---|---|---|
| `instructions.text` | `""` | Your own standing instructions, put in front of every turn of every role, on both agents, and given to the desktop pilot. Set it once in the global file, or per project. |

## `toolchain`

`toolchain` is the contract each agent's environment must meet. Before the first turn, vibe runs each probe inside each agent's own shell and refuses the run (exit 6) if a required tool is missing. `vibe doctor` runs the same check.

The defaults:

| Key | Default |
|---|---|
| `toolchain.git.probe` | `"git --version"` |
| `toolchain.git.phases` | `["plan", "implement", "review"]` |
| `toolchain.node.probe` | `"node --version"` |
| `toolchain.node.phases` | `["implement", "review"]` |
| `toolchain.node.agents` | the implementer's provider (`["claude"]` by default) |
| `toolchain.npm.probe` | `"npm --version"` |
| `toolchain.npm.phases` | `["implement", "review"]` |
| `toolchain.npm.agents` | the implementer's provider (`["claude"]` by default) |

The key under `toolchain` is the tool's name, and you may add your own (`go`, `cargo`, anything). Naming an existing tool replaces its whole entry. Each entry, `toolchain.<tool>`, takes:

| Field | Meaning |
|---|---|
| `probe` | Required. A command that must actually run in the agent's shell, not merely be found. |
| `minVersion` | Optional. A version floor, such as `"20"` or `"2.40.0"`, compared with the probe's output. |
| `phases` | Required, at least one of `plan`, `implement` and `review`: when the tool is needed. |
| `agents` | Optional: `claude`, `codex` or both. Omitted means every agent. |

`node` and `npm` are the implementer's tools, so their `agents` follow whoever holds `roles.implementer`. Write `agents` yourself and your list is used as written.
