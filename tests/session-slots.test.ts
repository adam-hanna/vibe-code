import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { rotateSession, shouldRotate, withConcurrentCompaction } from '@src/context.js';
import {
  ROLES,
  rotatingSlot,
  runTurn,
  slotForRole,
  slotHasMemory,
  slotId,
  slotRotatable,
  SLOTS,
  slotStarted,
} from '@src/orchestrator.js';
import type { AgentTurns, Role, RoleTable, TurnRequest } from '@src/orchestrator.js';
import { handoffContext } from '@src/prompts.js';
import { createRun, loadRun, recordContextMeasurement } from '@src/run.js';
import { ANSWERS_SCHEMA, FINDINGS_SCHEMA } from '@src/schemas.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { ClaudeTurnResult, Config, RunState, TokenUsage } from '@src/types.js';

/**
 * The slot lifecycle: an id, a separate marker for whether a turn has ever
 * succeeded on it, whether it currently carries memory, and what a failed first
 * turn leaves behind.
 *
 * Everything runs through injected fakes for the same reason the other seam
 * suites do: spawning `claude` or `codex` needs a logged-in account and costs
 * money per case. `codex.readRateLimits` is off so the rate-limit probe returns
 * before it would connect to an app-server.
 */

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-slots-')), 'slots', false);
}

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
    ...over,
  };
}

interface Recorder {
  turns: AgentTurns;
  claudeCalls: ClaudeTurnOptions[];
  codexCalls: CodexTurnOptions[];
}

/** Both providers, recording what each was asked for. */
function recorder(over: { codexSession?: string | null } = {}): Recorder {
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
          sessionId: over.codexSession === undefined ? 'thread-1' : over.codexSession,
          tokens: tokens(500),
        });
      },
    },
  };
}

/** A provider pair whose turns always fail, as a first turn can. */
function failing(): AgentTurns {
  return {
    claude: () => Promise.reject(new Error('the turn died')),
    codex: () => Promise.reject(new Error('the turn died')),
  };
}

function request(role: Role, over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    role,
    prompt: 'do the thing',
    cwd: process.cwd(),
    label: `${role}-0`,
    timeoutMs: 1_000,
    ...over,
  };
}

async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    return { result: await work(), lines };
  } finally {
    console.log = original;
  }
}

/**
 * Every role moved to the other provider.
 *
 * Copied rather than imported: a table another suite owns could be changed for
 * that suite's reasons, and these cases are about what this one asserts. Under
 * it the rotating role sits on Codex, so the conversation `rotateSession` would
 * compact is the provider-minted one - which has no rotation mechanism at all.
 */
const SWAPPED: RoleTable = {
  planner: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
  implementer: { provider: 'codex', access: 'write', schema: FINDINGS_SCHEMA },
  critic: { provider: 'claude', access: 'read-only' },
  answerer: { provider: 'claude', access: 'read-only' },
  reviewer: { provider: 'claude', access: 'read-only' },
};

/** A state whose measurement is over the threshold: `shouldRotate` is true under ROLES. */
function rotatableState(): RunState {
  const state = freshState();
  recordContextMeasurement(state, DEFAULTS.claude.model, 0.9, 200_000);
  state.sessionStarted = true;
  return state;
}

// ---- A failed first turn establishes nothing --------------------------------

test('a Claude slot whose first turn fails is not established on the next turn', async () => {
  const state = freshState();
  const cfg = config();

  await assert.rejects(() => captureLog(() => runTurn(state, cfg, request('planner'), failing())));

  // The id was minted before the turn was spawned, and says nothing.
  assert.notEqual(slotId(state, 'main'), null);
  assert.equal(slotStarted(state, 'main'), false);
  assert.equal(slotHasMemory(state, cfg, 'main'), false);

  const rec = recorder();
  await captureLog(() => runTurn(state, cfg, request('planner', { prompt: 'second' }), rec.turns));
  assert.equal(rec.claudeCalls[0]?.resume, false);
  assert.equal(rec.claudeCalls[0]?.prompt, handoffContext(null, null, false) + 'second');
});

