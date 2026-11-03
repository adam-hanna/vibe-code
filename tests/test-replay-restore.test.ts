import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearCancel, requestCancel } from '@src/cancel.js';
import { execute } from '@src/cli.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { EXIT, orchestrate } from '@src/orchestrator.js';
import { saveState } from '@src/run.js';
import { ReplayRestoreError } from '@src/test-replay.js';
import type { RunState } from '@src/types.js';
import { agents, commitTree, config, report, reviewingRun } from './helpers/loop-harness.js';

/**
 * A replay killed while earlier test versions were swapped in is put back
 * before anything else runs (#486).
 *
 * Every case starts from the layout a dead replay leaves: the earlier version
 * in the tree, the head copy under `test-replay-0/<sha256>.head`, and the
 * marker saved in `state.json`.
 */

const TEST = 'tests/a.test.txt';
const HEAD = 'expect: head\n';
const EARLY = 'expect: early\n';

const sha256 = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function swapped(prefix: string): RunState {
  const state = reviewingRun({ prefix: `vibe-replay-restore-${prefix}-`, task: 'restore', commit: true });
  mkdirSync(path.join(state.targetDir, 'tests'), { recursive: true });
  writeFileSync(path.join(state.targetDir, TEST), HEAD, 'utf8');
  commitTree(state);
  // What the dead process left: the earlier version in place, the head copy in
  // the run directory, and the marker naming both.
  writeFileSync(path.join(state.targetDir, TEST), EARLY, 'utf8');
  mkdirSync(path.join(state.dir, 'test-replay-0'), { recursive: true });
  const backup = `test-replay-0/${sha256(HEAD)}.head`;
  writeFileSync(path.join(state.dir, backup), HEAD, 'utf8');
  state.testReplayInFlight = { round: 0, files: [{ path: TEST, backup, sha256: sha256(HEAD) }] };
  saveState(state);
  return state;
}

const inTree = (state: RunState): string => readFileSync(path.join(state.targetDir, TEST), 'utf8');

function stored(state: RunState): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
}

async function quietly<T>(seen: Narration[], body: () => Promise<T>): Promise<T> {
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await body();
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
}

test('a resume restores every swapped test before prepareGit and before any turn, then clears the marker', async () => {
  const state = swapped('orchestrate');
  const seen: Narration[] = [];
  const calls: string[] = [];
  let atReview: string | null = null;
  await quietly(seen, () =>
    orchestrate(
      state,
      config(),
      true,
      agents(
        {
          codex: () => {
            atReview = inTree(state);
            return report([]);
          },
        },
        calls,
      ),
    ),
  );
  const withId = seen.filter((n) => n.id !== undefined);
  assert.equal(withId[0]?.id, 'test_replay_restored', `first said: ${withId.map((n) => n.id).join(', ')}`);
  assert.deepEqual(withId[0]?.data, { round: 0, files: [TEST] });
  assert.equal(atReview, HEAD, 'the first turn saw the head copy');
  assert.equal(inTree(state), HEAD);
  assert.equal(state.testReplayInFlight, undefined);
  assert.equal('testReplayInFlight' in stored(state), false);
});

/** `execute` with a preflight that records what it saw and stops, and a loop that must not run. */
async function viaExecute(state: RunState): Promise<{ code: number; preflightSaw: string | null; seen: Narration[] }> {
  const seen: Narration[] = [];
  let preflightSaw: string | null = null;
  const code = await quietly(seen, () =>
    execute(
      state,
      config(),
      true,
      true,
      () => {
        preflightSaw = inTree(state);
        return Promise.resolve(EXIT.PREFLIGHT);
      },
      () => assert.fail('the loop must not run'),
    ),
  );
  return { code, preflightSaw, seen };
}

test('execute restores before preflight, which touches the tree', async () => {
  const state = swapped('preflight');
  const { preflightSaw } = await viaExecute(state);
  assert.equal(preflightSaw, HEAD);
  assert.equal(state.testReplayInFlight, undefined);
});

function failedMessage(seen: readonly Narration[]): string {
  return seen.find((n) => n.id === 'run_failed')?.message ?? '';
}

