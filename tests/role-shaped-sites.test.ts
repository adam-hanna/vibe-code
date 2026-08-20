import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { withConcurrentCompaction } from '@src/context.js';
import {
  codexProbeSandbox,
  providersForRoles,
  roleEnabled,
  ROLES,
  ROTATING_ROLE,
  rotatesConcurrentlyWith,
  runTurn,
  turnTimeoutMs,
} from '@src/orchestrator.js';
import type { AgentTurns, Role, RoleTable, TurnRequest } from '@src/orchestrator.js';
import { environmentBlock } from '@src/prompts.js';
import { createRun, recordContextMeasurement } from '@src/run.js';
import type { EnvironmentFacts } from '@src/runtime.js';
import { ANSWERS_SCHEMA, FINDINGS_SCHEMA } from '@src/schemas.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { ClaudeTurnResult, Config, RunState, Sandbox, TokenUsage } from '@src/types.js';

/**
 * Six sites that used to read a provider's name to decide what an agent does.
 *
 * Each case points a fake role table at the other provider and asserts the site
 * follows the table. That is the whole property: no config surface exists, and
 * none of these tables can be reached by a user - `ROLES` is a constant, and the
 * table parameters are the same compile-time seam `runTurn` already has for its
 * providers. Under `ROLES` every one of these sites must produce exactly what it
 * produced before, which the "unchanged" halves of these cases pin.
 *
 * Nothing is spawned: turns are injected fakes and `codex.readRateLimits` is off.
 */

/** Every role on the other provider. Used for routing and labelling. */
const SWAPPED: RoleTable = {
  planner: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
  implementer: { provider: 'codex', access: 'write', schema: FINDINGS_SCHEMA },
  critic: { provider: 'claude', access: 'read-only' },
  answerer: { provider: 'claude', access: 'read-only' },
  reviewer: { provider: 'claude', access: 'read-only' },
};

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
    ...over,
  };
}

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-roles-')), 'role-shaped', false);
}

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

interface Recorder {
  turns: AgentTurns;
  claudeCalls: ClaudeTurnOptions[];
  codexCalls: CodexTurnOptions[];
}

function recorder(): Recorder {
  const claudeCalls: ClaudeTurnOptions[] = [];
  const codexCalls: CodexTurnOptions[] = [];
  return {
    claudeCalls,
    codexCalls,
    turns: {
      claude: (options): Promise<ClaudeTurnResult> => {
        claudeCalls.push(options);
        return Promise.resolve({
          text: 'claude said so',
          costUsd: 0.02,
          sessionId: options.sessionId,
          denials: [],
          numTurns: 1,
          usage: null,
          tokens: tokens(1000),
        });
      },
      codex: (options) => {
        codexCalls.push(options);
        return Promise.resolve({
          structured: { findings: [] },
          raw: '{"findings":[]}',
          sessionId: 'thread-1',
          tokens: tokens(500),
        });
      },
    },
  };
}

function request(role: Role, over: Partial<TurnRequest> = {}): TurnRequest {
  return { role, prompt: 'do the thing', cwd: process.cwd(), label: `${role}-0`, ...over };
}

async function captureLog<T>(work: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (): void => {};
  try {
    return await work();
  } finally {
    console.log = original;
  }
}

// ---- 1. The environment block ----------------------------------------------

const FACTS: EnvironmentFacts = {
  agents: [
    {
      provider: 'claude',
      shell: 'bash',
      pathStyle: 'msys',
      repaired: false,
      tools: [{ name: 'node', available: true, version: 'v24.18.0' }],
    },
    {
      provider: 'codex',
      shell: 'powershell',
      pathStyle: 'win32',
      repaired: true,
      tools: [{ name: 'git', available: true, version: 'git version 2.31.1' }],
    },
  ],
  verifyCommand: 'npm test',
  verifyRuns: 3,
};

test('the environment block reads today byte for byte, role labels included', () => {
  assert.equal(
    environmentBlock(FACTS, 'reviewer'),
    `## Verified environment

vibe established the following by executing each tool inside each agent's own shell before this run began. These are observations, not assumptions.

- **claude** (the implementer): bash, msys paths - node v24.18.0
- **codex** (the reviewer): powershell, win32 paths - git version 2.31.1 [PATH repaired by vibe for this run]

Verification: vibe will run \`npm test\` itself - not an agent - and it must pass 3 consecutive times before the change is accepted.

Your own shell is sandboxed and deliberately more restricted than the implementer's. **A tool you cannot run yourself is not evidence that the implementer cannot run it.** Do not raise findings about tool availability, runtime provisioning, or PATH - they are settled above, and a plan relying on a tool listed as available to the implementer is correct to do so.

`,
  );
});

