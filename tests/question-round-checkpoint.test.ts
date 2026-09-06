import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orchestrate } from '@src/orchestrator.js';
import { listCheckpoints } from '@src/run.js';
import { readCheckpointShape } from '@src/stored.js';
import {
  agents,
  answersReport,
  BLOCKING,
  config,
  freshRun,
  planFixture,
  questionFixture,
  report,
} from './helpers/loop-harness.js';
import type { RunCheckpointMeta, RunState } from '@src/types.js';

/**
 * The question round as a checkpoint boundary (#139).
 *
 * Two claims, and they fail in different ways so they are tested separately.
 *
 * **The hole.** `resolveQuestions` may come back with nothing - the answerer
 * declined every one - and that branch used to reach `continue` having written
 * no snapshot at all. It was the only round in the loop that left none, so a
 * fork of that run had to go back to the plan round before it and buy the
 * answerer turn a second time.
 *
 * **The blur.** When answers did come back, the checkpoint written was
 * `plan-round`, because `revisePlan` is shared with the critique-driven caller
 * and that one really is a plan round. So a plan revised because the critic
 * objected and a plan revised because it answered its own questions were
 * recorded under one name - and they are different diagnoses about a run.
 *
 * These stop after the plan phase, as the other question cases do: the questions
 * are asked and settled inside `planPhase`.
 */

/** The plan turn asks once, and every revision after it asks nothing. */
function planner(question = questionFixture()): (label: string) => unknown {
  return (label) => (label === 'plan' ? planFixture({ open_questions: [question] }) : planFixture());
}

function boundaries(state: RunState): string[] {
  return listCheckpoints(state.dir).map((c) => c.meta?.boundary ?? '(unreadable)');
}

function metas(state: RunState): RunCheckpointMeta[] {
  return listCheckpoints(state.dir)
    .map((c) => c.meta)
    .filter((m): m is RunCheckpointMeta => m !== null);
}

test('a question round the answerer answered leaves its own fork point, before the revision', async () => {
  const state = freshRun({ prefix: 'vibe-qcp-answered-', task: 'question checkpoint' });
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

  // The order is the claim. `question-round` is written where the answerer's
  // turn is recorded, and `plan-round` where the revision it caused is - two
  // snapshots for two pieces of work, rather than one standing for both.
  // `complete` rather than `plan-approved` closes the list because these runs
  // are plan-only: `runPhases` advances straight to complete, which is the
  // ordinary shape of `vibe plan` and not a detail of this change.
  const seen = boundaries(state);
  assert.deepEqual(seen, ['question-round', 'plan-round', 'complete'], seen.join(', '));
});

test('a question round the answerer declined leaves one too, which is the hole', async () => {
  // The branch that wrote nothing. An advisory question the answerer defers is
  // recorded and the run carries on with the planner's default - no revision, no
  // escalation, and until now no snapshot of the turn that was paid for.
  const state = freshRun({ prefix: 'vibe-qcp-declined-', task: 'question checkpoint' });
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: planner(questionFixture({ blocking: false })),
        codex: (label) =>
          label === 'answers-0' ? answersReport([{ defer_to_human: true }]) : report([]),
      },
      calls,
    ),
  );

  // No `revise-1`: nothing usable came back, so the plan in hand is still the
  // one the plan turn wrote.
  assert.deepEqual(calls, ['plan', 'answers-0', 'critique-0']);
  assert.equal(state.questionRound, 1);
  assert.equal(state.deferredQuestions.length, 1);

  const seen = boundaries(state);
  assert.deepEqual(seen, ['question-round', 'complete'], seen.join(', '));
});

test('the snapshot holds what the round bought, so a fork of it does not ask again', async () => {
  // What makes the checkpoint worth having rather than merely present. Every
  // question put to the answerer is marked answered before this point, so a run
  // seeded from this snapshot skips the question instead of buying the turn
  // twice - which is the whole cost the missing boundary was leaving on the table.
  const state = freshRun({ prefix: 'vibe-qcp-holds-', task: 'question checkpoint' });

  await orchestrate(
    state,
    config(),
    false,
    agents({
      claude: planner(),
      codex: (label) => (label === 'answers-0' ? answersReport([{}]) : report([])),
    }, []),
  );

  const entry = listCheckpoints(state.dir).find((c) => c.meta?.boundary === 'question-round');
  assert.ok(entry !== undefined, 'no question-round checkpoint was written');
  const snapshot: unknown = JSON.parse(readFileSync(entry.file, 'utf8'));
  const held = snapshot as { answeredQuestions?: unknown; questionRound?: unknown };
  assert.equal(held.questionRound, 1);
  assert.equal(Array.isArray(held.answeredQuestions) && held.answeredQuestions.length > 0, true);
});

