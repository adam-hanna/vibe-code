import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { rotateSession } from '@src/context.js';
import {
  applyCharge,
  claudePermission,
  codexSandbox,
  Escalation,
  EXIT,
  runTurn,
} from '@src/orchestrator.js';
import type { AgentTurns, Role, TurnRequest } from '@src/orchestrator.js';
import { handoffContext } from '@src/prompts.js';
import { createRun, recordContextMeasurement } from '@src/run.js';
import { ANSWERS_SCHEMA, FINDINGS_SCHEMA } from '@src/schemas.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { ClaudeTurnResult, Config, RunState, TokenUsage, TurnActivity } from '@src/types.js';

/**
 * The role-aware seam, driven through injected fakes.
 *
 * Nothing is spawned: `runTurn` takes its providers as an argument, and
 * `codex.readRateLimits` is off so the rate-limit probe returns before it would
 * connect to an app-server. Spawning `claude` or `codex` needs a logged-in
 * account and costs money per case.
 */

const CLAUDE_ROLES: readonly Role[] = ['planner', 'implementer'];
const CODEX_ROLES: readonly Role[] = ['critic', 'answerer', 'reviewer'];

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-seam-')), 'seam', false);
}

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    // No app-server: `read()` returns null before it connects, so the Codex
    // rate-limit probe is a no-op and no child is ever spawned.
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

/**
 * Both providers, each recording what it was asked for.
 *
 * `claudeCost` and `codexTokens` are the only knobs: every case here is about
 * where a turn was routed and what the run recorded about it, not about what
 * the agents said.
 */
function recorder(
  over: {
    claudeCost?: number;
    codexTokens?: number;
    codexSession?: string;
    /** What the turn's heartbeat observed, or absent for a turn nothing measured (#66). */
    activity?: TurnActivity;
  } = {},
): Recorder {
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
          costUsd: over.claudeCost ?? 0.02,
          sessionId: options.sessionId,
          denials: [],
          numTurns: 1,
          usage: null,
          tokens: tokens(1000),
          ...(over.activity === undefined ? {} : { activity: over.activity }),
        });
      },
      codex: (options) => {
        codexCalls.push(options);
        return Promise.resolve({
          structured: { findings: [] },
          raw: '{"findings":[]}',
          sessionId: over.codexSession ?? 'thread-1',
          tokens: tokens(over.codexTokens ?? 500),
          ...(over.activity === undefined ? {} : { activity: over.activity }),
        });
      },
    },
  };
}

/** A provider that must not be reached; reaching it fails the case loudly. */
function forbidden(): AgentTurns {
  return {
    claude: () => Promise.reject(new Error('claude was dispatched to and should not have been')),
    codex: () => Promise.reject(new Error('codex was dispatched to and should not have been')),
  };
}

function request(role: Role, over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    role,
    prompt: 'do the thing',
    cwd: process.cwd(),
    label: 'fixture-0',
    timeoutMs: 1_000,
    ...over,
  };
}

/** Captures whatever the turn logged, in order. */
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

// ---- Routing ---------------------------------------------------------------

test('every role dispatches to the provider ROLES names, and to no other', async () => {
  for (const role of CLAUDE_ROLES) {
    const rec = recorder();
    // The other provider is a rejecting fake, so a mis-route cannot pass quietly.
    await runTurn(freshState(), config(), request(role), { ...forbidden(), claude: rec.turns.claude });
    assert.equal(rec.claudeCalls.length, 1, `${role} should reach claude`);
  }

  for (const role of CODEX_ROLES) {
    const rec = recorder();
    await runTurn(freshState(), config(), request(role), { ...forbidden(), codex: rec.turns.codex });
    assert.equal(rec.codexCalls.length, 1, `${role} should reach codex`);
  }
});

// ---- The one write-versus-read-only expression -----------------------------

test('access translates to a permission mode for Claude and a sandbox for Codex', () => {
  assert.equal(claudePermission('read-only'), 'plan');
  assert.equal(claudePermission('write'), 'bypassPermissions');

  const cfg = config();
  assert.equal(codexSandbox('read-only', cfg), cfg.codex.sandbox);
  assert.equal(codexSandbox('write', cfg), 'workspace-write');
});

test('a planning turn is read-only and an implementation turn may write', async () => {
  const planner = recorder();
  await runTurn(freshState(), config(), request('planner'), planner.turns);
  assert.equal(planner.claudeCalls[0]?.permissionMode, 'plan');

  const implementer = recorder();
  await runTurn(freshState(), config(), request('implementer'), implementer.turns);
  assert.equal(implementer.claudeCalls[0]?.permissionMode, 'bypassPermissions');
});

