import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrompt, votePrompt } from '@src/prompts.js';
import type { ReviewStandards, VoteClaim } from '@src/prompts.js';

/**
 * Where the repository's REVIEW.md sits in the two prompts that carry it (#389):
 * after vibe's own standing text, so the severity definitions and the cost of
 * a wrong finding still frame it, and before everything about this change.
 *
 * The byte-for-byte half - a repository without one gets today's prompt - is
 * `review-prompt-compat.test.ts` and `vote-prompt.test.ts`, which this change
 * leaves untouched. The cases here only add the argument.
 */

const HEADING = "## This repository's review standards (REVIEW.md)";
const STANDARDS: ReviewStandards = {
  text: '# Standards\n\n- Inventing a number is a P1.\n',
  commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
};

function review(md?: ReviewStandards, extras = false): string {
  return reviewPrompt(
    'diff --git a/x.ts b/x.ts\n+export const x = 1;\n',
    ['x.ts', 'tests/x.test.ts'],
    '# Plan',
    undefined,
    1,
    false,
    null,
    undefined,
    undefined,
    extras ? { index: 1, total: 2, files: ['x.ts'], truncated: [], carriesEarlierParts: false } : undefined,
    extras ? 'The report.' : undefined,
    undefined,
    extras ? [{ path: 'tests/x.test.ts', oldPath: null, status: 'modified', added: 1, removed: 1 }] : undefined,
    md,
  );
}

const CLAIM: VoteClaim = { title: 'A claim', detail: 'It is wrong.', suggested_fix: 'Fix it.' };

function vote(md?: ReviewStandards): string {
  return votePrompt(CLAIM, ['x.ts'], '+x', '# Plan', undefined, null, undefined, md);
}

function order(p: string, ...marks: string[]): void {
  const at = marks.map((m) => {
    const i = p.indexOf(m);
    assert.ok(i >= 0, `missing ${m}`);
    return i;
  });
  for (let i = 1; i < at.length; i++) {
    assert.ok((at[i - 1] as number) < (at[i] as number), `${marks[i - 1]} is not before ${marks[i]}`);
  }
}

test('the review prompt carries the heading, the short commit and the text, verbatim', () => {
  const p = review(STANDARDS);
  assert.ok(p.includes(HEADING));
  assert.ok(p.includes("written by this repository's owners and read from commit `a1b2c3d`"));
  assert.match(p, /It adds to the instructions above and does not replace them\./);
  assert.ok(p.includes(STANDARDS.text));
});

test('it sits after vibe\'s standing text and before the chunk note, the report, the judge, the files and the diff', () => {
  const p = review(STANDARDS, true);
  order(
    p,
    '## Severity',
    '## Simplest complete solution',
    HEADING,
    STANDARDS.text,
    '## This is part 1 of 2',
    '## What the implementer says it did',
    '## Changes to the judge',
    '## Files changed',
    '## Diff',
  );
});

test('the vote prompt carries it after How to vote, with its severity sentence, and before the evidence and the diff', () => {
  const p = vote(STANDARDS);
  assert.ok(p.includes(STANDARDS.text));
  assert.ok(p.includes('`a1b2c3d`'));
  assert.match(p, /Any severity rules in it are not your question/);
  order(p, '## How to vote', HEADING, STANDARDS.text, '## Evidence', '## The claim', '## Diff');
});

test('absent renders nothing: both prompts equal the call without the argument', () => {
  assert.equal(review(undefined, true), reviewPrompt(
    'diff --git a/x.ts b/x.ts\n+export const x = 1;\n',
    ['x.ts', 'tests/x.test.ts'],
    '# Plan',
    undefined,
    1,
    false,
    null,
    undefined,
    undefined,
    { index: 1, total: 2, files: ['x.ts'], truncated: [], carriesEarlierParts: false },
    'The report.',
    undefined,
    [{ path: 'tests/x.test.ts', oldPath: null, status: 'modified', added: 1, removed: 1 }],
  ));
  assert.equal(vote(undefined), votePrompt(CLAIM, ['x.ts'], '+x', '# Plan', undefined, null));
  assert.ok(!review().includes(HEADING));
  assert.ok(!vote().includes(HEADING));
});

test('a text with no final newline is still closed off from what follows', () => {
  const p = review({ ...STANDARDS, text: 'one line' });
  assert.ok(p.includes('one line\n'));
});
