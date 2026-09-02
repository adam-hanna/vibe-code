import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { failureSparedConversation, RateLimitError } from '@src/claude.js';
import { DEFAULTS } from '@src/config.js';
import { Escalation, EXIT, runTurn } from '@src/orchestrator.js';
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
  //
  // The claim, unchanged by #91: nothing hands `--session-id` a spent id. What
  // changed is which of the two lawful ways of honouring it the retry takes. It
  // used to mint a fresh id; it now RESUMES the spent one, which is the other
  // form the adapter offers (`resume ? '--resume' : '--session-id'`) and the
  // only one that keeps the work the first attempt paid for.
  assert.equal(rec.calls[1]?.resume, true, 'the spent id is resumed, not re-issued');
  assert.equal(rec.calls[1]?.sessionId, rec.calls[0]?.sessionId, 'and it is the same conversation');
  assert.equal(state.sessionId, rec.calls[1]?.sessionId);
  assert.equal(state.rateLimitWaits, 1);
  assert.equal(state.sessionRotations, 0, 'and still not a rotation');

  // The prompt is rebuilt per attempt, and #91 is what makes that load-bearing
  // in this direction rather than the other. Attempt 1 is a genuinely fresh
  // conversation and is told so; attempt 2 resumes what attempt 1 registered, so
  // the same preamble would restate a briefing the session already holds.
  assert.equal(rec.calls[0]?.resume, false);
  assert.equal(rec.calls[0]?.prompt, FRESH_PREFIX + 'do the thing');
  assert.equal(rec.calls[1]?.prompt, 'do the thing');
});

test('a rate-limited recovery resumes the same conversation, and is not told it is fresh', async () => {
  // Attempt 1 RESUMES a dead session and is rightly given no fresh-conversation
  // prefix. Before #91 the limit then discarded that session and attempt 2 was a
  // genuinely fresh one; the case existed to prove the prompt is rebuilt per
  // attempt rather than captured once outside the retry.
  //
  // The limit no longer discards anything, so attempt 2 is the same conversation
  // a second time and the prefix stays off - which is the claim now. The rebuild
  // itself did not lose its witness, it moved one case up: in `a rate-limit retry
  // does not re-issue a spent id` the two attempts now differ in the opposite
  // direction, fresh then resumed, which a prompt captured once cannot produce.
  // A reset BETWEEN two attempts of one turn is no longer reachable at all - the
  // only failure the loop retries is the one that stopped resetting - so the
  // reset's own effect on the prompt is pinned across two turns instead, by `an
  // observed failure discards the spent id`.
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

  assert.equal(rec.calls[1]?.resume, true, 'and the retry recovers it again');
  assert.equal(rec.calls[1]?.sessionId, spent, 'the limit gave up nothing');
  assert.equal(
    rec.calls[1]?.prompt,
    'do the thing',
    'so it is not greeted as a conversation that has never seen this run',
  );
  assert.equal(state.sessionStarted, true);
});

// ---- A rate limit is not damage (#91) ---------------------------------------
//
// #74 reset the slot on EVERY observed failure, which made the dispatch rule
// need no counter but discarded a session on the one failure class known not to
// have harmed it. A `RateLimitError` is raised only from `claude.ts`'s `is_error`
// branch, which is reached after a complete result envelope has been parsed: the
// CLI ran to completion and declined the request. #74 measured that even a
// hard-killed session resumes cleanly and carries its work, so this one is
// strictly less damaged than that.
//
// The cost was highest where it was paid most often. The first Claude turn of a
// run is the plan turn - the longest and most expensive one a run makes - and a
// limit there meant waiting up to `budget.maxWaitMinutes` and then redoing it.

test('the classification is made on the type, not on the message', () => {
  assert.equal(failureSparedConversation(new RateLimitError('usage limit reached', null)), true);
  // Everything else fails closed, including a plain error whose text would match
  // `detectRateLimit`'s vocabulary. The class is decided where the envelope is
  // read; a string that reaches this point unclassified is not evidence.
  assert.equal(failureSparedConversation(new Error('usage limit reached')), false);
  assert.equal(failureSparedConversation(new Error('the process died here')), false);
  assert.equal(failureSparedConversation(new Escalation(EXIT.RATE_LIMITED, 'gave up waiting')), false);
  assert.equal(failureSparedConversation('rate limit'), false);
  assert.equal(failureSparedConversation(undefined), false);
});

