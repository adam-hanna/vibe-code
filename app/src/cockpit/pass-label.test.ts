import { describe, expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import type { PhaseGroup, Run } from './model';
import { classify } from './artifacts';
import { isFirstImplementation, passLabel, phaseRound, rounds, shownRound, turnRound, wakeRound } from './rounds';
import loopColumn from './LoopColumn.tsx?raw';
import runningRow from './RunningRow.tsx?raw';
import outputPane from './OutputPane.tsx?raw';
import codePane from './CodePane.tsx?raw';
import plansPane from './PlansPane.tsx?raw';
import reportPane from './ReportPane.tsx?raw';
import footer from './Footer.tsx?raw';
import roundCard from '../pilot/RoundCard.tsx?raw';
import pilotPane from '../pilot/PilotPane.tsx?raw';
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

  test('the implement turn draws no "round 0" chip; a fix turn keeps its own number', () => {
    expect(turnRound({ kind: 'implement', round: 0 })).toBeNull();
    expect(turnRound({ kind: 'review-fix', round: 1 })).toBe(1);
    expect(turnRound({ kind: 'final-fix', round: 2 })).toBe(2);
    expect(turnRound({ kind: 'verify-fix', round: 1 })).toBe(1);
  });

  test('the first implementation has no chip; a fix round\'s chip is its fix round', () => {
    expect(groups(fold(live), 'code').map(phaseRound)).toEqual([null, 1]);
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

  test('every group chip and pilot round card counts from one', () => {
    const run = fold(live);
    for (const kind of ['plan', 'critique', 'review']) {
      expect(groups(run, kind).map(phaseRound)).toEqual([1, 2]);
    }
    // The pilot's cards and the panes' in-flight cards are `rounds()`, asked the same question.
    expect(rounds(run).map((c) => [c.phase, phaseRound(c)])).toEqual([
      ['planning', 1],
      ['critique', 1],
      ['planning', 2],
      ['critique', 2],
      ['implementing', null],
      ['review', 1],
      ['implementing', 1],
      ['review', 2],
    ]);
  });

  test('every plan, critique, review and vote turn chip counts from one', () => {
    for (const kind of ['plan', 'revise', 'critique', 'review', 'vote']) {
      expect(turnRound({ kind, round: 0 })).toBe(1);
    }
    expect(turnRound({ kind: 'critique', round: null })).toBeNull();
  });

  test('a "round 1" chip still opens round 0\'s file', () => {
    const run = fold(live);
    const [critique] = groups(run, 'critique');
    // What the reader sees, and what the link carries.
    expect(phaseRound(critique!)).toBe(1);
    expect(critique!.round).toBe(0);
    // The file the link lands on is classified by its own name's round.
    expect(classify({ name: 'plan-critique-0.json', kind: 'file', bytes: 1 }).round).toBe(critique!.round);
    expect(classify({ name: 'code-review-0.json', kind: 'file', bytes: 1 }).round).toBe(groups(run, 'review')[0]!.round);
    // The links pass the raw round, and the panes key and reveal by it.
    expect(loopColumn).toContain("onOpen(census.phase === 'plan' ? 'critique' : 'review', phase.round)");
    expect(roundCard).toContain('onOpen(PANE[card.cycle], card.round)');
    expect(reportPane).toContain('id={report.round === null ? undefined : `${kind}-round-${String(report.round)}`}');
    expect(reportPane).toContain('report.round === openAt');
    expect(plansPane).toContain('plan.round === openAt');
  });

  test('the one + 1 is `shownRound`', () => {
    expect(shownRound(0)).toBe(1);
    expect(shownRound(4)).toBe(5);
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
  });
});

/**
 * Every place a person reads a round asks `rounds.ts`, so the + 1 lives in one
 * helper and no site draws the archive's number on its own. Source-read, as
 * `draft-tab-counts.test.ts` is: the panes need a host to mount and the app has
 * no jsdom.
 */
describe('every display site counts from one through `rounds.ts`', () => {
  test('turn chips: the done row, the live card and the Output pane strip', () => {
    expect(loopColumn).toContain('turnRound(turn) !== null && <Badge>round {turnRound(turn)}</Badge>');
    expect(runningRow).toContain('` · round ${String(turnRound(turn))}`');
    expect(outputPane).toContain('round {turnRound(turn)}</Badge>');
  });

  test('group chips: the loop column\'s round heads and the pilot\'s round cards', () => {
    expect(loopColumn).toContain('round {phaseRound(phase)}</Badge>');
    expect(roundCard).toContain('round {phaseRound(card)}</Badge>');
  });

  test('pane titles, the footer and the picked-up row', () => {
    expect(codePane).toContain('`code · fix round ${String(phaseRound(card))}`');
    expect(plansPane).toContain('`plan · round ${String(shownRound(plan.round))}`');
    expect(reportPane).toContain('`${words.title} · round ${String(shownRound(report.round))}`');
    expect(footer).toContain('plan {shownRound(gate.planRound)}');
    expect(loopColumn).toContain('`plan ${String(shownRound(from.planRound))}`');
  });

  test('no display site draws a raw round', () => {
    const raw = /round \{(turn|phase|card)\.round\}|round \$\{String\((plan|report|card)\.round\)\}|round \$\{(turn|phase)\.round\}/;
    for (const source of [loopColumn, runningRow, outputPane, codePane, plansPane, reportPane, roundCard]) {
      expect(source).not.toMatch(raw);
    }
    expect(footer).not.toContain('plan {gate.planRound}');
  });
});

/**
 * The pilot's wake sentence names the counter of the gate it is held at (#428).
 * It took `reviewRound ?? planRound ?? verifyRound`, and `reviewRound` is always
 * a number, so every plan gate was described by the review count.
 */
describe('the wake sentence reports the gate\'s own counter', () => {
  const at = (boundary: string) => ({ boundary, planRound: 1, reviewRound: 0, verifyRound: 0 });

  test('a plan gate reports the plan round, from one, never the review count', () => {
    expect(wakeRound(at('plan-approved'))).toBe('in plan round 2');
    expect(wakeRound(at('plan-round'))).toBe('in plan round 2');
    expect(wakeRound(at('question-round'))).toBe('in plan round 2');
    expect(wakeRound({ boundary: 'plan-approved', planRound: 0, reviewRound: 3, verifyRound: 2 })).toBe('in plan round 1');
  });

  test('a review gate reports the fix that just ran and the review it answered', () => {
    expect(wakeRound({ boundary: 'review-round', planRound: 4, reviewRound: 2, verifyRound: 0 })).toBe(
      'after fix round 2, which answered code review round 2',
    );
  });

  test('a verify gate reports the verification fix', () => {
    expect(wakeRound({ boundary: 'verify-round', planRound: 4, reviewRound: 2, verifyRound: 1 })).toBe(
      'after verification fix 1',
    );
  });

  test('a gate with no round of its own, or an unknown one, says none', () => {
    expect(wakeRound(at('implemented'))).toBeNull();
    expect(wakeRound(at('complete'))).toBeNull();
    expect(wakeRound(at('a-boundary-from-a-newer-core'))).toBeNull();
  });

  test('the pilot pane builds its sentence from `wakeRound` and no longer picks a counter itself', () => {
    expect(pilotPane).toContain('const where = wakeRound(gate);');
    expect(pilotPane).not.toContain('gate.reviewRound ?? gate.planRound');
  });
});
