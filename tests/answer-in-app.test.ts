import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANSWER_MARKER, fillAnswers, unanswered } from '@src/answers.js';
import { parseHumanAnswers } from '@src/cli.js';
import { LOCK_FILE } from '@src/lock.js';
import { answerQuestions } from '@src/run.js';
import { createSession } from '@src/serve.js';
import { StoredStateError } from '@src/stored.js';
import { freshRun } from './helpers/loop-harness.js';
import type { Outbound } from '@src/protocol.js';

/**
 * Answering a halted run from somewhere that is not a text editor (#223).
 *
 * **The window showed every question and could not answer one.** The halt banner
 * carried the CLI's own instruction - *"Answer the questions in NEEDS-INPUT.md,
 * then resume the run"* - which is correct in a terminal and absurd in a GUI
 * already displaying them: *"thats crazy, I should answer directly in the app on
 * the questions page."*
 *
 * The design is what it declines to do. A frame carrying answers into `state`
 * would be a **second definition of what an answer is**, one that skips
 * `parseHumanAnswers`, skips the `answered-<n>.md` retirement and skips the
 * raise and severity-move blocks in the same file - and `resumeRun` would then
 * have two roads in, drifting on the next change to either. So this fills in the
 * blockquote the template already leaves empty, and the resume that follows is
 * the ordinary one.
 *
 * **The round trip is the test that matters.** Both halves of the format are in
 * this repo - `writeEscalation` renders it, `parseHumanAnswers` reads it - so
 * checking the writer against a format written down in a comment would check
 * nothing. Every case below drives `fillAnswers` output through the real parser.
 */

/** What `writeEscalation` renders, with the same blank blockquote. */
function template(...questions: readonly string[]): string {
  const lines = ['# Needs input', '', '## Questions', ''];
  questions.forEach((q, i) => {
    lines.push(`### ${String(i + 1)}. ${q}`);
    lines.push('*Kind:* product');
    lines.push('*Claude would default to:* something');
    lines.push(`\n${ANSWER_MARKER}\n\n> \n`);
  });
  return lines.join('\n');
}

// ---- the round trip ---------------------------------------------------------

test('an answer written here is an answer the loop reads', () => {
  const md = template('Which database?', 'Which framework?');

  const { md: filled, filled: count } = fillAnswers(md, [
    { question: 'Which database?', answer: 'Postgres' },
    { question: 'Which framework?', answer: 'React' },
  ]);

  assert.equal(count, 2);
  const read = parseHumanAnswers(filled);
  assert.deepEqual(
    read.map((a) => [a.question, a.answer]),
    [
      ['Which database?', 'Postgres'],
      ['Which framework?', 'React'],
    ],
  );
  // And it is recorded as a person's answer, which is what stops it being
  // treated as the adversary's draft.
  assert.equal(read[0]?.confidence, 'high');
  assert.equal(read[0]?.defer_to_human, false);
});

test('a multi-line answer survives, every line quoted', () => {
  // `parseHumanAnswers` keeps only lines starting with `>`, so a paragraph break
  // would silently drop everything after it - which is the worst way for this to
  // fail, because the answer looks accepted and arrives truncated.
  const md = template('How should it deploy?');
  const answer = 'Two processes.\n\nVite on 5173, API on 3001.';

  const read = parseHumanAnswers(fillAnswers(md, [{ question: 'How should it deploy?', answer }]).md);

  assert.equal(read.length, 1);
  assert.match(read[0]?.answer ?? '', /Two processes/);
  assert.match(read[0]?.answer ?? '', /Vite on 5173/);
});

test('answering some leaves the rest blank rather than filling them in', () => {
  const md = template('Which database?', 'Which framework?');

  const result = fillAnswers(md, [{ question: 'Which database?', answer: 'Postgres' }]);

  assert.equal(result.filled, 1);
  assert.deepEqual(parseHumanAnswers(result.md).map((a) => a.question), ['Which database?']);
  // And the window can say so before spending a preflight to find out.
  assert.deepEqual(unanswered(result.md), ['Which framework?']);
});

test('re-answering replaces the text rather than appending to it', () => {
  const once = fillAnswers(template('Which database?'), [
    { question: 'Which database?', answer: 'MySQL' },
  ]);
  const twice = fillAnswers(once.md, [{ question: 'Which database?', answer: 'Postgres' }]);

  const read = parseHumanAnswers(twice.md);
  assert.equal(read.length, 1);
  assert.equal(read[0]?.answer, 'Postgres');
});

test('a question the file does not ask is reported, never added', () => {
  // The file is the record of what was ASKED. Appending a heading for something
  // nobody raised would put a question in the planner's mouth.
  const md = template('Which database?');

  const result = fillAnswers(md, [{ question: 'Which colour?', answer: 'blue' }]);

  assert.equal(result.filled, 0);
  assert.deepEqual(result.unmatched, ['Which colour?']);
  assert.equal(result.md.includes('Which colour?'), false);
  assert.deepEqual(parseHumanAnswers(result.md), []);
});

test('an empty answer is not an answer, and leaves the question open', () => {
  const result = fillAnswers(template('Which database?'), [
    { question: 'Which database?', answer: '   ' },
  ]);

  assert.equal(result.filled, 0);
  assert.deepEqual(unanswered(result.md), ['Which database?']);
});

