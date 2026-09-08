import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as log from '@src/log.js';
import { pairAnswers } from '@src/questions.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import { answerPrompt } from '@src/prompts.js';
import {
  agents,
  answersReport,
  config,
  freshRun,
  planFixture,
  questionFixture,
  report,
} from './helpers/loop-harness.js';
import type { Narration } from '@src/log.js';

/**
 * Run the loop with the console muted, collecting the narration.
 *
 * Local rather than in the harness, following `durable-narration.test.ts`: the
 * sink is a global and a helper that installs one is a helper that has to
 * restore it on every path, which is easier to get right in the file that needs
 * it than in a shared one that has to guess how it will be nested.
 */
async function muted<T>(body: () => Promise<T>, seen?: Narration[]): Promise<T> {
  const realLog = console.log;
  const realError = console.error;
  if (seen !== undefined) log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await body();
  } finally {
    console.log = realLog;
    console.error = realError;
    if (seen !== undefined) log.setSink(null);
  }
}

/**
 * Which question an answer answers (#211).
 *
 * The join used to be string equality on the question text, and it did not
 * hold. The answerer is told to *"echo the question"* and echoes the line it was
 * shown - which `formatQuestion` rendered as the text followed by the kind and
 * the blocking tag. From a real run's `answers-0.json`:
 *
 *     "If the sandbox cannot bind localhost ports, should the run stop or ship
 *      with the QA criteria reported as untested? *(technical, advisory)*"
 *
 * against a planner question ending at the question mark. Every pair failed.
 *
 * **Two things broke, and only one of them was visible.** The Questions pane
 * drew *"No answer yet"* over two answered questions, which is what got
 * reported. Underneath, `refusedBlocking` was computed from the same equality -
 * so a declined blocking question would have paired with nothing, been counted
 * as answered, and `escalateOnDefer` would not have fired. That is a documented
 * stop-the-run mechanism failing silently, and it is what this file mostly
 * guards.
 */

/** The exact suffix a real run produced, so the case is the observed one. */
const TAG = ' *(product, blocking)*';

test('an answer that echoes the rendered question still pairs with it', () => {
  const q = questionFixture();
  const pairing = pairAnswers(
    [q],
    [{ question: q.question + TAG }],
    (x) => x.question,
    (a) => a.question,
  );
  assert.equal(pairing.paired.length, 1);
  assert.equal(pairing.paired[0]?.question, q);
  assert.deepEqual(pairing.unpaired, []);
});

test('an exact echo pairs, which is what most answers do and must not change', () => {
  const q = questionFixture();
  const pairing = pairAnswers(
    [q],
    [{ question: q.question }],
    (x) => x.question,
    (a) => a.question,
  );
  assert.equal(pairing.paired[0]?.score, 1);
});

test('an answer about nothing that was asked is reported, never attached', () => {
  // The fail-closed half. `refusedBlocking` acts on this pairing, so putting a
  // decline on the nearest question going would stop a run for a question
  // nobody declined - which is worse than the bug being fixed.
  const q = questionFixture();
  const pairing = pairAnswers(
    [q],
    [{ question: 'Should the deploy target be staging or production?' }],
    (x) => x.question,
    (a) => a.question,
  );
  assert.deepEqual(pairing.paired, []);
  assert.equal(pairing.unpaired.length, 1);
});

test('each question takes one answer and each answer one question', () => {
  // Two near-identical questions and two answers. Whatever the pairing decides,
  // it must not use one answer twice or leave a question sharing another's.
  const a = questionFixture({ question: 'Should the widget be lazy or eager?' });
  const b = questionFixture({ question: 'Should the gadget be lazy or eager?' });
  const pairing = pairAnswers(
    [a, b],
    [{ question: 'Should the gadget be lazy or eager?' }, { question: 'Should the widget be lazy or eager?' }],
    (x) => x.question,
    (x) => x.question,
  );
  assert.equal(pairing.paired.length, 2);
  assert.equal(new Set(pairing.paired.map((p) => p.question)).size, 2);
  assert.equal(new Set(pairing.paired.map((p) => p.answer)).size, 2);
  // And each went to the right one, which exact matching gets right on its own.
  for (const p of pairing.paired) assert.equal(p.question.question, p.answer.question);
});

test('the answerer is shown the question on a line of its own', () => {
  // The other half of the fix, at the source. A tag glued to the question is a
  // format that invites the echo that broke the join, and `pairAnswers` being
  // able to recover from it is not a reason to keep inviting it.
  const q = questionFixture();
  const prompt = answerPrompt([q], 'the plan');
  assert.match(prompt, new RegExp(`1\\. ${q.question.replace(/[?]/g, '\\?')}\\r?\\n`));
  assert.match(prompt, /\(product, blocking\)/);
  // And it says which part to copy, because that string is the join key.
  assert.match(prompt, /Copy the question verbatim/);
});

test('a declined blocking question escalates even when the echo carried the tag', async () => {
  // The case the broken equality would have let through, end to end: the
  // answerer declines a blocking question and echoes the rendered form. Before
  // the pairing this returned normally, the run carried on, and the plan was
  // revised on an answer nobody gave.
  const q = questionFixture({ blocking: true });
  const state = freshRun({ prefix: 'vibe-pairing-', task: 'question pairing' });

  const err = await muted(() =>
    orchestrate(
      state,
      config({}),
      false,
      agents(
        {
          claude: (label) => (label === 'plan' ? planFixture({ open_questions: [q] }) : planFixture()),
          codex: (label) =>
            label === 'answers-0'
              ? answersReport([
                  { question: q.question + TAG, defer_to_human: true, rationale: 'product intent' },
                ])
              : report([]),
        },
        [],
      ),
    ).then(
      () => null,
      (e: unknown) => e,
    ),
  );

  assert.ok(err instanceof Escalation, `the run did not stop: ${String(err)}`);
  assert.equal(err.code, EXIT.NEEDS_HUMAN);
  assert.match(err.message, /blocking question/);
  // And the question handed back is the planner's, so NEEDS-INPUT.md asks what
  // was actually asked rather than the rendered line.
  assert.deepEqual((err.questions ?? []).map((x) => x.question), [q.question]);
});

test('the wire carries the question as the planner wrote it, not as it was echoed', async () => {
  // What the window joins on. `questions_opened` carries the planner's wording
  // and `questions_answered` used to carry the answerer's, so the only string
  // appearing on both frames was two different strings - which is why the pane
  // drew "No answer yet" over answered questions.
  const q = questionFixture({ blocking: false });
  // Plan-only, so the case stops once the question round has been narrated -
  // it is about the frame, not about what the loop does afterwards.
  const state = freshRun({ prefix: 'vibe-pairing-wire-', task: 'question pairing', planOnly: true });
  const said: Narration[] = [];

  await muted(
    () =>
      orchestrate(
        state,
        config({}),
        false,
        agents(
          {
            claude: (label) =>
              label === 'plan' ? planFixture({ open_questions: [q] }) : planFixture(),
            codex: (label) =>
              label === 'answers-0'
                ? answersReport([{ question: q.question + TAG, answer: 'Lazy.' }])
                : report([]),
          },
          [],
        ),
      ),
    said,
  );

  const answered = said.find((l) => l.id === 'questions_answered');
  assert.ok(answered, 'no questions_answered was narrated');
  const rows = (answered.data ?? {})['answers'] as { question: string }[];
  assert.deepEqual(
    rows.map((r) => r.question),
    [q.question],
    'the wire carried the echo rather than the question that was asked',
  );
});
