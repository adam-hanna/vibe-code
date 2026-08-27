import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildOverrides, parseArgs } from '@src/cli.js';
import { applyOverrides, DEFAULTS, loadConfig } from '@src/config.js';
import { progressOptions } from '@src/progress.js';
import type { Config, RunState } from '@src/types.js';

/** The flag contract, without running main() - which resolves binaries and spawns. */
function overridesFor(args: readonly string[]): ReturnType<typeof buildOverrides> {
  return buildOverrides(parseArgs(args).flags);
}

/** A target repo holding just a vibe.config.json. */
function repoWith(config: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cfg-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

test('progress is on by default, at a 30s cadence', () => {
  assert.deepEqual(DEFAULTS.progress, { enabled: true, intervalMs: 30_000 });
});

test('--no-progress switches the heartbeat off', () => {
  assert.equal(overridesFor(['--no-progress']).progress?.enabled, false);
});

test('--progress-interval is given in seconds and stored as milliseconds', () => {
  assert.equal(overridesFor(['--progress-interval', '5']).progress?.intervalMs, 5_000);
});

test('neither flag leaves the defaults in place', () => {
  const overrides = overridesFor([]);

  assert.deepEqual(overrides.progress, {});
  assert.deepEqual(loadConfig(mkdtempSync(path.join(tmpdir(), 'vibe-empty-')), overrides).progress, DEFAULTS.progress);
});

test('vibe.config.json can set the cadence without restating the whole section', () => {
  const dir = repoWith({ progress: { intervalMs: 60_000 } });

  const cfg = loadConfig(dir);

  assert.equal(cfg.progress.intervalMs, 60_000);
  assert.equal(cfg.progress.enabled, true);
});

test('a flag given now beats the file', () => {
  const dir = repoWith({ progress: { intervalMs: 60_000 } });

  const cfg = loadConfig(dir, overridesFor(['--no-progress']));

  assert.equal(cfg.progress.enabled, false);
  assert.equal(cfg.progress.intervalMs, 60_000);
});

test('a sub-second cadence is rejected: it would rewrite state.json continuously', () => {
  const dir = repoWith({ progress: { intervalMs: 500 } });

  assert.throws(() => loadConfig(dir), /progress\.intervalMs/);
});

test('a non-numeric cadence is rejected', () => {
  const dir = repoWith({ progress: { intervalMs: 'soon' } });

  assert.throws(() => loadConfig(dir), /progress\.intervalMs/);
});

test('a run stored before this section existed resumes on the defaults', () => {
  const stored = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  delete stored['progress'];

  const merged = applyOverrides(stored as unknown as Config, {});

  assert.deepEqual(merged.progress, DEFAULTS.progress);
});

test('disabled progress is the single point that stops any hook or timer existing', () => {
  const state = { dir: '/nowhere', events: [] } as unknown as RunState;
  const cfg: Config = { ...DEFAULTS, progress: { ...DEFAULTS.progress, enabled: false } };

  assert.equal(progressOptions(state, cfg, 'plan'), undefined);
});

// ---- vibe fork (#78) --------------------------------------------------------

test('--at is parsed as a number, and is not a config override', () => {
  const parsed = parseArgs(['20260101-000000-x', '--at', '3']);

  assert.deepEqual(parsed.positional, ['20260101-000000-x']);
  assert.equal(parsed.flags.at, 3);
  // It names a point in one run, so - like --force - it must never be written
  // back onto the run as a setting the next resume inherits.
  assert.deepEqual(overridesFor(['--at', '3']), overridesFor([]));
});

test('--at refuses a value that is not a number', () => {
  assert.throws(() => parseArgs(['--at', 'second']), /--at must be a number/);
  assert.throws(() => parseArgs(['--at']), /--at requires a value/);
});

test('--no-branch still reaches the fork through the shared override builder', () => {
  assert.equal(overridesFor(['--no-branch']).git?.useBranch, false);
});
