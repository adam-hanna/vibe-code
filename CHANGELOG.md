# Changelog

Notable changes per release. Versions follow [semver](https://semver.org): the minor
number moves for new capability, the patch number for fixes, and the major number only
for a change that breaks an existing config or an existing run.

Each entry links the pull request that made it and, where there is one, the issue it
closes.

## Unreleased

### Added

- **A run's state history, and `vibe fork`.** Each run writes a `checkpoint-<n>.json` at
  every phase and round boundary - the whole state, valid on its own - and records the
  commit that round produced as a full object id. `vibe fork <run-id> --at <n>` seeds a new
  run from one of them, creating its branch with `git branch` so the working tree, HEAD and
  the parent run are all untouched; the fork moves onto that branch when you resume it.
  `forkedFrom` records what the parent had spent at that point as provenance only - nothing
  in vibe computes from it - and the fork's own ceilings count the inherited totals.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))

### Fixed

- **A resume no longer commits to whatever branch is checked out.** `vibe resume` refuses
  when the run records a branch that exists and HEAD is somewhere else, naming the
  `git checkout` to run; `--no-branch` skips the check. Previously those commits landed on
  the wrong branch silently, which forking makes easy to hit.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))
- **Two runs started in the same second on the same task no longer share a directory.** The
  allocator claimed the run directory with a recursive `mkdir`, which succeeds on one that
  already exists, so the second run overwrote the first. The claim is now exclusive, with a
  bounded suffix and a refusal past it.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))
- **A stored report pointer is checked against the names vibe actually writes.** It was a
  character whitelist, so a stored `lastReport` of `state.json` rendered the whole state
  file into the reviewer's prompt. `vibe resume "<id>."` is refused for the same class of
  reason: Windows strips the trailing dot, so it named a different run than it said.
  (#78, [#81](https://github.com/adam-hanna/vibe-code/pull/81))

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
