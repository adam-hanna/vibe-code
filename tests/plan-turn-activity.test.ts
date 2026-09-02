import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectedItems } from '@src/evidence.js';
import { critiquePrompt } from '@src/prompts.js';
import { orchestrate } from '@src/orchestrator.js';
import { agents, config, freshRun, planFixture, report } from './helpers/loop-harness.js';
import type { TurnActivity } from '@src/types.js';

/**
 * Whether the turn that wrote the plan looked at anything (#63).
 *
 * Re-scoped on a 276-finding corpus. The premise held: 75% of critique findings
 * dispute a *fact about the existing code* rather than a decision, and 52% would
 * be settled by one command or one file read. The proposed remedy - a fact phase
 * with citation grounding - did not: a citation that resolves nowhere would have
 * caught 1 finding in 276. The other 275 name real files and draw a false
 * conclusion from them.
 *
 * What the same logs show is an asymmetry. Critic turns ran 150-170 command
 * executions each; planner revision turns ran two, while producing a
 * 45,000-character plan. Six planner turns in the archive inspected nothing at
 * all, and four of them belong to the run that spent 67.2M tokens over eleven
 * rounds and produced no code - including its last three revisions.
 *
 * So: record the fact, name it to the critic, and let the critic judge. No
 * threshold, because "more than N assertions with fewer than M commands" is the
 * invented number AGENTS.md forbids.
 */

/**
 * The shape a planner turn that opened nothing actually takes, verbatim from the
 * archive: all six such turns recorded exactly this.
 *
 * `tool` is 1, not 0, which is why `isInert` cannot answer this question - on the
 * Claude side every `tool_use` block counts and `StructuredOutput` is one.
 */
const ANSWERED_ONLY: TurnActivity = { items: { message: 1, StructuredOutput: 1 }, tool: 1 };

/** A planner turn that read the repository. From the #63 run's own `plan` turn. */
const LOOKED: TurnActivity = {
  items: { message: 30, Bash: 46, Read: 1, StructuredOutput: 1 },
  tool: 48,
};

// ---- the fact ---------------------------------------------------------------

test('a turn nothing measured reports nothing, never zero', () => {
  // The rule the whole of #66 turns on: a zero standing in for an absence is the
  // one thing this repo never records. 231 of the 265 turn events in the archive
  // predate the tally and have none.
  assert.equal(inspectedItems(undefined), null);
  assert.equal(inspectedItems({ items: {}, tool: 0 }), null);
});

test('answering and talking do not count as looking, on either provider', () => {
  assert.equal(inspectedItems(ANSWERED_ONLY), 0);
  assert.equal(inspectedItems({ items: { agent_message: 3, reasoning: 9 }, tool: 0 }), 0);
});

test('everything else does count, including a kind never seen before', () => {
  assert.equal(inspectedItems(LOOKED), 47);
  assert.equal(inspectedItems({ items: { agent_message: 3, command_execution: 93 }, tool: 93 }), 93);
  // Fails open, in the same direction `NON_TOOL_CODEX_ITEMS` does: an
  // unrecognised kind makes the turn look active, which loses a detection rather
  // than putting a false accusation in a prompt.
  assert.equal(inspectedItems({ items: { message: 1, WebFetch: 1 }, tool: 1 }), 1);
});

// ---- what the critic is told ------------------------------------------------

const PROMPT = ['# the plan', [], [], 1, false, null] as const;

function critique(activity?: TurnActivity): string {
  return critiquePrompt(...PROMPT, undefined, undefined, activity);
}

test('a plan turn that opened nothing is named to the critic as a fact', () => {
  const said = critique(ANSWERED_ONLY);

  assert.match(said, /ran no commands and opened no files/);
  // A fact, not a verdict. The critic is told where to look first, not what to
  // conclude - "that a turn ran nothing is observable; that its conclusion about
  // `git diff --stat` is wrong is not".
  assert.match(said, /That is a fact about the turn, not a verdict on the plan/);
});

test('every other prompt is byte-identical to the one before this change', () => {
  // The acceptance criterion, asserted directly: a run whose planner looked at
  // something, and a run from before the tally existed, both get exactly the
  // prompt they always got.
  const baseline = critiquePrompt(...PROMPT);
  assert.equal(critique(undefined), baseline);
  assert.equal(critique(LOOKED), baseline);
  assert.equal(critique({ items: {}, tool: 0 }), baseline);
  assert.notEqual(critique(ANSWERED_ONLY), baseline);
});

// ---- through the loop -------------------------------------------------------

const RUN = { prefix: 'vibe-plan-activity-', task: 'plan turn activity' } as const;

/** Every critique prompt the run produced, in order. */
async function critiquePrompts(
  activity: (label: string) => TurnActivity | undefined,
  seed?: 'restored',
): Promise<string[]> {
  const state = freshRun({ ...RUN, planOnly: true, git: true, commit: true });
  if (seed === 'restored') state.plan = planFixture();
  const prompts: string[] = [];

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: () => planFixture(),
        codex: (label, options) => {
          if (label.startsWith('critique-')) prompts.push(options.prompt);
          return report([]);
        },
        activity,
      },
      [],
    ),
  );
  return prompts;
}

test('the loop tells the critic about the turn that wrote the plan it is critiquing', async () => {
  const prompts = await critiquePrompts((label) =>
    label === 'plan' ? ANSWERED_ONLY : undefined,
  );

  assert.equal(prompts.length, 1);
  assert.match(String(prompts[0]), /ran no commands and opened no files/);
});

test('a planner that looked leaves the critique prompt alone', async () => {
  const prompts = await critiquePrompts((label) => (label === 'plan' ? LOOKED : undefined));

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(String(prompts[0]), /ran no commands/);
});

test('a plan restored on a resume says nothing about a turn this process never ran', async () => {
  // Absent, not zero, and for the same reason: no plan turn ran here, so there
  // is nothing to report about one. Inventing "it opened nothing" from the
  // absence would be the fabrication this repo refuses.
  const prompts = await critiquePrompts(() => ANSWERED_ONLY, 'restored');

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(String(prompts[0]), /ran no commands/);
});

/**
 * The critic is the control, and it stays one.
 *
 * Moving both roles at once would make the next measurement unattributable, so
 * nothing about the critic changes here. The rule that it is exempt from the
 * inertness downgrade is pinned in `tests/inert-review.test.ts` ("the critic is
 * not held to the rule, even when its turn ran nothing") and that case is
 * untouched. What is asserted here is the other half: a critic that ran nothing
 * does not make the run say anything about the *planner*.
 */
test('the critic running nothing does not put a note about the planner in its prompt', async () => {
  const prompts = await critiquePrompts((label) =>
    label.startsWith('critique-') ? { items: { agent_message: 3 }, tool: 0 } : LOOKED,
  );

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(String(prompts[0]), /ran no commands/);
});
