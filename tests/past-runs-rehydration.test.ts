import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { runTurn } from '@src/orchestrator.js';
import type { AgentTurns, TurnRequest } from '@src/orchestrator.js';
import { planPrompt } from '@src/prompts.js';
import { createRun } from '@src/run.js';
import type { ClaudeTurnResult, Config, Plan, RunState } from '@src/types.js';

/**
 * What survives a session rotation, and what must not be doubled by it (#52).
 *
 * `freshConversationPrefix` is everything a rehydrated generative session
 * starts from, and it has only ever carried the handoff and the plan of record
 * - never the plan prompt. So a planner that rotated between drafting and
 * revising would silently lose the past-run index it had been given, with
 * nothing in the run to say it had. The prefix now reattaches it, once.
 *
 * These cases drive `runTurn` with an injected Claude turn and read the prompt
 * it was handed, the way `rotation-accounting.test.ts` does. A freshly created
 * run has no started session, so `slotHasMemory` is false and the rehydration
 * path is the one taken.
 *
 * **This asserts injection, not exposure.** Under the default table the
 * implementer shares Claude's single `main` conversation with the planner and
 * inherits its history, this section included - that is pre-existing, true of
 * the whole plan prompt, and documented in README.md. Case three below says
 * the implementer is never *given* the section; it does not say the implementer
 * cannot see one.
 */

const HEADING = '## Past runs in this repository';

function config(): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
  };
}

/** A run with a real directory, and an archive of two prior runs beside it. */
function runWithArchive(task: string): RunState {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-rehydrate-'));
  const state = createRun(targetDir, task, false);
  for (const [id, what] of [
    ['20260101-000000-first-run', 'the first task'],
    ['20260202-000000-second-run', 'the second task'],
  ] as const) {
    const dir = path.join(targetDir, '.vibe', 'runs', id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ id, status: 'done', task: what, costUsd: 0 }),
      'utf8',
    );
  }
  return state;
}

function planFixture(): Plan {
  return {
    plan_md: '# the plan',
    assumptions: [],
    open_questions: [],
    out_of_scope: [],
    acceptance_criteria: [],
  };
}

function result(): ClaudeTurnResult {
  return {
    text: 'said so',
    costUsd: 0,
    sessionId: 'ignored',
    denials: [],
    numTurns: 1,
    usage: null,
    tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0, total: 1 },
  };
}

/** One dispatched turn, returning the prompt the agent was actually handed. */
async function promptFor(state: RunState, req: TurnRequest): Promise<string> {
  let seen = '';
  const turns: AgentTurns = {
    claude: (options) => {
      seen = options.prompt;
      return Promise.resolve(result());
    },
    codex: () => Promise.reject(new Error('no Codex turn belongs in this case')),
  };
  const original = console.log;
  console.log = (): void => {};
  try {
    await runTurn(state, config(), req, turns);
  } finally {
    console.log = original;
  }
  return seen;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('a rehydrated planner is given the index back, exactly once', async () => {
  const state = runWithArchive('rehydrated planner');
  state.plan = planFixture();

  const prompt = await promptFor(state, {
    role: 'planner',
    prompt: 'revise the plan',
    cwd: state.targetDir,
    label: 'plan-revise',
    timeoutMs: 1000,
  });

  assert.equal(occurrences(prompt, HEADING), 1);
  assert.ok(prompt.includes('20260202-000000-second-run'));
  // Its own run is not in its own index, on this path either.
  assert.equal(prompt.includes(state.id), false);
});

test('a memoryless first plan turn carries the index once, not twice', async () => {
  const state = runWithArchive('first plan turn');
  // The discriminator: `runPlan` dispatches the plan turn while `state.plan` is
  // still null, so the prefix must add nothing to a prompt that already has it.
  assert.equal(state.plan, null);

  const prompt = await promptFor(state, {
    role: 'planner',
    prompt: planPrompt(state.task, null, null, undefined, [
      { id: '20260202-000000-second-run', status: 'done', task: 'the second task', costUsd: 0 },
    ]),
    cwd: state.targetDir,
    label: 'plan',
    timeoutMs: 1000,
  });

  assert.equal(occurrences(prompt, HEADING), 1);
});

test('a rehydrated implementer is not given the index', async () => {
  const state = runWithArchive('rehydrated implementer');
  state.plan = planFixture();

  const prompt = await promptFor(state, {
    role: 'implementer',
    prompt: 'implement the plan',
    cwd: state.targetDir,
    label: 'implement',
    timeoutMs: 1000,
  });

  // The plan of record still travels with a rotated implementer; the archive
  // does not. Injection is the planner's alone.
  assert.ok(prompt.includes('# the plan'));
  assert.equal(occurrences(prompt, HEADING), 0);
});

test('a planner whose session already remembers gets no prefix and no index', async () => {
  const state = runWithArchive('continuing planner');
  state.plan = planFixture();

  const req: TurnRequest = {
    role: 'planner',
    prompt: 'revise the plan',
    cwd: state.targetDir,
    label: 'plan-revise',
    timeoutMs: 1000,
  };
  await promptFor(state, req);
  // The first turn marked the slot started, so the second resumes it.
  const second = await promptFor(state, req);

  assert.equal(second, 'revise the plan');
  assert.equal(occurrences(second, HEADING), 0);
});
