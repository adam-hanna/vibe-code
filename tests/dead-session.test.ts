import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RateLimitError } from '@src/claude.js';
import { DEFAULTS } from '@src/config.js';
import { runTurn } from '@src/orchestrator.js';
import type { AgentTurns, Role, TurnRequest } from '@src/orchestrator.js';
import { handoffContext } from '@src/prompts.js';
import { createRun } from '@src/run.js';
import { slotHasDeadTurn, slotHasMemory } from '@src/slots.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { ClaudeTurnResult, Config, RunState, TokenUsage } from '@src/types.js';

/**
 * A Claude session id spent by an attempt that never returned (#74).
 *
 * `claude --session-id X` consumes X on ATTEMPT, not on success. The run stored
 * only "has a turn succeeded here", so a process killed between the CLI
 * registering the session and the turn returning left a state that re-issued a
 * spent id - and every later attempt failed instantly with "Session ID ... is
 * already in use", with no flag that cleared it. Measured against the real CLI
 * on 2026-08-27; the same transcript showed the dead session is RESUMABLE and
 * carries that turn's work, and that a fork cut off mid-turn has already copied
 * the parent's history into the child.
 *
 * So there are two rules, and these cases are what says they compose:
 *
 * - at dispatch, a registered-and-unstarted slot is RESUMED rather than spawned
 *   fresh - on the ordinary path and on the fork path, and on the fork path
 *   without forking a second time;
 * - on an observed failure, a registered-and-unstarted slot is RESET, so an
 *   attempt this run actually watched fail starts clean next time.
 *
 * Together an unobserved death is recovered, an observed one is discarded, and a
 * recovery that itself fails falls through to the reset - so nothing loops.
 *
 * Nothing is spawned: `runTurn` takes an injected provider pair.
 */

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-dead-')), 'dead session', false);
}

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    // No app-server: the Codex rate-limit probe returns before it would connect.
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
    ...over,
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

/** What a Claude turn that succeeded returns, echoing the id it was given. */
function claudeResult(options: ClaudeTurnOptions): ClaudeTurnResult {
  return {
    text: 'claude said so',
    costUsd: 0.02,
    sessionId: options.sessionId,
    denials: [],
    numTurns: 1,
    usage: null,
    tokens: tokens(1000),
  };
}

interface Recorder {
  turns: AgentTurns;
  calls: ClaudeTurnOptions[];
}

/**
 * A Claude that records what it was asked for. `outcome` decides each call, so a
 * case can fail the first attempt and answer the second.
 */
