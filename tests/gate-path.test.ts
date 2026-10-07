import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveBin } from '@src/proc.js';
import { verificationEnv } from '@src/verify.js';
import { resolveCommand, refused } from '@src/commands.js';
import { hostDirectoryFor } from '@src/hosttools.js';
import type { ToolchainContract } from '@src/runtime.js';

/**
 * The verification gate ran a different Node from the one on the person's PATH
 * (#251), and that alone failed a green suite three times out of three on every
 * resume of a run. Three defects in a chain, one case each:
 *
 * 1. `resolveBin` took a hard-coded fallback (`/usr/bin/node`) over what `which`
 *    found first (an nvm Node) everywhere but Windows.
 * 2. `verificationEnv` put that directory at the FRONT of the gate's PATH, which
 *    chose the gate's Node rather than repairing a missing one.
 * 3. `nodeEntry` did not follow Fedora's `/usr/bin/npm` symlink into
 *    `node_modules_22`, so `npm` resolved to the link instead of `node npm-cli.js`
 *    - the one test that failed under the system Node.
 */

const posix = { skip: process.platform === 'win32' };

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gatepath-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function executable(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(file, 0o755);
  return file;
}

/** Run `fn` with PATH set to `value`, and put it back whatever happens. */
function withPath<T>(value: string, fn: () => T): T {
  const before = process.env['PATH'];
  process.env['PATH'] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env['PATH'];
    else process.env['PATH'] = before;
  }
}

test('what PATH finds wins over a fallback that also exists', posix, (t) => {
  const dir = scratch(t);
  const onPath = executable(path.join(dir, 'first', 'vibe-probe-tool'));
  const fallback = executable(path.join(dir, 'system', 'vibe-probe-tool'));

  // `which` must be reachable, so the real PATH stays behind the scratch entry.
  const found = withPath(`${path.dirname(onPath)}:${process.env['PATH'] ?? ''}`, () =>
    resolveBin('vibe-probe-tool', { fallbacks: [fallback] }),
  );
  assert.equal(found, onPath);
});

test('the fallbacks are still used when PATH finds nothing', posix, (t) => {
  const dir = scratch(t);
  const fallback = executable(path.join(dir, 'system', 'vibe-probe-missing'));
  assert.equal(resolveBin('vibe-probe-missing', { fallbacks: [fallback] }), fallback);
});

test('a gate whose PATH already finds a tool runs that PATH unchanged', (t) => {
  // The defect itself: the directory was prepended even when the tool was
  // already there, which is what moved `/usr/bin` in front of an nvm Node.
  const dir = scratch(t);
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  executable(path.join(dir, 'mine', name));
  const sep = process.platform === 'win32' ? ';' : ':';
  const env = { PATH: [path.join(dir, 'mine'), path.join(dir, 'other')].join(sep) };
  const contract: ToolchainContract = { node: { probe: 'node --version', phases: [] } };

  assert.equal(verificationEnv(contract, env)['PATH'], env.PATH);
});

test('a tool the gate cannot find is added at the END of its PATH', (t) => {
  const host = hostDirectoryFor('node');
  if (host === null) {
    t.skip('no node is resolvable from this process, so there is nothing to add');
    return;
  }
  const dir = scratch(t);
  const sep = process.platform === 'win32' ? ';' : ':';
  const env = { PATH: [path.join(dir, 'empty-a'), path.join(dir, 'empty-b')].join(sep) };
  const contract: ToolchainContract = { node: { probe: 'node --version', phases: [] } };

  const entries = (verificationEnv(contract, env)['PATH'] ?? '').split(sep);
  assert.deepEqual(entries, [path.join(dir, 'empty-a'), path.join(dir, 'empty-b'), host]);
});

test('npm reached through a symlink resolves to the npm-cli.js it points at', posix, (t) => {
  // Fedora's layout exactly: `/usr/bin/npm` -> `../lib/node_modules_22/npm/bin/npm-cli.js`,
  // a directory name no walk up from the link would guess.
  const dir = scratch(t);
  const entry = path.join(dir, 'lib', 'node_modules_22', 'npm', 'bin', 'npm-cli.js');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, '#!/usr/bin/env node\n', 'utf8');
  chmodSync(entry, 0o755);
  mkdirSync(path.join(dir, 'bin'));
  symlinkSync(path.join('..', 'lib', 'node_modules_22', 'npm', 'bin', 'npm-cli.js'), path.join(dir, 'bin', 'npm'));

  const plan = withPath(`${path.join(dir, 'bin')}:${process.env['PATH'] ?? ''}`, () =>
    resolveCommand('npm', ['install']),
  );
  assert.equal(refused(plan), false, refused(plan) ? plan.refused : '');
  if (refused(plan)) return;
  assert.equal(plan.file, process.execPath);
  assert.equal(plan.argv[0], realpathSync(entry));
  assert.deepEqual(plan.argv.slice(1), ['install']);
});
