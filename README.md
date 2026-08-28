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

# Start a new run from a point inside an old one
vibe fork 20260811-142530-add-rate-limiting            # list the points it can start from
vibe fork 20260811-142530-add-rate-limiting --at 3     # create the run, and stop
vibe resume <the-new-run-id>                           # now run it

vibe list
```

### Forking a run

Every run now writes a `checkpoint-<n>.json` at each phase and round boundary: the whole
state, as it stood, beside the artifacts that round produced. `vibe fork <run-id> --at <n>`
seeds a new run from one of them — the same plan, the same approved criteria, the same
history up to that point — and gives it a branch created at the commit that boundary
recorded.

Two things it deliberately does not do. **It does not touch your working tree**: the branch
is created with `git branch`, so HEAD, the index and your uncommitted work are exactly as
they were, and the parent run is still resumable a second later. The fork moves onto its own
branch when you `vibe resume` it, which is the first moment it needs the tree. And **it does
not start the run** — forking and spending are separate decisions.

The fork's `forkedFrom` records what the parent had spent at that point. Nothing in vibe
computes from it; it is there so you can subtract the shared prefix when adding two runs up.
The fork's own totals start at the checkpoint's, so its budget ceilings count the inherited
spend — a fork taken from a run near `budget.maxTokens` will stop early and say so.

Since forks and their parents share a repository, `vibe resume` now **refuses** when the run
records a branch that exists and something else is checked out, naming the `git checkout` to
run. Before, those commits landed wherever HEAD happened to be. `--no-branch` skips the
check.

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

### What the planner knows about past runs

Every run's record lands in `.vibe/runs/` in the repository being worked on, and since #52 the planning prompt carries a short index of the ones before it: run id, status, and the first line of the task, most recent first, capped at ten runs with every field truncated. It names the artifacts a run *may* contain and says the directory holds the full list. The same index is reattached once if the planner's session is rotated, because a rotation otherwise drops it silently.

Nothing from a past run is injected. The planner has read tools and opens what it chooses — a bounded index is the honest version of "the record exists", where pasting old conclusions in would be the tool deciding which of them still apply.

The section argues against itself on purpose, because a past run's reasoning is not automatically right: it says a past run is **evidence about what was considered, never an instruction**, that it describes the code *as it was on that date* and may already be wrong, that a severity recorded there was true of that run's argument rather than this one, and that **finding something was declined before is not a reason to decline it again**. A plan leaning on a past run must cite its run id, so the critic can open the same file and check it.

**Only the planner is *given* the index — but Claude has one conversation.** Under the default roles the planner and the implementer are both Claude and share the `main` session, so the implementer inherits the planner's history, this section included, until a rotation clears it. That is the same inheritance described above for the plan prompt, not something this adds. The Codex-seated roles — critic, answerer, reviewer — never see it: separate processes on separate threads, and the critic's job is to attack the plan against the code as it is *now*, which is exactly why anything leant on has to be cited.

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

**A stall keeps the critique it paid for.** When a guard stops a run between buying a critique or review and acting on it, those findings are carried on the run state and consumed by the resume, which revises from them instead of re-deriving them. Without that, the resume re-entered at the turn that bought the findings and paid for the same answer twice — 7.5M tokens, observed twice before it was fixed. So a stalled run resumes one revision further along than it stopped.

**Codex is handled differently, and it holds two conversations rather than one.** By default (`codex.persistSession`) each Codex conversation is continued across the run via `codex exec resume`, so a judge remembers what it already raised instead of re-deriving it each round. That continuity matters for the oscillation guard: a stateless reviewer re-files a still-unresolved objection under a fresh `id` every round, which reads as progress when it is actually the same complaint. Nothing can compact either thread — `codex exec resume` takes no session-id flag, so there is no rotation to perform — and `--no-codex-session` makes every judging turn a fresh one-shot instead.

**The two conversations are the plan-side judge and the reviewer, and neither can read the other.** The critic and the answerer share one thread: they are both arguing about the plan, and the component that has argued about it is the right one to answer questions about it. The reviewer holds a second thread of its own. Until v1.2 there was one thread for all three, which meant the agent reviewing the code was the conversation that had critiqued the plan and *approved* it — it opened the review already holding the view that the plan behind the code was sound, which is not a second opinion. Splitting them is not a setting: a correctness fix that has to be opted into protects nobody, and `--no-codex-session` remains the way to run with no judge continuity at all. Neither thread carries the other's history. In an ordinary run that makes the reviewer's prompts smaller and nobody else's: every critique and answer turn happens before the first review, so the shared thread held nothing but plan-side history by the time they ran — it was only the reviewer that used to open with the whole critique behind it. Moving `roles.reviewer` to Claude puts the reviewer on Claude's session like any other Claude role.

**Each Codex thread is measured separately, but only half of the fraction is obtainable.** The numerator is free: `turn.completed` reports `usage.input_tokens`, and on a resumed thread that is the whole conversation going in rather than the increment, so the last completed turn's prompt size *is* the thread's occupancy. `vibe` records it against the thread id it was measured on, and reports it on the turn's detail line and in the `codex_turn` event.

The denominator is not obtainable. `ThreadTokenUsage.modelContextWindow` exists in exactly one place in the app-server protocol — the `thread/tokenUsage/updated` **push notification**, delivered to a client the app-server is driving a thread for. No request or response returns it, `thread/read` carries no `tokenUsage` at all, and `model/list` has no context-window field of any kind. `vibe` drives Codex with `codex exec`, a separate process that is not an app-server client, so that notification never arrives. (`account/rateLimits/read` works precisely because it is a request with a reply.)

So the window is a setting, `codex.contextWindow` (`--codex-context-window <n>`), and it is **null by default**. Null is not a failure state; it is the truth about a thread whose window `vibe` cannot ask for. Nothing guesses one from the model name — a table mapping a model to a number is a fabricated denominator that goes stale silently, and a made-up context ratio is the same mistake as a made-up dollar figure with a more convincing face. With no window set you get the token count and never a percentage. With one set you get `ctx N%` beside the turn's tokens, and one warning per run once occupancy crosses `context.compactAboveRatio` — the same threshold the Claude side compacts at — saying plainly that nothing can compact this thread. A resumed run says it again: the condition is still true, and repeating one line is cheaper than swallowing it.

A measurement names the thread it was taken on and is only reported while that thread is still the one in use, so a replaced thread has no occupancy until it takes a turn of its own. The plan-side judge's thread and the reviewer's are recorded separately and against the same `codex.contextWindow`: a figure measured on one is never readable as the other's, and a turn on one leaves the other's figure exactly as it was. With `--no-codex-session` there is no thread to carry a measurement between turns, so the figure describes the size of a single judging prompt.

### Progress during a turn

A planning or implementation turn is a **single** long-running `claude -p` invocation, so a run that printed one line and then nothing for thirty minutes was indistinguishable from a hung one — confirming the first real dogfood run was healthy took `Get-Process` plus reading `state.json`. A user who cannot tell working from hung eventually kills a healthy run, and killing mid-turn throws away everything that turn has paid for.

Both CLIs already stream events as work happens (`--output-format stream-json --verbose`, `codex exec --json`); that stream was simply discarded until the process exited. `vibe` now consumes it live and emits at most one dim line every `progress.intervalMs` (default 30s):

```
plan: 4m12s · 23 tool uses · Read src/orchestrator.ts · 340k tok · ctx 31%
review: 2m03s · 14 events · command_execution
```

Every segment except elapsed time is omitted when the stream did not supply it, which is why the sparser Codex line is shorter — partial information beats an invented number. `ctx%` needs a context window, which only a *completed* turn reports — an ordinary turn or a session-rotation turn, whichever comes first — so it appears from the second Claude turn of a process onward, or from the first on a resumed run whose stored window was measured under the same model, and is omitted entirely after a `--claude-model` change until a turn under the new model has measured one. The heartbeat is also driven by a timer, not only by arriving events, because a long silent reasoning block emits nothing at all and silence was the whole problem.

It is a plain appended line, never a repainting one: runs are expected to be unattended and piped to a log. The same clock writes `lastActivityAt` into `state.json` — advancing even through silence, since vibe is still watching the turn — alongside `lastOutputAt`, the last line the agent actually wrote. The pair separates "working quietly" from "not saying anything", which is a fact about output and not a verdict about life: **whether a run is still alive is answered by its lock, not by its timestamps** — see [Is this run still alive?](#is-this-run-still-alive) below. A threshold over these fields cannot answer it, because a healthy run is routinely silent for a long time: the verification gate runs your test command three times at up to fifteen minutes each, entirely outside any heartbeat.

**`turnStartedAt` and `lastOutputAt` describe the turn running now, not the run.** A turn boundary rebases them and clears `lastOutputAt`; without that, a turn that died before its first line left the previous turn's timestamps in place and a watcher read a finished turn's pulse as current work. `lastOutputAt` is flushed at the end of a turn only when the adapter *accepted* that turn's output — for these CLIs that means a complete `result` envelope or a schema-conformant output file, not a zero exit status, since a bad exit beside a good payload is teardown failing after the work was done, and it is logged rather than throwing the turn away.

Compaction can overlap a rotation turn with a Codex turn, so two turns are occasionally live. Both fields are then recomputed across the live turns on every observation: `turnStartedAt` is the most recently started one, `lastOutputAt` the most recent line from either, and when the rotation finishes they fall back to the Codex turn still running rather than leaving a completed turn's output standing as the live turn's progress. `lastActivityAt` is the exception and only advances — it is about the run, so it stays readable between turns, when the other two still describe the turn that just ended. All three are maintained only while progress is enabled.

`--no-progress` turns the output off; `--progress-interval <sec>` changes the cadence. No compaction or rotation behaviour changes.

## Is this run still alive?

A run holds `run.lock` in its own run directory while it works, naming the pid, the host and when it started. `vibe list` prints a verdict per run, and `vibe resume` acts on it:

| what the lock says | verdict | `vibe resume` |
|---|---|---|
| no lock | **not running** | proceeds |
| this host, pid alive | **running** | refused |
| this host, pid gone | **interrupted** | proceeds, and recovers what that process spent |
| another host | **unknown** | refused — vibe cannot read another machine's process table |
| unreadable | **unknown** | refused — an unreadable lock cannot rule out a live process |
| this host, pid unprobeable | **unknown** | refused — the probe failed for some reason other than "no such process" |

*Unreadable* means any failure to read the lock other than its absence — a permission error, a torn or hand-edited file, something that is not a lock. Only a file that is genuinely not there reads as **not running**: everywhere else, "vibe could not find out" and "there is nothing here" are different answers, and collapsing them is what would let a second process start writing over a live run.

The pid probe sends no signal; it only asks whether the process exists. Its answer is three-valued for the same reason: the process is there, it is gone, or the question could not be answered — and only *gone* proceeds. **Pid reuse is not solved**: a recycled pid makes a dead run read as *running* and refuses a resume that should have been allowed. That is the safe direction — the alternative is two processes writing one run — and `--force` is the way out. Ctrl-C leaves the lock behind with a pid that is now dead, which reads as *interrupted*, which is exactly what happened.

A resume over an *interrupted* lock proceeds and says so first, naming the process that did not finish — whether or not it left anything to recover.

A refusal prints who holds the lock and, where the run kept the liveness timestamps, how long it has been since vibe observed anything. That line is omitted for a run whose progress heartbeat is off, including one that recorded activity before it was turned off: nothing is advancing that timestamp any more, so quoting it would report a silence nobody is measuring. That figure is stated as an observation and never as a verdict, for the reason above.

### What a resume can recover, and what it cannot

A killed turn has usually spent real money that nothing ever charged: on the run that prompted this, an implementation turn spent 17.4M tokens and the process died before the accounting ran. vibe watches its own stream, so it knows the figure — the heartbeat's running total is now the same arithmetic the finished turn reports, deduplicated by message id — and it persists it beside the liveness timestamps. On the next resume, that spend is charged, the ceilings see it, and the summary says so.

What it cannot recover is stated rather than estimated:

- **A killed Claude turn's cost.** Claude reports no dollar figure until the turn ends, and there is none anywhere else, so the tokens are charged and the cost is absent.
- **An interrupted Codex turn's tokens, entirely.** `codex exec --json` reports usage only on `turn.completed`, so there is nothing to observe in flight. The turn is named in the summary as unattributed; no total moves.
- **Up to five seconds of a turn killed between two writes.** The record rides the existing five-second write, so the recovered figure is the last one observed. It is an under-count, never an over-count, and the first figure a turn produces is written immediately so an early kill is not recorded as a zero.

**`--force` reports what it finds and charges none of it.** Forcing is the declaration that vibe cannot tell whether the other process is still alive and still owns those amounts, and an amount that cannot be attributed is not charged — the same rule that makes Codex cost absent rather than estimated. The figures are printed with the reason they were not charged, and then cleared. If you know the run is dead and want that spend counted, delete `run.lock` by hand and resume normally: that is the route that keeps it.

A run whose progress heartbeat is off (`--no-progress`) observes none of this, so there is nothing for it to recover. The lock and the verdict work exactly the same.

## The verification gates

The loop used to terminate on "the reviewer found no P1s", which is a statement about reading, not about working. It once declared success over an implementation that failed its own test suite most of the time.

So `vibe` runs the project's own commands itself, rather than believing a report about them. `verify.command` auto-detects (`npm test` where a `test` script exists) and a failure is filed as a **P0** finding with a stable id, which puts it through the same fix loop as anything else — bounded by `maxVerifyRounds`, and visible to the oscillation guard.

It runs the command **`verify.runs` times (default 3)**, and this is not paranoia. The first run to reach implementation shipped a concurrency fix that failed roughly half its executions; the implementer ran it once, saw green, and reported success entirely truthfully. A single execution cannot distinguish working code from a race that happened to win.

### Named gates

One command can only fail one way. `verify.gates` names as many as the project needs, in the order they run:

```jsonc
"verify": {
  "enabled": true,
  "gates": [
    { "name": "typecheck", "command": "npm run typecheck", "runs": 1 },
    { "name": "test",      "command": "npm test",          "runs": 3 },
    { "name": "qa",        "command": null, "runs": 1, "timeoutMs": 1800000, "required": false }
  ]
}
```

`runs` and `timeoutMs` default to `verify.runs` and `verify.timeoutMs`; `required` defaults to true; `command` is a **required key that may hold null**, so "there is deliberately nothing to run here" cannot be spelled by forgetting to write it. Each gate files its failure as `${name}-failing`, which is what lets the oscillation guard tell a typecheck that keeps failing from a test suite that keeps failing.

**Ordering.** A **failure stops the sequence** — the fixer gets one problem, and running a suite against code that does not typecheck buys an opinion about the wrong thing. An **unavailable gate does not** stop it: a `typecheck` gate nobody configured must not prevent `test` from running.

**Four states, and where each one lands:**

| State | When | Event | Exit |
|---|---|---|---|
| **verified** | ran, passed `runs` times | `verify_passed` | 0 |
| **failed** | ran, exited non-zero | `verify_failed` | P0 → the fix loop |
| **unavailable** | enabled, no command | `verify_unavailable` | **7** if `required`, else 0 |
| **disabled** | `verify.enabled: false` | `verify_disabled` | 0 |

Whatever the exit code, a gate that did not run is named in the `Done` block at the end of the run, saying which gates cost the exit code and which do not. A `log.warn` forty minutes earlier is not a contract; the end of the run is where a human reads.

`verify.command` and `verify.gates` together are refused — two keys naming what to run is an ambiguity, and `--verify-command` sets one of them, so the flag is refused alongside a gate list rather than being silently ignored. `gates: []` is refused too (`enabled: false` is how you turn verification off). A **blank command string is refused** at both spellings: an empty command reached the shell, exited 0, and was reported as a pass.

**Compatibility.** Absent `gates` synthesizes exactly one gate named `verification`, from `verify.command`/`runs`/`timeoutMs` — so its finding id is still `verification-failing` and nothing about an existing config changes. But a project with **no `test` script and no configured command** now exits **7 instead of 0**: that gate was never passing, it was never running, and 0 has always been documented to mean verification passed.

Auto-detection belongs to that legacy gate alone. A listed gate with `command: null` is unavailable and nothing is guessed — a gate named `qa` that silently ran `npm test` because the project happens to have one would report QA as passing when no QA ran.

**What it is actually for.** In practice the implementer self-verifies inside its own turn — the implementation prompt tells it to run the build, lint and tests as it goes — so across sixteen verification runs on five fixtures, including a from-scratch 1416-line glob parser, the gate has passed every time on first entry. It is a regression guard and a liar-detector, not a discovery mechanism. That is the correct thing for it to be, and the reason to keep it is precisely that it is cheap when the implementer was honest.

## Why the loop terminates

The stop condition never reads prose. Both CLIs are pinned to JSON schemas — `claude --json-schema`, `codex exec --output-schema` — so every finding carries a typed `severity` and a stable kebab-case `id`.

A phase moves on when there are **no P0s and at most `loop.p1Tolerance` P1s** (default 1). P2s and P3s never block.

The tolerance exists because demanding a spotless verdict is unmeetable on hard work: a plan for a 1416-line parser went eight rounds and $24 without reaching implementation, every finding legitimate and every one of them answerable in 400ms by the 1977-test suite nobody had run yet. **P0 is the level the tolerance cannot swallow** — it is for findings that make the work unshippable, and it blocks on its own no matter how few there are. A failing verification is filed as a P0 for exactly that reason.

### A plan says how you would know it worked

A plan used to describe work without ever stating what finishing it would look like, so "done"
was whatever the reviewer thought it was that round. Every plan now carries
`acceptance_criteria`: each one a stable kebab-case `id`, the observable `criterion`, the
`check` that settles it and `how` to run it. The bar is stated so that two people would agree
whether it holds — a criterion nobody can check is not one.

**A revision restates the whole bar, not a delta.** Dropping a criterion lowers the bar, so the
planner is asked to say so and explain why it was never the right condition; adding one is how a
revision answers a critique that the definition of done was incomplete.

**It is frozen at the instant the plan is approved**, as a copy rather than a view. The
implementer is bound by that snapshot and so is the reviewer, so a bar cannot be quietly lowered
after the gate by a later edit to the plan. The implementer's report is keyed to the same ids,
which is what lets a review round check a claim against the criterion it answers instead of
against prose.

An empty list is legal. It is a claim that done-ness here is unobservable, and it is meant to be
made only when that is true.

### A finding has to cite something

A blocking finding used to be able to point at nothing. One review round raised P1s having executed **zero** commands — assertions about code nobody had read, each of them bought a fix round at the same price as a finding somebody had checked.

So every finding carries `evidence`: at least one entry saying which kind of claim it is making, and where.

| kind | cites | checked against |
|---|---|---|
| `code` | a file, optionally a `line` and an `excerpt` | the repo: the file exists, the line is inside it, the excerpt appears in it |
| `artifact` | the basename of a run artifact — `PLAN.md`, `code-review-0.json` | the run directory |
| `absence` | the file **or directory** a thing is missing from | the repo: only that the place exists |
| `external` | a URL, a spec, another tool's behaviour | nothing |

A **P0 or P1 with no entry that resolves is downgraded to P2** before anything reads its severity. It stops forcing a round; it is kept in the round's artifact with the reason recorded on it, warned about as it happens, and logged as a `finding_downgraded` event naming the original severity and the kinds it offered. Downgraded, not deleted — the finding may well be right.

A citation is read in the *reporting agent's* own path convention (Codex reports `C:\...` from PowerShell while Claude reports `/c/...` from Git Bash, on the same machine) and must land inside the repo, or inside the run directory for an `artifact`; a resolved path is rewritten repo-relative, because the agent that reads the finding next is not the one that wrote it. `external` is an escape hatch and that is deliberate: nothing here can check another tool's CLI, and making the kind unusable would suppress exactly the findings this is meant to keep. What the taxonomy buys is that the claim has to *say* what it is, so "this P1 rested only on an unverifiable external claim" is visible.

The check is `existsSync`, a line count and a substring: no tokens, no second opinion. **It checks that a finding is grounded, not that it is correct.**

A carried P1 is not dropped. In the plan phase it is written into the implementation prompt as a known open issue. In the review phase it gets one final fix round, which is committed and re-verified but deliberately **not** re-reviewed — a fresh review could raise something new and reopen the argument the tolerance just settled. So those findings are worked on but unconfirmed, and `OUTSTANDING.md` says so rather than calling them unfixed.

Brakes, all independent:

| Brake | Behaviour |
|---|---|
| **Round cap** | `maxPlanRounds` / `maxReviewRounds` (default 5 each), plus `maxVerifyRounds` (3) and `maxQuestionRounds` (3). Verification fixes get their own counter because they previously shared one with review, so a run that spent every round on a failing suite had none left for the reviewer and stopped blaming a reviewer that had never run. |
| **Oscillation guard** | The set of blocking `id`s is fingerprinted each round. The same fingerprint `oscillationThreshold` rounds running (default 3) means nothing new is being produced and the run escalates. Three rather than two: a single repeat is a normal review cycle — the fix shifts the problem and the next round catches the shift. A lone blocker that never changes is this case, not the one below: it is the whole set, so its fingerprint repeats and this guard is what stops it. |
| **Convergence trend** | Late in the round budget, a finding count that is not trending down stops the run. Only consulted once most of the budget is spent; early churn is left alone. A *flat* count is not automatically a stuck one: if no finding survives the whole window — three rounds of two, six different ids — that is work being done, and it buys one window before the guard applies again. A rising count, a persistent core and an alternating set all still stop. |
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
plan-0.json ...            each plan revision, with assumptions, questions and acceptance criteria
plan-critique-0.json ...   Codex findings per round
code-review-0.json ...     Codex review findings per round
implementation-report.md   what Claude says it did — handed to the next reviewer
fix-report-1.md ...        the same, after a review fix round
verify-fix-1.md ...        the same, after a verification repair
answers-N.json             Codex's answers to blocking questions
answered-N.md              those answers as the planner received them
ASSUMED.md                 non-blocking questions the run proceeded on, and the answer it used
handoff-N.md               briefing carried across each session rotation
NEEDS-INPUT.md             written when the run stops for you
OUTSTANDING.md             carried P1s: fixed in a final round, but not re-reviewed
FOLLOW-UPS.md              deferred findings and the plan's declared out-of-scope work
state.json                 resumable state, tokens, cost, event log, turnStartedAt/lastActivityAt/lastOutputAt
checkpoint-1.json ...      the state as it stood at each phase/round boundary — what `vibe fork` reads
transcript.log
codex/                     raw schema and output files
```

