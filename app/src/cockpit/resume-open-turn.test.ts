import { expect, test } from 'vitest';
import { foldReplay, forResume, reduce } from './model';
import type { Run } from './model';
import { rounds } from './rounds';
import type { Frame } from '../host';

/**
 * After a resume, the turn the run stopped on is closed (#302).
 *
 * A run stopped on a ceiling after critique round 15 and was resumed; the log
 * then drew critique 15 AND plan 16 as running. A replay carries its ending
 * beside the steps, so nothing in the fold closes the last turn - and the seed
 * dropped `running` without closing it. Shaped on the reported run's own
 * replay: the charge, the census and the escalation all arrive after the turn
 * opened, and none of them closes it.
 */

const T = 1_000_000;

const step = (at: number, id: string, data: Record<string, unknown>) => ({
  at,
  narration: { level: 'info' as const, message: 'x', id, data },
});

const STOPPED = [
  step(T, 'phase_started', { phase: 'planning', round: 15 }),
  step(T, 'turn_started', { role: 'planner', kind: 'revise', round: 15, unmeasured: false }),
  step(T + 150_000, 'claude_turn', { label: 'revise-15', tokens: 411_975 }),
  step(T + 520_000, 'phase_started', { phase: 'critique', round: 15 }),
  step(T + 520_000, 'turn_started', { role: 'critic', kind: 'critique', round: 15, unmeasured: true }),
  step(T + 520_000, 'codex_turn', { label: 'critique-15', tokens: 58_804_728 }),
  step(T + 520_000, 'findings_reported', { phase: 'plan', counts: { P0: 0, P1: 2, P2: 0, P3: 0 } }),
  step(T + 520_054, 'run_escalated', { code: 4, reason: 'Planning has used its share of the budget.' }),
];

const say = (id: string, data: Record<string, unknown>): Frame => ({
  type: 'narration',
  level: 'info',
  message: 'x',
  id,
  data,
});

/** The seed, then the resume's own first frames, as the window folds them. */
function resumed(): Run {
  const last = STOPPED[STOPPED.length - 1]?.at ?? T;
  let run = forResume(foldReplay(STOPPED), last);
  run = reduce(run, say('phase_started', { phase: 'planning', round: 16 }), last + 90_000);
  return reduce(run, say('turn_started', { role: 'planner', kind: 'revise', round: 16 }), last + 90_001);
}

test('the round the run stopped on is no longer drawn as running', () => {
  const critique = rounds(resumed()).find((c) => c.phase === 'critique' && c.round === 15);
  expect(critique).toBeDefined();
  expect(critique?.endedAt).not.toBeNull();
  expect(critique?.turns.every((t) => t.endedAt !== null)).toBe(true);
});

test('exactly one round is open: the one the resume started', () => {
  const open = rounds(resumed()).filter((c) => c.endedAt === null);
  expect(open.map((c) => [c.phase, c.round])).toEqual([['planning', 16]]);
});

test('the closed turn ends at the replay’s last step, not at the resume', () => {
  // The same instant `useReplay` closes an opened run's last turn at, so the
  // card measures the work rather than the time the run sat stopped.
  const critique = rounds(resumed()).find((c) => c.phase === 'critique' && c.round === 15);
  expect(critique?.endedAt).toBe(T + 520_054);
});

test('the seed still carries no ending and nothing running', () => {
  const seed = forResume(foldReplay(STOPPED), T + 520_054);
  expect(seed.running).toBeNull();
  expect(seed.reason).toBeNull();
  expect(seed.ended).toBeNull();
  expect(seed.completed).toBeNull();
});
