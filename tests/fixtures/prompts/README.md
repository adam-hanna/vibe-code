# Golden review prompts

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

**Regenerating any of these is a statement that the review prompt changed**, and it needs saying
out loud in the PR rather than absorbing quietly. For the two frozen files that is a compatibility
break; for the third it means a second deliberate change to a path this one already moved.

To regenerate: build at the commit whose output you mean to freeze, then render each shape above
with the shared arguments and write it here with `'utf8'` and no post-processing.