test('a missing backup stops the run with EXIT.ERROR naming the file and the backup, before preflight', async () => {
  const state = swapped('missing');
  const backup = path.join(state.dir, state.testReplayInFlight?.files[0]?.backup ?? '');
  rmSync(backup);
  const { code, preflightSaw, seen } = await viaExecute(state);
  assert.equal(code, EXIT.ERROR);
  assert.equal(preflightSaw, null, 'preflight never ran');
  const message = failedMessage(seen);
  assert.ok(message.includes(TEST), message);
  assert.ok(message.includes(backup), message);
  assert.notEqual(state.testReplayInFlight, undefined);
  assert.ok('testReplayInFlight' in stored(state), 'the marker survives for the next attempt');
  assert.equal(inTree(state), EARLY, 'nothing was guessed into the tree');
});

test('a missing backup stops the run even when the file is already back at its head bytes', async () => {
  const state = swapped('already');
  writeFileSync(path.join(state.targetDir, TEST), HEAD, 'utf8');
  rmSync(path.join(state.dir, state.testReplayInFlight?.files[0]?.backup ?? ''));
  const { code, preflightSaw } = await viaExecute(state);
  assert.equal(code, EXIT.ERROR);
  assert.equal(preflightSaw, null);
  assert.ok('testReplayInFlight' in stored(state));
});

test('a backup whose bytes do not match is refused, never written into the tree', async () => {
  const state = swapped('mismatch');
  writeFileSync(path.join(state.dir, state.testReplayInFlight?.files[0]?.backup ?? ''), 'something else\n', 'utf8');
  const { code } = await viaExecute(state);
  assert.equal(code, EXIT.ERROR);
  assert.equal(inTree(state), EARLY);
});

test('a test directory replaced by a symlink is refused, and nothing outside the tree is written', async () => {
  const state = swapped('link');
  const outside = mkdtempSync(path.join(tmpdir(), 'vibe-replay-outside-'));
  renameSync(path.join(state.targetDir, 'tests'), path.join(outside, 'tests'));
  symlinkSync(path.join(outside, 'tests'), path.join(state.targetDir, 'tests'), 'dir');
  const { code, seen } = await viaExecute(state);
  assert.equal(code, EXIT.ERROR);
  assert.match(failedMessage(seen), /passes through a symlink/);
  assert.equal(readFileSync(path.join(outside, 'tests', 'a.test.txt'), 'utf8'), EARLY, 'the outside file is untouched');
  assert.ok('testReplayInFlight' in stored(state));
  assert.ok(existsSync(path.join(state.dir, state.testReplayInFlight?.files[0]?.backup ?? '')));
});

test('a restore failure after a stop still ends EXIT.ERROR with its message; an ordinary error still ends NEEDS_HUMAN', async () => {
  const restoreFailure = reviewingRun({ prefix: 'vibe-replay-restore-cancel-', task: 'restore', commit: true });
  const seen: Narration[] = [];
  const code = await quietly(seen, () =>
    execute(
      restoreFailure,
      config(),
      true,
      true,
      () => Promise.resolve(null),
      (s) => {
        s.testReplayInFlight = {
          round: 0,
          files: [{ path: TEST, backup: `test-replay-0/${sha256(HEAD)}.head`, sha256: sha256(HEAD) }],
        };
        requestCancel('test');
        return Promise.reject(new ReplayRestoreError('tests/a.test.txt could not be restored from its backup'));
      },
    ),
  );
  clearCancel();
  assert.equal(code, EXIT.ERROR);
  assert.match(failedMessage(seen), /tests\/a\.test\.txt could not be restored/);

  const ordinary = reviewingRun({ prefix: 'vibe-replay-restore-cancel2-', task: 'restore', commit: true });
  const code2 = await quietly([], () =>
    execute(
      ordinary,
      config(),
      true,
      true,
      () => Promise.resolve(null),
      () => {
        requestCancel('test');
        return Promise.reject(new Error('boom'));
      },
    ),
  );
  clearCancel();
  assert.equal(code2, EXIT.NEEDS_HUMAN);
});
