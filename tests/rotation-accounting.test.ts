import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { rotateSession, withConcurrentCompaction } from '@src/context.js';
import { Escalation, EXIT, runTurn } from '@src/orchestrator.js';
import type { AgentTurns, TurnRequest } from '@src/orchestrator.js';
import { artifact, createRun, recordContextMeasurement } from '@src/run.js';
import type { ClaudeTurnResult, Config, RunState } from '@src/types.js';

/**
 * What a session rotation costs the run.
 *
 * The rotation turn summarises a whole session, so it is among the largest a
 * run makes - and it used to add its cost to `state.costUsd` by hand and stop
 * there: no tokens, no ceiling. These cases pin it to the same charge-and-
 * enforce path an ordinary turn takes, and pin where the escalation it can now
 * raise is allowed to land.
 *
 * Nothing is spawned: `rotateSession` and `withConcurrentCompaction` both take
 * an injected `ClaudeTurnFn`, and progress is off.
 */

/** A run with a real directory: rotation writes artifacts and state. */
function runFor(task: string): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-charge-')), task, false);
}

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    ...over,
  };
}

/** A handoff turn that reported both a cost and a token count, as a real one does. */
function handoffResult(costUsd: number, total: number): ClaudeTurnResult {
  return {
    text: 'briefing',
    costUsd,
    sessionId: 'ignored',
    denials: [],
    numTurns: 1,
    usage: null,
    tokens: { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total },
  };
}

/** A measured session over the threshold: the ordinary rotation path. */
function measuredRun(task: string, model = 'opus'): RunState {
  const state = runFor(task);
  recordContextMeasurement(state, model, 0.6, 200_000);
  state.sessionStarted = true;
  return state;
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

// ---- What a rotation charges -----------------------------------------------

test('a rotation adds its tokens to the run, not only its cost', async () => {
  const state = measuredRun('rotation charges tokens');

  await captureLog(() =>
    rotateSession(state, config(), () => Promise.resolve(handoffResult(0.01, 12_000))),
  );

  assert.equal(state.tokensUsed, 12_000);
  assert.equal(state.costUsd, 0.01);
  // A rotation is a Claude turn: it is not part of the uncosted Codex share.
  assert.equal(state.codexTokens, undefined);
});

test('a rotation is still one event, now carrying what it spent', async () => {
  const state = measuredRun('rotation records one event');

  await captureLog(() =>
    rotateSession(state, config(), () => Promise.resolve(handoffResult(0.01, 12_000))),
  );

  const rotations = state.events.filter((e) => e.type === 'session_rotated');
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0]?.['tokens'], 12_000);
  assert.equal(rotations[0]?.['costUsd'], 0.01);
  assert.equal(rotations[0]?.['handoff'], true);
  // One operation, one record: no second charge event for the same rotation.
  assert.equal(state.events.filter((e) => e.type === 'claude_turn').length, 0);
});

test('a rotation that crosses budget.maxTokens raises the escalation', async () => {
  const state = measuredRun('rotation trips the token ceiling');
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1000 } });
  const oldSession = state.sessionId;

  await assert.rejects(
    () => captureLog(() => rotateSession(state, cfg, () => Promise.resolve(handoffResult(0.01, 12_000)))),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
  );

  // The rotation itself completed - the ceiling stops what comes next, and the
  // run has to be resumable on the session it just moved to.
  assert.equal(state.sessionRotations, 1);
  assert.notEqual(state.sessionId, oldSession);
  assert.equal(state.tokensUsed, 12_000);
});

// ---- Where the escalation lands --------------------------------------------

