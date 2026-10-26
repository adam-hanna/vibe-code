import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { DEFAULTS } from '@src/config.js';
import {
  agents,
  config,
  escalationFile,
  freshRun,
  moveInNeedsInput,
  p1,
  planFixture,
  report,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, CritiqueConfig, Evidence, Finding, LoopConfig, RunState, Votes } from '@src/types.js';

/**
 * The plan critique's vote, driven through the real plan loop (#405).
 *
 * Every P0 and P1 left after the critique's merge goes to every verifier,
 * before the gate; the tally decides whether it still blocks, and every guard
 * after it reads what the vote left. A `critique-<n>-vote-*` label is answered
 * with a vote; git, grounding and the artifacts are real.
 */

interface Driven {
  calls: string[];
  seen: Narration[];
  prompts: Map<string, string>;
}

/** A citation of the fixture's own file, so grounding resolves it. */
const HERE: Evidence = { kind: 'code', path: 'widget.ts', line: 1 };

const REAL = { vote: 'real', reason: 'It is there.', evidence: [] };
const NOT_REAL = { vote: 'not-real', reason: 'The plan handles it in step 2.', evidence: [{ ...HERE, excerpt: null, ref: null }] };
const CANNOT_TELL = { vote: 'cannot-tell', reason: 'Could not settle it.', evidence: [] };

const THREE: CritiqueConfig['verifiers'] = ['codex', 'codex', 'codex'];

function blocker(id: string, severity: 'P0' | 'P1' = 'P1'): Finding {
  return { ...p1(id), severity, evidence: [HERE] };
}

function withCritique(critique: Partial<CritiqueConfig>, loop: Partial<LoopConfig> = {}): Config {
  return config({ p1Tolerance: 0, ...loop }, { critique: { ...DEFAULTS.critique, ...critique } });
}

function run(prefix: string, over: { planOnly?: boolean } = {}): RunState {
  const planOnly = over.planOnly ?? true;
  const state = freshRun({ prefix, task: 'critique votes', planOnly, git: !planOnly, commit: !planOnly });
  writeFileSync(path.join(state.targetDir, 'widget.ts'), 'export const widget = 1;\n', 'utf8');
  return state;
}

/** Votes by verifier: `v1` gets the first, and so on. */
function byVerifier(...votes: unknown[]): (label: string) => unknown {
  return (label) => votes[Number(/-v(\d+)$/.exec(label)?.[1] ?? '0') - 1];
}

/**
 * The critic's report per round, a vote per `critique-*-vote-*` label, a plan
 * for every planner turn, and an empty report for anything else.
 */
function critiquing(
  state: RunState,
  critic: (round: number) => readonly Finding[],
  vote: (label: string, prompt: string) => unknown,
): Handlers {
  const answer = (label: string, prompt: string): unknown => {
    if (/^critique-\d+-vote-/.test(label)) return vote(label, prompt);
    const round = /^critique-(\d+)$/.exec(label)?.[1];
    return round === undefined ? report([]) : report(critic(Number(round)));
  };
  return {
    codex: (label, options) => answer(label, options.prompt),
    claude: (label, options) => {
      if (label.startsWith('critique-')) return answer(label, options.prompt);
      if (label === 'implement' || label.startsWith('fix-')) return work(state, `${label}.txt`);
      return planFixture();
    },
  };
}

async function drive(state: RunState, cfg: Config, handlers: Handlers, resume = false): Promise<Driven> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  const prompts = new Map<string, string>();
  const wrapped: Handlers = {
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
    await orchestrate(state, cfg, resume, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return { calls, seen, prompts };
}

/** `drive`, for a run that must stop: the escalation, and what was driven up to it. */
async function stopped(state: RunState, cfg: Config, handlers: Handlers, calls: string[] = []): Promise<Escalation> {
  const wrapped: Handlers = {
    claude: (label, options) => handlers.claude?.(label, options),
    codex: (label, options) => handlers.codex?.(label, options) ?? report([]),
  };
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, false, agents(wrapped, calls));
  } catch (err: unknown) {
    assert.ok(err instanceof Escalation, `expected an escalation, got ${String(err)}`);
    return err;
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return assert.fail('the run did not stop');
}

