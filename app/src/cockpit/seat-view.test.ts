import { describe, expect, test } from 'vitest';
import orchestrator from '../../../src/orchestrator.ts?raw';
import pane from './ReportPane.tsx?raw';
import {
  classify,
  mergedAs,
  nearLines,
  readNearPairs,
  readReport,
  readSeatReport,
  seatLabel,
  seatSlots,
} from './artifacts';
import type { SeatSlot } from './artifacts';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import type { ArtifactEntry, Frame } from '../host';

/**
 * What each seat said on its own, and the near pairs the fixer was told about
 * (#530), read from the files the core writes beside a round - and nothing at
 * all drawn for a round that left neither.
 */

const file = (name: string, bytes = 10): ArtifactEntry => ({ name, kind: 'file', bytes });

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

describe('the names are the loop’s', () => {
  test('the seat files and the near pairs are spelled as the orchestrator writes them', () => {
    expect(orchestrator.includes('`code-review-${round}.seat-${k}.json`')).toBe(true);
    expect(orchestrator.includes('`plan-critique-${round}.seat-${k}.json`')).toBe(true);
    expect(orchestrator.includes('`fix-near-pairs-${state.reviewRound}.json`')).toBe(true);
  });

  test('a near-pairs file is numbered by the fix round, which answers the review before it', () => {
    // The core says so in the file itself: `answers` is the fix round less one.
    expect(orchestrator).toMatch(/answers: state\.reviewRound - 1/);
    // Both callers record after the round number has moved, so the pairing
    // with `code-review-<n - 1>` holds for the ordinary and the final fix.
    const fix = orchestrator.slice(orchestrator.indexOf('async function runFixRound('));
    expect(fix.indexOf('state.reviewRound += 1')).toBeLessThan(fix.indexOf('recordNearPairs('));
    const finalFix = orchestrator.slice(orchestrator.indexOf('async function runFinalFix('));
    expect(finalFix.indexOf('state.reviewRound += 1')).toBeLessThan(finalFix.indexOf('recordNearPairs('));
    expect(classify(file('fix-near-pairs-2.json'))).toMatchObject({ kind: 'near-pairs', round: 2 });
  });

  test('a seat file is never classified as a round of its own', () => {
    expect(classify(file('code-review-0.seat-1.json')).kind).toBe('other');
    expect(classify(file('plan-critique-3.seat-0.json')).kind).toBe('other');
  });
});

describe('the seats of a round', () => {
  const merge = (finders: number, failed: SeatSlot['failure'][] = []) => ({
    finders,
    failed: failed.flatMap((f, i) => (f === null ? [] : [{ finder: i + 1, ...f }])),
  });

  test('none without a seat file, so a round without finders draws as before', () => {
    expect(seatSlots([file('code-review-0.json')], 'review', 0, null)).toEqual([]);
    // Even when a merge frame says seats sat: a run from before the files were kept.
    expect(seatSlots([file('code-review-0.json')], 'review', 0, merge(3))).toEqual([]);
  });

  test('each file of this round and kind, k ascending; another round, kind or a directory is not', () => {
    const entries = [
      file('code-review-1.seat-1.json'),
      file('code-review-1.seat-0.json'),
      file('code-review-0.seat-2.json'),
      file('plan-critique-1.seat-1.json'),
      { name: 'code-review-1.seat-5.json', kind: 'directory' as const, bytes: null },
    ];
    expect(seatSlots(entries, 'review', 1, null)).toEqual([
      { k: 0, name: 'code-review-1.seat-0.json', failure: null },
      { k: 1, name: 'code-review-1.seat-1.json', failure: null },
    ]);
    expect(seatSlots(entries, 'critique', 1, null).map((s) => s.name)).toEqual(['plan-critique-1.seat-1.json']);
  });

  test('a seat the merge counted with no file is a slot of its own, with its failure when one was closed', () => {
    const failure = { seat: 'review.finders[1]', provider: 'claude', model: 'opus', label: 'review-0-f2', error: 'boom' };
    const slots = seatSlots(
      [file('code-review-0.seat-0.json'), file('code-review-0.seat-1.json')],
      'review',
      0,
      merge(4, [null, failure]),
    );
    expect(slots.map((s) => [s.k, s.name])).toEqual([
      [0, 'code-review-0.seat-0.json'],
      [1, 'code-review-0.seat-1.json'],
      [2, null],
      [3, null],
    ]);
    expect(slots[2]?.failure).toEqual(failure);
    expect(slots[3]?.failure).toBeNull();
  });
});