test('a read-only Codex turn is sent the configured sandbox, not a hardcoded one', async () => {
  // The point of the case: `codex.sandbox` is a user setting, and the seam must
  // pass it through rather than substituting the literal it usually holds.
  const cfg = config({ codex: { ...DEFAULTS.codex, readRateLimits: false, sandbox: 'workspace-write' } });
  const rec = recorder();

  await runTurn(freshState(), cfg, request('reviewer'), rec.turns);

  assert.equal(rec.codexCalls[0]?.sandbox, 'workspace-write');
});

// ---- What each role asks for ----------------------------------------------

test('the output schema rides on the role rather than on the turn label', async () => {
  const answerer = recorder();
  await runTurn(freshState(), config(), request('answerer', { label: 'answers-0' }), answerer.turns);
  assert.equal(answerer.codexCalls[0]?.schema, ANSWERS_SCHEMA);

  for (const role of ['critic', 'reviewer'] as const) {
    const rec = recorder();
    await runTurn(freshState(), config(), request(role, { label: `${role}-0` }), rec.turns);
    assert.equal(rec.codexCalls[0]?.schema, FINDINGS_SCHEMA);
  }
});

test('the turn label is what Codex names its output by', async () => {
  const rec = recorder();

  await runTurn(freshState(), config(), request('critic', { label: 'critique-3' }), rec.turns);

  assert.equal(rec.codexCalls[0]?.schemaName, 'critique-3');
});

test('a Claude turn carries the schema and tools the request asked for', async () => {
  const rec = recorder();
  const schema = { type: 'object' };

  await runTurn(freshState(), config(), request('planner', { jsonSchema: schema, tools: ['Read'] }), rec.turns);

  assert.equal(rec.claudeCalls[0]?.jsonSchema, schema);
  assert.deepEqual(rec.claudeCalls[0]?.tools, ['Read']);
});

// ---- Accounting ------------------------------------------------------------

test('a Claude turn is costed as well as counted', async () => {
  const state = freshState();
  const rec = recorder({ claudeCost: 0.02 });

  await captureLog(() => runTurn(state, config(), request('planner', { label: 'plan' }), rec.turns));

  assert.equal(state.costUsd, 0.02);
  assert.equal(state.tokensUsed, 1000);
  // Untouched: this token count is not the Codex share of anything.
  assert.equal(state.codexTokens, undefined);
  const event = state.events.at(-1);
  assert.equal(event?.type, 'claude_turn');
  assert.equal(event?.['label'], 'plan');
  assert.equal(event?.['costUsd'], 0.02);
  assert.equal(event?.['tokens'], 1000);
});

test('a Codex turn is counted but never costed', async () => {
  const state = freshState();
  const rec = recorder({ codexTokens: 500 });

  await captureLog(() => runTurn(state, config(), request('critic', { label: 'critique-0' }), rec.turns));

  assert.equal(state.costUsd, 0);
  assert.equal(state.tokensUsed, 500);
  assert.equal(state.codexTokens, 500);
  const event = state.events.at(-1);
  assert.equal(event?.type, 'codex_turn');
  assert.equal(event?.['label'], 'critique-0');
  assert.equal(event?.['tokens'], 500);
  // No invented figure: Codex reports no cost, so the event carries none.
  assert.equal('costUsd' in (event ?? {}), false);
});

test('a turn event records what the turn did, on either provider', async () => {
  // Point 2 of #66, and worth having on its own: three of the four data points
  // in that issue had to be recovered by grepping a transcript, because nothing
  // about what a turn DID ever reached state.json.
  const codexState = freshState();
  await captureLog(() =>
    runTurn(
      codexState,
      config(),
      request('critic', { label: 'critique-0' }),
      recorder({ activity: { items: { command_execution: 24, agent_message: 2 }, tool: 24 } }).turns,
    ),
  );

  const codexEvent = codexState.events.at(-1);
  assert.equal(codexEvent?.type, 'codex_turn');
  assert.deepEqual(codexEvent?.['items'], { command_execution: 24, agent_message: 2 });
  assert.equal(codexEvent?.['toolItems'], 24);

  // Recorded for every role on both providers, not only for the one role whose
  // findings the rule reads.
  const claudeState = freshState();
  await captureLog(() =>
    runTurn(
      claudeState,
      config(),
      request('planner', { label: 'plan' }),
      recorder({ activity: { items: { Read: 3, message: 1 }, tool: 3 } }).turns,
    ),
  );

  const claudeEvent = claudeState.events.at(-1);
  assert.equal(claudeEvent?.type, 'claude_turn');
  assert.deepEqual(claudeEvent?.['items'], { Read: 3, message: 1 });
  assert.equal(claudeEvent?.['toolItems'], 3);
});

