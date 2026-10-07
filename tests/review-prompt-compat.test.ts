import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { critiquePrompt, reviewPrompt } from '@src/prompts.js';
import { CRITERIA, DIFF, FILES, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';
import { scopeBlock, spliceScope } from './helpers/scope-block.js';

/**
 * Reviewed first-round, continuing and fresh-session prompt shapes.
 *
 * The bar the chunking work was accepted against is that a change under the
 * diff limit is reviewed with *byte-identical* prompt to the one develop sent.
 * That is only assertable against something frozen, so the fixtures in
 * `tests/fixtures/prompts/` were generated from the build at `f0312d6` before
 * `src/prompts.ts` was touched, from the arguments this file imports - the same
 * module the generator used, so the two cannot drift apart.
 *
 * #56 deliberately replaced only the scope region. The prompt-discipline change
 * now changes standing instructions across the whole prompt: independent review
 * with no finding quota, scope-conscious breadth and the shared simplicity rule.
 * The fixtures are deliberately regenerated for that new contract, as recorded
 * in their README and the PR; substantive guards still have separate assertions.
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

test('a first-round review matches the reviewed prompt baseline', () => {
  assert.equal(prompt(1, false), fixture('review-round1.txt'));
});

test('a continuing review matches the reviewed prompt baseline', () => {
  assert.equal(prompt(3, true), fixture('review-round3-memory.txt'));
});

test('the replaced scope block still carries every guard it had before', () => {
  // #56's deferral counterweights still apply under the new standing rules.
  const block = scopeBlock(prompt(1, false));

  assert.ok(block.includes('is a defect in your finding'));
  assert.ok(block.includes('at P2 or P3'));
  assert.ok(block.includes('disputing it is legitimate'));
});

/**
 * The helper's own contract.
 *
 * The historical compatibility check relied on `spliceScope` refusing the two ways it
 * could be satisfied while proving nothing: a region it cannot find (it would
 * hand back the baseline, or a silently wrong slice) and a region that did not
 * change (it would hand back the baseline, which for an unchanged prompt equals
 * `current` - a green test asserting that nothing happened). Those refusals are
 * the entire reason this is a helper rather than an inline `replace`, so they
 * are pinned here rather than trusted.
 */
test('the splice refuses to pass vacuously when the scope block did not move', () => {
  const now = prompt(1, false);
  assert.throws(
    () => spliceScope(now, now),
    /identical/,
    'splicing a prompt into itself must throw, not return it unchanged',
  );
});

test('the splice refuses a baseline or a current whose scope region is gone', () => {
  const now = prompt(1, false);
  const noHeading = now.replace('## Scope\n', '## Boundary\n');
  const noEnd = now.replace('\n## Acceptance criteria', '\n## The bar');

  for (const broken of [noHeading, noEnd]) {
    assert.throws(() => spliceScope(broken, now), /prompt shape moved/);
    assert.throws(() => spliceScope(now, broken), /prompt shape moved/);
    assert.throws(() => scopeBlock(broken), /prompt shape moved/);
  }
});

test('a fresh review matches its baseline and never claims to carry earlier findings', () => {
  // The deliberate change. The old note told a reviewer that its earlier
  // findings were "quoted below" - `reviewPrompt` has never quoted a finding -
  // and then told it not to re-litigate points that were addressed. Under
  // `codex.persistSession: false` every review turn takes that branch, so a
  // reviewer that had never seen a finding was being asked to stay silent about
  // it, and silence is what an APPROVE is made of.
  const after =
    '\n\nThis is review round 3. The change has already been revised in response to findings ' +
    'from earlier rounds, but **you do not have those findings** - this turn starts a fresh ' +
    'conversation and they are not reproduced here. Review what you are given on its own terms ' +
    'and raise every defect you can see, including one that may already have been raised ' +
    'before; do not stay silent about something because it might have been addressed. Use ' +
    'whatever `id` you would naturally choose - repeats are reconciled by the tool.';

  const baseline = fixture('review-round3-nomemory.txt');
  const now = prompt(3, false);
  assert.ok(now.includes(after));
  assert.equal(now, baseline);
  assert.equal(now.includes('quoted below'), false);
  assert.equal(now.includes('re-litigate'), false);
});

test('a fresh plan critic is not told it has earlier findings it cannot see', () => {
  // The old #49 boundary deliberately preserved this defect on the plan side.
  // Both judge prompts omit earlier findings, so the broader prompt overhaul
  // applies the same honest memoryless framing to both.
  const critique = critiquePrompt(PLAN_MD, [], OUT_OF_SCOPE, 3, false, null, undefined, CRITERIA);
  assert.ok(critique.includes('**you do not have those findings**'));
  assert.ok(critique.includes('Use whatever `id` you would naturally choose'));
  assert.equal(critique.includes('quoted below'), false);
  assert.equal(critique.includes('do not re-litigate'), false);
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
