import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig } from '@src/config.js';
import { createRun, loadRun, pendingStepBack, stallAction } from '@src/run.js';
import type { PlanStallEntry, RunState } from '@src/types.js';

/**
 * What a plan-loop stall does next (#394), and how its record is read back.
 *
 * One pure function owns both rules: `lastStall` is the latest entry of any
 * kind, and a stall escalates only when a step-back already sits after the
 * latest escalation. The loop cases in `plan-step-back.test.ts` drive it end to
 * end; these pin the table itself.
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

// ---- the stored record -----------------------------------------------------

function loadWith(mutate: (raw: Record<string, unknown>) => void): RunState {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-stall-stored-'));
  const state = createRun(targetDir, 'stall stored', true);
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  mutate(raw);
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  return loadRun(targetDir, state.id);
}

function repaired(state: RunState): string[] {
  return state.events.filter((e) => e.type === 'state_repaired').map((e) => String(e['field']));
}

test('absent stall fields stay absent, with nothing repaired', () => {
  const state = loadWith(() => {});
  assert.equal(state.planStalls, undefined);
  assert.equal(state.planRevisedByAnswer, undefined);
  assert.deepEqual(repaired(state), []);
});

test('a well-formed stall history reads back as written', () => {
  const stalls = [entry(3, 'step-back', true), entry(5, 'escalated')];
  const state = loadWith((raw) => {
    raw['planStalls'] = stalls;
    raw['planRevisedByAnswer'] = true;
  });
  assert.deepEqual(state.planStalls, stalls);
  assert.equal(state.planRevisedByAnswer, true);
  assert.deepEqual(repaired(state), []);
});

test('a planStalls that is not a list is replaced, and the repair says so', () => {
  const state = loadWith((raw) => {
    raw['planStalls'] = { position: 3 };
  });
  assert.deepEqual(state.planStalls, []);
  assert.ok(repaired(state).includes('planStalls'));
});

test('a malformed stall entry is not taken in, and the drop is reported', () => {
  const good = entry(3, 'step-back');
  const state = loadWith((raw) => {
    raw['planStalls'] = [
      good,
      { ...good, action: 'retreat' },
      { ...good, position: -1 },
      { ...good, position: 2.5 },
      { ...good, counts: [2, 'two', 2] },
      { ...good, fresh: [2, 2] },
      { ...good, sent: 'yes' },
      'not an entry',
    ];
  });
  assert.deepEqual(state.planStalls, [good]);
  assert.ok(repaired(state).includes('planStalls'));
});

test('a planRevisedByAnswer that is not a boolean is dropped', () => {
  const state = loadWith((raw) => {
    raw['planRevisedByAnswer'] = 'true';
  });
  assert.equal(state.planRevisedByAnswer, undefined);
  assert.ok(repaired(state).includes('planRevisedByAnswer'));
});

// ---- the setting -----------------------------------------------------------

/** The validator, reached the way a project's file reaches it. */
function load(stallAfter: number): number {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-stall-config-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ loop: { stallAfter } }), 'utf8');
  return loadConfig(dir).loop.stallAfter;
}

test('stallAfter defaults to 3, and 0 is legal because it turns detection off', () => {
  assert.equal(DEFAULTS.loop.stallAfter, 3);
  assert.equal(load(0), 0);
  assert.equal(load(3), 3);
});

test('stallAfter refuses a negative or a fraction, by name', () => {
  assert.throws(() => load(-1), /loop\.stallAfter/);
  assert.throws(() => load(1.5), /loop\.stallAfter/);
});
