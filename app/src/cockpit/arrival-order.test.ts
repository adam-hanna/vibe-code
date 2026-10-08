import { expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import { rounds } from './rounds';
import type { Frame } from '../host';

/**
 * A record attached to a round by arrival, when two frames arrive together (#285).
 *
 * On the #138 run, critique round 2's census was drawn inside plan round 2, the
 * revision it caused. The core says the two 6ms apart; the window stamps frames
 * with its own clock as they are read, so both came out of one chunk with the
 * same millisecond, and the tie went to the later card. Every frame here is
 * folded at ONE timestamp, which is that case at its sharpest.
 */

const say = (id: string, data: Record<string, unknown>): Frame => ({
  type: 'narration',
  level: 'info',
  message: 'x',
  id,
  data,
});

const T = 5_000_000;
const together = (frames: readonly Frame[]): Run => frames.reduce((run, f) => reduce(run, f, T), emptyRun());

const COUNTS = { P0: 0, P1: 2, P2: 1, P3: 0 };

test("a critique's census stays on the critique when the revision opens in the same millisecond", () => {
  const run = together([
    say('phase_started', { phase: 'planning', round: 1 }),
    say('turn_started', { role: 'planner', kind: 'revise', round: 1 }),
    say('phase_started', { phase: 'critique', round: 1 }),
    say('turn_started', { role: 'critic', kind: 'critique', round: 1 }),
    say('findings_reported', { phase: 'plan', counts: COUNTS, tolerance: 1, pass: false }),
    say('phase_started', { phase: 'planning', round: 2 }),
    say('turn_started', { role: 'planner', kind: 'revise', round: 2 }),
  ]);

  const cards = rounds(run);
  expect(cards.map((c) => `${c.phase}:${String(c.round)}`)).toEqual(['planning:1', 'critique:1', 'planning:2']);
  expect(cards.map((c) => c.census?.counts['P1'] ?? null)).toEqual([null, 2, null]);
});

test('a verify pass, a commit and a question round stay on their own round under a tie too', () => {
  const run = together([
    say('phase_started', { phase: 'planning', round: 0 }),
    say('turn_started', { role: 'planner', kind: 'plan' }),
    say('questions_opened', { total: 1, blocking: 0, round: 1, cap: 3, questions: [] }),
    say('phase_started', { phase: 'implementing', baseSha: 'abc' }),
    say('turn_started', { role: 'implementer', kind: 'implement' }),
    say('verify_started', { gate: 'core', round: 0 }),
    say('round_committed', { sha: 'a'.repeat(40), since: 'b'.repeat(40) }),
    say('phase_started', { phase: 'review', round: 0 }),
  ]);

  const cards = rounds(run);
  expect(cards.map((c) => c.phase)).toEqual(['planning', 'implementing', 'review']);
  expect(cards.map((c) => c.questions !== null)).toEqual([true, false, false]);
  expect(cards.map((c) => c.verify !== null)).toEqual([false, true, false]);
  expect(cards.map((c) => c.commit !== null)).toEqual([false, true, false]);
});
