import { describe, expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import contextSource from '../../../src/context.ts?raw';
import questionsPane from './QuestionsPane.tsx?raw';
import type { Run } from './model';
import type { Frame } from '../host';

/**
 * Compaction, and the sentence that was not true (`5e`, `1f`).
 *
 * Two defects with one shape: **a pane saying something the code does not do.**
 *
 * `session_compacting` has been on the wire since #133 and nothing drew it,
 * while the spend pane asserted that compaction *"is an event in the output
 * stream"* — true of the wire, and invisible in the app. That is #198 repeating
 * exactly: the mechanism landed, the two halves were never connected, and the
 * prose covered the gap.
 *
 * The questions pane was worse. It said the grace period before an auto-submit
 * *"is shown in the footer and only there"*. No countdown was built in the
 * footer, **and there is no auto-submit in the core to have one** — so the
 * sentence described a feature the loop does not have, in a place it was not.
 */

function say(id: string | null, data: Record<string, unknown> | null): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

describe('compaction is drawn, because the agent forgetting cannot be silent', () => {
  test('the loop still narrates it, which is what makes this drawable', () => {
    // Read from the core's own source. If this id ever stops being narrated, the
    // pane goes quiet and only this says why.
    expect(contextSource).toContain("id: 'session_compacting'");
  });

  test('a compaction carries its slot, model and the ratio it fired at', () => {
    const run = fold([
      say('session_compacting', { slot: 'main', model: 'claude-opus-5', measured: 0.82 }),
    ]);
    expect(run.compactions).toHaveLength(1);
    expect(run.compactions[0]?.slot).toBe('main');
    expect(run.compactions[0]?.measured).toBe(0.82);
  });

  test('an unmeasured ratio stays null, never a percentage nobody took', () => {
    // Null on the baseline branch, where the occupancy was measured under a
    // different model - so a ratio would have been against the wrong window.
    const run = fold([say('session_compacting', { slot: 'main', model: null, measured: null })]);
    expect(run.compactions[0]?.measured).toBeNull();
    expect(run.compactions[0]?.model).toBeNull();
  });

  test('a compaction that cannot say which session it compacted is dropped', () => {
    // A measurement that cannot be attributed is not recorded - the same rule
    // the heartbeat and the work reading both follow.
    expect(fold([say('session_compacting', { measured: 0.8 })]).compactions).toHaveLength(0);
  });

  test('several rotations are kept in order, because the count is the point', () => {
    const run = fold([
      say('session_compacting', { slot: 'main', measured: 0.8 }),
      say('session_compacting', { slot: 'judge', measured: 0.9 }),
    ]);
    expect(run.compactions.map((c) => c.slot)).toEqual(['main', 'judge']);
  });
});

describe('the questions pane no longer describes a timer that does not exist', () => {
  test('the core has no auto-submit and no grace period', () => {
    // The claim the old sentence rested on. If either is ever built, this fails
    // and the pane's wording should be revisited - which is the right direction
    // for a guard about a thing that is absent.
    expect(contextSource).not.toContain('gracePeriod');
    expect(questionsPane).not.toContain('grace period to interrupt.\n */');
  });

  test('the pane says what the loop does instead', () => {
    expect(questionsPane).toContain('Nothing here fires on a timer');
    // And the false sentence is gone rather than softened.
    expect(questionsPane).not.toContain('is shown in the footer and only there');
  });
});
