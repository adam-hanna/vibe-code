import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { commitFork, ForkError, listForkPoints, planFork } from '@src/fork.js';
import { orchestrate } from '@src/orchestrator.js';
import { artifact, listCheckpoints, listRuns, loadRun, mintRunId, saveState } from '@src/run.js';
import { StoredStateError } from '@src/stored.js';
import { renderPlanDoc } from '@src/prompts.js';
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
 * `vibe fork <run-id> --at <n>` (#78).
 *
 * The properties these cases exist to hold, in the order they matter:
 *
 * - **The working tree is not touched.** The fork creates a branch REF and
 *   stops; HEAD, the index and the user's uncommitted work are exactly as they
 *   were. That is what makes the parent still resumable a moment later.
 * - **The parent's directory is byte-identical afterwards**, successful fork or
 *   refused one, and no lock is ever written into it.
 * - **Every refusal creates nothing** - no run directory, no lock, no branch.
 * - **Nothing reads the lineage.** `forkedFrom` is a provenance record; the case
 *   that edits it to nonsense and watches the run behave identically is the one
 *   that would fail if a derived figure ever crept back in.
 */

const FORK = { prefix: 'vibe-fork-', task: 'forking' } as const;

/** A finished run with checkpoints and commits, in a real repo. */
async function parentRun(task = 'forking'): Promise<RunState> {
  const state = freshRun({ ...FORK, task, planOnly: false, git: true, commit: true });
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

const runsRoot = (state: RunState): string => path.join(state.targetDir, '.vibe', 'runs');

function runDirs(state: RunState): string[] {
  return readdirSync(runsRoot(state)).sort();
}

/** sha256 of every file in a directory, so "byte-identical" is an observation. */
function fingerprint(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const rel = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(dir, '');
  return out;
}

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The checkpoint with a commit, which is the one a branching fork can use. */
function committedPoint(state: RunState): number {
  const found = listCheckpoints(state.dir).find((c) => c.meta?.commit != null);
  assert.ok(found !== undefined, 'the parent recorded a checkpoint with a commit');
  return found.n;
}

async function fork(state: RunState, n: number, overrides = {}): Promise<{ child: RunState; branch: string | null }> {
  const plan = await planFork(state.targetDir, state.id, n, overrides);
  const result = await commitFork(state.targetDir, plan);
  return { child: result.state, branch: result.branch };
}

// ---- what the child is ------------------------------------------------------

test('the child is the checkpoint, under a new identity', async () => {
  const parent = await parentRun('is the checkpoint');
  const n = committedPoint(parent);
  const snapshot = JSON.parse(
    readFileSync(path.join(parent.dir, `checkpoint-${n}.json`), 'utf8'),
  ) as RunState;

  const { child } = await fork(parent, n);

  assert.notEqual(child.id, parent.id);
  assert.equal(child.task, snapshot.task);
  assert.equal(child.phase, snapshot.phase);
  assert.equal(child.status, snapshot.status);
  assert.equal(child.baseSha, snapshot.baseSha);
  assert.deepEqual(child.p1Rounds, snapshot.p1Rounds);
  // Carried verbatim, ceilings included: a fork's totals are the checkpoint's
  // plus whatever it goes on to spend, which is what its own ceilings read.
  assert.equal(child.tokensUsed, snapshot.tokensUsed);
  assert.equal(child.costUsd, snapshot.costUsd);
  assert.equal(child.checkpoint?.n, n, 'it remembers which snapshot it came from');
  // A brand-new Claude session, not the parent's: two runs writing turns into
  // one conversation is exactly what forking exists to avoid.
  assert.notEqual(child.sessionId, snapshot.sessionId);
  assert.equal(child.sessionStarted, false);
});

test('forkedFrom records the checkpoint verbatim', async () => {
  const parent = await parentRun('lineage');
  const n = committedPoint(parent);
  const snapshot = JSON.parse(
    readFileSync(path.join(parent.dir, `checkpoint-${n}.json`), 'utf8'),
  ) as RunState;

  const { child } = await fork(parent, n);
  const origin = child.forkedFrom;
  assert.ok(origin !== undefined);
  assert.equal(origin.runId, parent.id);
  assert.equal(origin.checkpoint, n);
  assert.equal(origin.inheritedTokens, snapshot.tokensUsed);
  assert.equal(origin.inheritedCostUsd, snapshot.costUsd);
  assert.equal(origin.boundary, snapshot.checkpoint?.boundary);
  assert.equal(origin.branchFrom, snapshot.checkpoint?.commit);
});

test('an all-Claude checkpoint forks with inheritedCodexTokens absent, never zero', async () => {
  const parent = await parentRun('no codex share');
  const n = committedPoint(parent);
  const file = path.join(parent.dir, `checkpoint-${n}.json`);
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  // A checkpoint with no recorded Codex share. Every loop fixture runs a Codex
  // critic, so this is written rather than produced - the point is what the fork
  // does with the ABSENCE, which is to carry it as an absence.
  delete snapshot['codexTokens'];
  writeFileSync(file, JSON.stringify(snapshot), 'utf8');

  const { child } = await fork(parent, n, { git: { useBranch: false } });
  const origin = child.forkedFrom;
  assert.ok(origin !== undefined);
  assert.equal('inheritedCodexTokens' in origin, false, 'absent, and not defaulted to 0');
  // And it survives a round trip: absence is preserved on disk, not filled in.
  const reloaded = loadRun(child.targetDir, child.id);
  assert.equal('inheritedCodexTokens' in (reloaded.forkedFrom ?? {}), false);
});

test('nothing reads the lineage: nonsense in forkedFrom changes no behaviour', async () => {
  const parent = await parentRun('nothing reads it');
  const { child } = await fork(parent, committedPoint(parent), { git: { useBranch: false } });

  const before = loadRun(child.targetDir, child.id);
  const beforeTokens = before.tokensUsed;

  // Figures no accounting could produce. If any ceiling, guard or summary ever
  // computed from lineage, this is where it would go wrong.
  const state = loadRun(child.targetDir, child.id);
  assert.ok(state.forkedFrom !== undefined);
  state.forkedFrom.inheritedTokens = 999_999_999;
  state.forkedFrom.inheritedCostUsd = 12_345;
  state.forkedFrom.inheritedCodexTokens = 888_888_888;
  saveState(state);

  const after = loadRun(child.targetDir, child.id);
  assert.equal(after.tokensUsed, beforeTokens, 'the run enforces its ceilings on its own totals');
  assert.equal(after.costUsd, before.costUsd);
});

// ---- what the fork does not touch -------------------------------------------

test('the working tree is untouched, even a dirty one', async () => {
  const parent = await parentRun('untouched tree');
  // Deliberately dirty: the fork has no reason to look at the tree, let alone
  // move it, so there is nothing here for it to sweep or refuse over.
  writeFileSync(path.join(parent.targetDir, 'uncommitted.txt'), 'in progress\n', 'utf8');

  const head = gitIn(parent.targetDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const status = gitIn(parent.targetDir, 'status', '--porcelain');

  const { branch } = await fork(parent, committedPoint(parent));

  assert.equal(gitIn(parent.targetDir, 'rev-parse', '--abbrev-ref', 'HEAD'), head);
  assert.equal(gitIn(parent.targetDir, 'status', '--porcelain'), status);
  assert.ok(branch !== null);
  // The ref exists, at the checkpoint's commit, and is not what is checked out.
  const meta = listCheckpoints(parent.dir).find((c) => c.n === committedPoint(parent))?.meta;
  assert.equal(gitIn(parent.targetDir, 'rev-parse', branch), meta?.commit);
  assert.notEqual(head, branch);
});

test("the parent's directory is byte-identical afterwards, and takes no lock", async () => {
  const parent = await parentRun('parent untouched');
  const before = fingerprint(parent.dir);

  await fork(parent, committedPoint(parent));

  assert.deepEqual([...fingerprint(parent.dir)].sort(), [...before].sort());
  assert.equal(existsSync(path.join(parent.dir, 'run.lock')), false);
});

test('a refused fork leaves the parent byte-identical too', async () => {
  const parent = await parentRun('refusal untouched');
  const before = fingerprint(parent.dir);
  const dirs = runDirs(parent);

  await assert.rejects(() => fork(parent, 999), ForkError);

  assert.deepEqual([...fingerprint(parent.dir)].sort(), [...before].sort());
  assert.deepEqual(runDirs(parent), dirs, 'and creates no run directory');
});

// ---- refusals ---------------------------------------------------------------

test('a live parent is refused, and nothing is created', async () => {
  const parent = await parentRun('live parent');
  writeFileSync(
    path.join(parent.dir, 'run.lock'),
    JSON.stringify({ pid: process.pid, host: 'localhost', startedAt: new Date().toISOString(), id: parent.id }),
    'utf8',
  );
  const dirs = runDirs(parent);

  await assert.rejects(() => fork(parent, committedPoint(parent)), /cannot be forked/);
  assert.deepEqual(runDirs(parent), dirs);
});

test('a checkpoint that needed a repair is refused', async () => {
  const parent = await parentRun('needs repair');
  const n = committedPoint(parent);
  const file = path.join(parent.dir, `checkpoint-${n}.json`);
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  // `contextRatio` is repaired to 0 by the validator rather than refused, which
  // is exactly the case a fork must decline: a resume repairs what it must, a
  // fork would be copying the correction forward under a new identity.
  snapshot['contextRatio'] = 'not a ratio';
  writeFileSync(file, JSON.stringify(snapshot), 'utf8');

  const dirs = runDirs(parent);
  await assert.rejects(() => fork(parent, n), /needed 1 field\(s\) repaired/);
  assert.deepEqual(runDirs(parent), dirs);
});

test('a checkpoint with no metadata, or a mismatched n, is refused', async () => {
  const parent = await parentRun('no metadata');
  const n = committedPoint(parent);
  const file = path.join(parent.dir, `checkpoint-${n}.json`);
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

  const without = { ...snapshot };
  delete without['checkpoint'];
  writeFileSync(file, JSON.stringify(without), 'utf8');
  await assert.rejects(() => fork(parent, n), /carries no checkpoint metadata/);

  const meta = { ...(snapshot['checkpoint'] as Record<string, unknown>), n: n + 40 };
  writeFileSync(file, JSON.stringify({ ...snapshot, checkpoint: meta }), 'utf8');
  await assert.rejects(() => fork(parent, n), /says it is checkpoint/);
});

test('a commit that does not resolve to itself is refused', async () => {
  const parent = await parentRun('bad commit');
  const n = committedPoint(parent);
  const file = path.join(parent.dir, `checkpoint-${n}.json`);
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const meta = snapshot['checkpoint'] as Record<string, unknown>;

  // A well-formed 40-hex id this repository has never heard of. An abbreviation
  // or a branch name cannot even get this far - the reader drops the metadata.
  writeFileSync(
    file,
    JSON.stringify({ ...snapshot, checkpoint: { ...meta, commit: 'a'.repeat(40) } }),
    'utf8',
  );
  const dirs = runDirs(parent);
  await assert.rejects(() => fork(parent, n), /cannot resolve/);
  assert.deepEqual(runDirs(parent), dirs);
});

test('a checkpoint with no commit refuses when a branch is wanted, and says which have one', async () => {
  const parent = await parentRun('no commit here');
  const withoutCommit = listCheckpoints(parent.dir).find((c) => c.meta?.commit == null);
  assert.ok(withoutCommit !== undefined, 'a plan-side boundary records no commit');

  await assert.rejects(() => fork(parent, withoutCommit.n), /recorded no commit/);
  await assert.rejects(() => fork(parent, withoutCommit.n), /--no-branch/);
});

test('--no-branch proceeds where the branch requirement refuses, and records branch: null', async () => {
  const parent = await parentRun('no branch');
  const withoutCommit = listCheckpoints(parent.dir).find((c) => c.meta?.commit == null);
  assert.ok(withoutCommit !== undefined);

  const { child, branch } = await fork(parent, withoutCommit.n, { git: { useBranch: false } });
  assert.equal(branch, null);
  assert.equal(child.branch, null);
  assert.equal(child.branchPending, undefined, 'there is no branch to be put on');
  assert.ok((child.forkedFrom?.notInherited ?? []).some((l) => l.includes('--no-branch')));
});

const gitHas = (cwd: string, branch: string): boolean => {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

test('an existing branch of the derived name refuses when branching', async () => {
  const parent = await parentRun('branch collision');
  const n = committedPoint(parent);

  // The branch name is `branchPrefix` + the id `commitFork` claims, and that id
  // carries a second-resolution stamp - so it cannot be known in advance, only
  // guessed at inside the same second. Rather than race the clock (which is how
  // AGENTS.md's banned wall-clock fixtures get written), a guess that turns out
  // to have missed is treated as INCONCLUSIVE and retried: the fork succeeded,
  // so its run and its branch are removed and the next attempt starts clean.
  // The case fails only if it never once observed the refusal.
  for (let attempt = 0; attempt < 8; attempt++) {
    const branch = `vibe/${mintRunId(parent.task)}`;
    if (gitHas(parent.targetDir, branch)) continue;
    execFileSync('git', ['branch', branch, 'HEAD'], { cwd: parent.targetDir });

    const dirs = runDirs(parent);
    const outcome = await fork(parent, n).then(
      (ok) => ok,
      (err: unknown) => err,
    );

    if (outcome instanceof ForkError) {
      assert.match(outcome.message, /already exists/);
      assert.deepEqual(runDirs(parent), dirs, 'the refusal creates no run directory');
      assert.ok(gitHas(parent.targetDir, branch), 'and does not delete the branch it found');

      // With no branch wanted, that ref is nothing to do with this fork: it
      // will not be read, written or moved, so it is not a reason to refuse.
      const { branch: none } = await fork(parent, n, { git: { useBranch: false } });
      assert.equal(none, null);
      return;
    }

    // Inconclusive: the second rolled over, so the fork derived a different
    // name and went ahead. Undo it and guess again.
    assert.ok(!(outcome instanceof Error), `unexpected failure: ${String(outcome)}`);
    const made = outcome as { child: RunState; branch: string | null };
    rmSync(made.child.dir, { recursive: true, force: true });
    if (made.branch !== null) {
      execFileSync('git', ['branch', '-D', made.branch], { cwd: parent.targetDir });
    }
    execFileSync('git', ['branch', '-D', branch], { cwd: parent.targetDir });
  }
  assert.fail('never landed a branch in the way of the derived name');
});

test('an unvalidatable stored config refuses with nothing created', async () => {
  const parent = await parentRun('bad config');
  const n = committedPoint(parent);
  const file = path.join(parent.dir, `checkpoint-${n}.json`);
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  // A stored config `validateStoredState` deliberately does not check - it is
  // the one field left to the path that uses it - carrying a value `validate`
  // refuses. The fork must find that out before it creates anything.
  writeFileSync(
    file,
    JSON.stringify({ ...snapshot, config: { loop: { maxPlanRounds: -3 } } }),
    'utf8',
  );

  const dirs = runDirs(parent);
  await assert.rejects(() => fork(parent, n));
  assert.deepEqual(runDirs(parent), dirs, 'the config is resolved before anything is created');
});

// ---- path safety ------------------------------------------------------------

test('a traversing id is refused before any path is built, on both entry points', async () => {
  const parent = await parentRun('paths');
  assert.throws(() => listForkPoints(parent.targetDir, '../other'), StoredStateError);
  await assert.rejects(() => planFork(parent.targetDir, '../other', 1, {}), StoredStateError);
  await assert.rejects(() => planFork(parent.targetDir, `${parent.id}.`, 1, {}), StoredStateError);
});

// ---- artifacts --------------------------------------------------------------

test('the forked PLAN.md is the whole plan, not bare plan_md', async () => {
  const parent = await parentRun('whole plan');
  const { child } = await fork(parent, committedPoint(parent));

  const doc = readFileSync(path.join(child.dir, 'PLAN.md'), 'utf8');
  assert.ok(child.plan !== null);
  assert.equal(doc, renderPlanDoc(child.plan));
  assert.ok(doc.includes('## Out of scope'));
  assert.ok(doc.includes('## Acceptance criteria'));
});

test('a last report the parent no longer has is dropped, and the loss is stated', async () => {
  const parent = await parentRun('missing report');
  const n = committedPoint(parent);
  const snapshot = JSON.parse(
    readFileSync(path.join(parent.dir, `checkpoint-${n}.json`), 'utf8'),
  ) as RunState;
  assert.equal(snapshot.lastReport, 'implementation-report.md');
  rmSync(path.join(parent.dir, 'implementation-report.md'));

  const plan = await planFork(parent.targetDir, parent.id, n, {});
  const result = await commitFork(parent.targetDir, plan);
  assert.equal(result.state.lastReport, undefined, 'never a pointer to a file that is not there');
  assert.ok(result.losses.some((l) => l.includes('implementation-report.md')));
});

test('a report the parent does have is copied', async () => {
  const parent = await parentRun('copied report');
  const n = committedPoint(parent);
  const { child } = await fork(parent, n);
  if (child.lastReport !== undefined) {
    assert.ok(existsSync(path.join(child.dir, child.lastReport)), 'copied, not merely pointed at');
    assert.equal(
      readFileSync(path.join(child.dir, child.lastReport), 'utf8'),
      readFileSync(path.join(parent.dir, child.lastReport), 'utf8'),
    );
  }
});

test('a checkpoint naming a reserved file as its report copies nothing', async () => {
  const parent = await parentRun('reserved pointer');
  const n = committedPoint(parent);
  const file = path.join(parent.dir, `checkpoint-${n}.json`);
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...snapshot, lastReport: 'state.json' }), 'utf8');

  // Dropped by the reader, which the fork's zero-repair bar then refuses on -
  // so the pointer never becomes a path, whichever way you come at it.
  await assert.rejects(() => fork(parent, n), /repaired/);
});

// ---- the listing ------------------------------------------------------------

test('listRuns is safe over a fork, a malformed forkedFrom and a damaged checkpoint', async () => {
  const parent = await parentRun('listing');
  const { child } = await fork(parent, committedPoint(parent));

  writeFileSync(path.join(child.dir, 'checkpoint-9.json'), '', 'utf8');
  const broken: Record<string, unknown> = { ...loadRun(child.targetDir, child.id) };
  broken['forkedFrom'] = 'not a record';
  saveState(broken as unknown as RunState);

  const listed = listRuns(parent.targetDir);
  assert.ok(listed.length >= 2, 'both runs are listed');
  // The child's own row survives a `forkedFrom` that would refuse on load.
  const row = listed.find((r) => r.id === child.id);
  assert.ok(row !== undefined);
  assert.equal(row.forkedFrom, undefined, 'an unreadable record is simply not rendered');
  // And the refusal is real, on the path that acts on it.
  assert.throws(() => loadRun(child.targetDir, child.id), /forkedFrom/);
});

test('a forked run is labelled in the listing', async () => {
  const parent = await parentRun('labelled');
  const n = committedPoint(parent);
  const { child } = await fork(parent, n);

  const row = listRuns(parent.targetDir).find((r) => r.id === child.id);
  assert.deepEqual(row?.forkedFrom, { runId: parent.id, checkpoint: n });
  const parentRow = listRuns(parent.targetDir).find((r) => r.id === parent.id);
  assert.equal(parentRow?.forkedFrom, undefined, 'a run that is not a fork says nothing');
});

// ---- fork points ------------------------------------------------------------

test('listForkPoints reports what is there, damaged entries included', async () => {
  const parent = await parentRun('fork points');
  writeFileSync(path.join(parent.dir, 'checkpoint-99.json'), '{ broken', 'utf8');

  const points = listForkPoints(parent.targetDir, parent.id);
  assert.ok(points.length >= 2);
  assert.equal(points.at(-1)?.n, 99);
  assert.equal(points.at(-1)?.meta, null);
});

test('a run with no checkpoints has no fork points, and nothing is invented', () => {
  const legacy = freshRun({ ...FORK, task: 'legacy' });
  // `artifact` so the directory looks like a real run without any snapshots.
  artifact(legacy, 'PLAN.md', '# nothing');
  assert.deepEqual(listForkPoints(legacy.targetDir, legacy.id), []);
});

// ---- the kill window --------------------------------------------------------

const HELPER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'helpers',
  'kill-during-save.js',
);