test('a Codex slot whose first turn fails is not established on the next turn', async () => {
  const state = freshState();
  const cfg = config();

  await assert.rejects(() => captureLog(() => runTurn(state, cfg, request('critic'), failing())));

  assert.equal(state.codexSessionId, null);
  assert.equal(slotStarted(state, 'judge'), false);
  assert.equal(slotHasMemory(state, cfg, 'judge'), false);

  const rec = recorder();
  await captureLog(() => runTurn(state, cfg, request('reviewer'), rec.turns));
  assert.equal(rec.codexCalls[0]?.sessionId, null);
});

// ---- An id is not a marker --------------------------------------------------

test('a slot that has never run reports no memory', () => {
  const state = freshState();
  const cfg = config();

  // The Claude conversation has an id from the moment the run exists.
  assert.equal(typeof slotId(state, 'main'), 'string');
  assert.equal(slotStarted(state, 'main'), false);
  assert.equal(slotHasMemory(state, cfg, 'main'), false);

  assert.equal(slotId(state, 'judge'), null);
  assert.equal(slotStarted(state, 'judge'), false);
  assert.equal(slotHasMemory(state, cfg, 'judge'), false);
});

test('an explicit false marker outranks a present id', () => {
  const state = freshState();
  state.codexSessionId = 'thread-x';
  state.codexSessionStarted = false;

  assert.equal(slotStarted(state, 'judge'), false);
  assert.equal(slotHasMemory(state, config(), 'judge'), false);
});

test('an empty thread id is not an id', async () => {
  const state = freshState();
  const cfg = config();
  const rec = recorder({ codexSession: '' });

  const { lines } = await captureLog(() => runTurn(state, cfg, request('critic'), rec.turns));

  assert.equal(state.codexSessionId, null);
  assert.equal(slotId(state, 'judge'), null);
  assert.equal(slotHasMemory(state, cfg, 'judge'), false);
  assert.equal(
    lines.some((l) => l.includes('codex thread')),
    false,
    lines.join('\n'),
  );

  await captureLog(() => runTurn(state, cfg, request('reviewer'), rec.turns));
  assert.equal(rec.codexCalls[1]?.sessionId, null);
});

test('an empty id already in stored state is read as no id', () => {
  const state = freshState();
  state.codexSessionId = '';
  state.sessionId = '';

  assert.equal(slotId(state, 'judge'), null);
  assert.equal(slotHasMemory(state, config(), 'judge'), false);
  assert.equal(slotId(state, 'main'), null);
  assert.equal(slotHasMemory(state, config(), 'main'), false);
});

// ---- Stored state written before slots existed ------------------------------

/** A run directory holding exactly the fields a pre-slot version wrote. */
function legacyRun(over: Record<string, unknown>): RunState {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-legacy-'));
  const id = 'legacy-run';
  const dir = path.join(targetDir, '.vibe', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const stored = {
    id,
    dir,
    targetDir,
    task: 'legacy',
    sessionId: 'session-legacy',
    createdAt: new Date().toISOString(),
    status: 'planning',
    phase: 'planning',
    planRound: 0,
    reviewRound: 0,
    costUsd: 0,
    tokensUsed: 0,
    rateLimitWaits: 0,
    baseSha: null,
    branch: null,
    p1Rounds: [],
    verifyRounds: [],
    verifyRound: 0,
    questionRound: 0,
    events: [],
    planOnly: false,
    answeredQuestions: [],
    deferredQuestions: [],
    sessionRotations: 0,
    handoff: null,
    contextRatio: 0,
    plan: null,
    pendingAnswers: null,
    extraContext: null,
    ...over,
  };
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(stored, null, 2), 'utf8');
  return loadRun(targetDir, id);
}

