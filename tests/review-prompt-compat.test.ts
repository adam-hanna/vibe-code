import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { critiquePrompt, reviewPrompt } from '@src/prompts.js';
import { CRITERIA, DIFF, FILES, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';
import { scopeBlock, spliceScope } from './helpers/scope-block.js';

/**
 * What #49 promised not to change, and the one thing it did.
 *
 * The bar the chunking work was accepted against is that a change under the
 * diff limit is reviewed with *byte-identical* prompt to the one develop sent.
 * That is only assertable against something frozen, so the fixtures in
 * `tests/fixtures/prompts/` were generated from the build at `f0312d6` before
 * `src/prompts.ts` was touched, from the arguments this file imports - the same
 * module the generator used, so the two cannot drift apart.
 *
 * #56 narrowed that bar deliberately, and this file was edited for the second
 * of the two reasons AGENTS.md allows: the claim *byte-identical* is no longer
 * the contract. `scopeGuidance` gained the other half of the deferral decision,
 * and it renders into every one of these prompts. The fixtures were NOT
 * regenerated - each case now asserts equality with its baseline with the
 * `## Scope` block as the single replacement, which is strictly stronger than a
 * regenerated fixture because it proves nothing else moved. `spliceScope`
 * throws rather than passing vacuously if the region goes missing or turns out
 * not to have changed.
 */

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../tests/fixtures/prompts/${name}`, import.meta.url)),
    'utf8',
  );
}

/** The frozen call: every argument the fixtures were generated with, chunk absent. */
function prompt(round: number, hasMemory: boolean): string {
  return reviewPrompt(
    DIFF,
    FILES,
    PLAN_MD,
    OUT_OF_SCOPE,
    round,
    hasMemory,
    null,
    undefined,
    CRITERIA,
  );
}

test('a first-round review prompt moved by the scope block alone', () => {
  const now = prompt(1, false);
  assert.equal(
    now,
    spliceScope(fixture('review-round1.txt'), now),
    'something other than the ## Scope block moved',
  );
});

test('a continuing review prompt moved by the scope block alone', () => {
  const now = prompt(3, true);
  assert.equal(
    now,
    spliceScope(fixture('review-round3-memory.txt'), now),
    'something other than the ## Scope block moved',
  );
});

test('the replaced scope block still carries every guard it had before', () => {
  // The splice above proves only that the delta is confined to one region. What
  // is *inside* that region is the thing #56 changed, and these are the parts of
  // it that were never meant to move: a reviewer that may defer more freely
  // needs the counterweights more, not less.
  const block = scopeBlock(prompt(1, false));

  assert.ok(block.includes('is a defect in your finding'));
  assert.ok(block.includes('at P2 or P3'));
  assert.ok(block.includes('disputing it is legitimate'));
});

test('the memoryless round note changed by exactly one paragraph, and nothing else moved', () => {
  // The deliberate change. The old note told a reviewer that its earlier
  // findings were "quoted below" - `reviewPrompt` has never quoted a finding -
  // and then told it not to re-litigate points that were addressed. Under
  // `codex.persistSession: false` every review turn takes that branch, so a
  // reviewer that had never seen a finding was being asked to stay silent about
  // it, and silence is what an APPROVE is made of.
  const before =
    '\n\nThis is review round 3. The change has already been revised in response to earlier ' +
    'findings, which are quoted below. Re-raise one with its original `id` only if it is ' +
    'genuinely still unresolved - do not re-litigate points that were addressed.';
  const after =
    '\n\nThis is review round 3. The change has already been revised in response to findings ' +
    'from earlier rounds, but **you do not have those findings** - this turn starts a fresh ' +
    'conversation and they are not reproduced here. Review what you are given on its own terms ' +
    'and raise every defect you can see, including one that may already have been raised ' +
    'before; do not stay silent about something because it might have been addressed. Use ' +
    'whatever `id` you would naturally choose - repeats are reconciled by the tool.';

  const baseline = fixture('review-round3-nomemory.txt');
  assert.ok(baseline.includes(before), 'the baseline fixture no longer holds the old paragraph');

  // Two replacements on this one path, and they belong to different changes:
  // the paragraph swap is #49's delta, already baked into a baseline frozen at
  // `f0312d6`, and the scope splice is #56's. This change moved one region, not
  // two - the rule that a second region is a defect is about regions moved by
  // the same change.
  const now = prompt(3, false);
  assert.equal(
    now,
    spliceScope(baseline.replace(before, after), now),
    'something other than that paragraph and the ## Scope block moved',
  );
  assert.equal(now.includes('quoted below'), false);
  assert.equal(now.includes('re-litigate'), false);
});

test('the plan-side note is untouched, so the critic reads exactly what it always did', () => {
  // The critic takes the same memoryless branch and has the same problem, and
  // it was left alone deliberately rather than missed: it is out of scope for
  // #49, and moving the plan loop's prompt inside a change to the review loop
  // would be a second behaviour change with no evidence behind it. Asserted so
  // that "unchanged" is a fact rather than an intention.
  const critique = critiquePrompt(PLAN_MD, [], OUT_OF_SCOPE, 3, false, null, undefined, CRITERIA);
  assert.ok(critique.includes('which are quoted below'));
  assert.ok(critique.includes('do not re-litigate points that were addressed'));
});

test('a chunked part is told which part it is, and a first part is told it has seen no others', () => {
  const first = reviewPrompt(
    DIFF,
    FILES,
    PLAN_MD,
    OUT_OF_SCOPE,
    1,
    false,
    null,
    undefined,
    CRITERIA,
    { index: 1, total: 3, files: FILES, truncated: [], carriesEarlierParts: false },
  );
  assert.ok(first.includes('## This is part 1 of 3'));
  assert.ok(first.includes('**You have not been shown the other parts of this round**'));
  assert.equal(first.includes('shown to you earlier in this conversation'), false);

  const second = reviewPrompt(
    DIFF,
    FILES,
    PLAN_MD,
    OUT_OF_SCOPE,
    1,
    true,
    null,
    undefined,
    CRITERIA,
    { index: 2, total: 3, files: FILES, truncated: [], carriesEarlierParts: true },
  );
  assert.ok(second.includes('## This is part 2 of 3'));
  assert.ok(second.includes('shown to you earlier in this conversation'));
  assert.equal(second.includes('**You have not been shown the other parts of this round**'), false);
});

test('a lone truncated file gets the instruction without being called part 1 of 1', () => {
  // The case #49 is named after: one file too big to show whole is ONE chunk,
  // so the part framing would be nonsense - but it is the reviewer that most
  // needs telling that what it is reading stops part-way.
  const one = reviewPrompt(
    DIFF,
    ['src/huge.ts'],
    PLAN_MD,
    OUT_OF_SCOPE,
    1,
    false,
    null,
    undefined,
    CRITERIA,
    {
      index: 1,
      total: 1,
      files: ['src/huge.ts'],
      truncated: ['src/huge.ts'],
      carriesEarlierParts: false,
    },
  );

  assert.ok(one.includes('**The diff below is incomplete for `src/huge.ts`.**'));
  assert.ok(one.includes('read the remainder before judging'));
  assert.equal(one.includes('part 1 of 1'), false);
  assert.equal(one.includes('## This is part'), false);
});

test('a chunk with nothing cut says nothing about truncation', () => {
  const clean = reviewPrompt(DIFF, FILES, PLAN_MD, OUT_OF_SCOPE, 1, false, null, undefined, CRITERIA, {
    index: 2,
    total: 2,
    files: FILES,
    truncated: [],
    carriesEarlierParts: true,
  });
  assert.equal(clean.includes('The diff below is incomplete'), false);
});
