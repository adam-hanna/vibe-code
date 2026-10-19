import { expect, test } from 'vitest';
import { bootStep } from './boot';

/** Nothing is read before the lock (#346). */
test('a locked app shows only the cover', () => {
  expect(bootStep({ locked: true })).toBe('locked');
  expect(bootStep({ locked: false })).toBe('open');
});
