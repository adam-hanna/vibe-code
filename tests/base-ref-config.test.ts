import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig, writeConfigPatch } from '@src/config.js';

/**
 * `git.baseRef` as configuration (#249): null or a ref, refused by name
 * otherwise, and a project's alone.
 *
 * Driven through `loadConfig` and `writeConfigPatch`, the two public roads into
 * the validator, because those are what a person's file and the settings screen
 * actually reach.
 */

function project(git?: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-baseref-'));
  if (git !== undefined) writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ git }), 'utf8');
  return dir;
}

function withGlobal<T>(at: string, body: () => T): T {
  const before = process.env['VIBE_GLOBAL_CONFIG'];
  process.env['VIBE_GLOBAL_CONFIG'] = at;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env['VIBE_GLOBAL_CONFIG'];
    else process.env['VIBE_GLOBAL_CONFIG'] = before;
  }
}

test('unset is null, which is the repository HEAD - today', () => {
  assert.equal(DEFAULTS.git.baseRef, null);
  assert.equal(loadConfig(project()).git.baseRef, null);
});

test('null and a ref are accepted', () => {
  assert.equal(loadConfig(project({ baseRef: null })).git.baseRef, null);
  assert.equal(loadConfig(project({ baseRef: 'origin/develop' })).git.baseRef, 'origin/develop');
});

for (const bad of [5, '', '   ', '-x', true, ['origin/develop']]) {
  test(`git.baseRef ${JSON.stringify(bad)} is refused by name`, () => {
    assert.throws(() => loadConfig(project({ baseRef: bad })), /git\.baseRef/);
  });
}

test('a refused write leaves the project file as it was', () => {
  const dir = project({ baseRef: 'main' });
  const file = path.join(dir, 'vibe.config.json');
  const before = readFileSync(file, 'utf8');
  assert.throws(() => writeConfigPatch(dir, { git: { baseRef: '' } }, 'project'), /git\.baseRef/);
  assert.equal(readFileSync(file, 'utf8'), before);
  writeConfigPatch(dir, { git: { baseRef: 'origin/develop' } }, 'project');
  assert.equal(loadConfig(dir).git.baseRef, 'origin/develop');
});

test('a base is a project\'s alone: refused in the global file and on a global write', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-baseref-global-'));
  const global = path.join(root, 'home', 'vibe', 'config.json');
  const dir = project();
  withGlobal(global, () => {
    assert.throws(() => writeConfigPatch(dir, { git: { baseRef: 'origin/develop' } }, 'global'), /git\.baseRef/);
    assert.equal(existsSync(global), false);
    mkdirSync(path.dirname(global), { recursive: true });
    writeFileSync(global, JSON.stringify({ git: { baseRef: 'origin/develop' } }), 'utf8');
    assert.throws(() => loadConfig(dir), /git\.baseRef/);
  });
});
