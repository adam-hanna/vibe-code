import { describe, expect, test } from 'vitest';
import gates from '../../../src/gates.ts?raw';
import { nextHold } from './format';

/**
 * Where the run can next hand control back (#223, `3a`, §1.6 of the audit).
 *
 * The footer refused this for a stated reason — *"would need a phase-to-boundary
 * ordering written here, and a wrong one is a promise the app cannot keep"* —
 * and the refusal is answered rather than overruled: **the order is told and the
 * position is told**. These tests pin both halves, and the last one fails in the
 * repo that adds a seventh boundary to `GATEABLE` without telling the window.
 */

/** The loop's own order, as the config frame delivers it. */
const ORDER = [
  'plan-round',
  'question-round',
  'plan-approved',
  'implemented',
  'verify-round',
  'review-round',
];

/** The shipped default: four hold, two are the loop arguing with itself. */
const DEFAULTS = {
  'plan-round': 'auto',
  'question-round': 'auto',
  'plan-approved': 'step',
  implemented: 'step',
  'verify-round': 'step',
  'review-round': 'step',
};

describe('the next place a run can stop', () => {
  test('before any gate has held, it is the first one that holds', () => {
    expect(nextHold(ORDER, DEFAULTS, null)).toBe('plan-approved');
  });

  test('a boundary set to auto is skipped, not named', () => {
    // The two the default leaves on `auto` are the loop arguing with itself.
    // Naming one would tell somebody to expect a hold that never comes.
    expect(nextHold(ORDER, DEFAULTS, null)).not.toBe('plan-round');
  });

  test('after a hold, it is the next holding boundary in the loop’s order', () => {
    expect(nextHold(ORDER, DEFAULTS, 'plan-approved')).toBe('implemented');
    expect(nextHold(ORDER, DEFAULTS, 'implemented')).toBe('verify-round');
  });

  test('it wraps, because cycle 2 re-opens on every review fix', () => {
    // From `review-round` the next hold really is `implemented` again - the fix
    // round is an implement turn. Wrapping is the answer, not a fallback.
    expect(nextHold(ORDER, DEFAULTS, 'review-round')).toBe('plan-approved');
  });

  test('a matrix where nothing holds has no next stop at all', () => {
    // Rather than naming one anyway. The footer has its own sentence for this.
    const auto = Object.fromEntries(ORDER.map((b) => [b, 'auto']));
    expect(nextHold(ORDER, auto, null)).toBeNull();
    expect(nextHold(ORDER, auto, 'implemented')).toBeNull();
  });

  test('with no order there is no next, and the footer falls back to the list', () => {
    // The state before the config frame arrives. Absent beats invented.
    expect(nextHold([], DEFAULTS, null)).toBeNull();
  });

  test('a boundary the order does not contain takes the first holding one', () => {
    // A core newer than this window can hold somewhere it has never heard of.
    // Fail closed: name the first hold rather than an arbitrary neighbour.
    expect(nextHold(ORDER, DEFAULTS, 'reconcile-round')).toBe('plan-approved');
  });

  test('a boundary with no row at all counts as auto', () => {
    // `gates[b] ?? 'auto'`. A matrix missing a key must not be read as holding.
    expect(nextHold(ORDER, { 'review-round': 'step' }, null)).toBe('review-round');
  });
});

test('the order this reasons over is the one the loop walks', () => {
  // The whole claim rests on `order` being `GATEABLE` rather than a copy. This
  // reads the core's declaration so the fixture above cannot quietly rot, and
  // fails in the repo that adds a boundary without the window being told.
  const declared = /export const GATEABLE: readonly GateableBoundary\[\] = \[([^\]]+)\]/.exec(gates);
  expect(declared?.[1], 'GATEABLE is no longer a literal array in src/gates.ts').toBeTruthy();
  const names = [...(declared?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((m) => m[1] ?? '');
  expect(names).toEqual(ORDER);
});
