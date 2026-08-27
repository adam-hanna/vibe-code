import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { priorRunsSection } from '@src/prompts.js';
import { createRun, listRuns } from '@src/run.js';

/**
 * The archive as the planner's index reads it (#52).
 *
 * `listRuns` was the only code in the repo that read across runs, and its one
 * caller was `vibe list`. It now also feeds a prompt, which puts two new
 * demands on it: the run doing the reading must not be in its own index, and
 * the walk must be bounded before ten large `state.json` files are parsed.
 * Neither may cost the listing its first rule - one corrupt run must not take
 * out the healthy ones beside it, and nothing here may throw.
 *
 * Every fail-closed case asserts the *prompt* renders, not merely that the
 * listing returned: a run's own record must never be able to stop it planning.
 */

const RUNS = path.join('.vibe', 'runs');

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-past-runs-'));
}

/** A run directory with whatever `state.json` text the case wants. */
function plant(targetDir: string, id: string, text: string): void {
  const dir = path.join(targetDir, RUNS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), text, 'utf8');
}

function healthy(id: string, task: string): string {
  return JSON.stringify({ id, status: 'done', task, costUsd: 0 });
}

test('the current run is excluded, so a first-ever run sees an empty archive', () => {
  const targetDir = tempDir();
  const current = createRun(targetDir, 'the current task', true);

  // The case the byte-identity bar depends on: the run's own directory already
  // exists by the time the plan turn is dispatched.
  assert.deepEqual(listRuns(targetDir, { exclude: current.id }), []);
  assert.equal(priorRunsSection(listRuns(targetDir, { exclude: current.id })), '');
  // Without the filter it would list itself, which is what makes the filter
  // load-bearing rather than tidy.
  assert.equal(listRuns(targetDir).length, 1);
});

test('exclusion drops exactly one run, and order stays newest-first', () => {
  const targetDir = tempDir();
  const current = createRun(targetDir, 'current', true);
  plant(targetDir, '20260101-000000-oldest', healthy('20260101-000000-oldest', 'oldest'));
  plant(targetDir, '20260601-000000-middle', healthy('20260601-000000-middle', 'middle'));
  plant(targetDir, '20260901-000000-newest', healthy('20260901-000000-newest', 'newest'));

  const runs = listRuns(targetDir, { exclude: current.id });

  assert.deepEqual(
    runs.map((r) => r.task),
    ['newest', 'middle', 'oldest'],
  );
});

test('the limit keeps the newest runs, not the oldest', () => {
  const targetDir = tempDir();
  for (let i = 0; i < 6; i++) {
    const id = `2026010${i}-000000-run`;
    plant(targetDir, id, healthy(id, `task ${i}`));
  }

  const runs = listRuns(targetDir, { limit: 2 });

  assert.deepEqual(
    runs.map((r) => r.task),
    ['task 5', 'task 4'],
  );
});

test('the limit applies after the exclusion, so the current run costs no slot', () => {
  const targetDir = tempDir();
  // Named so it sorts newest: without the exclusion-before-slice order it would
  // take one of the ten slots and only nine prior runs would come back.
  const current = createRun(targetDir, 'zzz current', true);
  for (let i = 0; i < 12; i++) {
    const id = `2026010${String(i).padStart(2, '0')}-000000-run`;
    plant(targetDir, id, healthy(id, `task ${i}`));
  }

  const runs = listRuns(targetDir, { exclude: current.id, limit: 10 });

  assert.equal(runs.length, 10);
  assert.equal(
    runs.some((r) => r.id === current.id),
    false,
  );
});

test('a limit of zero lists nothing and renders nothing', () => {
  const targetDir = tempDir();
  plant(targetDir, '20260101-000000-run', healthy('20260101-000000-run', 'a task'));

  assert.deepEqual(listRuns(targetDir, { limit: 0 }), []);
  assert.equal(priorRunsSection(listRuns(targetDir, { limit: 0 })), '');
  // A negative limit is the same claim, not an accidental slice from the end.
  assert.deepEqual(listRuns(targetDir, { limit: -3 }), []);
});

