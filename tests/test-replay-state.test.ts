import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StoredStateError, validateStoredState } from '@src/stored.js';
import type { TestReplay, TestReplayCache, TestReplayInFlight } from '@src/types.js';

/**
 * The replay's three state fields across a stop and a resume (#486).
 *
 * The record and the cache in `testChanges`'s style: absence is preserved, a
 * well-formed value round-trips with no repairs, a damaged entry is dropped and
 * said, and a damaged value drops the key. The in-flight marker is the
 * exception, and on purpose: absence means "nothing is swapped", so a marker
 * that cannot be read stops the run instead of being dropped into that claim.
 */

function widest(): Record<string, unknown> {
  const file = fileURLToPath(new URL('../../tests/fixtures/state/done-widest.json', import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

const BLOB = '0123456789abcdef0123456789abcdef01234567';
const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
const SHA = 'a'.repeat(64);

const record: TestReplay = {
  round: 1,
  at: 'review',
  tree: BLOB,
  files: [
    { path: 'tests/a.test.ts', verdict: 'earlier-fails', earliest: { commit: COMMIT, blob: BLOB }, head: BLOB, gate: 'core', gates: ['core'] },
    { path: 'tests/b.test.ts', verdict: 'preserved', earliest: { commit: COMMIT, blob: BLOB }, head: BLOB, gates: ['core'], cached: true },
    { path: 'tests/c.test.ts', verdict: 'unproven', reason: 'the core gate timed out or was killed', gates: ['core'] },
    { path: 'vibe.config.json', verdict: 'not-a-test' },
  ],
};

const cache: TestReplayCache = {
  tree: BLOB,
  gates: [{ name: 'core', command: 'npm test' }],
  files: [
    { path: 'tests/a.test.ts', earliest: BLOB, verdict: 'earlier-fails', gate: 'core', gates: ['core'] },
    { path: 'tests/b.test.ts', earliest: BLOB, verdict: 'preserved', gates: ['core'] },
  ],
};

const marker: TestReplayInFlight = {
  round: 1,
  files: [{ path: 'tests/a.test.ts', backup: `test-replay-1/${SHA}.head`, sha256: SHA }],
};

test('a state written before the fields existed loads with no repairs and none of them', () => {
  const { state, repairs } = read(widest());
  assert.deepEqual(repairs, []);
  assert.equal(state.testReplay, undefined);
  assert.equal(state.testReplayAfterReview, undefined);
  assert.equal(state.testReplayCache, undefined);
  assert.equal(state.testReplayInFlight, undefined);
});

test('well-formed values survive the round trip intact, with no repairs', () => {
  const after: TestReplay = { ...record, at: 'final-fix', tree: null };
  const { state, repairs } = read({
    ...widest(),
    testReplay: record,
    testReplayAfterReview: after,
    testReplayCache: cache,
    testReplayInFlight: marker,
  });
  assert.deepEqual(repairs, []);
  assert.deepEqual(state.testReplay, record);
  assert.deepEqual(state.testReplayAfterReview, after);
  assert.deepEqual(state.testReplayCache, cache);
  assert.deepEqual(state.testReplayInFlight, marker);
});

test('a damaged record entry is dropped and said; a damaged record drops the key', () => {
  const damaged = {
    ...record,
    files: [
      ...record.files,
      { path: 'tests/d.test.ts', verdict: 'tampered' },
      { path: 'tests/e.test.ts', verdict: 'preserved', gate: 'core' },
      { path: 'tests/f.test.ts', verdict: 'preserved', earliest: { commit: 'abc', blob: BLOB } },
    ],
  };
  const { state, repairs } = read({ ...widest(), testReplay: damaged });
  assert.deepEqual(state.testReplay, record, 'the good entries are kept, as written');
  const repair = repairs.find((r) => r.field === 'testReplay');
  assert.equal(repair?.droppedCount, 3);
  assert.deepEqual(repair?.droppedPaths, ['testReplay.files[4]', 'testReplay.files[5]', 'testReplay.files[6]']);

  for (const bad of [{ ...record, round: -1 }, { ...record, at: 'later' }, { ...record, tree: 'x' }, { ...record, files: {} }, 'x']) {
    const out = read({ ...widest(), testReplayAfterReview: bad });
    assert.equal(out.state.testReplayAfterReview, undefined);
    assert.ok(out.repairs.some((r) => r.field === 'testReplayAfterReview'));
  }
});

test('a damaged cache entry is dropped and said, and only measured verdicts may be cached', () => {
  const damaged = {
    ...cache,
    files: [...cache.files, { path: 'tests/u.test.ts', earliest: BLOB, verdict: 'unproven', gates: [] }, { path: 1 }],
  };
  const { state, repairs } = read({ ...widest(), testReplayCache: damaged });
  assert.deepEqual(state.testReplayCache, cache);
  assert.equal(repairs.find((r) => r.field === 'testReplayCache')?.droppedCount, 2);

  const out = read({ ...widest(), testReplayCache: { ...cache, tree: null } });
  assert.equal(out.state.testReplayCache, undefined);
  assert.ok(out.repairs.some((r) => r.field === 'testReplayCache'));
});

test('a marker that cannot be read stops the run, naming the field, rather than reading as "nothing swapped"', () => {
  const file = marker.files[0] as TestReplayInFlight['files'][number];
  const bad: unknown[] = [
    'x',
    { ...marker, round: 'one' },
    { ...marker, files: [] },
    { ...marker, files: [{ ...file, backup: '../../elsewhere' }] },
    { ...marker, files: [{ ...file, backup: `test-replay-2/${SHA}.head` }] },
    { ...marker, files: [{ ...file, path: '../outside.test.ts' }] },
    { ...marker, files: [{ ...file, path: '/etc/passwd' }] },
    { ...marker, files: [{ ...file, sha256: 'abc', backup: 'test-replay-1/abc.head' }] },
  ];
  for (const value of bad) {
    assert.throws(
      () => read({ ...widest(), testReplayInFlight: value }),
      (err: unknown) =>
        err instanceof StoredStateError &&
        err.message.includes('testReplayInFlight') &&
        err.message.includes('may still be in the working tree'),
      JSON.stringify(value),
    );
  }
});

test('a measured verdict missing its evidence is dropped and said, never read as attributed (#486 review)', () => {
  const base = { path: 'tests/x.test.ts', earliest: { commit: COMMIT, blob: BLOB }, head: BLOB };
  const bad: unknown[] = [
    // A failure that names no gate would print as a failure of nothing.
    { ...base, verdict: 'earlier-fails', gates: ['core'] },
    // ...or names one that did not run last.
    { ...base, verdict: 'earlier-fails', gate: 'core', gates: ['core', 'e2e'] },
    // A pass with no gates run passed nothing.
    { ...base, verdict: 'preserved', gates: [] },
    { ...base, verdict: 'preserved' },
    // Neither is a comparison without the versions compared.
    { path: 'tests/x.test.ts', verdict: 'preserved', gates: ['core'] },
  ];
  const { state, repairs } = read({ ...widest(), testReplay: { ...record, files: [...record.files, ...bad] } });
  assert.deepEqual(state.testReplay, record);
  assert.equal(repairs.find((r) => r.field === 'testReplay')?.droppedCount, bad.length);
});

test('a cache entry that does not cover the gates in its key is dropped, so it can never suppress a run (#486 review)', () => {
  const twoGates: TestReplayCache = {
    ...cache,
    gates: [
      { name: 'core', command: 'npm test' },
      { name: 'e2e', command: 'npm run e2e' },
    ],
    files: [
      { path: 'tests/ok.test.ts', earliest: BLOB, verdict: 'preserved', gates: ['core', 'e2e'] },
      { path: 'tests/fails.test.ts', earliest: BLOB, verdict: 'earlier-fails', gate: 'core', gates: ['core'] },
    ],
  };
  const bad = [
    { path: 'tests/a.test.ts', earliest: BLOB, verdict: 'preserved', gates: [] },
    { path: 'tests/b.test.ts', earliest: BLOB, verdict: 'preserved', gates: ['core'] },
    { path: 'tests/c.test.ts', earliest: BLOB, verdict: 'preserved', gates: ['e2e', 'core'] },
    { path: 'tests/d.test.ts', earliest: BLOB, verdict: 'earlier-fails', gates: ['core'] },
    { path: 'tests/e.test.ts', earliest: BLOB, verdict: 'earlier-fails', gate: 'e2e', gates: ['e2e'] },
  ];
  const { state, repairs } = read({ ...widest(), testReplayCache: { ...twoGates, files: [...twoGates.files, ...bad] } });
  assert.deepEqual(state.testReplayCache, twoGates);
  assert.equal(repairs.find((r) => r.field === 'testReplayCache')?.droppedCount, bad.length);
});
