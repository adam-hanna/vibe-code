import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import { countModelAnswers } from '@src/riskfacts.js';
import { loadRun, saveState } from '@src/run.js';
import { renderScorecard, scoreArchive } from '@src/scorecard.js';
import { readRiskFactsRecord, validateStoredState } from '@src/stored.js';
import type { GatesConfig, RiskFacts, RunState } from '@src/types.js';
import { agents, answersReport, config, freshRun, p1, planFixture, questionFixture, report } from './helpers/loop-harness.js';

/**
 * The run's risk facts at plan approval (#492).
 *
 * From the CLI a `step` gate never holds, so a run on the default gates passes
 * `plan-approved` with nobody seeing what it decided on its own. These cases pin
 * that the counts land in the state and the `plan-approved` checkpoint, that a
 * count the record cannot establish is absent rather than zero, and that
 * `vibe stats` shows an absent fact as not recorded.
 */

/** Every row auto, `plan-approved` stopped: the run ends at the boundary under test. */
function stopAtApproval(): GatesConfig {
  return {
    'plan-round': 'auto',
    'question-round': 'auto',
    'plan-approved': 'stop',
    implemented: 'auto',
    'verify-round': 'auto',
    'review-round': 'auto',
  };
}

function startRun(): RunState {
  return freshRun({ prefix: 'vibe-risk-', task: 'risk facts', planOnly: false, git: true, commit: true });
}

async function drive(state: RunState, handlers: Parameters<typeof agents>[0]): Promise<RunState> {
  try {
    await orchestrate(state, config({}, { gates: stopAtApproval() }), false, agents(handlers, []));
    assert.fail('the run should have stopped at plan-approved');
  } catch (err) {
    assert.ok(err instanceof Escalation && err.code === EXIT.NEEDS_HUMAN, String(err));
  }
  return loadRun(state.targetDir, state.id);
}

/** The `riskFacts` the `plan-approved` checkpoint froze. */
function checkpointFacts(state: RunState): unknown {
  for (const name of readdirSync(state.dir)) {
    if (!/^checkpoint-\d+\.json$/.test(name)) continue;
    const parsed = JSON.parse(readFileSync(path.join(state.dir, name), 'utf8')) as Record<string, unknown>;
    const meta = parsed['checkpoint'] as Record<string, unknown> | undefined;
    if (meta?.['boundary'] === 'plan-approved') return parsed['riskFacts'];
  }
  assert.fail('no plan-approved checkpoint was written');
}

const DEFERRED = 'Should the log line name the base ref?';
const ANSWERED = 'Should the counter be per run or per round?';

test('a run that assumed, deferred, took a model answer and carried a P1 records each count at approval', async () => {
  const state = startRun();
  const plan = planFixture({
    plan_md: '# the plan\n\nEdit `src/alpha.ts` and `src/beta.ts`, then `src/alpha.ts` again.',
    assumptions: [{ assumption: 'The cache is warm.', why: 'It was last run.', blast_radius: 'Slower.' }],
    open_questions: [
      questionFixture({ question: DEFERRED, blocking: false }),
      questionFixture({ question: ANSWERED, blocking: false }),
    ],
  });
  const loaded = await drive(state, {
    claude: () => plan,
    codex: (label) => {
      if (label.startsWith('answers-')) {
        return answersReport([
          { question: DEFERRED, defer_to_human: true, rationale: 'Product call.' },
          { question: ANSWERED, answer: 'Per run.' },
        ]);
      }
      // Two P1s send the plan back once; one P1 is inside the default
      // tolerance of one, so it is carried.
      if (label === 'critique-0') return report([p1('first'), p1('second')]);
      return report([p1('carried-one')]);
    },
  });

  const expected: RiskFacts = {
    carriedP1s: 1,
    assumptions: 1,
    deferredQuestions: 1,
    modelAnswers: 1,
    planStalls: 0,
    planRounds: 1,
    namedFiles: 2,
  };
  assert.deepEqual(loaded.riskFacts, expected);
  assert.deepEqual(checkpointFacts(state), expected, 'the plan-approved checkpoint carries the same counts');
});

test('a run with none of them records zeros, because every source was read', async () => {
  const state = startRun();
  const loaded = await drive(state, { claude: () => planFixture(), codex: () => report([]) });
  assert.deepEqual(loaded.riskFacts, {
    carriedP1s: 0,
    assumptions: 0,
    deferredQuestions: 0,
    modelAnswers: 0,
    planStalls: 0,
    planRounds: 0,
    namedFiles: 0,
  });
});

test('a question round whose answers file is missing leaves the model-answer count absent, not zero', () => {
  const state = freshRun({ prefix: 'vibe-risk-', task: 'risk facts' });
  state.questionRound = 2;
  writeFileSync(path.join(state.dir, 'answers-1.json'), JSON.stringify([]));
  assert.equal(countModelAnswers(state, config()), undefined, 'round 2 has no file');
  writeFileSync(path.join(state.dir, 'answers-2.json'), '{ not json');
  assert.equal(countModelAnswers(state, config()), undefined, 'round 2 is unreadable');
  writeFileSync(
    path.join(state.dir, 'answers-2.json'),
    JSON.stringify([{ question: 'q', answer: 'a', confidence: 'low', defer_to_human: false, rationale: 'r' }]),
  );
  assert.equal(countModelAnswers(state, config()), 0, 'a low-confidence answer the defaults decline is not counted');
  rmSync(path.join(state.dir, 'answers-1.json'));
  assert.equal(countModelAnswers(state, config()), undefined);
});

