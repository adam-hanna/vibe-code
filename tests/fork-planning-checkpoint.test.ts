import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { main } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { commitFork, ForkError, listForkPoints, planFork } from '@src/fork.js';
import type { ForkPlan } from '@src/fork.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import { listCheckpoints, loadRun } from '@src/run.js';
import type { CheckpointBoundary, Config, GatesConfig, RunState } from '@src/types.js';
import {
  agents,
  answersReport,
  BLOCKING,
  commitTree,
  committing,
  config,
  freshRun,
  markerGate,
  markerRuns,
  planFixture,
  questionFixture,
  report,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * `vibe fork` of a planning checkpoint, branched at the run's start commit (#488).
 *
 * A planning checkpoint records no commit because planning commits nothing, so
 * the tree it describes is the one the run started from - and since #249 the run
 * records that commit. These hold the three things the change rests on:
 *
 * - **The fork is put exactly there**, or refused: a missing start, or one this
 *   repository cannot resolve to itself, is never replaced by a guess.
 * - **The child keeps what is true of a branch made there** - the start, the
 *   REVIEW.md record read from it, the debt to baseline it - and every other
 *   road drops them exactly as before.
 * - **Nothing is created or moved by the fork itself**, on success or refusal.
 */

const MARKER = 'BROKEN';

const AUTO: GatesConfig = {
  'plan-round': 'auto',
  'question-round': 'auto',
  'plan-approved': 'auto',
  implemented: 'auto',
  'verify-round': 'auto',
  'review-round': 'auto',
};

const PLANNING: readonly CheckpointBoundary[] = ['question-round', 'plan-round', 'plan-approved'];

/** A verification gate a baseline is owed for, and the loop config around it. */
function cfgFor(state: RunState, gates: Partial<GatesConfig> = {}): Config {
  return config(
    { maxVerifyRounds: 2 },
    {
      ...committing(),
      gates: { ...AUTO, ...gates },
      verify: {
        ...DEFAULTS.verify,
        enabled: true,
        runs: 1,
        timeoutMs: 30_000,
        command: markerGate(state, 'verification', MARKER),
      },
    },
  );
}

/** Every implement or fix turn leaves a file of its own, so each round has a diff. */
function handlers(state: RunState): Handlers {
  return {
    claude: (label) => {
      // One question on the first plan, so the answerer runs and a question
      // round is written; every revision after it asks nothing.
      if (label === 'plan') return planFixture({ open_questions: [questionFixture()] });
      if (label.startsWith('revise')) return planFixture();
      work(state, `${label}.txt`);
      return `did ${label}`;
    },
    codex: (label) => {
      if (label.startsWith('answers-')) return answersReport([{}]);
      // Two P1s, not one: `p1Tolerance` defaults to 1, and a single blocking
      // finding is tolerated - the plan would be approved with no plan round.
      if (label === 'critique-0') return report(BLOCKING);
      return report([]);
    },
  };
}

async function drive(state: RunState, cfg: Config, h: Handlers, resume = false): Promise<{ calls: string[]; err: unknown }> {
  const calls: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  let err: unknown = null;
  try {
    await orchestrate(state, cfg, resume, agents(h, calls));
  } catch (e) {
    err = e;
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return { calls, err };
}

type Snapshot = Record<string, unknown>;

const fileOf = (state: RunState, n: number): string => path.join(state.dir, `checkpoint-${n}.json`);
const snapshot = (state: RunState, n: number): Snapshot =>
  JSON.parse(readFileSync(fileOf(state, n), 'utf8')) as Snapshot;
const rewrite = (state: RunState, n: number, edit: (s: Snapshot) => Snapshot): void =>
  writeFileSync(fileOf(state, n), JSON.stringify(edit(snapshot(state, n))), 'utf8');

/**
 * A run stopped at plan approval, having written every planning boundary.
 *
 * Asserted before it is handed over, so a fixture that stops producing one of
 * them fails here by name rather than letting a case pass over nothing.
 */
async function planningParent(task: string): Promise<{ parent: RunState; at: Map<CheckpointBoundary, number> }> {
  const parent = freshRun({ prefix: 'vibe-fork-plan-', task, planOnly: false, git: true, commit: true });
  const cfg = cfgFor(parent, { 'plan-approved': 'stop' });
  // The gate script is part of the start commit, and the tree is clean.
  commitTree(parent);
  const { err } = await drive(parent, cfg, handlers(parent));
  assert.ok(err instanceof Escalation && err.code === EXIT.NEEDS_HUMAN, String(err));
  assert.notEqual(parent.start, undefined, 'the parent recorded where its branch started');

  const at = new Map<CheckpointBoundary, number>();
  for (const c of listCheckpoints(parent.dir)) {
    // The LAST of each, so the question round is the one carrying the revision.
    if (c.meta !== null) at.set(c.meta.boundary, c.n);
  }
  for (const boundary of PLANNING) {
    const n = at.get(boundary);
    assert.ok(n !== undefined, `the parent wrote no ${boundary} checkpoint`);
    const held = snapshot(parent, n);
    assert.equal((held['checkpoint'] as Snapshot)['commit'], null, `${boundary} recorded no commit`);
    assert.deepEqual(held['start'], parent.start, `${boundary} carries the run's start`);
  }
  assert.equal(snapshot(parent, at.get('plan-approved') as number)['baselineDue'], true);
  return { parent, at };
}

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const runDirs = (state: RunState): string[] =>
  readdirSync(path.join(state.targetDir, '.vibe', 'runs')).sort();

const refs = (state: RunState): string => gitIn(state.targetDir, 'for-each-ref', '--format=%(refname)', 'refs/heads');

/** sha256 of every file in a directory, so "byte-identical" is an observation. */
function fingerprint(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const rel = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else out.push(`${rel} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** Everything a fork must leave as it found it, refused or not. */
function untouched(state: RunState): Record<string, unknown> {
  return {
    head: gitIn(state.targetDir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    headSha: gitIn(state.targetDir, 'rev-parse', 'HEAD'),
    status: gitIn(state.targetDir, 'status', '--porcelain'),
    index: gitIn(state.targetDir, 'diff', '--cached'),
    parent: fingerprint(state.dir),
  };
}

async function refused(state: RunState, n: number, ...messages: RegExp[]): Promise<string> {
  const before = { ...untouched(state), dirs: runDirs(state), refs: refs(state) };
  let message = '';
  await assert.rejects(
    () => planFork(state.targetDir, state.id, n, {}),
    (err: unknown) => {
      assert.ok(err instanceof ForkError, `expected a ForkError, got ${String(err)}`);
      for (const m of messages) assert.match(err.message, m);
      message = err.message;
      return true;
    },
  );
  assert.deepEqual({ ...untouched(state), dirs: runDirs(state), refs: refs(state) }, before, 'nothing was created');
  return message;
}

// ---- the start road ---------------------------------------------------------

test('a plan-approved checkpoint forks at the run start, and the child keeps what is true of it', async () => {
  const { parent, at } = await planningParent('plan approved');
  const n = at.get('plan-approved') as number;
  const start = parent.start;
  assert.ok(start !== undefined);
  // A record a real planning checkpoint never holds - REVIEW.md is read at the
  // first review - put there so that keeping it is observable.
  const reviewMd = { commit: start.sha, outcome: 'absent' };
  rewrite(parent, n, (s) => ({ ...s, reviewMd }));
  const before = untouched(parent);

  const plan = await planFork(parent.targetDir, parent.id, n, {});
  assert.equal(plan.commitFrom, 'start');
  assert.equal(plan.commit, start.sha);
  const { state: child, branch } = await commitFork(parent.targetDir, plan);

  assert.ok(branch !== null);
  assert.equal(gitIn(parent.targetDir, 'rev-parse', branch), start.sha, 'the branch is at the start');
  assert.deepEqual(untouched(parent), before, 'HEAD, the index, the tree and the parent are as they were');

  for (const held of [child, loadRun(child.targetDir, child.id)]) {
    assert.deepEqual(held.start, start, 'the start is kept, ref included');
    assert.equal(held.baselineDue, true, 'the debt to baseline the start is kept');
    assert.deepEqual(held.reviewMd, reviewMd);
    assert.equal(held.gateBaseline, undefined);
    assert.equal(held.requestedBranch, undefined);
    assert.equal(held.branchPending, true);
    assert.equal(held.forkedFrom?.branchFrom, start.sha);
  }
  const stated = child.forkedFrom?.notInherited ?? [];
  assert.ok(stated.some((l) => l.includes("run's start commit") && l.includes('from planning')), stated.join('\n'));
  assert.ok(stated.some((l) => l.includes('uncommitted changes') && l.includes('may')), stated.join('\n'));
  assert.equal(stated.some((l) => l.includes('commit the checkpoint recorded')), false);
  assert.ok(stated.some((l) => l.includes("fork's branch is a new ref")));
});

test('a plan-round and a question-round checkpoint fork at the run start too', async () => {
  const { parent, at } = await planningParent('earlier planning');
  const start = parent.start;
  assert.ok(start !== undefined);
  for (const boundary of ['plan-round', 'question-round'] as const) {
    const n = at.get(boundary) as number;
    const held = snapshot(parent, n);
    const before = untouched(parent);

    const plan = await planFork(parent.targetDir, parent.id, n, {});
    assert.equal(plan.commitFrom, 'start', boundary);
    const { state: child, branch } = await commitFork(parent.targetDir, plan);

    assert.ok(branch !== null);
    assert.equal(gitIn(parent.targetDir, 'rev-parse', branch), start.sha, boundary);
    assert.deepEqual(untouched(parent), before, boundary);
    const stored = loadRun(child.targetDir, child.id);
    assert.deepEqual(stored.start, start, boundary);
    assert.equal(stored.baselineDue, held['baselineDue'], `${boundary}: the debt is the checkpoint's`);
    assert.equal(stored.gateBaseline, undefined, boundary);
    const stated = stored.forkedFrom?.notInherited ?? [];
    assert.ok(stated.some((l) => l.includes("run's start commit")), boundary);
    assert.ok(stated.some((l) => l.includes('uncommitted changes')), boundary);
  }
});

// ---- refusals ---------------------------------------------------------------

test('a planning checkpoint with no recorded start is refused, and says why', async () => {
  const { parent, at } = await planningParent('no start');
  const n = at.get('plan-approved') as number;
  // The shape of a run from before #249: a valid state, not one needing repair.
  rewrite(parent, n, (s) => {
    const out = { ...s };
    delete out['start'];
    return out;
  });
  await refused(parent, n, /recorded no commit/, /#249/, /no commits/, /--no-branch/);
});

test('a start this repository cannot resolve to itself is refused, never replaced', async () => {
  const { parent, at } = await planningParent('bad start');
  const n = at.get('plan-approved') as number;
  rewrite(parent, n, (s) => ({ ...s, start: { ...(s['start'] as Snapshot), sha: 'a'.repeat(40) } }));
  await refused(parent, n, /from planning/, /cannot resolve/, /--no-branch/);
});

test('a checkpoint after planning with no commit is refused as before, start or not', async () => {
  // Commits off, so the implement and review checkpoints record none - and they
  // still carry the start, which says nothing about the tree after a turn wrote.
  const parent = freshRun({ prefix: 'vibe-fork-plan-nocommit-', task: 'commits off', planOnly: false, git: true, commit: true });
  const { err } = await drive(parent, config(), {
    claude: (label) => {
      if (label === 'plan' || label.startsWith('revise')) return planFixture();
      work(parent, `${label}.txt`);
      return `did ${label}`;
    },
  });
  assert.equal(err, null, String(err));
  const point = listCheckpoints(parent.dir).find(
    (c) => c.meta?.boundary === 'implemented' && c.meta.commit === null,
  );
  assert.ok(point !== undefined, 'the implement checkpoint recorded no commit');
  assert.notEqual(snapshot(parent, point.n)['start'], undefined, 'and carries the start');

  const message = await refused(parent, point.n, /recorded no commit \(commits-disabled\)/, /--no-branch/);
  assert.doesNotMatch(message, /#249/);
  assert.doesNotMatch(message, /planning/);
});

// ---- the other roads, unchanged --------------------------------------------

test('--no-branch on a planning checkpoint drops the start fields, as it always did', async () => {
  const { parent, at } = await planningParent('no branch');
  const n = at.get('plan-approved') as number;
  rewrite(parent, n, (s) => ({ ...s, reviewMd: { commit: parent.start?.sha, outcome: 'absent' } }));
  const refsBefore = refs(parent);

  const plan = await planFork(parent.targetDir, parent.id, n, { git: { useBranch: false } });
  assert.notEqual(plan.commitFrom, 'start');
  const { state: child, branch } = await commitFork(parent.targetDir, plan);

  assert.equal(branch, null);
  assert.equal(refs(parent), refsBefore, 'no ref was made');
  for (const held of [child, loadRun(child.targetDir, child.id)]) {
    assert.equal(held.start, undefined);
    assert.equal(held.baselineDue, undefined);
    assert.equal(held.reviewMd, undefined);
    assert.equal(held.branchPending, undefined);
  }
  const stated = child.forkedFrom?.notInherited ?? [];
  assert.equal(stated.some((l) => l.includes("run's start commit")), false);
  assert.equal(stated.some((l) => l.includes('uncommitted changes')), false);
});

test('a plan built by hand without commitFrom takes the road every fork took before', async () => {
  const { parent, at } = await planningParent('hand built');
  const n = at.get('plan-approved') as number;
  const handBuilt: ForkPlan = { ...(await planFork(parent.targetDir, parent.id, n, {})) };
  delete handBuilt.commitFrom;

  const { state: child, branch } = await commitFork(parent.targetDir, handBuilt);

  assert.ok(branch !== null);
  assert.equal(gitIn(parent.targetDir, 'rev-parse', branch), handBuilt.commit);
  const stored = loadRun(child.targetDir, child.id);
  assert.equal(stored.start, undefined, 'absent means a checkpoint commit, whose child drops the start');
  assert.equal(stored.baselineDue, undefined);
  assert.equal(stored.reviewMd, undefined);
});

// ---- through the loop -------------------------------------------------------

test('a plan-approved fork resumed through the loop starts on its branch and baselines its start', async () => {
  const { parent, at } = await planningParent('through the loop');
  const start = parent.start;
  assert.ok(start !== undefined);
  const plan = await planFork(parent.targetDir, parent.id, at.get('plan-approved') as number, {});
  const { state: child, branch } = await commitFork(parent.targetDir, plan);
  assert.ok(branch !== null);
  const baselinesBefore = markerRuns(parent, 'verification');

  const { calls, err } = await drive(child, cfgFor(child), handlers(child), true);

  assert.equal(err, null, String(err));
  assert.equal(gitIn(parent.targetDir, 'rev-parse', '--abbrev-ref', 'HEAD'), branch, 'checked out its branch');
  const stored = loadRun(child.targetDir, child.id);
  assert.equal(stored.branchPending, undefined);
  assert.ok(calls.includes('implement'), calls.join(', '));
  assert.ok(calls.some((c) => c.startsWith('review')), calls.join(', '));
  assert.equal(stored.baseSha, start.sha, 'the child marked its own base, at the start');
  assert.equal(stored.gateBaseline?.sha, start.sha, 'and attributed its baseline to it');
  assert.equal(stored.gateBaseline?.gates[0]?.status, 'passed');
  assert.equal(stored.baselineDue, undefined, 'the debt is paid');
  assert.ok(markerRuns(parent, 'verification') > baselinesBefore, 'the gate actually ran');
});

// ---- the listing ------------------------------------------------------------

async function listed(state: RunState): Promise<string[]> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  console.error = () => undefined;
  try {
    const code = await main(['fork', state.id, '-C', state.targetDir]);
    assert.equal(code, EXIT.ERROR, 'a listing exits non-zero, as it always has');
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return lines;
}

test('the listing shows a planning checkpoint with a start as forkable there, and one without as no commit', async () => {
  // A full run with commits, so committed rows sit beside the planning one.
  const parent = freshRun({ prefix: 'vibe-fork-plan-list-', task: 'listing', planOnly: false, git: true, commit: true });
  const cfg = cfgFor(parent);
  commitTree(parent);
  const { err } = await drive(parent, cfg, {
    claude: (label) => {
      if (label === 'plan' || label.startsWith('revise')) return planFixture();
      work(parent, `${label}.txt`);
      return `did ${label}`;
    },
  });
  assert.equal(err, null, String(err));
  const start = parent.start;
  assert.ok(start !== undefined);

  const points = listForkPoints(parent.targetDir, parent.id);
  const approved = points.find((p) => p.meta?.boundary === 'plan-approved');
  assert.ok(approved !== undefined);
  assert.deepEqual(approved.start, start);
  const committed = points.filter((p) => p.meta?.commit != null);
  assert.ok(committed.length > 0);
  for (const p of committed) assert.equal('start' in p, false, `committed row ${p.n} names no start`);
  for (const p of points.filter((q) => q.meta?.boundary === 'complete')) {
    assert.equal('start' in p, false, 'the end of a run is not planning');
  }

  const row = (lines: string[], n: number): string =>
    lines.find((l) => l.startsWith(`  ${String(n).padStart(3)}  `)) ?? '';
  let lines = await listed(parent);
  assert.match(row(lines, approved.n), new RegExp(`start ${start.sha.slice(0, 7)}$`));
  for (const p of committed) {
    assert.match(row(lines, p.n), new RegExp(`${String(p.meta?.commit).slice(0, 7)}$`));
  }

  rewrite(parent, approved.n, (s) => {
    const out = { ...s };
    delete out['start'];
    return out;
  });
  assert.equal('start' in (listForkPoints(parent.targetDir, parent.id).find((p) => p.n === approved.n) ?? {}), false);
  lines = await listed(parent);
  assert.match(row(lines, approved.n), /no commit \(no-commit-in-round\)$/);
});
