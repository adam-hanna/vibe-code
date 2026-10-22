import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '@src/cli.js';
import { initGit } from './helpers/loop-harness.js';
import { sh, shaOf, staleClone } from './helpers/base-repo.js';

// `doctor-roles.test.ts`' reason: only so `resolveBin` succeeds where neither
// CLI is installed. Nothing here spawns either.
process.env['VIBE_CLAUDE_BIN'] = process.execPath;
process.env['VIBE_CODEX_BIN'] = process.execPath;

/**
 * `vibe doctor`'s REVIEW.md line (#389): what the commit the next run would
 * start from holds. Doctor fetches; a failed fetch is said with its reason,
 * and the local copy it may add is labelled possibly stale - never as the
 * commit the next run will start from. None of it moves the exit code.
 */

function project(dir: string, git: Record<string, unknown> = {}): void {
  writeFileSync(
    path.join(dir, 'vibe.config.json'),
    JSON.stringify({ codex: { readRateLimits: false }, git }),
    'utf8',
  );
}

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-doctor-reviewmd-'));
  initGit(dir, { commit: true });
  project(dir);
  return dir;
}

function commitAll(dir: string): string {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'change');
  return shaOf(dir, 'HEAD');
}

async function doctor(dir: string): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    return { code: await main(['doctor', '-C', dir, '--skip-probe']), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function only(lines: readonly string[]): string {
  const found = lines.filter((l) => l.includes('REVIEW.md:'));
  assert.equal(found.length, 1, `exactly one REVIEW.md line, got ${found.length}: ${found.join(' | ')}`);
  return found[0] as string;
}

test('present: the line names HEAD, the commit and the size', async () => {
  const dir = repo();
  const { code: before } = await doctor(dir);
  writeFileSync(path.join(dir, 'REVIEW.md'), '# Standards\n', 'utf8');
  const sha = commitAll(dir);
  const { code, lines } = await doctor(dir);
  assert.match(only(lines), new RegExp(`REVIEW\\.md at HEAD \\(${sha.slice(0, 7)}\\), 12 bytes`));
  assert.equal(code, before, 'a REVIEW.md does not move the exit code');
});

test('absent: the line says there is none at that commit', async () => {
  const dir = repo();
  commitAll(dir);
  const { lines } = await doctor(dir);
  assert.match(only(lines), new RegExp(`No REVIEW\\.md at HEAD \\(${shaOf(dir, 'HEAD').slice(0, 7)}\\)`));
});

test('refused: a symbolic link is named as one', { skip: process.platform === 'win32' }, async () => {
  const dir = repo();
  const { code: before } = await doctor(dir);
  symlinkSync('README.md', path.join(dir, 'REVIEW.md'));
  commitAll(dir);
  const { code, lines } = await doctor(dir);
  assert.match(only(lines), /is refused: REVIEW\.md is a symbolic link/);
  assert.equal(code, before, 'a refused REVIEW.md does not move the exit code');
});

test('a failed fetch is said with its reason, and the local copy is labelled possibly stale', async () => {
  const { clone, stale } = staleClone();
  project(clone, { baseRef: 'origin/main' });
  sh(clone, 'remote', 'set-url', 'origin', path.join(clone, 'no-such-remote'));
  const { lines } = await doctor(clone);

  const said = only(lines);
  assert.match(said, /could not resolve the commit the next run would start from/);
  assert.match(said, /could not be fetched/);
  const local = lines.filter((l) => l.includes(stale.slice(0, 7)));
  assert.equal(local.length, 1, 'the local copy is described once');
  assert.match(local[0] as string, /local copy, possibly stale - not necessarily the commit the next run will start from/);
});
