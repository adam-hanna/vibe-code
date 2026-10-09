import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { commitFork, planFork } from '@src/fork.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import { listCheckpoints, loadRun } from '@src/run.js';
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
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { Host } from '@src/host.js';
import type { Answer, GatesConfig, OpenQuestion, RunState } from '@src/types.js';

/**
 * An answerer turn's answers survive every way of stopping before the revision
 * that consumes them (#169).
 *
 * `resolveQuestions` marked every question answered - durably, one `saveState`
 * per key - and returned the answers only in memory. Anything that stopped the
 * run before `revisePlan` persisted the plan kept the marks and lost the
 * answers, so the resumed loop's `isAnswered` suppressed the questions and the
 * critic was handed a plan whose questions nothing had resolved. Silently.
 *
 * Four exits did it and each is a case here: a death between the two turns, a
 * declined blocking question, a `stop` gate at `question-round`, and a `step`
 * hold there that somebody answered with stop. The marking order is #65's and
 * is not what moved: the answers now ride on the write that holds the marks.
 */

const RUN = { prefix: 'vibe-answers-survive-', task: 'answers survive a stop' } as const;

const A = questionFixture({ question: 'Should the cache be per user or global?' });
const B = questionFixture({ question: 'Which database should the audit log live in?' });

/** A first plan that asks, and every revision after it asks nothing. */
function planner(
  questions: readonly OpenQuestion[],
  revise?: (options: ClaudeTurnOptions) => unknown,
): (label: string, options: ClaudeTurnOptions) => unknown {
  return (label, options) => {
    if (label === 'plan') return planFixture({ open_questions: [...questions] });
    return revise?.(options) ?? planFixture();
  };
}

function gates(over: Partial<GatesConfig>): GatesConfig {
  return {
    'plan-round': 'auto',
    'question-round': 'auto',
    'plan-approved': 'auto',
    implemented: 'auto',
    'verify-round': 'auto',
    'review-round': 'auto',
    ...over,
  };
}

/** What is on disk, not what the in-memory state happens to hold. */
function stored(state: RunState): RunState {
  return JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as RunState;
}

function answerTexts(answers: readonly Answer[] | null | undefined): string[] {
  return (answers ?? []).map((a) => a.answer);
}

/** The prompt each Claude turn was given, by label. */
function prompting(
  prompts: Map<string, string>,
  produce: (label: string) => unknown,
): (label: string, options: ClaudeTurnOptions) => unknown {
  return (label, options) => {
    prompts.set(label, options.prompt);
    return produce(label);
  };
}

/** The run's ending, or a failure if it had none. */
async function stopped(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => assert.fail('the run should have stopped'),
    (err: unknown) => err,
  );
}

const noSecondAnswerer = (label: string): unknown => {
  if (label.startsWith('answers-')) assert.fail(`a second answerer turn was bought: ${label}`);
  return report([]);
};

test('a run that dies between the answerer and the revision resumes against the answers', async () => {
  const state = freshRun({ ...RUN });

  const first: string[] = [];
  await stopped(
    orchestrate(
      state,
      config(),
      false,
      agents(
        {
          claude: planner([A], () => {
            throw new Error('the process died before the plan was persisted');
          }),
          codex: (label) =>
            label.startsWith('answers-') ? answersReport([{ question: A.question, answer: 'ANS-1' }]) : report([]),
        },
        first,
      ),
    ),
  );
  assert.deepEqual(first, ['plan', 'answers-1', 'revise-q1']);
  // The defect's signature was this pair: the question marked answered, and
  // nothing on disk saying what the answer was.
  assert.deepEqual(answerTexts(stored(state).pendingAnswers), ['ANS-1']);
  assert.equal(stored(state).answeredQuestions.length > 0, true);

  const resumed = loadRun(state.targetDir, state.id);
  const prompts = new Map<string, string>();
  const calls: string[] = [];
  await orchestrate(
    resumed,
    config(),
    true,
    agents({ claude: prompting(prompts, () => planFixture()), codex: noSecondAnswerer }, calls),
  );

  assert.deepEqual(calls, ['revise-q1', 'critique-0']);
  assert.match(prompts.get('revise-q1') ?? '', /ANS-1/);
  assert.equal(stored(resumed).pendingAnswers, null);
});

