# vibe

**vibe runs the plan → critique → implement → review loop between Claude Code and Codex, so you don't have to pass messages between them yourself.**

Claude plans and Codex critiques, until the plan has no blocking findings. Then Claude implements, vibe runs your tests, and Codex reviews the diff, until that is clean too. vibe stops only when it actually needs you.

![The vibe desktop app: projects and runs on the left, the pilot chat in the middle, the run's status on the right](docs/images/app-pilot.png)

```
PLAN ──> CRITIQUE ──blocking?──> REVISE ─┐
  │         │ clear                   └──┘
  │         v
  │      IMPLEMENT
  │         v
  │      VERIFY ──fails?──> FIX ─┐        your test suite, run by vibe
  │         │ passes          └──┘
  │         v
  │      REVIEW ──blocking?──> FIX ─┐
  │         │ clear              └──┘
  └─────────v  DONE
```

## Install

```bash
npm install -g @adam-hanna/vibe-code
vibe doctor
```

You need `claude` and `codex` installed and logged in. vibe installs neither: it runs them as child processes, so they use the subscriptions you already have. `vibe doctor` checks both, and the config a run would use. Node 20+.

<details>
<summary>From source</summary>

```bash
git clone https://github.com/adam-hanna/vibe-code.git
cd vibe-code && npm install && npm run build && npm link
vibe doctor
```
</details>

## Use

```bash
vibe run "Add rate limiting to the /api/upload endpoint"   # the full loop
vibe plan "Migrate the session store to Redis"             # stop once the plan is approved
vibe run "Fix the flaky auth tests" -C ../my-service       # another repository
vibe resume <run-id>                                       # continue a run that stopped for you
vibe fork <run-id> --at 3                                  # start a new run from a point in an old one
vibe list                                                  # runs in this repository
vibe stats                                                 # what the archive says about the loop
```

A long brief works better than a one-liner. Write it to a file, state the decisions you've already made, and pass it with `vibe run "$(cat brief.md)"`.

**When a run stops for you,** it exits with code 2 and writes `NEEDS-INPUT.md`. Answer under each question's **Your answer:** heading, then `vibe resume <run-id>`.

**It works on its own branch.** Implementation runs with permissions bypassed, so vibe creates `vibe/<run-id>` and commits after every round. To throw a run away, delete the branch. `--no-branch` turns this off.

## The desktop app

The app is the same loop with a window around it. You describe what you want to the **pilot**, a chat that can read your repository. It asks questions until the brief is clear, then proposes a run for you to start. While the run works, the right-hand column shows each round and its findings, and the tabs hold the plans, critiques, code, reviews and questions.

![A finished run's plans, with the rounds it took on the right](docs/images/app-plans.png)

![What each round changed, from the commits the run made](docs/images/app-code.png)

The app also pauses at the checkpoints you choose, lets you stop a turn in flight, and answers a run's questions in place. Settings edits `vibe.config.json` for you.

The app isn't packaged for download yet. To build it (Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) are needed):

```bash
cd app && npm install && npm run app:build
```

## Configuration

Put a `vibe.config.json` in the repository. Flags override it. `vibe.config.example.json` is a worked example. The keys most worth knowing:

| Key | What it does |
|---|---|
| `verify.command` | The test command vibe runs after implementing. It is detected from `package.json` if not set. |
| `verify.testPaths` | Which changed files count as tests when a review checks whether the run edited its own judge. Replaces the built-in list (`**/*.test.*`, `**/tests/**`, `**/test_*.py` and similar). `vibe.config.json` always counts. |
| `roles` | Which agent, model and effort plans, implements, critiques and reviews. |
| `budget.maxTokens` | A ceiling for the whole run, across both agents. |
| `loop.maxPlanRounds`, `loop.maxReviewRounds` | How many rounds before vibe stops and asks. |
| `gates` | Where the loop pauses for you: `auto`, `step` (the app only) or `stop`. |
| `git.worktree` | Run in a git worktree of its own. |

Settings for every project go in `~/.config/vibe/config.json` (`%APPDATA%\vibe\config.json` on Windows).

## What a run leaves behind

Everything goes in `.vibe/runs/<run-id>/` in the repository: `PLAN.md`, every plan revision and critique, every code review, `state.json`, and a `transcript.log`. `FOLLOW-UPS.md` is the one to read afterwards: it lists what the critic said belongs in another change.

When a round changes a test file or `vibe.config.json`, the reviewer is shown each one and must say whether the change was justified. Each file's status, the lines added and removed, and the verdict are recorded under `testChanges` in `state.json` and in that round's `code-review-<n>.json`. A file the reviewer left out is recorded as `unjudged`. None of this stops a run, but the end-of-run summary names any file that was not judged justified.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done: the plan and the code both cleared review, and the tests passed |
| 1 | Error |
| 2 | Needs your input (`NEEDS-INPUT.md`) |
| 3 | Didn't converge: a round cap was hit, or the findings went in circles |
| 4 | Over budget |
| 5 | Rate limited. Resume once the window resets |
| 6 | A precondition failed, such as a missing tool or not being in a git repository |
| 7 | Finished, but no test command was configured, so nothing verified it |

## Notes and limitations

- **Codex cost isn't reported.** Codex runs on a subscription and no output mode returns a price, so vibe reports tokens and never a guessed dollar figure. `budget.maxTokens` covers both agents.
- **Agreement isn't proof.** A clean run means two different models agreed and your tests passed. Both can still be wrong in the same way.
- **Long docs are coming.** [#230](https://github.com/adam-hanna/vibe-code/issues/230) tracks a docs site with a full config reference and how the loop works.

## Contributing

Read [AGENTS.md](AGENTS.md) first: it covers the commands, the code style, the repo map and the decisions already settled. Branch off `develop` and open your PR into `develop`. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

MIT licensed.
