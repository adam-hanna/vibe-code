import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import {
  agents,
  answerNeedsInput,
  answersReport,
  config,
  escalationFile,
  freshRun,
  planFixture,
  questionFixture,
  report,
} from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * What happens to a plan that has to ask something.
 *
 * The answerer, the two ways it may decline, and the round trip through
 * NEEDS-INPUT.md that a human's reply takes to get back into the loop. None of
 * this was reachable before the harness: the question path needs a plan turn
 * that returns open questions and an answerer turn whose output parses as an
 * answers report, and no test could produce either without spawning.
 *
 * These stop after the plan phase (`planOnly`, as the other plan-phase cases
 * do) because the questions are asked and settled inside `planPhase`; what
 * happens afterwards is `full-loop.test.ts`'s subject.
 */

const RUN = { prefix: 'vibe-question-', task: 'question escalation' } as const;
const QUESTION = questionFixture().question;

function questioningRun(): RunState {
  return freshRun({ ...RUN });
}

/** A first plan that asks, and a revision that does not. */
function planner(): (label: string) => unknown {
  return (label) =>
    label === 'plan' ? planFixture({ open_questions: [questionFixture()] }) : planFixture();
}

test('a blocking question is put to the answerer, and its answer is revised in', async () => {
  const state = questioningRun();
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: planner(),
        codex: (label) => (label === 'answers-0' ? answersReport([{}]) : report([])),
      },
      calls,
    ),
  );

  assert.deepEqual(calls, ['plan', 'answers-0', 'revise-1', 'critique-1']);
  assert.equal(existsSync(path.join(state.dir, 'answers-0.json')), true);
  assert.equal(state.questionRound, 1);
});

test('a question the answerer defers to a human stops the run', async () => {
  const state = questioningRun();
  const calls: string[] = [];

  await assert.rejects(
    () =>
      orchestrate(
        state,
        config(),
        false,
        agents(
          {
            claude: planner(),
            codex: (label) =>
              label === 'answers-0' ? answersReport([{ defer_to_human: true }]) : report([]),
          },
          calls,
        ),
      ),
    (err: unknown) =>
      err instanceof Escalation &&
      err.code === EXIT.NEEDS_HUMAN &&
      err.questions?.[0]?.question === QUESTION,
  );

  // Building on a guess about product intent is expensive to undo, so the run
  // stops rather than revising against an answer nobody gave.
  assert.deepEqual(calls, ['plan', 'answers-0']);
});

test('a low-confidence answer to a blocking question stops the run too', async () => {
  const state = questioningRun();

  await assert.rejects(
    () =>
      orchestrate(
        state,
        config(),
        false,
        agents(
          {
            claude: planner(),
            codex: (label) =>
              label === 'answers-0' ? answersReport([{ confidence: 'low' }]) : report([]),
          },
          [],
        ),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.NEEDS_HUMAN,
  );
});

test('a declined advisory question is recorded and the loop carries on', async () => {
  const state = questioningRun();
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: (label) =>
          label === 'plan'
            ? planFixture({ open_questions: [questionFixture({ blocking: false })] })
            : planFixture(),
        codex: (label) =>
          label === 'answers-0' ? answersReport([{ defer_to_human: true }]) : report([]),
      },
      calls,
    ),
  );

  // The planner already said its fallback was survivable, so halting here would
  // trade an unattended run for a question it was willing to answer itself.
  assert.deepEqual(calls, ['plan', 'answers-0', 'critique-0']);
  assert.deepEqual(state.deferredQuestions.map((q) => q.question), [QUESTION]);
});

test('a human answer in NEEDS-INPUT.md is read back and resumed against', async () => {
  const state = questioningRun();

  const stop = await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: planner(),
        codex: (label) =>
          label === 'answers-0' ? answersReport([{ defer_to_human: true }]) : report([]),
      },
      [],
    ),
  ).then(
    () => assert.fail('the blocking question should have stopped the run'),
    (err: unknown) => err as Escalation,
  );

  const file = escalationFile(state, stop);
  const template = readFileSync(file, 'utf8');
  assert.match(template, /\*\*Your answer:\*\*/);
  assert.ok(template.includes(QUESTION));

  const answers = answerNeedsInput(state, () => 'Lazy, and measure it.');
  assert.deepEqual(answers.map((a) => a.answer), ['Lazy, and measure it.']);
  assert.equal(state.pendingAnswers?.length, 1);
  // Retired, so a later escalation writes a fresh one rather than replaying
  // these.
  assert.equal(existsSync(file), false);

  const resumed: string[] = [];
  await orchestrate(
    state,
    config(),
    true,
    agents({ claude: planner(), codex: () => report([]) }, resumed),
  );

  // The answers are revised in first, and the question is not put to the
  // answerer a second time however the revision rephrases it.
  assert.deepEqual(resumed, ['revise-1', 'critique-1']);
  assert.equal(state.pendingAnswers, null);
});

test('with the answerer switched off, a blocking question stops the run before any turn', async () => {
  const state = questioningRun();
  const calls: string[] = [];

  await assert.rejects(
    () =>
      orchestrate(
        state,
        config({}, { questions: { ...DEFAULTS.questions, askCodex: false } }),
        false,
        agents({ claude: planner() }, calls),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.NEEDS_HUMAN,
  );

  assert.deepEqual(calls, ['plan']);
});