test('the findings section is left alone', () => {
  // `NEEDS-INPUT.md` holds more than questions: outstanding findings, and the
  // raise blocks a person may have written. A fill that walked into those would
  // corrupt the file the same resume is about to parse for them.
  const md = `${template('Which database?')}\n## Outstanding P1 findings\n\n### a finding \`f1\`\ndetail here\n`;

  const result = fillAnswers(md, [{ question: 'Which database?', answer: 'Postgres' }]);

  assert.match(result.md, /## Outstanding P1 findings/);
  assert.match(result.md, /### a finding/);
  assert.match(result.md, /detail here/);
});

// ---- on a real run ----------------------------------------------------------

function halted(questions: readonly string[]): { repo: string; id: string; dir: string } {
  const state = freshRun({ prefix: 'vibe-answer-', task: 'answer in app' });
  writeFileSync(path.join(state.dir, 'NEEDS-INPUT.md'), template(...questions), 'utf8');
  return { repo: state.targetDir, id: state.id, dir: state.dir };
}

test('the answers land in the run’s own file', () => {
  const { repo, id, dir } = halted(['Which database?']);

  const placed = answerQuestions(repo, id, [{ question: 'Which database?', answer: 'Postgres' }]);

  assert.equal(placed.filled, 1);
  assert.deepEqual(placed.open, []);
  const onDisk = readFileSync(path.join(dir, 'NEEDS-INPUT.md'), 'utf8');
  assert.equal(parseHumanAnswers(onDisk)[0]?.answer, 'Postgres');
});

test('a run that is not stopped on a question is refused', () => {
  // Writing the file would invent a halt, and the resume would then consume a
  // document the loop never produced.
  const state = freshRun({ prefix: 'vibe-answer-none-', task: 'no questions' });

  assert.throws(
    () => answerQuestions(state.targetDir, state.id, [{ question: 'q', answer: 'a' }]),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError);
      assert.match(err.message, /has no NEEDS-INPUT\.md/);
      assert.match(err.message, /Nothing was written/);
      return true;
    },
  );
  assert.equal(existsSync(path.join(state.dir, 'NEEDS-INPUT.md')), false);
});

test('a run whose lock names a live process is refused', () => {
  // Answering a file a running loop is about to read is a second writer on one
  // run, which is the state `src/lock.ts` exists to prevent.
  const { repo, id, dir } = halted(['Which database?']);
  writeFileSync(
    path.join(dir, LOCK_FILE),
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      id,
      token: 'answer-test',
    }),
    'utf8',
  );

  assert.throws(
    () => answerQuestions(repo, id, [{ question: 'Which database?', answer: 'Postgres' }]),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError);
      assert.match(err.message, /is running/);
      return true;
    },
  );
  assert.deepEqual(parseHumanAnswers(readFileSync(path.join(dir, 'NEEDS-INPUT.md'), 'utf8')), []);
});

test('a run id that would escape the runs root is refused', () => {
  const { repo } = halted(['q']);
  for (const bad of ['../..', 'a/b']) {
    assert.throws(() => answerQuestions(repo, bad, []), StoredStateError, `${bad} was joined`);
  }
});

// ---- over the wire ----------------------------------------------------------

test('the frame answers with what it placed, and does NOT resume', () => {
  // Two acts, taken in order by the caller. A write that also spent tokens would
  // be one nobody could take back, and would put spending behind a Save button.
  const { repo, id } = halted(['Which database?', 'Which framework?']);
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(
    JSON.stringify({
      type: 'answer_questions',
      id: 1,
      dir: repo,
      runId: id,
      answers: [{ question: 'Which database?', answer: 'Postgres' }],
    }),
  );

  const frame = sent[0];
  assert.equal(frame?.type, 'questions_answered');
  assert.equal(frame.type === 'questions_answered' ? frame.filled : null, 1);
  assert.deepEqual(
    frame.type === 'questions_answered' ? frame.open : null,
    ['Which framework?'],
  );
  assert.equal(
    sent.some((f) => f.type === 'result'),
    false,
    'answering resumed the run',
  );
});

test('a malformed answer row is dropped, and the rest are placed', () => {
  // Losing nine good answers to one bad row is the worse failure. A request that
  // survives with none is answered `filled: 0`, which is a true statement.
  const { repo, id } = halted(['Which database?']);
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(
    JSON.stringify({
      type: 'answer_questions',
      id: 1,
      dir: repo,
      runId: id,
      answers: [null, { question: 7 }, { question: 'Which database?', answer: 'Postgres' }],
    }),
  );

  assert.equal(sent[0]?.type, 'questions_answered');
  assert.equal(sent[0]?.type === 'questions_answered' ? sent[0].filled : null, 1);
});

test('a frame with no dir is refused rather than resolved to the host cwd', () => {
  // The stronger version of the reads' reason: this one WRITES, so an empty dir
  // would fill in a different repository's NEEDS-INPUT.md and report success.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(JSON.stringify({ type: 'answer_questions', id: 1, dir: '', runId: 'x', answers: [] }));
  session.receive(JSON.stringify({ type: 'answer_questions', id: 2, dir: '/r', answers: [] }));
  session.receive(JSON.stringify({ type: 'answer_questions', id: 3, dir: '/r', runId: 'x' }));

  assert.equal(sent[0]?.type, 'error');
  assert.match(sent[0]?.type === 'error' ? sent[0].message : '', /no dir/);
  assert.match(sent[1]?.type === 'error' ? sent[1].message : '', /no runId/);
  assert.match(sent[2]?.type === 'error' ? sent[2].message : '', /no answers/);
});
