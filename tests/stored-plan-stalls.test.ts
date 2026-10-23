import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig } from '@src/config.js';
import { createRun, loadRun } from '@src/run.js';
import type { PlanStallEntry, RunState } from '@src/types.js';

/**
 * How a plan-loop stall's record is read back, and the setting that turns the
 * detector on (#394).
 *
 * `planStalls` and `planRevisedByAnswer` are read by `src/stored.ts`, which
 * refuses a malformed value as its peers there do; `loop.stallAfter` is zero or
 * a positive whole number, because `0` turns detection off. The rules that act
 * on the record are in `stall-action.test.ts`.
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
