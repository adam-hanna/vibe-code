import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { votePrompt } from '@src/prompts.js';
import type { VoteClaim } from '@src/prompts.js';

/**
 * A verifier's prompt (#388 Part C), frozen against a reviewed golden.
 *
 * `tests/fixtures/prompts/vote-basic.txt` was generated once from exactly the
 * call below (`ARGS`), read by eye, and committed; it is regenerated only when
 * the vote's instructions are deliberately changed, as the README there says
 * of the others.
 */

const CLAIM: VoteClaim = {
  title: 'Retry loop never gives up',
  detail: 'retry() loops while the call fails and has no attempt cap, so a permanent failure hangs the run.',
  suggested_fix: 'Cap the attempts and rethrow the last error.',
  evidence: [{ kind: 'code', path: 'src/retry.ts', line: 12 }],
};

function render(): string {
  return votePrompt(
    CLAIM,
    ['src/retry.ts'],
    'diff --git a/src/retry.ts b/src/retry.ts\n+  while (true) {\n',
    '# Plan\n\nAdd a retry helper.',
    [{ item: 'Backoff tuning', why: 'Separate work.' }],
  );
}

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/prompts/${name}`, import.meta.url)), 'utf8');
}

test('the vote prompt matches its reviewed golden', () => {
  assert.equal(render(), fixture('vote-basic.txt'));
});

test('it asks whether the defect exists, and says what each vote needs', () => {
  const p = render();
  assert.match(p, /Judge \*\*whether the defect exists\*\* in this code - not how severe it is, and not whether it is worth fixing/);
  assert.match(p, /\*\*`not-real`\*\* - the claim is false\. Give a concrete reason it is false, and evidence/);
  assert.match(p, /If you are in doubt, this is your vote/);
  assert.match(p, /`real`\*\* - .*You need no evidence beyond the claim's own/);
});

test('it carries the claim and nothing about who made it', () => {
  const p = render();
  for (const part of [CLAIM.title, CLAIM.detail, CLAIM.suggested_fix, '`src/retry.ts:12`', 'Backoff tuning']) {
    assert.ok(p.includes(part), `missing ${part}`);
  }
  // The builder has no argument for any of these, so none can appear.
  for (const absent of ['foundBy', 'finder', 'review.verifiers', 'severity', 'P1', 'P0', 'ballot']) {
    assert.equal(p.includes(absent), false, `the prompt names ${absent}`);
  }
});