test('a state from before #492 loads with no record, and stats shows the facts as not recorded', () => {
  const old = freshRun({ prefix: 'vibe-risk-', task: 'old run' });
  assert.equal(loadRun(old.targetDir, old.id).riskFacts, undefined);

  const card = scoreArchive(old.targetDir);
  assert.equal(card.riskFacts.recorded, 0);
  assert.equal(card.riskFacts.byFact.carriedP1s.measured, 0);
  assert.equal(card.riskFacts.byFact.carriedP1s.unmeasured, 1);
  const lines = renderScorecard(card);
  const carried = lines.find((l) => l.startsWith('  P1s carried:')) ?? '';
  assert.ok(carried.includes('not recorded by any run (1 could not say)'), carried);
  assert.ok(!/P1s carried:\s+0 over/.test(carried), 'never rendered as a zero');
});

test('stats counts each fact over the runs that recorded it, and says how the non-zero ones ended', () => {
  const first = freshRun({ prefix: 'vibe-risk-', task: 'one' });
  first.riskFacts = {
    carriedP1s: 2,
    assumptions: 1,
    deferredQuestions: 0,
    modelAnswers: 3,
    planStalls: 0,
    planRounds: 2,
    namedFiles: 4,
  };
  first.status = 'done';
  saveState(first);
  // A second run in the same archive, whose model-answer count could not be
  // established, and a third from before the record existed.
  const second = freshRun({ prefix: 'vibe-risk-', task: 'two' });
  const secondDir = path.join(first.targetDir, '.vibe', 'runs', 'second-run');
  const stored = JSON.parse(readFileSync(path.join(second.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  stored['id'] = 'second-run';
  stored['status'] = 'error';
  stored['riskFacts'] = { carriedP1s: 1, assumptions: 0, deferredQuestions: 2, planStalls: 1, planRounds: 3, namedFiles: 0 };
  writeState(secondDir, stored);
  const thirdDir = path.join(first.targetDir, '.vibe', 'runs', 'third-run');
  writeState(thirdDir, { ...stored, id: 'third-run', riskFacts: undefined });

  const card = scoreArchive(first.targetDir);
  assert.equal(card.archive.read, 3);
  assert.equal(card.riskFacts.recorded, 2);
  const carried = card.riskFacts.byFact.carriedP1s;
  assert.deepEqual(
    { measured: carried.measured, unmeasured: carried.unmeasured, total: carried.total, max: carried.max },
    { measured: 2, unmeasured: 1, total: 3, max: 2 },
  );
  assert.deepEqual(carried.nonZeroEndings, { done: 1, error: 1 });
  const answers = card.riskFacts.byFact.modelAnswers;
  assert.deepEqual({ measured: answers.measured, unmeasured: answers.unmeasured }, { measured: 1, unmeasured: 2 });

  const lines = renderScorecard(card);
  assert.ok(lines.includes('Risk facts at plan approval  (counts of what each run recorded; no threshold)'));
  assert.ok(lines.some((l) => l.startsWith('  runs recording them:') && l.endsWith('2 of 3')));
  const line = lines.find((l) => l.startsWith('  P1s carried:')) ?? '';
  assert.ok(line.includes('3 over 2 runs, max 2') && line.includes('1 could not say'), line);
  assert.ok(line.includes('non-zero ended 1 done, 1 error'), line);
  // A count, never a rate: the line carries no percentage.
  assert.ok(!line.includes('%'), line);
  // The JSON document is the same measurement.
  assert.equal(JSON.parse(JSON.stringify(card)).riskFacts.byFact.planRounds.total, 5);
});

function writeState(dir: string, raw: Record<string, unknown>): void {
  // Written by hand rather than through `createRun`: a hand-written
  // state.json is exactly what an old archive holds.
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(raw, null, 2));
}

test('a malformed record is dropped with a repair note, never repaired into a count', () => {
  const state = freshRun({ prefix: 'vibe-risk-', task: 'damaged' });
  const raw = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  const good = { carriedP1s: 0, assumptions: 0, deferredQuestions: 0, planStalls: 0, planRounds: 0, namedFiles: 0 };
  for (const bad of [
    'three',
    [],
    { ...good, carriedP1s: -1 },
    { ...good, namedFiles: 1.5 },
    { ...good, modelAnswers: 'some' },
    { carriedP1s: 1 },
  ]) {
    const { state: out, repairs } = validateStoredState({ ...raw, riskFacts: bad }, state.id, state.dir);
    assert.equal(out.riskFacts, undefined, JSON.stringify(bad));
    assert.ok(repairs.some((r) => r.field === 'riskFacts'), JSON.stringify(bad));
    assert.equal(readRiskFactsRecord(bad), null);
  }
  // A record without `modelAnswers` is whole: that is how the writer says the
  // count could not be established.
  const { state: kept, repairs } = validateStoredState({ ...raw, riskFacts: good }, state.id, state.dir);
  assert.deepEqual(kept.riskFacts, good);
  assert.equal(repairs.length, 0);
});
