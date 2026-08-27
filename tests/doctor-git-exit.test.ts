import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '@src/cli.js';
import { EXIT } from '@src/orchestrator.js';

/**
 * `vibe doctor` must not call a broken git a healthy environment (#71, review
 * round 2).
 *
 * The gap this closes is narrow and was invisible from the other direction:
 * `check('git', git.gitBin)` only *resolves* the binary, so a `VIBE_GIT_BIN`
 * that exists but cannot be spawned passes it. The repository line then asked
 * git a question, got a spawn failure, and - before this - printed a warning
 * and let doctor exit 0. A diagnostic that exits 0 over a git it could not run
 * is the one answer it must never give.
 *
 * An ordinary non-repository target is deliberately NOT a failure: `vibe plan`
 * works there, and `vibe run` refuses with its own named exit 6. That case is
 * covered in `git-precondition.test.ts`.
 *
 * Its own file for the same reason as `git-unavailable.test.ts`: `gitBin()`
 * memoises, so the override has to be set in a process that has not resolved
 * git yet.
 */
const binDir = mkdtempSync(path.join(tmpdir(), 'vibe-badgit-'));
const notAnExecutable = path.join(binDir, 'git-but-not-really.txt');
writeFileSync(notAnExecutable, 'this is not a program\n', 'utf8');
process.env['VIBE_GIT_BIN'] = notAnExecutable;

/** A target whose config keeps doctor away from the Codex app-server child. */
function targetDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-badgit-target-'));
  writeFileSync(
    path.join(dir, 'vibe.config.json'),
    JSON.stringify({ codex: { readRateLimits: false } }),
    'utf8',
  );
  return dir;
}

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

test('doctor fails when git resolves but cannot be run', async () => {
  const { result: code, lines } = await captureLog(() =>
    main(['doctor', '-C', targetDir(), '--skip-probe']),
  );

  const said = lines.join('\n');
  assert.match(said, /git could not be run/, 'it says what it could not do');
  assert.equal(code, EXIT.ERROR, 'and it costs the exit code, rather than reading as healthy');
  assert.doesNotMatch(
    said,
    /not a git repository: /,
    'a git that could not run is not evidence about whether this is a repository',
  );
});