test('a declined blocking question escalates, and every usable answer is kept - unpaired too', async () => {
  const state = freshRun({ ...RUN });

  const err = await stopped(
    orchestrate(
      state,
      config(),
      false,
      agents(
        {
          claude: planner([A, B]),
          codex: (label) =>
            label.startsWith('answers-')
              ? answersReport([
                  { question: A.question, answer: 'ANS-A' },
                  { question: B.question, answer: 'I cannot say.', defer_to_human: true },
                  // Pairs with no question asked. It still reaches the revision
                  // when nothing stops the run, so it is still kept when something does.
                  { question: 'An unrelated point the answerer raised', answer: 'UNPAIRED' },
                ])
              : report([]),
        },
        [],
      ),
    ),
  );

  assert.ok(err instanceof Escalation, String(err));
  assert.equal(err.code, EXIT.NEEDS_HUMAN);
  assert.deepEqual((err.questions ?? []).map((q) => q.question), [B.question]);
  // The whole usable list, in the answerer's order, and never the decline.
  assert.deepEqual(answerTexts(stored(state).pendingAnswers), ['ANS-A', 'UNPAIRED']);
});

test('a stop gate at question-round leaves the answers on disk', async () => {
  const state = freshRun({ ...RUN });

  const err = await stopped(
    orchestrate(
      state,
      config({}, { gates: gates({ 'question-round': 'stop' }) }),
      false,
      agents(
        {
          claude: planner([A]),
          codex: (label) =>
            label.startsWith('answers-') ? answersReport([{ question: A.question, answer: 'ANS-1' }]) : report([]),
        },
        [],
      ),
    ),
  );

  assert.ok(err instanceof Escalation, String(err));
  assert.deepEqual(answerTexts(stored(state).pendingAnswers), ['ANS-1']);
});

test('a step hold at question-round answered with stop leaves the answers on disk', async () => {
  const state = freshRun({ ...RUN });
  const host: Host = { decide: () => Promise.resolve({ kind: 'stop' }) };

  const err = await stopped(
    orchestrate(
      state,
      config({}, { gates: gates({ 'question-round': 'step' }) }),
      false,
      agents(
        {
          claude: planner([A]),
          codex: (label) =>
            label.startsWith('answers-') ? answersReport([{ question: A.question, answer: 'ANS-1' }]) : report([]),
        },
        [],
      ),
      host,
    ),
  );

  assert.ok(err instanceof Escalation, String(err));
  assert.deepEqual(answerTexts(stored(state).pendingAnswers), ['ANS-1']);
});

test('on a NEEDS-INPUT resume the person wins, and the answerer stands where they left a blank', async () => {
  const state = freshRun({ ...RUN });

  // The `question-round` stop hands back every question the round put,
  // including the two the answerer already answered - which is what makes the
  // collision below the normal case on this path rather than an edge.
  const err = await stopped(
    orchestrate(
      state,
      config({}, { gates: gates({ 'question-round': 'stop' }) }),
      false,
      agents(
        {
          claude: planner([A, B]),
          codex: (label) =>
            label.startsWith('answers-')
              ? answersReport([
                  { question: A.question, answer: 'ANSWERER-A' },
                  { question: B.question, answer: 'ANSWERER-B' },
                ])
              : report([]),
        },
        [],
      ),
    ),
  );
  assert.ok(err instanceof Escalation, String(err));
  escalationFile(state, err);

  // B is left blank, which `parseHumanAnswers` drops rather than reading as an
  // answer of nothing.
  const human = answerNeedsInput(state, (question) => (question.startsWith(A.question) ? 'HUMAN-A' : ''));
  assert.deepEqual(answerTexts(human), ['HUMAN-A']);

  assert.deepEqual(answerTexts(state.pendingAnswers), ['HUMAN-A', 'ANSWERER-B']);
  assert.deepEqual(answerTexts(stored(state).pendingAnswers), ['HUMAN-A', 'ANSWERER-B']);
  // `humanAnswered` means a person answered, so the answerer's B is not in it.
  assert.equal(state.humanAnswered?.length, 1);
  assert.ok(state.humanAnswered?.[0]?.startsWith(A.question), String(state.humanAnswered));

  const prompts = new Map<string, string>();
  const calls: string[] = [];
  await orchestrate(
    state,
    config(),
    true,
    agents({ claude: prompting(prompts, () => planFixture()), codex: noSecondAnswerer }, calls),
  );

  assert.deepEqual(calls, ['revise-q1', 'critique-0']);
  const prompt = prompts.get('revise-q1') ?? '';
  assert.match(prompt, /HUMAN-A/);
  assert.match(prompt, /ANSWERER-B/);
  assert.doesNotMatch(prompt, /ANSWERER-A/);
});

