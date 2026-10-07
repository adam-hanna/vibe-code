import { describe, expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import type { Frame } from '../host';

/**
 * The verification gate, folded from frames (`5d`, #223).
 *
 * The loop has always known whether the gate passed and never said so, and these
 * are the frames that changed that. What is worth testing is not that they land -
 * it is the three places a pane could quietly start deciding things the loop
 * decided better:
 *
 * 1. **The verdict is carried, never computed.** `failed < runs` looks like
 *    flakiness and is not: one sample says nothing about determinism.
 * 2. **A pass is separated from the next by its round**, which is told. The
 *    outcomes are reset per pass, so the stream alone cannot tell the second
 *    gate of one pass from the first gate of the next.
 * 3. **A verdict with no gate under it is dropped**, because a measurement that
 *    cannot be attributed is not recorded.
 */

function say(id: string | null, data: Record<string, unknown> | null): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const attempts = (...oks: readonly boolean[]) =>
  oks.map((ok, i) => ({ run: i + 1, ok, exitCode: ok ? null : 1 }));

describe('a gate settles under the pass its round names', () => {
  test('a clean gate carries the command and every attempt', () => {
    const run = fold([
      say('verify_started', { gate: 'verification', round: 0 }),
      say('verify_passed', {
        gate: 'verification',
        round: 0,
        command: 'npm test',
        runs: 3,
        attempts: attempts(true, true, true),
      }),
    ]);

    expect(run.verify).toHaveLength(1);
    const gate = run.verify[0]?.gates[0];
    expect(gate?.status).toBe('passed');
    expect(gate?.runs).toBe(3);
    // The command, because a verdict about a suite is not usable without it.
    expect(gate?.command).toBe('npm test');
    expect(gate?.attempts).toHaveLength(3);
    expect(gate?.endedAt).not.toBeNull();
  });

  test('two gates in one pass share it, and the next round opens a new one', () => {
    const run = fold([
      say('verify_started', { gate: 'typecheck', round: 0 }),
      say('verify_passed', { gate: 'typecheck', round: 0, command: 'tsc', runs: 1 }),
      say('verify_started', { gate: 'test', round: 0 }),
      say('verify_failed', {
        gate: 'test',
        round: 0,
        command: 'npm test',
        runs: 3,
        failed: 3,
        verdict: 'failing',
      }),
      // The fix round, and the same two gates again.
      say('verify_started', { gate: 'typecheck', round: 1 }),
      say('verify_passed', { gate: 'typecheck', round: 1, command: 'tsc', runs: 1 }),
    ]);

    expect(run.verify).toHaveLength(2);
    expect(run.verify[0]?.gates.map((g) => g.name)).toEqual(['typecheck', 'test']);
    expect(run.verify[1]?.gates.map((g) => g.name)).toEqual(['typecheck']);
    // The round is what separates them, and it is the archive's number - which
    // is what the verify artifacts are keyed by.
    expect(run.verify.map((p) => p.round)).toEqual([0, 1]);
  });

  test('a core that carries no round puts everything in one pass', () => {
    // The honest reading of an older core: one pass with everything in it,
    // rather than a pass invented per gate, which would draw a trend out of
    // gates that all ran together.
    const run = fold([
      say('verify_started', { gate: 'a' }),
      say('verify_passed', { gate: 'a', runs: 1 }),
      say('verify_started', { gate: 'b' }),
      say('verify_passed', { gate: 'b', runs: 1 }),
    ]);
    expect(run.verify).toHaveLength(1);
    expect(run.verify[0]?.gates).toHaveLength(2);
  });
});

describe('the verdict is the loop’s and never the window’s', () => {
  test('one failing run of one is failing, not flaky', () => {
    // The case a window computing `failed < runs` gets wrong in the other
    // direction, and the case #135 is explicit about: one sample says nothing
    // about determinism, so this must never read as a noisy suite.
    const run = fold([
      say('verify_started', { gate: 'test', round: 0 }),
      say('verify_failed', {
        gate: 'test',
        round: 0,
        command: 'npm test',
        runs: 1,
        failed: 1,
        verdict: 'failing',
        attempts: attempts(false),
      }),
    ]);
    expect(run.verify[0]?.gates[0]?.verdict).toBe('failing');
  });

  test('one failure among three is flaky, and which run it was survives', () => {
    const run = fold([
      say('verify_started', { gate: 'test', round: 0 }),
      say('verify_failed', {
        gate: 'test',
        round: 0,
        command: 'npm test',
        runs: 3,
        failed: 1,
        verdict: 'flaky',
        attempts: attempts(true, false, true),
      }),
    ]);
    const gate = run.verify[0]?.gates[0];
    expect(gate?.verdict).toBe('flaky');
    // Which run failed is the information that separates broken from noisy, and
    // it is drawn rather than placed among three slots by guesswork.
    expect(gate?.attempts.filter((a) => !a.ok).map((a) => a.run)).toEqual([2]);
  });

  test('a verdict word this build has never heard of is carried, not replaced', () => {
    // The same rule `ending()` follows for an unknown exit code. A pane with no
    // sentence for it shows none; it does not invent one.
    const run = fold([
      say('verify_started', { gate: 'test', round: 0 }),
      say('verify_failed', { gate: 'test', round: 0, runs: 2, failed: 1, verdict: 'quantum' }),
    ]);
    expect(run.verify[0]?.gates[0]?.verdict).toBe('quantum');
  });
});

describe('absence is not zero, here either', () => {
  test('verification being off is a pass of disabled gates, not an empty list', () => {
    // Two different facts, and until #223 the run said neither. An empty list
    // means the gate has not come round yet.
    const run = fold([say('verify_disabled', { gates: ['typecheck', 'test'], round: 0 })]);
    expect(run.verify).toHaveLength(1);
    expect(run.verify[0]?.gates.map((g) => g.status)).toEqual(['disabled', 'disabled']);
    expect(run.verify[0]?.gates[0]?.command).toBeNull();
  });

  test('an unavailable gate keeps its reason and reports no runs', () => {
    const run = fold([
      say('verify_started', { gate: 'typecheck', round: 0 }),
      say('verify_unavailable', { gate: 'typecheck', round: 0, reason: 'no command configured' }),
    ]);
    const gate = run.verify[0]?.gates[0];
    expect(gate?.status).toBe('unavailable');
    expect(gate?.reason).toBe('no command configured');
    expect(gate?.runs).toBe(0);
    // Never a fabricated failure count for a gate that never ran.
    expect(gate?.failed).toBeNull();
  });

  test('a partly-readable attempt list is dropped whole', () => {
    // Dropping one attempt from three is how a flaky suite comes to look like a
    // clean one, so the list is whole or it is absent - the same rule `strings`
    // applies, on the sequence where it matters most.
    const run = fold([
      say('verify_started', { gate: 'test', round: 0 }),
      say('verify_failed', {
        gate: 'test',
        round: 0,
        runs: 3,
        failed: 1,
        verdict: 'flaky',
        attempts: [{ run: 1, ok: true }, { run: 2 }, { run: 3, ok: true }],
      }),
    ]);
    expect(run.verify[0]?.gates[0]?.attempts).toEqual([]);
    // The fraction the loop reported survives, so the pane still has something
    // true to say.
    expect(run.verify[0]?.gates[0]?.failed).toBe(1);
  });

  test('a verdict with no gate under it is dropped', () => {
    // A measurement that cannot be attributed is not recorded. Nothing is
    // created, because a gate invented here would have a start time nobody
    // measured.
    const run = fold([say('verify_passed', { gate: 'ghost', round: 0, runs: 1 })]);
    expect(run.verify).toHaveLength(0);
  });

  test('a second gate of the same name settles the one still running', () => {
    const run = fold([
      say('verify_started', { gate: 'test', round: 0 }),
      say('verify_passed', { gate: 'test', round: 0, runs: 1, command: 'first' }),
      say('verify_started', { gate: 'test', round: 1 }),
      say('verify_passed', { gate: 'test', round: 1, runs: 1, command: 'second' }),
    ]);
    expect(run.verify[0]?.gates[0]?.command).toBe('first');
    expect(run.verify[1]?.gates[0]?.command).toBe('second');
  });
});
