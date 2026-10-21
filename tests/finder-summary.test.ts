import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, reportReviewFinders, reportRoles } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { orchestrate } from '@src/orchestrator.js';
import { EXIT, fmtTokens } from '@src/charge.js';
import type { RunEvent, RunState } from '@src/types.js';
import { agents, BLOCKING, config, freshRun, report, reviewingRun } from './helpers/loop-harness.js';

/**
 * The run summary's finder line (#388 Part B, decision 12).
 *
 * Read, never estimated: turns and tokens from the charges - `turn_failed`
 * included, so a finder that failed after spending is counted - and the count
 * of finders that reported from the last recorded merge, which only an attempt
 * that finished its merge writes. A tally of `review_finder_failed` would keep
 * counting a failure from an attempt a resume threw away.
 */

const at = (offsetMs: number): string => new Date(Date.now() - 60_000 + offsetMs).toISOString();

function stateWith(events: RunEvent[]): RunState {
  const state = freshRun({ prefix: 'vibe-finder-summary-' });
  state.events = events;
  return state;
}

function lines(work: () => unknown): string[] {
  const out: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    out.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    work();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return out;
}

const finderLine = (out: readonly string[]): string[] => out.filter((l) => l.includes('Finders:'));

test('a failed finder turn counts toward the turns and tokens it cost', () => {
  const state = stateWith([
    { at: at(1), type: 'codex_turn', label: 'review-0', tokens: 5_000 },
    { at: at(2), type: 'codex_turn', label: 'review-0-f1', tokens: 1_000 },
    { at: at(3), type: 'turn_failed', label: 'review-0-f2', provider: 'claude', tokens: 400 },
    { at: at(4), type: 'review_finders_merged', round: 0, finders: 3, reported: 2, parts: 1, findings: 1, merged: 1 },
  ]);
  const [line] = finderLine(lines(() => reportReviewFinders(state)));
  assert.match(line ?? '', /review round 1: 2 of 3 reported/);
  assert.match(line ?? '', /2 turn\(s\) \(1 failed\)/);
  // 1,000 succeeded plus the 400 the failed turn was charged.
  assert.ok((line ?? '').includes(`, ${fmtTokens(1_400)} tokens across the run.`), line ?? 'no line');
});

test('a failure from an attempt a resume replaced does not lower the count', () => {
  const state = stateWith([
    { at: at(1), type: 'review_finder_failed', round: 0, finder: 1, seat: 'review.finders[0]', label: 'review-0-f1' },
    { at: at(2), type: 'codex_turn', label: 'review-0-f1', tokens: 1_000 },
    { at: at(3), type: 'codex_turn', label: 'review-0-f2', tokens: 1_000 },
    { at: at(4), type: 'review_finders_merged', round: 0, finders: 3, reported: 3, parts: 1, findings: 0, merged: 0 },
  ]);
  const [line] = finderLine(lines(() => reportReviewFinders(state)));
  assert.match(line ?? '', /3 of 3 reported/);
});

test('a run that seated no finder says nothing', () => {
  const state = stateWith([{ at: at(1), type: 'codex_turn', label: 'review-0', tokens: 5_000 }]);
  assert.deepEqual(finderLine(lines(() => reportReviewFinders(state))), []);
});

test('finder charges with no completed merge state the cost and claim no count', () => {
  const state = stateWith([{ at: at(1), type: 'codex_turn', label: 'review-0-f1', tokens: 1_000 }]);
  const [line] = finderLine(lines(() => reportReviewFinders(state)));
  assert.ok(
    (line ?? '').endsWith(
      `Finders:  additional finders took 1 turn(s), ${fmtTokens(1_000)} tokens across the run; no review round completed its merge.`,
    ),
    line ?? 'no line',
  );
  assert.doesNotMatch(line ?? '', / of /);
});

test('the line is in the summary of a run that stopped for input after a finder round', async () => {
  const state = reviewingRun({ prefix: 'vibe-finder-summary-run-' });
  const cfg = config(
    { p1Tolerance: 0, maxReviewRounds: 1 },
    { review: { ...DEFAULTS.review, finders: ['codex'] } },
  );
  const turns = agents({ codex: (label) => (label.startsWith('review-') ? report(BLOCKING) : report([])) }, []);
  let code = -1;
  const out: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    out.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    code = await execute(state, cfg, true, true, () => Promise.resolve(null), (s, c, r) =>
      orchestrate(s, c, r, turns),
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.notEqual(code, EXIT.OK, 'the run escalated rather than finishing');
  const [line] = finderLine(out.filter((l) => l.includes('review round')));
  assert.match(line ?? '', /Finders:\s+review round \d+: 2 of 2 reported; additional finders took \d+ turn\(s\)/);
});

test("the run's startup names the finders, and says nothing without them", () => {
  const seated = { ...DEFAULTS, review: { ...DEFAULTS.review, finders: ['codex', { provider: 'claude', model: 'opus', effort: 'high' }] } } as typeof DEFAULTS;
  assert.deepEqual(finderLine(lines(() => reportRoles(seated))), ['  Finders: codex claude@opus/high']);
  assert.deepEqual(finderLine(lines(() => reportRoles(DEFAULTS))), []);
});
