import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig } from '@src/config.js';
import * as log from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import {
  answerPrompt,
  clearPromptOverrides,
  critiquePrompt,
  environmentBlock,
  fixPrompt,
  implementPrompt,
  installPromptOverrides,
  planPrompt,
  promptBlocks,
  reviewPrompt,
  revisePlanPrompt,
} from '@src/prompts.js';
import type { EnvironmentFacts } from '@src/runtime.js';
import type { Config, RunState } from '@src/types.js';
import {
  agents,
  BLOCKING,
  codexRaw,
  committing,
  config,
  freshRun,
  p1,
  planFixture,
  report,
  reviewingRun,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import { CRITERIA, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';

/**
 * What a writer is told about the gates and the tests (#483).
 *
 * The implement prompt asked for "the project's existing build, lint, and test
 * commands" and never named them. `environmentBlock` named the gates vibe will
 * run, but only for the planner and the judging seats, so a Codex implementer
 * (a fresh `codex exec` on `SLOTS.write`) or a rotated Claude session wrote the
 * change without knowing what would judge it. And no writer prompt said
 * anything about editing a test to make a gate pass, which is the cheat
 * ImpossibleBench measured most often.
 */

const FACTS: EnvironmentFacts = {
  agents: [
    {
      provider: 'claude',
      shell: 'bash',
      pathStyle: 'posix',
      repaired: false,
      tools: [{ name: 'node', available: true, version: 'v22.1.0' }],
    },
    {
      provider: 'codex',
      shell: 'bash',
      pathStyle: 'posix',
      repaired: false,
      tools: [{ name: 'node', available: true, version: 'v22.1.0' }],
    },
  ],
  verifyCommand: 'npm run typecheck',
  verifyRuns: 1,
  verifyGates: [
    { name: 'typecheck', command: 'npm run typecheck', runs: 1 },
    { name: 'test', command: 'npm test', runs: 3 },
    { name: 'qa', command: null, runs: 1 },
  ],
};

const GATE_LINES = [
  '- `typecheck`: `npm run typecheck`, 1 consecutive time(s)',
  '- `test`: `npm test`, 3 consecutive time(s)',
  '- `qa`: no command configured; this gate will not run',
] as const;

const RUN_THEM =
  'Before you finish, run each command listed exactly as written, as many consecutive times as it says, and fix what fails.';
const REVIEWER_CAUTION = 'A tool you cannot run yourself is not evidence';
const PLANNER_CAUTION = 'Plan against these.';

const TESTS_TEXT = `## Existing tests

Do not edit, delete, skip or loosen an existing test, or \`vibe.config.json\`, to
make a gate pass. Change a test only where its claim is no longer the contract
because the plan moves the behaviour it pins, and \`vibe.config.json\` only where
the plan calls for it. If a test or an acceptance criterion looks wrong, leave it
as it is and say so in your report, with the evidence.`;

const ANCHOR = 'Do not commit - the orchestrator handles git.';
const PLAN = planFixture({ plan_md: PLAN_MD, out_of_scope: [...OUT_OF_SCOPE] });

/** The four writer renderings, with and without the facts. */
function writers(env: EnvironmentFacts | null | undefined): Record<string, string> {
  return {
    implement: implementPrompt(PLAN_MD, [], [], CRITERIA, OUT_OF_SCOPE, [], env),
    'verify-fix': fixPrompt(BLOCKING, 1, CRITERIA, PLAN, false, env),
    fix: fixPrompt(BLOCKING, 1, CRITERIA, PLAN, true, env),
    'final-fix': fixPrompt(BLOCKING, 2, CRITERIA, PLAN, true, env),
  };
}

function assertNamesGates(prompt: string, what: string): void {
  for (const line of GATE_LINES) assert.ok(prompt.includes(line), `${what} names ${line}`);
  assert.ok(prompt.includes(RUN_THEM), `${what} is told to run them as vibe will`);
  assert.ok(!prompt.includes(REVIEWER_CAUTION), `${what} is not given the reviewer's caution`);
  assert.ok(!prompt.includes(PLANNER_CAUTION), `${what} is not given the planner's line`);
}

// ---- the block, for each audience --------------------------------------------

test('the block is the text this issue settled on, and is what `existing tests` renders', () => {
  const block = promptBlocks().find((b) => b.name === 'existing tests');
  assert.ok(block !== undefined, 'the block is registered');
  assert.equal(block.fallback, TESTS_TEXT);
  assert.deepEqual(block.usedBy, ['implementer']);
});

test("the writer's environment block is the planner's facts with the writer's closing line", () => {
  const planner = environmentBlock(FACTS, 'planner');
  const writer = environmentBlock(FACTS, 'implementer');
  const plannerLine = '\n\nPlan against these. Do not add steps to install or locate a tool listed as available.';
  const writerLine = `\n\nWork against these. ${RUN_THEM} Do not add steps to install or locate a tool listed as available.`;
  assert.equal(planner.split(plannerLine).length, 2, 'the planner line is there once');
  // Every fact is the same bytes; only the closing instruction differs.
  assert.equal(writer, planner.replace(plannerLine, writerLine));
});

test('with nothing to run, the writer is not told to run "these"', () => {
  const none = environmentBlock({ ...FACTS, verifyCommand: null, verifyGates: undefined }, 'implementer');
  assert.match(none, /No verification command is configured/);
  assert.ok(!none.includes(RUN_THEM));
  assert.ok(none.includes('Work against these. Do not add steps to install'));

  const unrunnable = environmentBlock(
    { ...FACTS, verifyGates: [{ name: 'qa', command: null, runs: 1 }] },
    'implementer',
  );
  assert.ok(!unrunnable.includes(RUN_THEM), 'a gate list with no command has nothing to run');

  // A record from before #47: one command, no list, and it is runnable.
  const legacy = environmentBlock({ ...FACTS, verifyGates: undefined, verifyRuns: 3 }, 'implementer');
  assert.match(legacy, /vibe will run `npm run typecheck` itself - not an agent - and it must pass 3 consecutive times/);
  assert.ok(legacy.includes(RUN_THEM));
});

// ---- the prompts -------------------------------------------------------------

test('every writer prompt names the configured gate commands and their run counts', () => {
  for (const [turn, prompt] of Object.entries(writers(FACTS))) assertNamesGates(prompt, turn);
});

test('with no environment the writer prompts render no block, and with one they differ by exactly it', () => {
  const block = environmentBlock(FACTS, 'implementer');
  const bare = writers(undefined);
  for (const env of [null, { ...FACTS, agents: [] }]) {
    assert.deepEqual(writers(env), bare, 'an absent or empty environment renders nothing');
  }
  const withEnv = writers(FACTS);
  for (const [turn, prompt] of Object.entries(bare)) {
    assert.ok(!prompt.includes('## Verified environment'), `${turn} has no environment section`);
    // The block lands immediately before `existing tests`, and nothing else moves.
    assert.equal(prompt.split(TESTS_TEXT).length, 2, `${turn} carries the tests block once`);
    assert.equal(withEnv[turn], prompt.replace(TESTS_TEXT, `${block}${TESTS_TEXT}`), turn);
  }
});

test('the tests block sits in every writer prompt immediately before "Do not commit"', () => {
  for (const [turn, prompt] of Object.entries(writers(undefined))) {
    const at = prompt.indexOf(`${TESTS_TEXT}\n\n${ANCHOR}`);
    assert.ok(at !== -1, `${turn} carries the block before the commit line`);
    assert.equal(prompt.split(ANCHOR).length, 2, `${turn} has one commit line`);
  }
});

test('no read-only seat is given the tests block or the writer environment line', () => {
  const readOnly: Record<string, string> = {
    plan: planPrompt('a task', null, FACTS),
    critique: critiquePrompt(PLAN_MD, [], [], 0, false, FACTS),
    answer: answerPrompt([], PLAN_MD),
    revise: revisePlanPrompt({
      planMd: PLAN_MD,
      outOfScope: OUT_OF_SCOPE,
      acceptanceCriteria: CRITERIA,
      findings: BLOCKING,
      round: 1,
    }),
    review: reviewPrompt('diff', [], PLAN_MD, [], 0, false, FACTS),
  };
  for (const [turn, prompt] of Object.entries(readOnly)) {
    assert.ok(!prompt.includes('## Existing tests'), `${turn} has no tests block`);
    assert.ok(!prompt.includes('Do not edit, delete, skip or loosen'), `${turn} has no tests sentence`);
    assert.ok(!prompt.includes(RUN_THEM), `${turn} is not told to run the gates as a writer`);
  }
});

test('a `prompts` override of `existing tests` replaces it in every writer prompt', () => {
  installPromptOverrides({ 'existing tests': 'TESTS ARE MINE TO CHANGE ONLY WITH A REASON.' });
  try {
    for (const [turn, prompt] of Object.entries(writers(FACTS))) {
      assert.ok(prompt.includes('TESTS ARE MINE TO CHANGE ONLY WITH A REASON.'), turn);
      assert.ok(!prompt.includes('Do not edit, delete, skip or loosen'), turn);
      // The environment block is not part of the override.
      assertNamesGates(prompt, turn);
    }
  } finally {
    clearPromptOverrides();
  }
});

test('`existing tests` is a name `vibe.config.json` accepts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-writer-gates-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ prompts: { 'existing tests': 'mine' } }), 'utf8');
  assert.equal(loadConfig(dir).prompts['existing tests'], 'mine');
});

// ---- through the loop --------------------------------------------------------

const WRITER = /^(implement|verify-fix-\d+|fix-\d+|final-fix-\d+)$/;

/** Each turn's prompt by label, and which provider was handed it. */
const providerOf = new WeakMap<Map<string, string>, Map<string, 'claude' | 'codex'>>();

async function capture(state: RunState, cfg: Config, resume: boolean, handlers: Handlers): Promise<Map<string, string>> {
  const prompts = new Map<string, string>();
  const providers = new Map<string, 'claude' | 'codex'>();
  providerOf.set(prompts, providers);
  const calls: string[] = [];
  const wrapped: Handlers = {
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      providers.set(label, 'claude');
      return handlers.claude?.(label, options);
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      providers.set(label, 'codex');
      return handlers.codex?.(label, options) ?? report([]);
    },
  };
  const realLog = console.log;
  const realError = console.error;
  log.setSink(() => undefined);
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, resume, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return prompts;
}

