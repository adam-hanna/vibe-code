import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { recordHumanAnswers } from '@src/cli.js';
import { orchestrate } from '@src/orchestrator.js';
import { loadRun, saveState } from '@src/run.js';
import { BLOCKING, agents, answersReport, config, freshRun, planFixture, questionFixture, report, reviewingRun, verifying, work } from './helpers/loop-harness.js';
import { CRITERIA, OUT_OF_SCOPE } from './helpers/prompt-fixture-args.js';
import type { Answer } from '@src/types.js';

const TASK = 'ORIGINAL-TASK\n\nMake the existing operation work; preserve its public shape.';
const EXTRA = 'ORIGINAL-CONSTRAINT: add no configuration options.';
const PLAN = planFixture({
  plan_md: 'CURRENT-PLAN: repair the existing operation.',
  out_of_scope: [...OUT_OF_SCOPE],
  acceptance_criteria: [...CRITERIA],
});
const HUMAN: Answer = {
  question: 'Should this introduce a compatibility switch?',
  answer: 'HUMAN-DECISION: use the existing behaviour without a switch.',
  confidence: 'high',
  defer_to_human: false,
  rationale: 'The user clarified the scope.',
};

test('every stage receives the original brief and current plan through the real loop', async () => {
  const state = freshRun({ task: TASK, planOnly: false, git: true, commit: true });
  state.extraContext = EXTRA;
  const prompts = new Map<string, string>();
  const capture = (label: string, prompt: string): void => { prompts.set(label, prompt); };
  const question = questionFixture({ kind: 'technical', question: 'Which existing operation should be reused?' });
  const calls: string[] = [];
  await orchestrate(state, config({ p1Tolerance: 0 }), false, agents({
    claude: (label, options) => {
      capture(label, options.prompt);
      if (label === 'plan') return planFixture({ ...PLAN, open_questions: [question] });
      if (label.startsWith('revise-')) return PLAN;
      return work(state, `${label}.txt`);
    },
    codex: (label, options) => {
      capture(label, options.prompt);
      if (label.startsWith('answers-')) {
        return answersReport([{ question: question.question, answer: 'MODEL-RECOMMENDATION: reuse the existing operation.' }]);
      }
      return report(label === 'critique-0' || label === 'review-0' ? BLOCKING : []);
    },
  }, calls));
  assert.deepEqual(calls, ['plan', 'answers-1', 'revise-q1', 'critique-0', 'revise-1', 'critique-1', 'implement', 'review-0', 'fix-1', 'review-1']);
  for (const [label, prompt] of prompts) {
    assert.ok(prompt.includes(TASK), `${label}: original task`);
    assert.ok(prompt.includes(EXTRA), `${label}: original additional context`);
    assert.equal(prompt.split(TASK).length - 1, 1, `${label}: task appears once`);
    assert.equal(prompt.includes('## Explicit user decisions'), false, `${label}: model advice is not a user decision`);
    if (label === 'plan') continue;
    assert.ok(prompt.includes(PLAN.plan_md), `${label}: current plan`);
    assert.equal(prompt.split(PLAN.plan_md).length - 1, 1, `${label}: plan appears once`);
    assert.ok(prompt.includes(OUT_OF_SCOPE[0]?.item ?? assert.fail('fixture scope')), `${label}: scope exclusion`);
    assert.ok(prompt.includes('`returns-new`'), `${label}: acceptance criteria`);
  }
});

