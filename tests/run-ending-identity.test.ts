import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute, REAL_GATE } from '@src/cli.js';
import * as log from '@src/log.js';
import { Escalation, EXIT } from '@src/orchestrator.js';
import { createRun } from '@src/run.js';
import type { RunState } from '@src/types.js';
import { config, initGit } from './helpers/loop-harness.js';

/**
 * How a run ends, said in a way a host can act on (#162).
 *
 * The defect this pins: the desktop cockpit knew a run was over only from
 * `review_approved` and `gate_stopped`, so a run killed by a turn timeout - the
 * real one that produced the issue, a Codex critique stalled and cut off at its
 * 45-minute ceiling - fell through to the idle banner and looked exactly like a
 * run that had never started. The exit code was on the wire the whole time and
 * nothing was rendering it.
 *
 * Two halves are needed and only one of them is the code. The code says the
 * CATEGORY of the ending; these ids say what happened. Without them a host has
 * to pick the ending out of the output pane by how alarming a line looks, which
 * is the English-matching #133 exists to prevent - and it would pick wrong,
 * because an escalation narrates at `warn` and a healthy run is full of warnings
 * that are not the ending.
 *
 * Nothing here spawns an agent: `execute` takes an injected loop, and the loops
 * below do nothing but throw.
 */

/** A repository, outside this working tree so `rev-parse` cannot find ours. */
function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-ending-'));
  initGit(dir);
  return dir;
}

/** A directory that is not a repository, and has none above it. */
function bare(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-ending-nogit-'));
}

function runIn(dir: string): RunState {
  return createRun(dir, 'how this run ends', false);
}

/**
 * Drive `work` with the sink installed and the console silenced.
 *
 * Both consoles, because this exercises the failure paths and `log.fail` writes
 * to stderr - the point of the separation `serve.ts` depends on, and the reason
 * a test that only captured stdout would print stack traces into the run.
 */
async function narrated<T>(
  work: () => Promise<T>,
): Promise<{ result: T; seen: log.Narration[]; lines: string[] }> {
  const seen: log.Narration[] = [];
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  log.setSink((n) => seen.push(n));
  try {
    return { result: await work(), seen, lines };
  } finally {
    console.log = realLog;
    console.error = realError;
    log.setSink(null);
  }
}

function only(seen: readonly log.Narration[], id: string): log.Narration {
  const found = seen.filter((n) => n.id === id);
  assert.equal(found.length, 1, `expected exactly one ${id}, saw ${found.length}`);
  // Narrowed for the caller rather than asserted past: `found[0]` is
  // `Narration | undefined` under noUncheckedIndexedAccess and the length check
  // above does not tell the compiler otherwise.
  const first = found[0];
  assert.ok(first !== undefined);
  return first;
}

test('a stop for input carries the code it will exit with', async () => {
  const state = runIn(repo());
  const { result, seen } = await narrated(() =>
    execute(state, config(), false, true, REAL_GATE, () => {
      throw new Escalation(EXIT.NEEDS_HUMAN, 'Three questions nobody can answer from here.');
    }),
  );

  assert.equal(result, EXIT.NEEDS_HUMAN);
  const ending = only(seen, 'run_escalated');
  assert.equal(ending.level, 'warn');
  assert.equal(ending.data?.['code'], EXIT.NEEDS_HUMAN);
  assert.equal(ending.message, 'Three questions nobody can answer from here.');
  // The file it wrote travels too: the app has no filesystem and cannot go
  // looking for it, and "there is a file" with no path is not an instruction.
  assert.equal(typeof ending.data?.['file'], 'string');
});

test('every escalation code reaches the same id, not just the resumable one', async () => {
  // The four codes an `Escalation` can carry. A host branching on the id and
  // reading the code gets all of them; one that branched on the id ALONE would
  // be told "needs input" for a budget stop, which is a different next step.
  for (const code of [
    EXIT.NEEDS_HUMAN,
    EXIT.NO_CONVERGENCE,
    EXIT.BUDGET,
    EXIT.RATE_LIMITED,
  ] as const) {
    const state = runIn(repo());
    const { result, seen } = await narrated(() =>
      execute(state, config(), false, true, REAL_GATE, () => {
        throw new Escalation(code, `stopped with ${code}`);
      }),
    );

    assert.equal(result, code);
    assert.equal(only(seen, 'run_escalated').data?.['code'], code);
  }
});

test('a failure carries the sentence, while the terminal still gets the stack', async () => {
  const state = runIn(repo());
  const boom = new Error('the critic turn exceeded criticTimeoutMs');
  const { result, seen, lines } = await narrated(() =>
    execute(state, config(), false, true, REAL_GATE, () => {
      throw boom;
    }),
  );

  assert.equal(result, EXIT.ERROR);
  const ending = only(seen, 'run_failed');
  assert.equal(ending.level, 'error');
  assert.equal(ending.data?.['code'], EXIT.ERROR);
  // The two are deliberately different. A footer wants the one line that says
  // what went wrong; a terminal wants the frames. Rendering a stack into a
  // banner puts a wall of paths where "what now" is supposed to be.
  assert.equal(ending.data?.['reason'], 'the critic turn exceeded criticTimeoutMs');
  assert.ok(
    ending.message.includes('run-ending-identity'),
    'the printed message is the stack, not the sentence',
  );
  assert.ok(
    lines.some((l) => l.includes('run-ending-identity')),
    'and the stack still reaches the console',
  );
});

test('a preflight refusal says so with its own code, before anything is dispatched', async () => {
  const state = runIn(bare());
  let looped = false;

  const { result, seen } = await narrated(() =>
    execute(state, config(), false, true, REAL_GATE, () => {
      looped = true;
      return Promise.resolve();
    }),
  );

  assert.equal(result, EXIT.PREFLIGHT);
  assert.equal(looped, false);
  const ending = only(seen, 'run_failed');
  assert.equal(ending.data?.['code'], EXIT.PREFLIGHT);
  assert.equal(typeof ending.data?.['reason'], 'string');
});

test('a clean run says nothing about ending badly', async () => {
  // The other half of the guard, and the one that would catch an id emitted
  // from a path that is not an ending: a run that finishes has no `run_failed`
  // and no `run_escalated` anywhere in its narration.
  const state = runIn(repo());
  // The exit code is deliberately not asserted here. Whether a loop that ran no
  // verification exits 0 or 7 is `verificationIncomplete`'s decision and it has
  // its own tests; what this case is about is that neither ending id appears on
  // a path that did not end badly.
  const { seen } = await narrated(() =>
    execute(state, config(), false, true, REAL_GATE, () => Promise.resolve()),
  );

  assert.deepEqual(
    seen.filter((n) => n.id === 'run_failed' || n.id === 'run_escalated'),
    [],
  );
});
