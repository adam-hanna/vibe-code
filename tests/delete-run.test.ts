import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession } from '@src/serve.js';
import { LOCK_FILE } from '@src/lock.js';
import { deleteRun, RUNS_DIR } from '@src/run.js';
import { StoredStateError } from '@src/stored.js';
import { freshRun } from './helpers/loop-harness.js';
import { linkDir, JUNCTION_SKIP } from './helpers/links.js';
import { absentPid } from './helpers/pids.js';
import type { Outbound } from '@src/protocol.js';

/**
 * Taking a run out of the archive (#223).
 *
 * **The first thing in the product that destroys a run**, and the whole of this
 * file is the four questions that have to be answered before the `rmSync`. It
 * exists because a sidebar grew a `−` on every row: *"I should be able to delete
 * a run, and a project… There needs to be a confirmation window that shows up so
 * i dont accidentally delete something."*
 *
 * The confirmation is the window's half and is not what is tested here. This is
 * the half that matters when the confirmation is wrong, mis-clicked or absent —
 * the guards are in the core, because the core is the process holding the
 * filesystem, and a window is not a permission boundary.
 *
 * The four are not one rule with four spellings:
 *
 * - **An id that would escape `.vibe/runs`** is refused lexically, by the same
 *   `assertUsableRunId` the two reads go through. `runDirFor` is shared rather
 *   than repeated for exactly this: a delete with its own copy of the check is a
 *   delete whose check can fall behind.
 * - **A run directory that is a link** is refused before anything writes through
 *   it (#53). This matters more here than anywhere else in `run.ts` — following
 *   a junction to delete *recursively* is the worst thing this process could be
 *   talked into doing — and it is the same predicate that already refuses to
 *   read through one.
 * - **A live run** is refused. `livenessOf` is the verdict rather than a
 *   re-derivation, so there is no second definition of what *running* means.
 * - **A run whose lock cannot be read** is refused too, which is `src/lock.ts`'s
 *   own fail-closed rule applied to a stronger act: a lock it could not read
 *   *cannot rule out* a live process.
 *
 * And one thing that is deliberately allowed: `interrupted` — a dead pid still
 * holding a lock — is exactly the wreck somebody is trying to clear out, so a
 * guard that refused it would refuse the main case.
 */

/** A run with a directory of its own, and the repository it lives in. */
function aRun(): { repo: string; id: string; dir: string } {
  const state = freshRun({ prefix: 'vibe-delete-run-', task: 'delete me' });
  writeFileSync(path.join(state.dir, 'PLAN.md'), '# a plan', 'utf8');
  return { repo: state.targetDir, id: state.id, dir: state.dir };
}

/** A lock naming a pid, on this host — which is what makes it probeable. */
function lockWith(dir: string, pid: number): void {
  writeFileSync(
    path.join(dir, LOCK_FILE),
    JSON.stringify({
      pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      id: path.basename(dir),
      token: 'delete-run-test',
    }),
    'utf8',
  );
}

// ---- what it removes --------------------------------------------------------

test('a run with no lock is removed, directory and all', () => {
  const { repo, id, dir } = aRun();
  assert.ok(existsSync(path.join(dir, 'PLAN.md')), 'the fixture did not write its plan');

  const gone = deleteRun(repo, id);

  assert.equal(gone.runId, id);
  assert.equal(gone.dir, dir);
  assert.equal(existsSync(dir), false, 'the run directory survived');
  // The archive root is not touched. A delete that took `.vibe/runs` with it
  // would take every sibling run, which is the failure nobody would attribute
  // to the row they clicked.
  assert.ok(existsSync(path.join(repo, RUNS_DIR)), 'the runs root went with it');
});

test('a run that has already gone is not an error', () => {
  // `force`, deliberately: the caller asked for it to be absent and it is. A
  // second press of a confirm button must not produce a refusal describing a
  // state that is what was wanted.
  const { repo, id } = aRun();
  deleteRun(repo, id);
  assert.doesNotThrow(() => deleteRun(repo, id));
});

test('a dead pid still holding a lock is exactly the run this clears out', () => {
  // `interrupted` — #131's signature for terminated-from-outside. Refusing it
  // would refuse the main case: the run somebody wants to delete is usually the
  // one whose host was killed.
  const { repo, id, dir } = aRun();
  lockWith(dir, absentPid());

  assert.doesNotThrow(() => deleteRun(repo, id));
  assert.equal(existsSync(dir), false);
});

// ---- what it refuses --------------------------------------------------------

test('a run whose lock names a live process is refused, and nothing is removed', () => {
  const { repo, id, dir } = aRun();
  // This process, which is alive by construction — no probe to race.
  lockWith(dir, process.pid);

  assert.throws(
    () => deleteRun(repo, id),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError);
      assert.match(err.message, /is running/);
      // The refusal has to say that nothing happened. A sentence naming only
      // the problem leaves a person guessing whether half of it went.
      assert.match(err.message, /Nothing was deleted/);
      return true;
    },
  );
  assert.ok(existsSync(dir), 'the run was deleted under a live lock');
  assert.ok(existsSync(path.join(dir, 'PLAN.md')), 'the run lost files under a live lock');
});

