import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { formatHeartbeat, MISSED_TICKS } from '@src/progress.js';
import { diffChunks, gitBin } from '@src/git.js';
import { DEFAULTS, loadConfig } from '@src/config.js';

/**
 * A turn that has gone quiet, and the diff that made one go quiet (#223).
 *
 * **One run on 2026-09-15 is the whole of the evidence here, and it is worth
 * stating once.** A greenfield todo app: the plan converged over three rounds,
 * the implement turn wrote 40 files and 5,915 lines, the verification gate
 * passed three times out of three — and then the review turn was handed an
 * *empty diff*, improvised for five minutes, went silent, and was killed
 * thirty-nine minutes later at the Codex turn ceiling. The run ended
 * `status: error` on a tree that was finished and working.
 *
 * Two defects, and they are independent: the diff should not have been empty,
 * and the silence should not have cost thirty-nine minutes.
 */

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-emptydiff-'));
  const git = (...args: string[]): void => {
    execFileSync(gitBin(), args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  return dir;
}

function commit(dir: string, message: string): void {
  const git = (...args: string[]): void => {
    execFileSync(gitBin(), args, { cwd: dir, stdio: 'pipe' });
  };
  git('add', '-A');
  git('commit', '-m', message);
}

// ---- the diff a first commit produces ---------------------------------------

test('a greenfield run’s FIRST COMMIT is still reviewable', async () => {
  // **The defect, exactly.** `markBase` returns null if and only if the
  // repository had no commits when implementing began, so a greenfield run has
  // no base. `git diff --cached` compares the index to HEAD and falls back to
  // the empty tree only while there is no HEAD — so the moment the implement
  // round committed, the review diff became empty and the reviewer was handed
  // nothing at all.
  const dir = repo();
  writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(path.join(dir, 'b.ts'), 'export const b = 2;\n', 'utf8');
  commit(dir, 'vibe: implement approved plan');

  const { chunks, files } = await diffChunks(dir, null);
  assert.deepEqual([...files].sort(), ['a.ts', 'b.ts']);
  assert.match(chunks[0]?.diff ?? '', /export const a = 1/);
  assert.match(chunks[0]?.diff ?? '', /export const b = 2/);
});

test('a greenfield run that has NOT committed is unchanged', async () => {
  // The other half of the same command, and the case that always worked: with
  // `git.commitEachRound` off the round's work is still in the index, and
  // `git add -A` followed by a diff against the empty tree describes it exactly
  // as the old `--cached` did. One command covers both settings, which is why
  // this does not branch on whether a commit happened.
  const dir = repo();
  writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');

  const { chunks, files } = await diffChunks(dir, null);
  assert.deepEqual(files, ['a.ts']);
  assert.match(chunks[0]?.diff ?? '', /export const a = 1/);
});

test('a repository with history is not swept up by the empty tree', async () => {
  // The safety property. Naming the empty tree is safe **only** because
  // `baseSha === null` means the repository had nothing before this run — where
  // there is history there is a base, and the branch above is taken. This pins
  // that a base is honoured rather than widened to the whole history.
  const dir = repo();
  writeFileSync(path.join(dir, 'old.ts'), 'export const old = 0;\n', 'utf8');
  commit(dir, 'before the run');
  const base = execFileSync(gitBin(), ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  writeFileSync(path.join(dir, 'new.ts'), 'export const fresh = 1;\n', 'utf8');
  commit(dir, 'vibe: implement approved plan');

  const { files } = await diffChunks(dir, base);
  assert.deepEqual(files, ['new.ts'], 'the pre-run commit must not be in the review diff');
});

test('a run that changed nothing reports nothing, rather than a phantom file', async () => {
  // The residual case the review phase now refuses rather than reviewing: an
  // empty result is still well-formed, and `splitNul` is what keeps it from
  // being one nameless file.
  const dir = repo();
  writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
  commit(dir, 'first');
  const base = execFileSync(gitBin(), ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

  const { files, chunks } = await diffChunks(dir, base);
  assert.deepEqual(files, []);
  assert.equal(chunks[0]?.diff, '');
});

// ---- the quiet gap, said out loud -------------------------------------------

const beat = (over: Partial<Parameters<typeof formatHeartbeat>[0]>) =>
  formatHeartbeat({
    label: 'review-0',
    elapsedMs: 23 * 60_000,
    unit: 'event',
    snapshot: {
      activities: 32,
      lastActivity: 'command_execution',
      tokens: 0,
      promptTokens: 0,
      said: [],
    } as unknown as Parameters<typeof formatHeartbeat>[0]['snapshot'],
    ...over,
  });

test('a turn that has stopped speaking says so on its own line', () => {
  // **What forty minutes of this run looked like**: `review-0: 23m30s · 32
  // events · command_execution`, every thirty seconds, while the child had not
  // written a byte since 17:45:33. `sinceOutputMs` was on the record the whole
  // time and simply was not in the sentence, so the only evidence was an event
  // count that had stopped moving — readable by diffing two lines by eye.
  const line = beat({ intervalMs: 30_000, sinceOutputMs: 18 * 60_000 });
  assert.match(line, /quiet 18m/);
  // Second, right after elapsed, because it is what a person scanning a stalled
  // run is looking for.
  assert.match(line, /^review-0: 23m00s · quiet /);
});

test('a healthy turn carries no quiet segment at all', () => {
  // Measured across the six healthy turns of that run: the longest any went
  // without new activity was 3m30 on a 12m30 critique, and an 11m30 implement
  // turn never went more than 32 seconds. A segment that appeared on those would
  // be noise on every line of every run.
  const line = beat({ intervalMs: 30_000, sinceOutputMs: 20_000 });
  assert.doesNotMatch(line, /quiet/);
});

test('the threshold is derived from the cadence, never a duration', () => {
  // `MISSED_TICKS` is a shape rather than a number of seconds, the same answer
  // `app/src/cockpit/model.ts` gives for when `7c` calls a run stale. A run
  // configured with slower beats moves with it, which a hardcoded 90_000 would
  // not.
  const slow = 5 * 60_000;
  assert.doesNotMatch(beat({ intervalMs: slow, sinceOutputMs: slow * (MISSED_TICKS - 1) }), /quiet/);
  assert.match(beat({ intervalMs: slow, sinceOutputMs: slow * MISSED_TICKS }), /quiet/);
});

test('a turn whose child has never written has no gap rather than a gap of zero', () => {
  // The distinction `sinceOutputMs` already draws, kept: it is omitted entirely
  // when there has not been a line, and a zero would claim the child had just
  // written.
  assert.doesNotMatch(beat({ intervalMs: 30_000 }), /quiet/);
});

// ---- the ceiling ------------------------------------------------------------

function configWith(progress: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-quiet-cfg-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ progress }), 'utf8');
  return dir;
}

