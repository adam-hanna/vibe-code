import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessConvergence,
  p1Signature,
  persistenceNotice,
  persistentStreak,
  recordRound,
} from '@src/run.js';
import { DEFAULTS } from '@src/config.js';
import type { Finding, RoundRecord, Severity } from '@src/types.js';

function findings(ids: readonly string[], severity: Severity = 'P1'): Finding[] {
  return ids.map((id) => ({ id, severity, title: id, detail: '', suggested_fix: '' }));
}

/** Builds a history the way the review loop does: one record per round. */
function historyOf(...specs: readonly (readonly string[])[]): RoundRecord[] {
  const history: RoundRecord[] = [];
  for (const ids of specs) recordRound(history, p1Signature(findings(ids)), ids.length, ids);
  return history;
}

const ARGS = {
  repeatThreshold: DEFAULTS.loop.oscillationThreshold,
  window: DEFAULTS.loop.convergenceWindow,
};

const STUCK = 'regex-group-prefix-not-literalized';

/**
 * The picomatch reimplementation, as a fixture.
 *
 * `regex-group-prefix-not-literalized` was present in rounds 3 through 8 and
 * cleared on the sixth attempt at round 9; the run then converged with
 * 1977/1977 tests passing. The old persistence rule aborted at four rounds and
 * would have killed it. Its companions rotate, so every signature differs and
 * the set rule never fires - this is the rotating-companions case, not the
 * static-set case.
 *
 * The trailing streak of STUCK per round is 0, 0, 1, 2, 3, 4, 5, 6, 0. The
 * emission expectations in tests/guard-progress.test.ts are derived from that
 * column, so it is asserted below rather than assumed.
 */
const PICOMATCH: readonly (readonly string[])[] = [
  ['a-1', 'a-2'],
  ['a-2', 'b-1', 'b-2', 'b-3'],
  [STUCK, 'b-1', 'b-2'],
  [STUCK, 'c-1', 'c-2', 'c-3'],
  [STUCK, 'c-1'],
  [STUCK, 'd-1', 'd-2'],
  [STUCK, 'd-1'],
  [STUCK, 'e-1', 'e-2'],
  ['f-1'],
];

/** A raised cap: at the default of 5 this run could never have reached round 9. */
const PICOMATCH_CAP = 12;

test('the run that converged at round 9 is never stopped early', () => {
  const history = historyOf(...PICOMATCH);

  for (let round = 1; round <= history.length; round += 1) {
    assert.equal(
      assessConvergence(history.slice(0, round), { ...ARGS, cap: PICOMATCH_CAP, round }),
      null,
      `round ${round} stopped a run that went on to pass 1977/1977 tests`,
    );
  }
});

test('the picomatch fixture has the shape the other tests rely on', () => {
  const history = historyOf(...PICOMATCH);

  // The streak column, which the emission rounds are derived from.
  const streakOf = (id: string, upTo: number): number => {
    let rounds = 0;
    for (let i = upTo - 1; i >= 0; i -= 1) {
      if (history[i]?.ids?.includes(id) !== true) break;
      rounds += 1;
    }
    return rounds;
  };
  const streaks = history.map((_, idx) => streakOf(STUCK, idx + 1));
  assert.deepEqual(streaks, [0, 0, 1, 2, 3, 4, 5, 6, 0]);

  // No companion outlives two rounds, so from the round STUCK passes the
  // threshold onward it is unambiguously the id the notice names.
  for (let round = 1; round <= history.length; round += 1) {
    const streak = persistentStreak(history.slice(0, round));
    if (streak !== null && streak.id !== STUCK) {
      assert.ok(streak.rounds < 4, `companion ${streak.id} reached ${streak.rounds} rounds`);
    }
  }
  for (const round of [6, 7, 8]) {
    assert.equal(persistentStreak(history.slice(0, round))?.id, STUCK, `round ${round}`);
  }

  // Distinct signatures every round: the set rule cannot be what is under test.
  assert.equal(new Set(history.map((r) => r.signature)).size, history.length);

  // The trend rule engages at round 8 (TREND_FLOOR) and round 9 (0.75 * 12),
  // and both windows contain a decrease - so it is not the trend rule keeping
  // the run alive either.
  assert.deepEqual(history.slice(5, 8).map((r) => r.count), [3, 2, 3]);
  assert.deepEqual(history.slice(6, 9).map((r) => r.count), [2, 3, 1]);
});

