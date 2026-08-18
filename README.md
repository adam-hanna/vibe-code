# vibe

Automates the plan → critique → implement → review loop between **Claude Code** and **Codex**, so you are not the message bus in the middle of it.

The manual version of this workflow is: plan with Claude in plan mode, paste the plan to Codex for critique, paste findings back, repeat until Codex stops finding P1s, switch Claude to bypass-permissions and implement, hand the diff to Codex for review, repeat until clean. `vibe` runs that loop unattended and stops only when it genuinely needs you.

```
PLAN ──> CRITIQUE ──blocking?──> REVISE ─┐
  │         │ clear                   └──┘
  │         v
  │      IMPLEMENT  (same session, bypassPermissions)
  │         v
  │      VERIFY ──fails?──> FIX ─┐      vibe runs the test suite itself
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

**`vibe` drives two CLIs it does not install.** You need `claude` and `codex` already installed *and logged in* — this tool shells out to them and inherits your existing subscriptions. npm cannot express that as a dependency, so it is on you. `vibe doctor` checks for both, prints the resolved paths, and verifies each agent can actually run the tools it needs; run it first.

Node 20+ is required and is enforced via `engines`.

Installing globally puts `vibe` on your PATH — rename the bin or use `npx @adam-hanna/vibe-code` if that collides with something you already have.

> The npm package is scoped because the unscoped `vibe-code` is refused by npm's similarity check against the unrelated `vibecode`. The repo, the tags and the command are all still `vibe-code` / `vibe`.

<details>
<summary>From source</summary>

```bash
git clone https://github.com/adam-hanna/vibe-code.git
cd vibe-code
npm install
npm run build
npm link          # or: node dist/src/main.js ...
vibe doctor
```
</details>

TypeScript, strict — `noImplicitAny`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and no `any` in the source. Internal imports go through the `@src/*` alias (rewritten to relative paths at build time by `tsc-alias`), so there are no `../..` chains. `npm run typecheck` checks without emitting.

## Use

```bash
# Full loop, in the repo you want changed
vibe run "Add rate limiting to the /api/upload endpoint"

# Plan only — stop once the plan clears review, implement it yourself
vibe plan "Migrate the session store to Redis"

# Target another directory
vibe run "Fix the flaky auth tests" -C ../my-service

# Continue a run that stopped for your input
vibe resume 20260811-142530-add-rate-limiting

vibe list
```

## How the two hard parts work

### Switching from plan mode to bypass permissions

Permission mode is per-invocation, not a thing you toggle mid-session. `vibe` generates the session UUID up front, runs planning turns with `--permission-mode plan`, then **resumes that same session** with `--permission-mode bypassPermissions`:

```
claude -p --session-id $SID --permission-mode plan             # planning turns
claude -p --resume     $SID --permission-mode bypassPermissions # implementation
```

Because it is the same session, the implementer already has the plan and the whole investigation in context — it does not re-derive anything. Planning turns are additionally restricted to a read-only toolset (`Read`, `Glob`, `Grep`, `Bash`, `WebSearch`, `WebFetch`) as a second layer of protection.

### Claude's questions during planning

Headless Claude cannot ask you anything, so left alone it silently assumes and moves on. `vibe` makes questions *data* instead: the planning turn is constrained by a JSON schema that requires `assumptions` and `open_questions` alongside the plan itself.

From there:

1. **Non-blocking questions** proceed on Claude's own recommended answer — but the choice is recorded as a declared assumption, and the critique prompt points Codex directly at those assumptions. A wrong assumption comes back as a P1. The critic does the work you would have done.
2. **Blocking questions** go to Codex first, which reads the codebase and answers what it can.
3. **Anything Codex refuses to guess at** — it sets `defer_to_human: true` for product intent, priorities, or taste — escalates to you. So does any `low` confidence answer.

When a run escalates it writes `NEEDS-INPUT.md` with each question, its options, and Claude's default, then exits with code `2`. Answer inline in the blockquote under **Your answer:**, then `vibe resume <run-id>`.

This is the trade the tool makes deliberately: Codex answering *technical* questions keeps the loop unattended; Codex answering *product* questions would bake a guess about your intent into everything downstream, so those still come to you.

### Context compaction

**`/compact` does not work in headless mode.** It is a Claude Code CLI command, not a model instruction — piped into `claude -p` it arrives as an ordinary user turn and the model just explains what `/compact` is. Verified, not assumed.

So `vibe` compacts explicitly. After every Claude turn it reads the real prompt size from the result envelope (`usage.input_tokens + cache_read + cache_creation` against `modelUsage[].contextWindow`). Once that crosses `context.compactAboveRatio` (default 0.5), it:

1. asks the outgoing session for a dense handoff briefing — what was learned about the codebase, decisions made, dead ends ruled out, what happens next;
2. rotates to a **fresh session id** seeded with that briefing plus the current plan of record.

Two properties worth noting. It never interrupts a turn — rotation happens at a turn boundary. And when `context.compactDuringCodex` is on (default), it runs **concurrently with the Codex critique or review**, so the summarisation costs no extra wall-clock: Codex is busy anyway. Each briefing is saved as `handoff-N.md`.

If compaction fails for any reason the run continues on the existing session — it is an optimisation, never a failure mode.

**A ratio only means something under the model that measured it.** It is a fraction of *that model's* window, so `state.contextRatio` is stored with `contextModel` and `contextWindow` alongside it. When the stored measurement cannot be shown to describe the model now in use — a resume with `--claude-model`, or a run recorded before this existed — it is treated as **unknown**, not as a number. That matters in one direction in particular: 40% of a 1M window is 200% of a 200k one, and read as a number it sits below the threshold, so compaction was deferred past the turn that overflowed.

Unknown with a non-zero ratio buys exactly one rotation, to establish a baseline the new model can be measured against; the fresh session is tagged with the current model, so it is not asked for again. A run that has never recorded a ratio has no evidence of an accumulated session and rotates nothing. The baseline's handoff is requested from the model that grew the conversation where that is known, and if it fails the run still rotates to a fresh session — continuing on a session nothing can vouch for is the thing being avoided. A fresh session is seeded with the current plan of record whether or not a briefing was produced, and a briefing that survives a failed rotation is labelled as coming from earlier in the run rather than presented as the session it replaced.

**Resume persists the flags you give it.** `vibe resume --max-question-rounds 5` used to apply the flag to that process only, so stopping and resuming again without it silently reverted to the default. The effective config is now written back to the run, and a `resume_config` event records which settings the flags actually changed.

**Codex is handled differently.** By default (`codex.persistSession`) every Codex call continues one thread via `codex exec resume`, so the reviewer remembers what it already raised instead of re-deriving it each round. That continuity matters for the oscillation guard: a stateless reviewer re-files a still-unresolved objection under a fresh `id` every round, which reads as progress when it is actually the same complaint. Codex manages that thread's context itself and reports no signal `vibe` could rotate on, so there is no compaction setting for it. `--no-codex-session` makes each turn a fresh one-shot instead.

### Progress during a turn

A planning or implementation turn is a **single** long-running `claude -p` invocation, so a run that printed one line and then nothing for thirty minutes was indistinguishable from a hung one — confirming the first real dogfood run was healthy took `Get-Process` plus reading `state.json`. A user who cannot tell working from hung eventually kills a healthy run, and killing mid-turn throws away everything that turn has paid for.

Both CLIs already stream events as work happens (`--output-format stream-json --verbose`, `codex exec --json`); that stream was simply discarded until the process exited. `vibe` now consumes it live and emits at most one dim line every `progress.intervalMs` (default 30s):

```
plan: 4m12s · 23 tool uses · Read src/orchestrator.ts · 340k tok · ctx 31%
review: 2m03s · 14 events · command_execution
```

Every segment except elapsed time is omitted when the stream did not supply it, which is why the sparser Codex line is shorter — partial information beats an invented number. `ctx%` needs a context window, which only a *completed* turn reports — an ordinary turn or a session-rotation turn, whichever comes first — so it appears from the second Claude turn of a process onward, or from the first on a resumed run whose stored window was measured under the same model, and is omitted entirely after a `--claude-model` change until a turn under the new model has measured one. The heartbeat is also driven by a timer, not only by arriving events, because a long silent reasoning block emits nothing at all and silence was the whole problem.

It is a plain appended line, never a repainting one: runs are expected to be unattended and piped to a log. The same clock writes `lastActivityAt` into `state.json` — advancing even through silence, since vibe is still watching the turn — alongside `lastOutputAt`, the last line the agent actually wrote. The pair separates "thinking" from "gone" without inspecting the process table.

**`turnStartedAt` and `lastOutputAt` describe the turn running now, not the run.** A turn boundary rebases them and clears `lastOutputAt`; without that, a turn that died before its first line left the previous turn's timestamps in place and a watcher read a finished turn's pulse as current work. `lastOutputAt` is flushed at the end of a turn only when the adapter *accepted* that turn's output — for these CLIs that means a complete `result` envelope or a schema-conformant output file, not a zero exit status, since a bad exit beside a good payload is teardown failing after the work was done, and it is logged rather than throwing the turn away.

Compaction can overlap a rotation turn with a Codex turn, so two turns are occasionally live. Both fields are then recomputed across the live turns on every observation: `turnStartedAt` is the most recently started one, `lastOutputAt` the most recent line from either, and when the rotation finishes they fall back to the Codex turn still running rather than leaving a completed turn's output standing as the live turn's progress. `lastActivityAt` is the exception and only advances — it is about the run, so it stays readable between turns, when the other two still describe the turn that just ended. All three are maintained only while progress is enabled.

`--no-progress` turns the output off; `--progress-interval <sec>` changes the cadence. No compaction or rotation behaviour changes.

## The verification gate

The loop used to terminate on "the reviewer found no P1s", which is a statement about reading, not about working. It once declared success over an implementation that failed its own test suite most of the time.

So `vibe` runs the project's test command itself, rather than believing a report about it. `verify.command` auto-detects (`npm test` where a `test` script exists) and a failure is filed as a **P0** finding with a stable id, which puts it through the same fix loop as anything else — bounded by `maxVerifyRounds`, and visible to the oscillation guard.

It runs the command **`verify.runs` times (default 3)**, and this is not paranoia. The first run to reach implementation shipped a concurrency fix that failed roughly half its executions; the implementer ran it once, saw green, and reported success entirely truthfully. A single execution cannot distinguish working code from a race that happened to win.

**What it is actually for.** In practice the implementer self-verifies inside its own turn — the implementation prompt tells it to run the build, lint and tests as it goes — so across sixteen verification runs on five fixtures, including a from-scratch 1416-line glob parser, the gate has passed every time on first entry. It is a regression guard and a liar-detector, not a discovery mechanism. That is the correct thing for it to be, and the reason to keep it is precisely that it is cheap when the implementer was honest.

## Why the loop terminates

The stop condition never reads prose. Both CLIs are pinned to JSON schemas — `claude --json-schema`, `codex exec --output-schema` — so every finding carries a typed `severity` and a stable kebab-case `id`.

A phase moves on when there are **no P0s and at most `loop.p1Tolerance` P1s** (default 1). P2s and P3s never block.

The tolerance exists because demanding a spotless verdict is unmeetable on hard work: a plan for a 1416-line parser went eight rounds and $24 without reaching implementation, every finding legitimate and every one of them answerable in 400ms by the 1977-test suite nobody had run yet. **P0 is the level the tolerance cannot swallow** — it is for findings that make the work unshippable, and it blocks on its own no matter how few there are. A failing verification is filed as a P0 for exactly that reason.

A carried P1 is not dropped. In the plan phase it is written into the implementation prompt as a known open issue. In the review phase it gets one final fix round, which is committed and re-verified but deliberately **not** re-reviewed — a fresh review could raise something new and reopen the argument the tolerance just settled. So those findings are worked on but unconfirmed, and `OUTSTANDING.md` says so rather than calling them unfixed.

Brakes, all independent:

| Brake | Behaviour |
|---|---|
| **Round cap** | `maxPlanRounds` / `maxReviewRounds` (default 5 each), plus `maxVerifyRounds` (3) and `maxQuestionRounds` (3). Verification fixes get their own counter because they previously shared one with review, so a run that spent every round on a failing suite had none left for the reviewer and stopped blaming a reviewer that had never run. |
| **Oscillation guard** | The set of blocking `id`s is fingerprinted each round. The same fingerprint `oscillationThreshold` rounds running (default 3) means nothing new is being produced and the run escalates. Three rather than two: a single repeat is a normal review cycle — the fix shifts the problem and the next round catches the shift. A lone blocker that never changes is this case, not the one below: it is the whole set, so its fingerprint repeats and this guard is what stops it. |
| **Convergence trend** | Late in the round budget, a finding count that is not trending down stops the run. Only consulted once most of the budget is spent; early churn is left alone. |
| **Persistent finding** | A finding that keeps coming back while the *rest* of the set rotates is **reported, not stopped on**. It used to abort the run after four rounds; a finding in this repo's own history survived six rounds and was cleared on the sixth attempt, in a run that went on to pass 1977/1977 tests. Persistence is not evidence of unfixability, and runaway spend is measured directly by `budget.maxTokens`, which counts both agents. The notice names the finding, says the run is continuing, and says how to carry on past whichever limit does stop it. |
| **Plan share** | Planning may consume at most `budget.planShare` (0.4) of the ceiling. Planning that will not converge is the most expensive way to fail — it produces nothing, and the overall ceiling only notices once the whole budget is gone. |
| **Codex rate-limit window** | Before each Codex turn, `vibe` reads `account/rateLimits/read` from `codex app-server` and holds the connection open for the pushed `account/rateLimits/updated` updates. If Codex reports the limit *reached*, the run waits for that window's reset under the same `budget.maxWaitMinutes` cap Claude's limits use. If the fuller window is at or above `budget.codexLimitPercent` (default 95), the run stops resumably rather than starting a turn the window would kill partway through. `app-server` is experimental, so this is strictly optional: if it is missing, fails its handshake, or the account is not logged in, the run continues exactly as before and says so once. `--no-codex-limits` turns it off. |
| **Budget ceiling** | Two figures, with different coverage. Claude reports `total_cost_usd` per turn and the run aborts past `budget.maxCostUsd` — **Claude only**, since Codex reports no cost in any output mode. Tokens are counted for **both** agents (Codex reports usage on its `turn.completed` event) and abort past `budget.maxTokens` (default 25M). That makes `maxTokens` the ceiling that sees the whole run; `vibe` warns at startup if you disable it with `0`. |

## Safety

Implementation runs with permissions bypassed, so by default `vibe` creates an isolated branch `vibe/<run-id>` first and commits after every implement and fix round. A bad run is `git checkout -` and a branch delete, and you get a per-round history to bisect. Disable with `--no-branch` if you have your own isolation.

## Artifacts

Everything lands in `.vibe/runs/<run-id>/` in the target repo — not `/tmp`, so it survives and stays inspectable:

```
PLAN.md                    final approved plan
plan-0.json ...            each plan revision, with assumptions and questions
plan-critique-0.json ...   Codex findings per round
code-review-0.json ...     Codex review findings per round
implementation-report.md   what Claude says it did
fix-report-1.md ...
answers-N.json             Codex's answers to blocking questions
handoff-N.md               briefing carried across each session rotation
NEEDS-INPUT.md             written when the run stops for you
OUTSTANDING.md             carried P1s: fixed in a final round, but not re-reviewed
state.json                 resumable state, tokens, cost, event log, turnStartedAt/lastActivityAt/lastOutputAt
transcript.log
codex/                     raw schema and output files
```

## Configuration

Drop `vibe.config.json` in the target repo; CLI flags override it. See `vibe.config.example.json`.

```json
{
  "claude": { "model": "opus", "effort": "medium" },
  "codex":  { "model": "gpt-5.6-luna", "effort": "xhigh", "sandbox": "read-only", "persistSession": true,
              "readRateLimits": true },
  "loop":   { "maxPlanRounds": 5, "maxReviewRounds": 5, "maxVerifyRounds": 3,
              "p1Tolerance": 1, "oscillationThreshold": 3 },
  "budget": { "maxCostUsd": 25, "maxTokens": 25000000, "planShare": 0.4,
              "codexLimitPercent": 95 },
  "verify": { "enabled": true, "command": null, "runs": 3 },
  "questions": { "askCodex": true, "escalateOnDefer": true, "escalateOnLowConfidence": true },
  "git": { "useBranch": true, "branchPrefix": "vibe/", "commitEachRound": true },
  "context": { "enabled": true, "compactAboveRatio": 0.5, "compactDuringCodex": true },
  "progress": { "enabled": true, "intervalMs": 30000 }
}
```

Binaries can be pinned with `VIBE_CLAUDE_BIN`, `VIBE_CODEX_BIN`, `VIBE_GIT_BIN`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done — both phases cleared, verification passes. Any P1 carried under `p1Tolerance` was fixed in a final round and listed in `OUTSTANDING.md` |
| 1 | Error |
| 2 | Needs your input (see `NEEDS-INPUT.md`) |
| 3 | No convergence — round cap or oscillation guard tripped |
| 4 | Budget exceeded |
| 5 | Rate limited — Claude's window, or Codex's above `budget.codexLimitPercent`. Resume once it resets |
| 6 | An agent's environment fails the toolchain contract |

Suitable for `if vibe run "..."; then ...` in a wrapper script.

## Notes and limitations

- **Codex tokens are counted; Codex cost is not.** The Codex CLI reports token usage (via `codex exec --json`, on `turn.completed`) but no cost figure in any output mode. So `budget.maxCostUsd` caps the Claude side only, and deriving a dollar figure for Codex would mean hardcoding a price table for models that get renamed faster than it could be maintained — a fabricated number in the field the ceiling is enforced against. `budget.maxTokens` (default 25M) is the brake that covers both agents; the run summary reports the two token totals separately for the same reason.

  Nor is there an account-level cost API to fall back on. `codex app-server` (experimental JSON-RPC over stdio) exposes `account/usage/read` and `account/rateLimits/read`, but neither returns money: usage is lifetime and *daily* token buckets, account-wide, so it cannot be attributed to one run; rate limits are an integer `usedPercent` of a rolling window. A ChatGPT-auth account has a `credits.balance`, but it does not move when subscription-metered work is done — measured before and after a real turn — so it is not a per-turn cost signal either. Subscription Codex work is metered in window percentage, not dollars, and there is no figure to convert.

  What `vibe` *does* read from `app-server` is the rate limit itself, which is a different thing from cost and is the brake that actually stops long unattended runs on a subscription: `usedPercent`, its window length, its reset, and whether the limit is currently reached. That is a coarse whole-run signal, not per-turn metering — on the account this was measured against the primary window is 10080 minutes (a week), so a single turn does not move the integer percent at all. It is checked before each Codex turn and reported in the run summary. See the rate-limit brake above.

  One accounting detail if you extend the adapter: Codex nests its usage the OpenAI way — `cached_input_tokens` is a *subset* of `input_tokens`, and `reasoning_output_tokens` a subset of `output_tokens`. Claude's envelope nests neither. So `codex.ts` totals two fields where `claude.ts` totals four; summing all four on the Codex side counts the same prompt twice.
- **Prompts go over stdin, never argv.** Claude's variadic flags (`--tools`, `--allowedTools`) will otherwise swallow a positional prompt argument. If you extend the adapters, keep it that way.
- **Codex output is read as UTF-8 explicitly** — its smart quotes and em dashes mangle under the Windows ANSI codepage.
- **Large diffs are truncated** at 400k characters for the review prompt; the reviewer is told to read the working tree directly when that happens.
- Both models being wrong the same way is not something this catches. A clear verdict means two independent models agreed and the test suite passed three times — it is not proof.