test('a budget escalation from a rotation reaches the caller', async () => {
  const state = measuredRun('escalation through the wrapper');
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1000 } });
  let worked = false;

  const { lines } = await captureLog(async () => {
    await assert.rejects(
      () =>
        withConcurrentCompaction(
          state,
          cfg,
          () => {
            worked = true;
            return Promise.resolve('critique');
          },
          () => Promise.resolve(handoffResult(0.01, 12_000)),
        ),
      (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
    );
    return null;
  });

  // Not reported as a lost optimisation: that log line is the failure mode this
  // case exists to prevent - a ceiling enforced and then swallowed.
  assert.equal(
    lines.some((l) => l.includes('Compaction failed, continuing')),
    false,
    lines.join('\n'),
  );
  // And the turn it was running alongside was allowed to finish first.
  assert.equal(worked, true);
});

test('the work running alongside an escalating rotation still writes its record', async () => {
  // The shape of the critique and review call sites: the artifact is written by
  // the callback, so a held escalation cannot cost the run the record of a turn
  // it has already paid for.
  const state = measuredRun('escalation keeps the phase artifact');
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1000 } });

  await assert.rejects(
    () =>
      captureLog(() =>
        withConcurrentCompaction(
          state,
          cfg,
          async () => {
            const found = await Promise.resolve({ findings: [] });
            artifact(state, 'plan-critique-0.json', found);
            return found;
          },
          () => Promise.resolve(handoffResult(0.01, 12_000)),
        ),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
  );

  assert.equal(existsSync(path.join(state.dir, 'plan-critique-0.json')), true);
});

test('an ordinary compaction failure is still swallowed', async () => {
  const state = measuredRun('compaction failure is an optimisation');

  const { result, lines } = await captureLog(() =>
    withConcurrentCompaction(
      state,
      config(),
      () => Promise.resolve('critique'),
      () => Promise.reject(new Error('claude timed out')),
    ),
  );

  assert.equal(result, 'critique');
  assert.ok(
    lines.some((l) => l.includes('Compaction failed, continuing on the existing session')),
    lines.join('\n'),
  );
  // The run stays on the session it could not summarise.
  assert.equal(state.sessionRotations, 0);
});

test('a baseline rotation whose briefing fails charges nothing and throws nothing', async () => {
  // Unattributable provenance: the rotation happens anyway, and with no result
  // there is nothing to charge - so not even a ceiling of 1 can stop it.
  const state = runFor('baseline briefing failure');
  state.contextRatio = 0.4;
  state.sessionStarted = true;
  const cfg = config({
    claude: { ...DEFAULTS.claude, model: 'sonnet' },
    budget: { ...DEFAULTS.budget, maxTokens: 1 },
  });
  const oldSession = state.sessionId;

  await captureLog(() => rotateSession(state, cfg, () => Promise.reject(new Error('prompt too long'))));

  assert.notEqual(state.sessionId, oldSession);
  assert.equal(state.sessionStarted, false);
  assert.equal(state.handoffStale, true);
  assert.equal(state.tokensUsed, 0);
  assert.equal(state.costUsd, 0);
  const rotations = state.events.filter((e) => e.type === 'session_rotated');
  assert.equal(rotations.length, 1);
  assert.equal(rotations[0]?.['tokens'], 0);
});

// ---- The run that never rotates --------------------------------------------

test('a run with no rotation charges exactly what it charged before', async () => {
  const state = runFor('no rotation');
  const cfg = config({ context: { ...DEFAULTS.context, enabled: false } });
  const turns: AgentTurns = {
    claude: () =>
      Promise.resolve({
        text: 'claude said so',
        costUsd: 0.02,
        sessionId: 'ignored',
        denials: [],
        numTurns: 1,
        usage: null,
        tokens: { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0, total: 1000 },
      }),
    codex: () => Promise.reject(new Error('no Codex turn belongs in this case')),
  };
  const req: TurnRequest = {
    role: 'planner',
    prompt: 'plan it',
    cwd: state.targetDir,
    label: 'plan',
    timeoutMs: 1000,
  };

  await captureLog(() => runTurn(state, cfg, req, turns));

  assert.equal(state.tokensUsed, 1000);
  assert.equal(state.costUsd, 0.02);
  assert.equal(state.codexTokens, undefined);
  assert.equal(state.events.filter((e) => e.type === 'session_rotated').length, 0);
});
