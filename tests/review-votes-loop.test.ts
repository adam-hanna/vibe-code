import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Escalation, EXIT, orchestrate, writeEscalation } from '@src/orchestrator.js';
import { acceptMoves } from '@src/raise.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { DEFAULTS } from '@src/config.js';
import { agents, config, p1, report, reproducerGate, reviewingRun } from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, Evidence, Finding, ReviewConfig, RunState, Votes } from '@src/types.js';

/**
 * The review vote, driven through the real loop (#388 Part C).
 *
 * Every blocking finding that was not reproduced goes to every verifier, after
 * the merge and the reproducers and before the gate; the tally decides whether
 * it still blocks. Every agent is injected - a `vote-*` label is answered with a
 * vote - while git, grounding and the artifacts are real, so each case reads
 * `code-review-0.json`, FOLLOW-UPS.md and NEEDS-INPUT.md as a person would.
 */

interface Driven {
  calls: string[];
  seen: Narration[];
  prompts: Map<string, string>;
}

/** A citation of the fixture's own file, so grounding resolves it. */
const HERE: Evidence = { kind: 'code', path: 'implemented.ts', line: 1 };

const REAL = { vote: 'real', reason: 'It is there.', evidence: [] };
const NOT_REAL = { vote: 'not-real', reason: 'It is handled on line 1.', evidence: [{ ...HERE, excerpt: null, ref: null }] };
const CANNOT_TELL = { vote: 'cannot-tell', reason: 'Could not settle it.', evidence: [] };

function withReview(review: Partial<ReviewConfig>, over: Partial<Config> = {}): Config {
  return config({ p1Tolerance: 0 }, { review: { ...DEFAULTS.review, ...review }, ...over });
}

/** The reviewer's report for round 0, a vote per `vote-*` label, and approval otherwise. */
function voting(found: readonly Finding[], votes: (label: string) => unknown): Handlers {
  const answer = (label: string): unknown => {
    if (label.startsWith('vote-')) return votes(label);
    return label === 'review-0' ? report(found) : report([]);
  };
  return {
    codex: (label) => answer(label),
    claude: (label) => (label.startsWith('vote-') ? votes(label) : 'done'),
  };
}

async function drive(state: RunState, cfg: Config, handlers: Handlers, calls: string[] = []): Promise<Driven> {
  const seen: Narration[] = [];
  const prompts = new Map<string, string>();
  const wrapped: Handlers = {
    ...handlers,
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      return handlers.claude?.(label, options);
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      return handlers.codex?.(label, options) ?? report([]);
    },
  };
  log.setSink((n) => void seen.push(n));
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, true, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return { calls, seen, prompts };
}

function artifact(state: RunState, n = 0): Finding[] {
  return (JSON.parse(readFileSync(path.join(state.dir, `code-review-${n}.json`), 'utf8')) as { findings: Finding[] })
    .findings;
}

function blocker(id: string, severity: 'P0' | 'P1' = 'P1'): Finding {
  return { ...p1(id), severity, evidence: [HERE] };
}

const THREE: ReviewConfig['verifiers'] = ['codex', 'codex', 'codex'];

/** Votes by verifier: `v1` gets the first, and so on. */
function byVerifier(...votes: unknown[]): (label: string) => unknown {
  return (label) => votes[Number(/-v(\d+)$/.exec(label)?.[1] ?? '0') - 1];
}

test('confirmed: the finding blocks, and its votes are in the round artifact', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-confirmed-' });
  const { calls, seen } = await drive(
    state,
    withReview({ verifiers: THREE }),
    voting([blocker('the-claim')], byVerifier(REAL, REAL, NOT_REAL)),
  );
  assert.deepEqual(
    calls.filter((l) => l.startsWith('vote-')),
    ['vote-0-1-v1', 'vote-0-1-v2', 'vote-0-1-v3'],
  );
  assert.ok(calls.includes('fix-1'), `no fix round in ${calls.join(', ')}`);
  const [found] = artifact(state);
  assert.equal(found?.severity, 'P1');
  const votes = found?.votes as Votes;
  assert.equal(votes.outcome, 'confirmed');
  assert.deepEqual([votes.real, votes.notReal, votes.cannotTell, votes.n, votes.quorum], [2, 1, 0, 3, 2]);
  assert.deepEqual(
    votes.ballots.map((b) => [b.seat, b.provider, b.model, b.vote, b.counted]),
    [
      ['review.verifiers[0]', 'codex', 'default', 'real', 'real'],
      ['review.verifiers[1]', 'codex', 'default', 'real', 'real'],
      ['review.verifiers[2]', 'codex', 'default', 'not-real', 'not-real'],
    ],
  );
  const started = seen.filter((n) => n.id === 'turn_started' && n.data?.['kind'] === 'vote');
  assert.deepEqual(started[0]?.data, {
    role: 'reviewer',
    kind: 'vote',
    round: 0,
    verifier: 1,
    seat: 'review.verifiers[0]',
    finding: 'the-claim',
  });
  const tallied = state.events.filter((e) => e.type === 'review_votes_tallied');
  assert.equal(tallied[0]?.['confirmed'], 1);
  assert.equal(tallied[0]?.['votes'], 3);
});

