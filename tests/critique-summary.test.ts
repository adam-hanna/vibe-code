import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  reportCritiqueFinders,
  reportCritiqueVotes,
  reportReviewFinders,
  reportReviewVotes,
  reportUnconfirmedByVote,
} from '@src/cli.js';
import { orchestrate } from '@src/orchestrator.js';
import { DEFAULTS } from '@src/config.js';
import { fmtTokens } from '@src/charge.js';
import { agents, config, freshRun, p1, planFixture, report } from './helpers/loop-harness.js';
import type { Evidence, RunEvent, RunState } from '@src/types.js';

/**
 * The run summary's critique lines (#405), on the review's rule: the cost from
 * the critique's own finder and vote charges, and the outcome from the last
 * `critique_finders_merged` / `critique_votes_tallied`. The review's lines count
 * only the review's turns, so neither claims the other's spend.
 */

const at = (offsetMs: number): string => new Date(Date.now() - 60_000 + offsetMs).toISOString();

function stateWith(events: RunEvent[]): RunState {
  const state = freshRun({ prefix: 'vibe-critique-summary-' });
  state.events = events;
  return state;
}

function lines(work: () => unknown): string[] {
  const out: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => void out.push(parts.map((p) => String(p)).join(' '));
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

const EVENTS: RunEvent[] = [
  { at: at(1), type: 'codex_turn', label: 'critique-0', tokens: 5_000 },
  { at: at(2), type: 'codex_turn', label: 'critique-0-f1', tokens: 1_000 },
  { at: at(3), type: 'turn_failed', label: 'critique-0-f2', provider: 'claude', tokens: 200 },
  { at: at(4), type: 'critique_finders_merged', round: 0, finders: 3, reported: 2, findings: 3, merged: 2, byCitation: 1, byTitle: 0 },
  { at: at(5), type: 'codex_turn', label: 'critique-0-vote-1-v1', tokens: 700 },
  { at: at(6), type: 'codex_turn', label: 'critique-0-vote-1-v2', tokens: 300 },
  {
    at: at(7),
    type: 'critique_votes_tallied',
    round: 0,
    findings: 1,
    verifiers: 2,
    votes: 2,
    confirmed: 0,
    unconfirmed: 1,
    moved: 1,
    held: 0,
    undecided: 0,
    deferred: 0,
  },
];

test('the critique lines give the turns and tokens of the critique seats, and the last round they came to', () => {
  const state = stateWith(EVENTS);
  assert.deepEqual(
    lines(() => reportCritiqueFinders(state)),
    [
      `  Critique finders: plan critique round 1: 2 of 3 reported; additional finders took 2 turn(s) (1 failed), ${fmtTokens(1_200)} tokens across the run.`,
    ],
  );
  assert.deepEqual(
    lines(() => reportCritiqueVotes(state)),
    [
      `  Critique votes: plan critique round 1: 1 finding(s) voted on - 0 confirmed, 1 unconfirmed, 0 undecided; the vote took 2 turn(s), ${fmtTokens(1_000)} tokens across the run.`,
    ],
  );
});

test("the review's lines do not count a critique seat's turns, and the critique's do not count the review's", () => {
  const critiqueOnly = stateWith(EVENTS);
  assert.deepEqual(lines(() => reportReviewFinders(critiqueOnly)), []);
  assert.deepEqual(lines(() => reportReviewVotes(critiqueOnly)), []);

  const reviewOnly = stateWith([
    { at: at(1), type: 'codex_turn', label: 'review-0-f1', tokens: 1_000 },
    { at: at(2), type: 'codex_turn', label: 'vote-0-1-v1', tokens: 1_000 },
  ]);
  assert.deepEqual(lines(() => reportCritiqueFinders(reviewOnly)), []);
  assert.deepEqual(lines(() => reportCritiqueVotes(reviewOnly)), []);
  assert.equal(lines(() => reportReviewFinders(reviewOnly)).length, 1);
});

test('critique charges with no completed merge or tally state the cost and claim no count', () => {
  const state = stateWith([
    { at: at(1), type: 'codex_turn', label: 'critique-0-f1', tokens: 1_000 },
    { at: at(2), type: 'codex_turn', label: 'critique-0-vote-1-v1', tokens: 1_000 },
  ]);
  assert.match(lines(() => reportCritiqueFinders(state))[0] ?? '', /no plan critique round completed its merge\.$/);
  assert.match(lines(() => reportCritiqueVotes(state))[0] ?? '', /no plan critique round completed its tally\.$/);
});

test('a plan finding the critique vote moved is named as the critique vote\'s, with its tally', async () => {
  const state = freshRun({ prefix: 'vibe-critique-unconfirmed-' });
  writeFileSync(path.join(state.targetDir, 'widget.ts'), 'export const widget = 1;\n', 'utf8');
  const here: Evidence = { kind: 'code', path: 'widget.ts', line: 1 };
  const notReal = { vote: 'not-real', reason: 'No.', evidence: [{ ...here, excerpt: null, ref: null }] };
  const cfg = config({ p1Tolerance: 0 }, { critique: { ...DEFAULTS.critique, verifiers: ['codex', 'codex', 'codex'] } });
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(
      state,
      cfg,
      false,
      agents(
        {
          claude: () => planFixture(),
          codex: (label) =>
            label.includes('-vote-') ? notReal : report(label === 'critique-0' ? [{ ...p1('weak-claim'), evidence: [here] }] : []),
        },
        [],
      ),
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  const out = lines(() => reportUnconfirmedByVote(state));
  assert.equal(
    out[0],
    '  ! 1 blocking plan finding(s) the critique vote did not confirm - no longer blocking, and listed as unconfirmed by vote in FOLLOW-UPS.md:',
  );
  assert.equal(
    out[1],
    '    - `weak-claim` Finding weak-claim - 3 of 3 verifier(s) did not confirm (3 not real, 0 could not tell; quorum 2), was P1',
  );
  assert.equal(out.some((l) => l.includes('the review vote')), false);
  assert.match(out[2] ?? '', /Detail: .*FOLLOW-UPS\.md$/);
});