function assertSeats(prompts: Map<string, string>, writersExpected: readonly string[]): void {
  for (const label of writersExpected) {
    const prompt = prompts.get(label);
    assert.ok(prompt !== undefined, `${label} ran (saw ${[...prompts.keys()].join(', ')})`);
    assertNamesGates(prompt, label);
    assert.ok(prompt.includes(TESTS_TEXT), `${label} carries the tests block`);
  }
  for (const [label, prompt] of prompts) {
    if (WRITER.test(label)) continue;
    assert.ok(!prompt.includes('## Existing tests'), `${label} is read-only and has no tests block`);
    assert.ok(!prompt.includes(RUN_THEM), `${label} is read-only and is not told to run the gates`);
  }
}

/** Plan, approve, implement, fail the gate once, review with two P1s, fix, approve. */
async function loop(cfgOver: Partial<Config>, codexWrites: boolean): Promise<Map<string, string>> {
  const state = freshRun({ prefix: 'vibe-writer-gates-', task: 'writer gates', planOnly: false, git: true, commit: true });
  state.environment = FACTS;
  const writer = (label: string): unknown => {
    work(state, `${label}.txt`);
    return codexWrites ? codexRaw(`${label} done`) : `${label} done`;
  };
  return capture(
    state,
    config({ p1Tolerance: 0, maxReviewRounds: 3, maxVerifyRounds: 3 }, { ...committing(), ...verifying(state, { failures: 1 }), ...cfgOver }),
    false,
    {
      claude: (label) => (label === 'plan' || label.startsWith('revise-') ? planFixture() : writer(label)),
      codex: (label) => {
        if (WRITER.test(label)) return writer(label);
        return label === 'review-0' ? report([p1('finding-one'), p1('finding-two')]) : report([]);
      },
    },
  );
}