test('each agent is described by its role from the table, not by its provider', () => {
  const swapped = environmentBlock(FACTS, 'reviewer', SWAPPED);

  assert.match(swapped, /- \*\*claude\*\* \(the reviewer\)/);
  assert.match(swapped, /- \*\*codex\*\* \(the implementer\)/);
  // And the planner audience follows the same table.
  assert.match(environmentBlock(FACTS, 'planner', SWAPPED), /- \*\*codex\*\* \(the implementer\)/);
});

test('an agent the table gives no role is described without one, not by its provider name', () => {
  const noClaude: RoleTable = {
    ...SWAPPED,
    critic: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
    answerer: { provider: 'codex', access: 'read-only', schema: ANSWERS_SCHEMA },
    reviewer: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
  };

  assert.match(environmentBlock(FACTS, 'reviewer', noClaude), /- \*\*claude\*\*: bash/);
});

// ---- 2. Concurrent compaction ----------------------------------------------

/** A measured session over the threshold: `shouldRotate` is true. */
function rotatableState(): RunState {
  const state = createRun(mkdtempSync(path.join(tmpdir(), 'vibe-roles-')), 'compaction', false);
  recordContextMeasurement(state, 'opus', 0.6, 200_000);
  state.sessionStarted = true;
  return state;
}

function handoff(): Promise<ClaudeTurnResult> {
  return Promise.resolve({
    text: 'briefing',
    costUsd: 0.01,
    sessionId: 'ignored',
    denials: [],
    numTurns: 1,
    usage: null,
    tokens: tokens(12_000),
  });
}

test('compaction runs beside work done by an agent that is not the one being rotated', async () => {
  const state = rotatableState();
  let rotations = 0;

  const result = await captureLog(() =>
    withConcurrentCompaction(
      state,
      config({ context: DEFAULTS.context }),
      () => Promise.resolve('critique'),
      () => {
        rotations += 1;
        return handoff();
      },
      'critic',
    ),
  );

  assert.equal(result, 'critique');
  assert.equal(rotations, 1);
  assert.equal(state.sessionRotations, 1);
});

test('compaction does not rotate the session of the agent doing the concurrent work', async () => {
  // The critic and the rotating role share a provider here, so rotating while
  // the critique runs would be compacting the very session it is talking on.
  // Deliberately not the fully swapped table: that moves the critic *and* the
  // implementer together, which leaves the two on different providers again.
  const sameAgent: RoleTable = {
    ...ROLES,
    critic: { provider: 'claude', access: 'read-only' },
  };
  const state = rotatableState();
  let rotations = 0;

  const result = await captureLog(() =>
    withConcurrentCompaction(
      state,
      config({ context: DEFAULTS.context }),
      () => Promise.resolve('critique'),
      () => {
        rotations += 1;
        return handoff();
      },
      'critic',
      sameAgent,
    ),
  );

  assert.equal(result, 'critique');
  assert.equal(rotations, 0);
  assert.equal(state.sessionRotations, 0);
});

test('the rotation rule is about who is being interrupted, not about a provider', () => {
  assert.equal(ROTATING_ROLE, 'implementer');
  // Today: Codex critiques and reviews, Claude's session is the one rotated.
  assert.equal(rotatesConcurrentlyWith('critic'), true);
  assert.equal(rotatesConcurrentlyWith('reviewer'), true);
  assert.equal(rotatesConcurrentlyWith('planner'), false);
  assert.equal(rotatesConcurrentlyWith('implementer'), false);
});

// ---- 3. The answerer gate --------------------------------------------------

test('the answerer gate follows the role, and no other role is gated by it', () => {
  const on = config();
  const off = config({ questions: { ...DEFAULTS.questions, askCodex: false } });

  assert.equal(roleEnabled('answerer', on), true);
  assert.equal(roleEnabled('answerer', off), false);
  for (const role of ['planner', 'implementer', 'critic', 'reviewer'] as const) {
    assert.equal(roleEnabled(role, off), true, `${role} is not gated by questions.askCodex`);
  }
});

test('the answering turn is taken by whoever holds the answerer role', async () => {
  const today = recorder();
  await captureLog(() => runTurn(freshState(), config(), request('answerer'), today.turns));
  assert.equal(today.codexCalls.length, 1);
  assert.equal(today.claudeCalls.length, 0);

  const swapped = recorder();
  await captureLog(() =>
    runTurn(freshState(), config(), request('answerer'), swapped.turns, SWAPPED),
  );
  assert.equal(swapped.claudeCalls.length, 1);
  assert.equal(swapped.codexCalls.length, 0);
});

// ---- 4. What preflight probes ----------------------------------------------

test('the probed sandbox is what a Codex turn is spawned with, unchanged for every setting today', () => {
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    const cfg = config({ codex: { ...DEFAULTS.codex, readRateLimits: false, sandbox } });
    assert.equal(codexProbeSandbox(cfg), sandbox satisfies Sandbox);
  }
});

