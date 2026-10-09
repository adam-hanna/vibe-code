import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectCliVersions,
  installMethod,
  moveCommands,
  resetCliProbes,
  versionFinding,
} from '@src/cliversions.js';
import { TESTED_CLI_VERSIONS } from '@src/config.js';
import { compareVersions, satisfiesMinVersion, versionOf } from '@src/runtime.js';
import type { RunFn } from '@src/proc.js';

/**
 * The installed agent CLIs against the versions this build was tested with
 * (#298). Tested, not a floor: every finding here is a warning or a detail
 * line, and none is a refusal - that needs a missing flag (`cli-required-flags.test.ts`).
 */

test('the tested versions are the measured ones, with no floor beside them', () => {
  assert.deepEqual(TESTED_CLI_VERSIONS, { claude: '2.1.294', codex: '0.157.1' });
});

test('a version is read out of what each CLI actually prints', () => {
  assert.equal(versionOf('2.1.294 (Claude Code)'), '2.1.294');
  assert.equal(versionOf('codex-cli 0.157.1'), '0.157.1');
  assert.equal(versionOf('command not found'), null);
});

test('versions compare three ways, and an unparseable one is not ordered', () => {
  assert.equal(compareVersions('2.1.200', '2.1.294'), -1);
  assert.equal(compareVersions('2.2.0', '2.1.294'), 1);
  assert.equal(compareVersions('0.157.1', 'codex-cli 0.157.1'), 0);
  assert.equal(compareVersions('1.9', '1.9.0'), 0);
  assert.equal(compareVersions('garbage', '1.0'), null);
  assert.equal(compareVersions('1.0', 'garbage'), null);
});

test('satisfiesMinVersion keeps its meaning on top of the three-way compare', () => {
  assert.equal(satisfiesMinVersion('v24.18.0', '24.18.0'), true);
  assert.equal(satisfiesMinVersion('24.19', '24.18.0'), true);
  assert.equal(satisfiesMinVersion('24.17.9', '24.18.0'), false);
  assert.equal(satisfiesMinVersion(null, '1'), false);
  assert.equal(satisfiesMinVersion('none', '1'), false);
});