test('a turn nothing measured records no tally, rather than a zero', async () => {
  // A zero standing in for an absence is the one thing this repo never writes:
  // `toolItems: 0` asserts an idle turn, and an unmeasured turn is not one.
  const state = freshState();

  await captureLog(() =>
    runTurn(state, config(), request('critic', { label: 'critique-0' }), recorder().turns),
  );

  const event = state.events.at(-1) ?? {};
  assert.equal('items' in event, false);
  assert.equal('toolItems' in event, false);
});

test('the detail line says what each provider does and does not report', async () => {
  const claudeState = freshState();
  const claude = await captureLog(() =>
    runTurn(claudeState, config(), request('planner', { label: 'plan' }), recorder().turns),
  );
  assert.ok(
    claude.lines.some((l) => l.includes('plan: 1k tok, ~$0.020')),
    claude.lines.join('\n'),
  );

  const codexState = freshState();
  const codex = await captureLog(() =>
    runTurn(codexState, config(), request('critic', { label: 'critique-0' }), recorder().turns),
  );
  assert.ok(
    codex.lines.some((l) => l.includes('critique-0: 500 tok, cost not reported')),
    codex.lines.join('\n'),
  );
});

// ---- Ceilings --------------------------------------------------------------

test('the token ceiling stops a turn from either provider', async () => {
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1 } });

  for (const role of ['planner', 'critic'] as const) {
    const state = freshState();
    await assert.rejects(
      () => captureLog(() => runTurn(state, cfg, request(role), recorder().turns)),
      (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
      `${role} should have hit the token ceiling`,
    );
  }
});

test('the cost ceiling stops a Claude turn and leaves a Codex turn alone', async () => {
  // Deliberate asymmetry, preserved from the two paths this seam replaced:
  // `costUsd` can rise during a Codex turn from a concurrent compaction, and
  // stopping there would discard the critique the run had just paid for.
  const cfg = config({ budget: { ...DEFAULTS.budget, maxCostUsd: 1 } });

  const codexState = freshState();
  codexState.costUsd = 5;
  await captureLog(() => runTurn(codexState, cfg, request('critic'), recorder().turns));
  assert.equal(codexState.costUsd, 5);

  const claudeState = freshState();
  claudeState.costUsd = 5;
  await assert.rejects(
    () => captureLog(() => runTurn(claudeState, cfg, request('planner'), recorder().turns)),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
  );
});

// ---- Session handling ------------------------------------------------------

test('the Codex thread is captured and handed back to the next turn', async () => {
  const state = freshState();
  const cfg = config();
  const rec = recorder({ codexSession: 'thread-9' });

  await captureLog(() => runTurn(state, cfg, request('critic'), rec.turns));
  assert.equal(rec.codexCalls[0]?.sessionId, null);
  assert.equal(state.codexSessionId, 'thread-9');

  // The answerer, not the reviewer: both sit on the judge slot, and since #45
  // the reviewer's conversation is a different one that must not be handed this
  // id. See `judge-independence.test.ts`.
  await captureLog(() => runTurn(state, cfg, request('answerer'), rec.turns));
  assert.equal(rec.codexCalls[1]?.sessionId, 'thread-9');
});

test('a run with codex.persistSession off starts every Codex turn fresh', async () => {
  const state = freshState();
  const cfg = config({ codex: { ...DEFAULTS.codex, readRateLimits: false, persistSession: false } });
  const rec = recorder({ codexSession: 'thread-9' });

  await captureLog(() => runTurn(state, cfg, request('critic'), rec.turns));
  await captureLog(() => runTurn(state, cfg, request('reviewer'), rec.turns));

  assert.equal(rec.codexCalls[0]?.sessionId, null);
  assert.equal(rec.codexCalls[1]?.sessionId, null);
  assert.equal(state.codexSessionId, null);
});

test('the first Claude turn of a session carries the handoff context, later ones do not', async () => {
  const state = freshState();
  const cfg = config();
  const rec = recorder();

  await captureLog(() => runTurn(state, cfg, request('planner', { prompt: 'first' }), rec.turns));
  assert.equal(rec.claudeCalls[0]?.resume, false);
  assert.equal(rec.claudeCalls[0]?.prompt, handoffContext(null, null, false) + 'first');
  assert.equal(state.sessionStarted, true);

  await captureLog(() => runTurn(state, cfg, request('planner', { prompt: 'second' }), rec.turns));
  assert.equal(rec.claudeCalls[1]?.resume, true);
  assert.equal(rec.claudeCalls[1]?.prompt, 'second');
});