`FOLLOW-UPS.md` and `ASSUMED.md` are the two worth reading after a clean run. The first is
what the critic said belongs in a different change; the second is what the planner decided
without asking you. Both are raw material for the next issue rather than a defect report.

Most of the files above are conditional: `FOLLOW-UPS.md` is removed when there is nothing
deferred and no declared out-of-scope work, `ASSUMED.md` is written only when a question ran
on the planner's guess, and `OUTSTANDING.md` only when findings were carried. A missing one
means that run had nothing to report, not that the record is incomplete.

**Since #52 the planner reads this directory back.** See below.

## Configuration

Drop `vibe.config.json` in the target repo; CLI flags override it. See `vibe.config.example.json`.

Every key below is shown at its default, so this block is a complete statement of the
defaults rather than a sample — omit any section and you get exactly what is printed here.

```json
{
  "roles":  { "planner": "claude", "implementer": "claude",
              "critic": "codex", "answerer": "codex", "reviewer": "codex" },
  "claude": { "model": "opus", "effort": "medium",
              "planTimeoutMs": 1800000, "implementTimeoutMs": 5400000 },
  "codex":  { "model": "gpt-5.6-luna", "effort": "xhigh", "sandbox": "read-only", "persistSession": true,
              "readRateLimits": true, "contextWindow": null, "timeoutMs": 2700000,
              "implementTimeoutMs": 5400000 },
  "loop":   { "maxPlanRounds": 5, "maxReviewRounds": 5, "maxVerifyRounds": 3,
              "maxQuestionRounds": 3, "p1Tolerance": 1, "oscillationThreshold": 3,
              "convergenceWindow": 3 },
  "budget": { "maxCostUsd": 25, "maxTokens": 25000000, "planShare": 0.4,
              "codexLimitPercent": 95, "waitOnRateLimit": true, "maxWaitMinutes": 360 },
  "verify": { "enabled": true, "command": null, "runs": 3, "timeoutMs": 900000, "gates": null },
  "questions": { "askCodex": true, "answerNonBlocking": true,
                 "escalateOnDefer": true, "escalateOnLowConfidence": true },
  "git": { "useBranch": true, "branchPrefix": "vibe/", "commitEachRound": true },
  "context": { "enabled": true, "compactAboveRatio": 0.5, "compactDuringCodex": true },
  "progress": { "enabled": true, "intervalMs": 30000 },
  "toolchain": {
    "git":  { "probe": "git --version", "phases": ["plan", "implement", "review"] },
    "node": { "probe": "node --version", "minVersion": "20", "phases": ["implement", "review"] },
    "npm":  { "probe": "npm --version", "phases": ["implement", "review"] }
  }
}
```

