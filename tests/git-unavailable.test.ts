import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute, REAL_GATE, runPreflight } from '@src/cli.js';
import { EXIT } from '@src/orchestrator.js';
import { gitPrecondition } from '@src/preflight.js';
import { createRun } from '@src/run.js';
import { config } from './helpers/loop-harness.js';

/**
 * A git binary that cannot be run at all (#71, review round 1).
 *
 * `git.isRepo` passes `allowFail`, which covers only a git that ran and exited
 * nonzero. When the binary cannot be *resolved* - `VIBE_GIT_BIN` naming a file
 * that is not there - `resolveBin` throws, and an unguarded `await` in the new
 * preflight gate escaped as a generic run error: exit 1, "an error occurred",
 * with nothing said about git. The environment fault has to arrive as the
 * environment refusal, exit 6, naming what could not be run.
 *
 * Its own file because `gitBin()` memoises on first use: any earlier call in
 * the same process caches the real binary and the override would never be
 * consulted. `node --test` gives each file its own process, so this one is set
 * before anything here resolves git, and nothing else in the suite sees it.
 * Safe above the imports' side effects because `gitBin()` is lazy - nothing
 * imported here resolves a binary at module load.
 */
process.env['VIBE_GIT_BIN'] = path.join(
  mkdtempSync(path.join(tmpdir(), 'vibe-nogit-bin-')),
  'no-such-git.exe',
);

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

function plainDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-nogit-run-'));
}

test('an unrunnable git is an answer, not an exception', async () => {
  const reason = await gitPrecondition(plainDir(), ['plan', 'implement', 'review']);

  assert.notEqual(reason, null);
  assert.match(String(reason), /git could not be run/);
  assert.match(String(reason), /VIBE_GIT_BIN/, 'and it names what to repair');
});

test('a plan-only run is untouched by a broken git, because it never asks', async () => {
  // The check returns before it resolves anything for phases that do not need a
  // repository, so `vibe plan` on a host with no git still runs.
  assert.equal(await gitPrecondition(plainDir(), ['plan']), null);
});

test('the run stops at exit 6 naming git, not at a generic error', async () => {
  const state = createRun(plainDir(), 'broken git', false);
  let looped = false;

  const { result: code, lines } = await captureLog(() =>
    execute(state, config(), false, true, REAL_GATE, () => {
      looped = true;
      return Promise.resolve();
    }),
  );

  assert.equal(code, EXIT.PREFLIGHT, 'the environment fault arrives as the environment refusal');
  assert.equal(looped, false);
  assert.equal(state.tokensUsed, 0);
  assert.match(lines.join('\n'), /git could not be run/);
});

test('the gate refuses rather than throwing, with the probes untouched', async () => {
  const state = createRun(plainDir(), 'broken git, probed', false);
  let probed = 0;
  const probe = (): Promise<never> => {
    probed += 1;
    return Promise.reject(new Error('the probes must not be reached'));
  };

  const { result: code } = await captureLog(() =>
    runPreflight(state, config(), { claude: probe, codex: probe }),
  );

  assert.equal(code, EXIT.PREFLIGHT);
  assert.equal(probed, 0);
  assert.equal(state.status, 'error');
});