test('a started run stored before this change still carries its conversations', async () => {
  // No `codexSessionStarted`: for a provider-minted id, the id is the evidence.
  const state = legacyRun({ sessionStarted: true, codexSessionId: 'thread-legacy' });
  const cfg = config();

  assert.equal(slotHasMemory(state, cfg, 'main'), true);
  assert.equal(slotHasMemory(state, cfg, 'judge'), true);

  const rec = recorder({ codexSession: 'thread-legacy' });
  await captureLog(() => runTurn(state, cfg, request('planner', { prompt: 'go on' }), rec.turns));
  assert.equal(rec.claudeCalls[0]?.resume, true);
  assert.equal(rec.claudeCalls[0]?.prompt, 'go on');
  assert.equal(rec.claudeCalls[0]?.sessionId, 'session-legacy');

  await captureLog(() => runTurn(state, cfg, request('critic'), rec.turns));
  assert.equal(rec.codexCalls[0]?.sessionId, 'thread-legacy');
});

test('an unstarted run stored before this change still starts fresh', async () => {
  const state = legacyRun({ sessionStarted: false, codexSessionId: null });
  const cfg = config();

  assert.equal(slotHasMemory(state, cfg, 'main'), false);
  assert.equal(slotHasMemory(state, cfg, 'judge'), false);

  const rec = recorder();
  await captureLog(() => runTurn(state, cfg, request('planner'), rec.turns));
  assert.equal(rec.claudeCalls[0]?.resume, false);

  await captureLog(() => runTurn(state, cfg, request('critic'), rec.turns));
  assert.equal(rec.codexCalls[0]?.sessionId, null);
});

// ---- The default table, decision for decision ------------------------------

test('the Claude slot resumes from its second turn onward, on one id', async () => {
  const state = freshState();
  const cfg = config();
  const rec = recorder();

  await captureLog(() => runTurn(state, cfg, request('planner', { prompt: 'first' }), rec.turns));
  await captureLog(() => runTurn(state, cfg, request('planner', { prompt: 'second' }), rec.turns));

  assert.equal(rec.claudeCalls[0]?.resume, false);
  assert.equal(rec.claudeCalls[1]?.resume, true);
  assert.equal(rec.claudeCalls[0]?.sessionId, rec.claudeCalls[1]?.sessionId);
  assert.equal(rec.claudeCalls[0]?.sessionId, slotId(state, 'main'));
});

test('the Codex thread is adopted from a successful turn and continued', async () => {
  const state = freshState();
  const cfg = config();
  const rec = recorder({ codexSession: 'thread-9' });

  await captureLog(() => runTurn(state, cfg, request('critic'), rec.turns));
  assert.equal(rec.codexCalls[0]?.sessionId, null);
  assert.equal(slotId(state, 'judge'), 'thread-9');

  // The answerer, not the reviewer: this case is about the judge slot adopting
  // an id and continuing it, and since #45 the reviewer holds a different
  // conversation. `judge-independence.test.ts` asserts the reviewer's side, and
  // that these two never resume one another.
  await captureLog(() => runTurn(state, cfg, request('answerer'), rec.turns));
  assert.equal(rec.codexCalls[1]?.sessionId, 'thread-9');
});

test('a run not carrying the thread records success without continuity', async () => {
  const state = freshState();
  const cfg = config({ codex: { ...DEFAULTS.codex, readRateLimits: false, persistSession: false } });
  const rec = recorder({ codexSession: 'thread-9' });

  await captureLog(() => runTurn(state, cfg, request('critic'), rec.turns));
  await captureLog(() => runTurn(state, cfg, request('reviewer'), rec.turns));

  assert.equal(rec.codexCalls[0]?.sessionId, null);
  assert.equal(rec.codexCalls[1]?.sessionId, null);
  assert.equal(state.codexSessionId, null);
  // Success and continuity are different facts: the turns did happen, and the
  // run still carries nothing forward from them.
  assert.equal(slotStarted(state, 'judge'), true);
  assert.equal(slotHasMemory(state, cfg, 'judge'), false);
});

// ---- Rotation --------------------------------------------------------------

test('a rotation leaves a fresh conversation nothing has run on', async () => {
  const state = rotatableState();
  const cfg = config({ context: { ...DEFAULTS.context, enabled: true } });
  const before = slotId(state, 'main');
  const rec = recorder();

  await captureLog(() => rotateSession(state, cfg, rec.turns.claude));

  assert.notEqual(slotId(state, 'main'), before);
  assert.equal(slotStarted(state, 'main'), false);
  assert.equal(state.sessionRotations, 1);

  const next = recorder();
  await captureLog(() => runTurn(state, cfg, request('planner'), next.turns));
  assert.equal(next.claudeCalls[0]?.resume, false);
  assert.equal(next.claudeCalls[0]?.sessionId, slotId(state, 'main'));
});