`toolchain` is the contract each agent's environment must satisfy, and it is the one section
with open-ended keys — add `go`, `cargo` or anything else your project needs and `vibe
doctor` will probe for it. `phases` says when the tool must be present, and an `agents` array
which providers are held to it — omitted, every agent is.

`node` and `npm` are the exception: they are the implementer's tools, so `vibe` fills their
`agents` from whoever holds `roles.implementer`. Move the implementer to Codex and the
requirement moves with it, rather than being checked against an agent that never builds
anything. Naming `agents` yourself on either one turns that off and your list is used as
written.

Binaries can be pinned with `VIBE_CLAUDE_BIN`, `VIBE_CODEX_BIN`, `VIBE_GIT_BIN`.

### Who does what

`roles` decides which agent holds each job. Omit it and you get the assignment above, which is what every run did before the key existed; name only the roles you want to move and the rest fill in. A role's value takes two forms: a provider name — `"reviewer": "codex"` — or an object naming the provider and, optionally, that role's own model and reasoning effort:

```jsonc
{
  "roles": {
    "critic":      "codex",                                              // the string form, unchanged
    "reviewer":    { "provider": "codex", "model": "gpt-5.6-pro", "effort": "max" },
    "implementer": { "provider": "claude", "model": "sonnet" }           // its own model, and only its own
  }
}
```

