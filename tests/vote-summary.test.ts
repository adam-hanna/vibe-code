import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportReviewVotes, reportRoles } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { fmtTokens } from '@src/charge.js';
import type { RunEvent, RunState } from '@src/types.js';
import { freshRun } from './helpers/loop-harness.js';

/**
 * The run summary's vote line (#388 Part C), on Part B's rule: the cost from
 * the charges, `turn_failed` included, and the outcome from the last
 * `review_votes_tallied` event - never from adding up failures.
 */

const at = (offsetMs: number): string => new Date(Date.now() - 60_000 + offsetMs).toISOString();

function stateWith(events: RunEvent[]): RunState {
  const state = freshRun({ prefix: 'vibe-vote-summary-' });
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

const voteLine = (out: readonly string[]): string[] => out.filter((l) => l.includes('Votes:'));

const TALLY = { confirmed: 0, unconfirmed: 0, moved: 0, held: 0, undecided: 0, reproduced: 0, verifiers: 2 };

test('vote turns are charged, failures included, and the last tally is the one read', () => {
  const state = stateWith([
    { at: at(1), type: 'codex_turn', label: 'review-0', tokens: 5_000 },
    { at: at(2), type: 'codex_turn', label: 'vote-0-1-v1', tokens: 1_000 },
    { at: at(3), type: 'turn_failed', label: 'vote-0-1-v2', provider: 'claude', tokens: 400 },
    { at: at(4), type: 'review_votes_tallied', ...TALLY, round: 0, findings: 1, votes: 2, undecided: 1 },
    { at: at(5), type: 'codex_turn', label: 'vote-1-2-v1', tokens: 600 },
    { at: at(6), type: 'review_votes_tallied', ...TALLY, round: 1, findings: 2, votes: 2, confirmed: 1, unconfirmed: 1 },
  ]);
  const [line] = voteLine(lines(() => reportReviewVotes(state)));
  assert.ok(
    (line ?? '').endsWith(
      `Votes:    review round 2: 2 finding(s) voted on - 1 confirmed, 1 unconfirmed, 0 undecided; ` +
        `the vote took 3 turn(s) (1 failed), ${fmtTokens(2_000)} tokens across the run.`,
    ),
    line ?? 'no line',
  );
});

test('vote charges with no tally state the cost and claim no outcome', () => {
  const state = stateWith([{ at: at(1), type: 'codex_turn', label: 'vote-0-1-v1', tokens: 1_000 }]);
  const [line] = voteLine(lines(() => reportReviewVotes(state)));
  assert.ok((line ?? '').endsWith('no review round completed its tally.'), line ?? 'no line');
});

test('a run that cast no vote says nothing', () => {
  const state = stateWith([{ at: at(1), type: 'codex_turn', label: 'review-0-f1', tokens: 5_000 }]);
  assert.deepEqual(voteLine(lines(() => reportReviewVotes(state))), []);
});

test("the run's startup names the verifiers, and says nothing without them", () => {
  const seated = {
    ...DEFAULTS,
    review: { ...DEFAULTS.review, verifiers: ['codex', { provider: 'claude', model: 'opus', effort: 'high' }] },
  } as typeof DEFAULTS;
  const named = (out: readonly string[]): string[] => out.filter((l) => l.includes('Verifiers:'));
  assert.deepEqual(named(lines(() => reportRoles(seated))), ['  Verifiers: codex claude@opus/high']);
  assert.deepEqual(named(lines(() => reportRoles(DEFAULTS))), []);
});
