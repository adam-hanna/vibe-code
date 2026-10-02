import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULTS,
  globalConfigPath,
  loadConfig,
  withProjectFile,
  writeConfigPatch,
} from '@src/config.js';

/**
 * Settings for every project, under each project's own (#223).
 *
 * Asked for as *"Some settings are global, like api keys, etc. Some are project
 * specific, like the worktree command"*, and decided as: almost any key at
 * either level, project wins - all but the test command and the worktree,
 * which only a project may set. The order is `DEFAULTS` → global → `vibe.config.json` →
 * flags, and these cases pin each step of it plus the two things a global write
 * must never do — leave an invalid file, or leave the project in front of you
 * unloadable.
 *
 * Each case points `VIBE_GLOBAL_CONFIG` at a file of its own and puts the
 * variable back afterwards; `npm test` runs with it empty, so no case can read
 * the developer's real settings.
 */

function scratch(): { dir: string; global: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-global-'));
  return { dir: root, global: path.join(root, 'home', 'vibe', 'config.json') };
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

test('the global file lives in the platform\'s own config directory', () => {
  assert.equal(
    globalConfigPath({}, 'linux', '/home/me'),
    path.join('/home/me', '.config', 'vibe', 'config.json'),
  );
  assert.equal(
    globalConfigPath({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home/me'),
    path.join('/xdg', 'vibe', 'config.json'),
  );
  assert.equal(
    globalConfigPath({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', 'C:\\Users\\me'),
    path.join('C:\\Users\\me\\AppData\\Roaming', 'vibe', 'config.json'),
  );
  // Forced, and switched off. Empty is OFF, not "the current directory".
  assert.equal(globalConfigPath({ VIBE_GLOBAL_CONFIG: '/x/c.json' }, 'linux', '/h'), '/x/c.json');
  assert.equal(globalConfigPath({ VIBE_GLOBAL_CONFIG: '' }, 'linux', '/h'), null);
});

test('a global setting applies to a project that says nothing about it', () => {
  const { dir, global } = scratch();
  writeConfigPatch(dir, {}, 'project'); // an empty project file, so the case is not "no file"
  withGlobal(global, () => {
    writeConfigPatch(dir, { loop: { maxPlanRounds: 9 } }, 'global');
    assert.equal(loadConfig(dir).loop.maxPlanRounds, 9);
  });
});

test('the project wins over the global file, key by key', () => {
  const { dir, global } = scratch();
  withGlobal(global, () => {
    writeConfigPatch(dir, { loop: { maxPlanRounds: 9, maxReviewRounds: 8 } }, 'global');
    writeConfigPatch(dir, { loop: { maxPlanRounds: 2 } }, 'project');
    const cfg = loadConfig(dir);
    assert.equal(cfg.loop.maxPlanRounds, 2, 'the project named it');
    assert.equal(cfg.loop.maxReviewRounds, 8, 'the project did not, so the global one stands');
  });
});

test('flags still win over both', () => {
  const { dir, global } = scratch();
  withGlobal(global, () => {
    writeConfigPatch(dir, { loop: { maxPlanRounds: 9 } }, 'global');
    assert.equal(loadConfig(dir, { loop: { maxPlanRounds: 4 } }).loop.maxPlanRounds, 4);
  });
});

test('a resume takes the global file over its memory, and the project over that', () => {
  const { dir, global } = scratch();
  withGlobal(global, () => {
    const stored = { ...DEFAULTS, loop: { ...DEFAULTS.loop, maxPlanRounds: 3, maxReviewRounds: 3 } };
    writeConfigPatch(dir, { loop: { maxPlanRounds: 9, maxReviewRounds: 9 } }, 'global');
    writeConfigPatch(dir, { loop: { maxReviewRounds: 5 } }, 'project');
    const cfg = withProjectFile(stored, dir);
    assert.equal(cfg.loop.maxPlanRounds, 9);
    assert.equal(cfg.loop.maxReviewRounds, 5);
  });
});

test('a global write lands in the global file and leaves the project file alone', () => {
  const { dir, global } = scratch();
  withGlobal(global, () => {
    const wrote = writeConfigPatch(dir, { budget: { maxTokens: 30_000_000 } }, 'global');
    assert.equal(wrote.path, global);
    assert.deepEqual(JSON.parse(readFileSync(global, 'utf8')), {
      budget: { maxTokens: 30_000_000 },
    });
    assert.equal(existsSync(path.join(dir, 'vibe.config.json')), false);
  });
});

test('an invalid global write is refused and nothing is written', () => {
  const { dir, global } = scratch();
  withGlobal(global, () => {
    assert.throws(() => writeConfigPatch(dir, { loop: { maxPlanRounds: -1 } }, 'global'));
    assert.equal(existsSync(global), false);
  });
});

test('a global write that would break the project in front of you is refused', () => {
  // A project that heartbeats every ten minutes cannot be watched for five
  // minutes of quiet - `validate` refuses a quiet ceiling shorter than the
  // interval that measures it - so a global ceiling saved over that project
  // would leave it unloadable. (This used `verify.command` beside a project's
  // `verify.gates` until `verify` became project-only, #223.)
  const { dir, global } = scratch();
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ progress: { intervalMs: 600_000 } }));
  withGlobal(global, () => {
    assert.throws(
      () => writeConfigPatch(dir, { progress: { maxQuietMs: 300_000 } }, 'global'),
      /progress\.maxQuietMs is 300000ms, shorter than/,
    );
    assert.equal(existsSync(global), false);
  });
});

test('the test command and the worktree settings belong to the project alone', () => {
  // *"moving some settings out of global and into project scope (e.g. test
  // command, whether to use worktrees, etc)"* (#223).
  const { dir, global } = scratch();
  withGlobal(global, () => {
    assert.throws(
      () => writeConfigPatch(dir, { verify: { command: 'make test' } }, 'global'),
      /sets verify, which only a project's own vibe\.config\.json can/,
    );
    assert.throws(
      () => writeConfigPatch(dir, { git: { worktree: true, worktreeCommand: 'x' } }, 'global'),
      /sets git\.worktree, git\.worktreeCommand/,
    );
    assert.equal(existsSync(global), false);
    // The rest of `git` is still either level's.
    writeConfigPatch(dir, { git: { commitEachRound: false } }, 'global');
    // And a global file written by hand is refused where it is read.
    writeFileSync(global, JSON.stringify({ verify: { command: 'make test' } }));
    assert.throws(() => loadConfig(dir), /sets verify/);
    // The project may set all of it.
    writeFileSync(global, '{}');
    writeConfigPatch(dir, { verify: { command: 'make test' }, git: { worktree: true } }, 'project');
    assert.equal(loadConfig(dir).git.worktree, true);
  });
});

test('a global write is refused outright when the layer is off', () => {
  const { dir } = scratch();
  withGlobal('', () => {
    assert.throws(() => writeConfigPatch(dir, { loop: { maxPlanRounds: 4 } }, 'global'), /switched off/);
  });
});

test('an unreadable global file names itself', () => {
  const { dir, global } = scratch();
  withGlobal(global, () => {
    writeConfigPatch(dir, {}, 'global');
    writeFileSync(global, '{ not json');
    assert.throws(() => loadConfig(dir), (err: unknown) => {
      assert.ok(err instanceof Error && err.message.includes(global));
      return true;
    });
  });
});
