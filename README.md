# vibe

Automates the plan → critique → implement → review loop between **Claude Code** and **Codex**, so you are not the message bus in the middle of it.

The manual version of this workflow is: plan with Claude in plan mode, paste the plan to Codex for critique, paste findings back, repeat until Codex stops finding P1s, switch Claude to bypass-permissions and implement, hand the diff to Codex for review, repeat until clean. `vibe` runs that loop unattended and stops only when it genuinely needs you.

```
PLAN ──> CRITIQUE ──P1s?──> REVISE ─┐
  │        │ no P1s              └──┘
  │        v
  │     IMPLEMENT  (same session, bypassPermissions)
  │        v
  │     REVIEW ──P1s?──> FIX ─┐
  │        │ no P1s        └──┘
  └────────v  DONE
```

## Install

```bash
cd vibe-code
npm install
npm run build
npm link          # or: node dist/bin/vibe.js ...
vibe doctor
```

Requires Node 20+, the `claude` CLI, and the `codex` CLI. `vibe doctor` verifies all three and prints the resolved paths.

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

**Codex needs no equivalent.** Every Codex call is a one-shot `codex exec` with no resumed session, so its context does not accumulate across the run. Within a single call Codex manages its own context. There is nothing for `vibe` to do, which is why there is no setting for it.

## Why the loop terminates

The stop condition never reads prose. Both CLIs are pinned to JSON schemas — `claude --json-schema`, `codex exec --output-schema` — so every finding carries a typed `severity` and a stable kebab-case `id`. The loop continues while `findings.some(f => f.severity === 'P1')`.

Three independent brakes:

| Brake | Behaviour |
|---|---|
| **Round cap** | `maxPlanRounds` / `maxReviewRounds` (default 5 each) |
| **Oscillation guard** | The set of P1 `id`s is fingerprinted each round. Same fingerprint twice running means the two models are deadlocked, and asking again will not break the tie — the run escalates instead of burning budget. |
| **Budget ceiling** | Two figures, with different coverage. Claude reports `total_cost_usd` per turn and the run aborts past `budget.maxCostUsd` — **Claude only**, since Codex reports no cost in any output mode. Tokens are counted for **both** agents (Codex reports usage on its `turn.completed` event) and abort past `budget.maxTokens`. That makes `maxTokens` the only ceiling that sees the whole run; it is `0` (disabled) by default, and `vibe` warns at startup when it is. |

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
state.json                 resumable state, cost, event log
transcript.log
codex/                     raw schema and output files
```

## Configuration

Drop `vibe.config.json` in the target repo; CLI flags override it. See `vibe.config.example.json`.

```json
{
  "claude": { "model": "opus", "effort": "medium" },
  "codex":  { "model": "gpt-5.6-luna", "effort": "xhigh" },
  "loop":   { "maxPlanRounds": 5, "maxReviewRounds": 5, "oscillationThreshold": 2 },
  "budget": { "maxCostUsd": 25, "maxTokens": 0 },
  "questions": { "askCodex": true, "escalateOnDefer": true, "escalateOnLowConfidence": true },
  "git": { "useBranch": true, "branchPrefix": "vibe/", "commitEachRound": true },
  "context": { "enabled": true, "compactAboveRatio": 0.5, "compactDuringCodex": true }
}
```

Binaries can be pinned with `VIBE_CLAUDE_BIN`, `VIBE_CODEX_BIN`, `VIBE_GIT_BIN`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done — plan and implementation both cleared with zero P1s |
| 1 | Error |
| 2 | Needs your input (see `NEEDS-INPUT.md`) |
| 3 | No convergence — round cap or oscillation guard tripped |
| 4 | Budget exceeded |

Suitable for `if vibe run "..."; then ...` in a wrapper script.

## Notes and limitations

- **Codex tokens are counted; Codex cost is not.** The Codex CLI reports token usage (via `codex exec --json`, on `turn.completed`) but no cost figure in any output mode. So `budget.maxCostUsd` caps the Claude side only, and deriving a dollar figure for Codex would mean hardcoding a price table for models that get renamed faster than it could be maintained — a fabricated number in the field the ceiling is enforced against. **Set `budget.maxTokens` if you want a brake that covers both agents**; with it at the default `0`, nothing bounds the Codex half of the run. The run summary reports the two token totals separately for the same reason.

  One accounting detail if you extend the adapter: Codex nests its usage the OpenAI way — `cached_input_tokens` is a *subset* of `input_tokens`, and `reasoning_output_tokens` a subset of `output_tokens`. Claude's envelope nests neither. So `codex.ts` totals two fields where `claude.ts` totals four; summing all four on the Codex side counts the same prompt twice.
- **Prompts go over stdin, never argv.** Claude's variadic flags (`--tools`, `--allowedTools`) will otherwise swallow a positional prompt argument. If you extend the adapters, keep it that way.
- **Codex output is read as UTF-8 explicitly** — its smart quotes and em dashes mangle under the Windows ANSI codepage.
- **Large diffs are truncated** at 400k characters for the review prompt; the reviewer is told to read the working tree directly when that happens.
- Both models being wrong the same way is not something this catches. Zero P1s means two independent models agreed — it is not proof.
