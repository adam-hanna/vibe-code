import { describe, expect, test } from 'vitest';
import { CLI_DEFAULT, firstOf, labelOf, optionsFor, whyNot } from './models';
import type { Listing } from './models';

/**
 * Model pickers, drawn from what each road listed (#223). Nothing here is a
 * model name this build ships: *"What if claude introduces a new model, we have
 * to change source code? I really want to avoid that."*
 */

const CLAUDE: Listing = {
  ok: true,
  models: [
    { value: 'default', resolves: 'claude-fable-5-1', name: 'Default', description: 'Fable 5.1' },
    { value: 'opus', resolves: 'claude-opus-5-5', name: 'Opus 5.5', description: 'For complex work' },
    { value: 'claude-opus-5', resolves: 'claude-opus-5', name: 'Opus 5', description: '' },
  ],
};

describe('a picker', () => {
  test("starts on the road's first, which for a CLI is its own default", () => {
    expect(firstOf(CLAUDE)).toBe(CLI_DEFAULT);
    expect(firstOf(null)).toBeNull();
    expect(firstOf({ ok: false, why: 'x' })).toBeNull();
  });

  test('says what the default is today, and names each model with its value', () => {
    expect(optionsFor(CLAUDE, 'opus').map((c) => c.label)).toEqual([
      'Default · Fable 5.1',
      'Opus 5.5 · opus',
      'Opus 5 · claude-opus-5',
    ]);
    expect(labelOf({ value: 'gpt-6-luna', resolves: 'gpt-6-luna', name: 'gpt-6-luna', description: '' })).toBe('gpt-6-luna');
  });

  test('keeps a value the listing does not hold, and marks it only when there was a listing', () => {
    // A select that cannot represent its value rewrites it by rendering.
    expect(optionsFor(CLAUDE, 'claude-opus-9').at(-1)).toEqual({ value: 'claude-opus-9', label: 'claude-opus-9', unlisted: true });
    expect(optionsFor(null, 'opus')).toEqual([{ value: 'opus', label: 'opus', unlisted: false }]);
    expect(optionsFor({ ok: false, why: 'x' }, CLI_DEFAULT)).toEqual([{ value: 'default', label: 'Default', unlisted: false }]);
  });

  test('says why there is no list, and nothing while it is still being asked', () => {
    expect(whyNot({ ok: false, why: 'codex could not be asked' })).toBe('codex could not be asked');
    expect(whyNot(null)).toBeNull();
    expect(whyNot(CLAUDE)).toBeNull();
  });
});
