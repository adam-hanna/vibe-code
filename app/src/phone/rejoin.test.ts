import { describe, expect, test } from 'vitest';
import { ENDED_WHILE_AWAY, rejoin, routeFrame, settleRejoin, updateRun, watchRun } from '../cockpit/hosts';
import type { LiveRun, LiveRuns } from '../cockpit/hosts';
import { emptyRun, hostLost, reduce } from '../cockpit/model';
import type { Frame } from '../host';

/**
 * A reconnect replays every live run's frames (#346). Folded on top of what was
 * already folded, a run would draw every turn twice - the defect most likely to
 * ship unnoticed. So a reconnect starts each live run again from its base, and
 * these pin that the result is the run folded once.
 */

const say = (id: string, data: Record<string, unknown>): Frame => ({ type: 'narration', level: 'info', message: 'x', id, data });

const FRAMES: readonly Frame[] = [
  say('run_started', { runId: 'r1', dir: '/repo/.vibe/runs/r1', repo: '/repo', task: 'build it' }),
  say('phase_started', { phase: 'planning', round: 0 }),
  say('turn_started', { role: 'planner', kind: 'plan' }),
  say('phase_started', { phase: 'critique', round: 0 }),
  say('turn_started', { role: 'critic', kind: 'critique', round: 0 }),
];

function entry(over: Partial<LiveRun> = {}): LiveRun {
  return {
    handle: 'run-7',
    invokeId: 7,
    answered: new Set(),
    live: true,
    dir: '/repo',
    asked: null,
    task: 'build it',
    sent: null,
    draft: null,
    held: null,
    adopted: null,
    pid: 100,
    heard: true,
    pausing: false,
    stopping: false,
    watched: false,
    unclaimed: [],
    run: emptyRun(),
    base: emptyRun(),
    ...over,
  };
}

/** Each frame through `updateRun`, as the cockpit folds it, one millisecond apart. */
function fold(lives: LiveRuns, frames: readonly Frame[], t0 = 1_000): LiveRuns {
  return frames.reduce((l, frame, i) => updateRun(l, 'run-7', (r) => reduce(r, frame, t0 + i)), lives);
}

const once = fold([entry()], FRAMES)[0]!.run;

describe('a reconnect does not double a run', () => {
  test('folded, reconnected and refolded, it matches the run folded once', () => {
    const before = fold([entry()], FRAMES);
    const rejoined = rejoin(before);
    expect(rejoined[0]!.run.cycles).toEqual([]);
    const refolded = fold(rejoined, FRAMES);
    const { lives, lost } = settleRejoin(refolded, new Set(['run-7']), 5_000, ENDED_WHILE_AWAY);
    expect(lost).toEqual([]);
    expect(lives[0]!.run).toEqual(once);
    expect(lives[0]!.rejoining).toBeNull();
  });

  test('without the reconnect, folding the replay again doubles the turns: the defect this prevents', () => {
    const doubled = fold(fold([entry()], FRAMES), FRAMES)[0]!.run;
    expect(doubled).not.toEqual(once);
  });

  test('a resumed run refolds onto its seeded history, not onto nothing', () => {
    const seed = fold([entry()], FRAMES.slice(0, 3))[0]!.run;
    const resumed = entry({ run: seed, base: seed });
    const live = fold([resumed], FRAMES.slice(3));
    const refolded = fold(rejoin(live), FRAMES.slice(3));
    const { lives } = settleRejoin(refolded, new Set(['run-7']), 5_000, ENDED_WHILE_AWAY);
    expect(lives[0]!.run).toEqual(live[0]!.run);
  });

  test('host gone and nothing replayed: what was on screen comes back, lost', () => {
    const before = fold([entry()], FRAMES);
    const { lives, lost } = settleRejoin(rejoin(before), new Set(), 5_000, ENDED_WHILE_AWAY);
    expect(lost).toEqual(['run-7']);
    expect(lives[0]!.run).toEqual(hostLost(before[0]!.run, 5_000, ENDED_WHILE_AWAY));
  });

  test('host alive and nothing replayed: what was on screen comes back unchanged', () => {
    const before = fold([entry()], FRAMES);
    const { lives, lost } = settleRejoin(rejoin(before), new Set(['run-7']), 5_000, ENDED_WHILE_AWAY);
    expect(lost).toEqual([]);
    expect(lives[0]!.run).toEqual(before[0]!.run);
  });

  test('host gone after the replay: the refolded run stands', () => {
    const refolded = fold(rejoin(fold([entry()], FRAMES)), FRAMES);
    const { lives, lost } = settleRejoin(refolded, new Set(), 5_000, ENDED_WHILE_AWAY);
    expect(lost).toEqual([]);
    expect(lives[0]!.run).toEqual(once);
  });

  test('two reconnects before any replay keep the last run actually folded', () => {
    const before = fold([entry()], FRAMES);
    const twice = rejoin(rejoin(before));
    expect(twice[0]!.rejoining?.prior).toEqual(before[0]!.run);
  });

  test('a run that is no longer live is left alone', () => {
    const ended = [entry({ live: false, run: once })];
    expect(rejoin(ended)).toEqual(ended);
  });

  test('a watched run - every run a phone draws - is refolded once, never retired (#347)', () => {
    // A phone starts no run hosts, so each run it draws is one it is watching,
    // made by `watchRun` from the host's first frame. The cockpit remembers every
    // handle it has had an entry for, and a replayed frame must still reach the
    // entry rather than be routed `stale` as a run already finished.
    const watched = fold(watchRun([], 'run-7', 1), FRAMES);
    const seen = new Set(['run-7']);
    const rejoined = rejoin(watched);
    expect(routeFrame(rejoined, 'run-7', seen)).toBe('run');
    const { lives, lost } = settleRejoin(fold(rejoined, FRAMES), new Set(['run-7']), 5_000, ENDED_WHILE_AWAY);
    expect(lost).toEqual([]);
    expect(lives).toHaveLength(1);
    expect(lives[0]!.watched).toBe(true);
    expect(lives[0]!.run).toEqual(fold(watchRun([], 'run-7', 1), FRAMES)[0]!.run);
  });

  test('a host first seen during the disconnect is watched from its replay (#347)', () => {
    const rejoined = rejoin(fold([entry()], FRAMES));
    expect(routeFrame(rejoined, 'run-9', new Set(['run-7']))).toBe('watch');
  });
});
