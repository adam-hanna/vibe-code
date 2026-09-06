import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireLock, livenessOf, lockPath, probePid } from '@src/lock.js';
import type { PidProbe } from '@src/lock.js';
import { absentPid } from './helpers/pids.js';

/**
 * What the pid probe answers, and what each answer costs a second writer.
 *
 * Split in two on purpose (#164), because the two halves can be known to
 * different standards:
 *
 * - **What the OS says** is `probePid`'s business, and only the two answers a
 *   test can actually produce are asserted here. `EPERM` needs a live process
 *   owned by another user and the fallback needs a probe that fails some third
 *   way; neither is portably arrangeable, and inventing a case that pretends to
 *   produce one would assert the mock rather than the mapping.
 * - **What the answer means** is `livenessOf`'s and `acquireLock`'s, and every
 *   one of the three is reachable there, because the probe is a parameter with
 *   the real one as its default. Those cases state their premise and spawn
 *   nothing - which is the whole point of the seam, and is what the four verdict
 *   cases in `process-endings.test.ts` now do too.
 *
 * The half that used to be flaky was the first one being made to stand in for
 * the second: a case about what `interrupted` *means* had to obtain a dead pid,
 * and there is no such thing as a portably dead pid.
 */

function runDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'vibe-pid-liveness-'));
}

/** A lock as `acquireLock` writes one, on this host so the pid is probed. */
function plant(dir: string, pid: number): void {
  writeFileSync(
    lockPath(dir),
    JSON.stringify({
      pid,
      host: os.hostname(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      id: 'run-1',
      token: 'tok-1',
    }),
    'utf8',
  );
}

const says =
  (answer: 'running' | 'interrupted' | 'unknown'): PidProbe =>
  () =>
    answer;

// ---- what the OS says -------------------------------------------------------

test('probePid: this very process is running', () => {
  // A live pid costs nothing to obtain and cannot be recycled out from under
  // the assertion, because the thing holding it is the thing asserting.
  assert.equal(probePid(process.pid), 'running');
});

test('probePid: a pid nothing on this host holds is interrupted', () => {
  assert.equal(probePid(absentPid()), 'interrupted');
});

test('probePid: a pid the lock format refuses never reaches the probe', () => {
  // The issue offered "a pid the OS cannot have issued" - 0, or a negative - as
  // one way to get a reliably dead fixture. It is not one, and the reason is
  // upstream of the probe rather than in it: `parseLock` requires a positive
  // integer, so such a lock is malformed, and a malformed lock is `unknown`,
  // which refuses a second writer rather than permitting one.
  const dir = runDir();
  writeFileSync(
    lockPath(dir),
    JSON.stringify({ pid: 0, host: os.hostname(), startedAt: 'now', id: 'r', token: 't' }),
    'utf8',
  );

  const verdict = livenessOf(dir);
  assert.equal(verdict.liveness, 'unknown');
  assert.equal(verdict.lock, null, 'it never parsed, so there is no lock to report');
});

// ---- what the answer means --------------------------------------------------

test('livenessOf carries all three probe answers through unchanged', () => {
  const dir = runDir();
  plant(dir, 4242);

  assert.equal(livenessOf(dir, undefined, says('running')).liveness, 'running');
  assert.equal(livenessOf(dir, undefined, says('interrupted')).liveness, 'interrupted');
  // Tri-state on purpose: a probe that failed for any reason other than "no such
  // process" must not collapse into the answer that lets a resume proceed.
  assert.equal(livenessOf(dir, undefined, says('unknown')).liveness, 'unknown');
});

test('livenessOf does not probe at all when the lock is another host', () => {
  const dir = runDir();
  writeFileSync(
    lockPath(dir),
    JSON.stringify({
      pid: 4242,
      host: `${os.hostname()}-elsewhere`,
      startedAt: 'now',
      id: 'r',
      token: 't',
    }),
    'utf8',
  );

  let asked = 0;
  const counting: PidProbe = () => {
    asked += 1;
    return 'interrupted';
  };

  assert.equal(livenessOf(dir, undefined, counting).liveness, 'unknown');
  // A pid number means nothing on a machine this one cannot ask about, and
  // probing it locally would answer a question about the wrong host.
  assert.equal(asked, 0, 'a foreign lock is not probed');
});

// ---- what each answer costs a second writer ---------------------------------

test('acquireLock refuses over a lock the probe says is running', () => {
  const dir = runDir();
  plant(dir, 4242);

  const { ok, handle } = acquireLock(dir, 'run-1', false, says('running'));
  assert.equal(ok, false);
  assert.equal(handle, null);
});

test('acquireLock refuses over a lock the probe could not resolve', () => {
  // The direction that matters: `unknown` refuses. A probe that failed cannot
  // rule out a live process, and permitting here is what would put two writers
  // on one run.
  const dir = runDir();
  plant(dir, 4242);

  const { ok } = acquireLock(dir, 'run-1', false, says('unknown'));
  assert.equal(ok, false);
});

test('acquireLock takes a lock whose holder the probe says is gone', () => {
  const dir = runDir();
  plant(dir, 4242);

  const { ok, verdict, handle } = acquireLock(dir, 'run-1', false, says('interrupted'));
  assert.ok(ok);
  assert.equal(verdict.liveness, 'interrupted');
  // Not a force: nothing was overridden, which is what `vibe resume` reports on.
  assert.equal(handle?.forced, false);
  handle?.release();
});

test('--force is what overrides a running holder, and says it did', () => {
  const dir = runDir();
  plant(dir, 4242);

  const { ok, handle } = acquireLock(dir, 'run-1', true, says('running'));
  assert.ok(ok);
  assert.equal(handle?.forced, true);
  handle?.release();
});
