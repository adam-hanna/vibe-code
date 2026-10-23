import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingStepBack, stallAction } from '@src/run.js';
import type { PlanStallEntry } from '@src/types.js';

/**
 * What a plan-loop stall does next (#394).
 *
 * One pure function owns both rules: `lastStall` is the latest entry of any
 * kind, and a stall escalates only when a step-back already sits after the
 * latest escalation. The loop cases in `plan-step-back.test.ts` drive it end to
 * end; these pin the table itself. How the record is read back from
 * `state.json`, and the setting, are in `stored-plan-stalls.test.ts`.
 */

function entry(position: number, action: PlanStallEntry['action'], sent?: boolean): PlanStallEntry {
  return {
    position,
    action,
    counts: [2, 2, 2],
    fresh: [2, 2, 2],
    ...(sent === undefined ? {} : { sent }),
  };
}

test('no stall yet: nothing to window against, and the first stall steps back', () => {
  assert.deepEqual(stallAction([]), { lastStall: null, action: 'step-back' });
});

test('after one step-back the next stall asks a person', () => {
  assert.deepEqual(stallAction([entry(3, 'step-back')]), { lastStall: 3, action: 'escalated' });
});

test('after a person was asked, the next stall steps back again - windowed from the escalation', () => {
  assert.deepEqual(stallAction([entry(3, 'step-back'), entry(5, 'escalated')]), {
    lastStall: 5,
    action: 'step-back',
  });
});

test('an escalation alone is a steer, so the next stall steps back', () => {
  assert.deepEqual(stallAction([entry(4, 'escalated')]), { lastStall: 4, action: 'step-back' });
});

test('a step-back after an escalation means the next stall escalates', () => {
  assert.deepEqual(stallAction([entry(4, 'escalated'), entry(7, 'step-back')]), {
    lastStall: 7,
    action: 'escalated',
  });
  assert.deepEqual(stallAction([entry(3, 'step-back'), entry(5, 'escalated'), entry(7, 'step-back')]), {
    lastStall: 7,
    action: 'escalated',
  });
});

test('the step-back a revision owes is the last entry, unsent, and only a step-back', () => {
  assert.equal(pendingStepBack([]), null);
  const unsent = entry(3, 'step-back');
  assert.equal(pendingStepBack([unsent]), unsent);
  assert.equal(pendingStepBack([entry(3, 'step-back', true)]), null);
  assert.equal(pendingStepBack([unsent, entry(5, 'escalated')]), null);
});
