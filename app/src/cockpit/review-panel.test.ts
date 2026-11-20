import { describe, expect, test } from 'vitest';
import orchestrator from '../../../src/orchestrator.ts?raw';
import {
  classify,
  confirmedBy,
  consensusFilters,
  disagreedFiles,
  inConsensus,
  outcomeEntries,
  outcomeFor,
  panelLine,
  priorLines,
  readConfirmations,
  readReport,
  scopeLine,
} from './artifacts';
import type { AnsweringRound, FullFinding } from './artifacts';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import { rounds } from './rounds';
import type { Frame } from '../host';

/**
 * The review panel at a glance (#530): the seats, the merge, the vote, the
 * seats that failed, the test verdicts each seat gave, the prior ids a seat
 * declared, and the checks after the final fix - every one read from what the
 * core already records, and every one drawing nothing on a round without a
 * panel.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const seat = (s: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  seat: s,
  provider: 'codex',
  model: 'default',
  id,
  ...extra,
});

const votes = (outcome: string): Record<string, unknown> => ({
  quorum: 2,
  n: 3,
  real: outcome === 'confirmed' ? 3 : 0,
  notReal: outcome === 'unconfirmed' ? 3 : 0,
  cannotTell: outcome === 'undecided' ? 3 : 0,
  outcome,
  ballots: [],
});

function findings(rows: Record<string, unknown>[]): readonly FullFinding[] {
  return readReport(JSON.stringify({ findings: rows }))?.findings ?? [];
}

const PANEL = findings([
  { id: 'a', severity: 'P1', foundBy: [seat('roles.reviewer', 'a'), seat('review.finders[0]', 'x')], votes: votes('confirmed') },
  { id: 'b', severity: 'P1', foundBy: [seat('review.finders[0]', 'b')], votes: votes('unconfirmed') },
  { id: 'c', severity: 'P2', foundBy: [seat('roles.reviewer', 'c')] },
]);

describe('the panel line', () => {
  const merge = { finders: 3, reported: 2, findings: 14, merged: 9 };

  test('seats and the merge from the frame, the vote from the report', () => {
    expect(panelLine(merge, PANEL)).toBe(
      '3 seats · 2 reported · 14 findings merged into 9 · 2 put to a vote: 1 confirmed, 1 unconfirmed',
    );
  });

  test('a merge count the frame did not carry is left out, not filled in', () => {
    expect(panelLine({ ...merge, findings: null }, [])).toBe('3 seats · 2 reported');
  });

  test('nothing for a round with no panel: no frame, or one seat, and no vote', () => {
    const plain = findings([{ id: 'a', severity: 'P1' }]);
    expect(panelLine(null, plain)).toBeNull();
    expect(panelLine({ ...merge, finders: 1, reported: 1 }, plain)).toBeNull();
  });

  test('a vote without finders still says what it came to', () => {
    expect(panelLine(null, findings([{ id: 'a', severity: 'P0', votes: votes('undecided') }]))).toBe(
      '1 put to a vote: 1 undecided',
    );
  });
});

describe('a seat that failed', () => {
  const failed = (finder: number, error = 'boom'): Frame =>
    say('review_finder_failed', { round: 0, finder, seat: `review.finders[${String(finder - 1)}]`, label: `review-0-f${String(finder)}`, error });
  const merged = (reported: number): Frame =>
    say('review_finders_merged', { round: 0, finders: 3, parts: 1, reported, findings: 2, merged: 2 });

  test('is carried on the merge that closed its attempt, by seat, with its error', () => {
    const run = fold([failed(2, 'the turn timed out'), merged(2)]);
    expect(run.finderMerges[0]?.failed).toEqual([
      expect.objectContaining({ finder: 2, seat: 'review.finders[1]', label: 'review-0-f2', error: 'the turn timed out' }),
    ]);
    expect(run.finderFailures).toEqual([]);
  });

  test('an earlier attempt’s failure is not named against a round where every seat reported', () => {
    const run = fold([failed(1), merged(3)]);
    expect(run.finderMerges[0]?.failed).toEqual([]);
  });

  test('never more than the seats the frame says did not report, the latest kept', () => {
    const run = fold([failed(1, 'old'), failed(2, 'old'), failed(2, 'new'), merged(2)]);
    expect(run.finderMerges[0]?.failed.map((f) => [f.seat, f.error])).toEqual([['review.finders[1]', 'new']]);
  });

  test('the critique’s failure is read the same way, and reaches the round card', () => {
    const run = fold([
      say('phase_started', { phase: 'critique', round: 0 }),
      say('critique_finder_failed', { round: 0, finder: 1, seat: 'critique.finders[0]', label: 'critique-0-f1', error: 'x' }),
      say('critique_finders_merged', { round: 0, finders: 2, reported: 1, findings: 1, merged: 1 }),
    ]);
    const card = rounds(run).find((c) => c.cycle === 'critique');
    expect(card?.finders?.failed.map((f) => f.seat)).toEqual(['critique.finders[0]']);
  });

  test('a frame with no seat is dropped alone', () => {
    const run = fold([say('review_finder_failed', { round: 0, finder: 1 }), merged(3)]);
    expect(run.finderMerges[0]?.failed).toEqual([]);
  });
});

describe('the consensus filter', () => {
  test('offered only when the round had finders or a vote', () => {
    expect(consensusFilters(findings([{ id: 'a', severity: 'P1' }]), null)).toEqual([]);
    expect(consensusFilters(PANEL, 2)).toEqual(['all', 'one-seat', 'every-seat', 'voted-on', 'voted-down']);
    // Every seat needs the frame's denominator, never the configured count.
    expect(consensusFilters(PANEL, null)).toEqual(['all', 'one-seat', 'voted-on', 'voted-down']);
  });

  test('each filter keeps what it names', () => {
    const ids = (c: Parameters<typeof inConsensus>[1], reported: number | null = 2): string[] =>
      PANEL.filter((f) => inConsensus(f, c, reported)).map((f) => f.id);
    expect(ids('all')).toEqual(['a', 'b', 'c']);
    expect(ids('one-seat')).toEqual(['b', 'c']);
    expect(ids('every-seat')).toEqual(['a']);
    expect(ids('every-seat', null)).toEqual([]);
    expect(ids('voted-on')).toEqual(['a', 'b']);
    expect(ids('voted-down')).toEqual(['b']);
  });
});

describe('each seat’s test verdict', () => {
  const report = (testChanges: unknown) => readReport(JSON.stringify({ findings: [], testChanges }));
  const v = (s: string, verdict: unknown) => ({ seat: s, provider: 'codex', model: 'default', verdict });

  test('a file the seats disagreed on is named with every seat’s word', () => {
    const files = report({
      round: 1,
      patterns: [],
      files: [
        {
          path: 'tests/a.test.ts',
          verdict: { justified: false, reason: 'weakened' },
          verdicts: [v('roles.reviewer', { justified: true, reason: 'fine' }), v('review.finders[0]', { justified: false, reason: 'weakened' })],
        },
        { path: 'tests/b.test.ts', verdict: { justified: true, reason: 'ok' }, verdicts: [v('roles.reviewer', { justified: true, reason: 'ok' }), v('review.finders[0]', { justified: true, reason: 'ok' })] },
      ],
    })?.testChanges;
    const split = disagreedFiles(files ?? []);
    expect(split.map((f) => f.path)).toEqual(['tests/a.test.ts']);
    expect(split[0]?.verdict).toBe('not justified');
    expect(split[0]?.seats.map((s) => [s.seat, s.verdict, s.reason])).toEqual([
      ['roles.reviewer', 'justified', 'fine'],
      ['review.finders[0]', 'not justified', 'weakened'],
    ]);
  });

  test('a round without finders, or without the field, has nothing to name', () => {
    expect(report(undefined)?.testChanges).toEqual([]);
    const solo = report({ files: [{ path: 'a.test.ts', verdict: 'unjudged' }] })?.testChanges ?? [];
    expect(solo).toEqual([{ path: 'a.test.ts', verdict: 'unjudged', seats: [] }]);
    expect(disagreedFiles(solo)).toEqual([]);
  });

  test('a seat entry this build cannot read is dropped alone', () => {
    const files =
      report({ files: [{ path: 'a.test.ts', verdict: 'unjudged', verdicts: [v('roles.reviewer', 'unjudged'), { seat: 'x' }, v('y', 7)] }] })
        ?.testChanges ?? [];
    expect(files[0]?.seats.map((s) => s.seat)).toEqual(['roles.reviewer']);
  });
});

describe('a prior id a seat declared', () => {
  test('carried when present, null kept as null, and an unreadable value drops the key alone', () => {
    const [f] = findings([
      {
        id: 'a',
        severity: 'P1',
        foundBy: [
          seat('roles.reviewer', 'a', { priorId: 'old-1' }),
          seat('review.finders[0]', 'b', { priorId: null }),
          seat('review.finders[1]', 'c', { priorId: 7 }),
          seat('review.finders[2]', 'd'),
        ],
      },
    ]);
    expect(f?.foundBy?.map((s) => s.priorId)).toEqual(['old-1', null, undefined, undefined]);
    expect(f?.foundBy?.[2]).not.toHaveProperty('priorId');
    expect(f?.foundBy?.[3]).not.toHaveProperty('priorId');
    expect(priorLines(f?.foundBy ?? [])).toEqual(['roles.reviewer: same as earlier finding old-1']);
  });

  test('absent everywhere, as in every run without the ledger, says nothing', () => {
    expect(priorLines(PANEL[0]?.foundBy ?? [])).toEqual([]);
  });
});

describe('the final fix’s confirmations', () => {
  const file = (name: string) => ({ name, kind: 'file' as const, bytes: 10 });

  test('the name is the loop’s, and belongs with the review before it', () => {
    expect(orchestrator.includes('`final-fix-confirm-${round}.json`')).toBe(true);
    expect(classify(file('final-fix-confirm-2.json'))).toMatchObject({ kind: 'final-fix-confirm', round: 2 });
    // Never mistaken for a review round, which would add a section.
    expect(classify(file('code-review-0.seat-1.json')).kind).toBe('other');
  });

  test('each verdict is read with its source, and one this build cannot read is dropped alone', () => {
    const read = readConfirmations(
      JSON.stringify({
        round: 2,
        since: 'abc',
        scope: 'since-last-review',
        findings: [
          {
            id: 'p1-a',
            verdict: 'fixed',
            counted: 'cannot-tell',
            source: 'seat',
            seat: { provider: 'claude', model: 'default', sharesImplementerVendor: true },
            reason: 'It is **gone**.',
            countedReason: 'its evidence resolved to nothing',
            evidence: [],
          },
          { id: 'p1-b', verdict: 'fixed', counted: 'fixed', source: 'reproducer', reason: 'passed', evidence: [] },
          { id: 'p1-c', verdict: 'cannot-tell', counted: 'cannot-tell', source: 'unread-diff', reason: 'no diff', evidence: [] },
          { id: 'broken' },
        ],
      }),
    );
    expect(read?.round).toBe(2);
    expect(read?.findings.map((c) => c.id)).toEqual(['p1-a', 'p1-b', 'p1-c']);
    const [a, b, c] = read?.findings ?? [];
    expect(a === undefined ? '' : confirmedBy(a)).toBe('checked by claude/default, on the implementer’s own vendor');
    expect(a?.countedReason).toBe('its evidence resolved to nothing');
    expect(b === undefined ? '' : confirmedBy(b)).toBe('its reproducer passed after the fix');
    // A diff that could not be read bought no turn, and must not read as a check.
    expect(c === undefined ? '' : confirmedBy(c)).toBe('no check ran');
  });

  test('the scope is said, and a file that is not JSON is unreadable rather than empty', () => {
    expect(scopeLine('since-last-review')).toMatch(/final fix’s own change/);
    expect(scopeLine('whole-run')).toMatch(/whole run’s diff/);
    expect(scopeLine(null)).toMatch(/does not say/);
    expect(readConfirmations('not json')).toBeNull();
  });
});

describe('a disposition’s reason, split off to be drawn as prose', () => {
  const answering: AnsweringRound = {
    listed: 2,
    file: { round: 2, label: 'fix-2', final: false, byId: new Map([['a', { disposition: 'not-addressed', reason: 'It is `fine`.' }]]) },
    unrecorded: false,
    raised: new Set(['a']),
  };

  test('the full line is `outcomeFor`’s, byte for byte, and the head drops only the reason', () => {
    const entries = outcomeEntries('a', answering);
    expect(entries.map((e) => e.line)).toEqual(outcomeFor('a', answering));
    expect(entries[0]).toEqual({
      line: 'fixer: not addressed - It is `fine`. (fix round 2)',
      head: 'fixer: not addressed (fix round 2)',
      reason: 'It is `fine`.',
    });
    expect(entries[1]).toEqual({ line: 'same id raised again next round', head: 'same id raised again next round', reason: null });
  });
});
