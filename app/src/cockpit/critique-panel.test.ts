import { describe, expect, test } from 'vitest';
import settings from './Settings.tsx?raw';
import { quorumPatch, seatsPatch, toRow } from './seatform';
import { readReport, votesLine } from './artifacts';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import { rounds } from './rounds';
import { turnSentence } from './format';
import type { Frame } from '../host';

/**
 * The plan critique's panel (#405) in the window: its settings save under
 * `critique` while the review's still save under `review`, and a critique round
 * card carries its finders' merge and its findings' votes, as a review card
 * does. The pane that draws them is the review's own (`ReportPane`), so what is
 * pinned here is what reaches it.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

describe('the critique seats save under critique', () => {
  test('a seat list, a quorum and nothing else move section; the review keeps its own', () => {
    const rows = [toRow({ provider: 'codex' })];
    expect(seatsPatch('finders', rows, 'critique')).toEqual({ critique: { finders: [{ provider: 'codex' }] } });
    expect(seatsPatch('verifiers', [], 'critique')).toEqual({ critique: { verifiers: [] } });
    expect(quorumPatch('2', 'critique')).toEqual({ critique: { quorum: 2 } });
    expect(quorumPatch('', 'critique')).toEqual({ critique: { quorum: null } });
    // Every review call is unchanged.
    expect(seatsPatch('finders', rows)).toEqual({ review: { finders: [{ provider: 'codex' }] } });
    expect(quorumPatch('')).toEqual({ review: { quorum: null } });
  });

  test('the settings page has the critique section directly after the review one, all of it writing under critique', () => {
    const reviewAt = settings.indexOf('who else reviews, and who votes</h3>');
    const reviewEnd = settings.indexOf('</section>', reviewAt);
    const at = settings.indexOf('who else critiques the plan, and who votes</h3>');
    expect(reviewAt).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(reviewEnd);
    // Nothing between the two sections but the new one's opening.
    const between = settings.slice(reviewEnd + '</section>'.length, at);
    expect(between.match(/<section/g)).toHaveLength(1);
    expect(between).not.toContain('</section>');
    const section = settings.slice(at, settings.indexOf('</section>', at));
    expect(section.match(/<SeatList\s+kind="(finders|verifiers)"\s+section="critique"/g)).toHaveLength(2);
    expect(section).toMatch(/<QuorumField\s+id="critique-quorum"\s+section="critique"/);
    expect(section).toContain("onChange={() => save({ critique: { unconfirmedP0: choice.value } })}");
    expect(section).toContain("source('critique', 'quorum')");
    expect(section).toContain("source('critique', 'unconfirmedP0')");
    expect(section).not.toMatch(/save\(\{ review:/);
    // Its note states the cost in turns, and says nothing about accuracy.
    const noteAt = section.indexOf('<p className={S.note}>');
    const note = section.slice(noteAt, section.indexOf('</p>', noteAt)).replace(/\s+/g, ' ');
    expect(note).toContain('one extra turn per plan round per finder');
    expect(note).toContain('one extra turn per such finding per verifier, every plan round');
    expect(note).not.toMatch(/accura|precis|reliab/i);
    // The review's section still saves under review.
    expect(settings.slice(reviewAt, reviewEnd)).toContain("save({ review: { unconfirmedP0: choice.value } })");
    expect(settings.slice(reviewAt, reviewEnd)).not.toContain('section="critique"');
  });
});

describe('a critique round card', () => {
  const MERGED = { round: 0, finders: 2, reported: 2, findings: 3, merged: 2, byCitation: 1, byTitle: 0 };
  const TALLY = { round: 0, findings: 1, verifiers: 3, votes: 3, confirmed: 0, unconfirmed: 1, moved: 1, held: 0, undecided: 0, deferred: 0 };

  test('carries its finders\' merge, and the vote tally is kept', () => {
    const run = fold([
      say('phase_started', { phase: 'critique', round: 0 }),
      say('turn_started', { role: 'critic', kind: 'critique', round: 0 }),
      say('turn_started', { role: 'critic', kind: 'critique', round: 0, finder: 1, seat: 'critique.finders[0]' }),
      say('critique_finders_merged', MERGED),
      say('turn_started', { role: 'critic', kind: 'vote', round: 0, verifier: 1, seat: 'critique.verifiers[0]' }),
      say('critique_votes_tallied', TALLY),
    ]);
    expect(run.finderMerges).toHaveLength(1);
    expect(rounds(run).find((c) => c.cycle === 'critique')?.finders?.reported).toBe(2);
    expect(run.voteTallies[0]).toMatchObject({ round: 0, findings: 1, verifiers: 3, unconfirmed: 1, reproduced: null });
  });

  test('a plan-critique finding the vote moved reads its votes and its downgrade, as a review finding does', () => {
    const report = readReport(
      JSON.stringify({
        findings: [
          {
            id: 'weak-claim',
            severity: 'P2',
            downgraded: { from: 'P1', reason: 'unconfirmed by vote: 1 real, 2 not-real, 0 cannot-tell of 3 (quorum 2)' },
            foundBy: [{ seat: 'roles.critic', provider: 'codex', model: 'default', id: 'weak-claim' }],
            votes: {
              quorum: 2,
              n: 3,
              real: 1,
              notReal: 2,
              cannotTell: 0,
              outcome: 'unconfirmed',
              ballots: [
                { seat: 'critique.verifiers[0]', provider: 'codex', model: 'default', vote: 'not-real', counted: 'not-real', reason: 'No.', evidence: [] },
              ],
            },
          },
        ],
      }),
    );
    const f = report?.findings[0];
    expect(f?.votes && votesLine(f.votes)).toBe('vote: 1 of 3 real, 2 not real (quorum 2), unconfirmed');
    expect(f?.downgraded?.from).toBe('P1');
    expect(f?.foundBy?.[0]?.seat).toBe('roles.critic');
  });

  test("a critique verifier's turn reads as what it is", () => {
    expect(turnSentence({ role: 'critic', kind: 'vote' })).toBe('The critic is checking whether a finding is real.');
  });
});