test('an id persisting ten rounds while companions rotate never stops the run', () => {
  // The anti-reintroduction guard: persistence alone, at any length, is not a
  // stop condition. Counts fall, so the trend rule stays quiet too.
  const history = historyOf(
    [STUCK, 'x-1', 'x-2', 'x-3', 'x-4'],
    [STUCK, 'x-1', 'x-2', 'x-3', 'y-1'],
    [STUCK, 'x-1', 'x-2', 'y-2'],
    [STUCK, 'x-1', 'y-3', 'y-4'],
    [STUCK, 'x-1', 'y-5'],
    [STUCK, 'x-2', 'y-6'],
    [STUCK, 'y-7'],
    [STUCK, 'y-8'],
    [STUCK],
    [STUCK],
  );

  for (let round = 1; round <= history.length; round += 1) {
    assert.equal(
      assessConvergence(history.slice(0, round), { ...ARGS, cap: PICOMATCH_CAP, round }),
      null,
      `round ${round}`,
    );
  }
  assert.equal(persistentStreak(history)?.rounds, 10);
});

test('an identical blocking set three rounds running still stops the run', () => {
  const history = historyOf([STUCK, 'g-1'], [STUCK, 'g-1'], [STUCK, 'g-1']);

  assert.match(
    assessConvergence(history, { ...ARGS, cap: PICOMATCH_CAP, round: 3 }) ?? '',
    /same P1 set came back 3 rounds/,
  );
});

test('a late count that will not fall still stops the run', () => {
  const history = historyOf(
    ['h-1', 'h-2'],
    ['h-3', 'h-4'],
    ['h-5', 'h-6'],
    ['h-7', 'h-8'],
    ['h-9', 'h-10'],
    ['h-11', 'h-12'],
    ['h-13', 'h-14'],
    ['h-15', 'h-16'],
  );

  assert.match(
    assessConvergence(history, { ...ARGS, cap: PICOMATCH_CAP, round: 8 }) ?? '',
    /has not fallen in 3 rounds/,
  );
});

const CEILINGS = ['budget.maxCostUsd ($25, Claude only)', 'budget.maxTokens (25.0M)'];

test('the notice reports what was seen and how to carry on', () => {
  const line = persistenceNotice(historyOf(...PICOMATCH).slice(0, 8), {
    minRounds: 4,
    capLimit: 'maxReviewRounds (12)',
    ceilings: CEILINGS,
  });

  assert.ok(line !== null);
  assert.match(line, new RegExp(STUCK));
  assert.match(line, /6 rounds/);
  assert.match(line, /maxReviewRounds \(12\)/);
  // The cap is an upper bound, not a promise about which brake fires.
  assert.match(line, /at the latest/);
  assert.match(line, /another brake/);
  assert.match(line, /resume/);
  for (const ceiling of CEILINGS) assert.ok(line.includes(ceiling), `missing ${ceiling}`);
  // The claim the picomatch run disproved.
  assert.doesNotMatch(line, /cannot resolve|unfixable/);
});

test('the notice fires at the threshold and not one round before', () => {
  const below = historyOf([STUCK, 'i-1'], [STUCK, 'i-2'], [STUCK, 'i-3']);
  const at = historyOf([STUCK, 'i-1'], [STUCK, 'i-2'], [STUCK, 'i-3'], [STUCK, 'i-4']);
  const args = { minRounds: 4, capLimit: 'maxReviewRounds (12)', ceilings: CEILINGS };

  assert.equal(persistenceNotice(below, args), null);
  assert.match(persistenceNotice(at, args) ?? '', /4 rounds/);
});

test('a broken streak, an empty history and a legacy record report nothing', () => {
  const args = { minRounds: 4, capLimit: 'maxReviewRounds (12)', ceilings: CEILINGS };

  assert.equal(persistenceNotice([], args), null);
  assert.equal(
    persistenceNotice(
      historyOf([STUCK], ['j-1'], [STUCK], [STUCK], [STUCK]),
      args,
    ),
    null,
    'only the trailing run counts',
  );
  // A round recorded before RoundRecord.ids existed.
  const legacy: RoundRecord[] = [{ signature: 'abc', count: 1 }];
  assert.equal(persistenceNotice(legacy, args), null);
  assert.equal(persistentStreak(legacy), null);
});

test('with no armed ceilings the notice still says the run can stop sooner', () => {
  const line = persistenceNotice(historyOf(...PICOMATCH).slice(0, 8), {
    minRounds: 4,
    capLimit: 'maxReviewRounds (12)',
    ceilings: [],
  });

  assert.ok(line !== null);
  assert.match(line, /budget ceiling or another brake/);
  assert.doesNotMatch(line, /\(budget\./);
});

test('the longest trailing streak wins when several ids persist', () => {
  const history = historyOf(['k-1'], ['k-1', 'k-2'], ['k-1', 'k-2'], ['k-1', 'k-2']);

  assert.deepEqual(persistentStreak(history), { id: 'k-1', rounds: 4 });
});
