import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  answerPrompt,
  clearPromptOverrides,
  critiquePrompt,
  fixPrompt,
  implementPrompt,
  installPromptOverrides,
  planPrompt,
  promptBlocks,
  revisePlanPrompt,
  reviewPrompt,
} from '@src/prompts.js';
import { FINDINGS_SCHEMA, PLAN_SCHEMA } from '@src/schemas.js';
import { parseFindings } from '@src/validate.js';
import { CRITERIA, DIFF, FILES, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';
import { BLOCKING, planFixture } from './helpers/loop-harness.js';

// These cases check the instructions and their wiring, not model behaviour.
function everyStage(): readonly string[] {
  return [
    planPrompt('original task', 'original constraint'),
    critiquePrompt(PLAN_MD, [], OUT_OF_SCOPE, 1, false),
    answerPrompt([], PLAN_MD),
    revisePlanPrompt({ planMd: PLAN_MD, findings: BLOCKING, round: 1 }),
    implementPrompt(PLAN_MD, [], [], CRITERIA, OUT_OF_SCOPE),
    reviewPrompt(DIFF, FILES, PLAN_MD, OUT_OF_SCOPE, 1, false),
    fixPrompt(BLOCKING, 1, CRITERIA, planFixture({ plan_md: PLAN_MD, out_of_scope: [...OUT_OF_SCOPE] })),
  ];
}

test('the same simplicity instruction reaches every stage and is overridable', () => {
  const shared = promptBlocks().find((b) => b.name === 'simple solution');
  assert.ok(shared !== undefined);
  for (const prompt of everyStage()) {
    assert.ok(prompt.includes(shared.text));
    assert.equal(prompt.split(shared.text).length - 1, 1);
  }

  installPromptOverrides({ 'simple solution': 'PROJECT-SIMPLICITY-RULE' });
  try {
    for (const prompt of everyStage()) {
      assert.ok(prompt.includes('PROJECT-SIMPLICITY-RULE'));
      assert.equal(prompt.includes(shared.text), false);
    }
  } finally {
    clearPromptOverrides();
  }
});

test('initial implementation and fixes both require independent judgement and impact tracing', () => {
  for (const prompt of [implementPrompt(PLAN_MD), fixPrompt(BLOCKING, 1)]) {
    assert.ok(prompt.includes('A suggested fix is advisory'));
    assert.ok(prompt.includes('Trace upstream inputs'));
    assert.ok(prompt.includes('downstream consumers'));
    assert.ok(prompt.includes('what it could break that previously worked'));
    assert.ok(prompt.includes('Fix proven occurrences necessary to this task'));
    assert.ok(prompt.includes('a valid defect still'));
    assert.equal(prompt.includes('fix those occurrences too'), false);
  }
});

test('a correct plan and a clean review are allowed without manufactured assumptions or findings', () => {
  const planning = planPrompt('small change', null);
  const critique = critiquePrompt(PLAN_MD, [], [], 1, false);
  const review = reviewPrompt(DIFF, FILES, PLAN_MD, [], 1, false, null, undefined, CRITERIA, undefined, 'Verified: all checks pass.');
  assert.ok(planning.includes('An empty list is valid'));
  assert.equal(critique.includes('treat that itself as suspicious'), false);
  for (const prompt of [critique, review]) {
    assert.ok(prompt.includes('An empty findings list'));
    assert.ok(prompt.includes('a concrete trigger in a supported scenario'));
    assert.ok(prompt.includes('the affected task requirement or existing contract'));
  }
  assert.equal(review.includes('finding nothing beyond what it lists is not a review'), false);
  assert.equal(parseFindings({ verdict: 'APPROVE', summary: 'Inspected; no defects.', findings: [] }).verdict, 'APPROVE');
});

test('schema descriptions preserve the same scope and independent-repair rules', () => {
  assert.ok(PLAN_SCHEMA.properties.assumptions.description.includes('Material unresolved assumptions'));
  assert.equal(PLAN_SCHEMA.properties.assumptions.description.includes('Be exhaustive'), false);
  assert.ok(PLAN_SCHEMA.properties.acceptance_criteria.description.includes('original task and explicit user decisions'));
  const findings = FINDINGS_SCHEMA.properties.findings;
  assert.ok(findings.description.includes('no quota'));
  assert.ok(findings.items.properties.detail.description.includes('concrete trigger'));
  assert.ok(findings.items.properties.suggested_fix.description.includes('Advisory'));
  assert.ok(findings.items.properties.suggested_fix.description.includes('removing or simplifying'));
});

test('a cheap optional improvement does not automatically join a fix round', () => {
  const prompt = fixPrompt(BLOCKING, 1);
  assert.ok(prompt.includes('belongs to the task or is necessary to a coherent repair'));
  assert.ok(prompt.includes('Defer separable improvements, even when they would be a small edit'));
});

test('the declared boundary reaches initial implementation even when absent from plan prose', () => {
  const prompt = implementPrompt(PLAN_MD, [], [], CRITERIA, OUT_OF_SCOPE);
  assert.ok(prompt.includes(OUT_OF_SCOPE[0]?.item ?? assert.fail('fixture needs a scope exclusion')));
  assert.ok(prompt.includes(OUT_OF_SCOPE[0]?.why ?? assert.fail('fixture needs a scope reason')));
  assert.ok(implementPrompt(PLAN_MD).includes('no boundary was recorded'));
});