**Model and effort are the two settings a role may name**, and `claude.model`/`claude.effort` and `codex.model`/`codex.effort` remain what every other role on that provider runs. Everything else is a fact about the *job*, not a choice — whether a role may write, what schema its turn returns, and which conversation it talks through. There are three conversations, and which one a role gets follows from its provider and its job: everything on Claude shares Claude's session; a Codex reviewer holds the reviewer's thread, and every other Codex role the plan-side judge's.

**A model is accepted on trust, and that is deliberate.** An effort is a closed enum and is fully checked before a turn is spawned; a model name has no such check anywhere in this tool. `preflight` is an environment contract check rather than a model validator — the Claude probe runs a small fixed model whatever `claude.model` says, and the Codex probe runs `codex.model` — so it never validated a role's model and is not made to. There is no allowlist, no default table and no per-role default: vibe does not guess whether a model exists, and it never silently substitutes one that does. What you get instead is a name you mistyped surfacing twice, early and legibly: the `Roles:` line printed before the first turn shows `reviewer=codex@gpt-5.6-pro`, and a turn that fails under it reports `roles.reviewer.model` rather than `codex.model`, so you edit the line you actually wrote.

Two Codex roles can now name two models, and `codex.contextWindow` is one setting describing one of them. It stays provider-level — the Codex window is a setting rather than something vibe can derive — so a run that names two Codex models *and* sets that window is warned that at least one thread's occupancy, `ctx%` and compaction threshold are measured against a window that is not its model's.