test('human decisions survive consumption, persistence, and fresh or continuing sessions', async () => {
  for (const persist of [true, false]) {
    const state = freshRun({ task: TASK, planOnly: false, git: true, commit: true });
    state.plan = PLAN;
    state.extraContext = EXTRA;
    state.pendingAnswers = [HUMAN];
    recordHumanAnswers(state, [HUMAN]);
    saveState(state);
    const restored = loadRun(state.targetDir, state.id);
    const prompts: string[] = [];
    const cfg = config({}, { codex: { ...config().codex, persistSession: persist } });
    await orchestrate(restored, cfg, true, agents({
      claude: (label, options) => {
        prompts.push(options.prompt);
        return label.startsWith('revise-') ? PLAN : work(restored, `${label}.txt`);
      },
      codex: (_label, options) => { prompts.push(options.prompt); return report([]); },
    }, []));
    assert.equal(restored.pendingAnswers, null);
    assert.deepEqual(loadRun(restored.targetDir, restored.id).humanAnswers, [HUMAN]);
    for (const prompt of prompts) {
      assert.ok(prompt.includes('## Explicit user decisions'));
      assert.ok(prompt.includes(HUMAN.answer));
      assert.ok(prompt.includes(TASK));
    }
  }
});

test('a memoryless Codex writer receives one approved plan and the user decisions on every repair', async () => {
  const state = freshRun({ task: TASK, planOnly: false, git: true, commit: true });
  state.plan = PLAN;
  state.extraContext = EXTRA;
  recordHumanAnswers(state, [HUMAN]);
  const prompts = new Map<string, string>();
  const cfg = config({ p1Tolerance: 0 }, {
    roles: { planner: 'codex', implementer: 'codex', critic: 'claude', answerer: 'claude', reviewer: 'claude' },
    codex: { ...config().codex, persistSession: false },
  });
  await orchestrate(state, cfg, true, agents({
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      return report(label === 'review-0' ? BLOCKING : []);
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      return work(state, `${label}.txt`);
    },
  }, []));
  for (const label of ['implement', 'fix-1']) {
    const prompt = prompts.get(label) ?? assert.fail(`missing ${label}`);
    assert.ok(prompt.includes(TASK));
    assert.ok(prompt.includes(EXTRA));
    assert.ok(prompt.includes(HUMAN.answer));
    assert.equal(prompt.split(PLAN.plan_md).length - 1, 1, `${label}: plan is explicit without a duplicate restoration`);
    assert.ok(prompt.includes(OUT_OF_SCOPE[0]?.item ?? assert.fail('fixture scope')));
    assert.ok(prompt.includes('`returns-new`'));
  }
});

test('a verification repair and the final carried-finding repair receive the approved plan', async () => {
  const state = reviewingRun({ task: TASK });
  state.plan = PLAN;
  state.acceptanceCriteria = [...CRITERIA];
  state.extraContext = EXTRA;
  const prompts = new Map<string, string>();
  await orchestrate(state, config({}, verifying(state, { failures: 1 })), true, agents({
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      return work(state, `${label}.txt`);
    },
    codex: () => report([BLOCKING[0] ?? assert.fail('fixture finding')]),
  }, []));
  for (const label of ['verify-fix-1', 'final-fix-1']) {
    const prompt = prompts.get(label) ?? assert.fail(`missing ${label}`);
    assert.ok(prompt.includes(TASK));
    assert.ok(prompt.includes(EXTRA));
    assert.ok(prompt.includes(PLAN.plan_md));
    assert.ok(prompt.includes(OUT_OF_SCOPE[0]?.item ?? assert.fail('fixture scope')));
    assert.ok(prompt.includes('`returns-new`'));
  }
});

test('human answer storage preserves chronological amendments and tolerates legacy or damaged records', () => {
  const state = freshRun({ task: TASK });
  recordHumanAnswers(state, [HUMAN]);
  const amendment = { ...HUMAN, answer: 'LATER-USER-DECISION' };
  recordHumanAnswers(state, [amendment]);
  saveState(state);
  assert.deepEqual(loadRun(state.targetDir, state.id).humanAnswers, [HUMAN, amendment]);

  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['humanAnswers'] = [null, HUMAN, { question: 'broken' }];
  writeFileSync(file, JSON.stringify(raw), 'utf8');
  assert.deepEqual(loadRun(state.targetDir, state.id).humanAnswers, [HUMAN]);
  delete raw['humanAnswers'];
  writeFileSync(file, JSON.stringify(raw), 'utf8');
  assert.equal(loadRun(state.targetDir, state.id).humanAnswers, undefined);
});
