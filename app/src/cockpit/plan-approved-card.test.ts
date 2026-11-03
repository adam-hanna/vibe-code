import { expect, test } from 'vitest';
// The core's source as text, for the reason `contract.test.ts` gives: importing
// the module would drag Node into a webview test, and a literal is all we need.
import decisions from '../../../src/decisions.ts?raw';
import { hold } from './format';

/**
 * The plan-approved card points at the decisions first (#487).
 *
 * The last gate before code is written used to send a person to the whole
 * PLAN.md and a critique JSON. A long plausible plan is what misleads somebody,
 * so the card now names the two short sections PLAN.md ends with - what the
 * plan rests on, and what was settled without them - before the rest.
 */

test('the plan-approved card names the two decision sections before the critique', () => {
  const inspect = hold('plan-approved')?.inspect ?? '';
  const assumptions = inspect.indexOf('## Assumptions');
  const decided = inspect.indexOf('## Decided without you');
  const critique = inspect.indexOf('plan-critique-');
  expect(assumptions, 'names ## Assumptions').toBeGreaterThanOrEqual(0);
  expect(decided, 'names ## Decided without you').toBeGreaterThanOrEqual(0);
  expect(critique, 'still names the critique').toBeGreaterThanOrEqual(0);
  expect(assumptions).toBeLessThan(critique);
  expect(decided).toBeLessThan(critique);
  expect(inspect).toContain('DECISIONS.md');
});

test('the sections the card names are the ones the core writes', () => {
  // A heading renamed in `src/decisions.ts` would leave the card pointing at
  // nothing, so the two are read from the source the PLAN.md section comes from.
  expect(decisions).toContain("ASSUMPTIONS_SECTION = '## Assumptions'");
  expect(decisions).toContain("DECIDED_SECTION = '## Decided without you'");
});