// ---- Compaction beside work --------------------------------------------------

test('compaction never rotates the conversation the concurrent work is using', async () => {
  // Under SWAPPED the critic talks through `main` and the rotating role sits on
  // `judge`. A provider comparison says these are different agents and lets the
  // rotation run - compacting the very conversation the critique is using.
  const state = rotatableState();
  const cfg = config({ context: { ...DEFAULTS.context, enabled: true } });
  const before = slotId(state, 'main');
  let rotations = 0;

  assert.equal(rotatingSlot(SWAPPED), 'judge');
  assert.equal(shouldRotate(state, cfg, SWAPPED), false);
  assert.equal(shouldRotate(state, cfg), true, 'the default table would rotate here');

  const result = await captureLog(() =>
    withConcurrentCompaction(
      state,
      cfg,
      () => Promise.resolve('critique'),
      () => {
        rotations += 1;
        return Promise.reject(new Error('the rotation turn must not be reached'));
      },
      'critic',
      SWAPPED,
    ),
  );

  assert.equal(result.result, 'critique');
  assert.equal(rotations, 0);
  assert.equal(state.sessionRotations, 0);
  assert.equal(slotId(state, 'main'), before);
});

test('a slot with no rotation mechanism is refused before a turn is spent', async () => {
  assert.equal(slotRotatable('judge'), false);
  assert.equal(SLOTS.judge.reset, null);

  const state = rotatableState();
  let calls = 0;

  await assert.rejects(
    () =>
      rotateSession(
        state,
        config({ context: { ...DEFAULTS.context, enabled: true } }),
        () => {
          calls += 1;
          return Promise.reject(new Error('unreachable'));
        },
        SWAPPED,
      ),
    /no rotation mechanism/,
  );
  assert.equal(calls, 0, 'nothing may be spent on a rotation that cannot happen');
  assert.equal(state.sessionRotations, 0);
});

// ---- The pairing, and the invariant that lets a slot be added by naming it ---

test('a role seated on a slot belonging to another provider is refused', async () => {
  const misSeated: RoleTable = {
    ...ROLES,
    critic: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA, slot: 'main' },
  };

  assert.throws(() => slotForRole('critic', misSeated), /but slot "main" is a claude conversation/);

  const rec = recorder();
  await assert.rejects(
    () => runTurn(freshState(), config(), request('critic'), rec.turns, misSeated),
    /but slot "main" is a claude conversation/,
  );
  assert.equal(rec.codexCalls.length, 0);
});

test('every role talks through a conversation held with its own provider', () => {
  for (const role of Object.keys(ROLES) as Role[]) {
    assert.equal(
      SLOTS[slotForRole(role)].provider,
      ROLES[role].provider,
      `${role} is seated on a slot of the wrong provider`,
    );
  }
});

test('only a conversation vibe names can be re-minted', () => {
  for (const [name, spec] of Object.entries(SLOTS)) {
    if (spec.reset !== null) {
      assert.equal(spec.origin, 'client', `${name} cannot re-mint an id it does not mint`);
    }
  }
});

// Retitled by #45: "one conversation per provider" stopped being what a table
// that names no slot means - the fallback is each role's default conversation,
// and the reviewer's is not the critic's. The assertions are unchanged, and the
// reviewer's own fallback is asserted in `judge-independence.test.ts`.
test('a table that names no slot falls back to each role default conversation', () => {
  const unnamed: RoleTable = {
    planner: { provider: 'claude', access: 'read-only' },
    implementer: { provider: 'claude', access: 'write' },
    critic: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
    answerer: { provider: 'codex', access: 'read-only', schema: ANSWERS_SCHEMA },
    reviewer: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
  };

  assert.equal(slotForRole('planner', unnamed), 'main');
  assert.equal(slotForRole('critic', unnamed), 'judge');
  assert.equal(rotatingSlot(unnamed), 'main');
});