`provider` is required in the object form. A role's value is replaced *wholesale* when configs are layered, so a defaulted provider would let a later `{"effort": "max"}` hand a role you had moved to Claude back to Codex silently — the one thing this section is strict to prevent. Config errors: an unknown role name, a `roles` that is not an object, a provider that is not one of the two, an object with no `provider`, a `model` that is not a non-empty string, any other unknown key inside a role object, and an effort outside `low|medium|high|xhigh|max`. Each names the role, and the key where there is one.

The headline swap is a clean split — `{"planner": "codex", "implementer": "codex", "critic": "claude", "answerer": "claude", "reviewer": "claude"}` — and needs `codex.persistSession: false` (`--no-codex-session`). That pairing is refused rather than repaired: `codex exec resume` takes no `-s` flag, so a writing Codex role on a persisted thread can write on its first turn and silently reverts to read-only on every one after.

Some tables run with a warning rather than a refusal, and each says what it costs:

- A judging role on the implementer's provider loses review independence, which is most of what this tool buys.
- An implementer on Codex has no rotation mechanism, so session rotation and context compaction are off for the run — measured against `codex.contextWindow` if you set one, unmeasured if you have not, and uncompactable either way.
- A planner or implementer on a persisted Codex thread grows a context that nothing can compact, and that nothing measures either unless `codex.contextWindow` is set.
- A planner or implementer on Codex puts the expensive half of the run beyond `budget.maxCostUsd`, which is Claude-side only. `budget.maxTokens` still counts both.

