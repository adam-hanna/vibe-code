import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { recordHumanAnswers, reportDeferred } from '@src/cli.js';
import * as log from '@src/log.js';
import { Escalation, orchestrate } from '@src/orchestrator.js';
import { normalize, recordSuppressed } from '@src/questions.js';
import {
  agents,
  answerNeedsInput,
  answersReport,
  BLOCKING,
  config,
  escalationFile,
  freshRun,
  planFixture,
  questionFixture,
  report,
} from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * The same question in new words, and what a human actually answered (#65).
 *
 * Two defects with one mechanism: the re-ask guard was exact equality over
 * `normalize`, so a rephrasing walked past it; and `ASSUMED.md` was never
 * reconciled with the answers a person gave, so it reported their decisions as
 * the planner's guesses. `question-escalation.test.ts` owns the question path
 * itself - who is asked, and what stops the run; this file owns identity: when
 * two wordings are treated as one question, and what the run has to say about
 * it when it does.
 *
 * The arithmetic on the strings below is `question-identity.test.ts`'s subject.
 */

/**
 * Four real wordings of one question, verbatim from `plan-0.json` through
 * `plan-3.json` of the archived run
 * `20260825-121246-generalize-verification-into-named-gates`, and the other
 * question from that same `plan-0.json`.
 *
 * That run asked one question four times - three wasted answer turns, and the
 * accumulating rounds are what drove it into `loop.maxQuestionRounds`. Inlined
 * rather than read from `.vibe/`, which is neither tracked nor shipped.
 */
const W1 =
  'Should an unavailable *optional* gate still be visible in the run summary, or only in the event log and `gateOutcomes`?';
const W2 =
  'Should an unavailable *optional* gate be visible in the run summary, or only in the log line, the event log and `gateOutcomes`?';
const W4 =
  'Should an unavailable *optional* gate be visible in the `Done` summary, or only in the run log, the event log, `gateOutcomes` and `OUTSTANDING.md`?';
const UNRELATED =
  'When a gate fails and the sequence stops, should the gates that never got their turn be recorded as anything (e.g. `not-run`), or left out of `gateOutcomes` entirely?';

const REPHRASED = 'REPHRASED.md';
const ASSUMED = 'ASSUMED.md';

const runState = (): RunState => freshRun({ prefix: 'vibe-rephrase-', task: 'rephrased questions' });
const at = (state: RunState, name: string): string => path.join(state.dir, name);
const has = (state: RunState, name: string): boolean => existsSync(at(state, name));
const read = (state: RunState, name: string): string => readFileSync(at(state, name), 'utf8');

/** A planner that asks `first`, then `second` on its next turn, then nothing. */
function asking(first: string, second?: string): (label: string) => unknown {
  return (label) => {
    if (label === 'plan') {
      return planFixture({ open_questions: [questionFixture({ question: first })] });
    }
    if (second !== undefined && (label === 'revise-1' || label === 'revise-2')) {
      return planFixture({ open_questions: [questionFixture({ question: second })] });
    }
    return planFixture();
  };
}

/**
 * An answerer that answers whatever it was actually asked.
 *
 * It reads the questions back out of the prompt rather than being told them, so
 * a case cannot pass by answering a question the loop never put.
 */
function answering(over: { defer_to_human?: boolean } = {}) {
  return (label: string, options: unknown): unknown => {
    if (!label.startsWith('answers-')) return report([]);
    const prompt = (options as { prompt: string }).prompt;
    // `formatQuestion`'s shape: "1. **the question** *(product, blocking)*".
    const asked = [...prompt.matchAll(/^\d+\. \*\*(.*?)\*\* \*\(/gm)].map((m) => m[1] ?? '');
    return answersReport(asked.map((question) => ({ question, ...over })));
  };
}

/** The plain resume: no questions left, nothing to critique. */
async function resumeQuietly(state: RunState): Promise<void> {
  await orchestrate(
    state,
    config(),
    true,
    agents({ claude: () => planFixture(), codex: () => report([]) }, []),
  );
}

// ---- the guard --------------------------------------------------------------

test('a rephrased question is not put to the answerer twice, and the suppression is recorded', async () => {
  const state = runState();
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    false,
    agents({ claude: asking(W1, W2), codex: answering() }, calls),
  );

  assert.deepEqual(calls, ['plan', 'answers-0', 'revise-1', 'critique-1']);
  assert.equal(calls.filter((c) => c.startsWith('answers-')).length, 1, 'one answer turn, not two');

  const suppressed = state.suppressedQuestions ?? [];
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0]?.question, W2);
  // The normalized key, because that is all `answeredQuestions` ever held.
  assert.equal(suppressed[0]?.matched, normalize(W1));
  assert.ok((suppressed[0]?.score ?? 0) >= 0.6);

  const record = read(state, REPHRASED);
  assert.match(record, /## Re-asks suppressed/);
  assert.ok(record.includes(W2), 'the new wording is quoted');
  assert.ok(record.includes(normalize(W1)), 'and what it matched');
  assert.match(record, /0\.89/, 'and the score it matched on');
});

