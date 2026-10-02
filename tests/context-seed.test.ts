import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { seedContextWindows } from '@src/context.js';
import { progressOptions } from '@src/progress.js';
import { createRun, RUNS_DIR } from '@src/run.js';
import type { Config, RunState } from '@src/types.js';

/**
 * The window the first Claude turn of a run has to be a fraction of.
 *
 * A context window arrives on a turn's **result** envelope, so the first Claude
 * turn of a process has a live `promptTokens` and nothing to divide it by - which
 * is the planner, every time. `ctx%` therefore only ever appeared from the second
 * turn onwards, which was reported as context not being measured in the planning
 * phase.
 *
 * `seedContextWindows` borrows the denominator from the newest archived run that
 * recorded one. It is a **measurement, not a derivation**: a figure Claude
 * reported on this machine under this exact model name, recorded by vibe into
 * `state.json` and read back. Every case here is about the fail-closed half - the
 * conditions under which it takes nothing rather than taking something close.
 */

/**
 * A model name unique to each case.
 *
 * The window map lives in `progress.ts` at module scope and is deliberately
 * write-once per model - `seedContextWindow` fills a gap and never overwrites, so
 * a measured figure cannot be replaced by an archived one. Two cases sharing a
 * name would therefore be one case: the first to run would decide the answer for
 * the rest of the file.
 */
const model = (n: number): string => `seed-test-model-${String(n)}`;

function repo(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-seed-'));
}

/** An archived run, with whatever context measurement the case is about. */
function archive(dir: string, id: string, record: Record<string, unknown>): void {
  const at = path.join(dir, RUNS_DIR, id);
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, 'state.json'), JSON.stringify({ id, ...record }), 'utf8');
}

/** What the heartbeat would be told, for `model`. */
function windowFor(state: RunState, model: string): number | undefined {
  const cfg = { ...DEFAULTS, progress: { ...DEFAULTS.progress, enabled: true } } as Config;
  return progressOptions(state, cfg, 'plan', model, 'claude')?.contextWindow;
}

test('the first turn is given a window an earlier run measured under the same model', () => {
  const m = model(1);
  const dir = repo();
  archive(dir, '20260101-000000-old', { contextModel: m, contextWindow: 200_000, contextRatio: 0.4 });
  const state = createRun(dir, 'a task', false);

  assert.equal(windowFor(state, m), undefined);
  seedContextWindows(state);
  assert.equal(windowFor(state, m), 200_000);
});

test('a window measured under another model is not borrowed for this one', () => {
  // The fail-closed reading, and the same one `measuredWindow` applies within a
  // run: a window that cannot be attributed to this conversation is not evidence
  // about it. Scaling one model's window onto another is exactly the invention
  // this repo's one recurring rule forbids.
  const m = model(2);
  const dir = repo();
  archive(dir, '20260101-000000-old', { contextModel: `${m}-other`, contextWindow: 200_000 });
  const state = createRun(dir, 'a task', false);

  seedContextWindows(state);
  assert.equal(windowFor(state, m), undefined);
});

test('it stops at the newest run that measured anything', () => {
  // A run that measured under a different model is evidence about how this
  // checkout is configured NOW, so an older run naming the model in hand is not
  // reached past it. Newest-first, one stop.
  const m = model(3);
  const dir = repo();
  archive(dir, '20260101-000000-old', { contextModel: m, contextWindow: 111_000 });
  archive(dir, '20260601-000000-new', { contextModel: `${m}-other`, contextWindow: 999_000 });
  const state = createRun(dir, 'a task', false);

  seedContextWindows(state);
  assert.equal(windowFor(state, m), undefined);
});

test('runs that measured nothing are stepped over rather than stopping the walk', () => {
  // A plan-only run, or one that died in preflight, carries no measurement and is
  // no evidence either way.
  const m = model(4);
  const dir = repo();
  archive(dir, '20260101-000000-old', { contextModel: m, contextWindow: 123_000 });
  archive(dir, '20260601-000000-new', { status: 'failed' });
  const state = createRun(dir, 'a task', false);

  seedContextWindows(state);
  assert.equal(windowFor(state, m), 123_000);
});

test('an empty archive supplies nothing and never throws', () => {
  const dir = repo();
  const state = createRun(dir, 'a task', false);
  assert.doesNotThrow(() => { seedContextWindows(state); });
  assert.equal(windowFor(state, model(5)), undefined);
});

test('an unreadable state.json is skipped, not fatal', () => {
  const m = model(6);
  const dir = repo();
  const at = path.join(dir, RUNS_DIR, '20260601-000000-broken');
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, 'state.json'), '{ not json', 'utf8');
  archive(dir, '20260101-000000-old', { contextModel: m, contextWindow: 150_000 });
  const state = createRun(dir, 'a task', false);

  seedContextWindows(state);
  // The broken entry is `listRuns`'s `unreadable`, so it never reaches the read
  // here - and the readable one behind it still supplies its window.
  assert.equal(windowFor(state, m), 150_000);
});