`codex.timeoutMs` is the reviewing figure and `codex.implementTimeoutMs` the writing one, chosen by what the role does — the pair `claude` has always had. A provider that holds no enabled role takes no turn: it is still probed, but its findings can only warn, never stop the run.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. For `vibe run`: both phases cleared and every **required** verification gate passed — an optional gate with no command is reported as unavailable and does not affect this code. For `vibe plan`: the plan cleared critique; no verification runs. Any P1 carried under `p1Tolerance` was fixed in a final round and listed in `OUTSTANDING.md` |
| 1 | Error |
| 2 | Needs your input (see `NEEDS-INPUT.md`) |
| 3 | No convergence — round cap or oscillation guard tripped |
| 4 | Budget exceeded |
| 5 | Rate limited — Claude's window, or Codex's above `budget.codexLimitPercent`. Resume once it resets |
| 6 | A precondition of the phases ahead is not met: an agent's environment fails the toolchain contract, or the target directory cannot host them — `vibe run` outside a git repository is refused before any turn, because the review phase's only input is a diff produced by git. `vibe plan` still works there, and `--skip-probe` does not bypass it |
| 7 | Unverified — the run finished, but a required verification gate never ran (no command configured). The work, its artifacts and its commits are all there; the evidence that it runs is not |

Suitable for `if vibe run "..."; then ...` in a wrapper script.

