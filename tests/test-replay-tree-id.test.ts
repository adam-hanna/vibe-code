import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as git from '@src/git.js';
import { initGit } from './helpers/loop-harness.js';

/**
 * The replay's git reads go through a disposable index (#486): the listing,
 * the hidden-flag check and the tree id. The real index is only ever copied.
 */

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-replay-tree-'));
  initGit(dir, { commit: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'code.txt'), 'add\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'code'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

const indexHash = (dir: string): string =>
  createHash('sha256').update(readFileSync(path.join(dir, '.git', 'index'))).digest('hex');

async function treeId(dir: string): Promise<{ id: string | null; hidden: boolean }> {
  const scratch = path.join(mkdtempSync(path.join(tmpdir(), 'vibe-replay-index-')), 'index');
  const opened = await git.openScratchIndex(dir, scratch);
  assert.ok(opened !== null);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  await git.treeChanges(dir, base, { index: scratch });
  return { id: await git.scratchTreeId(dir, scratch), hidden: opened.hidden };
}

test('listing and naming the tree through a scratch index leave the real index byte-identical', async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'src', 'staged.txt'), 'staged\n', 'utf8');
  execFileSync('git', ['add', 'src/staged.txt'], { cwd: dir, stdio: 'pipe' });
  writeFileSync(path.join(dir, 'untracked.test.txt'), 'new\n', 'utf8');
  const before = indexHash(dir);
  const cached = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' });

  const { id } = await treeId(dir);
  assert.match(id ?? '', /^[0-9a-f]{40}$/);
  assert.equal(indexHash(dir), before, 'the real index is untouched');
  assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }), cached);
  assert.equal(
    execFileSync('git', ['ls-files', '--', 'untracked.test.txt'], { cwd: dir, encoding: 'utf8' }),
    '',
    'the untracked file was not added to the real index',
  );
});

test('the tree id is stable while nothing changes and moves when a source file does', async () => {
  const dir = repo();
  const first = await treeId(dir);
  const again = await treeId(dir);
  assert.equal(again.id, first.id);
  writeFileSync(path.join(dir, 'src', 'code.txt'), 'mul\n', 'utf8');
  const changed = await treeId(dir);
  assert.notEqual(changed.id, first.id);
  assert.equal(changed.hidden, false);
});

test('an assume-unchanged entry is reported as hiding changes', async () => {
  const dir = repo();
  execFileSync('git', ['update-index', '--assume-unchanged', 'src/code.txt'], { cwd: dir, stdio: 'pipe' });
  assert.equal((await treeId(dir)).hidden, true);
  assert.ok(existsSync(path.join(dir, '.git', 'index')));
});

test('a same-size edit the real index could only catch as racily clean is still listed (#486)', async () => {
  // The racy-git rule: git trusts an entry's cached stat only when the file is
  // older than the index FILE. Built so the real index can catch the edit only
  // that way: the entry is cached at a past time P and not smudged (the refresh
  // happens later than P), the edit keeps the size and is pinned back to P, and
  // the real index is pinned to P too. A copy stamped "now" is newer than P, so
  // it would trust the stale stat and miss the edit.
  const dir = repo();
  execFileSync('git', ['config', 'core.trustctime', 'false'], { cwd: dir, stdio: 'pipe' });
  const file = path.join(dir, 'src', 'code.txt');
  const past = new Date(Date.now() - 60_000);
  utimesSync(file, past, past);
  execFileSync('git', ['update-index', '--refresh'], { cwd: dir, stdio: 'pipe' });
  writeFileSync(file, 'mul\n', 'utf8');
  utimesSync(file, past, past);
  utimesSync(path.join(dir, '.git', 'index'), past, past);
  assert.match(
    execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: dir, encoding: 'utf8' }),
    /src\/code\.txt/,
    'the fixture: git itself still sees the edit through the real index',
  );
  utimesSync(path.join(dir, '.git', 'index'), past, past);

  const scratch = path.join(mkdtempSync(path.join(tmpdir(), 'vibe-replay-index-')), 'index');
  assert.ok((await git.openScratchIndex(dir, scratch)) !== null);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const { changes } = await git.treeChanges(dir, base, { index: scratch });
  assert.deepEqual(
    changes.map((c) => [c.path, c.status]),
    [['src/code.txt', 'modified']],
  );
});
