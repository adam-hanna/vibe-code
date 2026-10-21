import { describe, expect, test } from 'vitest';
import { ballotLine, readReport, votesLine } from './artifacts';
import type { Votes } from './artifacts';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import { turnSentence } from './format';
import type { Frame } from '../host';

/**
 * A finding's vote (#388 Part C), read off the round's own `code-review-<n>.json`,
 * and the round's tally off the `review_votes_tallied` frame. Every number is
 * the core's; a vote this window cannot read is dropped rather than completed.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const VOTES = {
  quorum: 2,
  n: 3,
  real: 1,
  notReal: 2,
  cannotTell: 0,
  outcome: 'unconfirmed',
  ballots: [
    { seat: 'review.verifiers[0]', provider: 'codex', model: 'default', vote: 'real', counted: 'real', reason: 'It is there.', evidence: [] },
    { seat: 'review.verifiers[1]', provider: 'claude', model: 'opus', vote: 'not-real', counted: 'not-real', reason: 'Handled on line 4.', evidence: [] },
    { seat: 'review.verifiers[2]', provider: 'codex', model: 'default', vote: 'not-real', counted: 'not-real', reason: 'Guarded above.', evidence: [] },
  ],
};

describe('votes, read off the report', () => {
  test('a finding put to a vote carries the tally and every ballot', () => {
    const report = readReport(JSON.stringify({ findings: [{ id: 'a', severity: 'P2', votes: VOTES }] }));
    const votes = report?.findings[0]?.votes;
    expect(votes).toMatchObject({ quorum: 2, n: 3, real: 1, notReal: 2, cannotTell: 0, outcome: 'unconfirmed' });
    expect(votes?.ballots.map((b) => b.seat)).toEqual(['review.verifiers[0]', 'review.verifiers[1]', 'review.verifiers[2]']);
    expect(votes?.ballots[1]?.countedReason).toBeNull();
  });

  test('a finding with no vote has none, and a vote whose counts cannot be read is dropped', () => {
    const plain = readReport(JSON.stringify({ findings: [{ id: 'a', severity: 'P1' }] }));
    expect(plain?.findings[0]?.votes).toBeNull();
    const junk = readReport(JSON.stringify({ findings: [{ id: 'a', severity: 'P1', votes: { ...VOTES, real: 'one' } }] }));
    expect(junk?.findings[0]?.votes).toBeNull();
  });

  test('a ballot this build cannot read is dropped alone', () => {
    const report = readReport(
      JSON.stringify({ findings: [{ id: 'a', severity: 'P1', votes: { ...VOTES, ballots: [VOTES.ballots[0], { seat: 7 }, null] } }] }),
    );
    expect(report?.findings[0]?.votes?.ballots).toHaveLength(1);
  });
});

describe('votesLine and ballotLine', () => {
  const votes = readReport(JSON.stringify({ findings: [{ id: 'a', severity: 'P2', votes: VOTES }] }))?.findings[0]
    ?.votes as Votes;

  test('the tally in the words the brief gives', () => {
    expect(votesLine(votes)).toBe('vote: 1 of 3 real, 2 not real (quorum 2), unconfirmed');
  });

  test('cannot-tell is said only when there was one', () => {
    expect(votesLine({ ...votes, notReal: 1, cannotTell: 1, outcome: 'undecided' })).toBe(
      'vote: 1 of 3 real, 1 not real, 1 cannot tell (quorum 2), undecided',
    );
  });

  test('a ballot names its seat, its vote and its reason, and how it was counted when that differs', () => {
    expect(ballotLine(votes.ballots[1] as Votes['ballots'][number])).toBe('review.verifiers[1]: not-real — Handled on line 4.');
    expect(
      ballotLine({ ...(votes.ballots[1] as Votes['ballots'][number]), counted: 'cannot-tell', countedReason: 'x' }),
    ).toBe('review.verifiers[1]: not-real (counted as cannot-tell) — Handled on line 4.');
  });
});

describe('review_votes_tallied, folded', () => {
  const TALLY = { round: 1, findings: 3, verifiers: 3, votes: 9, confirmed: 1, unconfirmed: 1, moved: 1, held: 0, undecided: 1, reproduced: 1 };

  test('the frame is kept with its counts', () => {
    const run = fold([say('review_votes_tallied', TALLY)]);
    expect(run.voteTallies).toHaveLength(1);
    expect(run.voteTallies[0]).toMatchObject({
      round: 1,
      findings: 3,
      verifiers: 3,
      votes: 9,
      confirmed: 1,
      unconfirmed: 1,
      undecided: 1,
      reproduced: 1,
    });
  });

  test('a frame missing either count is dropped rather than guessed', () => {
    const { findings: _findings, ...noFindings } = TALLY;
    const { verifiers: _verifiers, ...noVerifiers } = TALLY;
    const run = fold([say('review_votes_tallied', noFindings), say('review_votes_tallied', noVerifiers)]);
    expect(run.voteTallies).toEqual([]);
  });

  test('a run with no verifiers has no tally', () => {
    const run = fold([say('turn_started', { role: 'reviewer', kind: 'review', round: 0 })]);
    expect(run.voteTallies).toEqual([]);
  });

  test('a vote turn reads as what it is', () => {
    expect(turnSentence({ role: 'reviewer', kind: 'vote' })).toBe('The reviewer is checking whether a finding is real.');
  });
});