test('a suppressed wording is not marked answered, and recurring adds no second record', async () => {
  const state = runState();
  const calls: string[] = [];

  // The first critique asks for a change, so there is a second revision - and
  // the planner asks the same rephrasing again.
  let critiques = 0;
  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: asking(W1, W2),
        codex: (label, options) => {
          if (label.startsWith('answers-')) return answering()(label, options);
          critiques += 1;
          return report(critiques === 1 ? BLOCKING.slice(0, 1) : []);
        },
      },
      calls,
    ),
  );

  assert.equal(calls.filter((c) => c.startsWith('answers-')).length, 1, 'still one answer turn');
  assert.equal((state.suppressedQuestions ?? []).length, 1, 'one decision, however often repeated');
  // The list means "put to the answerer", and W2 never was. A recurrence is
  // caught by the fuzzy scan against W1, not by the exact path.
  assert.deepEqual(state.answeredQuestions, [normalize(W1)]);
});

test('the suppression is on disk even when the run stops rather than finishing', async () => {
  const state = runState();

  // The run that motivated #65 ended at the round cap, not at "Done". A record
  // written by `reportDeferred` would have been missing from exactly the run
  // that needed it, which is why this one is written the moment it happens.
  await assert.rejects(
    () =>
      orchestrate(
        state,
        config(),
        false,
        agents(
          {
            claude: (label) =>
              label === 'plan'
                ? planFixture({ open_questions: [questionFixture({ question: W1 })] })
                : label === 'revise-1'
                  ? planFixture({
                      open_questions: [
                        questionFixture({ question: W2 }),
                        questionFixture({ question: UNRELATED }),
                      ],
                    })
                  : planFixture(),
            codex: (label, options) =>
              answering(label === 'answers-1' ? { defer_to_human: true } : {})(label, options),
          },
          [],
        ),
      ),
    (err: unknown) => err instanceof Escalation,
  );

  assert.equal((state.suppressedQuestions ?? []).length, 1);
  assert.ok(read(state, REPHRASED).includes(W2));
});

test('a verbatim repeat is still suppressed in silence', async () => {
  const state = runState();
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    false,
    agents({ claude: asking(W1, W1), codex: answering() }, calls),
  );

  assert.equal(calls.filter((c) => c.startsWith('answers-')).length, 1);
  assert.equal(state.suppressedQuestions, undefined, 'nothing to report about an exact repeat');
  assert.equal(has(state, REPHRASED), false);
});

test('two genuinely different questions in one plan are both asked', async () => {
  const state = runState();
  let asked = '';

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: (label) =>
          label === 'plan'
            ? planFixture({
                open_questions: [
                  questionFixture({ question: W1 }),
                  questionFixture({ question: UNRELATED }),
                ],
              })
            : planFixture(),
        codex: (label, options) => {
          if (label.startsWith('answers-')) asked = (options as { prompt: string }).prompt;
          return answering()(label, options);
        },
      },
      [],
    ),
  );

  assert.ok(asked.includes(W1), 'the first question reached the answerer');
  assert.ok(asked.includes(UNRELATED), 'and so did the one that only looks like it');
  assert.equal(state.suppressedQuestions, undefined);
});

// ---- what a human answered is not an assumption -----------------------------

/**
 * A run that defers one advisory question and stops on a blocking one, in the
 * same round.
 *
 * Both come out of the same `resolveQuestions` call: `refusedAdvisory` lands in
 * `deferredQuestions`, which is ASSUMED.md's material, and `refusedBlocking` is
 * thrown as the `Escalation` that NEEDS-INPUT.md is written from. That is the
 * path by which a human's answer can reach a deferred question, and every case
 * below drives it through the real `writeEscalation`, the real answer parser
 * and a real resume - nothing forges a NEEDS-INPUT.md or edits state by hand.
 */
async function deferAndStop(
  state: RunState,
  advisory: string,
  blocking: string,
): Promise<Escalation> {
  return await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: (label) =>
          label === 'plan'
            ? planFixture({
                open_questions: [
                  questionFixture({ question: advisory, blocking: false }),
                  questionFixture({ question: blocking, blocking: true }),
                ],
              })
            : planFixture(),
        codex: (label, options) => answering({ defer_to_human: true })(label, options),
      },
      [],
    ),
  ).then(
    () => assert.fail('the blocking question should have stopped the run'),
    (err: unknown) => err as Escalation,
  );
}

/** Resume to completion once the answers are in, then report as `execute` does. */
async function finishAndReport(state: RunState): Promise<void> {
  await resumeQuietly(state);
  reportDeferred(state);
}

