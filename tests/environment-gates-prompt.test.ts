import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environmentBlock } from '@src/prompts.js';
import type { EnvironmentFacts } from '@src/runtime.js';

/**
 * What the agents are told about verification.
 *
 * `environmentBlock` states these as observations - "vibe established the
 * following by executing each tool" - so a sentence naming one command while
 * three gates are configured is not merely vague, it is false, and the reviewer
 * reasons from it. The pre-#47 sentence has to survive untouched for a run whose
 * stored facts predate the gate list, which is the other half of this file.
 */

function facts(over: Partial<EnvironmentFacts> = {}): EnvironmentFacts {
  return {
    agents: [
      {
        provider: 'claude',
        shell: 'bash',
        pathStyle: 'msys',
        repaired: false,
        tools: [{ name: 'node', available: true, version: 'v24.18.0' }],
      },
    ],
    verifyCommand: 'npm run typecheck',
    verifyRuns: 1,
    ...over,
  };
}

test('every gate is named, and the ones that will not run say so', () => {
  const block = environmentBlock(
    facts({
      verifyGates: [
        { name: 'typecheck', command: 'npm run typecheck', runs: 1 },
        { name: 'test', command: 'npm test', runs: 3 },
        { name: 'qa', command: null, runs: 1 },
      ],
    }),
    'planner',
  );

  assert.match(block, /`typecheck`: `npm run typecheck`, 1 consecutive time/);
  assert.match(block, /`test`: `npm test`, 3 consecutive time/);
  assert.match(block, /`qa`: no command configured; this gate will not run/);
  // The single-command sentence would name one of three and imply the others do
  // not exist.
  assert.doesNotMatch(block, /vibe will run `npm run typecheck` itself/);
});

test('without a gate list the sentence is exactly the one runs before #47 were given', () => {
  const block = environmentBlock(facts({ verifyCommand: 'npm test', verifyRuns: 3 }), 'planner');

  assert.match(
    block,
    /Verification: vibe will run `npm test` itself - not an agent - and it must pass 3 consecutive times before the change is accepted\./,
  );
  assert.doesNotMatch(block, /this gate will not run/);
});

test('a run with no verification at all still says nothing will execute the change', () => {
  const block = environmentBlock(facts({ verifyCommand: null }), 'planner');

  assert.match(block, /No verification command is configured/);
});

test('an empty gate list falls back rather than claiming an empty set of gates', () => {
  // Not reachable from a validated config - `gates: []` is refused - but the
  // facts are read tolerantly from a stored record, so the renderer must not
  // print a heading with nothing under it.
  const block = environmentBlock(facts({ verifyGates: [] }), 'reviewer');

  assert.match(block, /vibe will run `npm run typecheck` itself/);
});
