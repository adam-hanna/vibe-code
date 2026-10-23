import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumesOnMovesAlone } from '@src/cli.js';
import { setSink } from '@src/log.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import type { Config, LoopConfig, RunState } from '@src/types.js';
import {
  agents,
  answerNeedsInput,
  config,
  escalationFile,
  findingFixture,
  freshRun,
  moveInNeedsInput,
  p1,
  planFixture,
  report,
  stalledPlan,
} from './helpers/loop-harness.js';

/**
 * Demoting plan findings on a resume approves the plan when the gate passes
 * (#394).
 *
 * It used to buy one more revise-and-critique round: the moves rewrote
 * `pendingFindings` and the consume branch sent every one of them, P2s
 * included, to the planner, then ran a new critique - the very round in which
 * the stalled runs' critics found new P1s. So the stall question's "accept the
 * remaining P1s" could not have done what it says. This is a behaviour change
 * for every plan stop, not only a stall, and the ordinary-stop case below is
 * there to say so on its own.
 */

/** New P1s every critique round: three on an odd round, two on an even one. */
function churn(label: string): object {
  const round = Number(label.replace('critique-', ''));
  const ids = round % 2 === 1 ? ['a', 'b', 'c'] : ['a', 'b'];
  return report(ids.map((id) => p1(`r${round}-${id}`)));
}

function loop(over: Partial<LoopConfig> = {}): Config {
  return config({ maxPlanRounds: 20, ...over });
}

/** A run stopped by its second stall, holding r5-a, r5-b and r5-c. */
async function escalated(): Promise<{ state: RunState; error: Escalation }> {
  const state = freshRun({ prefix: 'vibe-accept-', task: 'accept on demotion' });
  state.plan = planFixture();
  let error: unknown = null;
  try {
    await orchestrate(state, loop(), true, agents({ claude: () => planFixture(), codex: churn }, []));
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof Escalation && error.code === EXIT.NEEDS_HUMAN, 'expected the stall question');
  return { state, error };
}

/** A resume that must not spend a turn: either agent being reached fails it. */
async function resumeSpendingNothing(state: RunState, cfg: Config): Promise<string[]> {
  const calls: string[] = [];
  await orchestrate(
    state,
    cfg,
    true,
    agents(
      {
        claude: (label) => assert.fail(`the planner was asked again: ${label}`),
        codex: (label) => assert.fail(`the critic was asked again: ${label}`),
      },
      calls,
    ),
  );
  return calls;
}

function approval(state: RunState): Record<string, unknown> {
  const events = state.events.filter((e) => e.type === 'plan_approved');
  assert.equal(events.length, 1, 'exactly one approval');
  const { at: _at, type: _type, ...data } = events[0] ?? { at: '', type: '' };
  return data;
}

const DEMOTE = 'Real, and not worth another round.';

test('after the escalation, demoting every blocker approves the plan with no revise and no critique', async () => {
  const { state } = await escalated();
  moveInNeedsInput(
    state,
    ['r5-a', 'r5-b', 'r5-c'].map((id) => ({ id, to: 'P2' as const, why: DEMOTE })),
  );

  const calls = await resumeSpendingNothing(state, loop());
  assert.deepEqual(calls, []);

  // The same record a gate pass writes over the same findings, plus one field.
  const passed = freshRun({ prefix: 'vibe-accept-' });
  passed.plan = planFixture();
  await orchestrate(
    passed,
    loop(),
    true,
    agents({ codex: () => report(['r5-a', 'r5-b', 'r5-c'].map((id) => findingFixture({ id, title: `Finding ${id}` }))) }, []),
  );
  assert.deepEqual(approval(state), { ...approval(passed), byPerson: true });

  assert.equal(state.pendingFindings, null);
  assert.deepEqual(state.acceptanceCriteria, passed.acceptanceCriteria);
  assert.equal(state.carried, undefined);
  assert.deepEqual(state.declined, passed.declined);
});

test('with p1Tolerance 1, demoting all but one P1 approves and carries the one left', async () => {
  const { state } = await escalated();
  moveInNeedsInput(state, [
    { id: 'r5-a', to: 'P2', why: DEMOTE },
    { id: 'r5-b', to: 'P3', why: DEMOTE },
  ]);

  const calls = await resumeSpendingNothing(state, loop({ p1Tolerance: 1 }));
  assert.deepEqual(calls, []);
  assert.deepEqual(state.carried?.map((f) => f.id), ['r5-c']);
  assert.deepEqual(approval(state)['carried'], ['r5-c']);
  assert.equal(approval(state)['byPerson'], true);
});

