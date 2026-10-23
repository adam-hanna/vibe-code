import { describe, expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import type { PhaseGroup, Run } from './model';
import { isFirstImplementation, passLabel, turnRound } from './rounds';
import loopColumn from './LoopColumn.tsx?raw';
import runningRow from './RunningRow.tsx?raw';
import type { Frame } from '../host';

/**
 * What the run rail calls each pass in an expanded stage (#428).
 *
 * During a run's first implement turn the Code stage listed the pass as
 * **"unnumbered pass"**, while the turn's own chip elsewhere said `round 0`. The
 * first `Implementing` heading carries no round, because the first
 * implementation is not a round: fix rounds count from 1 and it comes before
 * them. So the rail names it, and numbers the other passes the way the
 * terminal's headings do - `Plan critique (round 1)` is the frame's round 0.
 *
 * Folded from the frames the core emits (`orchestrator.ts`) and the ones a
 * replay synthesises for an opened run (`src/replay.ts`), so the label is pinned
 * against what actually arrives rather than a hand-built group.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

function groups(run: Run, kind: string): PhaseGroup[] {
  return run.cycles.find((c) => c.kind === kind)?.phases ?? [];
}

/** A live run: plan, critique, implement, review, fix, review - as the core says them. */
const live = [
  say('phase_started', { phase: 'planning', round: 0 }),
  say('turn_started', { role: 'planner', kind: 'plan' }),
  say('phase_started', { phase: 'critique', round: 0 }),
  say('turn_started', { role: 'critic', kind: 'critique', round: 0 }),
  say('phase_started', { phase: 'planning', round: 1 }),
  say('turn_started', { role: 'planner', kind: 'revise', round: 1 }),
  say('phase_started', { phase: 'critique', round: 1 }),
  say('turn_started', { role: 'critic', kind: 'critique', round: 1 }),
  // The first `Implementing` heading: a base, and no round.
  say('phase_started', { phase: 'implementing', baseSha: 'abc1234' }),
  say('turn_started', { role: 'implementer', kind: 'implement', round: 0 }),
  say('phase_started', { phase: 'review', round: 0 }),
  say('turn_started', { role: 'reviewer', kind: 'review', round: 0 }),
  // `announceFixRound`, after `reviewRound += 1`.
  say('phase_started', { phase: 'implementing', round: 1, baseSha: 'abc1234' }),
  say('turn_started', { role: 'implementer', kind: 'review-fix', round: 1 }),
  say('phase_started', { phase: 'review', round: 1 }),
  say('turn_started', { role: 'reviewer', kind: 'review', round: 1 }),
];

describe('the Code stage', () => {
  test('the first implement pass is "implementation" while its turn is running', () => {
    const run = fold(live.slice(0, 10));
    const [first] = groups(run, 'code');
    expect(first?.round).toBeNull();
    expect(run.running?.kind).toBe('implement');
    expect(passLabel(first!)).toBe('implementation');
    expect(passLabel(first!)).not.toMatch(/unnumbered|round/);
  });

  test('it is "implementation" in the instant between its heading and its turn', () => {
    const run = fold(live.slice(0, 9));
    const [first] = groups(run, 'code');
    expect(first?.turns).toHaveLength(0);
    expect(passLabel(first!)).toBe('implementation');
  });

  test('a fix round is "fix round N", the number its heading prints', () => {
    const code = groups(fold(live), 'code');
    expect(code.map(passLabel)).toEqual(['implementation', 'fix round 1']);
  });

  test('an opened run, whose replay files the first implementation under round 0, reads the same', () => {
    // `replay.ts` gives the `implement` charge its checkpoint's `reviewRound`, 0.
    const run = fold([
      say('phase_started', { phase: 'implementing', round: 0, baseSha: 'abc1234' }),
      say('turn_started', { role: 'implementer', kind: 'implement' }),
      say('phase_started', { phase: 'review', round: 0 }),
      say('turn_started', { role: 'reviewer', kind: 'review' }),
      say('phase_started', { phase: 'implementing', round: 1, baseSha: 'abc1234' }),
      say('turn_started', { role: 'implementer', kind: 'review-fix' }),
    ]);
    const code = groups(run, 'code');
    expect(code.map(passLabel)).toEqual(['implementation', 'fix round 1']);
    expect(code.map(isFirstImplementation)).toEqual([true, false]);
  });

  test('the carried-P1 final fix is a fix round too', () => {
    const run = fold([
      say('phase_started', { phase: 'implementing', baseSha: 'abc1234' }),
      say('turn_started', { role: 'implementer', kind: 'implement', round: 0 }),
      say('phase_started', { phase: 'review', round: 0 }),
      say('phase_started', { phase: 'implementing', round: 1, baseSha: 'abc1234' }),
      say('turn_started', { role: 'implementer', kind: 'final-fix', round: 1 }),
    ]);
    expect(groups(run, 'code').map(passLabel)).toEqual(['implementation', 'fix round 1']);
  });

  test('a verify-fix inside the first implementation leaves it the first implementation', () => {
    const run = fold([
      say('phase_started', { phase: 'implementing', baseSha: 'abc1234' }),
      say('turn_started', { role: 'implementer', kind: 'implement', round: 0 }),
      say('verify_started', { gate: 'core', round: 0 }),
      say('turn_started', { role: 'implementer', kind: 'verify-fix', round: 1 }),
    ]);
    expect(groups(run, 'code').map(passLabel)).toEqual(['implementation']);
  });

  test('the implement turn draws no "round 0" chip; a fix turn keeps its round', () => {
    expect(turnRound({ kind: 'implement', round: 0 })).toBeNull();
    expect(turnRound({ kind: 'review-fix', round: 1 })).toBe(1);
    expect(turnRound({ kind: 'critique', round: 0 })).toBe(0);
  });
});

describe('plan, critique and review count from one, as the headings do', () => {
  test('a plan round and its critique read the heading\'s round, not the archive\'s', () => {
    const run = fold(live);
    // `Plan critique (round 1)` and `(round 2)` are the frame's rounds 0 and 1.
    expect(groups(run, 'plan').map(passLabel)).toEqual(['round 1', 'round 2']);
    expect(groups(run, 'critique').map(passLabel)).toEqual(['round 1', 'round 2']);
  });

  test('a review round reads `Code review (round N)`\'s N', () => {
    expect(groups(fold(live), 'review').map(passLabel)).toEqual(['round 1', 'round 2']);
  });
});

describe('a frame with no round', () => {
  test('reads as the phase\'s own name, never "unnumbered pass"', () => {
    const run = fold([
      say('phase_started', { phase: 'planning' }),
      say('phase_started', { phase: 'critique' }),
      say('phase_started', { phase: 'implementing' }),
      say('phase_started', { phase: 'review' }),
    ]);
    const labels = run.cycles.flatMap((c) => c.phases.map(passLabel));
    expect(labels).toEqual(['planning', 'critique', 'implementation', 'review']);
  });

  test('the rail draws the label from `passLabel` and the fallback text is gone', () => {
    expect(loopColumn).toContain('const round = passLabel(phase);');
    expect(loopColumn).not.toContain('unnumbered pass');
    // The live card and the done row ask the same question of a turn.
    expect(loopColumn).toContain('turnRound(turn) !== null && <Badge>round {turnRound(turn)}</Badge>');
    expect(runningRow).toContain('turnRound(turn) === null');
  });
});
