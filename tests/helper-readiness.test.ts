import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ReadinessTimeout,
  retryable,
  spawnKillHelper,
  startKillHelper,
} from './helpers/kill-child.js';
import type { SpawnHelper } from './helpers/kill-child.js';
import { STARTING_LINE } from './helpers/kill-markers.js';

/**
 * Telling a child that never started from one that started and stalled.
 *
 * The readiness wait exists to turn an infinite hang into a diagnosis (#100), and
 * on a machine running three builds at once it fired twice on children that had
 * not begun running at all (#181) - `stdout ""`, `stderr ""`, ten seconds, for
 * work that is one `createRun` and at most one 17KB write. From outside, those
 * two are the same observation, and they want opposite responses: one can simply
 * be spawned again, the other is the hang the wait was built for.
 *
 * So the child says when it has arrived, and this file is about what the parent
 * does with that. The rule itself is pure and asserted directly; the three cases
 * that drive real processes go through the spawn seam, so what a child does is
 * decided by the case rather than arranged for.
 *
 * Deliberately not here: raising `READY_TIMEOUT_MS`. It is 25x the worst loaded
 * start-up already measured, and every second added to it is a second a genuine
 * hang looks like a slow machine, times the 24 children one case spawns.
 */

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-readiness-'));
}

/**
 * A child that is not the helper, so a case can say exactly what it emits.
 *
 * A real process rather than a stubbed stream: chunk boundaries, pipe buffering
 * and the exit event are the parts of this wait that have gone wrong before, and
 * a fake object would replace all three with an assumption.
 */
function fakeChild(script: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
}

const SILENT = 'setInterval(() => {}, 1000);';
const STARTS_THEN_STALLS = `process.stdout.write(${JSON.stringify(`${STARTING_LINE}\n`)}); ${SILENT}`;
const ANSWERS = `process.stdout.write(${JSON.stringify(`${STARTING_LINE}\nready SECOND-ATTEMPT\n`)}); ${SILENT}`;

/** A spawn seam that hands out the given scripts in order, and keeps every child it made. */
function scripted(scripts: readonly string[]): { spawn: SpawnHelper; made: ChildProcessWithoutNullStreams[] } {
  const made: ChildProcessWithoutNullStreams[] = [];
  const spawnHelper: SpawnHelper = () => {
    const script = scripts[made.length];
    if (script === undefined) {
      throw new Error(`the case allowed ${String(scripts.length)} spawns and a ${String(made.length + 1)}th was asked for`);
    }
    const child = fakeChild(script);
    made.push(child);
    return child;
  };
  return { spawn: spawnHelper, made };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** SIGKILL is not synchronous, so "the child is gone" is a poll rather than a read. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await sleep(10);
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * 3 seconds, not the 10 the helper ships with: every case here waits out its own
 * timeout, so the constant is what the file costs. It is ~7.7x the worst loaded
 * start-up in `kill-child.ts`'s measurement and ~30x the unloaded one, and the
 * two cases it has to be generous for need one line from a `node -e` that does
 * nothing else.
 */
const BUDGET_MS = 3_000;

// ---- the rule --------------------------------------------------------------

test('only a timeout whose child never printed its first line may be spawned again', () => {
  assert.equal(retryable(new ReadinessTimeout('never began', 1234, false)), true);

  // The one that matters. This is the outcome the wait was built for, and
  // retrying it would double the wait, double the side effects of a mode that
  // had already run some, and turn the diagnosis back into the flake.
  assert.equal(retryable(new ReadinessTimeout('stalled', 1234, true)), false);

  // An exit code is already an answer. A helper that cannot run is not a helper
  // that was unlucky.
  assert.equal(retryable(new Error('helper exited 1 before saying ready in save mode: ')), false);
  assert.equal(retryable(undefined), false);
});

// ---- what the child promises -----------------------------------------------

test('the helper prints its first line before it does any work, in every mode', async () => {
  // `hang` is the mode under test rather than an arbitrary one: it is the third
  // outcome #100 added the wait for, and it reaches its stall through the same
  // `main()` as the rest. If the line were printed anywhere later than the top
  // of `main()`, a real hang would read as "never started" and be retried -
  // which is the one thing the retry must never do.
  const child = spawnKillHelper(scratch(), 'hang');
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      reject(new Error(`no first line in 10s (stdout ${JSON.stringify(out)})`));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const first = out.split('\n')[0] ?? '';
      if (!out.includes('\n')) return;
      clearTimeout(timer);
      resolve(first.replace(/\r$/, ''));
    });
  }).finally(() => child.kill('SIGKILL'));

  assert.equal(line, STARTING_LINE);
  assert.equal(await goneWithin(child.pid ?? -1, 5_000), true, 'the helper was left running');
});

// ---- what the parent does with it ------------------------------------------

test('a child that never printed its first line is spawned once more, and the result says so', async () => {
  const { spawn: seam, made } = scripted([SILENT, ANSWERS]);

  const started = await startKillHelper(scratch(), 'save', { timeoutMs: BUDGET_MS, spawn: seam });

  assert.equal(started.attempts, 2, 'the retry has to be counted, not smoothed away');
  assert.equal(started.ready, 'SECOND-ATTEMPT', 'the second child is the one that answered');
  assert.equal(made.length, 2);

  // The abandoned one is killed, not left writing to a temp directory nobody is
  // reading - `save` and `artifact` loop forever, so an orphan here is not idle.
  const first = made[0];
  assert.ok(first !== undefined);
  assert.equal(await goneWithin(first.pid ?? -1, 5_000), true, 'the first child was left running');

  started.child.kill('SIGKILL');
  assert.equal(
    await goneWithin(started.child.pid ?? -1, 5_000),
    true,
    'the second child outlived the case that made it',
  );
});

test('a child that started and then stalled is not spawned again', async () => {
  const { spawn: seam, made } = scripted([STARTS_THEN_STALLS, SILENT]);

  const err = await startKillHelper(scratch(), 'hang', { timeoutMs: BUDGET_MS, spawn: seam }).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(err instanceof ReadinessTimeout, `expected a readiness timeout, got ${String(err)}`);
  assert.equal(err.started, true, 'the first line arrived, so the child was running');
  assert.equal(made.length, 1, 'a stall is the diagnosis, and must cost one timeout rather than two');
  assert.match(err.message, /stopped short/);
});

test('a second attempt that also never starts says it was the second', async () => {
  // 300ms rather than the budget above: both children here are asserted to print
  // nothing, and a slow machine makes that more certain rather than less - so
  // this one can be cheap without becoming the flake it is testing for.
  const { spawn: seam, made } = scripted([SILENT, SILENT]);

  const err = await startKillHelper(scratch(), 'save', { timeoutMs: 300, spawn: seam }).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(err instanceof ReadinessTimeout, `expected a readiness timeout, got ${String(err)}`);
  assert.equal(made.length, 2);
  assert.equal(err.started, false);
  assert.match(err.message, /this was the second attempt/);
  // Still the ordinary diagnosis as well, so the failure reads as a readiness
  // failure first and a retried one second.
  assert.match(err.message, /never reached readiness in save mode/);

  for (const child of made) {
    assert.equal(await goneWithin(child.pid ?? -1, 5_000), true, 'a child was left running');
  }
});
