import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { execute } from '@src/cli.js';
import { createRun } from '@src/run.js';
import { initGit } from './helpers/loop-harness.js';
import {
  cancelRequested,
  Cancelled,
  clearCancel,
  requestCancel,
  registerInterruptible,
} from '@src/cancel.js';
import { decode } from '@src/protocol.js';
import { run } from '@src/proc.js';
import { createSession } from '@src/serve.js';
import { EXIT } from '@src/orchestrator.js';
import type { Outbound } from '@src/protocol.js';

/**
 * Stopping a turn that is already running (#209, hi-fi 18).
 *
 * Every other ending waits for a boundary: a `stop` gate row ends the run at the
 * next checkpoint, a round cap raises an `Escalation` between turns, and
 * `shutdown` is documented as *"not a kill"*. None of them helps somebody
 * watching a turn that is forty minutes in and going the wrong way, and the
 * footer's `STOP` only existed while a gate was already holding - so the only
 * way to end a live turn was to kill the process.
 *
 * Two claims here are worth more than the rest. **A cancel latches**, so no
 * further agent child starts even if the killed turn's error is swallowed on its
 * way up; and **it kills only what it was told it may**, because `git`, the
 * verification gate and the app-server client all come through the same
 * `run()`.
 */

const line = (v: unknown): string => JSON.stringify(v);
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** A script that outlives the test unless something kills it. */
function sleeper(): { bin: string; args: string[] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cancel-'));
  const file = path.join(dir, 'sleep.mjs');
  // Prints before it waits, so a test can tell "has not started" from "started
  // and is now blocked" - the distinction #181 was about.
  writeFileSync(file, "process.stdout.write('up\\n');\nsetTimeout(() => undefined, 60_000);\n");
  return { bin: process.execPath, args: [file] };
}

test('a cancel frame decodes, with or without a reason', () => {
  assert.deepEqual(decode(line({ type: 'cancel', id: 4 })), {
    ok: true,
    message: { type: 'cancel', id: 4 },
  });
  assert.deepEqual(decode(line({ type: 'cancel', id: 4, reason: 'wrong branch' })), {
    ok: true,
    message: { type: 'cancel', id: 4, reason: 'wrong branch' },
  });
});

test('a reason that is not a sentence is refused, never coerced', () => {
  // It reaches NEEDS-INPUT.md and the run record. A number there would be a
  // sentence nobody wrote.
  for (const reason of [7, '', null]) {
    const read = decode(line({ type: 'cancel', id: 1, reason }));
    assert.equal(read.ok, false, `should have refused reason ${JSON.stringify(reason)}`);
  }
});

test('an interruptible child is killed, and says so as a Cancelled', async () => {
  clearCancel();
  const { bin, args } = sleeper();
  let started = false;
  const child = run(bin, args, {
    interruptible: true,
    onLine: () => {
      started = true;
    },
  });

  // Waited for rather than assumed: killing a child that has not started yet
  // would pass this test for the wrong reason.
  while (!started) await settle();

  const killed = requestCancel('wrong branch');
  assert.equal(killed, 1);

  await assert.rejects(child, (err: unknown) => {
    assert.ok(err instanceof Cancelled, `expected Cancelled, got ${String(err)}`);
    assert.match(err.message, /wrong branch/);
    return true;
  });
  clearCancel();
});

test('a child that was not marked interruptible is left alone', async () => {
  // `git`, the verification gate and the app-server client all come through
  // `run()`. A `git commit` killed mid-write leaves an index a later resume has
  // to recover from, and the gate is the USER'S command - a suite killed
  // half-way is a `failing` verdict about a run nobody completed (#135).
  clearCancel();
  const { bin, args } = sleeper();
  let started = false;
  const child = run(bin, args, {
    timeoutMs: 3_000,
    onLine: () => {
      started = true;
    },
  });
  while (!started) await settle();

  assert.equal(requestCancel('stop the turn'), 0, 'it killed something it was not offered');

  // It dies on its own timeout instead, which is the ordinary path and proves
  // the cancel did not reach it.
  await assert.rejects(child, (err: unknown) => {
    assert.ok(!(err instanceof Cancelled));
    return true;
  });
  clearCancel();
});

test('the latch refuses the next agent child rather than trusting the layers above', async () => {
  // The fail-closed half. A cancelled turn's error travels up through the retry
  // logic and the loop's own handlers, any one of which could decide to have
  // another go; refusing at the spawn means it cannot.
  clearCancel();
  requestCancel('stopped from the window');
  const { bin, args } = sleeper();

  await assert.rejects(run(bin, args, { interruptible: true }), (err: unknown) => {
    assert.ok(err instanceof Cancelled);
    return true;
  });

  // And a child that is not an agent turn still runs, because the run has to be
  // able to finish tidying up - write its artifacts, commit, release its lock.
  const ok = await run(process.execPath, ['-e', 'process.stdout.write("fine")']);
  assert.equal(ok.stdout, 'fine');
  clearCancel();
});