## Versions and contributing

`CHANGELOG.md` has the per-release detail, each entry linked to the PR that made it. Semver
here means: minor for new capability, patch for fixes, major only for a change that breaks an
existing config or an existing run. No release so far has required a config change.

`AGENTS.md` is the working guide for changing this repo — commands, code style, branch and PR
conventions, the release checklist, and the list of decisions that are settled. It also
describes how `vibe` is developed on itself, in git worktrees under `.worktrees/`, which is
where nearly every change since 1.0.1 came from.

## Notes and limitations

- **Codex tokens are counted; Codex cost is not.** The Codex CLI reports token usage (via `codex exec --json`, on `turn.completed`) but no cost figure in any output mode. So `budget.maxCostUsd` caps the Claude side only, and deriving a dollar figure for Codex would mean hardcoding a price table for models that get renamed faster than it could be maintained — a fabricated number in the field the ceiling is enforced against. `budget.maxTokens` (default 25M) is the brake that covers both agents; the run summary reports the two token totals separately for the same reason.

  Nor is there an account-level cost API to fall back on. `codex app-server` (experimental JSON-RPC over stdio) exposes `account/usage/read` and `account/rateLimits/read`, but neither returns money: usage is lifetime and *daily* token buckets, account-wide, so it cannot be attributed to one run; rate limits are an integer `usedPercent` of a rolling window. A ChatGPT-auth account has a `credits.balance`, but it does not move when subscription-metered work is done — measured before and after a real turn — so it is not a per-turn cost signal either. Subscription Codex work is metered in window percentage, not dollars, and there is no figure to convert.

  What `vibe` *does* read from `app-server` is the rate limit itself, which is a different thing from cost and is the brake that actually stops long unattended runs on a subscription: `usedPercent`, its window length, its reset, and whether the limit is currently reached. That is a coarse whole-run signal, not per-turn metering — on the account this was measured against the primary window is 10080 minutes (a week), so a single turn does not move the integer percent at all. It is checked before each Codex turn and reported in the run summary. See the rate-limit brake above.

  One accounting detail if you extend the adapter: Codex nests its usage the OpenAI way — `cached_input_tokens` is a *subset* of `input_tokens`, and `reasoning_output_tokens` a subset of `output_tokens`. Claude's envelope nests neither. So `codex.ts` totals two fields where `claude.ts` totals four; summing all four on the Codex side counts the same prompt twice.
