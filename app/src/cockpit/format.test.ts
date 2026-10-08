import { expect, test } from 'vitest';
import { buildStamp, fingerprint, uptime } from './format';

/**
 * The two facts the diagnostics panel formats (#201).
 *
 * Both are here rather than beside the component for the reason the model has
 * the tests and the components do not: these are the parts that can be *wrong*
 * rather than merely ugly. A build stamp that prints a placeholder where a
 * commit should be defeats the whole point of the stamp, which is that a reader
 * can tell two builds of one version apart.
 */

test('a stamp says only what it knows, and drops the rest', () => {
  expect(buildStamp({ version: '0.4.2', commit: '9f3ac81', at: null })).toBe('0.4.2 · 9f3ac81');
  // A tree with no git. A version alone is still a true answer.
  expect(buildStamp({ version: '0.4.2', commit: null, at: null })).toBe('0.4.2');
});

test('a build time is formatted, and a broken one is dropped rather than printed', () => {
  const stamped = buildStamp({ version: '0.4.2', commit: '9f3ac81', at: Date.UTC(2026, 8, 6, 12) });
  expect(stamped).toMatch(/^0\.4\.2 · 9f3ac81 · built /);

  // `new Date(NaN)` renders as `Invalid Date`, which would sit in the panel
  // reading like something somebody measured. The stamp is a number from
  // another process, so this is reachable rather than theoretical.
  expect(buildStamp({ version: '0.4.2', commit: '9f3ac81', at: Number.NaN })).toBe(
    '0.4.2 · 9f3ac81',
  );
});

test('uptime is a duration in the same shape as every other one', () => {
  expect(uptime(8)).toBe('8s');
  expect(uptime(750)).toBe('12m30s');
  expect(uptime(11_040)).toBe('3h04m');
  // Never negative. Two clocks disagreeing is not a reason to print `-3s`.
  expect(uptime(-5)).toBe('0s');
});

test('the rounds fingerprint is the design\'s p v r, with q only when questions were asked', () => {
  expect(fingerprint({ plan: 2, question: 1, review: 2, verify: 1 })).toBe('p2 q1 v1 r2');
  // A counter the run never recorded is a dash, never a zero.
  expect(fingerprint({ plan: null, question: null, review: 2, verify: 1 })).toBe('p– v1 r2');
  // No questions, or none recorded: nothing to scan for, so left out.
  expect(fingerprint({ plan: 2, question: 0, review: 2, verify: 1 })).toBe('p2 v1 r2');
  expect(fingerprint({ plan: 2, question: null, review: 2, verify: 1 })).toBe('p2 v1 r2');
  expect(fingerprint({ plan: null, question: null, review: null, verify: null })).toBe('p– v– r–');
});
