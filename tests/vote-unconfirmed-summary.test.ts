import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { reportUnconfirmedByVote } from '@src/cli.js';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { DEFAULTS } from '@src/config.js';
import { agents, config, p1, report, reviewingRun } from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, Evidence, Finding, ReviewConfig, RunState } from '@src/types.js';

/**
 * The end-of-run summary names each blocking finding the review vote did not
 * confirm (#436), beside the `Votes:` line that counts them: its id, its title
 * and the tally read from its recorded votes, with a pointer to FOLLOW-UPS.md.
 *
 * Each case drives the real loop through the harness with verifiers scripted,
 * so the findings the reporter reads are the ones `applyVotes` and
 * `collectDeferred` actually stored - not a hand-built state that could drift
 * from what a run writes.
 */

const HERE: Evidence = { kind: 'code', path: 'implemented.ts', line: 1 };
const REAL = { vote: 'real', reason: 'It is there.', evidence: [] };
const NOT_REAL = { vote: 'not-real', reason: 'It is handled on line 1.', evidence: [{ ...HERE, excerpt: null, ref: null }] };
const CANNOT_TELL = { vote: 'cannot-tell', reason: 'Could not settle it.', evidence: [] };
const THREE: ReviewConfig['verifiers'] = ['codex', 'codex', 'codex'];

function withReview(review: Partial<ReviewConfig>): Config {
  return config({ p1Tolerance: 0 }, { review: { ...DEFAULTS.review, ...review } });
}

function blocker(id: string): Finding {
  return { ...p1(id), evidence: [HERE] };
}

/** Votes by verifier, `v1` first; one list per finding, by its place in the report. */
function ballots(...perFinding: unknown[][]): (label: string) => unknown {
  return (label) => {
    const m = /^vote-\d+-(\d+)-v(\d+)$/.exec(label);
    return perFinding[Number(m?.[1] ?? '1') - 1]?.[Number(m?.[2] ?? '1') - 1];
  };
}

/** Round 0 raises `found`; every later review approves. */
function handlers(found: readonly Finding[], votes: (label: string) => unknown): Handlers {
  const answer = (label: string): unknown => {
    if (label.startsWith('vote-')) return votes(label);
    return label === 'review-0' ? report(found) : report([]);
  };
  return {
    codex: (label) => answer(label),
    claude: (label) => (label.startsWith('vote-') ? votes(label) : 'done'),
  };
}

async function drive(state: RunState, cfg: Config, h: Handlers): Promise<void> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, true, agents(h, []));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** What the reporter prints, and what it narrates. */
function capture(state: RunState): { out: string[]; seen: Narration[] } {
  const out: string[] = [];
  const seen: Narration[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => void out.push(parts.map((p) => String(p)).join(' '));
  console.log = collect;
  console.error = collect;
  log.setSink((n) => void seen.push(n));
  try {
    reportUnconfirmedByVote(state);
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return { out, seen };
}

test('the summary names each finding the vote did not confirm, with the tally from its votes', async () => {
  const state = reviewingRun({ prefix: 'vibe-unconfirmed-named-' });
  await drive(
    state,
    withReview({ verifiers: THREE }),
    handlers(
      [blocker('the-claim'), blocker('the-other')],
      ballots([NOT_REAL, REAL, NOT_REAL], [NOT_REAL, NOT_REAL, CANNOT_TELL]),
    ),
  );
  assert.equal(state.status, 'done');
  const { out, seen } = capture(state);
  const messages = seen.map((n) => n.message);
  assert.deepEqual(messages, [
    '2 blocking finding(s) the review vote did not confirm - no longer blocking, and listed as ' +
      'unconfirmed by vote in FOLLOW-UPS.md:',
    '  - `the-claim` Finding the-claim - 2 of 3 verifier(s) did not confirm ' +
      '(2 not real, 0 could not tell; quorum 2), was P1',
    '  - `the-other` Finding the-other - 3 of 3 verifier(s) did not confirm ' +
      '(2 not real, 1 could not tell; quorum 2), was P1',
    `  Detail: ${path.join(state.dir, 'FOLLOW-UPS.md')}`,
  ]);
  assert.equal(seen[0]?.level, 'warn', 'the header is a warning, as the unjustified-tests line is');
  assert.equal(out.length, 4);
});

test('a finding whose recorded votes cannot be read is listed as such, never as a count', async () => {
  const state = reviewingRun({ prefix: 'vibe-unconfirmed-unreadable-' });
  await drive(
    state,
    withReview({ verifiers: THREE }),
    handlers([blocker('the-claim'), blocker('the-other')], ballots([NOT_REAL, NOT_REAL, REAL], [NOT_REAL, NOT_REAL, REAL])),
  );
  // `votes` rides through stored state unvalidated: one record whose counts
  // disagree with its ballots, and one whose ballots are gone.
  const stored = state.deferred ?? [];
  assert.equal(stored.length, 2);
  const [first, second] = stored;
  if (first?.votes === undefined || second?.votes === undefined) throw new Error('no votes stored');
  first.votes = { ...first.votes, notReal: 3 };
  second.votes = { ...second.votes, ballots: undefined } as unknown as typeof second.votes;
  const { seen } = capture(state);
  const listed = seen.map((n) => n.message).filter((m) => m.startsWith('  - '));
  assert.deepEqual(listed, [
    '  - `the-claim` Finding the-claim - votes unreadable, was P1',
    '  - `the-other` Finding the-other - votes unreadable, was P1',
  ]);
  for (const m of listed) assert.doesNotMatch(m, /\d+ of \d+/);
});

test('a run with no verifiers, and one whose every vote confirmed, add nothing to the summary', async () => {
  const plain = reviewingRun({ prefix: 'vibe-unconfirmed-none-' });
  await drive(plain, withReview({}), handlers([blocker('the-claim')], () => undefined));
  assert.equal(plain.events.some((e) => e.type === 'review_votes_tallied'), false);
  assert.deepEqual(capture(plain), { out: [], seen: [] });

  const confirmed = reviewingRun({ prefix: 'vibe-unconfirmed-confirmed-' });
  await drive(confirmed, withReview({ verifiers: THREE }), handlers([blocker('the-claim')], ballots([REAL, REAL, NOT_REAL])));
  assert.equal(confirmed.events.some((e) => e.type === 'review_votes_tallied'), true);
  assert.deepEqual(capture(confirmed), { out: [], seen: [] });
});

test('an agreed deferral is not listed as unconfirmed by vote', () => {
  const state = reviewingRun({ prefix: 'vibe-unconfirmed-deferral-' });
  state.deferred = [{ ...p1('later'), severity: 'P2', defer: true }];
  assert.deepEqual(capture(state), { out: [], seen: [] });
});
