import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findRephrase,
  isSameQuestion,
  normalize,
  REPHRASE_THRESHOLD,
  similarity,
} from '@src/questions.js';

/**
 * When two wordings are one question.
 *
 * The four wordings below are real, copied verbatim from `plan-0.json` through
 * `plan-3.json` of the run
 * `20260825-121246-generalize-verification-into-named-gates` in this
 * repository's `.vibe/runs/` archive - the run that asked one question four
 * times, spent three extra answer turns on it and then stopped at
 * `loop.maxQuestionRounds`. `UNRELATED` is the other question in that same
 * `plan-0.json`, so the pair "rephrasing" and "different question" both come
 * from one plan rather than from something written to make a threshold look
 * good.
 *
 * They are inlined rather than read from `.vibe/`, which is not shipped and not
 * tracked. The run id above is how to find the originals.
 */
const W1 =
  'Should an unavailable *optional* gate still be visible in the run summary, or only in the event log and `gateOutcomes`?';
const W2 =
  'Should an unavailable *optional* gate be visible in the run summary, or only in the log line, the event log and `gateOutcomes`?';
const W3 =
  'Should an unavailable *optional* gate be visible in the `Done` summary, or only in the run log, the event log and `gateOutcomes`?';
const W4 =
  'Should an unavailable *optional* gate be visible in the `Done` summary, or only in the run log, the event log, `gateOutcomes` and `OUTSTANDING.md`?';
const UNRELATED =
  'When a gate fails and the sequence stops, should the gates that never got their turn be recorded as anything (e.g. `not-run`), or left out of `gateOutcomes` entirely?';

const WORDINGS = [W1, W2, W3, W4] as const;

test('every pair of the four real wordings scores above the threshold', () => {
  for (let i = 0; i < WORDINGS.length; i++) {
    for (let j = i + 1; j < WORDINGS.length; j++) {
      const score = similarity(WORDINGS[i] as string, WORDINGS[j] as string);
      assert.ok(
        score >= REPHRASE_THRESHOLD,
        `wordings ${i} and ${j} scored ${score.toFixed(3)}, below ${REPHRASE_THRESHOLD}`,
      );
    }
  }
});

test('each later wording is found as a rephrasing of the first', () => {
  for (const later of [W2, W3, W4]) {
    const found = findRephrase(later, [normalize(W1)]);
    assert.notEqual(found, null);
    assert.equal(found?.candidate, normalize(W1));
    assert.ok((found?.score ?? 0) >= 0.8, 'the measured band for these is 0.81-0.90');
  }
});

test('a genuinely different question from the same plan is not a rephrasing', () => {
  const score = similarity(W1, UNRELATED);
  assert.ok(score <= 0.4, `scored ${score.toFixed(3)}, which is inside the band measured empty`);
  assert.equal(findRephrase(UNRELATED, [normalize(W1)]), null);
});

// ---- the selection rule ------------------------------------------------------

// Synthetic, and deliberately so: these pin the arithmetic of the rule, not a
// claim about real questions. Token sets of 4 and 4 sharing 3 give 3/5 = 0.6.
const BASE = 'alpha bravo charlie delta';
const AT_THRESHOLD = 'alpha bravo charlie echo'; // 3 shared, union 5 -> 0.60
const BELOW_THRESHOLD = 'alpha bravo'; // 2 shared, union 4 -> 0.50
const HIGHER = 'alpha bravo charlie delta golf'; // 4 shared, union 5 -> 0.80
const TIE = 'alpha bravo charlie foxtrot'; // 3 shared, union 5 -> 0.60

test('the threshold is inclusive: exactly 0.6 matches, 0.5 does not', () => {
  assert.equal(similarity(BASE, AT_THRESHOLD).toFixed(2), '0.60');
  assert.equal(similarity(BASE, BELOW_THRESHOLD).toFixed(2), '0.50');
  assert.equal(findRephrase(BASE, [AT_THRESHOLD])?.candidate, AT_THRESHOLD);
  assert.equal(findRephrase(BASE, [BELOW_THRESHOLD]), null);
});

test('the highest-scoring candidate wins, and a tie goes to the first', () => {
  assert.equal(findRephrase(BASE, [AT_THRESHOLD, HIGHER])?.candidate, HIGHER);
  assert.equal(findRephrase(BASE, [HIGHER, AT_THRESHOLD])?.candidate, HIGHER);
  // Both at 0.60. The record has to name one, and which one must not depend on
  // the order two equal scores happened to be compared in.
  assert.equal(findRephrase(BASE, [AT_THRESHOLD, TIE])?.candidate, AT_THRESHOLD);
  assert.equal(findRephrase(BASE, [TIE, AT_THRESHOLD])?.candidate, TIE);
});

test('an exact candidate suppresses the fuzzy answer, wherever it sits in the list', () => {
  // The callers handle exactness themselves, silently. If this returned the
  // fuzzy runner-up, a verbatim repeat would start being reported as a
  // rephrasing - which is the one case #65 says must stay silent.
  assert.equal(findRephrase(BASE, [HIGHER, normalize(BASE)]), null);
  assert.equal(findRephrase(BASE, [normalize(BASE), HIGHER]), null);
  assert.equal(findRephrase(BASE, ['  ALPHA, Bravo; charlie -- delta!  ']), null);
});

test('similarity of a question with itself is 1, and normalize is idempotent', () => {
  assert.equal(similarity(W1, W1), 1);
  assert.equal(similarity(W1, normalize(W1)), 1);
  assert.equal(normalize(normalize(W1)), normalize(W1));
});

test('punctuation and case alone are an exact match, not a fuzzy one', () => {
  const shouted = '  SHOULD the WIDGET be lazy, or eager?!  ';
  const plain = 'Should the widget be lazy or eager';
  assert.equal(isSameQuestion(shouted, plain), true);
  assert.equal(findRephrase(shouted, [plain]), null);
});

test('an empty or whitespace-only question matches nothing and never divides by zero', () => {
  for (const empty of ['', '   ', '???', '\n\t']) {
    assert.equal(similarity(empty, W1), 0);
    assert.equal(similarity(W1, empty), 0);
    assert.equal(Number.isNaN(similarity(empty, empty)), false);
    assert.equal(similarity(empty, empty), 0);
    assert.equal(findRephrase(empty, [W1, normalize(empty)]), null);
    assert.equal(findRephrase(W1, [empty]), null);
    assert.equal(isSameQuestion(empty, empty), false);
  }
});
