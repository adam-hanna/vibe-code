import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, execute } from '@src/cli.js';
import { EXIT } from '@src/orchestrator.js';
import { acquireLock, lockPath } from '@src/lock.js';
import type { RunLock } from '@src/lock.js';
import { createRun, saveState } from '@src/run.js';
import { DEFAULTS } from '@src/config.js';
import type { Config, RunState } from '@src/types.js';

/**
 * What `vibe resume` does before it has permission.
 *
 * The answer has to be "nothing", and that is why the lock is taken in the
 * command rather than in `execute`. `loadRun` writes - it records repairs as
 * events and ensures the ignore file - and `resumeConfig` writes the effective
 * config straight after, so a resume that asked permission only once it reached
 * `execute` would already have rewritten a run another process was driving, and
 * would already have consumed the answers in NEEDS-INPUT.md (#77).
 *
 * These cases drive the real `main`, because the claim is about the command's
 * ordering and a test that called `execute` directly could not see it.
 */

function scratch(task = 'resume lock'): { targetDir: string; state: RunState } {
  const targetDir = mkdtempSync(path.join(os.tmpdir(), 'vibe-resume-lock-'));
  return { targetDir, state: createRun(targetDir, task, true) };
}

/**
 * A run the real loop will decline to do anything with.
 *
 * The cases below that drive `main` all the way through need the command's
 * ordering, not its agents - and `orchestrate` returns immediately for a run
 * that already finished, without spawning anything. That is what keeps the
 * suite's no-real-agents rule while still exercising the real command.
 */
function completed(task = 'resume lock'): { targetDir: string; state: RunState } {
  const targetDir = mkdtempSync(path.join(os.tmpdir(), 'vibe-resume-lock-'));
  // Not plan-only: `status: 'done'` beside `phase: 'complete'` on a plan-only
  // run is one of the triples #54's cross-field pass refuses, because no writer
  // produces it. A finished full run is the legal way to say "finished".
  const state = createRun(targetDir, task, false);
  state.status = 'done';
  state.phase = 'complete';
  saveState(state);
  return { targetDir, state };
}

function plant(dir: string, over: Partial<RunLock>): void {
  const lock: RunLock = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: '2026-08-26T09:00:00.000Z',
    id: 'planted',
    token: 'planted-token',
    ...over,
  };
  writeFileSync(lockPath(dir), JSON.stringify(lock, null, 2), 'utf8');
}

function deadPid(): number {
  return Number(
    execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }).trim(),
  );
}

/** Both streams: `log.fail` writes to stderr, and the refusals under test are fails. */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    return { result: await work(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const ANSWERS = `# Needs input

### 1. Which way?

**Your answer:**

> this way
`;

function config(): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
  };
}

// ---- refusal ----------------------------------------------------------------

test('a resume over a live lock is refused, naming who holds it', async () => {
  const { targetDir, state } = scratch();
  plant(state.dir, { pid: process.pid, startedAt: '2026-08-26T09:00:00.000Z' });

  const { result, lines } = await captureLog(() =>
    main(['resume', state.id, '-C', targetDir]),
  );

  assert.equal(result, EXIT.ERROR);
  const said = lines.join('\n');
  assert.match(said, new RegExp(String(process.pid)), 'names the pid');
  assert.match(said, new RegExp(os.hostname()), 'names the host');
  assert.match(said, /2026-08-26T09:00:00\.000Z/, 'names when it started');
  assert.match(said, /--force/, 'and says what the way out is');
});

test('a refused resume changes nothing at all', async () => {
  const { targetDir, state } = scratch();
  const answersFile = path.join(state.dir, 'NEEDS-INPUT.md');
  writeFileSync(answersFile, ANSWERS, 'utf8');
  const stateFile = path.join(state.dir, 'state.json');
  const before = readFileSync(stateFile, 'utf8');
  plant(state.dir, { pid: process.pid });

  const { result } = await captureLog(() => main(['resume', state.id, '-C', targetDir]));

  assert.equal(result, EXIT.ERROR);
  // Byte-identical: no repair event, no `resume_config`, no pendingAnswers.
  assert.equal(readFileSync(stateFile, 'utf8'), before);
  // The answers are still there to be used by the resume that eventually runs.
  assert.ok(existsSync(answersFile), 'NEEDS-INPUT.md was not consumed');
  assert.equal(readFileSync(answersFile, 'utf8'), ANSWERS);
});

test('a refused resume leaves the holder its own lock', async () => {
  const { targetDir, state } = scratch();
  plant(state.dir, { pid: process.pid, token: 'the-holders-token' });

  await captureLog(() => main(['resume', state.id, '-C', targetDir]));

  const raw: unknown = JSON.parse(readFileSync(lockPath(state.dir), 'utf8'));
  assert.equal((raw as RunLock).token, 'the-holders-token');
});