/** Spawn the fork helper and wait for the parent run id it prints. */
function startFork(targetDir: string): Promise<{ child: ChildProcessWithoutNullStreams; parentId: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, targetDir, 'fork'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n')[0] ?? '';
      if (line.startsWith('ready ')) resolve({ child, parentId: line.slice('ready '.length).trim() });
    });
    child.on('exit', (code) => {
      reject(new Error(`helper exited ${String(code)} before saying ready: ${stderr}`));
    });
  });
}

const killed = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  new Promise((resolve) => {
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a commitFork killed at any point leaves a child that is complete or absent', async () => {
  // A real process, killed at points spread across a real `commitFork`. The
  // ordering this guards - artifacts, then the state write, last - cannot be
  // shown by asserting which function was called first; only by stopping the
  // process without unwinding and reading the directory back.
  // Three outcomes are legal and all three are safe: nothing created at all, a
  // directory with no state.json (not a run), or a complete child. The
  // invariant is asserted at every kill point; the two counters below only
  // establish that kills really did land on both sides of the final write, so
  // the case cannot pass by never interrupting anything.
  let sawIncomplete = false;
  let sawComplete = false;

  // Spread wide rather than aimed: the early delays land inside `commitFork`
  // (which validates and rewrites a ~1.1MB state, so it is not instant) and the
  // late ones land after it, and the case asserts it observed both.
  for (const delay of [0, 2, 5, 10, 20, 40, 80, 150, 300, 600, 1200]) {
    const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-fork-kill-'));
    const { child, parentId } = await startFork(targetDir);
    child.stdin.write('go\n');
    await sleep(delay);
    await killed(child);

    const root = path.join(targetDir, '.vibe', 'runs');
    const children = readdirSync(root).filter((id) => id !== parentId);
    // At most one child is ever created, whatever the kill did.
    assert.ok(children.length <= 1, `unexpected directories: ${children.join(', ')}`);

    const listed = listRuns(targetDir).map((r) => r.id);
    if (children.length === 0) sawIncomplete = true;
    for (const id of children) {
      const dir = path.join(root, id);
      const entries = readdirSync(dir);
      if (existsSync(path.join(dir, 'state.json'))) {
        sawComplete = true;
        // Complete: whatever it points at is already on disk beside it.
        const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as RunState;
        assert.ok(existsSync(path.join(dir, 'PLAN.md')), 'a listed child has its plan');
        if (state.lastReport !== undefined) {
          assert.ok(existsSync(path.join(dir, state.lastReport)));
        }
        assert.ok(listed.includes(id), 'and it is a run');
      } else {
        sawIncomplete = true;
        // Absent: not a run, and nothing may present it as one.
        assert.equal(listed.includes(id), false, 'a directory with no state.json is not a run');
      }
      assert.equal(
        entries.some((e) => e.endsWith('.tmp')),
        false,
        `a killed fork left temp litter: ${entries.join(', ')}`,
      );
    }
  }

  // Both sides of the final write have to have been reached, or the case proved
  // only one of them.
  assert.ok(sawComplete, 'no kill landed after the fork completed - widen the delays');
  assert.ok(sawIncomplete, 'no kill landed before the fork completed - narrow the delays');
});

