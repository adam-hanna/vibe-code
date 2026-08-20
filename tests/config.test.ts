import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverrides, configDiff, DEFAULTS } from '@src/config.js';
import type { Config } from '@src/types.js';

/**
 * A config as an older vibe would have persisted it: everything it knew about,
 * nothing added since. Built by deleting from DEFAULTS rather than by hand so
 * the fixture cannot drift away from the real shape.
 */
function preFeatureStoredConfig(): Config {
  const stored = structuredClone(DEFAULTS) as unknown as Record<string, Record<string, unknown>>;
  delete stored['codex']?.['readRateLimits'];
  delete stored['budget']?.['codexLimitPercent'];
  return stored as unknown as Config;
}

test('a stored config missing keys added later still resumes', () => {
  const stored = preFeatureStoredConfig();

  const merged = applyOverrides(stored, {});

  assert.equal(merged.codex.readRateLimits, DEFAULTS.codex.readRateLimits);
  assert.equal(merged.budget.codexLimitPercent, DEFAULTS.budget.codexLimitPercent);
});

test('stored settings still win over the defaults layered underneath', () => {
  const stored = preFeatureStoredConfig();
  stored.claude.model = 'sonnet';
  stored.budget.maxTokens = 1_000_000;

  const merged = applyOverrides(stored, {});

  assert.equal(merged.claude.model, 'sonnet');
  assert.equal(merged.budget.maxTokens, 1_000_000);
});

test('flags given now still win over stored settings', () => {
  const stored = preFeatureStoredConfig();
  stored.claude.model = 'sonnet';

  const merged = applyOverrides(stored, {
    claude: { model: 'opus' },
    budget: { codexLimitPercent: 50 },
  });

  assert.equal(merged.claude.model, 'opus');
  assert.equal(merged.budget.codexLimitPercent, 50);
});

test('a stored value that is genuinely invalid is still rejected', () => {
  const stored = structuredClone(DEFAULTS) as Config;
  stored.budget.codexLimitPercent = 150;

  assert.throws(() => applyOverrides(stored, {}), /codexLimitPercent/);
});

test('an unchanged config diffs to nothing', () => {
  assert.deepEqual(configDiff(DEFAULTS, structuredClone(DEFAULTS) as Config), []);
});

test('a nullable setting and an open-ended toolchain change are both reported', () => {
  const after = structuredClone(DEFAULTS) as Config;
  after.verify.command = 'npm test';
  after.toolchain = { ...after.toolchain, go: { probe: 'go version', phases: ['implement'] } };

  assert.deepEqual(configDiff(DEFAULTS, after), ['toolchain', 'verify.command']);
});

test('a key one side does not have at all counts as a difference', () => {
  const before = structuredClone(DEFAULTS) as unknown as Record<string, Record<string, unknown>>;
  delete before['progress']?.['intervalMs'];

  assert.deepEqual(configDiff(before as unknown as Config, DEFAULTS), ['progress.intervalMs']);
});

test('a toolchain entry the run added is kept when defaults are layered under it', () => {
  const stored: Config = {
    ...structuredClone(DEFAULTS),
    toolchain: { ...DEFAULTS.toolchain, go: { probe: 'go version', phases: ['implement'] } },
  };

  const merged = applyOverrides(stored, {});

  assert.equal(merged.toolchain['go']?.probe, 'go version');
  assert.equal(merged.toolchain['git']?.probe, DEFAULTS.toolchain['git']?.probe);
});
