import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrompt, withFocus } from '@src/prompts.js';

/**
 * A finder's focus, and only its own (#388 Part B, decision 3). Without one, a
 * finder reads exactly the prompt a memoryless reviewer reads - the golden
 * prompts that pin `reviewPrompt` therefore pin every focus-less finder too.
 */

function memoryless(): string {
  return reviewPrompt('diff --git a/x b/x\n+one\n', ['x'], '# plan', [], 1, false);
}

test('no focus is the memoryless reviewer prompt, byte for byte', () => {
  assert.equal(withFocus(memoryless(), undefined), memoryless());
});

test('a focus is appended under its own heading, and nothing else moves', () => {
  assert.equal(
    withFocus(memoryless(), 'security'),
    `${memoryless()}\n\n## Focus for this review\n\nsecurity`,
  );
});

test('a blinded finder keeps its focus: appended after a prompt with no report section (#497)', () => {
  // `runReview` hands a `report: false` seat `undefined`, the fixture callers'
  // state, so its prompt is the memoryless one with no section, plus its focus.
  const blind = reviewPrompt(
    'diff --git a/x b/x\n+one\n', ['x'], '# plan', [], 1, false,
    undefined, undefined, undefined, undefined, undefined,
  );
  assert.equal(blind, memoryless());
  assert.doesNotMatch(blind, /What the implementer says it did|No report was recorded/);
  assert.equal(withFocus(blind, 'security'), `${memoryless()}\n\n## Focus for this review\n\nsecurity`);
});
