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
 * Most of `review` is still groundwork (#388 Part A): a run that names
 * verifiers behaves exactly as one that names none.
 *
 * The first case pins the default loop's turn labels as they are today - plan,
 * critique, implement, a blocking review, a fix round and an approving review.
 * The second runs the same loop with two verifiers, a quorum and a non-default
 * `unconfirmedP0` and requires the identical labels, the identical
 * `code-review-<n>.json` files and the identical event sequence. A run that read
 * those keys anywhere would show it in one of those three. (Finders are used
 * since #388 Part B; `review-finders-loop.test.ts` pins what they change.)
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

// Finders are used since #388 Part B, so this claim now holds for the rest of
// the section only: naming verifiers, a quorum and `unconfirmedP0` changes
// nothing a run does until Part C. What finders change is pinned in
// `review-finders-loop.test.ts`.
test('naming verifiers, a quorum and unconfirmedP0 changes nothing a run does, in this release', async () => {
  const plain = await run(DEFAULTS.review);
  const seated = await run({
    finders: [],
    verifiers: ['codex', { provider: 'claude', effort: 'high' }],
    quorum: 2,
    unconfirmedP0: 'halt',
  });
  assert.deepEqual(seated.calls, LABELS);
  assert.deepEqual(reviews(seated.state), reviews(plain.state));
  assert.deepEqual(
    seated.state.events.map((e) => e.type),
    plain.state.events.map((e) => e.type),
  );
  assert.equal(seated.state.status, plain.state.status);
});
