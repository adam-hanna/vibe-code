import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import { initGit } from './helpers/loop-harness.js';
import { sh, shaOf, staleClone } from './helpers/base-repo.js';
import type { Outbound } from '@src/protocol.js';

/**
 * The settings note's read (#389): REVIEW.md at the commit the next run would
 * start from, answered without a fetch and saying so - `fetched: false` - and
 * without the text, which the note does not show.
 */

const line = (v: unknown): string => JSON.stringify(v);

/** The reply for `id`, polled with a deadline: the answer runs two git children. */
async function reply(sent: readonly Outbound[], id: number): Promise<Outbound> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const got = sent.find((m) => 'id' in m && m.id === id);
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`no reply to request ${id} within 30s`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

test('a review_md frame decodes, and a missing or empty dir is refused like artifacts', () => {
  assert.equal(decode(line({ type: 'review_md', id: 1, dir: 'C:/repo' })).ok, true);
  for (const bad of ['', undefined, 7]) {
    const got = decode(line({ type: 'review_md', id: 1, dir: bad }));
    assert.equal(got.ok, false, `dir ${String(bad)} was accepted`);
    if (!got.ok) assert.equal(got.reason, 'review_md carried no dir');
  }
});

test('the answer carries the commit, the outcome and fetched: false, and never the text', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-reviewmd-frame-'));
  initGit(dir, { commit: true });
  writeFileSync(path.join(dir, 'REVIEW.md'), '# Standards\n', 'utf8');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'standards');
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(line({ type: 'review_md', id: 5, dir }));

  const got = await reply(sent, 5);
  assert.ok(got.type === 'review_md', JSON.stringify(got));
  assert.equal(got.fetched, false);
  assert.equal(got.ref, null);
  assert.equal(got.tracking, false);
  assert.equal(got.commit, shaOf(dir, 'HEAD'));
  assert.deepEqual(got.reviewMd, {
    kind: 'present',
    blob: sh(dir, 'rev-parse', 'HEAD:REVIEW.md'),
    bytes: 12,
  });
  assert.ok(!JSON.stringify(got).includes('# Standards'), 'the text went over the wire');
});

test('a remote-tracking base is answered from the local copy, never fetched', async () => {
  const { clone, stale } = staleClone();
  writeFileSync(
    path.join(clone, 'vibe.config.json'),
    JSON.stringify({ git: { baseRef: 'origin/main' } }),
    'utf8',
  );
  // A fetch would fail, so a successful answer proves none was attempted.
  sh(clone, 'remote', 'set-url', 'origin', path.join(clone, 'no-such-remote'));
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(line({ type: 'review_md', id: 6, dir: clone }));

  const got = await reply(sent, 6);
  assert.ok(got.type === 'review_md', JSON.stringify(got));
  assert.equal(got.ref, 'origin/main');
  assert.equal(got.tracking, true);
  assert.equal(got.fetched, false);
  assert.equal(got.commit, stale);
  assert.deepEqual(got.reviewMd, { kind: 'absent' });
});