// ---- Ordering under concurrent compaction ----------------------------------

test('applying a charge cannot yield, so nothing can interleave inside it', async () => {
  const state = freshState();
  const order: string[] = [];
  // Queued first, and still second: if the charge yielded anywhere - between the
  // totals and the event, or before the ceilings - this continuation would run
  // in the gap.
  const other = Promise.resolve().then(() => order.push('other chain'));

  await captureLog(async () => {
    applyCharge(state, config(), {
      costUsd: null,
      tokens: 500,
      // Stated since #77, where the share used to be inferred from a null cost.
      // Nothing about what this case asserts changes: it is still one charge
      // with no await in it.
      provider: 'codex',
      label: 'critique-0',
      event: { type: 'codex_turn', data: { label: 'critique-0', tokens: 500 } },
      describe: () => 'critique-0: charged',
      warnings: [],
    });
    order.push('charge applied');
    await other;
  });

  assert.deepEqual(order, ['charge applied', 'other chain']);
});

/**
 * Microtask distance from a provider's result to that turn's accounting.
 *
 * Measured against a fake whose promise this case resolves, so the count is a
 * property of the seam rather than of any real agent. It is asserted as a
 * number because the property is structural: the two paths this seam replaced
 * applied their accounting in the same continuation as their provider result,
 * and critique and review run alongside a session rotation under
 * `withConcurrentCompaction`. One extra await here is enough for
 * `session_rotated` and its handoff cost to land between a Codex result and the
 * Codex turn's own event and detail line, which would reorder the run record
 * without changing a single visible expression.
 *
 * If the seam legitimately gains or loses an await, re-measure - but work out
 * what it does to that interleaving before updating the number.
 */
async function ticksToAccounting(role: Role, eventType: string): Promise<number> {
  const state = freshState();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const turns: AgentTurns = {
    claude: (options) =>
      gate.then(() => ({
        text: 'claude said so',
        costUsd: 0.02,
        sessionId: options.sessionId,
        denials: [],
        numTurns: 1,
        usage: null,
        tokens: tokens(1000),
      })),
    codex: () =>
      gate.then(() => ({
        structured: { findings: [] },
        raw: '{"findings":[]}',
        sessionId: 'thread-1',
        tokens: tokens(500),
      })),
  };

  const { result } = await captureLog(async () => {
    const turn = runTurn(state, config(), request(role), turns);
    release();

    let ticks = 0;
    while (!state.events.some((e) => e.type === eventType) && ticks < 40) {
      ticks += 1;
      await Promise.resolve();
    }
    await turn;
    return ticks;
  });
  return result;
}

test('accounting follows a provider result with no await of its own', async () => {
  assert.equal(await ticksToAccounting('critic', 'codex_turn'), 6);
  assert.equal(await ticksToAccounting('planner', 'claude_turn'), 3);
});

test('a rotation running concurrently cannot land inside a Codex turn s accounting', async () => {
  // The shape `withConcurrentCompaction` produces: a Codex turn and a session
  // rotation in flight together. `rotateSession` is called here directly with an
  // injected turn, because the wrapper takes no provider argument and would
  // reach for a real `claude`.
  const state = freshState();
  const cfg = config({ context: { ...DEFAULTS.context, enabled: true } });
  recordContextMeasurement(state, cfg.claude.model, 0.9, 200_000);
  state.sessionStarted = true;
  const rec = recorder({ codexTokens: 500 });

  const { lines } = await captureLog(() =>
    Promise.all([
      runTurn(state, cfg, request('critic', { label: 'critique-0' }), rec.turns),
      rotateSession(state, cfg, rec.turns.claude),
    ]),
  );

  // The thread line and the turn's own detail line are written by the same
  // block. Anything between them - a "Rotated to a fresh session", a handoff
  // cost - would mean the rotation had run inside the Codex turn's accounting.
  const thread = lines.findIndex((l) => l.includes('codex thread thread-1'));
  assert.notEqual(thread, -1, lines.join('\n'));
  assert.ok(lines[thread + 1]?.includes('critique-0: 500 tok, cost not reported'), lines.join('\n'));

  const codexTurns = state.events.filter((e) => e.type === 'codex_turn');
  assert.equal(codexTurns.length, 1);
  assert.equal(codexTurns[0]?.['tokens'], 500);
  assert.equal(state.codexTokens, 500);
  // Only the rotation's handoff turn contributed cost; the Codex turn none.
  assert.equal(state.costUsd, 0.02);
});
