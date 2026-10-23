import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nextRunStart } from '@src/git.js';
import { sh, shaOf, staleClone, twoCommits } from './helpers/base-repo.js';

/**
 * The one rule for where the next run would start (#389): `git.baseRef` if
 * set, else HEAD, in two modes that say which they were.
 *
 * The run's own use - the fetching mode, and its refusal when the fetch fails
 * with no fallback to the local copy - is pinned by `base-ref-refusals.test.ts`,
 * which this change leaves exactly as it was. These cases are the display mode
 * and the `fetched` flag that keeps it from being mistaken for the real answer.
 */

const timeoutMs = 60_000;

test('fetch: false answers from the local copy, never fetches, and says so', async () => {
  const { clone, stale } = staleClone();
  // Any fetch would now fail, so an answer at all proves none was attempted.
  sh(clone, 'remote', 'set-url', 'origin', path.join(clone, 'no-such-remote'));
  const got = await nextRunStart(clone, 'origin/main', { fetch: false, timeoutMs });
  assert.deepEqual(got, { ok: true, sha: stale, ref: 'origin/main', tracking: true, fetched: false });
});

test('fetch: true fetches a remote-tracking ref and reports that it did', async () => {
  const { clone, fresh } = staleClone();
  const got = await nextRunStart(clone, 'origin/main', { fetch: true, timeoutMs });
  assert.deepEqual(got, { ok: true, sha: fresh, ref: 'origin/main', tracking: true, fetched: true });
});

test('fetch: true refuses when the fetch fails, and gives the reason', async () => {
  const { clone } = staleClone();
  sh(clone, 'remote', 'set-url', 'origin', path.join(clone, 'no-such-remote'));
  const got = await nextRunStart(clone, 'origin/main', { fetch: true, timeoutMs });
  assert.equal(got.ok, false);
  if (!got.ok) assert.match(got.reason, /could not be fetched/);
});

test('a local branch is not remote-tracking, and nothing is fetched for it', async () => {
  const { dir, first } = twoCommits();
  for (const fetch of [true, false]) {
    const got = await nextRunStart(dir, 'base', { fetch, timeoutMs });
    assert.deepEqual(got, { ok: true, sha: first, ref: 'base', tracking: false, fetched: false });
  }
});

test('no git.baseRef is HEAD, unfetched', async () => {
  const { dir } = twoCommits();
  const got = await nextRunStart(dir, null, { fetch: true, timeoutMs });
  assert.deepEqual(got, { ok: true, sha: shaOf(dir, 'HEAD'), ref: null, tracking: false, fetched: false });
});

test('a directory that is not a repository is refused', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-not-a-repo-'));
  const got = await nextRunStart(dir, null, { fetch: false, timeoutMs });
  assert.equal(got.ok, false);
});
