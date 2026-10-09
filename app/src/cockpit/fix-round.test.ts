import { expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import { rounds } from './rounds';
import type { Frame } from '../host';

/**
 * A fix round is a code round on screen (#280). The core now opens
 * `implementing` with the review round before a fix turn; this pins what the
 * window draws from it - the fix under CODE rather than inside the review it
 * answers, and the log reading code, review, code, review.
 */

const say = (id: string, data: Record<string, unknown>): Frame => ({
  type: 'narration',
  level: 'info',
  message: 'x',
  id,
  data,
});

const fold = (frames: readonly Frame[]): Run =>
  frames.reduce((run, frame, i) => reduce(run, frame, 1_000_000 + i), emptyRun());

const FIXED: readonly Frame[] = [
  say('phase_started', { phase: 'implementing', baseSha: 'abc' }),
  say('turn_started', { role: 'implementer', kind: 'implement' }),
  say('phase_started', { phase: 'review', round: 0 }),
  say('turn_started', { role: 'reviewer', kind: 'review', round: 0 }),
  say('phase_started', { phase: 'implementing', round: 1, baseSha: 'abc' }),
  say('turn_started', { role: 'implementer', kind: 'review-fix', round: 1 }),
  say('phase_started', { phase: 'review', round: 1 }),
  say('turn_started', { role: 'reviewer', kind: 'review', round: 1 }),
];

test('the fix turn is filed under a second code group, not under the review', () => {
  const run = fold(FIXED);
  const code = run.cycles.find((c) => c.kind === 'code');
  const review = run.cycles.find((c) => c.kind === 'review');

  expect(code?.phases.map((p) => p.turns.map((t) => t.kind))).toEqual([['implement'], ['review-fix']]);
  expect(review?.phases.map((p) => p.turns.map((t) => t.kind))).toEqual([['review'], ['review']]);
});

test("the pilot's log reads code, review, code, review", () => {
  expect(rounds(fold(FIXED)).map((c) => c.cycle)).toEqual(['code', 'review', 'code', 'review']);
});
