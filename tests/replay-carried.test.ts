import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayRun } from '@src/replay.js';
import type { ReplaySources, RoundCensus } from '@src/replay.js';
import type { RunState } from '@src/types.js';

/**
 * What an opened run carried, said on the census of the round whose gate passed (#505).
 *
 * A census is narration with no event, so a replayed one carried the counts its
 * round's artifact holds and no gate decision, and #503's Summary drew `—` over
 * a run whose `state.events` records what it carried: `plan_approved.carried`
 * and `review_approved.carriedAndFixed`. The replay now attaches those ids to
 * the census of the round each approval followed, in the live census's shape.
 *
 * The runs are shaped on `20261021-211408`, which carried
 * `fix-round-recording-not-resumable` out of its critique and
 * `dispositions-lost-after-consumption` out of its second review.
 */

// Relative to now, never a wall-clock constant (AGENTS.md "Tests").
const T0 = Date.now() - 60 * 60 * 1000;
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function stateWith(events: RunState['events']): RunState {
  return {
    id: '20261021-211408-carried',
    dir: '/runs/a',
    targetDir: '/repo',
    task: 'build the thing',
    sessionId: 's',
    createdAt: iso(0),
    status: 'done',
    planRound: 1,
    reviewRound: 2,
    questionRound: 0,
    verifyRound: 0,
    verifyRounds: [],
    costUsd: 0,
    tokensUsed: 0,
    rateLimitWaits: 0,
    baseSha: null,
    branch: null,
    events,
    sessionStarted: false,
    planOnly: false,
    answeredQuestions: [],
    deferredQuestions: [],
    sessionRotations: 0,
    codexSessionId: null,
    handoff: null,
    contextRatio: 0,
    plan: null,
    pendingAnswers: null,
    extraContext: null,
  } as unknown as RunState;
}

const counts = (P1: number): RoundCensus['counts'] => ({ P0: 0, P1, P2: 1, P3: 0 });

/** Every judge round of the run, as their artifacts count them. */
const SOURCES: ReplaySources = {
  checkpoints: [],
  questions: [],
  censuses: [
    { phase: 'plan', round: 0, counts: counts(2) },
    { phase: 'plan', round: 1, counts: counts(1) },
    { phase: 'review', round: 0, counts: counts(2) },
    { phase: 'review', round: 1, counts: counts(1) },
  ],
};

const PLAN_ID = 'fix-round-recording-not-resumable';
const REVIEW_ID = 'dispositions-lost-after-consumption';

/**
 * The turns of a run that critiqued twice, reviewed twice and carried a P1 out
 * of each gate, with the approvals where the loop records them: the plan's right
 * after its passing critique, the review's after the final fix turn.
 */
function carryingRun(over: { plan?: Record<string, unknown>; review?: Record<string, unknown> } = {}): RunState {
  return stateWith([
    { at: iso(1_000), type: 'claude_turn', label: 'plan', tokens: 1 },
    { at: iso(2_000), type: 'codex_turn', label: 'critique-0', tokens: 1 },
    { at: iso(3_000), type: 'claude_turn', label: 'revise-1', tokens: 1 },
    { at: iso(4_000), type: 'codex_turn', label: 'critique-1', tokens: 1 },
    { at: iso(4_500), type: 'codex_turn', label: 'critique-1-vote-1-v1', tokens: 1 },
    { at: iso(4_600), type: 'plan_approved', findings: 2, carried: [PLAN_ID], declined: [], ...over.plan },
    { at: iso(5_000), type: 'claude_turn', label: 'implement', tokens: 1 },
    { at: iso(6_000), type: 'codex_turn', label: 'review-0', tokens: 1 },
    { at: iso(7_000), type: 'claude_turn', label: 'fix-1', tokens: 1 },
    { at: iso(8_000), type: 'codex_turn', label: 'review-1', tokens: 1 },
    { at: iso(9_000), type: 'claude_turn', label: 'final-fix-2', tokens: 1 },
    { at: iso(9_100), type: 'review_approved', findings: 2, carriedAndFixed: [REVIEW_ID], ...over.review },
  ]);
}

/** Each replayed census's data, keyed `plan-0`, `review-1`, in replay order. */
function censuses(state: RunState): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const steps = replayRun(state, SOURCES).steps.filter((s) => s.narration.id === 'findings_reported');
  for (const s of steps) {
    const data = s.narration.data ?? {};
    // The sentence counts from one; the key keeps the archive's round.
    const round = Number(/round (\d+)$/.exec(s.narration.message)?.[1]) - 1;
    out.set(`${String(data['phase'])}-${String(round)}`, data);
  }
  return out;
}

const UNDECIDED = (data: Record<string, unknown> | undefined): void => {
  assert.ok(data !== undefined, 'the census was not replayed');
  assert.equal('pass' in data, false);
  assert.equal('reason' in data, false);
  assert.equal('tolerated' in data, false);
};

