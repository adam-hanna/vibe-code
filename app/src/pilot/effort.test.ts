import { expect, test } from 'vitest';
import types from '../../../src/types.ts?raw';
import pane from './PilotPane.tsx?raw';
import { DEFAULT_EFFORT, EFFORTS, effortOff, effortToSend } from './effort';

/** The pilot's effort picker (#296). */

test("the list is the CLIs' own, the one a run's seat takes", () => {
  const list = EFFORTS.map((e) => `'${e}'`).join(', ');
  expect(types).toContain(`export const EFFORTS: readonly Effort[] = [${list}];`);
});

test('a subscription turn sends what was picked, and default sends nothing', () => {
  expect(effortToSend('subscription', 'high')).toBe('high');
  expect(effortToSend('codex', 'xhigh')).toBe('xhigh');
  expect(effortToSend('subscription', DEFAULT_EFFORT)).toBeUndefined();
  expect(effortToSend('subscription', 'turbo')).toBeUndefined();
});

test('an API turn sends none, and the control says why', () => {
  expect(effortToSend('anthropic', 'high')).toBeUndefined();
  expect(effortToSend('openai', 'high')).toBeUndefined();
  expect(effortOff('anthropic')).not.toBeNull();
  expect(effortOff('subscription')).toBeNull();
});

test('the select sits directly right of the model, and the turn carries it', () => {
  const model = pane.indexOf('aria-label="Pilot model"');
  const effort = pane.indexOf('aria-label="Pilot effort"');
  expect(model).toBeGreaterThan(-1);
  expect(effort).toBeGreaterThan(model);
  // Nothing drawn between them: the only element opened in between is the
  // effort select's own tag.
  const between = pane.slice(model, effort);
  expect(between).not.toMatch(/<input|<span/);
  expect(between.match(/<select/g)).toHaveLength(1);
  expect(pane).toContain('withEffort(effortToSend(provider, effort))');
});
