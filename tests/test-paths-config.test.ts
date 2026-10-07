import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyOverrides, DEFAULTS, loadConfig, withProjectFile } from '@src/config.js';
import { DEFAULT_TEST_PATHS } from '@src/judge.js';
import type { Config } from '@src/types.js';

/**
 * `verify.testPaths` is validated like every other key: a list of non-empty
 * strings, refused by name otherwise (#112). Through `loadConfig`, because the
 * merge has to keep the key for the validator to see it - `mergeSection` drops
 * any key `DEFAULTS.verify` does not carry.
 */

function project(contents: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-testpaths-cfg-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(contents));
  return dir;
}

test('a value that is not a list of patterns is refused by name', () => {
  assert.throws(
    () => loadConfig(project({ verify: { testPaths: 'tests/**' } })),
    /verify\.testPaths must be a list/,
  );
  assert.throws(
    () => loadConfig(project({ verify: { testPaths: { a: 1 } } })),
    /verify\.testPaths must be a list/,
  );
});

test('an empty or non-string pattern is refused by its index', () => {
  assert.throws(
    () => loadConfig(project({ verify: { testPaths: ['tests/**', ''] } })),
    /verify\.testPaths\[1\] must be a non-empty/,
  );
  assert.throws(
    () => loadConfig(project({ verify: { testPaths: ['  '] } })),
    /verify\.testPaths\[0\] must be a non-empty/,
  );
  assert.throws(
    () => loadConfig(project({ verify: { testPaths: [1] } })),
    /verify\.testPaths\[0\] must be a non-empty/,
  );
});

test('an empty list is legal, and a list replaces the defaults rather than extending them', () => {
  assert.deepEqual(loadConfig(project({ verify: { testPaths: [] } })).verify.testPaths, []);
  assert.deepEqual(
    loadConfig(project({ verify: { testPaths: ['spec/**'] } })).verify.testPaths,
    ['spec/**'],
  );
  assert.deepEqual(loadConfig(project({})).verify.testPaths, [...DEFAULT_TEST_PATHS]);
  assert.deepEqual(DEFAULTS.verify.testPaths, [...DEFAULT_TEST_PATHS]);
});

test('a resumed run stored before testPaths existed still takes the project file\'s patterns', () => {
  // `mergeSection` copies only keys its base has, so a stored config from before
  // #112 - no `verify.testPaths` - would drop the project's setting on resume and
  // the default would be filled in afterwards. The seed in `withProjectFile` is
  // what keeps a written-down setting applied.
  const { testPaths: _dropped, ...legacyVerify } = DEFAULTS.verify;
  const stored = { ...DEFAULTS, verify: legacyVerify } as Config;
  const dir = project({ verify: { testPaths: ['checks/**'] } });

  assert.deepEqual(withProjectFile(stored, dir).verify.testPaths, ['checks/**']);
  assert.deepEqual(applyOverrides(withProjectFile(stored, dir), {}, {}).verify.testPaths, [
    'checks/**',
  ]);
  // And a stored value the project file says nothing about is still the run's.
  const remembered = { ...DEFAULTS, verify: { ...DEFAULTS.verify, testPaths: ['spec/**'] } };
  assert.deepEqual(withProjectFile(remembered, project({})).verify.testPaths, ['spec/**']);
});
