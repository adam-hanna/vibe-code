import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { critiqueVotePrompt } from '@src/prompts.js';
import type { VoteClaim, VotePlan } from '@src/prompts.js';
import { PLAN_VOTE_SCHEMA, VOTE_SCHEMA } from '@src/schemas.js';

/**
 * A critique verifier's prompt (#405), frozen against a reviewed golden.
 *
 * `tests/fixtures/prompts/critique-vote-basic.txt` was generated once from
 * exactly the call in `render()`, read by eye, and committed; it is regenerated
 * only when the critique vote's instructions change on purpose. The review's
 * vote prompt is a different function, pinned by `vote-basic.txt`.
 */

const CLAIM: VoteClaim = {
  title: 'The plan edits a function that does not exist',
  detail: 'Step 2 changes `retryAll()` in src/retry.ts, but the module only exports `retry()`.',
  suggested_fix: 'Point step 2 at `retry()`, or say where `retryAll()` will come from.',
  evidence: [{ kind: 'code', path: 'src/retry.ts', line: 12 }],
};

const TASK = 'Make retries give up after five attempts.';

const PLAN: VotePlan = {
  plan_md: '# Plan\n\n1. Read src/retry.ts.\n2. Cap `retryAll()` at five attempts.',
  assumptions: [{ assumption: 'Nothing else calls retry().', why: 'One import.', blast_radius: 'Another caller would also stop at five.' }],
  out_of_scope: [{ item: 'Backoff tuning', why: 'Separate work.' }],
  acceptance_criteria: [{ id: 'gives-up', criterion: 'A permanent failure stops after five attempts.', check: 'command', how: 'npm test' }],
};

function render(): string {
  return critiqueVotePrompt(CLAIM, TASK, PLAN);
}

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/prompts/${name}`, import.meta.url)), 'utf8');
}

test('the critique vote prompt matches its reviewed golden', () => {
  assert.equal(render(), fixture('critique-vote-basic.txt'));
});

test('it asks whether the defect exists in this plan, and not how severe it is', () => {
  const p = render();
  assert.match(p, /Judge \*\*whether the defect exists in this plan\*\* - not how severe it is, and not whether it is worth fixing/);
  assert.match(p, /contradicting the repository, missing something the task requires, getting a step wrong, or putting in scope something the task rules out/);
  for (const section of ['## The task the plan is for', '## The plan', '## Assumptions the planner declared', '## Scope the plan declared', "## The plan's acceptance criteria"]) {
    assert.ok(p.includes(section), `${section} is missing`);
  }
});

test('PLAN_VOTE_SCHEMA has VOTE_SCHEMA\'s shape, worded for a plan', () => {
  assert.deepEqual(PLAN_VOTE_SCHEMA.required, VOTE_SCHEMA.required);
  assert.deepEqual(PLAN_VOTE_SCHEMA.properties.vote.enum, VOTE_SCHEMA.properties.vote.enum);
  assert.equal(PLAN_VOTE_SCHEMA.properties.evidence.items, VOTE_SCHEMA.properties.evidence.items);
  assert.match(PLAN_VOTE_SCHEMA.properties.vote.description, /exists in this plan/);
});