test('a carried plan P1 and a carried review P1 are on the censuses of the rounds that passed', () => {
  const got = censuses(carryingRun());
  // The live census's shape: `pass`, `reason` null on a pass, `tolerated` ids.
  assert.deepEqual(got.get('plan-1'), {
    phase: 'plan',
    counts: counts(1),
    pass: true,
    reason: null,
    tolerated: [PLAN_ID],
  });
  // The final fix turn sits between the review round and its approval, and does
  // not move the round: the gate decided over review round 1's findings.
  assert.deepEqual(got.get('review-1'), {
    phase: 'review',
    counts: counts(1),
    pass: true,
    reason: null,
    tolerated: [REVIEW_ID],
  });
  // The rounds whose gate blocked say nothing - never a `pass: false` the
  // record does not hold.
  UNDECIDED(got.get('plan-0'));
  UNDECIDED(got.get('review-0'));
});

test('a clean review states no ids, so its census claims no decision', () => {
  // The clean road records `review_approved` with `findings` alone. Today that
  // means nothing was carried, but archives from before `carriedAndFixed`
  // recorded the same shape for other reasons, so absence is not read as empty.
  const state = carryingRun({ plan: { carried: [] } });
  const approved = state.events.find((e) => e.type === 'review_approved');
  assert.ok(approved !== undefined);
  delete approved['carriedAndFixed'];
  const got = censuses(state);
  UNDECIDED(got.get('review-1'));
  // A plan gate that passed carrying nothing is an answer: `[]`, so the card says None.
  assert.equal(got.get('plan-1')?.['pass'], true);
  assert.deepEqual(got.get('plan-1')?.['tolerated'], []);
});

test('a run whose gate never passed replays no decision on any census', () => {
  // Stopped after the critique blocked: no approval event, and the counts - one
  // P1 within a tolerance of one would pass - are never read as a pass.
  const state = stateWith([
    { at: iso(1_000), type: 'claude_turn', label: 'plan', tokens: 1 },
    { at: iso(2_000), type: 'codex_turn', label: 'critique-0', tokens: 1 },
    { at: iso(3_000), type: 'claude_turn', label: 'revise-1', tokens: 1 },
    { at: iso(4_000), type: 'codex_turn', label: 'critique-1', tokens: 1 },
    { at: iso(5_000), type: 'escalation', message: 'plan round cap reached', code: 3 },
  ]);
  state.status = 'stalled';
  const got = censuses(state);
  UNDECIDED(got.get('plan-0'));
  UNDECIDED(got.get('plan-1'));
});

test('malformed approval data is dropped, never guessed', async (t) => {
  await t.test('a field that is not an array attaches nothing', () => {
    const got = censuses(carryingRun({ plan: { carried: PLAN_ID }, review: { carriedAndFixed: { id: REVIEW_ID } } }));
    UNDECIDED(got.get('plan-1'));
    UNDECIDED(got.get('review-1'));
  });

  await t.test('entries that are not ids are dropped and the rest kept, each once', () => {
    const got = censuses(
      carryingRun({ plan: { carried: [PLAN_ID, 7, null, '', '  padded  ', { id: 'x' }, PLAN_ID] } }),
    );
    assert.deepEqual(got.get('plan-1')?.['tolerated'], [PLAN_ID]);
  });

  await t.test('an approval with no readable time ties to no round', () => {
    const got = censuses(carryingRun({ plan: { at: 'not a time' }, review: { at: 42 } }));
    UNDECIDED(got.get('plan-1'));
    UNDECIDED(got.get('review-1'));
  });

  await t.test('an approval before any judge turn of its phase ties to no round', () => {
    const state = carryingRun();
    state.events.push({ at: iso(500), type: 'review_approved', carriedAndFixed: ['early'] });
    const got = censuses(state);
    // The well-placed one still lands; the stray one lands nowhere.
    assert.deepEqual(got.get('review-1')?.['tolerated'], [REVIEW_ID]);
    for (const data of got.values()) assert.equal((data['tolerated'] as unknown[] | undefined)?.includes('early') ?? false, false);
  });
});

test('a failed judge turn does not take the approval from the round that passed', () => {
  // A stopped critique wrote no report, so its round gated nothing. #394's
  // acceptance on a person's demotion then approves over the last critique that
  // did report.
  const state = stateWith([
    { at: iso(1_000), type: 'claude_turn', label: 'plan', tokens: 1 },
    { at: iso(2_000), type: 'codex_turn', label: 'critique-0', tokens: 1 },
    { at: iso(3_000), type: 'turn_failed', provider: 'codex', label: 'critique-1', tokens: 1 },
    { at: iso(4_000), type: 'plan_approved', findings: 2, carried: [PLAN_ID], declined: [], byPerson: true },
  ]);
  const got = censuses(state);
  assert.deepEqual(got.get('plan-0')?.['tolerated'], [PLAN_ID]);
  assert.equal(got.get('plan-0')?.['pass'], true);
});

test('two approvals of one round are one decision', () => {
  const state = carryingRun();
  state.events.push({ at: iso(9_200), type: 'review_approved', carriedAndFixed: [REVIEW_ID, 'another'] });
  assert.deepEqual(censuses(state).get('review-1')?.['tolerated'], [REVIEW_ID, 'another']);
});
