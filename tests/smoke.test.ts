import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the test runner discovers compiled tests', () => {
  assert.equal(1 + 1, 2);
});