test('a foreign-host lock refuses too, because it cannot be probed', async () => {
  const { targetDir, state } = scratch();
  plant(state.dir, { host: `${os.hostname()}-elsewhere`, pid: 1 });

  const { result, lines } = await captureLog(() => main(['resume', state.id, '-C', targetDir]));

  assert.equal(result, EXIT.ERROR);
  assert.match(lines.join('\n'), /another machine/);
});

test('an unknown run id is still refused by loadRun, and takes no lock', async () => {
  const { targetDir } = scratch();

  // `main` turns the throw into an exit code; what matters here is that asking
  // about a run that does not exist creates nothing to hold a lock in.
  const { result } = await captureLog(() => main(['resume', 'nosuchrun', '-C', targetDir]));

  assert.equal(result, EXIT.ERROR);
  assert.equal(
    existsSync(path.join(targetDir, '.vibe', 'runs', 'nosuchrun')),
    false,
    'no directory, and so no lock, was created for a run that does not exist',
  );
});

// ---- release ----------------------------------------------------------------

test('the lock is released after an early return that never reaches execute', async () => {
  // The no-answers path: `cmdResume` returns NEEDS_HUMAN without ever calling
  // `execute`, so a lock released only by `execute` would leak here.
  const { targetDir, state } = scratch();
  writeFileSync(
    path.join(state.dir, 'NEEDS-INPUT.md'),
    '# Needs input\n\n### 1. Which way?\n\n**Your answer:**\n\n> \n',
    'utf8',
  );

  const { result } = await captureLog(() => main(['resume', state.id, '-C', targetDir]));

  assert.equal(result, EXIT.NEEDS_HUMAN);
  assert.equal(existsSync(lockPath(state.dir)), false, 'the lock did not leak');
});

test('the lock is released when the loop blows up under it', async () => {
  const { state } = scratch();
  const { handle } = acquireLock(state.dir, state.id, false);
  assert.ok(handle);

  // `execute` reports a failed loop as an exit code rather than rethrowing, so
  // the release has to happen on the ordinary return path too - which is the
  // command's `finally`, modelled here.
  const { result } = await captureLog(async () => {
    try {
      return await execute(
        state,
        config(),
        true,
        true,
        () => Promise.resolve(null),
        () => Promise.reject(new Error('the loop exploded')),
        handle,
      );
    } finally {
      handle.release();
    }
  });

  assert.equal(result, EXIT.ERROR);
  assert.equal(existsSync(lockPath(state.dir)), false);
});

test('execute itself neither acquires nor releases', async () => {
  // A test that drives `execute` directly holds no lock, exactly as before, and
  // `execute` must not invent one - the command owns the lifetime.
  const { state } = scratch();

  await captureLog(() =>
    execute(state, config(), true, true, () => Promise.resolve(null), () => Promise.resolve()),
  );

  assert.equal(existsSync(lockPath(state.dir)), false);
});

// ---- force ------------------------------------------------------------------

test('--force takes a live lock and says what it overrode', async () => {
  const { targetDir, state } = completed();
  plant(state.dir, { pid: process.pid, startedAt: '2026-08-26T09:00:00.000Z' });

  const { result, lines } = await captureLog(() =>
    main(['resume', state.id, '-C', targetDir, '--force', '--skip-probe', '--no-progress']),
  );

  assert.equal(result, EXIT.OK);
  const said = lines.join('\n');
  assert.match(said, /--force/, 'says it forced');
  assert.match(said, /2026-08-26T09:00:00\.000Z/, 'and what it overrode');
  assert.equal(existsSync(lockPath(state.dir)), false, 'and released it at the end');
});

test('a resume over an interrupted lock needs no force', async () => {
  const { targetDir, state } = completed();
  plant(state.dir, { pid: deadPid() });

  const { result, lines } = await captureLog(() =>
    main(['resume', state.id, '-C', targetDir, '--skip-probe', '--no-progress']),
  );

  assert.equal(result, EXIT.OK);
  assert.ok(!lines.join('\n').includes('--force'), 'nothing had to be overridden');
  assert.equal(existsSync(lockPath(state.dir)), false, 'and the lock was released at the end');
});

test('a resume that takes the lock releases it on the way out', async () => {
  const { targetDir, state } = completed();

  await captureLog(() => main(['resume', state.id, '-C', targetDir, '--skip-probe', '--no-progress']));

  assert.equal(existsSync(lockPath(state.dir)), false);
});
