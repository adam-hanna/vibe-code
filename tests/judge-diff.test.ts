import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffChunks } from '@src/git.js';
import { initGit } from './helpers/loop-harness.js';
import type { FileChange } from '@src/types.js';

/**
 * The facts `diffChunks` reports about each file, read through the same diff
 * mode the reviewer's diff is (#112). Real git, because the parsing of
 * `--name-status -z` and `--numstat -z` - renames especially - is the thing
 * under test, and a stub would only test the stub.
 */

function repo(commit: boolean): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-judge-diff-'));
  initGit(dir, { commit });
  return dir;
}

function write(dir: string, rel: string, body: string | Buffer): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body);
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

function commitAll(dir: string, message: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const lines = (n: number, tag = 'line'): string =>
  Array.from({ length: n }, (_u, i) => `${tag} ${i}\n`).join('');

function byPath(changes: readonly FileChange[]): Map<string, FileChange> {
  return new Map(changes.map((c) => [c.path, c]));
}

test('deleted, modified, added and renamed files are reported with their own facts', async () => {
  const dir = repo(true);
  // Distinct contents per file: git's rename detection pairs any delete and add
  // that are similar enough, so shared lines would turn the deletion below into
  // a rename onto the new file - which is git being right, not this test.
  write(dir, 'tests/gone.test.ts', lines(5, 'gone'));
  write(dir, 'tests/edit.test.ts', lines(10, 'edit'));
  write(dir, 'tests/move.test.ts', lines(20, 'kept'));
  const base = commitAll(dir, 'baseline');

  rmSync(path.join(dir, 'tests/gone.test.ts'));
  write(dir, 'tests/edit.test.ts', lines(7, 'edit'));
  write(dir, 'tests/new.test.ts', lines(3, 'new'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  renameSync(path.join(dir, 'tests/move.test.ts'), path.join(dir, 'src/move.ts'));
  commitAll(dir, 'the round');

  const { changes } = await diffChunks(dir, base);
  const got = byPath(changes);

  assert.deepEqual(got.get('tests/gone.test.ts'), {
    path: 'tests/gone.test.ts',
    oldPath: null,
    status: 'deleted',
    added: 0,
    removed: 5,
  });
  assert.deepEqual(got.get('tests/edit.test.ts'), {
    path: 'tests/edit.test.ts',
    oldPath: null,
    status: 'modified',
    added: 0,
    removed: 3,
  });
  assert.deepEqual(got.get('tests/new.test.ts'), {
    path: 'tests/new.test.ts',
    oldPath: null,
    status: 'added',
    added: 3,
    removed: 0,
  });
  assert.deepEqual(got.get('src/move.ts'), {
    path: 'src/move.ts',
    oldPath: 'tests/move.test.ts',
    status: 'renamed',
    added: 0,
    removed: 0,
  });
  // A rename is one change, not a delete beside an add.
  assert.equal(got.has('tests/move.test.ts'), false);
});

test('a binary file is counted as null, never as zero', async () => {
  const dir = repo(true);
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, 'tests/blob.test.bin', Buffer.from([0, 1, 2, 0, 255, 0, 10]));
  commitAll(dir, 'binary');

  const { changes } = await diffChunks(dir, base);
  const blob = byPath(changes).get('tests/blob.test.bin');
  assert.equal(blob?.status, 'added');
  assert.equal(blob?.added, null);
  assert.equal(blob?.removed, null);
});

test('with no base the whole tree is the change, and every file is added', async () => {
  const dir = repo(false);
  write(dir, 'tests/a.test.ts', lines(4));
  write(dir, 'src/a.ts', lines(2));

  const { files, changes } = await diffChunks(dir, null);
  assert.deepEqual([...files].sort(), ['src/a.ts', 'tests/a.test.ts']);
  assert.deepEqual(
    changes.map((c) => [c.path, c.status, c.added, c.removed]).sort(),
    [
      ['src/a.ts', 'added', 2, 0],
      ['tests/a.test.ts', 'added', 4, 0],
    ],
  );
});

test('an uncommitted round is read through the same fallback the diff uses', async () => {
  // `git.commitEachRound: false`: `base..HEAD` is empty, the diff falls back to
  // the working tree, and the facts must come from that same fallback - not
  // from the empty range.
  const dir = repo(true);
  write(dir, 'tests/x.test.ts', lines(6));
  const base = commitAll(dir, 'baseline');
  write(dir, 'tests/x.test.ts', lines(2));

  const { changes } = await diffChunks(dir, base);
  assert.deepEqual(byPath(changes).get('tests/x.test.ts'), {
    path: 'tests/x.test.ts',
    oldPath: null,
    status: 'modified',
    added: 0,
    removed: 4,
  });
});