test('a revision the critic asked for is still a plan round, and says nothing about questions', async () => {
  // The other half of the blur, and the one that would break if `revisePlan`
  // had been changed instead of its caller. Nothing here asks anything, so
  // `question-round` must not appear at all.
  const state = freshRun({ prefix: 'vibe-qcp-critique-', task: 'question checkpoint' });
  // Two, not one: `p1Tolerance` defaults to 1, so a single blocking finding is
  // tolerated and the plan is approved without a revision at all.
  const rounds = [BLOCKING, []];
  let round = 0;
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: () => planFixture(),
        codex: () => report(rounds[round++] ?? []),
      },
      calls,
    ),
  );

  assert.deepEqual(calls, ['plan', 'critique-0', 'revise-1', 'critique-1']);
  const seen = boundaries(state);
  assert.equal(seen.includes('question-round'), false, seen.join(', '));
  assert.deepEqual(seen, ['plan-round', 'complete'], seen.join(', '));
});

test('every checkpoint carries the question counter, so q1 p1 is not p2', async () => {
  // The fingerprint. Both runs below end with `planRound` at 1 and both took two
  // planner turns; what tells them apart is the counter, and it is on the meta
  // rather than only inside the snapshot body because the meta is what a fork
  // listing and `ForkOrigin` actually read.
  const asked = freshRun({ prefix: 'vibe-qcp-fp-asked-', task: 'question checkpoint' });
  await orchestrate(
    asked,
    config(),
    false,
    agents({
      claude: planner(),
      codex: (label) => (label === 'answers-0' ? answersReport([{}]) : report([])),
    }, []),
  );

  const critiqued = freshRun({ prefix: 'vibe-qcp-fp-crit-', task: 'question checkpoint' });
  const rounds = [BLOCKING, []];
  let round = 0;
  await orchestrate(
    critiqued,
    config(),
    false,
    agents({
      claude: () => planFixture(),
      codex: () => report(rounds[round++] ?? []),
    }, []),
  );

  const last = (state: RunState): RunCheckpointMeta => {
    const all = metas(state);
    const end = all[all.length - 1];
    assert.ok(end !== undefined, 'the run wrote no readable checkpoint');
    return end;
  };

  assert.equal(last(asked).planRound, last(critiqued).planRound);
  assert.equal(last(asked).questionRound, 1);
  assert.equal(last(critiqued).questionRound, 0);
});

test('a checkpoint written before this existed is still readable, and says so by omission', () => {
  // Every snapshot in the archive today is missing the field. Requiring it would
  // have `vibe fork` report a directory of healthy checkpoints as damaged, so
  // absent is legal - and it is absent rather than zero, because "this file
  // never carried the counter" is not "the run asked itself nothing".
  const written = {
    n: 1,
    at: new Date().toISOString(),
    boundary: 'plan-round',
    phase: 'planning',
    planRound: 2,
    reviewRound: 0,
    verifyRound: 0,
    commit: null,
    commitNote: 'no-commit-in-round',
  };

  const old = readCheckpointShape(written);
  assert.ok(old !== null, 'a pre-#139 checkpoint must still read');
  assert.equal('questionRound' in old, false, 'absent must stay absent, not become zero');

  // Present and usable survives; present and unusable refuses the whole meta,
  // exactly as the three counters beside it do. `planFork` refuses to fork
  // anything that needed a repair, so refusing is the safe direction.
  assert.equal(readCheckpointShape({ ...written, questionRound: 3 })?.questionRound, 3);
  assert.equal(readCheckpointShape({ ...written, questionRound: -1 }), null);
  assert.equal(readCheckpointShape({ ...written, questionRound: 1.5 }), null);
  assert.equal(readCheckpointShape({ ...written, questionRound: '3' }), null);

  // And the boundary itself is now in the stored vocabulary, so a snapshot taken
  // at one is readable rather than dropped as a value this version does not know.
  assert.equal(
    readCheckpointShape({ ...written, boundary: 'question-round' })?.boundary,
    'question-round',
  );
});
