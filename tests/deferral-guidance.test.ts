import { test } from 'node:test';
import assert from 'node:assert/strict';
import { critiquePrompt, reviewPrompt } from '@src/prompts.js';
import { FINDINGS_SCHEMA } from '@src/schemas.js';
import type { OutOfScopeItem } from '@src/types.js';

/**
 * Whether the deferral decision is described two-sidedly, everywhere the model
 * reads it (#56).
 *
 * `tests/scope.test.ts` pins the *structure* of the scope axis - schema shape,
 * parse behaviour, the artifact, which branch renders what. This file pins one
 * property of the prose instead: that `defer` is described the way `severity`
 * already is, with both errors named and an operative test for telling them
 * apart. Every sentence about `defer` used to warn against setting it and none
 * named the cost of leaving it unset, which is one half of what #56 measured.
 *
 * **What this cannot test.** Whether a two-sided description actually moves the
 * deferral rate is a property of the model, and it can only be measured on runs
 * that come after this lands. Nothing here claims to measure it; the bar is that
 * the decision is described two-sidedly, not that it is taken differently.
 *
 * Short substrings, never whole paragraphs: a paragraph-level assertion is a
 * second copy of the prompt that drifts on the first wording change.
 */

const ITEM: OutOfScopeItem = { item: 'token accounting', why: 'tracked in issue #16' };

/** The operative test, shared by both prompts and the schema. */
const SHIP_TEST = 'correct, complete and safe to ship';
const DEFECT_IN_FINDING = 'is a defect in your finding';

/** Both prompts that render `scopeGuidance`, for a given boundary. */
function guidance(outOfScope: readonly OutOfScopeItem[] | undefined): string[] {
  return [
    critiquePrompt('# the plan', [], outOfScope, 1, false, null),
    reviewPrompt('diff', ['a.ts'], '# the plan', outOfScope, 1, false, null),
  ];
}

const deferDescription =
  FINDINGS_SCHEMA.properties.findings.items.properties.defer.description;

// ---- The declared-boundary branch: both directions --------------------------

test('a declared boundary states the cost of not deferring, not only of deferring', () => {
  for (const text of guidance([ITEM])) {
    // The direction that already existed. Losing it would turn a two-sided
    // description into a one-sided one pointing the other way, which is worse
    // than what #56 set out to fix.
    assert.ok(text.includes('Deferring costs you the same honesty'), 'cost of deferring wrongly');
    assert.ok(
      text.includes('Deferring something') && text.includes('signs off work that is still broken'),
      'what a wrong deferral does',
    );

    // The direction #56 added.
    assert.ok(text.includes('becomes part of'), 'a non-deferred finding joins the work');
    assert.ok(text.includes('full round of revision'), 'and what that costs');
  }
});

test('a declared boundary gives an operative test rather than leaving it to feel', () => {
  for (const text of guidance([ITEM])) {
    assert.ok(text.includes(SHIP_TEST));
    // The `diffSince`/`diffChunks` case from the #49 run is why: the same file,
    // two functions apart, one in scope and one not. "Does the plan touch this
    // file" would have got that wrong.
    assert.ok(text.includes('the same file or the same function'));
  }
});

test('a declared boundary says the reviewer may draw a line, not only honour one', () => {
  for (const text of guidance([ITEM])) {
    assert.ok(text.includes('is how you draw one'));
    assert.ok(
      text.includes('does not have to appear on that list'),
      'the plan\'s list is not the limit of what is separate work',
    );
  }
});

test('a declared boundary keeps every guard that stops this becoming permission', () => {
  for (const text of guidance([ITEM])) {
    assert.ok(text.includes(DEFECT_IN_FINDING), 'demanding work beyond the boundary is still a defect');
    assert.ok(text.includes('at P2 or P3'), 'a deferral is still non-blocking by construction');
    assert.ok(text.includes('can never be a P0 or a P1'));
    assert.ok(text.includes('disputing it is legitimate'), 'the boundary itself is still attackable');
    assert.ok(
      text.includes('not deferrable at any severity'),
      'work the change needs cannot be deferred by relabelling it',
    );
  }
});

test('an explicitly empty boundary is the declared branch, not the legacy one', () => {
  // `PLAN_SCHEMA` requires `out_of_scope`, so an empty list is a considered
  // claim rather than a missing field - and a reviewer given one must get the
  // same two-sided guidance as a reviewer given fifteen items.
  for (const text of guidance([])) {
    assert.ok(text.includes('declared nothing out of scope'));
    assert.ok(text.includes(SHIP_TEST));
    assert.ok(text.includes('full round of revision'));
    assert.ok(text.includes(DEFECT_IN_FINDING));
  }
});

// ---- The legacy branch: same test, without the plan's authority -------------

test('the legacy branch gains the operative test and keeps its own guard', () => {
  for (const text of guidance(undefined)) {
    assert.ok(text.includes('no boundary was recorded'));
    assert.ok(text.includes(SHIP_TEST), 'the bar is the same question the other branch asks');

    // The whole point of the branch: with nothing recorded, the reviewer's own
    // judgement is still allowed, but the plan's silence is not evidence.
    assert.ok(text.includes('its silence is not evidence'));
    assert.ok(text.includes("out of scope on the plan's authority"));
    assert.ok(
      !text.includes(DEFECT_IN_FINDING),
      'a boundary nobody drew cannot make a finding defective',
    );

    // The bar this branch used to set was narrower than the other branch's -
    // "work the plan never touches" excludes the same-file case entirely.
    assert.ok(!text.includes('never touches'));

    // The restriction that keeps a freer deferral honest travels with it. This
    // branch now offers the flag where it previously withheld it, so it is the
    // branch that most needs the severity rule stated, and the assertion above
    // this one would pass on a version that dropped it.
    assert.ok(text.includes('at P2 or P3'), 'a legacy-run deferral is still non-blocking');
    assert.ok(text.includes('never P0 or P1'));
    assert.ok(
      text.includes('raise it at its true severity'),
      'work the change needs is still raised, not relabelled',
    );
  }
});

// ---- The schema description, which is the other place a model reads this ----

test('the defer description names both directions and still names the P2/P3 rule', () => {
  assert.ok(deferDescription.includes('correct, complete and safe to ship'));
  assert.ok(deferDescription.includes('must be P2 or P3, never P0 or P1'));
  assert.ok(deferDescription.includes('costs the same honesty'), 'the cost of deferring wrongly');
  assert.ok(deferDescription.includes('Not deferring costs too'), 'and the cost of not deferring');
  assert.ok(deferDescription.includes('not deferrable at any severity'));
});

test('the defer field is still typed and still required', () => {
  // Deliberately the same claim `tests/scope.test.ts` makes. #56 rewrote the
  // description immediately above these, and a required property with no `type`
  // still accepts a string that `parseFindings` then reads as false - so this
  // file has to fail on its own if the rewrite took the type with it.
  const item = FINDINGS_SCHEMA.properties.findings.items;
  assert.equal(item.properties.defer.type, 'boolean');
  assert.ok((item.required as readonly string[]).includes('defer'));
});
