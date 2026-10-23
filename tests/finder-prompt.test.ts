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
