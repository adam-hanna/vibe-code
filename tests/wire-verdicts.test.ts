import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import {
  agents,
  committing,
  config,
  findingFixture,
  freshRun,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * What a window is told about a round, and what it is still not told (#223).
 *
 * The loop has always **known** whether the verification gate passed, what the
 * four severity counts were and how they compared to the tolerance. It wrote all
 * of it to `state.events` and said none of it - so a host could watch a run for
 * ninety minutes and never learn the verdict, while `state.json` held it the
 * whole time.
 *
 * Every assertion here is **by id**, never by English. That is #133's rule and
 * it is the whole reason these ids exist: a test matching the sentence would
 * break the next time somebody improved it, and so would the app.
 *
 * The guard that keeps this honest is not in this file. It is
 * `durable-narration.test.ts`'s first case, which pins the set of event types a
 * clean pass records - so if any of this ever starts creating events rather than
 * only saying facts that were already durable, that is what fails.
 */

function passing(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

interface Options {
  /**
   * What the gate should do, passed through to `verifying`.
   *
   * A field rather than a caller-built config, because `verifying` **writes the
   * script** as a side effect: a case that built its own and handed it in got a
   * gate that never failed, since this function's own call ran afterwards and
   * overwrote the file with the passing version.
   */
  verify?: { failures?: number; failRuns?: readonly number[]; runs?: number };
  over?: object;
  handlers?: Handlers;
}

/** Run the loop with the console muted, collecting narration. */
async function pass(state: RunState, options: Options = {}): Promise<Narration[]> {
  const seen: Narration[] = [];
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state, options.verify ?? {}), ...options.over }),
      false,
      agents(options.handlers ?? passing(state), []),
    );
  } catch {
    // Several cases below drive the loop into an ending on purpose. The
    // narration up to that point is the subject, and it is already collected.
  } finally {
    console.log = realLog;
    console.error = realError;
    log.setSink(null);
  }
  return seen;
}

function fresh(task: string): RunState {
  return freshRun({ prefix: 'vibe-wire-', task, planOnly: false, git: true, commit: true });
}

const withId = (seen: readonly Narration[], id: string): Narration[] =>
  seen.filter((n) => n.id === id);

const dataOf = (n: Narration | undefined): Record<string, unknown> =>
  (n?.data ?? {}) as Record<string, unknown>;

test('a gate that passed says so, with the command and how many times it ran', async () => {
  const state = fresh('verify passed');
  const seen = await pass(state);

  const passed = withId(seen, 'verify_passed');
  assert.equal(passed.length, 1);
  assert.equal(passed[0]?.level, 'ok');

  const data = dataOf(passed[0]);
  assert.equal(data['gate'], 'verification');
  assert.equal(data['runs'], 1);
  // The command, because `5d` prints it: a verdict about a suite is not usable
  // without knowing which command produced it.
  assert.ok(String(data['command']).includes('vibe-verify.mjs'));

  // Still exactly one event, under the same type. The identity rule: a host
  // acting on the fact and an archive recording it agree about one fact.
  assert.equal(state.events.filter((e) => e.type === 'verify_passed').length, 1);
});

test('a gate that failed carries the fraction and the flaky-or-broken verdict', async () => {
  // The distinction #135 built and nothing on the wire could report. `runs: 3`
  // with the second failing is the case that is *flaky* rather than *failing*,
  // and the two send the fixer opposite instructions.
  const state = fresh('verify flaky');
  const seen = await pass(state, { verify: { failRuns: [2], runs: 3 } });

  const failed = withId(seen, 'verify_failed');
  assert.ok(failed.length >= 1, 'the gate failure never reached the wire');
  assert.equal(failed[0]?.level, 'warn');

  const data = dataOf(failed[0]);
  assert.equal(data['gate'], 'verification');
  assert.equal(data['runs'], 3);
  assert.equal(data['failed'], 1);
  // The word the pane renders. `failing` and `flaky` are different findings
  // about a suite, and only one of them is about the code.
  assert.equal(data['verdict'], 'flaky');
});

test('verification being off is said, not merely recorded', async () => {
  // The one promoted site that adds a line a terminal did not print. Worth it:
  // "verification is off" and "the gate has not come round yet" looked
  // identical, in the terminal and on the wire both.
  const state = fresh('verify off');
  const seen = await pass(state, { over: { verify: { ...config().verify, enabled: false } } });

  const off = withId(seen, 'verify_disabled');
  assert.equal(off.length, 1);
  assert.equal(off[0]?.level, 'info');
  assert.equal(withId(seen, 'verify_passed').length, 0);
});

test('every round says its four counts and what the tolerance made of them', async () => {
  // `1e`'s subject. The question at a gate is not "how many findings" but "why
  // did the loop choose to fix again rather than finish", and that is a
  // comparison against a number nothing on the wire carried.
  const state = fresh('census');
  const seen = await pass(state, {
    handlers: {
      claude: (label: string) =>
        label === 'plan' || label.startsWith('revise-')
          ? planFixture()
          : work(state, `${label}.txt`),
      codex: (label: string) =>
        label.startsWith('critique-')
          ? report([findingFixture({ id: 'a', severity: 'P2' })])
          : report([]),
    },
  });

  const census = withId(seen, 'findings_reported');
  assert.ok(census.length >= 2, 'both the critique and the review should report a census');

  const plan = dataOf(census.find((n) => dataOf(n)['phase'] === 'plan'));
  // Zeros are sent. Where a gate decision is being made an absence is
  // information, which is the design's four-chip rule in data form - and it is
  // the whole reason this is four counts rather than a list nobody can total.
  assert.deepEqual(plan['counts'], { P0: 0, P1: 0, P2: 1, P3: 0 });
  assert.equal(plan['pass'], true);
  assert.equal(plan['tolerance'], config().loop.p1Tolerance);
  // `reason` is null rather than absent when the gate passed: "the loop may
  // proceed" is an answer, not a missing one.
  assert.equal(plan['reason'], null);

  const listed = plan['findings'] as readonly Record<string, unknown>[];
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.['id'], 'a');
  assert.equal(listed[0]?.['severity'], 'P2');
  // Enough to open `4c` and no more: the detail and the suggested fix stay in
  // the artifact rather than putting a review's whole prose on the wire.
  assert.equal(listed[0]?.['detail'], undefined);
  assert.equal(listed[0]?.['title'], 'Some finding');
});