test('an unconfirmed P1 is moved to P2 with the tally, the gate passes, and it reaches FOLLOW-UPS', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-unconfirmed-' });
  const { calls, seen } = await drive(
    state,
    withReview({ verifiers: THREE }),
    voting([blocker('the-claim')], byVerifier(NOT_REAL, REAL, NOT_REAL)),
  );
  assert.equal(calls.some((l) => l.startsWith('fix-')), false, calls.join(', '));
  assert.equal(state.status, 'done');
  const [found] = artifact(state);
  assert.equal(found?.severity, 'P2');
  assert.deepEqual(found?.downgraded, {
    from: 'P1',
    reason: 'unconfirmed by vote: 1 real, 2 not-real, 0 cannot-tell of 3 (quorum 2)',
  });
  assert.equal(found?.defer, false, 'never marked as an agreed deferral');
  assert.equal(state.events.some((e) => e.type === 'finding_downgraded' && e['id'] === 'the-claim'), true);
  const followUps = readFileSync(path.join(state.dir, 'FOLLOW-UPS.md'), 'utf8');
  assert.match(followUps, /the-claim/);
  assert.match(followUps, /\*Unconfirmed by vote:\* unconfirmed by vote: 1 real, 2 not-real/);
  const line = seen.find((n) => n.id === 'review_votes_tallied');
  assert.match(
    line?.message ?? '',
    /^review round 1: 1 findings to vote × 3 verifiers, 3 votes; 0 confirmed, 1 unconfirmed \(1 moved to P2\), 0 undecided \(still blocking\); 0 reproduced, not voted$/,
  );
});

test('undecided because of cannot-tell: it still blocks and goes to the fix round', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-undecided-' });
  const { calls } = await drive(
    state,
    withReview({ verifiers: THREE }),
    voting([blocker('the-claim')], byVerifier(REAL, CANNOT_TELL, NOT_REAL)),
  );
  assert.ok(calls.includes('fix-1'));
  const [found] = artifact(state);
  assert.equal(found?.severity, 'P1');
  assert.equal(found?.votes?.outcome, 'undecided');
});

test('a not-real vote that points at nothing is counted as cannot-tell, and the finding keeps blocking', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-uncited-' });
  const bare = { vote: 'not-real', reason: 'Trust me.', evidence: [] };
  const { calls } = await drive(
    state,
    withReview({ verifiers: THREE }),
    voting([blocker('the-claim')], byVerifier(bare, bare, REAL)),
  );
  assert.ok(calls.includes('fix-1'));
  const votes = artifact(state)[0]?.votes as Votes;
  assert.equal(votes.outcome, 'undecided');
  assert.equal(votes.ballots[0]?.vote, 'not-real');
  assert.equal(votes.ballots[0]?.counted, 'cannot-tell');
  assert.equal(votes.ballots[0]?.countedReason, 'its evidence resolved to nothing: it cited no evidence');
});

test('a failed verifier turn is counted as cannot-tell, and the round finishes', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-failed-' });
  const { calls } = await drive(
    state,
    withReview({ verifiers: THREE }),
    voting([blocker('the-claim')], (label) => {
      if (label === 'vote-0-1-v2') throw new Error('verifier fell over\nsecond line');
      return label.endsWith('v1') ? NOT_REAL : REAL;
    }),
  );
  assert.equal(state.status, 'done');
  assert.ok(calls.includes('fix-1'));
  const votes = artifact(state)[0]?.votes as Votes;
  assert.equal(votes.outcome, 'undecided');
  assert.deepEqual(
    { vote: votes.ballots[1]?.vote, counted: votes.ballots[1]?.counted },
    { vote: 'cannot-tell', counted: 'cannot-tell' },
  );
  assert.match(votes.ballots[1]?.reason ?? '', /^the turn failed: verifier fell over/);
  assert.doesNotMatch(votes.ballots[1]?.reason ?? '', /second line/);
});

