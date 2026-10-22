import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readReviewMd } from '@src/review-md.js';
import { initGit } from './helpers/loop-harness.js';
import { sh, shaOf } from './helpers/base-repo.js';

/**
 * Reading `REVIEW.md` from a commit (#389): from the commit only, never the
 * working tree, and verbatim or not at all.
 *
 * Real git, for the reason `base-repo.ts` gives: what a commit holds is a thing
 * git either says or does not, and a fake answering would pin our belief.
 */

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-review-md-'));
  initGit(dir, { commit: true });
  return dir;
}

function commitAll(dir: string, message: string): string {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return shaOf(dir, 'HEAD');
}

const STANDARDS = '# Review standards\n\n- Inventing a number is a P1.\n';

test('a committed REVIEW.md is present, with its text, its blob id and its size', async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'REVIEW.md'), STANDARDS, 'utf8');
  const sha = commitAll(dir, 'standards');

  const read = await readReviewMd(dir, sha);
  assert.equal(read.kind, 'present');
  if (read.kind !== 'present') return;
  // The trailing newline survives: nothing is trimmed.
  assert.equal(read.text, STANDARDS);
  assert.equal(read.blob, sh(dir, 'rev-parse', `${sha}:REVIEW.md`));
  assert.equal(read.bytes, Buffer.byteLength(STANDARDS));
});

test('a commit with no REVIEW.md is absent, and so is one with only review.md or docs/REVIEW.md', async () => {
  const dir = repo();
  assert.deepEqual(await readReviewMd(dir, shaOf(dir, 'HEAD')), { kind: 'absent' });

  writeFileSync(path.join(dir, 'review.md'), STANDARDS, 'utf8');
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'docs', 'REVIEW.md'), STANDARDS, 'utf8');
  const sha = commitAll(dir, 'not the file');
  assert.deepEqual(await readReviewMd(dir, sha), { kind: 'absent' });
});

test('a REVIEW.md committed as a symbolic link is refused, never followed', { skip: process.platform === 'win32' }, async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'elsewhere.md'), STANDARDS, 'utf8');
  symlinkSync('elsewhere.md', path.join(dir, 'REVIEW.md'));
  const sha = commitAll(dir, 'a link');

  const read = await readReviewMd(dir, sha);
  assert.equal(read.kind, 'refused');
  if (read.kind === 'refused') assert.match(read.reason, /symbolic link/);
});

test('a commit that does not exist is unreadable, not absent', async () => {
  const dir = repo();
  const read = await readReviewMd(dir, 'f'.repeat(40));
  assert.equal(read.kind, 'unreadable');
  if (read.kind === 'unreadable') assert.match(read.reason, /git ls-tree ff{6} exited/);
});

test('the working tree is never read: an edited working copy leaves the committed text', async () => {
  const dir = repo();
  writeFileSync(path.join(dir, 'REVIEW.md'), STANDARDS, 'utf8');
  const sha = commitAll(dir, 'v1');
  writeFileSync(path.join(dir, 'REVIEW.md'), 'anything goes now\n', 'utf8');

  const read = await readReviewMd(dir, sha);
  assert.equal(read.kind === 'present' ? read.text : read.kind, STANDARDS);
});

test('a REVIEW.md added by a later commit is not read at the earlier one', async () => {
  const dir = repo();
  const start = shaOf(dir, 'HEAD');
  writeFileSync(path.join(dir, 'REVIEW.md'), STANDARDS, 'utf8');
  commitAll(dir, 'added later');

  assert.deepEqual(await readReviewMd(dir, start), { kind: 'absent' });
});

// ---- verbatim or refused, never redacted ------------------------------------

/** Hold `value` as a key for the length of one case, then put the variable back. */
function holding(t: { after: (fn: () => void) => void }, value: string): void {
  const before = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = value;
  t.after(() => {
    if (before === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = before;
  });
}

test('a REVIEW.md containing a key vibe holds is refused, and the reason does not carry the key', async (t) => {
  const marker = 'sk-ant-review-md-marker-0001';
  holding(t, marker);
  const dir = repo();
  writeFileSync(path.join(dir, 'REVIEW.md'), `${STANDARDS}\nkey: ${marker}\n`, 'utf8');
  const sha = commitAll(dir, 'leaked');

  const read = await readReviewMd(dir, sha);
  assert.equal(read.kind, 'refused');
  if (read.kind === 'refused') {
    assert.match(read.reason, /contains a key vibe holds/);
    assert.ok(!read.reason.includes(marker));
  }
});

test('a REVIEW.md with no held key comes back byte-identical, a literal "[redacted key]" included', async (t) => {
  holding(t, 'sk-ant-unrelated-key-0002');
  const dir = repo();
  const body = `${STANDARDS}A log line reads [redacted key] when a key was removed.\n`;
  writeFileSync(path.join(dir, 'REVIEW.md'), body, 'utf8');
  const sha = commitAll(dir, 'verbatim');

  const read = await readReviewMd(dir, sha);
  assert.equal(read.kind === 'present' ? read.text : read.kind, body);
});

test('a held key that occurs inside the blob id does not corrupt the id', async (t) => {
  const dir = repo();
  writeFileSync(path.join(dir, 'REVIEW.md'), STANDARDS, 'utf8');
  const sha = commitAll(dir, 'standards');
  const blob = sh(dir, 'rev-parse', `${sha}:REVIEW.md`);
  // Eight characters is the shortest key `secrets()` holds; this one is a run
  // of the object id itself, which a redacted `ls-tree` would have mangled.
  holding(t, blob.slice(4, 12));

  const read = await readReviewMd(dir, sha);
  assert.equal(read.kind, 'present');
  if (read.kind === 'present') assert.equal(read.blob, blob);
});
