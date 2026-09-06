import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';

import { attachEnding, describeEnding, endingOf, isAbnormal, run } from '@src/proc.js';
import type { ChildEnding } from '@src/proc.js';
import {
  ENDING_FILE,
  describeEnding as describeProcessEnding,
  endingPath,
  installEndingStamp,
  readEnding,
} from '@src/ending.js';
import type { ProcessHooks, RunEnding } from '@src/ending.js';
import { describeLiveness, livenessOf } from '@src/lock.js';
import { orchestrate } from '@src/orchestrator.js';
import { agents, config, freshRun } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * How a run ends - the child's ending, and the process's own (#131).
 *
 * Two facts that used to be one absence. `close(code, signal)` always carried
 * the signal and `run()` always dropped it, so a killed turn and a turn that
 * exited non-zero reached the run record as the same `code: null`; and nothing
 * at all recorded how the *parent* went, so a lock left behind by a dead pid
 * meant "vibe chose to stop and did not tidy up" and "something killed it"
 * indistinguishably.
 *
 * The cases below are organised as those two halves plus the pair, because the
 * pair is what the issue is actually about: neither half alone says which
 * process died first.
 */

// ---- the child's ending ----------------------------------------------------

test('run: a child that exits under its own power reports a code and no signal', async () => {
  const result = await run(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(result.code, 3);
  assert.equal(result.signal, null);
});

test('a child killed by something outside vibe ends abnormally, however the OS words it', async () => {
  // Killed through the child's own announcement of its pid - `run` deliberately
  // hands no child out, and `onLine` is the only way in.
  //
  // **The two platforms genuinely disagree here, and the disagreement is a
  // finding rather than a wrinkle to smooth over.** POSIX reports a signal
  // death as `(null, 'SIGTERM')`. Windows has no signals: `process.kill(pid,
  // sig)` against a process this one did not spawn becomes `TerminateProcess`,
  // and the child closes with an exit code and no signal at all. So on the
  // platform this repo is developed on, *an outside kill is not observable as a
  // kill* - which is exactly why the two #87 stops left nothing behind, and
  // exactly why the parent's own stamp is the load-bearing half of #131 here
  // rather than a supplement to this one.
  //
  // What survives on both is that the ending is abnormal, and `isAbnormal` is
  // the predicate the recording site uses for that reason.
  const result = await run(
    process.execPath,
    ['-e', 'console.log(process.pid); setTimeout(() => {}, 5000);'],
    {
      onLine: (line) => {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM');
      },
    },
  );

  assert.equal(isAbnormal({ code: result.code, signal: result.signal }), true);
  if (process.platform === 'win32') {
    assert.equal(result.signal, null);
    assert.notEqual(result.code, 0);
  } else {
    assert.equal(result.code, null);
    assert.equal(result.signal, 'SIGTERM');
  }
});

test('run: a turn killed for running over its timeout carries SIGKILL out on the error', async () => {
  await assert.rejects(
    () => run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 }),
    (err: unknown) => {
      assert.match(String((err as Error).message), /timed out after 200ms/);
      // Attached even though vibe sent the signal itself. The reader wants to
      // know the child died on one; the message beside it says who sent it.
      assert.deepEqual(endingOf(err), { code: null, signal: 'SIGKILL' });
      return true;
    },
  );
});

test('an ending is only reported for a failure that came from a child ending', () => {
  // Null, not `{code: null, signal: null}`. Most failures in a run are not
  // children ending - a rate limit read off a stream, a schema the adapter
  // refused - and putting an ending on those would make the real ones
  // unfindable.
  assert.equal(endingOf(new Error('the adapter refused this output')), null);
  assert.equal(endingOf('not even an object'), null);
  assert.equal(endingOf(null), null);
});

