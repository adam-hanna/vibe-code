import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countBallot, describeVotes, failedBallot, quorumFor, tally, tallyReason } from '@src/vote.js';
import type { Ballot, VoteValue } from '@src/types.js';

/**
 * The review vote's tally (#388 Part C): fail-closed, so too few usable votes
 * can never release a finding. The truth table is enumerated whole for n = 1,
 * 2, 3 and 5, and checked against the rule stated the other way round - a
 * finding is unconfirmed exactly when the quorum is out of reach even if every
 * `cannot-tell` had been `real` - so the test is not the implementation again.
 */

function ballot(counted: VoteValue, vote: VoteValue = counted): Ballot {
  return { seat: 'review.verifiers[0]', provider: 'codex', model: 'default', vote, counted, reason: 'r', evidence: [] };
}

function ballots(real: number, notReal: number, cannotTell: number): Ballot[] {
  return [
    ...Array.from({ length: real }, () => ballot('real')),
    ...Array.from({ length: notReal }, () => ballot('not-real')),
    ...Array.from({ length: cannotTell }, () => ballot('cannot-tell')),
  ];
}

function expected(real: number, cannotTell: number, q: number): string {
  if (real >= q) return 'confirmed';
  if (real + cannotTell < q) return 'unconfirmed';
  return 'undecided';
}

for (const n of [1, 2, 3, 5]) {
  test(`every outcome for n = ${n} at the majority quorum`, () => {
    const q = Math.floor(n / 2) + 1;
    for (let real = 0; real <= n; real += 1) {
      for (let notReal = 0; real + notReal <= n; notReal += 1) {
        const cannotTell = n - real - notReal;
        const v = tally(ballots(real, notReal, cannotTell), null);
        assert.deepEqual(
          { quorum: v.quorum, n: v.n, real: v.real, notReal: v.notReal, cannotTell: v.cannotTell },
          { quorum: q, n, real, notReal, cannotTell },
        );
        assert.equal(v.outcome, expected(real, cannotTell, q), `${real}/${notReal}/${cannotTell}`);
      }
    }
  });
}

test('n = 3, written out: one cannot-tell keeps a 1-1 split blocking', () => {
  const rows: [number, number, number, string][] = [
    [3, 0, 0, 'confirmed'],
    [2, 1, 0, 'confirmed'],
    [2, 0, 1, 'confirmed'],
    [1, 2, 0, 'unconfirmed'],
    [1, 1, 1, 'undecided'],
    [1, 0, 2, 'undecided'],
    [0, 3, 0, 'unconfirmed'],
    [0, 2, 1, 'unconfirmed'],
    [0, 1, 2, 'undecided'],
    [0, 0, 3, 'undecided'],
  ];
  for (const [r, nr, ct, outcome] of rows) {
    assert.equal(tally(ballots(r, nr, ct), null).outcome, outcome, `${r}/${nr}/${ct}`);
  }
});

test('an explicit quorum: 3 of 3 needs everyone, 1 of 3 needs anyone', () => {
  assert.equal(tally(ballots(2, 0, 1), 3).outcome, 'undecided');
  assert.equal(tally(ballots(2, 1, 0), 3).outcome, 'unconfirmed');
  assert.equal(tally(ballots(3, 0, 0), 3).outcome, 'confirmed');
  assert.equal(tally(ballots(1, 2, 0), 1).outcome, 'confirmed');
  assert.equal(tally(ballots(0, 2, 1), 1).outcome, 'undecided');
  assert.equal(tally(ballots(0, 3, 0), 1).outcome, 'unconfirmed');
});

test('a null quorum is the majority, and the same number set explicitly counts the same', () => {
  for (const n of [1, 2, 3, 5]) assert.equal(quorumFor(n, null), Math.floor(n / 2) + 1);
  assert.equal(quorumFor(5, 2), 2);
  for (const [r, nr, ct] of [[2, 1, 0], [1, 1, 1], [0, 2, 1], [1, 2, 0]] as const) {
    const byDefault = tally(ballots(r, nr, ct), null);
    const set = tally(ballots(r, nr, ct), 2);
    assert.deepEqual(set, byDefault);
  }
  // And a different explicit quorum is not the majority.
  assert.notEqual(tally(ballots(2, 1, 0), 3).outcome, tally(ballots(2, 1, 0), null).outcome);
});

test('a failed turn is a cannot-tell ballot, recorded with the first line of its error', () => {
  const b = failedBallot(
    { path: 'review.verifiers[1]', setting: { provider: 'claude', model: 'opus' } },
    new Error('timed out after 5ms\nstack and more'),
  );
  assert.deepEqual(b, {
    seat: 'review.verifiers[1]',
    provider: 'claude',
    model: 'opus',
    vote: 'cannot-tell',
    counted: 'cannot-tell',
    reason: 'the turn failed: timed out after 5ms',
    evidence: [],
  });
  assert.equal(failedBallot({ path: 'p', setting: { provider: 'codex' } }, 'boom').model, 'default');
  // Three failed turns cannot release anything.
  assert.equal(tally([b, b, b], null).outcome, 'undecided');
});

test('a not-real vote whose evidence resolves to nothing is counted as cannot-tell, and says why', () => {
  assert.deepEqual(countBallot('not-real', 'it cited no evidence'), {
    counted: 'cannot-tell',
    countedReason: 'its evidence resolved to nothing: it cited no evidence',
  });
  assert.deepEqual(countBallot('not-real', null), { counted: 'not-real' });
  // A real vote needs no evidence of its own.
  assert.deepEqual(countBallot('real', 'it cited no evidence'), { counted: 'real' });
  assert.deepEqual(countBallot('cannot-tell', 'x'), { counted: 'cannot-tell' });
  // Counted, not cast, decides the tally.
  const v = tally([ballot('cannot-tell', 'not-real'), ballot('cannot-tell', 'not-real'), ballot('real')], null);
  assert.equal(v.outcome, 'undecided');
});

test('the reason names the tally, in the words the brief gives', () => {
  assert.equal(
    tallyReason(tally(ballots(1, 2, 0), null)),
    'unconfirmed by vote: 1 real, 2 not-real, 0 cannot-tell of 3 (quorum 2)',
  );
});

test('the NEEDS-INPUT lines name every ballot, its vote and its reason', () => {
  const v = tally(
    [
      { ...ballot('real'), seat: 'review.verifiers[0]', reason: 'yes it is' },
      { ...ballot('cannot-tell', 'not-real'), seat: 'review.verifiers[1]', reason: 'no', countedReason: 'its evidence resolved to nothing: x' },
    ],
    null,
  );
  const lines = describeVotes(v);
  assert.equal(lines[0], '*Vote:* 1 real, 0 not-real, 1 cannot-tell of 2 (quorum 2) - undecided');
  assert.match(lines[1] ?? '', /review\.verifiers\[0\].*real - yes it is/);
  assert.match(lines[2] ?? '', /review\.verifiers\[1\].*not-real \(counted as cannot-tell - its evidence resolved to nothing: x\) - no/);
});