test('the answers are consumed by the write that persists the plan answering them', async () => {
  // The artifact write after `revisePlan`'s `saveState` is made to fail, so the
  // state on disk is exactly what that one write left. It has to hold both: the
  // revised plan, and no answers left to revise against again. Failure is
  // provoked portably, as `pending-findings.test.ts` does it: a path that is a
  // directory cannot be written as a file.
  const state = freshRun({ ...RUN });

  await stopped(
    orchestrate(
      state,
      config(),
      false,
      agents(
        {
          claude: planner([A], () => {
            const file = path.join(state.dir, 'plan-0.json');
            rmSync(file, { force: true });
            mkdirSync(file);
            return planFixture({ plan_md: '# answered' });
          }),
          codex: (label) =>
            label.startsWith('answers-') ? answersReport([{ question: A.question, answer: 'ANS-1' }]) : report([]),
        },
        [],
      ),
    ),
  );

  const disk = stored(state);
  assert.equal(disk.plan?.plan_md, '# answered');
  assert.equal(disk.pendingAnswers, null);
});

test('on resume too, the answers go on the plan write and not on a second write after it', async () => {
  // The re-entry block used to null `pendingAnswers` on its own `saveState`
  // after `revisePlan` returned - so a failure between the plan write and that
  // one left the revised plan on disk beside the answers it had answered, and
  // the next resume bought the revision again. Same provocation as above, on
  // the resume path.
  const state = freshRun({ ...RUN });
  await stopped(
    orchestrate(
      state,
      config(),
      false,
      agents(
        {
          claude: planner([A], () => {
            throw new Error('the process died before the plan was persisted');
          }),
          codex: (label) =>
            label.startsWith('answers-') ? answersReport([{ question: A.question, answer: 'ANS-1' }]) : report([]),
        },
        [],
      ),
    ),
  );

  const resumed = loadRun(state.targetDir, state.id);
  await stopped(
    orchestrate(
      resumed,
      config(),
      true,
      agents(
        {
          claude: () => {
            const file = path.join(resumed.dir, 'plan-0.json');
            rmSync(file, { force: true });
            mkdirSync(file);
            return planFixture({ plan_md: '# answered' });
          },
          codex: noSecondAnswerer,
        },
        [],
      ),
    ),
  );

  const disk = stored(resumed);
  assert.equal(disk.plan?.plan_md, '# answered');
  assert.equal(disk.pendingAnswers, null);
});

test('a fork from the post-answerer checkpoint revises against the answers it carries', async () => {
  // The intended side effect of #169 on #139's checkpoint: the snapshot taken
  // after the answerer's turn now holds what that turn bought, so a fork of it
  // revises against the answers rather than losing them - and does not buy the
  // answerer turn a second time either, because the questions are marked.
  const state = freshRun({ ...RUN, git: true, commit: true });
  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: planner([A]),
        codex: (label) =>
          label.startsWith('answers-') ? answersReport([{ question: A.question, answer: 'ANS-1' }]) : report([]),
      },
      [],
    ),
  );

  const point = listCheckpoints(state.dir).find((c) => c.meta?.boundary === 'question-round');
  assert.ok(point !== undefined, 'no question-round checkpoint was written');
  const snapshot = JSON.parse(readFileSync(point.file, 'utf8')) as RunState;
  assert.deepEqual(answerTexts(snapshot.pendingAnswers), ['ANS-1']);

  // No commit on a planning checkpoint, so the fork cannot branch.
  const plan = await planFork(state.targetDir, state.id, point.n, { git: { useBranch: false } });
  const { state: child } = await commitFork(state.targetDir, plan);
  assert.deepEqual(answerTexts(child.pendingAnswers), ['ANS-1']);

  const prompts = new Map<string, string>();
  const calls: string[] = [];
  await orchestrate(
    child,
    config(),
    true,
    agents({ claude: prompting(prompts, () => planFixture()), codex: noSecondAnswerer }, calls),
  );

  assert.equal(calls[0], 'revise-q1', calls.join(', '));
  assert.equal(calls.some((c) => c.startsWith('answers-')), false, calls.join(', '));
  assert.match(prompts.get('revise-q1') ?? '', /ANS-1/);
  assert.equal(child.pendingAnswers, null);
});
