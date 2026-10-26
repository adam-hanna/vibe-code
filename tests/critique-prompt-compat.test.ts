import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { advisoryAnswers, critiquePrompt } from '@src/prompts.js';
import { CRITERIA, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';
import type { Assumption } from '@src/types.js';

/**
 * The critic's first-round prompt, frozen before #405 touched the plan loop.
 *
 * `tests/fixtures/prompts/critique-round1.txt` was generated from `9329910`'s
 * own build - `develop` before any of #405's `src/` changes - from exactly the
 * call below. #405 adds critique finders and a vote, and the bar is that with
 * both lists empty the critic is sent this prompt byte for byte; there was no
 * frozen critique prompt to hold it to until this one.
 */

const ASSUMPTIONS: readonly Assumption[] = [
  {
    assumption: 'The widget has one caller.',
    why: 'Only src/widget.ts imports it.',
    blast_radius: 'A second caller would see the new string too.',
  },
];

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/prompts/${name}`, import.meta.url)), 'utf8');
}

test('a first-round critique matches the prompt develop sent before #405', () => {
  const rendered =
    critiquePrompt(PLAN_MD, ASSUMPTIONS, OUT_OF_SCOPE, 1, false, null, undefined, CRITERIA, undefined) +
    advisoryAnswers(undefined, 'critic');
  assert.equal(rendered, fixture('critique-round1.txt'));
});
