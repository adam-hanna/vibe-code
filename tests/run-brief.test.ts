import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitFork, planFork } from '@src/fork.js';
import { orchestrate } from '@src/orchestrator.js';
import { priorRunsSection } from '@src/prompts.js';
import { BRIEF_FILE, createRun, listCheckpoints, listRuns, loadRun, saveState } from '@src/run.js';
import { agents, committing, config, freshRun, planFixture, verifying, work } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * `BRIEF.md` (#500): each run's brief as a file of its own, for whoever reads
 * the run afterwards.
 *
 * The properties, in the order they matter:
 *
 * - **It is the brief exactly as stored in `task`**, written once by
 *   `createRun`, and by `commitFork` for a fork from the child's own `task`.
 * - **Nothing reads it back.** `state.json` stays the source of truth, so an
 *   edited `BRIEF.md` changes nothing, and nothing rewrites it.
 * - **The past-run index names it first**, and a run from before it existed -
 *   with no `BRIEF.md` - lists and renders exactly as one with it.
 */

const RUNS = path.join('.vibe', 'runs');

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-run-brief-'));
}

const briefOf = (state: RunState): string => readFileSync(path.join(state.dir, BRIEF_FILE), 'utf8');

// A brief with everything a first-line index would drop or flatten: several
// lines, a lone CR, backticks, trailing whitespace and non-ASCII text.
const LONG_BRIEF =
  '# Fix the thing\n\nDecided already - do not re-derive:\r\n- `a` stays `b`\r- naïve → café\n\n  trailing  \n';

test('createRun writes BRIEF.md as the brief exactly as stored in task', () => {
  const state = createRun(tempDir(), LONG_BRIEF, true);
  assert.equal(briefOf(state), LONG_BRIEF);
  assert.equal(loadRun(state.targetDir, state.id).task, LONG_BRIEF);
});

test('editing BRIEF.md changes nothing, and nothing rewrites it', () => {
  const state = createRun(tempDir(), 'the real brief', true);
  const file = path.join(state.dir, BRIEF_FILE);
  writeFileSync(file, 'an edited brief', 'utf8');

  const loaded = loadRun(state.targetDir, state.id);
  assert.equal(loaded.task, 'the real brief', 'the brief is read from state.json, never from BRIEF.md');
  saveState(loaded);
  assert.equal(readFileSync(file, 'utf8'), 'an edited brief', 'a state write does not rewrite BRIEF.md');
  assert.equal(listRuns(state.targetDir)[0]?.task, 'the real brief', 'the listing reads state.json too');
});

test('the past-run index names BRIEF.md first among the files a run directory may contain', () => {
  const section = priorRunsSection([{ id: '20260101-000000-old', status: 'done', task: 'old', costUsd: 0 }]);
  const list = section.slice(section.indexOf('**may** contain'));
  const named = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.equal(named[0], 'BRIEF.md');
  assert.ok(named.includes('FOLLOW-UPS.md'), 'the files named before it are all still named');
  assert.ok(section.includes('treat a missing file as nothing to report'));
});

test('a run from before BRIEF.md existed lists and renders as one with it', () => {
  const targetDir = tempDir();
  const current = createRun(targetDir, 'current', true);
  const withBrief = createRun(targetDir, 'has a brief', true);
  const old = '20250101-000000-old';
  mkdirSync(path.join(targetDir, RUNS, old), { recursive: true });
  writeFileSync(
    path.join(targetDir, RUNS, old, 'state.json'),
    JSON.stringify({ id: old, status: 'done', task: 'from before BRIEF.md', costUsd: 0 }),
    'utf8',
  );
  assert.equal(existsSync(path.join(targetDir, RUNS, old, BRIEF_FILE)), false);

  const runs = listRuns(targetDir, { exclude: current.id });
  assert.deepEqual(runs.map((r) => r.id).sort(), [old, withBrief.id].sort());
  const section = priorRunsSection(runs);
  assert.ok(section.includes(`\`${old}\` - done - from before BRIEF.md`));
  assert.ok(section.includes('has a brief'));
});

// ---- forks ------------------------------------------------------------------

async function parentRun(task: string): Promise<RunState> {
  const state = freshRun({ prefix: 'vibe-run-brief-', task, planOnly: false, git: true, commit: true });
  let round = 0;
  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(
      {
        claude: (label) => {
          if (label === 'plan' || label.startsWith('revise')) return planFixture();
          round += 1;
          work(state, `work-${round}.txt`);
          return `did ${label}`;
        },
      },
      [],
    ),
  );
  return state;
}

async function forkOf(parent: RunState): Promise<RunState> {
  const point = listCheckpoints(parent.dir).find((c) => c.meta?.commit != null);
  assert.ok(point !== undefined, 'the parent recorded a checkpoint with a commit');
  const plan = await planFork(parent.targetDir, parent.id, point.n, {});
  return (await commitFork(parent.targetDir, plan)).state;
}

test("a fork gets its own BRIEF.md from its own task, and the parent's is untouched", async () => {
  const parent = await parentRun('forked brief\n\nwith a second paragraph');
  const before = briefOf(parent);
  const child = await forkOf(parent);

  assert.notEqual(child.dir, parent.dir);
  assert.equal(briefOf(child), child.task);
  assert.equal(child.task, 'forked brief\n\nwith a second paragraph');
  assert.equal(briefOf(parent), before);
});

test('a fork of a run with no BRIEF.md still gets one', async () => {
  const parent = await parentRun('parent from before BRIEF.md');
  rmSync(path.join(parent.dir, BRIEF_FILE));
  const child = await forkOf(parent);

  assert.equal(briefOf(child), 'parent from before BRIEF.md');
  assert.equal(existsSync(path.join(parent.dir, BRIEF_FILE)), false, 'nothing is written into the parent');
});
