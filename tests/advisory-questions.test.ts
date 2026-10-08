import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '@src/orchestrator.js';
import { agents, answersReport, config, freshRun, p1, planFixture, questionFixture, report } from './helpers/loop-harness.js';

/**
 * A question round whose questions are all advisory buys no planner revision (#277).
 *
 * On the #249 run one advisory question - about the wording of a log line - cost
 * a 21s answer and then a 79s, 237k-token revision before the critique could
 * start. An advisory question is one the planner said does not change what the
 * plan does, so the answers go to the critic with the plan instead, and a real
 * consequence comes back as a finding.
 */
const ANSWER = 'Keep the sentence byte-identical when no base is set.';
const advisory = (): unknown => planFixture({ open_questions: [questionFixture({ blocking: false })] });

test('an advisory-only round goes straight to the critique, which is shown the answer', async () => {
  const state = freshRun({ prefix: 'vibe-advisory-', task: 'advisory questions' });
  const calls: string[] = [];
  let critiquePrompt = '';

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: (label) => (label === 'plan' ? advisory() : planFixture()),
        codex: (label, options) => {
          if (label.startsWith('critique-')) critiquePrompt = String(options.prompt);
          return label.startsWith('answers-') ? answersReport([{ answer: ANSWER }]) : report([]);
        },
      },
      calls,
    ),
  );

  // No `revise-q1` between the answer and the critique.
  assert.deepEqual(calls.slice(0, 3), ['plan', 'answers-1', 'critique-0']);
  assert.ok(critiquePrompt.includes(ANSWER), 'the critic judges the plan knowing the answer');
  assert.match(critiquePrompt, /raise it as a finding/);
  // And it is not left where a resume would buy the skipped revision back.
  assert.equal(state.pendingAnswers, null);
});

test('when the critique sends the plan back, that revision folds the answers in and clears them', async () => {
  const state = freshRun({ prefix: 'vibe-advisory-', task: 'advisory questions' });
  const calls: string[] = [];
  let revisePrompt = '';

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: (label, options) => {
          if (label === 'revise-1') revisePrompt = String(options.prompt);
          return label === 'plan' ? advisory() : planFixture();
        },
        codex: (label) => {
          if (label.startsWith('answers-')) return answersReport([{ answer: ANSWER }]);
          // The first critique objects; the second approves.
          if (label === 'critique-0') return report([p1('contradicts-answer'), p1('second-objection')]);
          return report([]);
        },
      },
      calls,
    ),
  );

  assert.deepEqual(calls.slice(0, 5), ['plan', 'answers-1', 'critique-0', 'revise-1', 'critique-1']);
  assert.ok(revisePrompt.includes(ANSWER), 'the one revision the run pays for takes the answer');
  assert.equal(state.advisoryAnswers, undefined, 'and it is consumed on that revision');
});

test('a round with a blocking question still revises before anything judges the plan', async () => {
  const state = freshRun({ prefix: 'vibe-advisory-', task: 'advisory questions' });
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: (label) =>
          label === 'plan' ? planFixture({ open_questions: [questionFixture({ blocking: true })] }) : planFixture(),
        codex: (label) => (label.startsWith('answers-') ? answersReport([{ answer: ANSWER }]) : report([])),
      },
      calls,
    ),
  );

  assert.deepEqual(calls.slice(0, 4), ['plan', 'answers-1', 'revise-q1', 'critique-0']);
  assert.equal(state.advisoryAnswers, undefined);
});
