import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createRun,
  linkedCheckpointReason,
  listCheckpoints,
  writeCheckpoint,
} from '@src/run.js';
import { ForkError, listForkPoints, planFork } from '@src/fork.js';
import type { RunState } from '@src/types.js';
import { FILE_LINK_SKIP, linkFile } from './helpers/links.js';

/**
 * A checkpoint inside an accepted run directory that is a link out of the
 * archive (#102).
 *
 * #53 closed the run **entry** and its `state.json` and said, at the time, that
 * files inside an entry already accepted are the same hole one level deeper. A
 * checkpoint is the one that matters most: it *becomes* a run - `planFork` puts
 * it through `loadRun`'s validators and `commitFork` inherits it under a new
 * identity - and `loadRun` quotes field contents back in its refusals, so a link
 * pointing at an arbitrary file can put that file's bytes in a terminal.
 *
 * A FILE symlink, not a junction: junctions point only at directories, so on
 * Windows this shape needs Developer Mode or Administrator where the entry
 * vector needs neither. That asymmetry is exactly why this was a smaller vector
 * than #53's and not a closed one - and it does not exist on POSIX at all. Every
 * case here skips with a stated reason rather than passing silently.
 */

const OUTSIDE = 'SECRET-MUST-NOT-BE-READ';

interface Fixture {
  state: RunState;
  targetDir: string;
  /** A file outside the archive that a link would reach. */
  secret: string;
}

function fixture(): Fixture {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-linked-cp-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'vibe-linked-cp-outside-'));
  const state = createRun(targetDir, 'linked checkpoint', false);
  state.plan = {
    plan_md: '# the plan',
    assumptions: [],
    open_questions: [],
    out_of_scope: [],
    acceptance_criteria: [],
  };

  // A file that WOULD read as a perfectly good checkpoint. That is the point: if
  // anything opens it, `meta` comes back non-null and the case fails - so "it was
  // not read" is proved by a positive, not by an absence.
  const secret = path.join(outside, 'SECRET.json');
  writeFileSync(
    secret,
    JSON.stringify({
      ...state,
      checkpoint: {
        n: 1,
        boundary: 'plan-round',
        phase: 'planning',
        planRound: 0,
        reviewRound: 0,
        verifyRound: 0,
        commit: null,
        commitNote: 'no-commit-in-round',
        at: new Date().toISOString(),
        marker: OUTSIDE,
      },
    }),
    'utf8',
  );
  return { state, targetDir, secret };
}

/** Put a link where `checkpoint-<n>.json` would be. False if this box cannot. */
function linkCheckpoint(f: Fixture, n: number): boolean {
  return linkFile(f.secret, path.join(f.state.dir, `checkpoint-${n}.json`));
}

// ---- the predicate ----------------------------------------------------------

test('an ordinary checkpoint, and a missing one, are not refused', () => {
  const f = fixture();
  writeCheckpoint(f.state, 'plan-round', { sha: null, note: 'no-commit-in-round' });

  assert.equal(linkedCheckpointReason(f.state.dir, 1), null);
  assert.equal(linkedCheckpointReason(f.state.dir, 99), null);
});

test('a linked checkpoint is refused, and the sentence says nothing was read', (t) => {
  const f = fixture();
  if (!linkCheckpoint(f, 1)) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  const why = linkedCheckpointReason(f.state.dir, 1);
  assert.match(String(why), /checkpoint-1\.json/);
  assert.match(String(why), /symlink or a junction/);
  assert.match(String(why), /Nothing was read and nothing was written/);
  // The bytes behind it never appear in what a user is shown.
  assert.doesNotMatch(String(why), new RegExp(OUTSIDE));
});

// ---- the listing ------------------------------------------------------------