test('an ending of exit 0 is recorded but is not abnormal', () => {
  // The two halves of the rule. `attachSpend` drops a spend of nothing because
  // nothing is nothing to charge; an ending has no equivalent zero, so "the
  // child finished and the adapter refused its output" is recorded - and then
  // not reported, because it is not the finding.
  const err = attachEnding(new Error('refused'), { code: 0, signal: null });
  assert.deepEqual(endingOf(err), { code: 0, signal: null });
  assert.equal(isAbnormal({ code: 0, signal: null }), false);
  assert.equal(isAbnormal({ code: 1, signal: null }), true);
  assert.equal(isAbnormal({ code: null, signal: 'SIGKILL' }), true);
});

test('an ending says which of the two it observed, or that it observed neither', () => {
  assert.equal(describeEnding({ code: null, signal: 'SIGKILL' }), 'killed by SIGKILL');
  assert.equal(describeEnding({ code: 1, signal: null }), 'exit 1');
  assert.equal(describeEnding({ code: 0, signal: null }), 'exit 0');
  assert.equal(
    describeEnding({ code: null, signal: null }),
    'neither an exit code nor a signal',
  );
});

// ---- the process's own ending ----------------------------------------------

function runDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-ending-'));
}

interface FakeHooks extends ProcessHooks {
  fireExit: () => void;
  fireSignal: (signal: NodeJS.Signals) => void;
  /** Every signal a listener was installed for, in order. */
  listening: NodeJS.Signals[];
  raised: NodeJS.Signals[];
  live: () => number;
}

function fakeHooks(exitCode: number | undefined = undefined): FakeHooks {
  const signals = new Map<NodeJS.Signals, () => void>();
  const listening: NodeJS.Signals[] = [];
  const raised: NodeJS.Signals[] = [];
  let onExit: (() => void) | null = null;
  return {
    pid: 4242,
    exitCode: () => exitCode,
    onExit: (fn) => {
      onExit = fn;
    },
    offExit: () => {
      onExit = null;
    },
    onceSignal: (signal, fn) => {
      listening.push(signal);
      signals.set(signal, fn);
    },
    offSignal: (signal) => {
      signals.delete(signal);
    },
    raise: (signal) => {
      raised.push(signal);
    },
    fireExit: () => onExit?.(),
    fireSignal: (signal) => {
      // `process.once` removes before invoking, and the re-raise depends on
      // that: the handler has to find the default disposition when it fires the
      // signal back. A fake that left the listener installed would let a broken
      // re-raise loop for ever and pass.
      const fn = signals.get(signal);
      signals.delete(signal);
      fn?.();
    },
    listening,
    raised,
    live: () => signals.size + (onExit === null ? 0 : 1),
  };
}

test('the exit hook stamps the code the process is leaving with', () => {
  const dir = runDir();
  const hooks = fakeHooks(2);
  installEndingStamp(dir, hooks);
  hooks.fireExit();

  const ending = readEnding(dir);
  assert.deepEqual(
    { how: ending?.how, code: ending?.code, signal: ending?.signal, pid: ending?.pid },
    { how: 'exit', code: 2, signal: null, pid: 4242 },
  );
});

test('an exit nobody set a code for is stamped as null, never as zero', () => {
  const dir = runDir();
  const hooks = fakeHooks(undefined);
  installEndingStamp(dir, hooks);
  hooks.fireExit();

  // Node reports this exit as 0. "Nobody set one" and "somebody set zero" are
  // the same outcome and different facts, and this file is about the facts.
  assert.equal(readEnding(dir)?.code, null);
});

test('a stamped signal is written before it is re-raised, and only then', () => {
  const dir = runDir();
  const hooks = fakeHooks();
  const order: string[] = [];
  const raise = hooks.raise;
  hooks.raise = (signal): void => {
    // The file has to exist by the time the process is asked to die: on the
    // real path the raise IS the death, and anything not yet written is lost.
    order.push(readEnding(dir) === null ? 'raised-before-write' : 'raised-after-write');
    raise(signal);
  };
  installEndingStamp(dir, hooks);
  hooks.fireSignal('SIGTERM');

  assert.deepEqual(order, ['raised-after-write']);
  assert.deepEqual(hooks.raised, ['SIGTERM']);
  const ending = readEnding(dir);
  assert.equal(ending?.how, 'signal');
  assert.equal(ending?.signal, 'SIGTERM');
  assert.equal(ending?.code, null);
});

