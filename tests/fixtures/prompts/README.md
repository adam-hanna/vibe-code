# Golden prompts

Two sets, generated the same way and held to the same rule: **regenerating one is a statement
that the prompt changed**, and it needs saying out loud in the PR rather than absorbing quietly.

## The planning prompt

`plan-no-runs.txt` is one rendering of `planPrompt`, generated from the build at **`50e14d3`** -
the `develop` tip #52 was branched from - **before** `src/prompts.ts` was touched. It exists so
that the bar #52 was accepted against can be asserted rather than asserted-about: *a repo with no
prior runs renders a planning prompt byte-identical to develop's.*

```ts
planPrompt(TASK, EXTRA_CONTEXT, null)
```

Its arguments live in [`tests/helpers/plan-prompt-args.ts`](../../helpers/plan-prompt-args.ts),
which imports nothing but a type so it compiles unchanged inside a checkout of `50e14d3`; the
generator was given a copy of that file, so the fixture and `tests/past-runs-prompt.test.ts`
cannot drift onto different tuples.

**Frozen contract.** The past-run index renders nothing when the list is empty, and a first-ever
run's list *is* empty - the current run is filtered out of its own index. So this file is what an
ordinary first run still sends, and it must match byte for byte.

## Golden review prompts

Three renderings of `reviewPrompt`, generated from the build at **`f0312d6`** - the `develop`
tip #49 was branched from - **before** `src/prompts.ts` was touched. They exist so that the
compatibility bar #49 set can be asserted rather than asserted-about: *for a change under the
diff limit, the reviewer's prompt is byte-identical to develop's.*

Every one was produced with the same arguments, which live in
[`tests/helpers/prompt-fixture-args.ts`](../../helpers/prompt-fixture-args.ts) and are imported by
both the generator and `tests/review-prompt-compat.test.ts`. A fixture generated with one tuple
and asserted against another proves nothing, so there is exactly one copy of them.

```ts
reviewPrompt(DIFF, FILES, PLAN_MD, OUT_OF_SCOPE, <round>, <hasMemory>, null, undefined, CRITERIA)
```

| File | `round` | `hasMemory` | Status |
| --- | --- | --- | --- |
| `review-round1.txt` | 1 | false | **Frozen contract.** No continuity note at all; this is the shape an ordinary first review round renders. Must match byte for byte, forever. |
| `review-round3-memory.txt` | 3 | true | **Frozen contract.** The `hasMemory` branch of `continuityNote`. Must match byte for byte. |
| `review-round3-nomemory.txt` | 3 | false | **Deliberate-delta baseline.** #49 rewrote exactly one paragraph on this path - the memoryless note used to claim the earlier findings were "quoted below", which `reviewPrompt` has never done. The test asserts the new output equals this file with *only* that paragraph replaced, which is what proves nothing else moved. |

Since #50 every real review prompt carries a report section — the last write turn's report, or an
explicit notice that none was recorded — so the bar these two files hold has narrowed. It is now:
*an under-limit round **with no report** renders byte-identically to develop's.* The shared
argument tuple passes no report at all, which is why they still match; `runReview` always passes
one, so no run produces these bytes any more.

**Regenerating any of these is a statement that the review prompt changed**, and it needs saying
out loud in the PR rather than absorbing quietly. For the two frozen files that is a compatibility
break; for the third it means a second deliberate change to a path this one already moved.

To regenerate: build at the commit whose output you mean to freeze, then render each shape above
with the shared arguments and write it here with `'utf8'` and no post-processing.
