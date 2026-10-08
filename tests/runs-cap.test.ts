import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS,
  loadConfig,
  readMaxConcurrent,
  withProjectFile,
  writeConfigPatch,
} from '@src/config.js';

/**
 * `runs.maxConcurrent` - how many runs this machine's app may host at once (#246).
 *
 * The window enforces it; the core's part is that it lives in the global file
 * only, is refused by name on every road that reads or writes a project file,
 * and is validated as a whole number when the global file is written. A bad
 * value in the global file must not stop a run, because no run reads it.
 */

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

function scratch(): { dir: string; global: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-runs-cap-'));
  return { dir: root, global: path.join(root, 'home', 'vibe', 'config.json') };
}

test('absent is no limit', () => {
  assert.equal(readMaxConcurrent({}), 0);
  assert.equal(readMaxConcurrent({ runs: {} }), 0);
  assert.equal(readMaxConcurrent({ runs: { maxConcurrent: 0 } }), 0);
  assert.equal(readMaxConcurrent({ runs: { maxConcurrent: 3 } }), 3);
});

test('anything but a whole number of runs is refused by name, null included', () => {
  for (const bad of [-1, 1.5, '2', null]) {
    assert.throws(
      () => readMaxConcurrent({ runs: { maxConcurrent: bad } }),
      /runs\.maxConcurrent must be 0 \(no limit\) or a whole number of runs/,
      String(bad),
    );
  }
  assert.throws(() => readMaxConcurrent({ runs: 2 }), /runs must be an object/);
  assert.throws(() => readMaxConcurrent({ runs: { max: 2 } }), /runs\.max is not a setting; the one is maxConcurrent/);
});

test('a project file that sets runs is refused by loadConfig and by withProjectFile', () => {
  const { dir, global } = scratch();
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ runs: { maxConcurrent: 2 } }));
  withGlobal(global, () => {
    assert.throws(() => loadConfig(dir), /vibe\.config\.json sets runs, and only your settings for all projects can/);
    assert.throws(() => withProjectFile(DEFAULTS, dir), /sets runs/);
  });
});

test('a project write that sets runs is refused, and the file is untouched', () => {
  const { dir, global } = scratch();
  withGlobal(global, () => {
    assert.throws(() => writeConfigPatch(dir, { runs: { maxConcurrent: 2 } }, 'project'), /sets runs/);
  });
});

test('a global write of a whole number is written; anything else is refused unwritten', () => {
  const { dir, global } = scratch();
  withGlobal(global, () => {
    writeConfigPatch(dir, { runs: { maxConcurrent: 2 } }, 'global');
    assert.deepEqual(JSON.parse(readFileSync(global, 'utf8')), { runs: { maxConcurrent: 2 } });
    for (const bad of [-1, 1.5, '2', null]) {
      assert.throws(() => writeConfigPatch(dir, { runs: { maxConcurrent: bad } }, 'global'), /runs\.maxConcurrent/);
    }
    assert.throws(() => writeConfigPatch(dir, { runs: { other: 1 } }, 'global'), /runs\.other is not a setting/);
    assert.deepEqual(JSON.parse(readFileSync(global, 'utf8')), { runs: { maxConcurrent: 2 } });
  });
});

test('a malformed global runs does not stop a run from loading its config', () => {
  const { dir, global } = scratch();
  mkdirSync(path.dirname(global), { recursive: true });
  writeFileSync(global, JSON.stringify({ runs: { maxConcurrent: null } }));
  withGlobal(global, () => {
    assert.doesNotThrow(() => loadConfig(dir));
  });
});