test('SIGINT is not stamped, so Ctrl-C keeps working exactly as it does', () => {
  // The promise `acquireLock` makes in the same words. On Windows the re-raise
  // is emulated by TerminateProcess, so a handler here would change the exit
  // code a Ctrl-C produces on the platform this repo is developed on. The three
  // that are stamped cannot arrive from a keyboard.
  const dir = runDir();
  const hooks = fakeHooks();
  installEndingStamp(dir, hooks);

  assert.deepEqual([...hooks.listening].sort(), ['SIGBREAK', 'SIGHUP', 'SIGTERM']);
  assert.equal(hooks.listening.includes('SIGINT'), false);
});

test('the first ending to be written is the one that stands', () => {
  const dir = runDir();
  const hooks = fakeHooks(0);
  installEndingStamp(dir, hooks);
  hooks.fireSignal('SIGHUP');
  // Both paths are reachable in one teardown on some platforms. The signal is
  // what happened; the exit that follows it is a consequence.
  hooks.fireExit();

  assert.equal(readEnding(dir)?.how, 'signal');
  assert.equal(readEnding(dir)?.signal, 'SIGHUP');
});

test('installing hands back the ending it displaced, and clears it', () => {
  const dir = runDir();
  const first = fakeHooks(7);
  installEndingStamp(dir, first);
  first.fireSignal('SIGTERM');

  const second = installEndingStamp(dir, fakeHooks(0));
  // The previous process's account of itself is the record this issue exists to
  // create. A resume that silently overwrote it would delete the evidence on
  // the way to investigating it, so it comes back to the caller...
  assert.equal(second.previous?.how, 'signal');
  assert.equal(second.previous?.signal, 'SIGTERM');
  // ...and the file itself is gone, so nothing can read it as this process's.
  assert.equal(readEnding(dir), null);
});

test('uninstall takes every hook off and writes nothing', () => {
  const dir = runDir();
  const hooks = fakeHooks(0);
  const stamp = installEndingStamp(dir, hooks);
  assert.equal(hooks.live(), 4); // three signals and the exit hook

  stamp.uninstall();
  stamp.uninstall(); // idempotent

  assert.equal(hooks.live(), 0);
  // Every path that reaches `uninstall` unwound, which means the process was
  // never stopped - so there is nothing to record.
  assert.equal(readEnding(dir), null);
});

test('a stamp this build did not write is not read as an ordinary exit', () => {
  const dir = runDir();
  // Missing `signal` entirely. Reading the absence as null would report an
  // unknown shape as a process that exited cleanly, which is the one claim a
  // damaged stamp must not be allowed to make.
  writeFileSync(
    endingPath(dir),
    JSON.stringify({ pid: 1, host: 'h', at: 'now', how: 'exit', code: 0 }),
    'utf8',
  );
  assert.equal(readEnding(dir), null);

  writeFileSync(endingPath(dir), 'not json at all', 'utf8');
  assert.equal(readEnding(dir), null);

  writeFileSync(
    endingPath(dir),
    JSON.stringify({ pid: 1, host: 'h', at: 'now', how: 'vanished', code: null, signal: null }),
    'utf8',
  );
  assert.equal(readEnding(dir), null);
});

// ---- the pair: which process died first ------------------------------------