test('a limit past the wait cap exits resumable on a session it kept', async () => {
  // The trap in the obvious fix. Moving the reset to the outer catch - "only a
  // failure that ESCAPES the retry loop discards the id" - looks equivalent and
  // is not: past the cap the loop throws, so the catch would give up an intact
  // session at the exact moment the run is exiting resumable on it, destroying
  // the work the resume below recovers. The predicate is what the failure did to
  // the conversation, and that holds on both paths.
  const state = freshState();
  const cfg = config({ budget: { ...DEFAULTS.budget, maxWaitMinutes: 0.005 } });
  const minted = state.sessionId;
  const soon = new Date(Date.now() + 60 * 60_000);
  const rec = recorder(() => new RateLimitError('usage limit reached', soon));

  await captureLog(async () => {
    await assert.rejects(
      () => runTurn(state, cfg, request('planner'), rec.turns),
      (err: unknown) => {
        assert.ok(err instanceof Escalation, `expected an Escalation, got ${String(err)}`);
        assert.equal(err.code, EXIT.RATE_LIMITED);
        return true;
      },
    );
    return null;
  });

  assert.equal(rec.calls.length, 1, 'the reset was too far off to wait for');
  assert.equal(state.sessionId, minted, 'and the session it paid for is still named');
  assert.equal(state.sessionRegistered, true);
  assert.equal(state.sessionStarted, false);
  assert.equal(slotHasDeadTurn(state, 'main'), true, 'so the next process has something to recover');

  // Which is the whole point: the resume continues that conversation.
  const next = recorder();
  await captureLog(() => runTurn(state, cfg, request('planner'), next.turns));
  assert.equal(next.calls[0]?.resume, true);
  assert.equal(next.calls[0]?.sessionId, minted);
  assert.equal(next.calls[0]?.prompt, 'do the thing', 'holding the work the limited turn did');
});

test('a run configured not to wait keeps the session too', async () => {
  // The other way out of the loop without a retry. Same reasoning, and it is the
  // reason the gate sits in `onFailure` rather than around the wait: nothing
  // about whether this run waits changes what the failure did to the session.
  const state = freshState();
  const cfg = config({ budget: { ...DEFAULTS.budget, waitOnRateLimit: false } });
  const minted = state.sessionId;
  const rec = recorder(() => new RateLimitError('usage limit reached', null));

  await captureLog(async () => {
    await assert.rejects(() => runTurn(state, cfg, request('planner'), rec.turns));
    return null;
  });

  assert.equal(state.sessionId, minted);
  assert.equal(state.sessionRegistered, true);
  assert.equal(slotHasDeadTurn(state, 'main'), true);
});

test('a limit that is followed by real damage still gives the id up', async () => {
  // Self-correcting, and the reason keeping an intact session costs nothing even
  // where the judgement is wrong: whatever the limit spared, a resume of a
  // conversation that turns out to be unusable fails with something that is not
  // a rate limit - and that does reset.
  const state = freshState();
  const cfg = config({ budget: { ...DEFAULTS.budget, maxWaitMinutes: 0.005 } });
  const minted = state.sessionId;
  const rec = recorder((call) =>
    call === 1
      ? new RateLimitError('usage limit reached', null)
      : new Error('Session ID is corrupt'),
  );

  await captureLog(async () => {
    await assert.rejects(() => runTurn(state, cfg, request('planner'), rec.turns));
    return null;
  });

  assert.equal(rec.calls.length, 2, 'the limit was waited out');
  assert.equal(rec.calls[1]?.sessionId, minted, 'and the retry resumed the kept session');
  assert.equal(rec.calls[1]?.resume, true);
  assert.notEqual(state.sessionId, minted, 'which the second failure then discarded');
  assert.equal(state.sessionRegistered, undefined);
  assert.equal(state.sessionStarted, false);
});

test('a rate-limited fork is resumed on the retry, not forked a second time', async () => {
  // #78 and #91 composing. `--fork-session` copies the parent at session
  // creation, so attempt 1 has already made the child; forking again would make
  // a second child from a parent this run has left, and the attempt counter would
  // disclose a retry that never needed to happen.
  const state = owesFork(freshState());
  const cfg = config({ budget: { ...DEFAULTS.budget, maxWaitMinutes: 0.005 } });
  const child = state.sessionId;
  const rec = recorder((call, options) =>
    call === 1 ? new RateLimitError('usage limit reached', null) : claudeResult(options),
  );

  await captureLog(() => runTurn(state, cfg, request('planner'), rec.turns));

  assert.equal(rec.calls[0]?.forkFrom, 'parent-session', 'the first attempt forked');
  assert.equal(rec.calls[0]?.sessionId, child);

  assert.equal(rec.calls[1]?.forkFrom, undefined, 'the fork had already happened');
  assert.equal(rec.calls[1]?.resume, true);
  assert.equal(rec.calls[1]?.sessionId, child, 'into the same child');
  assert.equal(state.forkPending, undefined, 'and the turn that resumed it clears the debt');
  assert.equal(state.sessionStarted, true);
});

test('keeping a session is said out loud', async () => {
  const state = freshState();
  const cfg = config({ budget: { ...DEFAULTS.budget, maxWaitMinutes: 0.005 } });
  const minted = state.sessionId;
  const rec = recorder((call, options) =>
    call === 1 ? new RateLimitError('usage limit reached', null) : claudeResult(options),
  );

  const { lines } = await captureLog(() => runTurn(state, cfg, request('planner'), rec.turns));

  // Otherwise invisible: the run is about to wait, and what it will resume when
  // the wait ends is the conversation this attempt already paid for.
  assert.ok(
    lines.some((l) => l.includes(minted) && /intact/.test(l)),
    `the kept session is disclosed: ${lines.join('\n')}`,
  );
  // And the discard line, which says the opposite thing, is not also printed.
  assert.equal(
    lines.some((l) => l.includes('starting a fresh conversation')),
    false,
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