describe('one seat’s own report', () => {
  const body = {
    round: 0,
    k: 1,
    seat: 'review.finders[0]',
    provider: 'codex',
    model: 'gpt-5.5',
    verdict: 'changes-requested',
    summary: 'It **leaks**.',
    findings: [{ id: 'finder-id', severity: 'P1', title: 'Mutable state leaks', detail: 'x' }],
  };

  test('is read with who it was and the report as the merged one is read', () => {
    const seat = readSeatReport(JSON.stringify(body));
    expect([seat?.seat, seat?.provider, seat?.model]).toEqual(['review.finders[0]', 'codex', 'gpt-5.5']);
    expect(seat?.report.findings.map((f) => [f.id, f.title])).toEqual([['finder-id', 'Mutable state leaks']]);
    expect(seat?.report.summary).toBe('It **leaks**.');
  });

  test('an unreadable seat key drops alone; a file that is not JSON is unreadable', () => {
    const seat = readSeatReport(JSON.stringify({ ...body, provider: 7, model: undefined }));
    expect([seat?.seat, seat?.provider, seat?.model]).toEqual(['review.finders[0]', null, null]);
    expect(readSeatReport('not json')).toBeNull();
  });

  test('its tab is `<seat> <provider>/<model>` where known, and never a guessed vendor', () => {
    const slot: SeatSlot = { k: 1, name: 'code-review-0.seat-1.json', failure: null };
    expect(seatLabel(slot, readSeatReport(JSON.stringify(body)))).toBe('review.finders[0] codex/gpt-5.5');
    expect(seatLabel(slot, readSeatReport(JSON.stringify({ ...body, model: null })))).toBe('review.finders[0]');
    // Not read yet, or unreadable: the finder's number, not a path composed from it.
    expect(seatLabel(slot, null)).toBe('finder 1');
    expect(seatLabel({ ...slot, k: 0 }, null)).toBe('first seat');
    // A seat with no file, named by the failure the merge closed for it.
    const failure = { seat: 'review.finders[1]', provider: 'claude', model: 'opus', label: null, error: null };
    expect(seatLabel({ k: 2, name: null, failure }, null)).toBe('review.finders[1] claude/opus');
    expect(seatLabel({ k: 2, name: null, failure: { ...failure, provider: null, model: null } }, null)).toBe(
      'review.finders[1]',
    );
  });

  test('a seat’s finding names the merged finding it went into, by the seat and id `foundBy` names', () => {
    const merged =
      readReport(
        JSON.stringify({
          findings: [
            {
              id: 'reviewer-id',
              severity: 'P1',
              foundBy: [
                { seat: 'roles.reviewer', provider: 'codex', model: 'default', id: 'reviewer-id' },
                { seat: 'review.finders[0]', provider: 'codex', model: 'default', id: 'finder-id' },
              ],
            },
          ],
        }),
      )?.findings ?? [];
    expect(mergedAs(merged, 'review.finders[0]', 'finder-id')).toBe('reviewer-id');
    expect(mergedAs(merged, 'review.finders[1]', 'finder-id')).toBeNull();
    expect(mergedAs(merged, null, 'finder-id')).toBeNull();
  });
});

describe('the near pairs', () => {
  const text = JSON.stringify({
    round: 1,
    answers: 0,
    label: 'fix-1',
    pairs: [
      { first: 'a', second: 'b', path: 'src/x.ts', gap: 1 },
      { first: 'a', second: 'c', path: 'src/y.ts', gap: 3 },
      { first: 'd' },
      { first: 'e', second: 'f' },
    ],
  });

  test('a pair this build cannot read drops alone, and a missing path or gap drops its words', () => {
    const read = readNearPairs(text);
    expect(read?.answers).toBe(0);
    expect(read?.pairs.map((p) => [p.first, p.second])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['e', 'f'],
    ]);
    expect(nearLines('e', read?.pairs ?? [])).toEqual(['may be the same defect as f, the fixer was told']);
    expect(readNearPairs('not json')).toBeNull();
  });

  test('both findings of a pair are marked, each naming the other', () => {
    const pairs = readNearPairs(text)?.pairs ?? [];
    expect(nearLines('a', pairs)).toEqual([
      'may be the same defect as b, the fixer was told (both cite src/x.ts, 1 line apart)',
      'may be the same defect as c, the fixer was told (both cite src/y.ts, 3 lines apart)',
    ]);
    expect(nearLines('b', pairs)).toEqual(['may be the same defect as a, the fixer was told (both cite src/x.ts, 1 line apart)']);
    expect(nearLines('z', pairs)).toEqual([]);
  });
});

describe('a failed seat by its model', () => {
  const merged = say('review_finders_merged', { round: 0, finders: 2, reported: 1, findings: 1, merged: 1 });

  test('the provider and model the event carries are read', () => {
    const run = fold([
      say('review_finder_failed', {
        round: 0,
        finder: 1,
        seat: 'review.finders[0]',
        label: 'review-0-f1',
        error: 'boom',
        provider: 'claude',
        model: 'opus',
      }),
      merged,
    ]);
    expect(run.finderMerges[0]?.failed[0]).toMatchObject({ seat: 'review.finders[0]', provider: 'claude', model: 'opus' });
  });

  test('an older run’s event without them reads as null, never parsed out of the sentence', () => {
    const run = fold([
      {
        type: 'narration',
        level: 'warn',
        message: 'Review finder 1 (review.finders[0], claude/opus) failed on review-0-f1: boom',
        id: 'review_finder_failed',
        data: { round: 0, finder: 1, seat: 'review.finders[0]', label: 'review-0-f1', error: 'boom' },
      },
      merged,
    ]);
    expect(run.finderMerges[0]?.failed[0]).toMatchObject({ provider: null, model: null });
  });

  test('the pane names the model only when both are known', () => {
    expect(pane).toMatch(/f\.provider !== null && f\.model !== null && ` \$\{f\.provider\}\/\$\{f\.model\}`/);
  });
});

describe('the pane', () => {
  test('offers the seat switch only when the round has a seat, and draws a seat’s prose as Markdown', () => {
    expect(pane).toMatch(/seatViews\.length > 0 && \(\s*<SeatSwitch/);
    expect(pane).toMatch(/<Markdown text=\{own\.summary\}/);
    // The seat's findings go through the one `Finding` the merged list uses.
    expect(pane).toMatch(/own\.findings\.map\(\(f\) => \(\s*<Finding/);
  });

  test('a seat file that is missing or unreadable is said in place', () => {
    expect(pane).toMatch(/No report of \{label\}’s is beside this round/);
    expect(pane).toMatch(/\{slot\.name\} is not the report shape this build/);
  });

  test('near pairs are marked only in the merged list, from the file of the fix that answered the round', () => {
    expect(pane).toMatch(/near=\{nearLines\(f\.id, pairs\)\}/);
    expect(pane).toMatch(/ofKind\(entries, 'near-pairs'\)\.find\(\(c\) => c\.round === round \+ 1\)/);
  });
});