/** A lock as `acquireLock` writes one, for a pid that is not running. */
function deadLock(dir: string, pid: number): void {
  writeFileSync(
    path.join(dir, 'run.lock'),
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

/**
 * A pid that is certainly not running.
 *
 * Not a hardcoded number: `probePid` answers `unknown` rather than
 * `interrupted` for anything it cannot resolve, and a pid that happens to be
 * live on the machine running the suite would take the case with it. This
 * process's own pid plus a large offset is the cheapest reliably-absent one,
 * and it is re-probed rather than assumed.
 */
function absentPid(): number {
  for (let candidate = process.pid + 100_000; ; candidate += 1) {
    try {
      process.kill(candidate, 0);
    } catch (err: unknown) {
      if ((err as { code?: unknown }).code === 'ESRCH') return candidate;
    }
  }
}

test('a dead pid with no ending says the process ran none of its own code', () => {
  const dir = runDir();
  const pid = absentPid();
  deadLock(dir, pid);

  const verdict = livenessOf(dir);
  assert.equal(verdict.liveness, 'interrupted');
  assert.equal(verdict.ending, null);
  // The finding, not the absence of one: every ending vibe is capable of
  // choosing writes a stamp, so no stamp rules all of them out.
  assert.match(
    describeLiveness(verdict),
    /nothing recorded how it ended, so it was stopped without running any of its own code/,
  );
});

test('a dead pid with its own ending beside it says the process chose to stop', () => {
  const dir = runDir();
  const pid = absentPid();
  deadLock(dir, pid);
  const hooks = fakeHooks(2);
  hooks.pid = pid;
  installEndingStamp(dir, hooks);
  hooks.fireExit();

  const verdict = livenessOf(dir);
  assert.equal(verdict.liveness, 'interrupted');
  assert.equal(verdict.ending?.how, 'exit');
  // "it was interrupted" was the run's whole account of a dead pid, and it
  // asserted more than the pid could support. This one did not.
  assert.match(describeLiveness(verdict), /exited under its own control \(exit 2\)/);
  assert.doesNotMatch(describeLiveness(verdict), /nothing recorded how it ended/);
});

test('a dead pid sent a signal says which one', () => {
  const dir = runDir();
  const pid = absentPid();
  deadLock(dir, pid);
  const hooks = fakeHooks();
  hooks.pid = pid;
  installEndingStamp(dir, hooks);
  hooks.fireSignal('SIGHUP');

  assert.match(describeLiveness(livenessOf(dir)), /was sent SIGHUP and recorded it before going/);
});

test("another process's ending is not reported as this one's", () => {
  const dir = runDir();
  const pid = absentPid();
  deadLock(dir, pid);
  const hooks = fakeHooks(0);
  hooks.pid = pid + 1;
  installEndingStamp(dir, hooks);
  hooks.fireExit();

  const verdict = livenessOf(dir);
  // Carried, because a stamp that disagrees with the lock beside it is itself
  // worth seeing - but never spoken as this process's ending.
  assert.equal(verdict.ending?.pid, pid + 1);
  assert.match(describeLiveness(verdict), /belongs to a different process/);
});

test('the ending is read even beside a live lock, where it is a contradiction', () => {
  const dir = runDir();
  writeFileSync(
    path.join(dir, 'run.lock'),
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      id: 'run-1',
      token: 'tok-1',
    }),
    'utf8',
  );
  const hooks = fakeHooks(0);
  installEndingStamp(dir, hooks);
  hooks.fireExit();

  const verdict = livenessOf(dir);
  assert.equal(verdict.liveness, 'running');
  // Either an ending from a process that has already gone or a pid that has
  // been recycled. Suppressing it on the healthy path would hide exactly that.
  assert.equal(verdict.ending?.how, 'exit');
});

test('the stamp is a file of its own, so a torn write cannot cost the run', () => {
  const dir = runDir();
  const hooks = fakeHooks(0);
  installEndingStamp(dir, hooks);
  hooks.fireExit();
  assert.equal(path.basename(endingPath(dir)), ENDING_FILE);
  // Written whole, and parseable on its own terms - it never touches state.json.
  const raw: unknown = JSON.parse(readFileSync(endingPath(dir), 'utf8'));
  assert.equal(typeof raw, 'object');
});

