import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearPromptOverrides,
  fixPrompt,
  implementPrompt,
  installPromptOverrides,
  promptBlocks,
  revisePlanPrompt,
} from '@src/prompts.js';
import { findingFixture } from './helpers/loop-harness.js';

/**
 * Whoever deferred a finding is named by phase (#509).
 *
 * A plan finding was deferred by the plan critique, which is the critic plus any
 * critique finders (#405), and the planner used to be told "deferred by the
 * reviewer". The review side's bytes are what they were: these cases pin the
 * review-side mark and note as literals, so a change that moved them would
 * fail here rather than pass as a wording tweak.
 */

const REVIEW_MARK =
  '**Deferred by the reviewer** - real, and agreed to belong in separate work rather than in this change.';
const PLAN_MARK =
  '**Deferred by the plan critique** - real, and agreed to belong in separate work rather than in this change.';
const FIXER_NOTE =
  'A deferred finding is not work to do here: the reviewer has already agreed it belongs in separate effort';

const DEFERRED = findingFixture({ id: 'later', severity: 'P2', defer: true });
const BLOCKER = findingFixture({ id: 'now', severity: 'P1' });

/** The text after `marker`, refusing a marker that is not there. */
function from(text: string, marker: string): string {
  const at = text.indexOf(marker);
  assert.ok(at !== -1, `expected ${JSON.stringify(marker)} in the prompt`);
  return text.slice(at);
}

test('a plan revision names the plan critique as what deferred a finding', () => {
  const prompt = revisePlanPrompt({ findings: [DEFERRED, BLOCKER], round: 2 });

  // On the finding itself, right after its fix.
  assert.ok(from(prompt, '`later`').includes(`*Suggested fix:* Fix it.`));
  assert.ok(prompt.includes(PLAN_MARK));
  assert.ok(!prompt.includes('Deferred by the reviewer'));
  // And in the paragraph below the findings that says what a deferral asks.
  assert.ok(prompt.includes('That is the plan critique agreeing the work belongs elsewhere'));
  assert.ok(!prompt.includes('That is the reviewer agreeing'));
});

test('the implement prompt names the plan critique for what it declined and carried', () => {
  const prompt = implementPrompt('PLAN_BODY', [BLOCKER], [DEFERRED]);

  const declined = from(prompt, '## Declined by the plan critique - not work for this change');
  assert.ok(declined.includes('The plan critique marked these **deferred**'));
  assert.ok(declined.includes('`later`'));
  const carried = from(prompt, '## Known open issues with this plan');
  assert.ok(carried.startsWith('## Known open issues with this plan\n\nThe plan critique raised these'));
  // Neither list came from a code review, so no reviewer is named for them.
  assert.ok(!prompt.includes('Declined by the reviewer'));
  assert.ok(!prompt.includes('The reviewer marked these'));
  assert.ok(!prompt.includes('The reviewer raised these'));
});

test('a review fix prompt still says the reviewer deferred it, byte for byte', () => {
  // Both renderings: the review fix turns (with `dispositions`) and the plain one.
  for (const dispositions of [false, true]) {
    const prompt = fixPrompt([DEFERRED, BLOCKER], 1, [], null, dispositions);
    // The mark sits directly under the finding, as it always did.
    assert.ok(prompt.includes(`*Suggested fix:* Fix it.`));
    assert.ok(prompt.includes(`\n\n${REVIEW_MARK}`));
    assert.ok(prompt.includes(FIXER_NOTE));
    assert.ok(!prompt.includes('plan critique'));
  }
});

test('an override of "a deferred finding" replaces the mark on both sides', (t) => {
  t.after(clearPromptOverrides);
  installPromptOverrides({ 'a deferred finding': 'CUSTOM DEFERRAL MARK' });

  const revise = revisePlanPrompt({ findings: [DEFERRED, BLOCKER], round: 2 });
  const fix = fixPrompt([DEFERRED, BLOCKER], 1);
  for (const prompt of [revise, fix]) {
    assert.ok(prompt.includes('\n\nCUSTOM DEFERRAL MARK'));
    assert.ok(!prompt.includes(PLAN_MARK));
    assert.ok(!prompt.includes(REVIEW_MARK));
  }

  // Still one block, reported as overridden, reaching the same two turns.
  const blocks = promptBlocks().filter((b) => b.name === 'a deferred finding');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.overridden, true);
  assert.equal(blocks[0]?.text, 'CUSTOM DEFERRAL MARK');
  assert.equal(blocks[0]?.fallback, REVIEW_MARK);
  assert.deepEqual(blocks[0]?.usedBy, ['planner', 'implementer']);
});

test('a blank override gives each side its own default back', (t) => {
  t.after(clearPromptOverrides);
  installPromptOverrides({ 'a deferred finding': '   ' });

  assert.ok(revisePlanPrompt({ findings: [DEFERRED, BLOCKER], round: 2 }).includes(PLAN_MARK));
  assert.ok(fixPrompt([DEFERRED, BLOCKER], 1).includes(REVIEW_MARK));
});