test('the install method is read off where the binary resolves', () => {
  assert.equal(installMethod('claude', '/home/u/.local/share/claude/versions/2.1.294'), 'native');
  assert.equal(installMethod('claude', 'C:\\Users\\u\\.local\\share\\claude\\versions\\2.1.294'), 'native');
  assert.equal(installMethod('claude', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'npm');
  assert.equal(installMethod('codex', '/home/u/.nvm/lib/node_modules/@openai/codex/bin/codex.js'), 'npm');
  assert.equal(installMethod('codex', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'), 'npm');
  assert.equal(installMethod('codex', '/usr/local/bin/codex'), 'unknown');
  assert.equal(installMethod('claude', '/opt/homebrew/bin/claude'), 'unknown');
  // The codex package does not make a claude binary npm-installed.
  assert.equal(installMethod('claude', '/x/node_modules/@openai/codex/bin/codex.js'), 'unknown');
});

test('the install method follows a link to where the binary really is', () => {
  if (process.platform === 'win32') return;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-cli-install-'));
  const versions = path.join(dir, '.local', 'share', 'claude', 'versions');
  mkdirSync(versions, { recursive: true });
  const real = path.join(versions, '2.1.294');
  writeFileSync(real, '');
  const link = path.join(dir, 'claude');
  symlinkSync(real, link);
  assert.equal(installMethod('claude', link), 'native');
});

test('the move command is the one for the install method, and every one when it is unknown', () => {
  assert.deepEqual(moveCommands('claude', 'native', '2.1.294'), ['claude install 2.1.294']);
  assert.deepEqual(moveCommands('claude', 'npm', '2.1.294'), ['npm i -g @anthropic-ai/claude-code@2.1.294']);
  assert.deepEqual(moveCommands('codex', 'npm', '0.157.1'), ['npm i -g @openai/codex@0.157.1']);

  const claude = moveCommands('claude', 'unknown', '2.1.294');
  assert.equal(claude.length, 2);
  assert.ok(claude.some((c) => c.includes('claude install 2.1.294')));
  assert.ok(claude.some((c) => c.includes('npm i -g @anthropic-ai/claude-code@2.1.294')));
  for (const c of claude) assert.match(c, /^if installed /);

  const codex = moveCommands('codex', 'unknown', '0.157.1');
  assert.ok(codex.length > 1, 'one guessed command must never be presented as the command');
  assert.ok(codex.some((c) => c.includes('npm i -g @openai/codex@0.157.1')));
});

test('the tested version is confirmed and warns about nothing', () => {
  const found = versionFinding('claude', '2.1.294', '2.1.294', null);
  assert.equal(found.warning, null);
  assert.equal(found.confirm, 'claude 2.1.294 (tested 2.1.294)');
});

test('an older or newer version warns, naming both and the command, and continues', () => {
  const bin = '/home/u/.local/share/claude/versions/2.1.200';
  const older = versionFinding('claude', '2.1.200', '2.1.294', bin);
  assert.equal(older.confirm, null);
  assert.match(older.warning ?? '', /claude 2\.1\.200 is installed, older than the tested 2\.1\.294/);
  assert.match(older.warning ?? '', /Continuing/);
  assert.match(older.warning ?? '', /claude install 2\.1\.294/);

  const newer = versionFinding('codex', '0.160.0', '0.157.1', '/x/node_modules/@openai/codex/bin/codex.js');
  assert.match(newer.warning ?? '', /codex 0\.160\.0 is installed, newer than the tested 0\.157\.1/);
  assert.match(newer.warning ?? '', /npm i -g @openai\/codex@0\.157\.1/);
});

test('a version that could not be read warns and continues, guessing nothing', () => {
  const found = versionFinding('codex', null, '0.157.1', null);
  assert.equal(found.confirm, null);
  assert.match(found.warning ?? '', /could not be read/);
  assert.match(found.warning ?? '', /Continuing/);
});

function versionExec(outputs: Record<string, { code: number; stdout: string }>, calls: string[]): RunFn {
  return (bin, args) => {
    calls.push(`${bin} ${args.join(' ')}`);
    const out = outputs[bin] ?? { code: 127, stdout: '' };
    return Promise.resolve({ code: out.code, signal: null, stdout: out.stdout, stderr: '' });
  };
}

test('detection runs --version once per process and reads both CLIs', async () => {
  resetCliProbes();
  const calls: string[] = [];
  const exec = versionExec(
    { c: { code: 0, stdout: '2.1.294 (Claude Code)\n' }, x: { code: 0, stdout: 'codex-cli 0.157.1\n' } },
    calls,
  );
  const bins = { claude: () => 'c', codex: () => 'x' };
  assert.deepEqual(await detectCliVersions(exec, bins), { claude: '2.1.294', codex: '0.157.1' });
  assert.deepEqual(await detectCliVersions(exec, bins), { claude: '2.1.294', codex: '0.157.1' });
  assert.deepEqual(calls, ['c --version', 'x --version']);
  resetCliProbes();
});

test('a failed --version, a missing binary or a throw is null, never a guess', async () => {
  resetCliProbes();
  const exec = versionExec({ c: { code: 1, stdout: '2.1.294' } }, []);
  const bins = {
    claude: () => 'c',
    codex: (): string => {
      throw new Error('codex not found');
    },
  };
  assert.deepEqual(await detectCliVersions(exec, bins), { claude: null, codex: null });
  resetCliProbes();
  const throwing: RunFn = () => Promise.reject(new Error('spawn failed'));
  assert.deepEqual(await detectCliVersions(throwing, { claude: () => 'c', codex: () => 'x' }), {
    claude: null,
    codex: null,
  });
  resetCliProbes();
});