function critiqueArtifact(state: RunState, n = 0): Finding[] {
  return (JSON.parse(readFileSync(path.join(state.dir, `plan-critique-${n}.json`), 'utf8')) as { findings: Finding[] })
    .findings;
}

test('a 2-of-3 not-real moves the only P1 to P2, the gate passes, and it reaches the implementer', async () => {
  const state = run('vibe-cvotes-unconfirmed-', { planOnly: false });
  const { calls, prompts, seen } = await drive(
    state,
    withCritique({ verifiers: THREE }),
    critiquing(state, (r) => (r === 0 ? [blocker('weak-claim')] : []), byVerifier(NOT_REAL, REAL, NOT_REAL)),
  );
  assert.deepEqual(calls.slice(0, 5), [
    'plan',
    'critique-0',
    'critique-0-vote-1-v1',
    'critique-0-vote-1-v2',
    'critique-0-vote-1-v3',
  ]);
  assert.equal(calls[5], 'implement', `the plan was revised: ${calls.join(', ')}`);
  const [found] = critiqueArtifact(state);
  assert.equal(found?.severity, 'P2');
  assert.deepEqual(found?.downgraded, {
    from: 'P1',
    reason: 'unconfirmed by vote: 1 real, 2 not-real, 0 cannot-tell of 3 (quorum 2)',
  });
  assert.equal((found?.votes as Votes).outcome, 'unconfirmed');
  // `loop.fixNonBlocking` is on by default: the implementer is told, and not as a declined deferral.
  const implement = prompts.get('implement') ?? '';
  assert.match(implement, /## Non-blocking findings from the plan critique[\s\S]*`weak-claim`/);
  assert.equal(state.declined?.some((f) => f.id === 'weak-claim'), false);
  const followUps = readFileSync(path.join(state.dir, 'FOLLOW-UPS.md'), 'utf8');
  assert.match(followUps, /\*Unconfirmed by vote:\* unconfirmed by vote: 1 real, 2 not-real/);
  const tallied = seen.find((n) => n.id === 'critique_votes_tallied');
  assert.match(
    tallied?.message ?? '',
    /^plan critique round 1: 1 findings to vote × 3 verifiers, 3 votes; 0 confirmed, 1 unconfirmed \(1 moved to P2\), 0 undecided \(still blocking\)$/,
  );
  const started = seen.find((n) => n.id === 'turn_started' && n.data?.['kind'] === 'vote');
  assert.deepEqual(started?.data, {
    role: 'critic',
    kind: 'vote',
    round: 0,
    verifier: 1,
    seat: 'critique.verifiers[0]',
    finding: 'weak-claim',
  });
});

test('with loop.fixNonBlocking off, a vote-moved plan finding goes to FOLLOW-UPS.md only', async () => {
  const state = run('vibe-cvotes-nofix-');
  await drive(
    state,
    withCritique({ verifiers: THREE }, { fixNonBlocking: false }),
    critiquing(state, (r) => (r === 0 ? [blocker('weak-claim')] : []), byVerifier(NOT_REAL, NOT_REAL, REAL)),
  );
  assert.equal(state.status, 'planned');
  assert.equal(state.planNonBlocking, undefined);
  const followUps = readFileSync(path.join(state.dir, 'FOLLOW-UPS.md'), 'utf8');
  assert.match(followUps, /`weak-claim`[\s\S]*\*Unconfirmed by vote:\*/);
});

test('an undecided P1 keeps blocking, and the revision follows', async () => {
  const state = run('vibe-cvotes-undecided-');
  const { calls } = await drive(
    state,
    withCritique({ verifiers: THREE }),
    critiquing(state, (r) => (r === 0 ? [blocker('the-claim')] : []), byVerifier(REAL, CANNOT_TELL, NOT_REAL)),
  );
  assert.ok(calls.includes('revise-1'), calls.join(', '));
  const [found] = critiqueArtifact(state);
  assert.equal(found?.severity, 'P1');
  assert.equal(found?.votes?.outcome, 'undecided');
});

test('a not-real that cites nothing resolvable is counted as cannot-tell', async () => {
  const state = run('vibe-cvotes-uncited-');
  const nowhere = { vote: 'not-real', reason: 'Trust me.', evidence: [{ kind: 'code', path: 'missing.ts', line: 1, excerpt: null, ref: null }] };
  const { calls } = await drive(
    state,
    withCritique({ verifiers: THREE }),
    critiquing(state, (r) => (r === 0 ? [blocker('the-claim')] : []), byVerifier(nowhere, nowhere, REAL)),
  );
  assert.ok(calls.includes('revise-1'));
  const votes = critiqueArtifact(state)[0]?.votes as Votes;
  assert.equal(votes.outcome, 'undecided');
  assert.equal(votes.ballots[0]?.vote, 'not-real');
  assert.equal(votes.ballots[0]?.counted, 'cannot-tell');
  assert.match(votes.ballots[0]?.countedReason ?? '', /^its evidence resolved to nothing/);
});

test("a not-real citing the round's plan artifact resolves, and the prompt names that artifact", async () => {
  const state = run('vibe-cvotes-plan-cite-');
  const onPlan = {
    vote: 'not-real',
    reason: 'Step 2 of the plan already handles it.',
    evidence: [{ kind: 'artifact', path: 'plan-0.json', line: null, excerpt: null, ref: null }],
  };
  const { prompts } = await drive(
    state,
    withCritique({ verifiers: THREE }),
    critiquing(state, (r) => (r === 0 ? [blocker('weak-claim')] : []), byVerifier(onPlan, onPlan, REAL)),
  );
  assert.match(prompts.get('critique-0-vote-1-v1') ?? '', /The plan below is the run artifact `plan-0\.json`/);
  const [found] = critiqueArtifact(state);
  const votes = found?.votes as Votes;
  assert.equal(votes.ballots[0]?.counted, 'not-real', votes.ballots[0]?.countedReason ?? '');
  assert.equal(votes.outcome, 'unconfirmed');
  assert.equal(found?.severity, 'P2');
});

test('a P1 the critic marks deferred reaches the vote as an ordinary P1, and a P2 is never voted on', async () => {
  // `parseFindings` clears `defer` on every P0 and P1 a turn returns, so the
  // vote's `defer: true` exclusion cannot be reached from a turn: this pins
  // the invariant that makes it so, rather than asserting a path that does not exist.
  const state = run('vibe-cvotes-deferred-');
  const { calls } = await drive(
    state,
    withCritique({ verifiers: ['codex'] }),
    critiquing(
      state,
      (r) => (r === 0 ? [{ ...blocker('deferred-p1'), defer: true }, { ...blocker('a-p2'), severity: 'P2', title: 'Unrelated' }] : []),
      () => REAL,
    ),
  );
  assert.deepEqual(
    calls.filter((l) => l.includes('-vote-')),
    ['critique-0-vote-1-v1'],
  );
  const [p1Found, p2Found] = critiqueArtifact(state);
  assert.equal(p1Found?.defer, false);
  assert.equal(p1Found?.votes?.outcome, 'confirmed');
  assert.equal(p2Found?.votes, undefined);
});

test("a verifier's prompt carries the plan, the task and the claim, and nothing about who raised it", async () => {
  const state = run('vibe-cvotes-prompt-');
  const { prompts } = await drive(
    state,
    withCritique({ finders: ['codex'], verifiers: ['codex', 'codex'] }),
    critiquing(state, (r) => (r === 0 ? [blocker('the-claim')] : []), byVerifier({ ...REAL, reason: 'UNIQUE-REASON-OF-V1' }, REAL)),
  );
  const first = prompts.get('critique-0-vote-1-v1') ?? '';
  const second = prompts.get('critique-0-vote-1-v2') ?? '';
  assert.match(first, /does this defect exist in this plan|whether the defect exists in this plan/);
  assert.ok(first.includes('Finding the-claim'), 'the claim is in the prompt');
  assert.ok(first.includes('critique votes'), 'the task is in the prompt');
  assert.ok(first.includes('Do the thing.'), 'the plan is in the prompt');
  assert.equal(second, first, 'every verifier is handed the same prompt');
  for (const absent of ['foundBy', 'critique.finders', 'roles.critic', 'UNIQUE-REASON-OF-V1', 'the-claim`', '[P1]']) {
    assert.equal(second.includes(absent), false, `the prompt names ${absent}`);
  }
});

test('unconfirmedP0 "block" keeps the P0 blocking with its votes; "demote" moves it to P2', async () => {
  const blocked = run('vibe-cvotes-p0-block-');
  const { calls } = await drive(
    blocked,
    withCritique({ verifiers: THREE, unconfirmedP0: 'block' }),
    critiquing(blocked, (r) => (r === 0 ? [blocker('the-p0', 'P0')] : []), byVerifier(NOT_REAL, NOT_REAL, REAL)),
  );
  const [kept] = critiqueArtifact(blocked);
  assert.equal(kept?.severity, 'P0');
  assert.equal(kept?.downgraded, undefined);
  assert.equal(kept?.votes?.outcome, 'unconfirmed');
  assert.ok(calls.includes('revise-1'), calls.join(', '));

  const demoted = run('vibe-cvotes-p0-demote-');
  const second = await drive(
    demoted,
    withCritique({ verifiers: THREE, unconfirmedP0: 'demote' }),
    critiquing(demoted, (r) => (r === 0 ? [blocker('the-p0', 'P0')] : []), byVerifier(NOT_REAL, NOT_REAL, REAL)),
  );
  const [moved] = critiqueArtifact(demoted);
  assert.equal(moved?.severity, 'P2');
  assert.equal(moved?.downgraded?.from, 'P0');
  assert.equal(second.calls.includes('revise-1'), false);
  assert.equal(demoted.status, 'planned');
});

/** A plan run stopped by an unconfirmed P0 under "halt", with its NEEDS-INPUT.md written. */
async function halted(prefix: string): Promise<{ state: RunState; cfg: Config; needsInput: string; calls: string[] }> {
  const state = run(prefix);
  const cfg = withCritique({ verifiers: THREE, unconfirmedP0: 'halt' });
  const calls: string[] = [];
  const err = await stopped(
    state,
    cfg,
    critiquing(state, (r) => (r === 0 ? [blocker('the-p0', 'P0')] : []), byVerifier(NOT_REAL, NOT_REAL, REAL)),
    calls,
  );
  assert.equal(err.code, EXIT.NEEDS_HUMAN);
  assert.deepEqual(err.findings?.map((f) => f.id), ['the-p0']);
  const file = escalationFile(state, err);
  return { state, cfg, needsInput: readFileSync(file, 'utf8'), calls };
}

test('unconfirmedP0 "halt": exit 2, the artifact holds the P0 unmoved, and NEEDS-INPUT.md lists every ballot', async () => {
  const { state, needsInput, calls } = await halted('vibe-cvotes-p0-halt-');
  assert.equal(calls.includes('revise-1'), false);
  const [found] = critiqueArtifact(state);
  assert.equal(found?.severity, 'P0');
  assert.equal(found?.downgraded, undefined);
  assert.equal(found?.votes?.outcome, 'unconfirmed');
  assert.match(needsInput, /critique\.unconfirmedP0 is "halt"/);
  assert.match(needsInput, /## Unconfirmed P0 findings/);
  for (const [seat, reason] of [
    ['critique.verifiers[0]', 'The plan handles it in step 2.'],
    ['critique.verifiers[1]', 'The plan handles it in step 2.'],
    ['critique.verifiers[2]', 'It is there.'],
  ] as const) {
    assert.ok(needsInput.includes(`\`${seat}\``) && needsInput.includes(reason), `${seat} is not named`);
  }
  assert.match(needsInput, /### Move: `the-p0`/);
});

test('a resume after "halt" with nothing changed revises the plan with the P0 blocking, and votes on nothing', async () => {
  const { state, cfg } = await halted('vibe-cvotes-p0-halt-resume-');
  const { calls, prompts } = await drive(
    state,
    cfg,
    critiquing(state, () => [], () => assert.fail('no vote on resume')),
    true,
  );
  assert.equal(calls[0], 'revise-1', calls.join(', '));
  assert.equal(calls.some((l) => l.startsWith('critique-0-')), false);
  assert.match(prompts.get('revise-1') ?? '', /### \[P0\] Finding the-p0/);
  assert.equal(state.status, 'planned');
});

test('a resume after "halt" with the P0 demoted approves the plan with no further critique', async () => {
  const { state, cfg } = await halted('vibe-cvotes-p0-halt-moved-');
  moveInNeedsInput(state, [{ id: 'the-p0', to: 'P2', why: 'The verifiers are right.' }]);
  const { calls } = await drive(
    state,
    cfg,
    critiquing(
      state,
      () => assert.fail('the critic was asked again'),
      () => assert.fail('no vote on resume'),
    ),
    true,
  );
  assert.deepEqual(calls, []);
  const approved = state.events.filter((e) => e.type === 'plan_approved');
  assert.equal(approved.length, 1);
  assert.equal(approved[0]?.['byPerson'], true);
});

test('a revision is shown a vote-moved finding as non-blocking, with its tally', async () => {
  const state = run('vibe-cvotes-revise-');
  const { prompts } = await drive(
    state,
    withCritique({ verifiers: THREE }),
    critiquing(
      state,
      (r) => (r === 0 ? [blocker('stuck'), { ...blocker('weak'), title: 'An unrelated weak claim' }] : []),
      (label, prompt) => (prompt.includes('Finding stuck') ? REAL : byVerifier(NOT_REAL, NOT_REAL, REAL)(label)),
    ),
  );
  const revise = prompts.get('revise-1') ?? '';
  assert.match(revise, /### \[P1\] Finding stuck/);
  assert.match(
    revise,
    /### \[P2\] An unrelated weak claim {2}`weak`[\s\S]*\*Unconfirmed by vote:\* unconfirmed by vote: 1 real, 2 not-real, 0 cannot-tell of 3 \(quorum 2\) - non-blocking\./,
  );
  assert.equal((revise.match(/Unconfirmed by vote/g) ?? []).length, 1, 'only the moved finding carries it');
});

/**
 * Every round: one P1 the vote confirms, under the same id, and three fresh
 * ones it does not. With no verifiers the fresh ones are new blockers every
 * round, which is exactly what `planStall` calls a stall; with the vote they
 * never block, so they never reach `p1Rounds` and the loop never stalls.
 */
function churning(r: number): Finding[] {
  return [blocker('stuck'), ...['a', 'b', 'c'].map((x) => ({ ...blocker(`r${r}-${x}`), title: `Fresh claim ${x} in round ${r}` }))];
}

function churnVotes(_label: string, prompt: string): unknown {
  return prompt.includes('Finding stuck') ? REAL : NOT_REAL;
}

test('p1Rounds and the stall detector see only what the vote left blocking', async () => {
  const control = run('vibe-cvotes-stall-control-');
  await stopped(control, withCritique({}, { maxPlanRounds: 5 }), critiquing(control, churning, () => assert.fail('no verifiers')));
  assert.ok(control.events.some((e) => e.type === 'plan_stalled'), 'without the vote, the fresh P1s stall the loop');

  const state = run('vibe-cvotes-stall-');
  const err = await stopped(state, withCritique({ verifiers: THREE }, { maxPlanRounds: 5 }), critiquing(state, churning, churnVotes));
  assert.equal(err.code, EXIT.NO_CONVERGENCE);
  assert.equal(state.events.some((e) => e.type === 'plan_stalled'), false);
  assert.ok(state.p1Rounds.length >= 3, `${state.p1Rounds.length} rounds recorded`);
  for (const record of state.p1Rounds) assert.deepEqual(record.ids, ['stuck']);
  // What stopped it is the one P1 the vote kept: the repeat check, not a stall.
  assert.deepEqual(err.findings?.map((f) => f.id), ['stuck']);
});
