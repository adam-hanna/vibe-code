import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateStoredState } from '@src/stored.js';
import type { JudgeEditedAfterReview, JudgeSnapshot } from '@src/types.js';

/**
 * `judgeAtLastReview` and `judgeEditedAfterReview` across a stop and a resume
 * (#485), in `testChanges`'s style: absence is preserved, a well-formed record
 * round-trips with no repairs, a damaged entry is dropped and said, and a
 * damaged record drops the key - which for the snapshot means the run says its
 * edits after the last review could not be checked.
 */

function widest(): Record<string, unknown> {
  const file = fileURLToPath(new URL('../../tests/fixtures/state/done-widest.json', import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

const BLOB = '0123456789abcdef0123456789abcdef01234567';

const snapshot: JudgeSnapshot = {
  round: 2,
  files: [
    { path: 'tests/a.test.ts', blob: BLOB },
    { path: 'tests/gone.test.ts', blob: null },
  ],
};

const edited: JudgeEditedAfterReview = {
  sinceRound: 2,
  files: [
    { path: 'tests/a.test.ts', oldPath: null, status: 'modified', added: 1, removed: 2 },
    { path: 'tests/b.bin', oldPath: null, status: 'added', added: null, removed: null },
  ],
  restored: ['tests/c.test.ts'],
};

test('a state written before the fields existed loads with no repairs and neither record', () => {
  const { state, repairs } = read(widest());
  assert.deepEqual(repairs, []);
  assert.equal(state.judgeAtLastReview, undefined);
  assert.equal(state.judgeEditedAfterReview, undefined);
});

test('well-formed records survive the round trip intact, with no repairs', () => {
  const { state, repairs } = read({ ...widest(), judgeAtLastReview: snapshot, judgeEditedAfterReview: edited });
  assert.deepEqual(repairs, []);
  assert.deepEqual(state.judgeAtLastReview, snapshot);
  assert.deepEqual(state.judgeEditedAfterReview, edited);
  assert.equal(JSON.stringify(state.judgeEditedAfterReview), JSON.stringify(edited));

  const { files } = edited;
  const plain = read({ ...widest(), judgeEditedAfterReview: { sinceRound: 1, files } });
  assert.deepEqual(plain.repairs, []);
  assert.equal('restored' in (plain.state.judgeEditedAfterReview ?? {}), false);
});

test('a malformed snapshot entry is named by its path, and the snapshot is not used at all', () => {
  // Not repaired down to the rest: a restored path missing from the snapshot is
  // missing from the end listing too, and would pass in silence.
  for (const bad of ['nonsense', { path: 7, blob: BLOB }, { path: 'tests/x.ts', blob: 'not-a-hash' }, { path: 'tests/x.ts' }]) {
    const { state, repairs } = read({
      ...widest(),
      judgeAtLastReview: { ...snapshot, files: [snapshot.files[0], bad, snapshot.files[1]] },
    });
    assert.equal(state.judgeAtLastReview, undefined, JSON.stringify(bad));
    assert.deepEqual(
      repairs.map((r) => [r.field, r.droppedPaths]),
      [['judgeAtLastReview', ['judgeAtLastReview.files[1]']]],
      JSON.stringify(bad),
    );
  }
});

test('a malformed file or restored entry in the result is dropped by its path and said', () => {
  const [first, second] = edited.files;
  for (const bad of ['nonsense', { ...first, status: 'copied' }, { ...first, added: -1 }, { ...first, path: null }]) {
    const { state, repairs } = read({
      ...widest(),
      judgeEditedAfterReview: { ...edited, files: [first, bad, second] },
    });
    assert.deepEqual(state.judgeEditedAfterReview, edited, JSON.stringify(bad));
    assert.deepEqual(
      repairs.map((r) => [r.field, r.droppedPaths]),
      [['judgeEditedAfterReview', ['judgeEditedAfterReview.files[1]']]],
      JSON.stringify(bad),
    );
  }

  const entry = read({ ...widest(), judgeEditedAfterReview: { ...edited, restored: [3, 'tests/c.test.ts'] } });
  assert.deepEqual(entry.state.judgeEditedAfterReview, edited);
  assert.deepEqual(
    entry.repairs.map((r) => [r.field, r.droppedPaths]),
    [['judgeEditedAfterReview', ['judgeEditedAfterReview.restored[0]']]],
  );

  for (const bad of ['tests/c.test.ts', { 0: 'x' }, null]) {
    const list = read({ ...widest(), judgeEditedAfterReview: { ...edited, restored: bad } });
    assert.equal('restored' in (list.state.judgeEditedAfterReview ?? {}), false, JSON.stringify(bad));
    assert.deepEqual(list.state.judgeEditedAfterReview?.files, edited.files);
    assert.deepEqual(
      list.repairs.map((r) => [r.field, r.droppedPaths]),
      [['judgeEditedAfterReview', ['judgeEditedAfterReview.restored']]],
      JSON.stringify(bad),
    );
  }

  // Every restored entry dropped leaves the key out, as the writer leaves it out.
  const empty = read({ ...widest(), judgeEditedAfterReview: { ...edited, restored: [false] } });
  assert.equal('restored' in (empty.state.judgeEditedAfterReview ?? {}), false);
});

test('a damaged record drops its key, once, and says so', () => {
  for (const broken of [{ ...snapshot, round: 0 }, { ...snapshot, files: null }, 'nonsense', null]) {
    const { state, repairs } = read({ ...widest(), judgeAtLastReview: broken });
    assert.equal(state.judgeAtLastReview, undefined, JSON.stringify(broken));
    assert.deepEqual(repairs.map((r) => [r.field, r.droppedPaths]), [['judgeAtLastReview', ['judgeAtLastReview']]]);
  }
  for (const broken of [{ ...edited, sinceRound: 0 }, { ...edited, files: 'tests' }, 'nonsense', 3]) {
    const { state, repairs } = read({ ...widest(), judgeEditedAfterReview: broken });
    assert.equal(state.judgeEditedAfterReview, undefined, JSON.stringify(broken));
    assert.deepEqual(
      repairs.map((r) => [r.field, r.droppedPaths]),
      [['judgeEditedAfterReview', ['judgeEditedAfterReview']]],
    );
  }
});
