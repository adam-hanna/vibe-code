import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateStoredState } from '@src/stored.js';

/**
 * What `reviewCoverage` does to a state file that has never heard of it, and
 * what it does to one that is damaged.
 *
 * #44's rule, applied one field along from `gateOutcomes`: absence is preserved.
 * Absent means no review part has completed - a plan-only run, or one that
 * stopped before the reviewer - and that is a different fact from a review that
 * saw nothing. Unlike `gateOutcomes` a damaged record is not repaired into an
 * empty one either: nothing here feeds the exit rule, and `round` and `chunks`
 * cannot be reconstructed, so guessing them would be the fabricated number this
 * repo refuses everywhere else (#49).
 *
 * The fixture is a real post-run `state.json`, not a constructed one, for the
 * reason `gate-outcomes-state.test.ts` gives: a claim about what older state
 * looks like should be settled by an older state file.
 */

function widest(): Record<string, unknown> {
  const file = fileURLToPath(
    new URL('../../tests/fixtures/state/done-widest.json', import.meta.url),
  );
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

const coverage = {
  round: 2,
  chunks: 3,
  files: ['src/a.ts', 'src/b.ts'],
  truncated: ['src/b.ts'],
};

test('a 1.1.0 state loads with no repairs and no reviewCoverage invented', () => {
  const { state, repairs } = read(widest());

  assert.deepEqual(repairs, []);
  assert.equal('reviewCoverage' in state, false);
  assert.equal(state.reviewCoverage, undefined);
});

test('a well-formed record survives the round trip intact', () => {
  const { state, repairs } = read({ ...widest(), reviewCoverage: coverage });

  assert.deepEqual(repairs, []);
  assert.deepEqual(state.reviewCoverage, coverage);
});

test('a record the writer could never have produced is dropped, not believed', () => {
  // `round` is `reviewRound + 1` and `chunks` counts completed turns, so neither
  // is ever zero. A stored zero is damage wearing the shape of a record.
  for (const broken of [
    { ...coverage, round: 0 },
    { ...coverage, chunks: 0 },
    { ...coverage, files: 'src/a.ts' },
    { ...coverage, truncated: null },
    'nonsense',
    42,
  ]) {
    const { state, repairs } = read({ ...widest(), reviewCoverage: broken });
    assert.equal(state.reviewCoverage, undefined, JSON.stringify(broken));
    assert.deepEqual(
      repairs.map((r) => r.field),
      ['reviewCoverage'],
      JSON.stringify(broken),
    );
  }
});

test('an entry that is not a path is dropped and said out loud', () => {
  const { state, repairs } = read({
    ...widest(),
    reviewCoverage: { ...coverage, files: ['src/a.ts', 7] },
  });

  assert.deepEqual(state.reviewCoverage?.files, ['src/a.ts']);
  assert.deepEqual(
    repairs.map((r) => r.field),
    ['reviewCoverage'],
  );
});
