import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isPlaceholderPlan, refusePlaceholderPlan } from '@src/evidence.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import {
  agents,
  committing,
  config,
  freshRun,
  p1,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { FindingsReport, RunState } from '@src/types.js';

/**
 * A plan that is not a plan (#108).
 *
 * Run `20260829-083852-issue-66-record-what-a-turn-actually-did` stored a
 * 130-byte `plan-0.json` whose `plan_md` was the literal `« see below »`, on a
 * brief of the shape that had converged twenty-three times. The critic caught it
 * exactly, at P1 - and then `gate` compared one P1 against `loop.p1Tolerance: 1`,
 * passed, and the run implemented. It finished green only because the
 * implementer resumes the planner's conversation and inherited reasoning that
 * never reached `plan_md`; everything that reads `state.plan` got the
 * placeholder.
 */

const STUB = '« see below »';

function reportWith(findings: FindingsReport['findings']): FindingsReport {
  return { verdict: findings.length > 0 ? 'REVISE' : 'APPROVE', summary: 'summary', findings };
}

// ---- what counts as a placeholder ------------------------------------------

test('the body that was actually stored is recognised, however it is dressed', () => {
  // The first is verbatim from `plan-0.json`. The rest are the same failure with
  // the scaffolding a model puts around it - a title, a bullet, a blockquote -
  // none of which carries a claim of its own.
  for (const body of [
    STUB,
    '« see below »\n',
    '# Plan\n\n« see below »\n',
    '## Implementation plan\n\n- see above\n',
    '> As described below.\n',
    '**TBD**',
    'TODO',
    '',
    '   \n\n\t\n',
    '---\n',
  ]) {
    assert.equal(isPlaceholderPlan(body), true, `should be refused: ${JSON.stringify(body)}`);
  }
});

test('a plan that says real work is not refused, however short', () => {
  for (const body of [
    planFixture().plan_md,
    'Delete `changedFiles` from src/git.ts.',
    // One line of content among the scaffolding is enough: judging whether a
    // plan is GOOD is the critic's job, and this guard has no opinion about it.
    '# Plan\n\nAdd a timeout to the readiness wait.\n',
    // The words appear, in a sentence. A substring rule would refuse this, which
    // is why the match is whole-line equality.
    '# Plan\n\nRewrite `gate` as described below, then see above for the rollback.\n',
    // A terse plan for a one-line change. A length threshold would refuse it.
    'Set `loop.p1Tolerance` to 0.',
  ]) {
    assert.equal(isPlaceholderPlan(body), false, `should be allowed: ${JSON.stringify(body)}`);
  }
});

// ---- what the guard puts in the report --------------------------------------

test('the refusal is a P0, and it names the artifact and the field', () => {
  const { report: out, raised } = refusePlaceholderPlan(reportWith([]), STUB, 'plan-0.json');

  assert.notEqual(raised, null);
  // P0 and not P1 is the whole point: `p1Tolerance` ends an argument about a
  // plan, and must not be able to authorise proceeding without one.
  assert.equal(raised?.severity, 'P0');
  assert.match(raised?.detail ?? '', /plan-0\.json/);
  assert.match(raised?.detail ?? '', /plan_md/);
  assert.match(raised?.detail ?? '', /« see below »/);
  assert.deepEqual(raised?.evidence, [{ kind: 'artifact', path: 'plan-0.json' }]);
  assert.equal(out.findings[0], raised);
});

test("the critic's own findings are kept beside it, not replaced", () => {
  // Two findings about one defect is the honest record: one is the critic's
  // judgement, one is a mechanical fact about the artifact on disk. In the run
  // that produced this issue the critic was right, and deleting its finding
  // would delete the evidence that it was.
  const theirs = p1('plan-body-is-missing');
  const { report: out } = refusePlaceholderPlan(reportWith([theirs]), STUB, 'plan-0.json');

  assert.equal(out.findings.length, 2);
  assert.ok(out.findings.includes(theirs));
});

test('a real plan is passed through untouched, object identity included', () => {
  const input = reportWith([p1('ordinary')]);
  const { report: out, raised } = refusePlaceholderPlan(input, planFixture().plan_md, 'plan-0.json');

  assert.equal(raised, null);
  assert.equal(out, input, 'no rewrite at all when there is nothing to refuse');
});