test('a broken archive still leaves the planner with a renderable prompt', () => {
  const targetDir = tempDir();
  const current = createRun(targetDir, 'current', true);

  plant(targetDir, 'unparseable', '{');
  plant(targetDir, 'null-root', 'null');
  plant(targetDir, 'healthy-run', healthy('healthy-run', 'a real task'));
  // A run directory with no state.json at all, and one whose other artifacts
  // are garbage - neither is opened by the index, and neither may break it.
  mkdirSync(path.join(targetDir, RUNS, 'no-state'), { recursive: true });
  writeFileSync(path.join(targetDir, RUNS, 'healthy-run', 'FOLLOW-UPS.md'), '\0\0', 'utf8');

  const runs = listRuns(targetDir, { exclude: current.id, limit: 10 });
  const section = priorRunsSection(runs);

  assert.equal(
    runs.some((r) => r.id === 'no-state'),
    false,
    'a run with no state.json is not listed',
  );
  assert.equal(runs.find((r) => r.id === 'unparseable')?.status, 'unreadable');
  assert.equal(runs.find((r) => r.id === 'null-root')?.status, 'unreadable');
  assert.equal(runs.find((r) => r.id === 'unparseable')?.costUsd, null);
  // The worst outcome any of them may produce: listed as unreadable, or not
  // listed. The healthy run beside them is unaffected and the section renders.
  assert.ok(section.includes('- `healthy-run` - done - a real task'));
  assert.ok(section.includes('- `unparseable` - unreadable'));
});

test('an empty runs directory and a missing .vibe both render nothing', () => {
  const empty = tempDir();
  mkdirSync(path.join(empty, RUNS), { recursive: true });
  assert.deepEqual(listRuns(empty, { limit: 10 }), []);
  assert.equal(priorRunsSection(listRuns(empty, { limit: 10 })), '');

  const bare = tempDir();
  assert.deepEqual(listRuns(bare, { limit: 10 }), []);
  assert.equal(priorRunsSection(listRuns(bare, { limit: 10 })), '');
});

test('the listing itself is unchanged: verbatim values, no options, no writes', () => {
  const targetDir = tempDir();
  const hostile = 'implementing\r\n## a heading'.padEnd(3000, 'x');
  plant(targetDir, 'hostile', JSON.stringify({ status: hostile, task: 'a\nb', costUsd: 1.5 }));
  const before = readFileSync(path.join(targetDir, RUNS, 'hostile', 'state.json'), 'utf8');

  const runs = listRuns(targetDir);

  // `vibe list` prints what was stored. Bounding happens where the prompt is
  // rendered, so this path must stay byte-for-byte what it always was.
  assert.equal(runs[0]?.status, hostile);
  assert.equal(runs[0]?.task, 'a\nb');
  assert.equal(runs[0]?.costUsd, 1.5);
  assert.equal(readFileSync(path.join(targetDir, RUNS, 'hostile', 'state.json'), 'utf8'), before);
});

// ---- forks in the index (#78) -----------------------------------------------

test('a forked run is labelled in the index, tolerantly', () => {
  const targetDir = tempDir();
  plant(
    targetDir,
    'child',
    JSON.stringify({
      id: 'child',
      status: 'done',
      task: 'the fork',
      costUsd: 0,
      forkedFrom: { runId: 'parent-run', checkpoint: 4 },
    }),
  );

  const runs = listRuns(targetDir);
  assert.deepEqual(runs[0]?.forkedFrom, { runId: 'parent-run', checkpoint: 4 });
  const section = priorRunsSection(runs);
  assert.ok(section.includes('fork of `parent-run` at checkpoint 4'));
});

test('an unreadable fork record costs the label and nothing else', () => {
  const targetDir = tempDir();
  // A listing must not fail over one bad run - which is deliberately a different
  // rule from `loadRun`, where the same value refuses. One prints; the other acts.
  for (const [id, forkedFrom] of [
    ['a', 'not a record'],
    ['b', { runId: '', checkpoint: 2 }],
    ['c', { runId: 'p', checkpoint: 'second' }],
  ] as const) {
    plant(targetDir, id, JSON.stringify({ id, status: 'done', task: 't', costUsd: 0, forkedFrom }));
  }

  const runs = listRuns(targetDir);
  assert.equal(runs.length, 3);
  for (const run of runs) assert.equal(run.forkedFrom, undefined);
  assert.equal(priorRunsSection(runs).includes('fork of'), false);
});

test('a repo with no forks renders the index exactly as it did before', () => {
  const targetDir = tempDir();
  plant(targetDir, 'plain', healthy('plain', 'no forks here'));

  const section = priorRunsSection(listRuns(targetDir));
  assert.ok(section.includes('`plain` - done - no forks here'));
  assert.equal(section.includes('fork of'), false);
});