test('the default is ten minutes, and it is a setting rather than a census', () => {
  // Stated here so a change to it is a change to a test as well as to a
  // constant. The figure is the owner's, taken against a measured separation:
  // roughly three times the worst healthy gap observed, and a quarter of the
  // stall that prompted it.
  assert.equal(DEFAULTS.progress.maxQuietMs, 600_000);
});

test('zero disables it, exactly as a zero token ceiling does', () => {
  // One shape for the off switch wherever a ceiling appears in this config.
  assert.equal(loadConfig(configWith({ maxQuietMs: 0 })).progress.maxQuietMs, 0);
});

test('a ceiling shorter than the beat that measures it is refused by name', () => {
  // A turn cannot be observed quiet for less time than the gap between
  // observations, so such a ceiling could fire on a turn nobody had looked at
  // yet. Refused with both figures, because the validator reporting a bad value
  // *by name* is what makes it actionable.
  assert.throws(
    () => loadConfig(configWith({ maxQuietMs: 1_000, intervalMs: 30_000 })),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /maxQuietMs/);
      assert.match(err.message, /intervalMs/);
      return true;
    },
  );
});

test('a negative ceiling is refused rather than treated as off', () => {
  assert.throws(() => loadConfig(configWith({ maxQuietMs: -1 })), /maxQuietMs/);
});