test('unconfirmedP0 "block": an unconfirmed P0 keeps its severity and blocks', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-p0-block-' });
  const { calls } = await drive(
    state,
    withReview({ verifiers: THREE, unconfirmedP0: 'block' }),
    voting([blocker('the-p0', 'P0')], byVerifier(NOT_REAL, NOT_REAL, REAL)),
  );
  const [found] = artifact(state);
  assert.equal(found?.severity, 'P0');
  assert.equal(found?.downgraded, undefined);
  assert.equal(found?.votes?.outcome, 'unconfirmed');
  assert.ok(calls.includes('fix-1'), calls.join(', '));
});

test('unconfirmedP0 "demote": an unconfirmed P0 is moved to P2 as a P1 is', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-p0-demote-' });
  const { calls } = await drive(
    state,
    withReview({ verifiers: THREE, unconfirmedP0: 'demote' }),
    voting([blocker('the-p0', 'P0')], byVerifier(NOT_REAL, NOT_REAL, REAL)),
  );
  const [found] = artifact(state);
  assert.equal(found?.severity, 'P2');
  assert.equal(found?.downgraded?.from, 'P0');
  assert.equal(calls.some((l) => l.startsWith('fix-')), false);
  assert.equal(state.status, 'done');
});

/** A run stopped by an unconfirmed P0 under "halt", with its NEEDS-INPUT.md written. */
async function halted(prefix: string): Promise<{ state: RunState; cfg: Config; needsInput: string; calls: string[] }> {
  const state = reviewingRun({ prefix });
  const cfg = withReview({ verifiers: THREE, unconfirmedP0: 'halt' });
  const calls: string[] = [];
  const handlers = voting([blocker('the-p0', 'P0')], byVerifier(NOT_REAL, NOT_REAL, REAL));
  let stopped: unknown = null;
  try {
    await drive(state, cfg, handlers, calls);
  } catch (err: unknown) {
    stopped = err;
  }
  assert.ok(stopped instanceof Escalation, `expected an escalation, got ${String(stopped)}`);
  assert.equal(stopped.code, EXIT.NEEDS_HUMAN);
  assert.deepEqual(stopped.findings?.map((f) => f.id), ['the-p0']);
  const file = writeEscalation(state, stopped);
  return { state, cfg, needsInput: readFileSync(file, 'utf8'), calls };
}

test('unconfirmedP0 "halt": the artifact is written with the P0 unmoved, and NEEDS-INPUT.md names every vote', async () => {
  const { state, needsInput, calls } = await halted('vibe-votes-p0-halt-');
  assert.equal(calls.some((l) => l.startsWith('fix-')), false);
  const [found] = artifact(state);
  assert.equal(found?.severity, 'P0');
  assert.equal(found?.downgraded, undefined);
  assert.equal(found?.votes?.outcome, 'unconfirmed');
  assert.match(needsInput, /## Unconfirmed P0 findings/);
  for (const [seat, reason] of [
    ['review.verifiers[0]', 'It is handled on line 1.'],
    ['review.verifiers[1]', 'It is handled on line 1.'],
    ['review.verifiers[2]', 'It is there.'],
  ] as const) {
    assert.ok(needsInput.includes(`\`${seat}\``) && needsInput.includes(reason), `${seat} is not named`);
  }
  assert.match(needsInput, /Leave it alone and it keeps blocking/);
  // The existing #142 block, rendered from what the run is carrying.
  assert.match(needsInput, /### Move: `the-p0`/);
});

test('a resume after "halt" with no answer sends the P0 to the fix round and casts no vote again', async () => {
  const { state, cfg } = await halted('vibe-votes-p0-halt-resume-');
  const calls: string[] = [];
  const { seen } = await drive(state, cfg, voting([], () => assert.fail('no vote on resume')), calls);
  assert.equal(calls[0], 'fix-1', calls.join(', '));
  assert.equal(calls.some((l) => l.startsWith('vote-0-')), false);
  const fix = seen.find((n) => n.id === 'turn_started' && n.data?.['kind'] === 'review-fix');
  assert.equal(fix?.data?.['blocking'], 1);
  assert.equal(state.status, 'done');
});

test('a resume after "halt" with a #142 move to P2 continues with it non-blocking, as a person\'s change', async () => {
  const { state, cfg } = await halted('vibe-votes-p0-halt-moved-');
  acceptMoves(state, 'review', [{ id: 'the-p0', to: 'P2', reason: 'The verifiers are right.' }]);
  const calls: string[] = [];
  const { seen, prompts } = await drive(state, cfg, voting([], () => assert.fail('no vote on resume')), calls);
  assert.equal(calls.some((l) => l.startsWith('vote-0-')), false);
  const fix = seen.find((n) => n.id === 'turn_started' && n.data?.['kind'] === 'review-fix');
  assert.equal(fix?.data?.['blocking'], 0);
  assert.match(prompts.get('fix-1') ?? '', /Severity moved from P0 to P2 by the person running this: The verifiers are right\./);
  const moved = state.events.find((e) => e.type === 'finding_severity_changed');
  assert.equal(moved?.['by'], 'human');
  // A person's change, not a vote's: no guard downgrade was recorded for it.
  assert.equal(state.events.some((e) => e.type === 'finding_downgraded' && e['id'] === 'the-p0'), false);
});

test('a reproduced finding is never voted on, and the tally says so', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-reproduced-', commit: true });
  const reproduced: Finding = {
    ...blocker('the-claim'),
    reproducer: { path: 'repro/witness.txt', contents: 'FAIL - it really happens\n' },
  };
  const { calls } = await drive(
    state,
    withReview(
      { verifiers: THREE },
      {
        verify: { ...DEFAULTS.verify, enabled: true, command: reproducerGate(state), runs: 1, timeoutMs: 30_000 },
      },
    ),
    voting([reproduced], () => assert.fail('a reproduced finding was put to a vote')),
  );
  assert.equal(calls.some((l) => l.startsWith('vote-')), false, calls.join(', '));
  assert.ok(calls.includes('fix-1'));
  const tallied = state.events.find((e) => e.type === 'review_votes_tallied');
  assert.equal(tallied?.['reproduced'], 1);
  assert.equal(tallied?.['findings'], 0);
  assert.equal('votes' in (artifact(state)[0] ?? {}), false);
  assert.equal(existsSync(path.join(state.targetDir, 'repro/witness.txt')), false);
});

test('a finding grounding downgraded is never voted on', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-grounded-' });
  const ungrounded: Finding = { ...p1('the-claim'), evidence: [{ kind: 'code', path: 'nowhere.ts', line: 1 }] };
  const { calls } = await drive(
    state,
    withReview({ verifiers: THREE }),
    voting([ungrounded], () => assert.fail('a downgraded finding was put to a vote')),
  );
  assert.equal(calls.some((l) => l.startsWith('vote-')), false);
  assert.equal(artifact(state)[0]?.severity, 'P2');
});

