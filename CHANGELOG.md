# Changelog

Notable changes per release. Versions follow [semver](https://semver.org): the minor
number moves for new capability, the patch number for fixes, and the major number only
for a change that breaks an existing config or an existing run.

Each entry links the pull request that made it and, where there is one, the issue it
closes.

## 1.2.0 - 2026-08-27

Seventeen issues since 1.1.0. **Nothing here breaks an existing config**: every new key has a
default that reproduces 1.1.0's behaviour and no key was renamed or removed. Three things a
running setup can notice are listed under Upgrading.

The theme is evidence. A plan now says how you would know it worked, a finding has to cite
something, a verification gate that never ran can no longer report success, and a run that is
killed can be told from one that is working — and can be resumed without losing what it spent.

### Added

- **A plan has a structured definition of done.** `acceptance_criteria` on every plan: a stable
  id, the observable condition, the check that settles it and how to run it. Frozen as a copy at
  the instant the plan is approved, so the bar cannot be lowered after the gate, and the
  implementer's report is keyed to the same ids.
  (#44, [#58](https://github.com/adam-hanna/vibe-code/pull/58))
- **Named verification gates.** `verify.gates` replaces a single command with an ordered list,
  each with its own name, command and `required` flag. A required gate that never ran now exits
  **7** instead of reporting success. A config with `verify.command` still works and is
  synthesised into one legacy gate.
  (#47, [#64](https://github.com/adam-hanna/vibe-code/pull/64))
- **A finding has to cite something.** Every finding carries `evidence` naming what kind of claim
  it makes and where. A P0 or P1 whose citations do not resolve is downgraded to P2, with the
  reason recorded on it, rather than buying a fix round on an assertion nobody checked.
  (#48, [#67](https://github.com/adam-hanna/vibe-code/pull/67))
- **The implementer's report reaches the next reviewer**, framed as an untrusted and
  non-exhaustive self-report rather than as evidence. Five fixed headings, keyed to the plan's
  acceptance-criterion ids, rendered into every turn of the next review round.
  (#50, [#72](https://github.com/adam-hanna/vibe-code/pull/72))
- **The planner reads what past runs decided.** `.vibe/runs/` is named in the planning prompt as
  evidence and explicitly not as instruction — bounded to ten rows, every field truncated, and
  sanitised where the prompt is rendered rather than where it is read.
  (#52, [#73](https://github.com/adam-hanna/vibe-code/pull/73))
- **A role can name its own effort**, and then its own model. `roles.<role>` accepts
  `{ "provider", "model", "effort" }`, so the critic and the reviewer no longer have to be one
  mind in two conversations. A model is accepted on trust — no allowlist, no substitution — and
  surfaced early in the `Roles:` line and by name when a turn fails.
  (#46, [#61](https://github.com/adam-hanna/vibe-code/pull/61); #60,
  [#79](https://github.com/adam-hanna/vibe-code/pull/79))
- **`vibe list` and `vibe resume` can tell a dead run from a live one.** A run holds `run.lock`
  while it works, naming its pid, host and start time. Six verdicts, and only a genuinely absent
  lock permits a second writer; a resume over a live or unprobeable lock is refused, with
  `--force` as the way out.
  (#77, [#80](https://github.com/adam-hanna/vibe-code/pull/80))
- **A killed turn's spend is recovered.** vibe watches its own stream, so a Claude turn
  interrupted mid-flight is charged on the next resume and the ceilings see it. An interrupted
  Codex turn is named as unattributed rather than counted, because `codex exec --json` reports
  usage only when a turn completes.
  (#77, [#80](https://github.com/adam-hanna/vibe-code/pull/80))
- **A run's state has a history, and `vibe fork`.** Each run writes a `checkpoint-<n>.json` at
  every phase and round boundary — the whole state, valid on its own — and records the commit
  that round produced. `vibe fork <run-id> --at <n>` seeds a new run from one of them, creating
  its branch with `git branch` so the working tree, HEAD and the parent run are untouched.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))
- **The reviewer has its own Codex conversation**, separate from the thread that argued the plan
  into shape and approved it.
  (#45, [#59](https://github.com/adam-hanna/vibe-code/pull/59))
- **The reviewer is told what deferring is for, and what not deferring costs.** Across nine runs
  the critic deferred twice while plan revisions moved 46 items out of scope — the mechanism was
  not unused, it was being routed around at the price of a full round.
  (#56, [#76](https://github.com/adam-hanna/vibe-code/pull/76))

### Fixed

- **A change too large for one review turn is reviewed in as many turns as it takes.** Above 400k
  characters the diff is packed into whole-file parts, each its own reviewer turn, merged into one
  findings report and one round. A single file whose own diff exceeds the limit is still cut, but
  the reviewer is told which one and the run says so.
  (#49, [#70](https://github.com/adam-hanna/vibe-code/pull/70))
- **Stored run state is validated rather than cast.** A record is repaired to the empty value its
  type implies and the repair is logged; a promise the run cannot keep is refused with the run
  named and nothing rewritten.
  (#23, [#55](https://github.com/adam-hanna/vibe-code/pull/55))
- **`status`, `phase` and `planOnly` are checked together, not just individually.** A combination
  no writer could have produced is refused or normalised toward repeating work rather than
  skipping it.
  (#54, [#75](https://github.com/adam-hanna/vibe-code/pull/75))
- **Codex no longer rejects the findings schema with a 400.** Every critique and review turn was
  failing; the rule is now asserted offline so it cannot regress silently.
  (#68, [#69](https://github.com/adam-hanna/vibe-code/pull/69))
- **A critique round that only defers reaches the planner.** The approving round's deferrals used
  to be cleared without ever being stated to the implementer.
  (#22, [#57](https://github.com/adam-hanna/vibe-code/pull/57))
- **`state.json` is written whole or not at all.** Write-to-temp then rename, so a process killed
  during the write leaves either the previous file or the new one. It was truncate-then-write, on
  a ~96KB file rewritten every five seconds for the length of a run.
  (#77, [#80](https://github.com/adam-hanna/vibe-code/pull/80))
- **The in-turn token figure matches what the turn is charged.** It counted a message once per
  content block, overstating by up to 99%.
  (#77, [#80](https://github.com/adam-hanna/vibe-code/pull/80))
- **A resume no longer commits to whatever branch is checked out.** See Upgrading.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))
- **Two runs started in the same second on the same task no longer share a directory.** The
  allocator claimed it with a recursive `mkdir`, which succeeds on one that already exists, so the
  second run overwrote the first.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))
- **A stored report pointer is checked against the names vibe actually writes.** It was a
  character whitelist, so a stored `lastReport` of `state.json` rendered the whole state file into
  the reviewer's prompt.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))

### Internal

- **A full-loop integration harness**, so the phase loop itself is testable: `orchestrate` end to
  end with injected agents, a real git repo and a real verification command. Every phase feature
  in this release was tested through it.
  (#43, [#51](https://github.com/adam-hanna/vibe-code/pull/51))
- `AGENTS.md`, the working guide for changing this repo, and the README gaps 1.1.0 left.
  ([#40](https://github.com/adam-hanna/vibe-code/pull/40),
  [#41](https://github.com/adam-hanna/vibe-code/pull/41),
  [#42](https://github.com/adam-hanna/vibe-code/pull/42))

### Upgrading

No config change is required. Three behaviours a running setup can notice:

- **A required verification gate that never ran now exits 7** instead of 0. The work, its
  artifacts and its commits are all there; what is missing is the evidence that it runs. If you
  script on the exit code, treat 7 as "finished, unverified".
  (#47)
- **`vibe resume` refuses when the run records a branch that exists and something else is checked
  out**, naming the `git checkout` to run, where it used to proceed. Those commits were landing on
  whichever branch happened to be current. `--no-branch` skips the check.
  (#78)
- **A `state.json` that is internally contradictory can now be refused on load** rather than
  resumed. Only combinations no writer could have produced are refused; everything that is merely
  damaged is repaired to the empty value its type implies and logged.
  (#23, #54)

## 1.1.0 - 2026-08-20

Nineteen changes since 1.0.1. **Nothing here breaks an existing setup**: every new config
key has a default that reproduces 1.0.1's behaviour, no key was renamed or removed, and a
`state.json` written by 1.0.1 resumes unchanged.

### Added

- **Configurable agent roles.** `roles` names which agent holds each of `planner`,
  `implementer`, `critic`, `answerer` and `reviewer`. The default is the assignment every
  1.0.1 run made - Claude plans and implements, Codex critiques, answers and reviews - so
  a config without the section behaves identically. Assignments that cannot work are
  refused rather than silently degraded, and ones that work with a cost say so.
  (#2, [#34](https://github.com/adam-hanna/vibe-code/pull/34))
- **Codex thread context measurement.** `codex.contextWindow` turns the thread's occupancy
  into a ratio and warns above `context.compactAboveRatio`. It defaults to null, because
  the window is not obtainable from a `codex exec` thread: `modelContextWindow` exists only
  on an app-server push notification, and vibe spawns Codex as a separate process. With no
  window configured the occupancy is reported as a token count and never as a fraction.
  (#30, [#38](https://github.com/adam-hanna/vibe-code/pull/38))
- **Codex rate-limit awareness.** Reads Codex's rate-limit window over the app-server and
  stops before a turn that the window would kill partway through.
  `budget.codexLimitPercent`, `budget.waitOnRateLimit`, `budget.maxWaitMinutes`.
  (#1, [#5](https://github.com/adam-hanna/vibe-code/pull/5))
- **In-turn progress.** A heartbeat during a turn rather than silence until it returns.
  `progress.enabled`, `progress.intervalMs`.
  (#4, [#7](https://github.com/adam-hanna/vibe-code/pull/7))
- **A way to decline out-of-scope work.** A plan states what it is deliberately not doing,
  and a critique finding outside that boundary can be deferred to `FOLLOW-UPS.md` instead
  of being absorbed or argued away.
  (#18, [#19](https://github.com/adam-hanna/vibe-code/pull/19); #20,
  [#21](https://github.com/adam-hanna/vibe-code/pull/21))
- **`codex.implementTimeoutMs`**, so a Codex role that writes gets the implementing figure
  rather than the reviewing one.
  ([#34](https://github.com/adam-hanna/vibe-code/pull/34))

### Fixed

- **Turns that escaped token accounting.** Session rotation, preflight probes and failed
  turns all spent tokens that no ceiling counted. All three now charge through the same
  seam, and a ceiling crossed by a failed turn is enforced before the retry.
  (#16, [#24](https://github.com/adam-hanna/vibe-code/pull/24),
  [#25](https://github.com/adam-hanna/vibe-code/pull/25),
  [#26](https://github.com/adam-hanna/vibe-code/pull/26))
- **A stall discarded the findings it had just paid for.** The guard threw between buying a
  critique and consuming it, so a resumed run re-entered at the turn that bought it and
  re-derived the same answer - 7.5M tokens, observed twice. The findings are now carried
  and consumed on resume.
  (#32, [#35](https://github.com/adam-hanna/vibe-code/pull/35),
  [#36](https://github.com/adam-hanna/vibe-code/pull/36))
- **The convergence guard could not see finding turnover.** A flat P1 count with completely
  different findings each round is convergence, not deadlock, and was being stopped as
  deadlock. A flat count now excuses one window when no finding survives it; a rising
  count, a persistent core and an alternating set all still stop the run.
  (#33, [#37](https://github.com/adam-hanna/vibe-code/pull/37))
- **Preflight enforced against the wrong thing.** It keyed off which agent was running
  rather than what that agent may do, so a Codex that could write was only warned about.
  (#13, [#17](https://github.com/adam-hanna/vibe-code/pull/17))
- **A single persistent finding ended runs that would have converged.** The stop became a
  report of the streak instead.
  (#3, [#11](https://github.com/adam-hanna/vibe-code/pull/11))
- **Context measurements had no model provenance**, so a ratio measured under one model
  could be read under another. Resume overrides are now persisted too.
  (#6, [#9](https://github.com/adam-hanna/vibe-code/pull/9))
- **Heartbeat liveness, flush boundary and rotation measurement.**
  (#8, [#10](https://github.com/adam-hanna/vibe-code/pull/10))

### Internal

Groundwork with no user-visible change, each shipped separately so that the role table
stayed hardcoded until the last step:

- One role-aware dispatch seam behind Claude and Codex turns.
  (#14, [#15](https://github.com/adam-hanna/vibe-code/pull/15))
- Six sites that inferred a role from a provider name now ask the role table.
  (#27, [#28](https://github.com/adam-hanna/vibe-code/pull/28))
- Both managed conversations given the same explicit lifecycle - an id, and a separate
  marker for whether a turn has ever succeeded on it.
  (#29, [#31](https://github.com/adam-hanna/vibe-code/pull/31))

### Upgrading

Nothing is required. To use the new capability:

```jsonc
{
  "roles": {
    "planner": "codex",      // claude | codex, per role
    "implementer": "codex",
    "critic": "claude",
    "answerer": "claude",
    "reviewer": "claude"
  },
  "codex": {
    "contextWindow": 200000, // null (default) reports tokens, never a ratio
    "implementTimeoutMs": 5400000,
    "persistSession": false  // required when a Codex role writes
  }
}
```

Two things to know before swapping roles. A writing Codex role is **refused** while
`codex.persistSession` is true, because `codex exec resume` takes no `-s` flag and every
resumed turn would silently revert to read-only. And with the implementer on Codex there is
no session rotation or compaction, because that thread has no rotation mechanism - the run
warns and continues.

Models and effort remain per provider (`claude.model`, `codex.model`), not per role.

## 1.0.1

First published release.
