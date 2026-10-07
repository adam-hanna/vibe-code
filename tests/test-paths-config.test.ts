import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig } from '@src/config.js';
import { DEFAULT_TEST_PATHS } from '@src/judge.js';

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
