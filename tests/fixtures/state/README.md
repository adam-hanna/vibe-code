# Real `state.json` fixtures

Four **unmodified** `state.json` files, copied verbatim from runs this repo made on itself.
Not constructed, not trimmed, not reshaped. The point of them is that a claim about what
older state looks like should be settled by an older state file rather than by reasoning
about what `createRun` would have written.

| File | Keys | `status` / `phase` | From the run for | Written |
|---|---:|---|---|---|
| `oldest-planning.json` | 32 | `planning` / `planning` | issue #1 | 2026-08-17 |
| `stalled-planning.json` | 40 | `stalled` / `planning` | issue #2 (the attempt that stalled) | 2026-08-19 |
| `done-pendingfindings-null.json` | 43 | `done` / `complete` | issue #33 | 2026-08-19 |
| `done-widest.json` | 45 | `done` / `complete` | issue #32 | 2026-08-19 |

## What each one is here to prove

**`oldest-planning.json`** is the narrowest state on record - 32 keys, from before roughly a
third of `RunState` existed. Every field it lacks is a field whose absence must read as
absent rather than as damage.

**`stalled-planning.json`** is a real stall, not a simulated one: `status: "stalled"` with
`phase: "planning"`, mid-run counters, and a populated `p1Rounds`. It is the shape a user
actually resumes from.

**`done-pendingfindings-null.json`** carries `"pendingFindings": null`. That is what
`clearPendingFindings` writes (`src/run.ts:460-462`) after a revision consumes the findings,
so **`null` here is the normal, healthy value** - not a malformed record. A validator that
treats it as corrupt fires a repair on ordinary states.

**`done-widest.json`** is the widest on record at 45 keys, including `codexSessionStarted`.

## Provenance, stated precisely

These are **post-run** states, not freshly-created ones. They contain everything a completed
run accumulates - `config`, `events`, `p1Rounds`, rate-limit records, progress timestamps -
and their key sets are therefore much larger than what `createRun` initialises. Any claim
that a fixture's key set equals `createRun`'s output is false for all four.

The absolute `dir` and `targetDir` paths are left as they were written. `loadRun` re-derives
both, so a fixture loading correctly from a different location is itself part of what these
prove.

Add to this set rather than editing it. A fixture that gets adjusted to suit a test stops
being evidence.