- **Prompts go over stdin, never argv.** Claude's variadic flags (`--tools`, `--allowedTools`) will otherwise swallow a positional prompt argument. If you extend the adapters, keep it that way.
- **Codex output is read as UTF-8 explicitly** — its smart quotes and em dashes mangle under the Windows ANSI codepage.
- **A change too large for one review turn is reviewed file by file, across several turns that form one round.** Above 400k characters of diff, `vibe` packs whole files greedily in `git diff --name-only` order and sends each part as its own reviewer turn. It is still *one* round: one findings report, one `code-review-<n>.json`, one entry for the oscillation guard. Findings from the parts are merged by `id`, most blocking severity wins, and a tie keeps the first occurrence — which is git's file order, so the same change merges the same way every time.

  The parts run in order on the reviewer's own Codex conversation, so a later part still sees what an earlier one did — **except under `--no-codex-session` (`codex.persistSession: false`), where every turn is a fresh conversation.** Each part is told which of the two it is: whether it has been shown the round's other parts, and, in a later round without a persistent thread, that it does *not* have the earlier rounds' findings and should raise every defect it can see rather than assume something was already addressed. A reviewer told to hold its tongue about a finding it was never shown is how a defect ships with an APPROVE on it.

  What this costs, stated rather than managed: *n* parts cost roughly *n* reviewer turns (the review in #47 was 3.0M tokens on its own), and the thread grows across them with no way to measure the growth — `codex.contextWindow` is a setting that defaults to `null`, and deriving it from a model name is a refusal this project has already made.

  **A single file whose own diff exceeds the limit is still cut** — splitting one file by hunk would mean rebuilding its `diff --git` header onto every piece, which is a second mechanism with its own failure mode. But it is no longer silent: the reviewer is told in the prompt which file was cut and to read the rest from the working tree, the file is named in `state.reviewCoverage.truncated`, a `review_file_truncated` event records it, and the `Done` block says so at the end. It does not change the exit code — a review that covered every file across several turns is complete.

  `state.reviewCoverage` is written one completed part at a time, so it never claims the reviewer saw a file whose turn had not happened yet. Absent means no review part has finished.
- **The implementer's report is handed to the next reviewer, framed as a self-report rather than as evidence.** Every write turn — implement, verification repair, review fix, final fix — is asked for the same five headings (`Changed`, `Verified`, `Unable to verify`, `Deviations`, `Questions / concerns for reviewer`), keyed to the plan's acceptance-criterion ids where the plan set any, and the most recent one is rendered into *every* turn of the next review round. The prompt states both halves of what it is worth: it is **untrusted** — a "verified" line is a claim that something was checked, not evidence that it works — and it is **not exhaustive**, because it says where the implementer knows it is weak and nothing about where it does not. Its questions are review *leads*, never findings in themselves.

  What is stored is the report's **basename** on `state.lastReport`, not its text, so the handoff survives a resume through the artifact on disk while `state.json` stays a state file. The pointer is cleared before each write turn and rewritten once that turn's report is on disk: a run killed mid-turn therefore reports *no* report rather than the previous round's, because a stale report presented as current is worse than none. Nothing probes the run directory for one either — `implementation-report.md` may still be sitting there three fix rounds later. When there is no report the reviewer gets an explicit notice saying so, and saying that it is **not** a statement that there were no concerns; silence would read as a clean bill of health, which is the failure this exists to prevent.
- **The past-run index is bounded in what it renders *and* in what it scans.** Ten rows, each field truncated, so the prompt cannot grow with the archive — and only those ten `state.json` files are read and parsed. The directory scan underneath *was* the exception: until #85 every entry was stat-ed before the limit was applied, 74ms of a 77ms call at 2000 runs, and the bullet you are reading said so. The walk now stops at the tenth surviving row, so the scan is proportional to the rows returned too. `vibe list` passes no limit and still scans the whole archive, which is what it is for. Values are sanitised where the prompt is rendered rather than where they are read: a status or task stored by an older run is untrusted input to a model, and `vibe list` still prints exactly what is on disk.
- Both models being wrong the same way is not something this catches. A clear verdict means two independent models agreed and the test suite passed three times — it is not proof.
