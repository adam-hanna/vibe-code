<!-- ------------------------------------------------------------------------
     Added to the repo by hand. Everything below this block is the designer's
     own text, copied verbatim; this block is the only thing that is not.
     ------------------------------------------------------------------------ -->

> **This is the design corpus, and until now no checkout had it.**
>
> `tokens.css` opens by citing *"fourteen hi-fi screens over nine review rounds"* and a
> `Vibe Design Spec.dc.html` that has never existed in this repository. Twelve source
> comments name a screen — `3a`, `4a`, `4h`, `5c`, `6a`, `7a`, `7c`, `7d`, `hi-fi 5`,
> `hi-fi 11` — and every one of them was a reference an agent or a contributor could not
> follow. This file closes that.
>
> **What it is.** The designer's handoff, verbatim: wireframe rounds 1–8, hi-fi 1–18, three
> source-grounded feedback rounds' corrections applied, and the r9 final list. The
> annotations under each frame *are* the spec — the document says so itself, and it is
> right: the reasoning is what survives, not the pixels.
>
> **What it is not.**
>
> - **Not the palette.** The wireframe values it lists — `#f2f2f3` ground, `#5980a6` accent,
>   Barlow — are the *low-fidelity* convention and are explicitly disowned in "Fidelity".
>   The shipped design system is dark and lives in `tokens.css`, which is the only file in
>   this repo allowed to hold a hex. Hi-fi 15–18 were drawn in those tokens; everything
>   before them was not.
> - **Not current.** It is a snapshot, and one section rots faster than the rest: **`7i —
>   Provenance`** sorts every frame into *real today* / *app-side* / *unbuilt*, and each
>   issue that lands moves a name between them. Read it as a claim about the day it was
>   written. The `proposed · #NNN` chips are the same index in the artwork.
>
>   **`7i` is now materially out of date, and #223 is why.** Every row it lists as *unbuilt*
>   has moved except two, so the table below is what to read instead of that one — and it
>   will rot in its turn.
>
>   | `7i` said | today |
>   | --- | --- |
>   | `1c` phase-filtered output (#133) | built — the filter is on the phase each line was stamped with |
>   | `1f` live inbox + gate cards (#134) | built — `questions_opened` carries the questions, `questions_answered` the drafts |
>   | `1b` fingerprint (#114) | `1b` is built; **the fingerprint column is not**, and is drawn as a named absence |
>   | `5d` gate verdict (#135) | built — whole-gate verdict, per-attempt cards, flaky told from broken |
>   | `4c` ungrounded flag (#113) | built — a finding citing nothing is flagged as such |
>   | `7a`'s `question-round` row, `7d`'s checkpoint line (#139) | built — the row is in the matrix |
>   | `4i` / `1g` / `6g` prompts (#137) | **still unbuilt**, and still v1.5 |
>   | `7h` MCP surface (#138) | **still unbuilt**, and still v1.5 |
>
>   Three things `7i` did not anticipate are also absent, each because no frame carries them
>   and none is a measurement this build is missing: `1b`'s rounds fingerprint, `4g`'s commit
>   count, and `5e`'s provider headroom. Each is drawn as absent **with its reason** rather
>   than omitted.
>
>   Two of the design's own controls are deliberately **not** built, and neither is an
>   oversight. `4c`'s disposition column and `4d`'s `+2 rounds` / `implement anyway` / `swap
>   the reviewer` all mutate run state, and `src/host.ts` requires a validator per `Decision`
>   member before one is offered — buttons producing no frame would be the `proposed` chip
>   shipped as behaviour. `4a`'s name/branch/worktree row and its setup preview have no flag
>   and no worktree creation behind them (#208).
> - **Not a build target.** The bundle is HTML for panning in a browser. Do not port its
>   markup; `app/src/design/` is the implementation and the two are not the same thing.
>
> **Where the rest lives.** The three `.dc.html` canvases, `support.js` and nine rounds of
> feedback are not committed — they are ~1 MB of browsable artwork with a JS runtime, and
> this file is the part a reader in a terminal can use. Ask for the bundle when a frame's
> layout matters more than its reasoning.

# Handoff: vibe desktop — UX wireframes (rounds 1–8) + first hi-fi screen

## Overview

`vibe` is a Tauri desktop app that **links the same source** as the `vibe-code` CLI (adam-hanna/vibe-code, branch `develop`) and runs the loop **in its own process** — shared core, two front ends. It does not shell out to the CLI. This matters for what is possible: gates are an `await` at a phase boundary, and `⏸ pause` keeps the agent session warm rather than killing a subprocess, so "resume costs nothing extra" is literally true. It gives a human full control and transparency over an adversarial multi-agent coding loop: one agent plans and implements, a different agent critiques and reviews, and `vibe` itself runs the test suite. A single pilot chat (Claude or ChatGPT) drives the whole session.

Rounds 5, 6 and 7 each incorporate a detailed source-grounded review of the previous round. All three reviews are included (`design-feedback-round5.md`, `-round6.md`, `-round7.md`) and every correction in them is applied. This bundle is the **UX definition** of that app — layout, information architecture, state coverage and interaction semantics. It is not a visual design.

## About the design files

`Vibe Wireframes.dc.html` is a **design reference created in HTML**. It is a pannable canvas of wireframe frames, not an app and not production code. Do not port its markup. Its purpose is to define what screens exist, what is on them, and what the system must be able to say to the user.

The implementation target is Tauri + HTML/CSS/TypeScript. Recreate these designs in that stack using whatever component and styling approach the repo settles on.

Open the file directly in a browser (`support.js` and `_ds/` must sit alongside it, as they do here). Scroll/pan: newest round is at the top.

## Fidelity

**Low-fidelity.** Deliberately so. Greys, hairline borders and one steel-blue accent (#5980a6) are a wireframe convention here, *not* the intended palette. Hi-fi is planned to be **dark-primary**, and has not been designed yet.

What IS binding in these files:
- which screens exist and what is on each
- information hierarchy and reading order
- the vocabulary (workstream, cycle, round, version, finding, gate, brief)
- every state that must be representable, especially the failure states
- the annotations — numbered notes under each frame carry the reasoning; **read them, they are the actual spec**

What is NOT binding: colors, fonts, exact px, iconography, density.

## The domain model — read this first

Everything below depends on getting this right, and round 1 of the design got it wrong.

**Hierarchy:** Project (a git repo) → Workstream (a unit of work: feature, bugfix, sprint) → its own git worktree and branch.

**The loop is NOT linear.** It is three nested convergence cycles, each iterating over *versions of an artifact* until the adversary stops objecting:

- **Cycle 1 — the plan.** PLAN produces plan v.a → CRITIQUE a → if blocking, REVISE → plan v.b → CRITIQUE b → … Exits when critique returns clear. Cap 5 rounds (`maxPlanRounds`).
  - **Nested inside it: the question loop.** The planner raises open questions → the answerer resolves them (`questions.askCodex`) → the plan is revised with the answers → around again. Own counter `questionRound`, own cap `maxQuestionRounds: 3`. It exists because without it the path re-plans forever on newly-invented questions, never reaching the plan-round cap — a question round produces no critique, so **it cannot advance the plan round**.
- **Cycle 2 — working code.** IMPLEMENT produces code v.a → VERIFY (vibe runs the suite, 3 runs) → if failing, FIX → VERIFY again → … Exits when the suite passes. Cap 3 rounds.
- **Cycle 3 — acceptable code.** REVIEW a → if blocking findings, FIX → code v.b → **re-enters verify** → REVIEW b → … Exits when findings are within tolerance. Cap 5 rounds.

**Important vocabulary point.** In the source, `reviewPhase` is a single `for(;;)` loop with the verification gate at the top of every iteration — so verify re-opens on every review fix. The three "cycles" are a UI device for keeping the independent round caps legible, not three sequential stages. **A cycle header must never read "closed"** — cycle 2 reads `2 rounds · re-runs on every fix`. The two counters (`verifyRound` cap 3, `reviewRound` cap 5) genuinely are independent budgets.

Consequences for the UI, all of which the wireframes act on:
- A **round is a pair** (author produces a version, adversary judges it), not a step. The reviewable object is the round: what was objected to, and whether the next version answered it.
- A **version** (`plan v.a`, `code v.b`) is the addressable artifact.
- Round lists grow unboundedly, so the loop column must collapse by cycle.
- **Convergence is the signal.** Blocking count per round: 3 → 1 → 0 is healthy; 2 → 3 → 2 is oscillation and a guard halts at 3.

**Severity.** Every critique, review, and human diff comment buckets into **P0 / P1 / P2 / P3**. These four counts are the single most repeated readout in the app — they appear per version, per cycle header, per workstream in the rail, and on dashboard cards. "Blocking" = P0 + P1 above the configured tolerance (default P1 ≤ 1). P2/P3 are visible but never hold the loop.

**Four round counters, not three.** `questionRound` (3) nested inside `planRound` (5), then `verifyRound` (3) and `reviewRound` (5). All four are configurable and all four must be visible — see 7a.

**Roles.** planner, critic, implementer, answerer, reviewer. Each binds an agent + model + **thinking level** + sandbox mode.

**Thinking level is one shared vocabulary for both providers:** `low | medium | high | xhigh | max`. Claude defaults to `medium`, Codex to `xhigh`. There is no per-provider wording.

**The independence check is the implementer against the judging roles** — critic, answerer, reviewer. The planner is *not* part of it. It warns and continues. It makes **two distinct statements**, and keeping them distinct matters because a warning that overstates gets the next one ignored too:

- **Shared conversation** — *"the judge remembers writing the code it is judging."* The real problem.
- **Shared provider or model** — same blind spots, fresh context. A weaker claim, stated as weaker.

**Never invent a number.** This is the repo's most-repeated rule and it is now a design rule. An unknown context window stays null rather than guessed; a missing cost is reported absent rather than derived. Consequences that are binding on the UI:

- **There is no step counter, and no denominator of any kind.** The implementer works in one long turn (up to 90 minutes) with no relation to plan steps. A `Plan` is `{ plan_md, assumptions[], open_questions[], out_of_scope?[], acceptance_criteria?[] }` with `additionalProperties: false` — **no steps array and no file list**, so both `step 9/14` and "9 of the 14 files this plan names" would mean parsing model prose. Issue #136.
- **No filled horizontal progress track anywhere.** A filled bar means percent-done to everyone, whatever the caption says — an "indeterminate" label loses that argument. The only bar left in the app is Claude's context, because it is the one dividing a real number by a known denominator. **That is the test: if you cannot name the denominator, it is not a bar.**
- **Plan size is `3 assumptions · 4 acceptance criteria`, not `14 steps`.** Both are structured fields; a step count is list items in a markdown string. The structured version also says something more useful — how much the plan asserts and how it expects to be checked.
- **Codex reports no context figure and no cost.** Draw the absence with a reason, never a bar at 0% and never a blank.
- **Tokens are the only unit.** A dollar view can only ever cover Claude, and half a cost view is worse than none.

**Gates.** Per phase-boundary, three modes: auto / stop / step-through. Configured per project as a matrix, overridable per workstream at launch.

**Explicitly dropped:** fork-from-a-version into a new worktree. Rounds 1–3 in the file still show a `⎇ fork` affordance; it is a record of a retired idea. **Do not build it.** Versions remain readable and addressable, but they are not branch points.

## Frames

Ids are visible badges on each frame in the file. Rounds 1–3 are superseded where round 4 revisits them.

### Round 7 (top of canvas) — current

| id | Frame | Notes |
| --- | --- | --- |
| 7a | **The question loop** — nested group in cycle 1, own counter and cap. Changes the loop column; build before hi-fi. |
| 7b | *Not used* — the question loop's escalation card merged into 7a. Placeholder so nobody hunts for a missing frame; ids are never reused |
| 7c | Staleness from two clocks (**replaces 5b**) |
| 7e | Rate limits — Claude headroom removed as invented |
| 7f | Project settings split — vibe config vs. app settings (**replaces 1h**) |
| 7g | History on the listing's real fields (**replaces 1b's table**) |
| 7h | MCP servers per role (**extends 6f**) |
| 7i | Provenance — what each frame rests on |
| 7d | Hide vs quit — a safety surface, not a preference |

### Round 6

| id | Frame | Notes |
| --- | --- | --- |
| 6a | **The running row — settled.** Six measurements, no bar. Build this exactly. |
| 6b | `finishing · carried finding` — the third way a run ends |
| 6c | One provider connected — the likeliest real first run |
| 6d | Gate matrix on the code's seven checkpoints (**replaces 1h's four**) |
| 6e | Spend with the unattributed bucket (**replaces 5e**) |
| 6f | MCP server detail — per-role scoping |
| 6g | Prompt scoping, three layers |
| 5a | **Idle cockpit — the app's true home screen.** Running, nothing for the user to do. Collapsed rail, honest running row. Build this state first, alongside 3a. |
| 5b | Staleness — live / quiet / stale |
| 5c | First-run & empty states ×4 |
| 5d | Verify pane, corrected — gate-level verdict (**replaces 4b**) |
| 5e | Spend & context — unavailability drawn. **Figures corrected in 6e** |
| 5f | ⌘K switcher overlay |

### Round 4

| id | Frame | Notes |
| --- | --- | --- |
| 4a | New workstream dialog | The only modal in the app |
| 4h | Kickoff conversation | Pilot ↔ user agree a brief before PLAN |
| 4b | Verify pane | **Superseded by 5d** — its per-test verdict column has no data behind it |
| 4c | Findings lifecycle | Evidence, disposition, carry-forward |
| 4d | Halt states ×8 | Round cap, oscillation, token cap, rate limit, restart, dirty worktree, verify misconfigured, agent crash |
| 4e | Interruption model | Notification, tray, pause/stop/step semantics |
| 4f | Spend & context | **Superseded by 5e** — context % is Claude-only, dollars are half a view |
| 4g | After DONE | Pilot does git work via CLI/MCP tools |
| 4i | Prompt access | Three doors into one editor |

### Round 3 — the locked shell

| id | Frame |
| --- | --- |
| 3a | **Workstream cockpit — the primary screen.** Build this first. |
| 3b | Versions tab |

### Round 2 — the loop model

| id | Frame |
| --- | --- |
| 2m | The three-cycle model diagram |
| 2a | Nested rounds (chosen for the loop column) |
| 2b | Adversarial lanes (rejected — best explanation, worst use of space) |
| 2c | Version ladder (chosen as the Versions tab) |
| 2d | Round detail — critique vs. what changed |

### Round 1 — still current except where noted

| id | Frame | Status |
| --- | --- | --- |
| 1a | Cockpit, linear loop | **Superseded by 3a** |
| 1b | All workstreams dashboard | Current |
| 1c | Output pane | Current |
| 1d | Diff + inline comments | Current |
| 1e | Findings pane | Current, extended by 4c |
| 1f | Questions inbox + policy | Current |
| 1g | Prompt template editor | Current |
| 1h | Project settings | Current |
| 1i | Global settings | Current |

## Screens

### 3a — Workstream cockpit (primary screen)

Three columns in **one window**, always. Switching workstreams is a rail click; there is no second window and no tabs.

**Left rail — 216px, collapsible to a 52px icon strip.** The rail is a switcher touched maybe twice an hour, and 216 + 364 = 580px of fixed chrome leaves ~700px for the diff pane on a 1280 laptop. The loop column earns its width; the rail does not. Collapsed, it shows project initials with a dot for "needs you". ⌘K (5f) is the faster switcher and makes the expanded rail optional. Projects as collapsible groups, workstreams as children. Each workstream child shows name, current cycle + round (`cycle 2 · round 1/3`), and a **collapsed verdict chip** (`1 blocking`) — not four chips. See the chip density rule under Design tokens. Active workstream gets a tinted background and a 2px accent left border. Bottom of rail: "New workstream" (primary), "All workstreams ↗", settings.

**Center — loop column, 364px, fixed.** Header: workstream name, branch, worktree path. Body: three collapsible cycle groups.

Each cycle group is a bordered box:
- Header row: disclosure triangle, `CYCLE n · PLAN|CODE|REVIEW` in condensed caps, status (`accepted · 2 rounds` for cycle 1 / `2 rounds · re-runs on every fix` for cycle 2 / `not started · 0/5`), and the cycle's aggregated open-finding chips right-aligned.
- Children: one row per version — version name, author + model + thinking level, that version's four severity chips, a verdict phrase (`2 blocking`, `clear ✓ accepted by you`), and a row of small actions (`open round`, `critique`, `Δ vs v.a`). Plan versions carry `3 assumptions · 4 acceptance criteria`.
- Running versions get an accent border, the honest running row from **6a**, and pause/output/diff/prompt actions. **No bar of any kind** — see "Never invent a number".
- Not-started cycles collapse to a single header line at reduced opacity.

Below the groups, pinned to the bottom: **open findings** block — four chips, tolerance statement, and a stacked bar of findings per round (P0+P1 filled solid, P2/P3 tinted) with the trend in words (`blocking 2 → 0`, `oscillation guard 3`).

Footer, in three stacked parts:

1. **Mode control** — `auto` / `step` as a persistent segmented control that shows its current state. Right-aligned: `next stop: verify gate`. Mode is a mode, not an action, and must be readable at a glance.
2. **Any armed auto-answer countdown** (see 1f). A timer that will act on the user's behalf belongs here, not in the chat transcript — chat scrolls, and a grace period that scrolls away fires unseen, which is the exact failure it exists to prevent.
3. **One primary action** whose label follows the mode (`⏭ run to verify gate`), plus `⏹ stop`.

**When the loop halts, the halt banner (4d) replaces these footer controls**, in place, so the place you look for "what now" never moves.

**Right pane — flexible.** Tab bar with counts: Pilot chat · Output · Versions 5 · Diff 12 · Findings 8 · Questions 1 · Prompt. Right-aligned in the tab bar: consumption + provider headroom (`2.14M tok · claude 38%`).

**Pilot chat speaks in rounds, not phases.** Every loop event lands as a card in the chat carrying the same severity chips as the column, a verdict, and its actions inline (`view v.b` / `approve`). The chat alone must be a usable log of the run — chat and loop column are the same events at two densities.

### 4a — New workstream dialog

The only modal. Sections top to bottom:

1. **What are we doing** — a textarea. This is the user's **opening message to the pilot**, not a brief for the planner. Creating the workstream opens the chat with this sent.
2. **name / base / token cap** in a row. Name derives branch (`vibe/<name>`) and worktree path, both shown as computed monospace text. Base is a branch picker showing fetch freshness. Token cap is **optional and empty by default** (see Spend below).
3. **Overrides block** — collapsed summary showing only what differs from project defaults, with a count (`2 differ from project`) and reset. Two columns: gates (**the seven checkpoints from 6d**, each with its mode and cap; changed rows tinted and labelled `changed`) and roles (per role: role name, agent/model, **thinking level**; plus prompt variant).
4. **Setup preview** — the worktree scripts that will run, last duration, and a note that failure halts before PLAN and shows script output.
5. Footer: `start planning immediately` / `create the worktree but hold` toggles, cancel, `create & plan`.

Design intent: everything has a project default, so the honest path is type → create → keep talking. The overrides block exists to make divergence visible at the one moment the user is thinking about it.

### 4h — Kickoff conversation

Between worktree creation and PLAN. Loop column shows all three cycles as dashed, not-started; cycle 1 reads "waiting for the brief". Setup script results in a box at the bottom of the column.

The pilot reads the repo, asks 2–4 clarifying questions in one message, offers to propose answers itself. After the exchange it emits a **brief card** (accent left border): a restated, tightened version of the task, with `edit brief` / `keep talking` / `start PLAN`.

The brief is a **versioned artifact** — when a plan goes wrong, you can tell whether the brief or the planner was at fault. Nothing bills against the loop until start is pressed.

### 5d — Verify pane (replaces 4b)

**The gate stops at the first failing run.** `runs: 3` means "up to three, all must pass" — a flake *detector*, never a flake *classifier*. The sequence `run 1 fail · run 2 pass · run 3 fail` cannot occur, and the captured output is a single tail-trimmed blob of combined stdout/stderr with **no per-test structure at all**. Issue #135 makes the failure path run the remaining attempts, so a whole-gate verdict becomes real in v1.4.

So the pane is built around the **gate-level verdict**, not a per-test table:

- Verdict, large and first: `FAILED 1 OF 3 RUNS` with the plain-language reading — *"This suite is not deterministic. Run 2 failed; runs 1 and 3 passed."*
- Three run cards (pass/fail + duration).
- "What this means for the loop": all three must pass, so this counts as a failure and sends the round to FIX — and **the fixer is told the suite is non-deterministic, not that a specific test is broken.**
- Failed-runs trend across rounds, with rounds remaining.
- `rerun · spends a round` — a manual rerun consumes a verify round, and the button says so. The round is the scarce thing: three of them, each failure costing an implementation-sized turn.
- The gate card: mode, countdown when auto, and `let FIX run` (primary) / `hold` / `fix myself`. **"Fix myself" is real** — it drops the user into the worktree and the loop waits.

The verdict gets the **flexible** column; the trimmed log gets the fixed one. This is the inverse of 4b, whose annotation claimed the verdict was primary while giving it a 64px right-aligned label.

A **per-test broken-vs-flaky table needs a test-reporter parser per toolchain** — a standing maintenance commitment the repo has not taken on. Draw it as a clearly-marked later state; the pane must not imply data it doesn't have. The one row worth keeping from the 4b draft: `…342 passing, stable`, collapsed and dimmed.

### 4c — Findings lifecycle

Header: finding id, severity chip, one-line title, provenance (`raised by codex · review a · carried to code v.b`).

Left column: **evidence the reviewer cited** — file:line references and precedent. A finding with no citation is flagged **ungrounded** and displayed as such; the reviewer is held to the same standard as the implementer. Below: the finding's history as a timeline — raised → your disposition → fixer claims resolved → **persisted** (reviewer disagrees, still P1).

*Persisted* is the state that matters: a finding surviving a fix round is the loop arguing with itself, and it is what the oscillation guard counts.

Right column: disposition — **Accept → FIX** (text goes into the next fix prompt verbatim), **Decline** (reason required; never re-raised; reason is fed to the reviewer's next prompt), **Defer** (leaves the workstream with a note; **P0 and P1 cannot be deferred**), **Downgrade severity** (P1 → P2 clears the gate, logged as the human's call, not the reviewer's).

The same panel serves a finding the human wrote in the diff (1d) — human comments enter the identical lifecycle.

### 4d — Halt states

Eight states, one shape: **kicker** (halted / waiting / blocked / recovered / crashed) · **condensed-caps title** · one plain sentence · the evidence · the choices. Rendered in place of the loop-column footer controls.

| State | Kicker | Choices |
| --- | --- | --- |
| Plan round cap | halted | read the disagreement · +2 rounds · implement anyway · abandon |
| Oscillation | halted | open the finding · decide it myself · swap the reviewer |
| Token cap | halted | +2M and resume · breakdown · stop here |
| Rate limit | **waiting** | **keep waiting** · pause · *(link)* run this phase on the other agent |
| App restarted | recovered | **resume the phase** · see the drift · *(link)* start over |
| Worktree dirty | blocked | commit mine first · let the agent take over · stash |
| Verify can't run | misconfigured | set the command · rerun setup · skip verify |
| Agent session died | crashed | stderr · retry now · run on the other agent |

Rules, all load-bearing:
- **Every halt names a next action, never just a reason — and marks exactly one primary.** Someone reading a halt banner is already frustrated; four equal-weight buttons make them read all four every time. The lossy or destructive option is demoted to a text link.
- **Every halt is recoverable from a checkpoint.** "Nothing is lost" must be literally true or the autonomy isn't worth using.
- **Rate limit is "waiting", not "halted"** — it requires no decision, so it must not look like it does. Other workstreams on the other provider keep running.
- **"Run this phase on the other agent" is not a peer of "wait".** Swapping providers mid-run means a fresh session with no memory of the conversation so far, and for a writing role on a persisted Codex thread the configuration is refused outright rather than repaired. It is a different run, not a faster route to the same one — demote it to a link and state the cost.
- Agent crashes retry automatically (3 attempts, visible) and the round is **not** counted against the cap.
- Restart recovery shows the **drift** between checkpoint and worktree as a diff before the user chooses. Never silently discarded.
- Verify misconfiguration is caught at **preflight, before PLAN**, whenever the toolchain probe can predict it.

### 4e — Interruption

- **OS notification, always** — carries workstream, gate/question, severity summary, and inline `approve` / `open` / `later`.
- **Tray badge counts only things needing a human.** Never "running". A badge that includes running work trains the user to ignore it.
- **In-app:** rail sorts waiting workstreams to the top; a persistent strip above the rail reads `2 need you` and cycles with ⌥↑/⌥↓.

Control semantics — be honest about these in the UI:
- `⏸ pause` — finishes the tool call in flight, writes a checkpoint, keeps the agent session warm. Resume is free. **Pause is not instant, and the UI says so**: `pausing — finishing edit to auth.ts` for as long as it takes.
- `⏹ stop` — kills the process without waiting for a boundary. The conversation resumes by id, but **the turn in flight is lost and redone**; its spend is charged either way, and that figure is what the confirmation states.
- `▶ step` — runs exactly one phase, then halts as if a gate were set.
- `⏭ to next gate` — runs to the next configured stop, showing what it will pass through before committing.

### 5e — Spend & context (replaces 4f)

**Both accounts are subscriptions, so tokens are the only unit.** No dollar mode: Codex returns no cost from any output mode or endpoint, and estimating one from a price table is a settled, closed decision — a dollar view could only ever show half the run.

Layout, top to bottom:

1. **Run total** with a per-phase stacked bar. One ceiling covering **both loop agents** — this is the one honest ceiling the tool has.
2. **Pilot tokens, shown separately and never summed in.** The pilot is not a sixth agent: it is the assistant conversation that writes briefs, kicks off runs and does the git work afterwards. Its tokens are the app's own conversation, not the run's. Quietly making the ceiling cover three parties would break it.
3. **Per-round consumption** — the decision unit; it's what tells you whether another round is worth it.
4. **Context** — Claude with a real percentage; **Codex drawn as a dashed empty track reading `n/a` with the reason** (no per-request usage is reported, and its window size is unset in config). Never 0%, never blank.
5. **Compaction events**, Claude only for the same reason, each an event in the output stream with the summary readable — it is the moment the agent starts forgetting, so it cannot be silent.
6. **Provider headroom** — the scarcity that actually matters on a subscription.

A token cap is optional and off by default.

### 4g — After DONE

**No merge UI.** DONE emits a summary card (commits, diffstat, files, consumption, deferred/declined findings, worktree path). Everything after that is chat: the user asks the pilot to open a PR, merge, clean up the worktree, and the pilot uses whatever `gh` CLI or MCP tools are configured.

**Every tool call renders as a card** showing the tool, the command, and the result. "The pilot pushed something" must never be a mystery. This keeps vibe out of the git-client business and makes the tool inventory in settings the thing that determines what the pilot can do.

### 4i — Prompt access

Three doors, one editor, scope order **default → project → workstream**, each level stating what it inherits:

1. **Read, mid-run** — right pane → Prompt tab. The exact rendered string sent for the step being viewed, variables filled, token count. Read-only, with "edit this template ↗".
2. **Edit, per project** — Settings → prompts (frame 1g). Eight phase templates (plan, critique, revise, implement, verify, fix, review, answer), each stored as an **override diffed against the shipped default** so an upstream prompt improvement doesn't silently vanish behind a user edit.
3. **Override, one workstream** — named variants (`strict-tdd`, `docs-first`) defined at project level, picked at launch.

Prompts carry the thinking level per role — template and effort move together.

### 1b — All workstreams

Directly addresses the stated pain: *"I don't have visibility into my past workstreams and can't easily switch to them or start new ones."*

Active workstreams as cards on top (status, project, progress, severity chips, consumption, what it's waiting on). Below, a flat **cross-project** searchable history table: workstream, project, outcome (done / merged / abandoned), a rounds fingerprint (`p2 v1 r2` = rounds spent in each cycle — cheap to scan for runs that thrashed), consumption, when, and a reopen action.

**Resolved: build both.** They are different features. ⌘K (5f) is a *switcher* — "take me to `fix-ratelimit-wait`". This screen is *triage after a night of unattended work*, a reading task with sorting and history that a palette is bad at.

### 1c / 1d / 1e / 1f — Panes

- **1c Output** — filtered by phase, not one endless stream; raw log one click away. Header states who is running with which settings, never inferred.
- **1d Diff** — file list + hunks, with **inline comments that carry a severity the user picks**. Those comments become findings, merge with the reviewer's list, and are injected into the next FIX round. Human review and agent review use one mechanism.
- **1e Findings** — severity counters against tolerance, so the gate decision is legible: you can see *why* the loop chose to fix again rather than finish.
- **1f Questions** — open questions with the adversarial agent's draft answer and its confidence, plus per-workstream policy: ask the adversary for a draft / auto-submit non-blocking / auto-submit blocking / escalate on low confidence, and a **grace period (default 45s) before any auto-submit fires**. The countdown lives **only** in the loop-column footer — the chat card is a record and carries no timer. Two live timers for one event can drift, and drifting timers are how people learn not to trust them. The grace timer is the key move — auto-answer stays on for speed, but every auto-submit is visible and interruptible *before* it happens rather than discovered afterwards.

### 1g / 1h / 1i — Settings

- **1g Prompts** — template list with inherited/overridden state, editor with variable palette, per-template role+model, "diff vs default", "render preview" (the exact string with token count).
- **1h Project settings** — worktree root pattern, branch prefix, create script, **setup script** (runs once after create), teardown, "test scripts in a scratch worktree"; the **gate matrix**; round caps and P1 tolerance. Sidebar also lists roles & models, verify & toolchain, budget, prompts, MCP, and the raw `vibe.config.json`. **The form and the raw file are the same file the CLI reads and must stay in sync.**
- **1i Global settings** — accounts (Claude, ChatGPT/Codex, add provider) each showing plan, detected CLI version and **rate-limit headroom where you connect the account**, not buried in a status bar; default roles table (agent, model, effort, sandbox); MCP servers with enable toggles and a detail sheet carrying **per-role scoping** so a read-only reviewer can't be handed a write tool.

### 5a — Idle cockpit (the true home screen)

**A run is 60–90 minutes of watching.** The honest modal state of this app is *"one workstream, running, nothing for you to do for the next forty minutes"* — and an interface designed only for the interesting moment feels broken during the 95%. This state is as important as the busy one; build it alongside 3a.

What makes it work:

- The rail is **collapsed** by default here, and the severity readout in it collapses to a single verdict chip.
- The running row is the honest one (elapsed, tool calls, current activity, indeterminate bar, labelled proxy, past-run distribution).
- The **open-findings block states the consequence, not just counts**: *"Nothing is blocking. Next decision is the verify gate, after this turn."*
- The output pane ends in a **"nothing needs you" card**: what the next stop is, how long comparable turns took, and the one genuinely useful action — **review the diff so far**, because comments written now are queued as findings and reach the next fix round.
- **"Notify me and hide"** is the honest primitive. This app should be closeable; the notification and tray badge (4e) are what bring the user back.

### 5b — Staleness

For an app whose entire job is reflecting a long-running external process, **how old the thing on screen is, and whether it is still live, is a first-class concern** rather than a polish item. Three degrees, distinguished because "nothing happened" and "I stopped being able to tell" are different:

| State | Treatment | Copy |
| --- | --- | --- |
| live | filled dot, titlebar `live · updated 2s ago` | `last activity 8s ago` |
| quiet | hollow dot | `quiet · 6m` — the session is alive; a long thinking block or slow tool looks exactly like this. **Must not look alarming.** |
| stale | a strip across the whole window, not a dot | `stale · not live · last event 41m ago` — everything on screen is 41 minutes old and vibe cannot confirm the phase is still running. **Must not look normal.** `reconnect` / `see the drift` |

### 5c — First run & empty states

Each state teaches exactly one idea and ends in one obvious next action. No tours.

1. **No accounts — "Two agents, on purpose."** Teaches the adversarial premise up front: one agent writes, a different agent objects. Both provider cards show whether a CLI was detected on PATH. One is enough to start.
2. **No projects — "Point vibe at a git repo."** Teaches that a project is a repo and work happens in worktrees, never in your checkout. Drop target plus detected repos under `~/dev` as a list — most people add three at once.
3. **Project, no workstreams.** Shows the **preflight** result (worktree root, verify command resolves, roles are two different agents). This is the same probe that produces the `VERIFY CAN'T RUN` halt — better to fail here than after PLAN.
4. **Workstream created, not planned.** Three empty cycle boxes and a chat waiting on the brief — this is 4h, the only empty state that is a conversation rather than a call to action.

### 5f — ⌘K switcher

A **switcher, not a screen**: it answers "take me to `fix-ratelimit-wait`" and nothing else. Overlay on the cockpit, waiting workstreams sorted first and carrying a collapsed verdict chip. Two actions at the bottom (new workstream here, all workstreams).

1b stays as it is. Triage after a night of unattended work is a reading task with sorting and history, and a palette is bad at it. **These are two different features, not alternatives** — build both.

### 6a — The running row (build this exactly)

Third and final attempt at the element that is on screen longer than anything else in the app. Six lines, six measurements, no derived quantity:

| Line | Source |
| --- | --- |
| `9m12s` | wall clock since the turn started |
| `47 tool calls` | counted off the event stream |
| `editing src/auth.ts` | the most recent tool call, verbatim |
| `9 files modified · +412 −38` | worktree diffstat — a count, not a fraction |
| `last activity 8s ago` | time since the last event; the liveness signal |
| `comparable turns took 57–98m` | distribution over past runs of similar shape |

The pulsing dot is the only moving element — it carries "alive" so nothing else has to imply it. Header reads `claude/opus · medium`.

Each earlier attempt failed the same way: inventing a denominator to make waiting feel measured. Do not re-add one.

### 6b — `finishing · carried finding`

**When review passes with a tolerated P1, the loop runs one more fix round that is deliberately never re-reviewed**, verifies once more, and finishes. The code comment is explicit: another review round could raise something new and the loop would never end, which is the situation the tolerance exists to escape.

This is the **third distinct way a run ends** — clear, halted, or finished-with-a-carried-finding — and without a card it reads as the loop skipping a round, or as a fix that silently escaped review.

The card, in the loop column where halts live:

> **finishing · carried finding**
> `1 P1 within tolerance. Incorporating it, then done — this fix will not be reviewed again.`
> F-07 · P1 · final-fix · running → then: verify once more → complete
> **let it finish** · review it anyway · *(link)* drop the fix

Alongside it, the tolerance shown **being used**: review r1 P1 3 (over) → r2 P1 2 (over) → r3 P1 1 (at tolerance). Everywhere else `tolerance P1≤1` is a number in a corner; this is the one moment it does something, and it decides how the run ends.

"Review it anyway" spends a review round against the cap and re-opens the loop — offered because the user may disagree that this particular P1 was tolerable, but secondary, and the card says what it costs.

The finding's history in 4c gains a matching row: `final-fix · applied, not re-reviewed`. **The record must never imply more scrutiny than happened.**

### 6c — One provider connected (the degraded first run)

Someone with one subscription, trying this before deciding whether to buy a second. This is the **likeliest real first run**.

The honest pitch is not "connect both to continue" — it is "here is precisely what you lose":

- Preflight replaces its check line with: *"The implementer and the reviewer are the same model. The judge will be reviewing code from a conversation it remembers writing."* Plus: separate sessions per role reduce this; they do not remove it.
- Primary action is **run anyway**; "connect codex" is the secondary.
- **The caveat rides the run, not the launch.** Every critique and review header carries `same provider as the implementer` for the whole run. It is a standing caveat on the findings, in the place the findings are read — not a dismissible banner.

### 6d + 7a — Gate matrix on the real boundaries (replaces 1h's four)

A boundary is a place the loop can be held **because a checkpoint is written there** — which is what lets a halt card promise "nothing is lost". Use the code's own list, not invented boundaries:

| Checkpoint | What it holds | Default | Cap |
| --- | --- | --- | --- |
| `question-round` **(#139 — not a checkpoint yet)** | answerer resolves, plan revised — nested in plan-round | auto | 3 |
| `plan-round` | after each critique | auto | 5 |
| `plan-approved` | critique clear, before code | **stop** | — |
| `implemented` | turn done, before verify | stop | — |
| `verify-round` | after each gate run | auto | 3 |
| `review-round` | after each review | auto | 5 |
| `final-fix` | tolerated finding, unreviewed but still verified | auto | `once` |
| `complete` | holds before the run marks itself done, so the summary reads while the worktree is live | stop | — |

**`final-fix` is auto, and its cap reads `once, by construction`.** Two corrections from round 7:

- It is a boolean flag (`finalFixDone`, set once), not a counter — there is no `maxFinalFixRounds` to edit, and a number in a cap column implies an editable field.
- It does **not** hold the run. No reviewer checks the fix, but **verify still runs after it**, because the fix returns to the top of the loop where the gate is. So it is unreviewed, not unverified, and the change is bounded: one fix, against findings the reviewer already characterised, on a run that already passed review within tolerance. Stopping there converts a completed run into a stalled one at the worst possible moment. 6b's card **notifies**; the `final-fix · applied, not re-reviewed` row in 4c is the protection.

Tolerance sits with the caps, and the field notes that **raising it makes `final-fix` more likely**. The oscillation guard (3) is independent of the caps — it fires on a finding that keeps returning.

### 6e — Spend, reconciled (replaces 5e)

**Not all run spend belongs to a round**, so a per-round breakdown will never sum to the total. Draw the gap as a row with a reason:

> **unattributed · 440k**
> compaction & session rotation turns 210k · a failed turn, charged for what it spent 180k · stream ≠ provider on one turn 50k

Segments must sum to the stated total. Numbers that quietly disagree are worse than an explicit bucket. Issue #114.

Everything else from 5e stands: tokens only (no dollar mode — Codex returns no cost from any endpoint), pilot tokens shown but never summed into the run's ceiling, Codex context as a dashed empty track reading `n/a` with the reason.

### 6f — MCP server detail *(extended by 7h — read that first)*

Per-role read/write scoping as a table — **all five roles plus the pilot**: planner, implementer, critic, answerer, reviewer, pilot. The answerer belongs here specifically because it is one of the three judging roles in the independence check (6c); omitting it made two frames disagree about how many roles exist. The three judging roles are read-only by construction.

**Write is not offerable to a read-only role** — the cell shows a dash, not an unchecked box. The role's sandbox mode decides it, so the two settings can never contradict each other. Write tools are **named** (`create_pr`, `merge_pr`, `push`) so granting write is a specific decision rather than a category.

The pilot's row is why 4g works: the git tools available after DONE are the ones granted here. **The tool inventory is the pilot's capability surface.**

### 6g — Prompt scoping, three layers

`default → project → this run`, each layer a diff on the one above, with an **effective** view showing the summed string, its layers marked by origin, and a token count. Thinking level lives with the template — one is meaningless without the other.

**"Promote to project"** is one button: a run-level edit that worked is usually meant to be kept.

Mid-run this same view is the read-only `Prompt` tab — so "which text produced this output" and "where do I change it" are one screen at two permission levels.

### 7a — The question loop (changes the loop column)

Drawn as a **nested group inside the cycle 1 box**, indented with a left rule: `QUESTIONS · round 2/3 · answerer`, one row per question round (`r1 4 answered · plan revised · 3m40s`), the running one carrying its model, elapsed and liveness dot. Nesting rather than a fourth peer group, because that is what it is — iterating a plan before anyone critiques it.

**The user-facing problem this fixes.** A question round is two full turns of legitimate work that produce no critique, so the outer counter correctly sits at `cycle 1 · round 1/5` throughout. Without the nested group that is indistinguishable from a stall — and 7c would label it `thinking`, accurately but unhelpfully. So the frame carries an explicit panel: *"Two turns have run and `round 1/5` is still correct — a question round produces no critique, so it cannot advance the plan round. The nested counter is where that time is accounted for."*

**`question-round` is drawn as a gate row but is not yet a checkpoint.** `CheckpointBoundary` is `plan-round · plan-approved · implemented · verify-round · review-round · final-fix · complete`. The question loop calls `saveState` (persists, not a checkpoint); if the answerer returned answers it then calls `revisePlan`, which does checkpoint — but labelled **`plan-round`**, because that function is shared with the critique-driven caller. Two consequences:

- A question round that produced answers **is** checkpointed, under the wrong name — so nothing in the record distinguishes "revised because the critic objected" from "revised because it answered its own questions", which is the exact distinction 7a exists to draw and `q3 p1` in 7g depends on.
- A question round where the answerer declined everything gets **no checkpoint at all**. Every other round in the loop has one.

6d's guarantee is that every row can be held because something was written there. **Draw the row; it is not true yet.** Filed as **#139 (v1.4)** — small, closes the recovery gap, makes the fingerprint readable. Until it lands, 7a's matrix row and 7d's checkpoint line belong under *unbuilt* in 7i, not *real today*.

**Escalation at the cap:**

> **halted · STILL ASKING**
> `The planner is still raising questions after 3 rounds of answering its own.`
> r1 4 questions → answered · r2 2 → answered · r3 3 questions, 2 are new
> **answer them myself** · raise the cap · *(link)* critique as-is

"Answer them myself" is primary because it is the action that actually works — the planner is circling something it cannot resolve from the repo.

**This reframes 1f.** Questions are two things, and only the second was drawn:

- **Default: the loop answers.** The answerer resolves them and the human never sees them. This is most questions.
- **Escalation: the inbox (1f).** Reached when policy says so, confidence is low, or the cap is hit.

So 1f's policy toggles are really *when to break out of the loop*, and should read that way: ask me on low confidence, ask me for blocking questions, ask me always. The Questions tab lists **every** question with who answered it — an auto-answered question is still a decision on the record.

### 7c — Staleness from two clocks (replaces 5b)

**Not a threshold — a comparison between two fields the run state already maintains.** `lastActivityAt` advances on any child output *or* vibe's own heartbeat tick, and deliberately keeps advancing through a silent reasoning block. `lastOutputAt` is the last line a running turn actually wrote.

| State | Condition | Treatment |
| --- | --- | --- |
| **live** | `lastOutputAt` recent | filled dot, `output 8s ago` |
| **thinking** | `lastOutputAt` stale, `lastActivityAt` fresh | hollow dot, `thinking · 12m` + `activity 3s ago` — **stated as a fact, not a worry** |
| **not live** | **both** stale | a strip across the window, `nothing since 13:48`, reconnect / see the drift |

`turnStartedAt` separates "quiet because the turn started three seconds ago" from "quiet for twenty minutes", so a fresh turn never flickers through the middle state.

**The middle state is named `thinking`, not `quiet`** — the difference between reporting a state and reporting an absence.

**The retired 6-minute line stays on the canvas with its reason:** a turn emitting nothing for twelve minutes is a healthy turn, so a 6-minute indicator fires on healthy turns twice over, which is how a status light becomes something people stop reading.

The one judgement left is how stale `lastActivityAt` must be before the strip appears — and that is about vibe's own heartbeat interval, so derive it from the heartbeat (a few missed ticks) rather than picking a number.

### 7d — Hide vs quit

**vibe runs the loop in its own process**, so closing the window ends a turn mid-flight and every failure mode the recovery logic exists for becomes reachable by clicking the X. This makes window close a safety surface, not a convenience.

- **⌘W hides. ⌘Q asks.** In most apps closing the last window is soft; here the two must be different actions and the difference must be visible.
- **Hidden with runs live is a first-class state.** The tray *is* the whole app: no badge when nothing needs you, each run's phase and elapsed readable without opening a window (`add-appserver-auth · implementing · 24m`), show / pause everything / quit vibe… with the ellipsis promising a question.
- **The quit confirmation states the cost in the tool's own units — and the cost is not a re-send.** A killed run resumes its conversation **by session id** (`--resume`), which is exactly what the last release bought; there is no context re-send. What a quit destroys is the **turn in flight**: its spend is charged anyway and the turn is redone from the top. vibe knows that number — `inFlight` holds observed-but-uncharged spend per live turn. So the row reads `~180k spent on this turn — that work is redone`. "Unsaved work may be lost" is the sentence people learn to click through; a measured token figure is checkable.
  - One narrow exception: if the dying turn was the **first** on that session, the id is treated as burned and the next attempt starts fresh. A run killed mid-implement has already planned successfully on that session, so it survives.
  - **Codex reports usage only on `turn.completed`**, so a Codex turn killed mid-flight has no figure at all. That row says the spend is unknown and why — the standing rule again.
- **Primary is "hide instead."** A confirmation whose primary action is the destructive one is a speed bump. "Pause both, then quit" is the honest middle — pause writes a checkpoint and keeps sessions warm, so resuming is free rather than ~220k.
- **Coming back has two shapes:** quit-while-running arrives at `APP RESTARTED` (4d) with a drift diff; paused-then-quit resumes from a real checkpoint with nothing to reconcile. That difference is exactly what the dialog is buying.
- **Recorded as an outcome.** `ended by quit · turn 24m · checkpoint plan-approved` appears in 1b's history beside done, halted and abandoned — window close is about to be the most common way a run ends.

### 7e — Rate limits: Claude reports no headroom

`src/ratelimits.ts` mentions Claude **zero times**. It is entirely the Codex app-server:

- **Codex** — a real proactive reading: two windows (`primary`, `secondary`), `usedPercent`, `resetsAt`, `planType`, a configurable brake at 95%.
- **Claude** — **nothing until a turn fails.** A limit is detected reactively by matching an error's text, yielding a reset time and nothing else.

So `claude 38%` (3a tab bar, 5a tab bar, 4d's rate-limit card, 1i's "weekly 38% · resets Sun") was invented, in the same class as `step 9/14`. All four are corrected. The treatment is the one 6e established — and note it is the **exact mirror of the context case**, where Claude has the number and Codex does not:

```
codex    ████████████████░  95%   5h window · resets 14:52
claude   ─────────────────  n/a   no headroom is reported; a limit is
                                  only observable when a turn is refused
```

4d's card keeps its Codex bar and loses the Claude one; *"other workstreams using claude keep running"* stays, because it was true and never needed a number. The Claude variant of that card shows only a retry time.

Both invented numbers appeared where the design wanted symmetry between two things that are not symmetric. Worth watching for in hi-fi.

### 7f — Project settings split (replaces 1h)

`GitConfig` is `{ useBranch, branchPrefix, commitEachRound }`. There is **no worktree root pattern, no create script, no setup script, no teardown, no scratch-worktree option** anywhere in the config — so 1h's claim that "the form and the raw file are the same file the CLI reads" was false for half the page.

Split the screen, don't just label rows:

- **vibe config** (`vibe.config.json`, read by the CLI too) — the three git fields, the four round caps, `p1Tolerance`, `oscillationThreshold`, the verify command and its `runs`, budget ceilings, the role table, raw JSON.
- **app settings** (this app only) — worktree root pattern, create/setup/teardown scripts, notifications, prompts.

The app creates the worktree and runs the setup scripts **before** handing the directory to the loop. The split also answers a question the two halves answer differently: which settings travel with the repo, or to the CLI, or to a teammate's machine.

### 7g — History on the real fields (replaces 1b's table)

A `RunSummary` is `{ id, status, task, costUsd, liveness?, forkedFrom?, linked?, unverified? }`.

| Column | Treatment |
| --- | --- |
| status | done · stalled · needs-input · error. **`merged` and `abandoned` are gone** — merging happens in chat afterwards and the loop never learns of it |
| rounds | now `q1 p2 v1 r2`, four counters. Lives in each run's state, not the listing — fills in on open, reads `not in listing` until then |
| tokens | the listing carries `costUsd` only — Claude-only, and the unit we decided not to show. Tokens are read from the run's own state; `—` where a run predates the field |
| project | the archive is per-repo; the cross-project index is the app's own |
| resume | `vibe resume` |

The sharp one is consumption: the listing carries the unit we correctly decided not to show and omits the one shown everywhere else. Same answer as everywhere — an empty cell with a reason beats a number in the wrong unit.

The fourth fingerprint letter matters: a run that thrashed in *question* rounds rather than plan rounds is a different diagnosis, and it was invisible before 7a.

### 7h — MCP servers per role (extends 6f)

**No MCP surface exists in the loop yet, but the seam does — and it needs no new machinery.** `src/roles.ts` already defines a per-role toolset, and vibe builds a fresh role-specific invocation for **every turn**: a Claude turn gets `--tools <allow-list>`, a Codex turn gets `-c key=value` overrides (already how reasoning effort is set). MCP servers are more entries in a list vibe owns.

So 6f's role × read/write matrix was sound. Two changes:

**1. The built-in toolset is fixed, not configurable.** `roles.ts` refuses that deliberately: *access, schema and the tool list are facts about the work — a reviewer is read-only and returns findings whoever holds it.* What a run chooses is which provider sits in each seat and at what effort. **MCP servers become the single per-role opt-in.** Narrowing, not reversing: a reviewer cannot be handed `Write` by configuration, but whether it may reach the `github` server is a choice.

The screen is therefore **two tables, and its whole job is making obvious which half is a decision**:

- *Fixed* — role × access × built-in tools (Read · Glob · Grep · Bash · WebSearch · WebFetch), drawn as a statement with no controls.
- *Configurable* — role × MCP server checkboxes, **fail-closed**: a newly added server reaches nothing until it is named against a role (#138). The drawn grid is a project someone has already configured; an **empty grid is what a new install looks like**, and it is the state the screen should teach first, since a reader takes the default as the recommendation. Plus the pilot below a heavier rule (not a loop role; the only seat besides the implementer that may hold write — its `github` grant is what makes 4g's `gh pr create` possible).

A single combined matrix would have implied the built-in toolset was editable.

**2. Enforcement differs per provider, and the frame shows it.** Claude takes an explicit tool allow-list; Codex is governed by sandbox mode. An `enforced by` column tracks the role table, so swapping a provider changes it in front of the user.

**vibe replaces the agent CLI's own MCP config; it does not add to it.** This is #138's named trap: if vibe merely added, a user's globally-configured `github` would still reach the reviewer and the matrix would enforce nothing while appearing to. One line on the frame makes the promise true — *"the servers listed here are the only ones any role reaches."*

**One limit, stated on the frame: vibe is not in the tool-*call* path.** Calls execute inside the child and vibe reads a stream of events reporting what already happened. It controls *what a role may reach*, not whether an individual call proceeds — so this is a grant surface and the output stream is the record. **No per-call approval prompt can be promised.**

6f's line survives verbatim: *write is not offerable to a read-only role; the dash is not an unchecked box* — true of both providers, for different reasons.

### 7i — Provenance

Hi-fi covers the whole app, so every frame carries where its data comes from. A wireframe that quietly mixes shipped, planned and app-invented behaviour hands the implementer three kinds of work under one visual language.

| Category | Frames |
| --- | --- |
| **Real today** | 5a · 6a · 7c · 6b · 3a · 3b · 2d · 4d · 4e · 5c · 6c · 1e · 7a · 7d · 7e — with two named holes carved out of 7a and 7d for the `question-round` checkpoint |
| **App-side** | 4h brief versions · 4g DONE summary · 1d human findings · 1b cross-project index · 7f worktree scripts |
| **Unbuilt** | 1c phase-filtered output (#133) · 1f live inbox + gate cards (#134) · 4c ungrounded flag (#113) · 1b fingerprint (#114) · 5d gate verdict (#135) · 7h MCP surface · **7a's `question-round` matrix row and 7d's checkpoint line (#139)** · 4i / 1g / 6g prompts (#137) |

**App-side means the loop never learns of it.** 4h's promise — "you can tell whether the brief or the planner was wrong" — is only true because the app stores brief versions; there is no brief concept in the loop, only a task string, and its prompt module treats it as one ("a task is a whole brief").

**7i rots faster than anything else in the bundle** — every issue that lands moves a name from *unbuilt* to *real today*. **Check it first at the start of a hi-fi round, not last:** rendering something in the wrong category is how a promise the loop cannot keep gets built.

Two notes on the unbuilt row: the **prompt surfaces are v1.5** — treat them as unbuilt rather than merely undrawn, and don't schedule hi-fi around them. **7h's MCP surface is new UI over an existing seam**, unlike the rest of the row.

Two claims softened: `persisted` is a **text-similarity inference, not an id lookup**, so 4c reads `likely the same finding` and links both claims for checking. And **verify artifacts are keyed by `reviewRound`, not `verifyRound`** — a UI numbering verify runs under cycle 2 will not match the filenames.

**1f and the gate cards are one feature.** Escalated questions are file-based today (`NEEDS-INPUT.md` with a `**Your answer:**` block, read on resume) — the process has already exited by the time you answer. In-process they become a live inbox, which is the same host-decision mechanism the gate cards need. Draw them as one thing.

## Interactions & behavior

- Gates: at a stop-mode boundary the loop halts and the gate card offers approve / hold / inspect. Auto boundaries proceed with a short visible countdown.
- Auto-answer: draft shown with confidence, countdown visible, interruptible.
- Selecting any version row (loop column or Versions tab) opens the round detail (2d): critique findings on the left with resolved/persisted status, artifact diff on the right.
- Collapse state of cycle groups persists per workstream.
- Long-running phases stream output; the loop column shows elapsed time, tool-call count and the current tool call inline — never step progress, which does not exist.
- No animation direction has been set. Keep transitions minimal and functional.

## State

Per workstream: current cycle, current round + cap, versions[], findings[] (with severity, provenance, evidence, disposition, per-version status), questions[], gate config (inherited + overrides), roles config, worktree status, consumption, context %, halt state.

Per project: worktree scripts, gate matrix, round caps, tolerance, prompt overrides, role defaults.

Global: accounts + rate-limit headroom, MCP servers + role scoping, model defaults.

Cross-cutting: the "needs you" queue driving the tray badge and rail sort.

## Design tokens

The wireframe uses the **Industry** design system's tokens via `_ds/industry-.../styles.css` (included). Treat this as the *wireframe* palette only.

Values used in the frames: ground `#f2f2f3`, frame borders `#b7b7ba`, inner rules `#d4d4d7`/`#e7e7ea`, text `#1d1f20`, secondary text `#5d5d60`/`#7a7a7d`, accent `#5980a6`, accent deep `#416180`, accent tints `#dfe8f0`/`#d6ebff`/`#f4f7fa`. Type: Barlow Condensed for headings and labels, Barlow for body, system monospace for paths, commands and counts.

**Severity chips** — structurally the strongest pattern in the bundle, and the biggest density risk. Four chips at four zoom levels means three projects × three workstreams = 36 chips in the rail before the eye reaches anything that matters.

**The density rule: always four wherever the tolerance is in play; a collapsed verdict everywhere else.**

- **Four chips, zeros shown** — version rows, cycle headers, the open-findings block, the round detail. A **gate decision** is being made there, so absence is information.
- **One collapsed verdict chip** (`1 blocking`, `clear`) — rail, ⌘K, dashboard cards, chat cards. There it is a status, not a decision.

Weighting: P0 darkest solid, P1 accent solid, P2 light tint, P3 outline, zero counts dashed and greyed — severity reads by weight rather than hue. Whatever the hi-fi palette becomes, keep the order and keep zeros visible in the four-chip form.

Hi-fi will be **dark-primary, light secondary**. Not yet designed.

## Assets

None. No images, no icon set chosen. Icon references in the wireframes are text glyphs standing in for a real set (Industry specifies Lucide at stroke-width 1.5, but the hi-fi round has not confirmed it).

## Files

- `Vibe Cockpit hi-fi.dc.html` — **the first hi-fi screen.** Open in a browser.
- `Vibe Wireframes.dc.html` — the wireframe canvas, rounds 1–8. Open in a browser.
- `support.js` — runtime required by that file.
- `_ds/industry-6a8d2bb4-ca81-4dbb-9ea0-d5c812066f0e/` — the wireframe design system's stylesheet and bundle.

## Still not drawn

Nothing queued. Round 6 closed the MCP detail sheet (6f) and workstream prompt scoping (6g).

## Hi-fi — revision 2

`Vibe Cockpit hi-fi.dc.html` is a scrolling canvas of four hi-fi studies at 1440×900:

1. **The idle cockpit** — 5a with 6a's running row. First, because idle is the modal state: a run is 60–90 minutes of watching, and an interface designed only for the interesting moment feels broken during the 95%.
2. **The blocking cockpit** — `P0 2 · P1 3 · P2 4 · P3 1`, oscillation halted, the 4d halt banner in place of the footer controls.
3. **Five kickers** — `halted / blocked / crashed / waiting / recovered` separated without hue.
4. **Absence in colour** — Claude's context bar beside Codex's `n/a`, and the mirror case for headroom.

Between 1 and 2 sits the **ramp study**, which is the reference for everything after it.

**Review this for the visual system, not the content** — the content is 5a/6a as specified in this document, and any content change should be argued against those frames rather than against the render.

### Dark treatment, derived from Industry

The bound design system (Industry) is a light steel-on-paper wireframe system. The dark treatment keeps its grammar and moves the ramp:

| Role | Value | Note |
| --- | --- | --- |
| ground | `#0e1012` | page behind the window |
| window / panel | `#141719` · `#16191c` | one step apart, no more |
| titlebar / chrome | `#101315` | recedes below the content |
| hairline rules | `#2e3236` · `#2b3034` · `#232a30` | three weights, all hairline |
| primary text | `#dbe4ec` · `#e7e9eb` | headings and live values |
| **text tiers** | `#c3c8cc` primary · `#9aa0a5` secondary · `#8f9498` tertiary | **three, and the floor is `#8f9498`** |
| **accent, line & type** | `#94bce3` (Industry `--color-accent-400`) | **lifted one step** — `--color-accent` at #5980a6 lacks contrast on a dark ground for thin rules and small type |
| accent, fills & tints | `#5980a6` borders · `#1b2a38` · `#1a2530` fills | the base steel, used as field |
| accent, bright | `#b5d9fd` | text on an accent-tinted field |
| liveness | `#7fb069` | see below |
| non-text greys | `#4a4f54` · `#3d4247` · `#2e3236` · `#232a30` | dashed chip borders, control borders, structural rules, in-panel rules |
| **severity P0** | fill `#dbe4ec`, digit `#0e1012` | the highest luminance on the screen |
| diff minus | `#c07a6a` | log only |

### The ramp — revision 2, and the rule behind it

**On a light ground you can build hierarchy downward into the background; on a dark ground you cannot.** Revision 1 carried four greys below body text — `#6c7176`, `#5f6469`, `#565b60`, `#4e5358` — at **2.3–3.8:1**, all of it under 14px, all of it failing AA. They were carrying the output log (the main content of the largest pane, on the screen whose job is to be watched), every path on the screen, and the zero severity chips.

The fix was not to lighten each grey a notch:

1. **Three text tiers, floor at `#8f9498`** (5.9:1). The AA floor on these grounds is about `#7b8085`, so the tertiary tier is already near it — there is no room for a ramp beneath.
2. **`#4a4f54` and darker are non-text only** — hairlines, rules, dashed borders. They are good at that; they were never text.
3. **Build hierarchy upward.** There is headroom above `#c3c8cc` and almost none below the floor. Further recession uses **size and weight**, not colour.

**If a value is a measurement it is monospace.** The Barlow/monospace split is load-bearing — a number never sits in body type.

### Severity on dark — rebuilt, not inverted

Round 6's light weighting was P0 darkest solid → P3 outline, so severity read by weight rather than hue. **That does not invert cleanly:** on dark, "darkest solid" is a near-black chip on a near-black ground, which is the recessive end. So the ramp is rebuilt with **weight ascending with severity**:

| Bucket | Treatment |
| --- | --- |
| **P0** | solid `#dbe4ec`, digit `#0e1012` — the highest luminance on the screen |
| **P1** | solid `#94bce3`, digit `#0e1012` |
| **P2** | `#1b2a38` fill, `#4a6b8c` border, `#b5d9fd` digit |
| **P3** | no fill, `#4a4f54` border, `#9aa0a5` digit |
| **zero** | dashed `#4a4f54` border, digit at the text floor `#8f9498` |

Two consequences worth keeping:

- **P0 uses the pale tone, not the accent** — which is what keeps it from competing with the primary button, and it means a run in trouble looks different from across the room.
- **A zero's digit is legible.** Round 6 argued that zeros are shown deliberately because absence is information and a gate decision is being made there. Revision 1 put them at 2.57:1, which hid them — the one place the visual treatment reversed a rule the wireframe rounds had settled.

That pale family also carries the **halt banner's border**, so the banner and the P0 finding that caused it read as one family.

### The five kickers, without hue

A mono-accent system cannot colour-code five states, so they separate on **fill weight and border** — the same ramp the chips use. Ordered by how much of the user's attention the state deserves:

| Kicker | Treatment |
| --- | --- |
| `halted` | solid `#dbe4ec` — stopped, needs a decision from you |
| `blocked` | solid `#94bce3` — stopped by something outside the loop |
| `crashed` | accent tint — retrying on its own; visible, not actionable yet |
| `waiting` | outline — needs no decision, so it must not look like it does |
| `recovered` | dashed outline — already handled, here for the record |

### Absence, in colour

A dashed empty track at 1.5:1 says "nothing here", not "unavailable, and here is why". Both absences — Codex context, Claude headroom — are drawn as **the same mirrored object**: a dashed `#4a4f54` border plus a faint 135° hatch, so it reads as *a track with nothing in it* rather than a track at zero. A flat outline could not carry that at this contrast. Each states its reason directly beneath, and `n/a` sits at the text floor.

### Rules the render is applying

1. **Solid accent = exactly one primary *action* per region — and a state is not an action.** Round 6 split the footer precisely because mode and action were being drawn alike; revision 1 re-merged them by filling the `auto` chip. The mode control is now bordered-active (`#4a6b8c` border, `#1b2a38` fill, `#b5d9fd` label with a dot), and the solid fill is left for the one thing that will *do* something.
2. **Registration marks twice, not everywhere.** On the window frame (the app itself is the blueprint object) and on the one card that asks something of the user. At this density, marks on every panel are noise — a deliberate departure from "never drop the marks from a framed element", justified by an app UI having thirty framed elements per screen where a marketing page has three.
3. **Two moving things, and they are the same thing.** The liveness dot in the titlebar and in the stream, on a 2.4s pulse. Nothing else animates. A screen watched for forty minutes cannot have decorative motion.
4. **Green is not a second accent.** `#7fb069` appears only for liveness and diff additions — both cases where it means "alive" or "added", never as a status colour or a brand tone.
5. **No progress track.** The running row is 6a exactly: six measurements, no bar. See "Never invent a number".
6. **Severity chips are rebuilt for dark**, per the table above. Structure unchanged from round 6: always four, always in order, zeros visible *and legible*.
7. **Rail collapsed by default**, 54px, giving the right pane ~1014px on a 1440 window.
8. **Scope your reassurance.** The idle card reads "Nothing needs you **here**" — it is scoped to one workstream, and the rail can legitimately show a needs-you dot on another at the same time. One word stops the two contradicting each other.
9. **Type is Industry's pairing, unchanged.** Barlow Condensed for every label, kicker and heading (uppercase, wide tracking); Barlow for body; system monospace for paths, commands, counts and times. The split is load-bearing: **anything measured is monospace**, so a number never sits in body type.

### Not yet rendered

The quit dialog (7d), the question loop nested group (7a), the verify pane (5d), the launch dialog (4a), the settings surfaces (7f, 7h) and the history screen (7g). The shell is meant to hold all of them without new chrome.

The three hardest palette problems are now settled — non-zero severity, the five kickers, and absence in colour — so the remaining screens are composition rather than system work.

## Open, and worth raising rather than inventing

The round-5 review closed the earlier open questions. What remains:

Round 7 closed the remaining ones: `quiet` became provable from two clocks, `final-fix` became auto, "notify me and hide" became a real window state, and the MCP question resolved by narrowing. What is open now:

- How many missed heartbeat ticks should trigger the **not live** strip in 7c.
- Whether the question loop's nested group should stay expanded by default during a question round (it accounts for otherwise-unexplained time) or collapse like the other completed groups.
- Whether making the role toolset configurable at all is right, or whether even the MCP opt-in should be fixed per role.
- Where the "notify me and hide" state actually goes — a real window state, or just a notification preference.

## One standing request

**Where a readout cannot be produced, draw the absence explicitly rather than omitting the row.** How this tool says "I don't know" is a large part of its character, and it is the thing a wireframe is best placed to get right.


## Hi-fi revision 3 — one meaning per treatment

The five-step weight ramp encodes three orthogonal systems (severity, run state, interactivity). Only one of them may use a **solid fill**, and it is interactivity:

- **Solid = interactive.** `#94bce3` fill + `#0e1012` text, one per region. Secondary is a `#3d4247` 1px border; tertiary is an underlined label at the text floor.
- **Severity = weight, drawn as rule.** P0 `2px #dbe4ec` border + `#dbe4ec` text, no fill · P1 `1px #94bce3` border + `#94bce3` text · P2 `#1b2a38` tint + `#4a6b8c` border + `#b5d9fd` text · P3 `1px #4a4f54` border · zero `1px dashed #4a4f54` at the text floor. Weight still ascends with severity.
- **State kickers keep their solid fills.** A kicker is one wide label at the top of a banner, never sitting in a row of four numerals, so the family reads without the ambiguity.
- **Quantity is a fourth system with its own steps.** Phase shares and run bars descend `#7fa3c4` → `#4a6b8c` → `#33475a` on a `#232a30` track. The pale `#dbe4ec` is reserved for alarm (headroom near cap, a failing sliver).
- `#5980a6` is not a chart step. The oscillation chart alternates `#4a6b8c` / `#94bce3`.

### Screens added in hi-fi round 3
- **Pilot chat** (first tab, default view). Round cards: who/how long → one sentence → severity row → actions. Settled rounds keep the shape at lower weight; the live round gets the accent border and registration marks. User turns are the only tinted ground in the transcript (`#161b20` + `2px #4a6b8c` left rule).
- **Verify pane.** Verdict is a sentence at 30px (`2 of 3 clean`) with a kicker naming one of three verdicts: passed (3/3, advances if the gate allows), flaky (1–2/3, always stops), broken (0/3, returns to fix without asking). Three run bars, then the single test that disagreed with itself. No per-test table — the other 183 tests are not listed. Raw log present, collapsed, tertiary.


## Hi-fi revision 4 — corrections from feedback r3

- **The solid-fill rule, with its exception written in.** *Solid fill is for interaction, plus the single state label that leads a banner* (`halted`, `blocked`, `flaky`, `broken`). Never two solids of the same fill in one region; never a solid on anything that sits in a row. A banner kicker is a wide single label, not a numeral in a row of four, so it is not confusable.
- **Charts take the quantity ramp, not the accent.** The oscillation chart alternates `#4a6b8c` / `#7fa3c4`. `#94bce3` means pressable and must not appear as a bar fill.
- **The tab-bar percentage is labelled with what it measures.** `codex 5h 41%` is headroom; `claude ctx 61%` is context. They are different quantities and only one is available per provider (see the absence pair in hi-fi 4), so the slot cannot be left unqualified.
- **Cycle 2 never reads terminal.** `re-runs on every fix` everywhere; `verified` and `closed` are both wrong while a fix round can still land.
- **Role labels carry template and effort together**: `codex/gpt-5.6-luna · high`.

### Provenance
Hi-fi 6 (verify pane) draws **#135's future behaviour**: today the gate stops at the first failing run, so three completed runs cannot occur yet. It belongs under *unbuilt* in the 7i provenance table.

The gate label *"a flaky verdict never advances on its own"* is **not** #135 behaviour — that issue changes what the fixer is told; the round still advances to FIX automatically. Holding for a human instead is a behavioural decision, raised as a question on #135 and marked `proposed` on the screen. It needs an answer before the label ships.


## Hi-fi 7 — the form vocabulary (7f project settings)

Settings was drawn first because the form controls unblock 7g, 1b, 7h, 1f, 1i and 4a. Rules established:

- **Field**: 32px, `1px #3d4247` border, `#16191c` ground, value in mono `#dbe4ec`. Label above in 10px condensed caps at the text floor.
- **Focus** is a `1px #94bce3` border plus a caret — never a fill. An input is a place to type, not a thing to press.
- **Empty field**: `1px dashed #4a4f54` with `not set` at the floor — the absence rule, one level down.
- **Radio**: 12px square, selected = `1px #94bce3` border with a 6px `#94bce3` mark. **Checkbox**: 13px square with a `#94bce3` ✓. Square, never round.
- **Locked control**: `1px dashed #33383d`, and any mark inside it drops to rule grey `#4a4f54` — a fact about the loop, not a choice.
- **No pill toggle.** A two-state switch is two cells of the segmented control the mode chip already uses.
- **Table** (inherited by 7g / 1b / 7h): 30px header on `#131618`, tertiary condensed caps; 34px rows on `#232a30` hairlines; current row washed `#161b20`; numerics right-aligned in mono. No zebra, no vertical rules — which requires the table be **sized to its content, not to the pane**. A full-bleed table with no rules and no zebra puts the label 400px from its own controls; the gate matrix is capped at 940px.
- **Dirty bar**: a 56px footer naming the changed fields, one primary `Save`, and `Apply to running workstreams` as secondary — it is the action that can surprise you.

### Gate matrix — corrected against the code
Rows are the code's own checkpoint boundaries, in order, with a **boundary** column keeping the mapping recoverable under the friendlier names:

| Row | Boundary | Cap |
| --- | --- | --- |
| Critique returned | `plan-round` | 5 · `maxPlanRounds` |
| Plan accepted | `plan-approved` | — |
| Implement complete | `implemented` | — |
| Verify verdict | `verify-round` | 3 · `maxVerifyRounds` |
| Review returned | `review-round` | 5 · `maxReviewRounds` |
| Final fix | `final-fix` | once, by construction (locked) |
| Run complete | `complete` | — |

There is **no fix cap** — fix rounds are counted by the verify and review counters. The five editable caps are `maxPlanRounds 5`, `maxReviewRounds 5`, `maxVerifyRounds 3`, `maxQuestionRounds 3`, `p1Tolerance 1`, with `oscillationThreshold 3` and `convergenceWindow 3` beside them.

**The whole Gates section is #134 and unbuilt** — one gate exists today, with no per-boundary mode, no step and no countdown. The `proposed` chip sits on the section heading, not a row.

### Budget
`budget.maxTokens` 25,000,000 is the only ceiling that counts both agents, so it is the one that actually bounds a run; hitting it exits resumable. Beside it: `planShare` 0.4 (planning may take at most 40% of the ceiling), `codexLimitPercent` 95 (stop before starting a turn the window will kill partway through), `waitOnRateLimit` true / `maxWaitMinutes` 360 — which is the wait/halt switch. `context.compactAboveRatio` 0.5 and `compactDuringCodex` live in the same section.

`budget.maxCostUsd` is drawn as an **empty dashed field labelled `not offered`** with its reason beside it. It is Claude-only, so a dollar ceiling would bound half a run. The settings screen is where tokens-only becomes a visible product stance rather than a caption on the spend panel.

### The settings nav
Project settings are **one scrolling page**; the nav is its table of contents. Every row under the project heading (Repository · Verify · Gates · Budget · Loop limits · Roles & models · MCP servers · Prompts) is a section anchor, and the accent left-rule means *you are here in the scroll*, not *this is the page*. Only the Global group is a separate destination. One dirty bar, one save, for the whole config.

### The app / config split
Rows tagged `app` are the desktop app's own and never reach `vibe.config`: repository path, base branch, worktree root, wall clock, the notification preference. `GitConfig` is exactly `useBranch · branchPrefix · commitEachRound`; `VerifyConfig` is `enabled · command · timeoutMs (default 15) · runs · gates`. There is no serving concept — the earlier "serve for the gate" control was invented and is gone.

### Still to draw
1d diff + inline comment composer (largest — no diff rendering exists yet, and `#c07a6a` has one instance in the file), then 4c findings lifecycle, 4a launch modal, 5c first-run/empty. Cheap and riding along: 7c staleness, 7d quit, 7a question loop. 6g/1g/4i prompts stay undrawn until #137 is answered.


## Hi-fi 8 — diff and the inline composer (1d)

**Diff pair on the dark ground.** Added row `#3f483f` / gutter band `#4b554b` / mark `#9ad183` / numbers `#dbe7d6` / code `#d7e6d1`. Removed row `#352f30` / band `#443a3b` / mark `#e0a596` / numbers `#e6d2cc` / code `#e8cfc8`.

**Contrast ratio is the wrong instrument for added-versus-removed.** It measures luminance only, so two equal-luminance hues score 1.0 while being perfectly discriminable. Hold ratio for the two questions it answers, and let hue do the rest:

- **row vs base** — is the row visible at all? Both rows ~1.56–1.59, deliberately **symmetric**: scanning a diff depends on removals being as findable as additions.
- **text on row** — is the code readable? Never below 5.3.
- **added vs removed** — carried by **hue at ~6.8% HSL saturation in the rows as well as the gutter**, not by lightness. Row `#343c34` / `#3f3737`; gutter `#414b41` / `#4b4242`. Eight levels of channel spread, not four: at four the pair is a just-noticeable difference and the glyph is doing the work again.

Two failure modes already hit: a first pass at 1.10–1.16 where the backgrounds were decoration and the glyph did all the work; a second at 1.90/1.38 which fixed visibility but halved saturation, made the rows asymmetric, and put the added row above every card in the app.

**Hue lives in the gutter**, 20px wide and repeating down the edge, which is where 6% of a hue is legible. Unchanged context stays `#9aa0a5`.

**Gutter**: two 46px right-aligned number columns on `#131618`, then a 20px mark column. Hunk header on `#131618` with the `@@` range and the enclosing symbol.

**Selection** is a 2px `#94bce3` left rule that runs down the chosen lines and continues into the composer's edge, so citation and claim read as one object.

**Truncation.** The reviewer's diff is `git diff <base>..HEAD` capped at 400,000 chars, drawn as a full-width dashed-hatch band at the cut point and repeated in the file list.

Say only what is true: **the diff it was handed stopped here** — not that it saw nothing below. The reviewer holds `Read · Glob · Grep · Bash` and can open any file. Whether it did is recorded: `TurnActivity` carries a per-turn tool count (the same data `isInert` reads), so the band states it — *"the reviewer made 34 tool calls after this point"*, or *"the reviewer ran nothing"*. That turns an alarm into a judgement from data that already exists.

Related, and #113's territory: `checkEvidence` verifies a citation **resolves on disk**, not that the reviewer was ever shown it. A finding citing a truncated-away file passes grounding while possibly resting on nothing the reviewer read.

**The composer produces a `Finding`, not a comment**: severity radio row (the outline chips as options), title, detail, optional suggested fix, and an `evidence[]` entry filled in automatically — a selection anchored to `file:line` is structurally `{ kind: 'code', path, line, excerpt }`, which is what the grounding check validates. **A human finding is grounded by construction where an agent's has to earn it.**

Carries `proposed · app-side`: no human-authored finding path exists — no merge with the reviewer's list, nothing reaching `fixPrompt`.

## Hi-fi 9 — findings lifecycle (4c)

**Two downgrades, different accusations.** Grounding (#48) — *this claim cites nothing that checks out* — lives on the card. An inert turn (#66) — *the reviewer never ran anything* — indicts the whole round, so it is a band above the list wearing the pale severity tone plus the hatch: something is wrong, and what is wrong is an absence.

**A demoted finding keeps its history in a sentence**: "the reviewer called this P0 — the excerpt does not appear in src/auth.ts". No strikethrough, no badge. It stays in the artifact at the severity the guard set and stops forcing a round. Demoted, not disproved. A *restore* link sits at tertiary weight.

**Absent and broken evidence are one case** deliberately (`parseFindings` is tolerant) — no third state.

**Evidence kinds.** `code` · `artifact` · `absence` resolve against the filesystem: solid-bordered accent tint with a ✓. **`external` is uncheckable** — dashed accent border, and the card's left rule goes dashed too. The accent because it passed grounding; dashed because nothing verified it. "This P1 rests only on an unverifiable external claim" is a distinct confidence tier, and `finding_downgraded` records the kinds each finding offered, so it is drawable.

**Attribution names the author, not the disposer** — the disposition line beside it carries "declined by you · …". Same slot, one role.

**An `external` card shows its `ref`**, because a non-empty ref is the whole citation and the only reason the finding kept its severity. Never "no path".

**`persisted` is an inference**, matched by the oscillation guard's similarity metric, not by id — 21/21 on claim text, 19/21 on citation over 276 findings. Drawn as a dashed `likely the same` chip, the same object the zero counts use.

**Dispositions.** Accept → FIX (text goes into `fixPrompt` verbatim) and Defer (`FOLLOW-UPS.md`, P2/P3 only — drawn **dashed rather than disabled** on a P0, because it is unavailable by rule, not by state) are real. Decline exists as `declined?: Finding[]`; the reason field needs confirming. **Human-attributed downgrade does not exist** — `downgraded` is only ever written by the two guards — so it carries `proposed`.


## Hi-fi 10–14 — the closing round

### Elevation (4a launch modal, inherited by 7d)
The **only** modal surface in the product, so this is the whole rule: scrim `rgba(8,10,12,.76)`, surface `#16191c` (the card colour — unchanged, because the palette spent its light end on severity and a pale panel would read as an alarm), border `1px #4a6b8c` with accent corner marks, and `0 28px 70px rgba(0,0,0,.62)` — **the only shadow in the product**. Everything else is a line drawing on one plane, so a shadow can mean exactly one thing.

Launch order is task → pilot conversation → derived brief (editable in place) → overrides. **Overrides list only what differs from the project default**, run value in primary weight with the project's beside it in tertiary, plus one sentence naming everything that follows the project.

### 7d — hide vs quit
The cost is **the turn in flight, not the conversation**. Resuming continues the same session by id; nothing is re-sent. What quitting destroys is the partial turn and the tokens it has already spent, which will be spent again from the same start. A live **Codex** turn is drawn as a dashed `unknown` — Codex reports usage only on `turn.completed`, so a killed turn has no figure; not zero, not an estimate. Primary is `Hide instead`. The tray with no window open is part of the screen.

### 5c — first run and empty states
Four states, one idea and one action each, no tour. The one-provider case **grades its two warnings**: shared *conversation* takes the pale severity rule (structural — the reviewer is checking its own work), shared *model* takes the accent tint and the word *weaker*. Drawing them at equal weight would be the easy lie. The empty findings pane shows four dashed zeros rather than a blank — *nothing found yet* is not *nothing to find*.

### 7c — staleness, on two clocks not a threshold
`lastOutputAt` stale + `lastActivityAt` fresh = **quiet**: dot goes hollow and stops pulsing, label reads *still working*, elapsed lifts to primary. Twelve minutes of silence is a documented healthy turn, so quiet must not look alarming. Both stale = **stale**: a full-window strip wearing the halt banner's pale border and kicker, because the run has stopped being a run. Both states print both clocks — the same two numbers the code branches on.

### 7a — the question loop
A nested group inside cycle 1 with its own counter (`round 2/3` inside `round 1/5`), built from the settings checkbox and existing inset borders. While one runs the column says `waiting on you · not stalled` with a hollow dot, so a motionless column does not read as a dead run. At `maxQuestionRounds` the group escalates to `STILL ASKING` — the group only, not the run — offering answer anyway / rewrite the brief / split into two workstreams.


## Final corrections (r9)

- **Liveness is three-valued** — running / dead / **unknown** — so staleness has four states, not three. Both clocks stopped *and* the probe unable to answer is the worst state the app can report: `pid · cannot tell` in the dashed absence chip, and the only place `kill and resume from the last checkpoint` is offered. An unasked question and an unanswerable one are the same thing; don't collapse them into "dead".
- **At `maxQuestionRounds` the card offers raising the cap.** It is what the run itself suggests and it is one config value. Order the four ways out by cost: answer · raise the cap · rewrite the brief · split into two workstreams.

## Carrying into implementation

- **The `proposed · #NNN` chips are a live index** of promises the UI makes that the code has not kept: #134 (gate matrix), #135 (verify runs), and three on the findings screen (human-authored findings, the composer, human-attributed downgrade). They come off as the issues close. Any that survives to a build is a screen shipping ahead of its behaviour.
- **The contrast floor is a rule, not a result.** `#8f9498` is the last passing step on these grounds at 5.47–6.09; anything dimmer is a border, not text. It held across 986 elements and it is the first thing that will slip once real content arrives.


## Hi-fi 15–18 — four states added after the design system shipped

Drawn in `app/src/design/tokens.css` values only. Nothing new: no hex, no size, no spacing step outside the 42/9/8.

### Coverage check — do the existing screens cover #208 / #210 / #211?
Partly. Read the overlap as follows before building:

- **4a (hi-fi 10, launch modal)** covers everything up to the press of *Start the run*. It does **not** cover what happens after: the modal dismisses and both panes are empty. Item 2 is genuinely undrawn — hi-fi 16.
- **Hi-fi 5 (pilot chat)** has settled round cards, but a settled card in the transcript is *quiet*: version label recedes, no measurements at primary weight. A turn ended **at a holding gate** is the opposite requirement — completely still, fully measured, because a decision is pending on those numbers. Not the same component; hi-fi 17.
- **3a's pause control** (`⏸ pause after this turn`) is real and covers pause. There is **no stop** anywhere in the bundle, and the two must not be confusable — hi-fi 18 draws both side by side.
- **7d (hi-fi 11, quit)** already establishes the cost language stop needs, and hi-fi 18 reuses it: work in flight lost, tokens already spent, run stays resumable.

So: one of the three is covered, two are not, and the pause/stop pair is one screen rather than two.

### 15 · Diagnostics
Permanent `HOST 43804` / `PROTOCOL 1` chips are removed. The titlebar keeps one tertiary `•••` affordance (⌘⇧D). A chip appears **only when a value is wrong**, in the alarm tone, and names the disagreement rather than the value — `protocol 1 · expected 2`, not `PROTOCOL 1`.

The panel holds four facts, each with the sentence that makes it usable: **run id** + its `~/.vibe/runs/` path (the complaint was finding artifacts, not seeing the id), **build** `0.4.2 · 9f3ac81` + `built 6 Sep, 18:22` (two builds of one version are otherwise identical), **host pid** + uptime, **protocol** + expected. Every value mono with a copy control — these are strings destined for a bug report.

It is a **popover, not a modal**: modal border, marks and shadow, but **no scrim**. Diagnostics are read while looking at what went wrong. The only elevated surface in the product that does not block.

### 16 · Launching — honest waiting
No bar (no denominator), no ETA, no spinner, no skeleton. Instead:

| instead of | drawn as |
| --- | --- |
| progress bar | three checkboxes — two done, one running: task reached the core (timestamp) · host alive (pid) · preflight probing (elapsed) |
| ETA | `preflight usually clears in under a minute` — a claim about the past |
| spinner | the existing liveness dot + elapsed. One pulsing element |
| skeleton | dashed hatched cycle rows: *these three stages exist and none has begun* |
| zeroes | dashed `0` on tab counts; `no turn has reported` where spend goes |

**Preflight takes the live card** — accent border, pulse — because it *is* a real turn against a real CLI. This is not a special state with its own vocabulary; it is the cockpit with one card in it.

A dashed block names what is unknown and attributes it: *phase, round, elapsed total and spend — the first turn has not reported.* Without it the next reader assumes four numbers were forgotten. Exit is **Cancel before it starts** — different wording from stop, because nothing has been spent.

### 17 · Turn ended while a gate holds
The single change that fixes the six-hour hang: **every relative time becomes absolute.** `activity 6s` is a claim that must keep being true; `last activity 14:52` is true forever. Elapsed takes the past tense — `ran 1h 04m · ended 14:52`.

Removed: accent border + corner marks (→ `#2b3034`), active ground (`#161b20` → `#16191c`), accent version label (`#b5d9fd` → `#9aa0a5`), the liveness dot entirely. **Kept at primary weight**: tool count, last activity, spend, the summary line — these are what the pending decision rests on. Settled ≠ unimportant; the transcript's settled cards can recede, a card at a gate cannot.

A `held` kicker inside the card names why nothing moves, so the card goes completely still without reading as failure. `Continue to verify` is the only solid fill.

### 18 · Stop, and its distinction from pause
Two footer controls, one above the other, neither a primary:

- `⏸ Pause at the next gate` — *lets the turn finish, then holds. Costs nothing.* Border `#3d4247`.
- `⏹ Stop this turn now` — *kills the agent mid-turn. Confirms first.* Border `#4a4f54`, plus an `ends the run` chip in the alarm tone.

**The labels carry the distinction, not the colour** — they differ in when it happens and what it acts on, and each carries its cost on a second line. The visual difference is deliberately small: two controls that look wildly different stop reading as alternatives, and these are alternatives.

Confirmation reuses 7d's cost table — work in flight (132 tool calls, discarded) · tokens already spent (1.9M, not refunded) · resumes from (`plan-approved · 13:47`) — plus a panel offering pause with a historical figure. Dialog primary is **Keep running**; `Stop the turn` is the leftmost secondary, no solid fill and no red.


## Correction — one pulsing element, enforced

The rule was stated but not held: the running cockpit, the pilot chat and the launching screen each carried two or three pulsing dots (titlebar + card + footer), and hi-fi 16's own annotation claimed compliance while showing three.

**Now exactly one `animation:vpulse` per drawn window, on the one live card.** Every other liveness dot is a static filled `#7fb069` — which loses nothing, by the same argument the reduced-motion fallback already makes: the adjacent label carries the state in words (`live · updated 2s ago`, `working · last activity 8s ago`, `starting · 8s`). The pulse is reserved for the single element that means *this is the thing currently moving*, which is the only reading that justified motion in the first place.

Screens with a pulse: running cockpit (loop column's live card) · pilot chat (live round card) · diff (fix running) · empty findings (the wait) · staleness (the `live` strip) · launching (the Preflight card) · ended-at-gate (the *before* comparison only). Everywhere else the dot is static, and hi-fi 17's *after* card has no dot at all.

**No documented exception.** A stated rule with a test behind it and three violations in the reference artwork is how the artwork stops being the reference.