test('a registered child that ended on its own is not killed later', async () => {
  // A stale entry is a kill aimed at a pid the OS may have handed to somebody
  // else by then.
  clearCancel();
  await run(process.execPath, ['-e', 'process.stdout.write("done")'], { interruptible: true });
  assert.equal(requestCancel('after the fact'), 0);
  clearCancel();
});

test('a kill that throws still leaves the run cancelled', () => {
  // The latch is the mechanism and the kill is the courtesy. A cancel that
  // reported failure because one dying child could not be signalled would be
  // refusing to do the part that worked.
  clearCancel();
  const undo = registerInterruptible(() => {
    throw new Error('already gone');
  });
  assert.equal(requestCancel('regardless'), 0);
  assert.equal(cancelRequested(), 'regardless');
  undo();
  clearCancel();
});

test('the session acts at once and reports how many children it killed', () => {
  // Not at a boundary, which is the whole difference from `pause`. The count is
  // on the wire because zero is a different thing to tell somebody: the cancel
  // arrived between turns, so the run still ends but no work was discarded.
  clearCancel();
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(line({ type: 'cancel', id: 9, reason: 'wrong branch' }));

  assert.deepEqual(sent, [{ type: 'result', id: 9, exit: 0 }]);
  assert.equal(cancelRequested(), 'wrong branch');
  clearCancel();
});

test('a cancel with no reason still says something a person can read', () => {
  clearCancel();
  const session = createSession(() => undefined, { invoke: () => Promise.resolve(0) });
  session.receive(line({ type: 'cancel', id: 1 }));
  assert.equal(cancelRequested(), 'stopped from the window');
  clearCancel();
});

/** Run `execute` with the console silenced. */
function quiet<T>(body: () => Promise<T>): Promise<T> {
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  return body().finally(() => {
    console.log = realLog;
    console.error = realError;
  });
}

test('a cancelled run ends the resumable way, and never as an error', async () => {
  // The claim that keeps this from being a second definition of how a run ends.
  // #131 closed the ambiguity between "vibe chose to stop" and "something killed
  // it"; a cancel that exited some other way would reopen it with a button
  // attached. So it takes the ending a round cap already takes - `needs-input`,
  // exit 2, and a file naming why.
  clearCancel();
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cancel-run-'));
  initGit(dir);
  const state = createRun(dir, 'stop me', false);

  const code = await quiet(() =>
    execute(state, DEFAULTS, false, true, () => Promise.resolve(null), () => {
      // What the loop sees: a child killed under it. The error is a plain
      // `Cancelled` rather than an `Escalation`, which is the case this
      // conversion exists for.
      requestCancel('wrong branch');
      return Promise.reject(new Cancelled('wrong branch'));
    }),
  );

  assert.equal(code, EXIT.NEEDS_HUMAN, 'a stopped run is resumable, not failed');
  assert.equal(state.status, 'needs-input');
  assert.ok(existsSync(path.join(state.dir, 'NEEDS-INPUT.md')));

  // And the file says what happened in terms a person can act on: the turn is
  // redone, its spend is already gone, and nothing before it was lost.
  const said = readFileSync(path.join(state.dir, 'NEEDS-INPUT.md'), 'utf8');
  assert.match(said, /wrong branch/);
  assert.match(said, /redone/);
  clearCancel();
});

test('an ordinary failure is still a failure, not a stop', async () => {
  // The other direction, and the one that would be easy to get wrong: the
  // conversion is gated on the latch, so a run that threw for its own reasons
  // must still end as an error rather than being reported as something somebody
  // chose.
  clearCancel();
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cancel-not-'));
  initGit(dir);
  const state = createRun(dir, 'fail on my own', false);

  const code = await quiet(() =>
    execute(state, DEFAULTS, false, true, () => Promise.resolve(null), () =>
      Promise.reject(new Error('the run directory vanished')),
    ),
  );

  assert.equal(code, EXIT.ERROR);
  assert.equal(state.status, 'error');
});

test('a latch does not survive into the next run in the same process', async () => {
  // The host allows a second `invoke` once the first has settled, and a cancel
  // that survived into it would kill its first agent turn instantly - reported
  // as the run being stopped by somebody who stopped a different one.
  requestCancel('the previous run');
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cancel-next-'));
  initGit(dir);
  const state = createRun(dir, 'a fresh run', false);

  let sawLatch: string | null = 'not asked';
  await quiet(() =>
    execute(state, DEFAULTS, false, true, () => Promise.resolve(null), () => {
      sawLatch = cancelRequested();
      return Promise.resolve();
    }),
  );

  assert.equal(sawLatch, null, 'the new run started already cancelled');
});
