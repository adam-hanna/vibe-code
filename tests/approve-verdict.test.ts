import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINDINGS_SCHEMA } from '@src/schemas.js';
import { APPROVE_COST, critiquePrompt, reviewPrompt } from '@src/prompts.js';
import { gate } from '@src/validate.js';
import { DEFAULTS } from '@src/config.js';
import type { Finding, Severity } from '@src/types.js';
import { CRITERIA, DIFF, FILES, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';

/**
 * #115: the judge was told what APPROVE *means* - "if and only if there are
 * zero P0 and zero P1 findings" - and that sentence was false. `gate()` decides
 * a round from the findings and `loop.p1Tolerance`, carries up to that many
 * P1s, and never reads the verdict. These cases pin the replacement: no
 * threshold in the schema, a price on an invented finding in the reviewer's
 * prompt alone, and the gate itself untouched.
 */

const verdict = FINDINGS_SCHEMA.properties.verdict;

function findings(...severities: readonly Severity[]): Finding[] {
  return severities.map((severity, i) => ({
    id: `f-${i}`,
    severity,
    title: `f-${i}`,
    detail: '',
    suggested_fix: '',
  }));
}

test('the verdict states no threshold the loop does not apply', () => {
  const text = verdict.description;
  // No count rule of any shape: no severity named, no number, no "iff".
  assert.equal(/\bP[0-3]\b/.test(text), false, text);
  assert.equal(/\d/.test(text), false, text);
  assert.equal(/if and only if|zero/i.test(text), false, text);
  // And it says the field is not what decides the round.
  assert.match(text, /not acted on/);
  assert.match(text, /APPROVE is a correct and expected outcome/);
});

test('the verdict is still the same two words, so every archived review still parses', () => {
  assert.deepEqual(verdict.enum, ['APPROVE', 'REVISE']);
  assert.ok(FINDINGS_SCHEMA.required.includes('verdict'));
});

test('the gate is unchanged: any P0 blocks, P1s up to the tolerance are carried', () => {
  assert.equal(DEFAULTS.loop.p1Tolerance, 1);
  assert.equal(gate(findings('P1'), DEFAULTS.loop.p1Tolerance).pass, true);
  assert.equal(gate(findings('P1', 'P1'), DEFAULTS.loop.p1Tolerance).pass, false);
  assert.equal(gate(findings('P1'), 0).pass, false);
  assert.equal(gate(findings('P0'), 99).pass, false);
  assert.equal(gate([], 0).pass, true);
});

test('the reviewer is told what an invented finding costs, and the critic deliberately is not', () => {
  const review = reviewPrompt(DIFF, FILES, PLAN_MD, OUT_OF_SCOPE, 1, false, null, undefined, CRITERIA);
  const critique = critiquePrompt(PLAN_MD, [], OUT_OF_SCOPE, 1, false, null, undefined, CRITERIA);

  assert.ok(review.includes(APPROVE_COST));
  // Changing both judges at once would make the effect unattributable (#115).
  assert.equal(critique.includes(APPROVE_COST), false);
});

test('the reviewer is never told how many P1s are free', () => {
  // A stated tolerance invites shading a real P1 down to P2 to stay under it.
  const review = reviewPrompt(DIFF, FILES, PLAN_MD, OUT_OF_SCOPE, 1, false, null, undefined, CRITERIA);
  assert.equal(review.includes('p1Tolerance'), false);
  assert.equal(/tolerance of \d/.test(review), false);
});