test('a process ending renders as a sentence a reader can act on', () => {
  const exited: RunEnding = {
    pid: 9,
    host: 'box',
    at: '2026-01-01T00:00:00.000Z',
    how: 'exit',
    code: 7,
    signal: null,
  };
  assert.match(describeProcessEnding(exited), /pid 9 on box exited under its own control \(exit 7\)/);
  assert.match(
    describeProcessEnding({ ...exited, how: 'signal', code: null, signal: 'SIGTERM' }),
    /was sent SIGTERM and recorded it before going/,
  );
  assert.match(describeProcessEnding({ ...exited, code: null }), /no exit code set/);
});

// A compile-time check that the two vocabularies stayed apart: a child's ending
// is two nullable observations, and a process's is a stamped record with an
// identity. Nothing should ever be able to pass one where the other is wanted.
const _childEnding: ChildEnding = { code: null, signal: 'SIGKILL' };
assert.equal(_childEnding.signal, 'SIGKILL');

// ---- what the run record ends up holding -----------------------------------

/** Every `child_ended` row the run recorded, in order. */
function childEndings(state: RunState): Record<string, unknown>[] {
  return state.events.filter((event) => event.type === 'child_ended');
}

test('a killed turn puts how its child ended into the run record', async () => {
  const state = freshRun();
  await assert.rejects(() =>
    orchestrate(
      state,
      config(),
      false,
      agents(
        {
          claude: () => {
            throw attachEnding(new Error('claude produced no output (killed by SIGKILL)'), {
              code: null,
              signal: 'SIGKILL',
            });
          },
        },
        [],
      ),
    ),
  );

  const ended = childEndings(state);
  assert.equal(ended.length, 1);
  // Flat, like every other event row: `recordAndSay`'s data is spread onto it.
  assert.equal(ended[0]?.['signal'], 'SIGKILL');
  assert.equal(ended[0]?.['code'], null);
  assert.equal(ended[0]?.['provider'], 'claude');
  // The turn's own label, so a reader can tell which of a run's turns lost its
  // child rather than only that one did.
  assert.equal(ended[0]?.['label'], 'plan');
});

test('the ending is recorded even for a turn that spent nothing to charge', async () => {
  const state = freshRun();
  await assert.rejects(() =>
    orchestrate(
      state,
      config(),
      false,
      agents(
        {
          claude: () => {
            throw attachEnding(new Error('claude produced no output'), {
              code: null,
              signal: 'SIGKILL',
            });
          },
        },
        [],
      ),
    ),
  );

  // The reason this is not folded into `turn_failed`. `chargeFailure` returns
  // early with no event when the attempt spent nothing, and a turn killed in
  // its first seconds is exactly the case that spends nothing AND exactly the
  // case whose ending a reader most wants.
  assert.equal(state.events.some((event) => event.type === 'turn_failed'), false);
  assert.equal(childEndings(state).length, 1);
});

test('an ordinary failure with no child behind it records no ending', async () => {
  const state = freshRun();
  await assert.rejects(() =>
    orchestrate(
      state,
      config(),
      false,
      agents(
        {
          claude: () => {
            // No `attachEnding`: a schema the adapter refused, a rate limit read
            // off a stream. Reporting `exit 0` for these would put an ending on
            // every failure in the run and make the real ones unfindable.
            throw new Error('claude emitted a plan that did not match the schema');
          },
        },
        [],
      ),
    ),
  );

  assert.deepEqual(childEndings(state), []);
});

test('a child that exited cleanly and had its output refused records no ending either', async () => {
  const state = freshRun();
  await assert.rejects(() =>
    orchestrate(
      state,
      config(),
      false,
      agents(
        {
          claude: () => {
            throw attachEnding(new Error('claude output was not valid JSON'), {
              code: 0,
              signal: null,
            });
          },
        },
        [],
      ),
    ),
  );

  // Attached, and deliberately not reported: `isAbnormal` is the gate, so the
  // run record names the endings a reader would act on rather than every one
  // the adapter happened to observe.
  assert.deepEqual(childEndings(state), []);
});