test('with finders and verifiers, the labels come review-*, then review-*-f*, then vote-*', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-order-' });
  const { calls } = await drive(
    state,
    withReview({ finders: ['codex'], verifiers: ['codex', 'claude'] }),
    voting([blocker('one'), { ...blocker('two'), title: 'A different defect entirely' }], () => REAL),
  );
  const at = calls.indexOf('review-0');
  assert.deepEqual(calls.slice(at, at + 6), [
    'review-0',
    'review-0-f1',
    'vote-0-1-v1',
    'vote-0-1-v2',
    'vote-0-2-v1',
    'vote-0-2-v2',
  ]);
});

test("a verifier's prompt carries no foundBy and no other verifier's ballot", async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-prompt-' });
  const { prompts } = await drive(
    state,
    withReview({ finders: ['codex'], verifiers: ['codex', 'codex'] }),
    voting([blocker('the-claim')], byVerifier({ ...REAL, reason: 'UNIQUE-REASON-OF-V1' }, REAL)),
  );
  const first = prompts.get('vote-0-1-v1') ?? '';
  const second = prompts.get('vote-0-1-v2') ?? '';
  assert.ok(first.includes('Finding the-claim'), 'the claim is in the prompt');
  assert.equal(second, first, 'every verifier is handed the same prompt');
  for (const absent of ['foundBy', 'review.finders', 'roles.reviewer', 'UNIQUE-REASON-OF-V1', 'the-claim`']) {
    assert.equal(second.includes(absent), false, `the prompt names ${absent}`);
  }
});

test('a verifier turn that fails names its seat; a role turn still names its role', async () => {
  const state = reviewingRun({ prefix: 'vibe-votes-seatpath-' });
  await drive(
    state,
    withReview({ verifiers: [{ provider: 'codex', model: 'verifier-model' }] }),
    voting([blocker('the-claim')], () => {
      throw new Error('boom');
    }),
  );
  const ballot = (artifact(state)[0]?.votes as Votes).ballots[0];
  assert.equal(ballot?.reason, 'the turn failed: boom [this turn ran review.verifiers[0].model = "verifier-model"]');

  const role = reviewingRun({ prefix: 'vibe-votes-rolepath-' });
  await assert.rejects(
    drive(
      role,
      withReview({}, { roles: { ...DEFAULTS.roles, reviewer: { provider: 'codex', model: 'reviewer-model' } } }),
      {
        codex: () => {
          throw new Error('boom');
        },
      },
    ),
    (err: unknown) => err instanceof Error && err.message === 'boom [this turn ran roles.reviewer.model = "reviewer-model"]',
  );
});