// ---- through the loop -------------------------------------------------------

const RUN = { prefix: 'vibe-placeholder-', task: 'placeholder plan' } as const;

function fullRun(): RunState {
  return freshRun({ ...RUN, planOnly: false, git: true, commit: true });
}

/** A planner whose plan body is decided per turn label. */
function planning(state: RunState, body: (label: string) => string): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-')
        ? planFixture({ plan_md: body(label) })
        : work(state, `${label}.txt`),
    // Approving, deliberately: the guard has to hold on its own, without relying
    // on the critic noticing. In the observed run the critic DID notice and it
    // made no difference, because its finding was a tolerable P1.
    codex: () => report([]),
  };
}

test('a placeholder plan never reaches the implement phase, though the critic approved it', async () => {
  const state = fullRun();
  const calls: string[] = [];

  await assert.rejects(
    () =>
      orchestrate(
        state,
        // The tolerance the observed run was on. Nothing here depends on its
        // value: a P0 is never carried and never tolerated.
        config({ p1Tolerance: 1, maxPlanRounds: 2 }, { ...committing(), ...verifying(state) }),
        false,
        agents(planning(state, () => STUB), calls),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.NO_CONVERGENCE,
  );

  assert.equal(
    calls.includes('implement'),
    false,
    'a run with no plan must not implement one',
  );
  // Bounded by the cap that already exists, rather than by a new one: the guard
  // adds a finding and lets `guardProgress` do what it does for any blocker.
  assert.deepEqual(calls, ['plan', 'critique-0', 'revise-1', 'critique-1']);
  assert.equal(state.events.filter((e) => e.type === 'plan_placeholder_refused').length, 2);
});

test('the round artifact records what the run refused on', async () => {
  const state = fullRun();

  await assert.rejects(
    () =>
      orchestrate(
        state,
        config({ p1Tolerance: 1, maxPlanRounds: 1 }, { ...committing(), ...verifying(state) }),
        false,
        agents(planning(state, () => STUB), []),
      ),
    (err: unknown) => err instanceof Escalation,
  );

  const critique = JSON.parse(
    readFileSync(path.join(state.dir, 'plan-critique-0.json'), 'utf8'),
  ) as FindingsReport;
  const raised = critique.findings.find((f) => f.id === 'plan-body-is-a-placeholder');
  assert.equal(raised?.severity, 'P0');
});

test('a planner that fixes its stub on the next round proceeds normally', async () => {
  // The guard is a refusal, not a dead end: it reaches the planner through the
  // ordinary revision path, and a plan that arrives is implemented.
  const state = fullRun();
  const calls: string[] = [];

  await orchestrate(
    state,
    config({ p1Tolerance: 1 }, { ...committing(), ...verifying(state) }),
    false,
    agents(
      planning(state, (label) => (label === 'plan' ? STUB : planFixture().plan_md)),
      calls,
    ),
  );

  assert.deepEqual(calls, ['plan', 'critique-0', 'revise-1', 'critique-1', 'implement', 'review-0']);
  assert.equal(state.status, 'done');
});

test('one ordinary P1 still proceeds under p1Tolerance 1 - the tolerance is not removed', async () => {
  // The control the issue asked for. What changed is that "there is no plan" is
  // no longer expressible as one tolerable P1, not that one tolerable P1 stopped
  // being tolerable.
  const state = fullRun();
  const calls: string[] = [];

  await orchestrate(
    state,
    config({ p1Tolerance: 1 }, { ...committing(), ...verifying(state) }),
    false,
    agents(
      {
        claude: (label) =>
          label === 'plan' || label.startsWith('revise-')
            ? planFixture()
            : work(state, `${label}.txt`),
        codex: (label) => (label === 'critique-0' ? report([p1('ordinary-p1')]) : report([])),
      },
      calls,
    ),
  );

  assert.ok(calls.includes('implement'), 'a tolerated P1 still carries into implementation');
  assert.deepEqual(state.carried?.map((f) => f.id), ['ordinary-p1']);
});
