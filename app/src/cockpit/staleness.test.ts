import { describe, expect, test } from 'vitest';
import { MISSED_TICKS, emptyRun, reduce, staleness } from './model';
import type { Run } from './model';
import type { Frame } from '../host';

/**
 * Two clocks, and why one of them is not enough (`7c`, #223).
 *
 * `7c` replaced `5b` for a specific reason: a threshold on a single timer cannot
 * tell *"nothing happened"* from *"I stopped being able to tell"*, and those need
 * opposite responses. A beat fires on the loop's own timer whether or not the
 * child said anything, so its arrival proves **vibe** is alive and proves nothing
 * about the turn; `sinceOutputMs` proves the opposite thing.
 *
 * The case this file exists for is the middle one. A turn that has written
 * nothing for twelve minutes is a **healthy** turn, and the retired 6-minute
 * indicator is on the design canvas with exactly that reason beside it: an
 * indicator that fires on healthy turns is one people stop reading.
 */

const INTERVAL = 30_000;

function say(id: string | null, data: Record<string, unknown> | null): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

const beat = (over: Record<string, unknown> = {}): Frame =>
  say('heartbeat', {
    label: 'implement',
    elapsedMs: 60_000,
    activities: 12,
    unit: 'tool use',
    tokens: 1000,
    promptTokens: 500,
    intervalMs: INTERVAL,
    ...over,
  });

/** A run with one turn open and one beat delivered at `t0`. */
function beating(over: Record<string, unknown> = {}, t0 = 1_000_000): { run: Run; at: number } {
  const frames = [
    say('phase_started', { phase: 'implementing' }),
    say('turn_started', { role: 'implementer', kind: 'implement' }),
    beat(over),
  ];
  const run = frames.reduce((r, f, i) => reduce(r, f, t0 + i), emptyRun());
  return { run, at: t0 + frames.length - 1 };
}

describe('the three states are a comparison, not a threshold', () => {
  test('recent output is live', () => {
    const { run, at } = beating({ sinceOutputMs: 2_000 });
    expect(staleness(run, at).state).toBe('live');
  });

  test('a silent child under a beating loop is thinking, not stale', () => {
    // The case the whole screen exists for. Twelve minutes of silence with vibe
    // still ticking is a healthy turn in a long tool call or a reasoning block,
    // and it must not look alarming.
    const { run, at } = beating({ sinceOutputMs: 12 * 60_000 });
    const s = staleness(run, at);
    expect(s.state).toBe('thinking');
    // Both clocks survive, because the point is the comparison: either number
    // alone is the one that misleads.
    expect(s.outputMs).toBeGreaterThan(11 * 60_000);
    expect(s.activityMs).toBeLessThan(INTERVAL);
  });

  test('both clocks stale is not-live', () => {
    const { run, at } = beating({ sinceOutputMs: 12 * 60_000 });
    // Long enough that the loop itself has missed its ticks.
    const later = at + INTERVAL * MISSED_TICKS + 1;
    expect(staleness(run, later).state).toBe('not-live');
  });

  test('the threshold moves with the cadence the loop reported', () => {
    // The design's one open judgement, answered as it asks: a few missed ticks,
    // derived from vibe's own heartbeat interval rather than picked. A run
    // configured slower stays live longer, which a hardcoded 90 seconds would
    // not.
    const slow = beating({ intervalMs: 120_000, sinceOutputMs: 1_000 });
    const atThreeMinutes = slow.at + 180_000;
    expect(staleness(slow.run, atThreeMinutes).state).not.toBe('not-live');

    const fast = beating({ intervalMs: 10_000, sinceOutputMs: 1_000 });
    expect(staleness(fast.run, fast.at + 180_000).state).toBe('not-live');
  });
});

describe('what it refuses to say', () => {
  test('a turn with no beat yet is unknown, never stale', () => {
    // A fresh turn must never flicker through the middle state - that is
    // `turnStartedAt`'s job in the design, and here it falls out of having
    // nothing to compare.
    const t0 = 1_000_000;
    const run = [
      say('phase_started', { phase: 'implementing' }),
      say('turn_started', { role: 'implementer', kind: 'implement' }),
    ].reduce((r, f, i) => reduce(r, f, t0 + i), emptyRun());
    const s = staleness(run, t0 + 5_000);
    expect(s.state).toBe('unknown');
    expect(s.why).toMatch(/has not reported a heartbeat/);
  });

  test('no cadence means no verdict, and the reason is stated', () => {
    // Fail closed. Picking a number here would be the invented denominator this
    // repo refuses everywhere else - and it would be invented at the one moment
    // somebody is deciding whether to kill a run.
    const { run, at } = beating({ intervalMs: undefined, sinceOutputMs: 60_000 });
    const s = staleness(run, at);
    expect(s.state).toBe('unknown');
    expect(s.why).toMatch(/how often the loop beats/);
    // What IS known is still reported. An unmeasurable verdict is not a reason
    // to withhold two measurements.
    expect(s.outputMs).toBe(60_000);
    expect(s.lastBeatAt).toBe(at);
  });

  test('a turn whose child has written nothing reads live, not thinking', () => {
    // No output at all is neither recent nor stale: there is nothing to be
    // either. vibe is beating, which is the honest half of what is known, and
    // calling it `thinking` would claim a silence that was never broken.
    const { run, at } = beating({ sinceOutputMs: undefined });
    const s = staleness(run, at);
    expect(s.state).toBe('live');
    expect(s.outputMs).toBeNull();
  });

  test('no turn running is unknown and says why', () => {
    expect(staleness(emptyRun(), 1_000).state).toBe('unknown');
    expect(staleness(emptyRun(), 1_000).why).toMatch(/no turn is running/);
  });
});

describe('output lines carry the phase they arrived in', () => {
  test('a line is filed under the phase the loop last announced', () => {
    // Stamped, never inferred. Reading the sentence to work it out would file a
    // line under whatever word it happened to contain, which is the
    // English-matching #133 exists to prevent.
    const t0 = 1_000_000;
    const run = [
      say('run_started', { runId: 'r', dir: 'd' }),
      say('phase_started', { phase: 'planning' }),
      say('turn_started', { role: 'planner', kind: 'plan' }),
      say(null, null),
      say('phase_started', { phase: 'implementing' }),
      say(null, null),
    ].reduce((r, f, i) => reduce(r, f, t0 + i), emptyRun());

    expect(run.output.map((l) => l.phase)).toEqual([
      // Before any phase, which is a real state: the run announcement and
      // preflight genuinely belong to none.
      null,
      // A `phase_started` line belongs to the phase it OPENS, not the one before.
      'planning',
      'planning',
      'planning',
      'implementing',
      'implementing',
    ]);
  });

  test('the role is the turn that was open, and null between turns', () => {
    const t0 = 1_000_000;
    const run = [
      say('phase_started', { phase: 'planning' }),
      say('turn_started', { role: 'planner', kind: 'plan' }),
      say(null, null),
      // An `ask` closes the running turn, so what follows has no role.
      { type: 'ask', id: 1, context: { boundary: 'plan-round', planRound: 0, reviewRound: 0, verifyRound: 0 } } as Frame,
      say(null, null),
    ].reduce((r, f, i) => reduce(r, f, t0 + i), emptyRun());

    const roles = run.output.map((l) => l.role);
    expect(roles[2]).toBe('planner');
    expect(roles[roles.length - 1]).toBeNull();
  });
});