test('through the loop, the implement, verify-fix and fix turns name the gates, and no read-only turn does', async () => {
  const prompts = await loop({}, false);
  assertSeats(prompts, ['implement', 'verify-fix-1', 'fix-1']);
  for (const label of ['implement', 'verify-fix-1', 'fix-1']) assert.equal(providerOf.get(prompts)?.get(label), 'claude', label);
});

test('a Codex implementer, a fresh exec with no planner history, is given the block on every writer turn', async () => {
  const prompts = await loop({ roles: { ...DEFAULTS.roles, implementer: 'codex' } }, true);
  assertSeats(prompts, ['implement', 'verify-fix-1', 'fix-1']);
  // Seated on Codex, so the prompt is all it has: no planner history to inherit.
  for (const label of ['implement', 'verify-fix-1', 'fix-1']) assert.equal(providerOf.get(prompts)?.get(label), 'codex', label);
});

test('the final fix turn names the gates too', async () => {
  const state = reviewingRun({ prefix: 'vibe-writer-gates-final-', task: 'writer gates final', commit: true });
  state.environment = FACTS;
  let reviewed = 0;
  const prompts = await capture(state, config({}, { ...committing(), ...verifying(state) }), true, {
    claude: (label) => work(state, `${label}.txt`),
    codex: () => {
      reviewed += 1;
      return report(reviewed === 1 ? [p1('tolerated-one')] : []);
    },
  });
  assertSeats(prompts, ['final-fix-1']);
});
