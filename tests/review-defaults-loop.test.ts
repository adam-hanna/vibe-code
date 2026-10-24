import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import { DEFAULTS } from '@src/config.js';
import {
  agents,
  BLOCKING,
  committing,
  config,
  freshRun,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, ReviewConfig, RunState } from '@src/types.js';

/**
 * What `review` changes about a run, against a default one (#388).
 *
 * The first case pins the default loop's turn labels as they are today - plan,
 * critique, implement, a blocking review, a fix round and an approving review.
 * The second runs the same loop with two verifiers, a quorum and a non-default
 * `unconfirmedP0`, and requires exactly the vote's own additions (Part C) and
 * nothing else: the same other labels, artifacts and event sequence. Finders
 * (Part B) are pinned in `review-finders-loop.test.ts`, and the vote's
 * outcomes in `review-votes-loop.test.ts`.
 */

const LABELS = ['plan', 'critique-0', 'implement', 'review-0', 'fix-1', 'review-1'];

function handlers(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    // The first review blocks; every other Codex turn (the critique, the second review) approves.
    codex: (label) => report(label === 'review-0' ? BLOCKING : []),
  };
}

async function run(review: ReviewConfig): Promise<{ calls: string[]; state: RunState }> {
  const state = freshRun({ prefix: 'vibe-review-defaults-', task: 'review defaults', planOnly: false, git: true, commit: true });
  const calls: string[] = [];
  const cfg: Config = config({ p1Tolerance: 0 }, { ...committing(), ...verifying(state), review });
  await orchestrate(state, cfg, false, agents(handlers(state), calls));
  return { calls, state };
}

/** Each round's review artifact, as written, by file name. */
function reviews(state: RunState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(state.dir).filter((n) => /^code-review-\d+\.json$/.test(n)).sort()) {
    out[name] = readFileSync(path.join(state.dir, name), 'utf8');
  }
  return out;
}

test('a default run takes exactly the turns it always has', async () => {
  const { calls, state } = await run(DEFAULTS.review);
  assert.deepEqual(calls, LABELS);
  assert.equal(state.status, 'done');
  assert.deepEqual(Object.keys(reviews(state)), ['code-review-0.json', 'code-review-1.json']);
});

// Finders are used since #388 Part B and verifiers since Part C, so the claim
// this case made before - that naming verifiers changes nothing a run does -
// is no longer the contract. What still holds, and is pinned here: the vote
// adds exactly one turn per blocking finding per verifier, labelled
// `vote-<r>-<n>-v<k>`, plus one `review_votes_tallied` event per round; a
// round with nothing blocking casts no vote and writes the artifact a default
// run writes; and everything else - every other turn, every other event, every
// severity - is what the default run does. Finders: `review-finders-loop.test.ts`.
test('verifiers add one vote turn per blocking finding per verifier, and nothing else', async () => {
  const plain = await run(DEFAULTS.review);

  const state = freshRun({ prefix: 'vibe-review-defaults-', task: 'review defaults', planOnly: false, git: true, commit: true });
  const calls: string[] = [];
  const cfg: Config = config(
    { p1Tolerance: 0 },
    {
      ...committing(),
      ...verifying(state),
      review: { finders: [], verifiers: ['codex', { provider: 'claude', effort: 'high' }], quorum: 2, unconfirmedP0: 'halt', maxParallel: 1 },
    },
  );
  const base = handlers(state);
  const real = { vote: 'real', reason: 'It is there.', evidence: [] };
  const voting: Handlers = {
    claude: (label, options) => (label.startsWith('vote-') ? real : base.claude?.(label, options)),
    codex: (label, options) => (label.startsWith('vote-') ? real : base.codex?.(label, options)),
  };
  await orchestrate(state, cfg, false, agents(voting, calls));

  assert.deepEqual(calls, [
    'plan',
    'critique-0',
    'implement',
    'review-0',
    'vote-0-1-v1',
    'vote-0-1-v2',
    'vote-0-2-v1',
    'vote-0-2-v2',
    'fix-1',
    'review-1',
  ]);
  assert.equal(state.status, plain.state.status);

  // The approving round voted on nothing, and its artifact is the default one.
  const seated = reviews(state);
  const unseated = reviews(plain.state);
  assert.equal(seated['code-review-1.json'], unseated['code-review-1.json']);
  // The blocking round's findings carry their votes, and nothing else moved.
  const round0 = JSON.parse(seated['code-review-0.json'] ?? '{}') as { findings: Record<string, unknown>[] };
  for (const f of round0.findings) assert.equal((f['votes'] as { outcome: string }).outcome, 'confirmed');
  const stripped = { ...round0, findings: round0.findings.map(({ votes: _votes, ...rest }) => rest) };
  assert.deepEqual(stripped, JSON.parse(unseated['code-review-0.json'] ?? '{}'));

  // Every event the default run records, in its order, once the vote's own are set aside.
  const isVote = (e: Record<string, unknown>): boolean =>
    e['type'] === 'review_votes_tallied' || (typeof e['label'] === 'string' && e['label'].startsWith('vote-'));
  assert.deepEqual(
    state.events.filter((e) => !isVote(e)).map((e) => e.type),
    plain.state.events.map((e) => e.type),
  );
  assert.equal(state.events.filter((e) => e.type === 'review_votes_tallied').length, 2);
});