function recorder(
  outcome: (call: number, options: ClaudeTurnOptions) => ClaudeTurnResult | Error = (_n, o) =>
    claudeResult(o),
): Recorder {
  const calls: ClaudeTurnOptions[] = [];
  return {
    calls,
    turns: {
      claude: (options): Promise<ClaudeTurnResult> => {
        calls.push(options);
        const produced = outcome(calls.length, options);
        return produced instanceof Error ? Promise.reject(produced) : Promise.resolve(produced);
      },
      codex: () =>
        Promise.resolve({
          structured: { findings: [] },
          raw: '{"findings":[]}',
          sessionId: 'thread-1',
          tokens: tokens(500),
        }),
    },
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

/** Exactly what a process killed mid-turn leaves behind: an id handed over, nothing started. */
function died(state: RunState): RunState {
  state.sessionRegistered = true;
  state.sessionStarted = false;
  return state;
}

/** What a forked run's state carries before its first turn on the Claude slot. */
function owesFork(state: RunState, parentId = 'parent-session'): RunState {
  state.forkPending = { main: { parentId, attempts: 0 } };
  return state;
}

/** The prefix a genuinely fresh generative turn is given on this fixture. */
const FRESH_PREFIX = handoffContext(null, null, false);

// ---- At dispatch: a dead turn is resumed, never re-issued -------------------

test('a dead first turn is resumed, not re-issued', async () => {
  const state = died(freshState());
  const cfg = config();
  const spent = state.sessionId;
  const rec = recorder();

  assert.equal(slotHasDeadTurn(state, 'main'), true);
  assert.equal(slotHasMemory(state, cfg, 'main'), false, 'no turn ever succeeded there');

  await captureLog(() => runTurn(state, cfg, request('planner'), rec.turns));

  assert.equal(rec.calls[0]?.resume, true, 'the dead session is resumed');
  assert.equal(rec.calls[0]?.forkFrom, undefined);
  assert.equal(rec.calls[0]?.sessionId, spent, 'under the id the dead turn spent');
  // The session holds that turn's work, including the briefing it was given, so
  // greeting it as a fresh conversation would be false.
  assert.equal(rec.calls[0]?.prompt, 'do the thing');
  assert.equal(state.sessionStarted, true, 'and the recovered turn establishes it');
});

test('a recovered fork is a completed fork', async () => {
  const state = owesFork(died(freshState()));
  const cfg = config();
  const child = state.sessionId;
  const rec = recorder();

  await captureLog(() => runTurn(state, cfg, request('planner'), rec.turns));

  // The copy is made at session creation, so the child already holds the
  // parent's history: forking again would make a second child from a parent
  // this run has already left.
  assert.equal(rec.calls[0]?.forkFrom, undefined, 'the fork has already happened');
  assert.equal(rec.calls[0]?.resume, true);
  assert.equal(rec.calls[0]?.sessionId, child, "in vibe's own chosen id");
  assert.equal(state.forkPending, undefined, 'and the turn that recovered it clears the debt');
  assert.equal(state.sessionStarted, true);
});

// ---- On a failure: an observed death is discarded --------------------------

test('an observed failure discards the spent id', async () => {
  const state = died(freshState());
  const cfg = config();
  const spent = state.sessionId;
  const rotations = state.sessionRotations;
  const rec = recorder(() => new Error('the process died here'));

  const { lines } = await captureLog(async () => {
    await assert.rejects(() => runTurn(state, cfg, request('planner'), rec.turns));
    return null;
  });

  assert.equal(rec.calls[0]?.sessionId, spent, 'the attempt used the spent id');
  assert.notEqual(state.sessionId, spent, 'and the failure gave it up');
  assert.equal(state.sessionRegistered, undefined, 'the fresh one is unspent');
  assert.equal(state.sessionStarted, false);
  assert.equal(state.sessionRotations, rotations, 'a discard is not a rotation');
  assert.equal(
    state.events.some((e) => e.type === 'session_rotated'),
    false,
  );
  assert.ok(
    lines.some((l) => l.includes(spent)),
    `the discarded id is disclosed: ${lines.join('\n')}`,
  );

  // And the next pass is genuinely fresh, prefix and all.
  const next = recorder();
  await captureLog(() => runTurn(state, cfg, request('planner'), next.turns));
  assert.equal(next.calls[0]?.resume, false);
  assert.equal(next.calls[0]?.sessionId, state.sessionId);
  assert.equal(next.calls[0]?.prompt, FRESH_PREFIX + 'do the thing');
});

test('a failed fork keeps the fork owed, and re-forks into an id the CLI has not refused', async () => {
  const state = owesFork(freshState());
  const cfg = config();
  const first = state.sessionId;
  const rec = recorder(() => new Error('the process died here'));

  await captureLog(async () => {
    await assert.rejects(() => runTurn(state, cfg, request('planner'), rec.turns));
    return null;
  });

  assert.equal(rec.calls[0]?.forkFrom, 'parent-session', 'the attempt forked');
  assert.equal(rec.calls[0]?.sessionId, first);
  assert.notEqual(state.sessionId, first, 'the spent child id was discarded');
  assert.equal(state.sessionRegistered, undefined);
  assert.equal(state.forkPending?.main?.parentId, 'parent-session', 'the fork is still owed');
  assert.equal(state.forkPending?.main?.attempts, 1, 'and the attempt is recorded');
  assert.equal(state.sessionRotations, 0);

  const next = recorder();
  await captureLog(() => runTurn(state, cfg, request('planner'), next.turns));
  assert.equal(next.calls[0]?.forkFrom, 'parent-session', 'so the next pass forks again');
  assert.equal(next.calls[0]?.sessionId, state.sessionId, 'into the id the failure minted');
  assert.notEqual(next.calls[0]?.sessionId, first);
  assert.equal(state.forkPending, undefined, 'and that fork completes');
});

test('a started conversation is not discarded by a failure', async () => {
  const state = freshState();
  const cfg = config();
  const rec = recorder((call, options) =>
    call === 1 ? claudeResult(options) : new Error('the second turn died'),
  );

  await captureLog(() => runTurn(state, cfg, request('planner'), rec.turns));
  const established = state.sessionId;
  assert.equal(state.sessionStarted, true);
  assert.equal(state.sessionRegistered, true);

  await captureLog(async () => {
    await assert.rejects(() => runTurn(state, cfg, request('planner'), rec.turns));
    return null;
  });

  // Nothing to recover: the conversation exists and carries the run, and a
  // failure on it is an ordinary failed turn.
  assert.equal(state.sessionId, established, 'the id is untouched');
  assert.equal(state.sessionRegistered, true, 'and so is the marker');
  assert.equal(state.sessionStarted, true);
  assert.equal(state.sessionRotations, 0);
});

test('an unregistered id is not discarded', async () => {
  const state = freshState();
  const cfg = config();
  const minted = state.sessionId;
  // The marker goes after the pre-spawn write and before the failure, which is
  // the only way to reach a failed turn on an id the code cannot show was ever
  // handed over. The reset is registered-and-unstarted, never `!started` alone:
  // an id with no evidence of being spent is one there is no reason to give up.
  const rec = recorder(() => {
    delete state.sessionRegistered;
    return new Error('the turn died');
  });

  await captureLog(async () => {
    await assert.rejects(() => runTurn(state, cfg, request('planner'), rec.turns));
    return null;
  });

  assert.equal(state.sessionId, minted, 'the id is kept');
  assert.equal(state.sessionRegistered, undefined);
  assert.equal(state.sessionStarted, false);
  assert.equal(state.sessionRotations, 0);
});

// ---- The same defect a third time: the in-process retry ---------------------

test('a rate-limit retry does not re-issue a spent id', async () => {
  const state = freshState();
  // 0.005 minutes is 300ms - the wait is real, and short enough to sit in a test.
  const cfg = config({ budget: { ...DEFAULTS.budget, maxWaitMinutes: 0.005 } });
  const rec = recorder((call, options) =>
    call === 1 ? new RateLimitError('usage limit reached', null) : claudeResult(options),
  );

  await captureLog(() => runTurn(state, cfg, request('planner'), rec.turns));

  assert.equal(rec.calls.length, 2, 'the limit was waited out and retried');
  // The first attempt spent its id: the CLI registers the session before it
  // makes the request the limit is raised on. Re-issuing `--session-id` against
  // it would fail with "already in use" - which is not a rate limit, so the
  // wait would have bought nothing.
  assert.notEqual(rec.calls[1]?.sessionId, rec.calls[0]?.sessionId, 'a fresh id, not the spent one');
  assert.equal(rec.calls[1]?.resume, false);
  assert.equal(state.sessionId, rec.calls[1]?.sessionId);
  assert.equal(state.rateLimitWaits, 1);
  assert.equal(state.sessionRotations, 0, 'and still not a rotation');
});

test('a rate-limited recovery retries as a fresh conversation, told so', async () => {
  // The transition the plain retry case cannot reach: attempt 1 RESUMES a dead
  // session, so it is rightly given no fresh-conversation prefix; the limit then
  // discards that session, and attempt 2 is a genuinely fresh one. A prompt
  // captured once, outside the retry, would start that fresh session without the
  // briefing or the plan of record and imply it already had them.
  const state = died(freshState());
  const cfg = config({ budget: { ...DEFAULTS.budget, maxWaitMinutes: 0.005 } });
  const spent = state.sessionId;
  const rec = recorder((call, options) =>
    call === 1 ? new RateLimitError('usage limit reached', null) : claudeResult(options),
  );

  await captureLog(() => runTurn(state, cfg, request('planner'), rec.turns));

  assert.equal(rec.calls.length, 2);
  assert.equal(rec.calls[0]?.resume, true, 'the first attempt recovered the dead session');
  assert.equal(rec.calls[0]?.sessionId, spent);
  assert.equal(rec.calls[0]?.prompt, 'do the thing', 'which needed no rehydration');

  assert.equal(rec.calls[1]?.resume, false, 'the retry is a fresh conversation');
  assert.notEqual(rec.calls[1]?.sessionId, spent);
  assert.equal(
    rec.calls[1]?.prompt,
    FRESH_PREFIX + 'do the thing',
    'and is told so, rather than carrying the resumed attempt prompt',
  );
});

// ---- The Codex threads have no id to burn -----------------------------------

test('a provider-minted thread is never registered, and a Codex turn writes nothing extra', async () => {
  const state = died(freshState());
  const cfg = config();

  // `codex exec` takes no session-id flag, so vibe never hands these
  // conversations an id and there is nothing to spend.
  assert.equal(slotHasDeadTurn(state, 'judge'), false);
  assert.equal(slotHasDeadTurn(state, 'review'), false);

  const dormant = state.sessionId;
  const rec = recorder();
  await captureLog(() => runTurn(state, cfg, request('critic'), rec.turns));

  // The Claude slot's marker is untouched by a turn held with the other
  // provider: nothing here registers, and nothing here recovers.
  assert.equal(state.sessionRegistered, true);
  assert.equal(state.sessionId, dormant);
  assert.equal(state.codexSessionStarted, true, 'the Codex thread started as usual');
  assert.equal(slotHasDeadTurn(state, 'judge'), false);
});

// ---- The pre-spawn write is a precondition, not a formality -----------------

test('an id that cannot be recorded as handed over is not handed over', async () => {
  // The one part of this change that reaches every run rather than only the
  // failure paths: the registration is persisted BEFORE the spawn, so a run
  // directory that cannot be written now ends the turn instead of starting one.
  //
  // That is the fail-closed direction and it is the whole point. A turn spawned
  // without its handover recorded is precisely the state #74 is about, and it is
  // the state the fork path already refused to enter for the same reason - its
  // attempt counter has been a pre-turn write since #78.
  //
  // Pinned here because the coverage moved: `failure-accounting.test.ts`'s "an
  // accounting fault while charging a failure does not become the failure"
  // reached an unwritable directory by deleting it before the dispatch, which
  // now faults this write rather than the accounting one that case is about, so
  // it deletes from inside the injected turn instead.
  const state = freshState();
  const cfg = config();
  const rec = recorder();
  rmSync(state.dir, { recursive: true, force: true });

  await captureLog(async () => {
    await assert.rejects(() => runTurn(state, cfg, request('planner'), rec.turns));
    return null;
  });

  assert.equal(rec.calls.length, 0, 'no turn was spawned');
  assert.equal(state.sessionStarted, false, 'and nothing claims one ran');
});