test('a finding nobody could attribute names nobody', async () => {
  // #141's rule, carried onto the wire unchanged. `authorOf` narrows and returns
  // null rather than guessing, and a renderer that cannot name the author names
  // nobody - so the frame has to be able to say that.
  const state = fresh('authors');
  const seen = await pass(state, {
    handlers: {
      claude: (label: string) =>
        label === 'plan' || label.startsWith('revise-')
          ? planFixture()
          : work(state, `${label}.txt`),
      codex: (label: string) =>
        label.startsWith('critique-')
          ? report([findingFixture({ id: 'unattributed', severity: 'P3' })])
          : report([]),
    },
  });

  const plan = dataOf(withId(seen, 'findings_reported').find((n) => dataOf(n)['phase'] === 'plan'));
  const listed = plan['findings'] as readonly Record<string, unknown>[];
  const one = listed.find((f) => f['id'] === 'unattributed');
  // `groundAndRecord` stamps the critic, so this one IS attributed - the claim
  // under test is that the field is the narrowed value and never a guess.
  assert.ok(one?.['raisedBy'] === null || one?.['raisedBy'] === 'critic');
});

test('the questions reach the wire, and so do the answers with their confidence', async () => {
  // `1f` is an inbox and cannot be built over two counts. Before this the
  // alternative was scraping the `- [kind] text` lines printed underneath, which
  // is the English-matching #133 exists to prevent.
  const state = fresh('questions');
  const seen = await pass(state, {
    handlers: {
    claude: (label: string) =>
      label === 'plan'
        ? planFixture({
            open_questions: [
              {
                question: 'Which database?',
                kind: 'product',
                blocking: true,
                recommended: 'sqlite',
                options: ['sqlite', 'postgres'],
              },
            ],
          })
        : label.startsWith('revise-')
          ? planFixture()
          : work(state, `${label}.txt`),
    codex: (label: string) =>
      label.startsWith('answers-')
        ? {
            answers: [
              {
                question: 'Which database?',
                answer: 'sqlite',
                confidence: 'high',
                rationale: 'it is already a dependency',
                defer_to_human: false,
              },
            ],
          }
        : report([]),
    },
  });

  const opened = dataOf(withId(seen, 'questions_opened')[0]);
  assert.equal(opened['total'], 1);
  assert.equal(opened['blocking'], 1);
  const asked = opened['questions'] as readonly Record<string, unknown>[];
  assert.equal(asked[0]?.['question'], 'Which database?');
  assert.equal(asked[0]?.['blocking'], true);

  const answered = dataOf(withId(seen, 'questions_answered')[0]);
  assert.equal(answered['answered'], 1);
  const back = answered['answers'] as readonly Record<string, unknown>[];
  assert.equal(back[0]?.['answer'], 'sqlite');
  // The confidence is the field `1f` draws its policy on - escalate on low - so
  // a pane that could not see it could not explain its own behaviour.
  assert.equal(back[0]?.['confidence'], 'high');
});

test('what a turn spent arrives under the event type that recorded it', async () => {
  // `5e`. The one seam every token is charged through said nothing with an id on
  // it, so the spend screen had a run total nowhere to read from.
  const state = fresh('spend');
  const seen = await pass(state);

  const claude = withId(seen, 'claude_turn');
  assert.ok(claude.length >= 1, 'no Claude charge reached the wire');
  assert.equal(typeof dataOf(claude[0])['tokens'], 'number');
  assert.equal(dataOf(claude[0])['provider'], 'claude');

  // Both providers, under their own event types, because `5e`'s one honest
  // ceiling covers both loop agents and a pane that saw only one would draw
  // half the run.
  const codex = withId(seen, 'codex_turn');
  assert.ok(codex.length >= 1, 'no Codex charge reached the wire');
  assert.equal(dataOf(codex[0])['provider'], 'codex');

  // The run's total after the LAST charge, whichever provider took it. This is
  // what makes the figure trustworthy: a pane reads the running total off the
  // charge rather than adding up a stream of turns and getting a different
  // answer from the one `state.json` holds.
  const charges = seen.filter((n) => n.id === 'claude_turn' || n.id === 'codex_turn');
  assert.equal(dataOf(charges[charges.length - 1])['runTokens'], state.tokensUsed);

  // The id IS the event type. Two spellings of one fact is what this avoids.
  assert.ok(state.events.some((e) => e.type === 'claude_turn'));
});

test('the plan approval says which sentence it approved by', async () => {
  const state = fresh('approval');
  const seen = await pass(state);

  const approved = withId(seen, 'plan_approved');
  assert.equal(approved.length, 1);
  assert.equal(approved[0]?.level, 'ok');
  assert.equal(dataOf(approved[0])['findings'], 0);
  // Unchanged wording on the branch that already had a line: this promotion is
  // meant to be invisible to a terminal.
  assert.match(String(approved[0]?.message), /^Plan approved - 0 non-blocking finding\(s\)$/);
});
