import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateStoredState } from '@src/stored.js';

/**
 * `state.reviewMd` on the way back in (#389). Absent stays absent - every run
 * from before it has none - a well-formed record round-trips with no repairs,
 * and a damaged one is dropped whole, `readStart`'s rule: a repaired record
 * would describe a read nobody made.
 */

const SHA = 'a'.repeat(40);
const BLOB = 'b'.repeat(40);

function widest(): Record<string, unknown> {
  const file = fileURLToPath(new URL('../../tests/fixtures/state/done-widest.json', import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

test('a state written before the field existed loads with no repairs and no record', () => {
  const { state, repairs } = read(widest());
  assert.deepEqual(repairs, []);
  assert.equal(state.reviewMd, undefined);
});

for (const record of [
  { commit: SHA, outcome: 'present', blob: BLOB, bytes: 4200 },
  { commit: SHA, outcome: 'absent' },
  { commit: SHA, outcome: 'refused', reason: 'REVIEW.md is a symbolic link' },
  { commit: SHA, outcome: 'unreadable', blob: BLOB, bytes: 1, reason: 'the recorded blob no longer matches' },
]) {
  test(`a ${record.outcome} record round-trips with no repairs`, () => {
    const { state, repairs } = read({ ...widest(), reviewMd: record });
    assert.deepEqual(repairs, []);
    assert.deepEqual(state.reviewMd, record);
  });
}

for (const bad of [
  'present',
  { commit: 'abc1234', outcome: 'absent' },
  { commit: SHA, outcome: 'present' },
  { commit: SHA, outcome: 'present', blob: BLOB },
  { commit: SHA, outcome: 'present', blob: 'nope', bytes: 1 },
  { commit: SHA, outcome: 'present', blob: BLOB, bytes: -1 },
  { commit: SHA, outcome: 'refused' },
  { commit: SHA, outcome: 'unreadable', reason: '' },
  { commit: SHA, outcome: 'maybe' },
]) {
  test(`a damaged record ${JSON.stringify(bad)} is dropped and says so`, () => {
    const { state, repairs } = read({ ...widest(), reviewMd: bad });
    assert.equal(state.reviewMd, undefined);
    assert.ok(
      repairs.some((r) => JSON.stringify(r).includes('reviewMd')),
      'the drop is reported, not silent',
    );
  });
}