test('listCheckpoints reports a linked entry without opening it', (t) => {
  const f = fixture();
  if (!linkCheckpoint(f, 1)) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  const listed = listCheckpoints(f.state.dir);

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.n, 1);
  assert.equal(listed[0]?.linked, true);
  // Null because it was never opened - not because opening it failed. The file
  // behind the link is a valid checkpoint, so a read would have produced meta.
  assert.equal(listed[0]?.meta, null);
});

test('an ordinary checkpoint beside a linked one is unaffected', (t) => {
  const f = fixture();
  if (!linkCheckpoint(f, 1)) {
    t.skip(FILE_LINK_SKIP);
    return;
  }
  // Reservation skips 1 - `openSync(..., 'wx')` refuses a name that exists, link
  // or not - so this lands at 2, which is the behaviour that matters: a link
  // cannot make the run stop checkpointing.
  const written = writeCheckpoint(f.state, 'plan-round', { sha: null, note: 'no-commit-in-round' });

  const listed = listCheckpoints(f.state.dir).sort((a, b) => a.n - b.n);
  assert.equal(written?.n, 2);
  assert.equal(listed[0]?.linked, true);
  assert.equal(listed[1]?.n, 2);
  assert.equal(listed[1]?.linked, undefined);
  assert.equal(listed[1]?.meta?.boundary, 'plan-round');
});

test('no write reaches the target of a linked checkpoint', (t) => {
  const f = fixture();
  const before = readFileSync(f.secret, 'utf8');
  if (!linkCheckpoint(f, 1)) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  writeCheckpoint(f.state, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  writeCheckpoint(f.state, 'plan-round', { sha: null, note: 'no-commit-in-round' });

  assert.equal(readFileSync(f.secret, 'utf8'), before, 'the file outside the archive is untouched');
});

// ---- fork -------------------------------------------------------------------

test('listForkPoints carries the fact that a point was not read', (t) => {
  const f = fixture();
  if (!linkCheckpoint(f, 1)) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  const points = listForkPoints(f.targetDir, f.state.id);

  assert.deepEqual(points, [{ n: 1, meta: null, linked: true }]);
});

test('planFork refuses a linked checkpoint by name, before anything is read', async (t) => {
  const f = fixture();
  if (!linkCheckpoint(f, 1)) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  await assert.rejects(
    () => planFork(f.targetDir, f.state.id, 1, {}),
    (err: unknown) => {
      assert.ok(err instanceof ForkError, `expected a ForkError, got ${String(err)}`);
      assert.match(err.message, /Checkpoint 1 cannot be used/);
      assert.match(err.message, /checkpoint-1\.json/);
      assert.doesNotMatch(err.message, new RegExp(OUTSIDE), 'and quotes nothing from behind it');
      return true;
    },
  );

  // Refused, not merely failed: no child run was allocated on the way.
  const runs = readdirSync(path.join(f.targetDir, '.vibe', 'runs'));
  assert.deepEqual(runs, [f.state.id]);
});

test('a real checkpoint beside a linked one still forks', async (t) => {
  const f = fixture();
  if (!linkCheckpoint(f, 1)) {
    t.skip(FILE_LINK_SKIP);
    return;
  }
  const written = writeCheckpoint(f.state, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  assert.equal(written?.n, 2);

  const plan = await planFork(f.targetDir, f.state.id, 2, { git: { useBranch: false } });

  assert.equal(plan.meta.n, 2);
  assert.equal(plan.source.id, f.state.id);
});

// ---- and a run with no links is exactly as it was ---------------------------

test('an ordinary run lists its checkpoints with no linked flag at all', () => {
  const f = fixture();
  mkdirSync(path.join(f.state.dir, 'not-a-checkpoint'), { recursive: true });
  writeCheckpoint(f.state, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  writeCheckpoint(f.state, 'complete', { sha: null, note: 'no-commit-in-round' });

  const listed = listCheckpoints(f.state.dir);

  assert.deepEqual(
    listed.map((c) => c.n),
    [1, 2],
  );
  assert.ok(listed.every((c) => c.linked === undefined && c.meta !== null));
});