test('a writing Codex role is probed for what it would actually be given', () => {
  const cfg = config({ codex: { ...DEFAULTS.codex, readRateLimits: false, sandbox: 'read-only' } });

  // The raw config key says read-only; the turn this table describes is spawned
  // with workspace-write, and that is what preflight has to probe under.
  assert.equal(codexProbeSandbox(cfg, SWAPPED), 'workspace-write');
});

test('the probe is never widened past what a turn is spawned with', () => {
  // Every Codex role here writes, so every Codex turn is spawned with
  // `workspace-write` however wide `codex.sandbox` reads. Probing under
  // danger-full-access would clear tools the run then cannot execute.
  const writingOnly: RoleTable = {
    planner: { provider: 'claude', access: 'read-only' },
    implementer: { provider: 'codex', access: 'write', schema: FINDINGS_SCHEMA },
    critic: { provider: 'claude', access: 'read-only' },
    answerer: { provider: 'claude', access: 'read-only' },
    reviewer: { provider: 'claude', access: 'read-only' },
  };

  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    const cfg = config({ codex: { ...DEFAULTS.codex, readRateLimits: false, sandbox } });
    assert.equal(codexProbeSandbox(cfg, writingOnly), 'workspace-write', `under ${sandbox}`);
  }
});

test('a table with no Codex role falls back to what a read-only turn would get', () => {
  const noCodex: RoleTable = {
    planner: { provider: 'claude', access: 'read-only' },
    implementer: { provider: 'claude', access: 'write' },
    critic: { provider: 'claude', access: 'read-only' },
    answerer: { provider: 'claude', access: 'read-only' },
    reviewer: { provider: 'claude', access: 'read-only' },
  };

  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    const cfg = config({ codex: { ...DEFAULTS.codex, readRateLimits: false, sandbox } });
    assert.equal(codexProbeSandbox(cfg, noCodex), sandbox);
  }
});

// ---- 5. The toolchain contract ---------------------------------------------

test('the toolchain contract follows the role that needs the tool', () => {
  assert.deepEqual(providersForRoles(['implementer']), ['claude']);
  assert.deepEqual(providersForRoles(['implementer'], SWAPPED), ['codex']);
  assert.deepEqual(providersForRoles(['implementer', 'reviewer']), ['claude', 'codex']);

  assert.deepEqual(DEFAULTS.toolchain['node']?.agents, ['claude']);
  assert.deepEqual(DEFAULTS.toolchain['npm']?.agents, ['claude']);
});

// ---- 6. Timeouts -----------------------------------------------------------

/** What each role's turn was given before the selection became role-aware. */
const TODAY: Readonly<Record<Role, number>> = {
  planner: 30 * 60 * 1000,
  implementer: 90 * 60 * 1000,
  critic: 45 * 60 * 1000,
  answerer: 45 * 60 * 1000,
  reviewer: 45 * 60 * 1000,
};

test('every timeout selected under the default table is identical to today\'s', () => {
  for (const [role, expected] of Object.entries(TODAY) as [Role, number][]) {
    assert.equal(turnTimeoutMs(role, DEFAULTS), expected, `${role} keeps its timeout`);
  }
});

test('timeout selection follows the role, not the provider', () => {
  // Implementing gets the long turn once the implementer is Codex: `codex` now
  // has the same pair of keys Claude has, so the limitation this pinned is gone.
  assert.equal(turnTimeoutMs('implementer', DEFAULTS, SWAPPED), DEFAULTS.codex.implementTimeoutMs);
  // And a reviewing Claude gets the reading figure, not the implementing one.
  assert.equal(turnTimeoutMs('reviewer', DEFAULTS, SWAPPED), DEFAULTS.claude.planTimeoutMs);
});

test('a dispatched turn is given its role\'s timeout, and an explicit one still wins', async () => {
  for (const role of ['planner', 'implementer'] as const) {
    const rec = recorder();
    await captureLog(() => runTurn(freshState(), config(), request(role), rec.turns));
    assert.equal(rec.claudeCalls[0]?.timeoutMs, TODAY[role], `${role} timeout`);
  }

  for (const role of ['critic', 'answerer', 'reviewer'] as const) {
    const rec = recorder();
    await captureLog(() => runTurn(freshState(), config(), request(role), rec.turns));
    assert.equal(rec.codexCalls[0]?.timeoutMs, TODAY[role], `${role} timeout`);
  }

  const explicit = recorder();
  await captureLog(() =>
    runTurn(freshState(), config(), request('implementer', { timeoutMs: 1_234 }), explicit.turns),
  );
  assert.equal(explicit.claudeCalls[0]?.timeoutMs, 1_234);
});
