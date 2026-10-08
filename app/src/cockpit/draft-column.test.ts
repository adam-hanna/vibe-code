import { expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import { draftHasNoRun, markLaunched, newDraft } from './pending';

/**
 * A new run's draft draws an empty run column, not the last run on screen.
 *
 * Switching between runs moved the column; starting a new one and talking it
 * through with the pilot did not, because a draft sets `viewing` to null and the
 * column fell through to the window's last live run. Once the proposal is
 * pressed the live run is the draft's own, so it is drawn from then on.
 */

const draft = newDraft('/repo', 'add a thing', 1_000, 'abc123', null);

test('a draft not yet started has no run to draw', () => {
  expect(draftHasNoRun(draft)).toBe(true);
});

test('a started draft is drawn as the run it asked for, and no draft draws whatever is open', () => {
  const [launched] = markLaunched([draft], draft.id);
  expect(draftHasNoRun(launched ?? null)).toBe(false);
  expect(draftHasNoRun(null)).toBe(false);
});

test('the column, the footer and the summary all take the empty run while a draft has none', () => {
  // One expression decides the run those three draw, so they cannot disagree.
  expect(cockpit).toMatch(/const columnRun = draftHasNoRun\(drafting\) \? blank : /);
  expect(cockpit).toContain('run={columnRun}');
});