test('a deferred question a human answered in other words is not called an assumption', async () => {
  const state = runState();
  const stop = await deferAndStop(state, W1, W4);

  assert.deepEqual(
    state.deferredQuestions.map((q) => q.question),
    [W1],
  );
  const file = escalationFile(state, stop);
  assert.ok(readFileSync(file, 'utf8').includes(W4));

  answerNeedsInput(state, () => 'Only in the run log.');
  await finishAndReport(state);

  assert.equal(has(state, ASSUMED), false, 'the only entry was answered, so there is no file');
  const resolved = state.resolvedByHuman ?? [];
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.question, W1);
  assert.equal(resolved[0]?.answered, W4);
  assert.ok((resolved[0]?.score ?? 0) >= 0.8);

  // Removed on the strength of a similarity score, so it is removed out loud.
  const record = read(state, REPHRASED);
  assert.match(record, /## Deferred questions your answer disposed of/);
  assert.ok(record.includes(W1) && record.includes(W4));
  assert.match(record, /0\.81/);
});

test('an unrelated answer removes nothing, and the count matches the file', async () => {
  const state = runState();
  const stop = await deferAndStop(state, W1, UNRELATED);
  escalationFile(state, stop);
  answerNeedsInput(state, () => 'Leave them out.');

  const transcript = at(state, 'count.log');
  log.attachTranscript(transcript);
  try {
    await finishAndReport(state);
  } finally {
    log.attachTranscript(at(state, 'transcript.log'));
  }

  assert.equal(state.resolvedByHuman, undefined, 'nothing was disposed of');
  const assumed = read(state, ASSUMED);
  const entries = [...assumed.matchAll(/^### \d+\. /gm)].length;
  assert.equal(entries, 1);
  assert.ok(assumed.includes(W1));
  // #65 complained about the number as much as about the file. Both come out of
  // one filter now, so they cannot disagree.
  assert.match(readFileSync(transcript, 'utf8'), new RegExp(`WARN  ${entries} question\\(s\\) ran`));
});

test('an exact match disposes of a deferred question in silence', async () => {
  const state = runState();
  const stop = await deferAndStop(state, W1, W1);
  escalationFile(state, stop);
  answerNeedsInput(state, () => 'The run log.');
  await finishAndReport(state);

  assert.equal(has(state, ASSUMED), false);
  assert.equal(state.resolvedByHuman, undefined, 'an exact match is unambiguous');
  assert.equal(has(state, REPHRASED), false);
});

test('an ASSUMED.md written before the answer existed is repaired, not left standing', async () => {
  const state = runState();
  const stop = await deferAndStop(state, W1, UNRELATED);
  escalationFile(state, stop);
  answerNeedsInput(state, () => 'Leave them out.');
  await finishAndReport(state);
  assert.equal(has(state, ASSUMED), true, 'nobody had answered W1 yet');

  // The second stop is the case the reviewer pointed at: the answer becomes
  // durable inside `cmdResume`, and a run that then exits at the preflight gate
  // or stops for input again never reaches `reportDeferred`.
  // `recordHumanAnswers` is the exported half of that write, and the repair
  // rides on the resume that follows it.
  recordHumanAnswers(state, [
    {
      question: W2,
      answer: 'Only in the run log.',
      confidence: 'high',
      defer_to_human: false,
      rationale: 'Answered by the user.',
    },
  ]);
  await resumeQuietly(state);

  assert.equal(has(state, ASSUMED), false, 'the file no longer claims a guess');
  assert.equal((state.resolvedByHuman ?? []).length, 1);
  assert.ok(read(state, REPHRASED).includes(W2));
});

// ---- the record survives what the run does not ------------------------------

test('a lost REPHRASED.md is rebuilt from state, by a resume and by the next suppression', async () => {
  const state = runState();
  await orchestrate(
    state,
    config(),
    false,
    agents({ claude: asking(W1, W2), codex: answering() }, []),
  );
  const original = read(state, REPHRASED);

  // Killed between the state write and the artifact write: the suppression is
  // in state.json and there is nothing to read. A fork is the same shape - the
  // child inherits the state and none of the parent's artifacts - and it is
  // always started by a resume, which is this call.
  rmSync(at(state, REPHRASED));
  await resumeQuietly(state);
  assert.equal(read(state, REPHRASED), original, 'byte-identical, rebuilt from state');
  assert.equal((state.suppressedQuestions ?? []).length, 1, 'and no second entry for it');

  // The other half: a duplicate suppression republishes rather than returning
  // early on "already recorded".
  rmSync(at(state, REPHRASED));
  const known = state.suppressedQuestions?.[0];
  assert.notEqual(known, undefined);
  recordSuppressed(state, W2, { candidate: normalize(W1), score: known?.score ?? 0 });
  assert.equal(read(state, REPHRASED), original);
  assert.equal((state.suppressedQuestions ?? []).length, 1);
});