test('a lock this process cannot make sense of refuses too, and says which it is', () => {
  // `unknown`, not `not-running`. `src/lock.ts` keeps those apart precisely so
  // an unreadable lock cannot license a second writer, and deleting is a
  // stronger act than writing — so it inherits the refusal rather than an
  // exemption from it.
  const { repo, id, dir } = aRun();
  writeFileSync(path.join(dir, LOCK_FILE), 'not json at all', 'utf8');

  assert.throws(
    () => deleteRun(repo, id),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError);
      assert.match(err.message, /cannot tell whether anything is still working on it/);
      assert.match(err.message, /Nothing was deleted/);
      // The two refusals must not read the same. One says stop the run; the
      // other says vibe could not find out — different next actions.
      assert.doesNotMatch(err.message, /is running:/);
      return true;
    },
  );
  assert.ok(existsSync(dir), 'the run was deleted under an unreadable lock');
});

test('a run id that would escape the runs root is refused before anything is joined', () => {
  const { repo } = aRun();
  for (const bad of ['../..', 'a/b', '..\\..', 'run.']) {
    assert.throws(() => deleteRun(repo, bad), StoredStateError, `${bad} was joined onto a path`);
  }
});

test('a run directory that is a link is refused, and the link survives', (t) => {
  // #53's rule, on the one path where following a link would be recursive. The
  // target is where the evidence is: a delete that followed would take a
  // directory nobody named.
  const { repo, dir } = aRun();
  const target = path.join(path.dirname(dir), 'the-real-target');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'keep.txt'), 'not yours to delete', 'utf8');

  const at = path.join(repo, RUNS_DIR, 'linked-run');
  if (!linkDir(target, at)) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  assert.throws(
    () => deleteRun(repo, 'linked-run'),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError);
      assert.match(err.message, /symlink or a junction/);
      return true;
    },
  );
  assert.equal(
    readFileSync(path.join(target, 'keep.txt'), 'utf8'),
    'not yours to delete',
    'the delete followed the link',
  );
});

// ---- over the wire ----------------------------------------------------------

/** A session whose frames are collected, with nothing answering them. */
function collecting(): { sent: Outbound[]; session: ReturnType<typeof createSession> } {
  const sent: Outbound[] = [];
  return {
    sent,
    session: createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) }),
  };
}

test('a delete is answered with the directory that is gone', () => {
  const { repo, id, dir } = aRun();
  const { sent, session } = collecting();
  session.receive(JSON.stringify({ type: 'delete_run', id: 1, dir: repo, runId: id }));

  const frame = sent[0];
  assert.equal(frame?.type, 'run_deleted');
  assert.equal(frame.type === 'run_deleted' ? frame.runId : null, id);
  assert.equal(frame.type === 'run_deleted' ? frame.removed : null, dir);
  assert.equal(existsSync(dir), false);
});

test('a refusal reaches the sender as an error carrying the core sentence', () => {
  // The throw IS the answer. A window told only *"could not delete"* cannot
  // choose between stopping the run and looking at a link, and those are the
  // two things it might have been.
  const { repo, id, dir } = aRun();
  lockWith(dir, process.pid);
  const { sent, session } = collecting();
  session.receive(JSON.stringify({ type: 'delete_run', id: 2, dir: repo, runId: id }));

  const frame = sent[0];
  assert.equal(frame?.type, 'error');
  assert.match(frame.type === 'error' ? frame.message : '', /is running/);
  assert.ok(existsSync(dir));
});

test('a frame with no dir is refused by the decoder, not resolved to the host cwd', () => {
  // The same check `artifacts` and `artifact` get, and it is shared with them
  // for the reason the decoder states: an empty `dir` would resolve to wherever
  // this process was spawned, which for a delete is a *different repository's*
  // run removed successfully.
  const { sent, session } = collecting();
  session.receive(JSON.stringify({ type: 'delete_run', id: 3, dir: '', runId: 'x' }));
  session.receive(JSON.stringify({ type: 'delete_run', id: 4, dir: 'C:/repo' }));

  assert.equal(sent[0]?.type, 'error');
  assert.match(sent[0]?.type === 'error' ? sent[0].message : '', /no dir/);
  assert.equal(sent[1]?.type, 'error');
  assert.match(sent[1]?.type === 'error' ? sent[1].message : '', /no runId/);
});

test('a delete is answered beside a run, because the run in flight is the one it cannot reach', () => {
  // Not an exemption granted on the strength of being small. What makes this
  // safe beside a run is the live-lock refusal above: the running run is the one
  // run this frame can never delete, and every other entry is inert.
  const { repo, id, dir } = aRun();
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    // Never settles, so the session is genuinely mid-run while the delete lands.
    invoke: () => new Promise<number>(() => undefined),
  });
  session.receive(JSON.stringify({ type: 'invoke', id: 1, argv: ['run', 'something'] }));
  session.receive(JSON.stringify({ type: 'delete_run', id: 2, dir: repo, runId: id }));

  assert.ok(
    sent.some((f) => f.type === 'run_deleted'),
    `the delete was not answered while a run was going: ${sent.map((f) => f.type).join(', ')}`,
  );
  assert.equal(existsSync(dir), false);
});
