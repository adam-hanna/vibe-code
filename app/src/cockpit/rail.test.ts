import { describe, expect, test } from 'vitest';
import { emptyRun, hostLost, reduce } from './model';
import type { Run } from './model';
import { attemptAction, nowStatus, turnGroup, verifyRow, verifyRowText } from './rail';
import type { Frame } from '../host';

/**
 * The run rail's decisions, folded from frames (#248).
 *
 * In the #169 run a verify-fix turn ran for its whole length under a NOW card
 * reading *Ready for the next turn*, because the rail took a turn's group from a
 * table that knew four of the loop's turn kinds. What is pinned here is the rule
 * that replaced it: a turn's group is where `reduce` put it, and while a turn is
 * open the card is never idle.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const beat = say('heartbeat', { elapsedMs: 30_000, activities: 4, unit: 'tool use', lastActivity: 'Bash for f in …' });

const attempts = [1, 2, 3].map((run) => ({ run, ok: false, exitCode: 1, log: `verify-0-0-core-${run}.log` }));

const verifyFix = [
  say('phase_started', { phase: 'implementing', round: 0 }),
  say('turn_started', { role: 'implementer', kind: 'implement', round: 0 }),
  say('verify_started', { gate: 'core', round: 0 }),
  say('verify_failed', { gate: 'core', round: 0, runs: 3, failed: 3, verdict: 'failing', command: 'npm test', attempts }),
  say('turn_started', { role: 'implementer', kind: 'verify-fix', round: 1 }),
  beat,
  beat,
];

describe('a fix turn reads as live', () => {
  test('the verify-fix turn of #169 is running, in Code, and the verify row says what it is fixing', () => {
    const run = fold(verifyFix);
    const status = nowStatus(run);
    expect(status.tone).toBe('running');
    expect(status.title).toBe('Code');
    expect(status.detail).toMatch(/fixing the verification failure/);
    expect(status.title).not.toBe('Ready for the next turn');
    expect(turnGroup(run, run.running?.id ?? null)).toBe('code');
    const row = verifyRow(run);
    expect(row).not.toBeNull();
    expect(verifyRowText(row!)).toContain('core failed 3/3 → fixing (round 1)');
  });

  test('a pass in flight reads as running that gate', () => {
    const run = fold([
      say('phase_started', { phase: 'implementing', round: 0 }),
      say('turn_started', { role: 'implementer', kind: 'implement', round: 0 }),
      say('verify_started', { gate: 'core', round: 0 }),
    ]);
    expect(verifyRowText(verifyRow(run)!)).toBe('running core');
  });

  test('no pass yet, no row', () => {
    expect(verifyRow(fold(verifyFix.slice(0, 2)))).toBeNull();
  });

  test('the latest run of a gate in a pass is the one described', () => {
    const run = fold([
      ...verifyFix,
      say('verify_started', { gate: 'core', round: 0 }),
      say('verify_passed', { gate: 'core', round: 0, runs: 3, command: 'npm test', attempts: [] }),
    ]);
    expect(verifyRowText(verifyRow(run)!)).toBe('core passed → fixing (round 1)');
    // Once the next phase opens, the fix turn is closed and the suffix goes.
    const after = fold([...verifyFix.slice(0, 7), say('verify_started', { gate: 'core', round: 0 }),
      say('verify_passed', { gate: 'core', round: 0, runs: 3, command: 'npm test', attempts: [] }),
      say('phase_started', { phase: 'review', round: 0 })]);
    expect(verifyRowText(verifyRow(after)!)).toBe('core passed');
  });

  test('a re-run in flight after a fix is read as answering that fix', () => {
    const run = fold([...verifyFix, say('verify_started', { gate: 'core', round: 0 })]);
    expect(verifyRowText(verifyRow(run)!)).toBe('running core → fixing (round 1)');
  });

  test.each([
    ['revise', 'planning', 'planner', 'plan'],
    ['answer', 'planning', 'answerer', 'plan'],
    ['review-fix', 'implementing', 'implementer', 'code'],
    ['final-fix', 'implementing', 'implementer', 'code'],
  ])('a %s turn is never idle while it runs', (kind, phase, role, group) => {
    const run = fold([
      say('phase_started', { phase, round: 1 }),
      say('turn_started', { role, kind, round: 1 }),
      beat,
    ]);
    const status = nowStatus(run);
    expect(status.tone).toBe('running');
    expect(status.title).not.toBe('Ready for the next turn');
    expect(turnGroup(run, run.running?.id ?? null)).toBe(group);
  });

  test('the fix kinds say which fix, and every other kind is working', () => {
    const fix = fold([say('phase_started', { phase: 'implementing', round: 1 }), say('turn_started', { role: 'implementer', kind: 'review-fix', round: 1 })]);
    expect(nowStatus(fix).detail).toBe('Implementer is fixing review findings');
    const revise = fold([say('phase_started', { phase: 'planning', round: 1 }), say('turn_started', { role: 'planner', kind: 'revise', round: 1 })]);
    expect(nowStatus(revise).detail).toBe('Planner is working');
  });

  test('a turn in no cycle still reads as running, titled by its role', () => {
    const run = fold([say('turn_started', { role: 'implementer', kind: 'implement', round: 0 })]);
    expect(run.running).not.toBeNull();
    expect(turnGroup(run, run.running?.id ?? null)).toBeNull();
    const status = nowStatus(run);
    expect(status.tone).toBe('running');
    expect(status.title).toBe('Implementer is working');
  });

  test('with nothing open, the between-turns card is still reachable', () => {
    const run = fold([...verifyFix.slice(0, 1)]);
    expect(nowStatus(run).title).toBe('Ready for the next turn');
  });
});

describe('an attempt opens the log it was told about', () => {
  test('a carried log is an open action naming that artifact', () => {
    const run = fold(verifyFix);
    const gate = run.verify[0]!.gates[0]!;
    expect(gate.attempts.map((a) => a.log)).toEqual(attempts.map((a) => a.log));
    expect(attemptAction(gate, gate.attempts[1]!)).toEqual({ kind: 'open', name: 'verify-0-0-core-2.log' });
  });

  test('an event from before the field keeps its attempts and names the absence', () => {
    const run = fold([
      say('phase_started', { phase: 'implementing', round: 0 }),
      say('verify_started', { gate: 'core', round: 0 }),
      say('verify_failed', {
        gate: 'core',
        round: 0,
        runs: 2,
        failed: 2,
        attempts: [
          { run: 1, ok: false, exitCode: 1 },
          { run: 2, ok: false, exitCode: 1 },
        ],
      }),
    ]);
    const gate = run.verify[0]!.gates[0]!;
    expect(gate.attempts).toHaveLength(2);
    expect(gate.attempts[0]!.log).toBeNull();
    expect(attemptAction(gate, gate.attempts[0]!)).toEqual({
      kind: 'absent',
      sentence: 'this run recorded no log for this attempt',
    });
  });

  test('a gate that passed every attempt claims no absence', () => {
    expect(attemptAction({ status: 'passed' }, { run: 1, ok: true, exitCode: 0, log: null })).toEqual({ kind: 'none' });
  });
});

describe('a run whose host has gone (#246)', () => {
  test('the now card says so rather than calling it idle', () => {
    const open = fold([say('phase_started', { phase: 'planning' }), say('turn_started', { role: 'planner', kind: 'plan' })]);
    const status = nowStatus(hostLost(open, 2_000_000, 'the host exited 1'));
    expect(status.title).toBe('Run host lost');
    expect(status.detail).toBe('the host exited 1');
  });
});