test('demoting too few to pass the gate revises and critiques as before', async () => {
  const { state } = await escalated();
  moveInNeedsInput(state, [{ id: 'r5-a', to: 'P2', why: DEMOTE }]);

  const calls: string[] = [];
  await orchestrate(
    state,
    loop({ p1Tolerance: 1 }),
    true,
    agents({ claude: () => planFixture(), codex: () => report([]) }, calls),
  );
  assert.deepEqual(calls, ['revise-6', 'critique-6']);
  assert.equal(approval(state)['byPerson'], undefined);
});

test('on an ordinary plan stop, demoting and resuming approves - the behaviour change, on its own', async () => {
  // The round cap, not a stall: this is every plan stop.
  const { state } = await stalledPlan();
  moveInNeedsInput(state, [
    { id: 'finding-one', to: 'P2', why: DEMOTE },
    { id: 'finding-two', to: 'P2', why: DEMOTE },
  ]);

  const calls = await resumeSpendingNothing(state, config({ maxPlanRounds: 5 }));
  assert.deepEqual(calls, []);
  assert.equal(approval(state)['byPerson'], true);
  assert.equal(state.pendingFindings, null);
});

test('with no moves, a resumed plan stop revises and critiques exactly as before', async () => {
  const { state } = await stalledPlan();
  const calls: string[] = [];
  await orchestrate(
    state,
    config({ maxPlanRounds: 5 }),
    true,
    agents({ claude: () => planFixture(), codex: () => report([]) }, calls),
  );
  assert.deepEqual(calls, ['revise-1', 'critique-1']);
  assert.equal(approval(state)['byPerson'], undefined);
});

// ---- an answer wins --------------------------------------------------------

/** The stall's question answered in free text, and every blocker demoted as well. */
async function answeredAndDemoted(): Promise<RunState> {
  const { state, error } = await escalated();
  escalationFile(state, error);
  answerNeedsInput(state, () => 'Continue, but keep the parser out of it.');
  moveInNeedsInput(
    state,
    ['r5-a', 'r5-b', 'r5-c'].map((id) => ({ id, to: 'P2' as const, why: DEMOTE })),
  );
  return state;
}

test('an answer given beside demotions is revised and critiqued, and nothing is accepted', async (t) => {
  const state = await answeredAndDemoted();
  const said: string[] = [];
  setSink((n) => said.push(n.message));
  t.after(() => setSink(null));

  const calls: string[] = [];
  await orchestrate(state, loop(), true, agents({ claude: () => planFixture(), codex: () => report([]) }, calls));

  assert.deepEqual(calls, ['revise-q0', 'revise-6', 'critique-6']);
  assert.equal(approval(state)['byPerson'], undefined);
  assert.ok(
    said.some((m) => m.startsWith('Your severity changes were not taken as accepting the plan, because an answer was also given')),
  );
  assert.equal(state.planRevisedByAnswer, undefined, 'cleared by the findings revision');
});

test('a stop after the answer revision has saved still does not accept on the next resume', async () => {
  const state = await answeredAndDemoted();
  // Dies on the findings revision, after the answers revision has been saved.
  await assert.rejects(() =>
    orchestrate(
      state,
      loop(),
      true,
      agents(
        {
          claude: (label) => {
            if (label.startsWith('revise-q')) return planFixture({ plan_md: '# answered' });
            throw new Error('the process died here');
          },
        },
        [],
      ),
    ),
  );
  assert.equal(state.pendingAnswers, null, 'the answers were consumed');
  assert.equal(state.planRevisedByAnswer, true, 'and the marker says a critic has not read the result');

  const calls: string[] = [];
  await orchestrate(state, loop(), true, agents({ claude: () => planFixture(), codex: () => report([]) }, calls));
  // `revise-7`, not `revise-6`: the death spent round 6, as any death mid-revision
  // does. What matters is that a revision and a critique ran, not an approval.
  assert.deepEqual(calls, ['revise-7', 'critique-7']);
  assert.equal(approval(state)['byPerson'], undefined);
  assert.equal(state.planRevisedByAnswer, undefined);
});

// ---- the CLI ---------------------------------------------------------------

test('an unanswered NEEDS-INPUT.md resumes on its moves alone, in the plan phase only', () => {
  assert.equal(resumesOnMovesAlone(2, 'plan'), true);
  assert.equal(resumesOnMovesAlone(0, 'plan'), false);
  assert.equal(resumesOnMovesAlone(2, 'review'), false);
  assert.equal(resumesOnMovesAlone(2, null), false);
});
