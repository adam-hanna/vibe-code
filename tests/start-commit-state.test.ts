import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, REAL_GATE } from '@src/cli.js';
import { commitFork, planFork } from '@src/fork.js';
import { orchestrate } from '@src/orchestrator.js';
import { createRun, listCheckpoints, loadRun, saveState } from '@src/run.js';
import { validateStoredState } from '@src/stored.js';
import {
  agents,
  committing,
  config,
  freshRun,
  planFixture,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * `state.start` across a stop, a resume, the summary and a fork (#249).
 *
 * Absence is preserved - every run from before the field has none and none is
 * back-filled - a well-formed record round-trips with no repairs, and a damaged
 * one is dropped whole rather than repaired into a commit nobody saw.
 */

const SHA = 'a'.repeat(40);

function widest(): Record<string, unknown> {
  const file = fileURLToPath(new URL('../../tests/fixtures/state/done-widest.json', import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

test('a state written before the field existed loads with no repairs and no start', () => {
  const { state, repairs } = read(widest());
  assert.deepEqual(repairs, []);
  assert.equal(state.start, undefined);
});

for (const start of [
  { sha: SHA, ref: 'origin/develop' },
  { sha: SHA, ref: null },
]) {
  test(`a start ${JSON.stringify(start.ref)} round-trips with no repairs`, () => {
    const { state, repairs } = read({ ...widest(), start });
    assert.deepEqual(repairs, []);
    assert.deepEqual(state.start, start);
  });
}

for (const bad of [
  'abc',
  { sha: 'abc1234', ref: null },
  { sha: SHA, ref: '' },
  { sha: SHA },
  { sha: SHA, ref: 7 },
]) {
  test(`a damaged start ${JSON.stringify(bad)} is dropped and says so`, () => {
    const { state, repairs } = read({ ...widest(), start: bad });
    assert.equal(state.start, undefined);
    assert.ok(
      repairs.some((r) => JSON.stringify(r).includes('start')),
      'the drop is reported, not silent',
    );
  });
}

test('a start survives a stop and a resume from disk with no repair', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-start-'));
  const state = createRun(dir, 'kept', true);
  state.branch = 'vibe/kept';
  state.start = { sha: SHA, ref: 'base' };
  saveState(state);
  const back = loadRun(dir, state.id);
  assert.deepEqual(back.start, { sha: SHA, ref: 'base' });
  assert.equal(back.events.filter((e) => e.type === 'state_repaired').length, 0);
});

// ---- the summary -------------------------------------------------------------

async function summaryOf(state: RunState): Promise<string[]> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts: unknown[]): void => void lines.push(parts.map(String).join(' '));
  console.error = () => undefined;
  try {
    await execute(state, config(), false, true, REAL_GATE, () => Promise.resolve());
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines.filter((l) => /Start:/.test(l));
}

test('the summary names the start commit and its ref when the run recorded one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-start-sum-'));
  const state = createRun(dir, 'summarised', true);
  state.start = { sha: SHA, ref: 'origin/develop' };
  const said = await summaryOf(state);
  assert.equal(said.length, 1);
  assert.match(said[0] ?? '', new RegExp(`${SHA}.*\\(origin/develop\\)`));
});

test('the summary prints no start line when the run has none', async () => {
  // A plan-only run outside a repository: nothing ever recorded a start.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-start-none-'));
  const state = createRun(dir, 'no start', true);
  assert.deepEqual(await summaryOf(state), []);
});

// ---- a fork ------------------------------------------------------------------

test('a fork does not inherit the start of the run it was forked from', async () => {
  const parent = freshRun({ prefix: 'vibe-start-fork-', task: 'parent', planOnly: false, git: true, commit: true });
  let round = 0;
  const realLog = console.log;
  console.log = () => undefined;
  try {
    await orchestrate(
      parent,
      config({}, { ...committing(), ...verifying(parent) }),
      false,
      agents(
        {
          claude: (label) => {
            if (label === 'plan' || label.startsWith('revise')) return planFixture();
            round += 1;
            work(parent, `work-${round}.txt`);
            return `did ${label}`;
          },
        },
        [],
      ),
    );
  } finally {
    console.log = realLog;
  }
  assert.notEqual(parent.start, undefined, 'the parent recorded where its branch started');
  const point = listCheckpoints(parent.dir).find((c) => c.meta?.commit != null);
  assert.ok(point !== undefined);
  const snapshot = JSON.parse(
    readFileSync(path.join(parent.dir, `checkpoint-${point.n}.json`), 'utf8'),
  ) as Record<string, unknown>;
  assert.notEqual(snapshot['start'], undefined, 'and the checkpoint carries it');

  const plan = await planFork(parent.targetDir, parent.id, point.n, {});
  const { state: child } = await commitFork(parent.targetDir, plan);
  assert.equal(child.start, undefined);
  assert.equal(loadRun(child.targetDir, child.id).start, undefined);
});
