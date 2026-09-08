import { expect, test } from 'vitest';
import { clock, elapsed } from './format';

/**
 * The two shapes a time can take, and why the app needs both (#202, hi-fi 17).
 *
 * Here rather than beside the component for the reason the model has the tests
 * and the components do not: this is the part that can be *wrong* rather than
 * merely ugly. A relative time is a claim that has to keep being true, and the
 * six-hour hang was one that stopped being true while sitting on screen.
 */

test('an elapsed duration and an instant are different answers to different questions', () => {
  // `elapsed` is right for a card that is moving: it is re-rendered every second
  // and its claim is true each time.
  expect(elapsed(252_000)).toBe('4m12s');

  // `clock` is right for a card that is not: it is true for as long as the gate
  // is held, which may be overnight.
  const at = new Date(2026, 8, 6, 14, 52).getTime();
  expect(clock(at)).toMatch(/\b52\b/);
  expect(clock(at)).toBe(clock(at));
});

test('a timestamp that cannot be read is named, not rendered as Invalid Date', () => {
  // The instant comes from another process by way of the reducer, so an
  // unusable one is reachable rather than theoretical - and `Invalid Date`
  // sitting where a timestamp goes reads like something somebody measured.
  expect(clock(Number.NaN)).toBe('an unrecorded time');
});
