import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { claudeTurn, RateLimitError } from '@src/claude.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import { codexTurn } from '@src/codex.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { rotateSession, withConcurrentCompaction } from '@src/context.js';
import { attachSpend, chargeFailure, Escalation, EXIT, runTurn, spendOf } from '@src/orchestrator.js';
import type { AgentTurns, Role, TurnRequest } from '@src/orchestrator.js';
import { createRun, recordContextMeasurement } from '@src/run.js';
import type { RunFn, RunResult } from '@src/proc.js';
import type { ClaudeTurnResult, Config, RunState, TokenUsage } from '@src/types.js';

/**
 * What a turn that FAILED costs the run.
 *
 * A turn that fails after producing output has already spent, and until now the
 * figure died at the throw site: claude.ts threw with the result envelope in
 * scope and codex.ts threw with the `turn.completed` usage block already parsed,
 * and the thrown Error carried neither. These cases pin three things - that the
 * spend now rides out on the error, that the dispatch layer charges it through
 * the same `applyCharge` a successful turn pays through, and that none of it
 * changes which error reaches cli.ts.
 *
 * Nothing is spawned: the adapters take an injected `exec`, the seam takes
 * injected providers, and `rotateSession` / `withConcurrentCompaction` take an
 * injected `ClaudeTurnFn`.
 */
process.env['VIBE_CLAUDE_BIN'] = process.execPath;
process.env['VIBE_CODEX_BIN'] = process.execPath;

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-fail-')), 'failure accounting', false);
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
    label: 'fixture-0',
    timeoutMs: 1_000,
    ...over,
  };
}

/** A provider that must not be reached; reaching it fails the case loudly. */
function forbidden(): AgentTurns {
  return {
    claude: () => Promise.reject(new Error('claude was dispatched to and should not have been')),
    codex: () => Promise.reject(new Error('codex was dispatched to and should not have been')),
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

// ---- The adapters: the value rides out on the error -------------------------

/** A child that printed `lines` and exited with `code`. */
function fakeExec(code: number | null, lines: readonly string[], after?: () => void): RunFn {
  return (_bin, _args, _options): Promise<RunResult> => {
    after?.();
    return Promise.resolve({ code, stdout: lines.map((line) => `${line}\n`).join(''), stderr: '' });
  };
}

/** The envelope of a turn that reported usage and then said it had failed. */
function claudeFailure(result: string): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result,
    session_id: 'fixture-session',
    total_cost_usd: 0.02,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 80,
    },
  });
}

function claudeOptions(): ClaudeTurnOptions {
  return {
    prompt: 'hello',
    sessionId: 'fixture-session',
    resume: false,
    permissionMode: 'plan',
    model: 'fixture-model',
    effort: 'low',
    cwd: process.cwd(),
    timeoutMs: 1_000,
  };
}

test('a claude turn that fails after reporting usage carries what it spent', async () => {
  await assert.rejects(
    () => claudeTurn(claudeOptions(), fakeExec(1, [claudeFailure('the tool crashed')])),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'the failure is still a plain Error');
      assert.ok(!(err instanceof RateLimitError));
      assert.match(err.message, /claude turn failed \(error_during_execution\)/);
      // The same two expressions the success path costs a completed turn from.
      assert.deepEqual(spendOf(err), { costUsd: 0.02, tokens: 500 });
      return true;
    },
  );
});

test('a rate-limited claude turn carries its spend too', async () => {
  // The case the retry loop hangs on: this is the only failure it retries, so if
  // the spend did not ride out on a RateLimitError there would be nothing to
  // charge between attempts.
  await assert.rejects(
    () => claudeTurn(claudeOptions(), fakeExec(1, [claudeFailure('usage limit reached')])),
    (err: unknown) => {
      assert.ok(err instanceof RateLimitError, 'still classified as a rate limit');
      assert.deepEqual(spendOf(err), { costUsd: 0.02, tokens: 500 });
      return true;
    },
  );
});

test('a claude turn that reported no usage carries nothing', async () => {
  const assistant = JSON.stringify({ type: 'assistant', message: { content: [] } });

  await assert.rejects(
    () => claudeTurn(claudeOptions(), fakeExec(0, [assistant])),
    (err: unknown) => {
      assert.match((err as Error).message, /no result event/);
      // No envelope, so no figure. The per-message usage blocks are not one:
      // see the note on extractUsage.
      assert.equal(spendOf(err), null);
      return true;
    },
  );
});

function codexOptions(artifactDir: string): CodexTurnOptions {
  return {
    prompt: 'review it',
    schema: { type: 'object' },
    schemaName: 'review-0',
    artifactDir,
    model: 'fixture-model',
    effort: 'low',
    sandbox: 'read-only',
    cwd: process.cwd(),
    timeoutMs: 1_000,
  };
}

const CODEX_USAGE = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 900, output_tokens: 100, cached_input_tokens: 50 },
});
const CODEX_FAILED = JSON.stringify({ type: 'turn.failed', error: { message: 'model refused' } });

test('a codex turn that fails after reporting usage carries what it spent', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-codex-'));
  // A file beside the verdict, which is the situation the `turn.failed` check
  // exists for; written by the child, so `supersede` cannot have moved it.
  const wroteOutput = (): void => {
    writeFileSync(path.join(dir, 'review-0.out.json'), '{"findings":[]}', 'utf8');
  };

  await assert.rejects(
    () => codexTurn(codexOptions(dir), fakeExec(1, [CODEX_USAGE, CODEX_FAILED], wroteOutput)),
    (err: unknown) => {
      assert.match((err as Error).message, /codex reported the turn failed/);
      // No invented cost: Codex reports none, and that is what applyCharge routes on.
      assert.deepEqual(spendOf(err), { costUsd: null, tokens: 1000 });
      return true;
    },
  );
});

test('a codex turn that never reported usage carries nothing worth charging', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-codex-'));

  await assert.rejects(
    () => codexTurn(codexOptions(dir), fakeExec(1, [CODEX_FAILED])),
    (err: unknown) => {
      assert.match((err as Error).message, /codex wrote no structured output/);
      // Null, not a zero sentinel: "reported no usage" and "reported none worth
      // charging" are one answer, so there is one way of saying it.
      assert.equal(spendOf(err), null);
      return true;
    },
  );
});

test('a spend of nothing is never attached, whichever provider reports it', async () => {
  const claudeErr = attachSpend(new Error('claude'), { costUsd: 0, tokens: 0 });
  const codexErr = attachSpend(new Error('codex'), { costUsd: null, tokens: 0 });
  const realErr = attachSpend(new Error('real'), { costUsd: 0, tokens: 12 });

  assert.equal(spendOf(claudeErr), null);
  assert.equal(spendOf(codexErr), null);
  // A turn that moved tokens but reported no cost is still worth charging.
  assert.deepEqual(spendOf(realErr), { costUsd: 0, tokens: 12 });
});

// ---- The seam: the failure is charged, and the failure still wins -----------

/** A provider that fails the way a real one now does: with the spend attached. */
function failingClaude(err: Error, calls: { n: number } = { n: 0 }): AgentTurns['claude'] {
  return () => {
    calls.n += 1;
    return Promise.reject(err);
  };
}

test('a claude turn that fails after reporting usage charges that usage, and still throws', async () => {
  const state = freshState();
  const boom = attachSpend(new Error('boom'), { costUsd: 0.02, tokens: 1000 });

  await captureLog(async () => {
    await assert.rejects(
      () =>
        runTurn(state, config(), request('planner', { label: 'plan' }), {
          ...forbidden(),
          claude: failingClaude(boom),
        }),
      // Identity, not shape: cli.ts routes on the object it is handed.
      (err: unknown) => err === boom,
    );
  });

  assert.equal(state.costUsd, 0.02);
  assert.equal(state.tokensUsed, 1000);
  assert.equal(state.codexTokens, undefined);
  const event = state.events.at(-1);
  assert.equal(event?.type, 'turn_failed');
  assert.equal(event?.['label'], 'plan');
  assert.equal(event?.['provider'], 'claude');
  assert.equal(event?.['tokens'], 1000);
});

test('a codex turn that fails after reporting usage charges that usage, and still throws', async () => {
  const state = freshState();
  const boom = attachSpend(new Error('codex blew up'), { costUsd: null, tokens: 500 });

  await captureLog(async () => {
    await assert.rejects(
      () =>
        runTurn(state, config(), request('critic', { label: 'critique-0' }), {
          ...forbidden(),
          codex: () => Promise.reject(boom),
        }),
      (err: unknown) => err === boom,
    );
  });

  // Straight through the existing routing: counted, never costed.
  assert.equal(state.tokensUsed, 500);
  assert.equal(state.codexTokens, 500);
  assert.equal(state.costUsd, 0);
  const event = state.events.at(-1);
  assert.equal(event?.type, 'turn_failed');
  assert.equal(event?.['provider'], 'codex');
  assert.equal(event?.['costUsd'], null);
});

test('a turn that fails with no usage available charges nothing and still throws', async () => {
  const state = freshState();
  const boom = new Error('claude died before it said anything');

  await captureLog(async () => {
    await assert.rejects(
      () =>
        runTurn(state, config(), request('planner'), { ...forbidden(), claude: failingClaude(boom) }),
      (err: unknown) => err === boom,
    );
  });

  assert.equal(state.tokensUsed, 0);
  assert.equal(state.costUsd, 0);
  // No event claiming a turn spent when it did not.
  assert.equal(state.events.some((e) => e.type === 'turn_failed'), false);
});

test('a ceiling crossed by a failed turn does not displace the failure', async () => {
  // The rule: charging on the way out never changes which error reaches cli.ts.
  // The spend stays in the totals, so the ceiling is deferred, not lost.
  const state = freshState();
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1 } });
  const boom = attachSpend(new Error('boom'), { costUsd: 0.02, tokens: 1000 });

  await captureLog(async () => {
    await assert.rejects(
      () => runTurn(state, cfg, request('planner'), { ...forbidden(), claude: failingClaude(boom) }),
      (err: unknown) => {
        assert.ok(!(err instanceof Escalation), 'the ceiling must not become the failure');
        return err === boom;
      },
    );
  });

  assert.equal(state.tokensUsed, 1000);
});

test('an accounting fault while charging a failure does not become the failure', async () => {
  // recordEvent persists state.json, so a deleted run directory or a full disk
  // can throw inside applyCharge - after the totals have been updated. Letting
  // it out would replace the run's real failure with a write error.
  const state = freshState();
  const boom = attachSpend(new Error('boom'), { costUsd: 0.02, tokens: 1000 });

  const { lines } = await captureLog(async () => {
    await assert.rejects(
      () =>
        runTurn(state, config(), request('planner', { label: 'plan' }), {
          ...forbidden(),
          // The directory goes when the turn is already under way, rather than
          // before the dispatch. Since #74 a Claude turn persists the session
          // registration BEFORE it spawns - fail closed: an id that cannot be
          // recorded as handed over must not be handed over - so deleting the
          // directory first now faults that write instead, and the turn this
          // case is about never runs. The fault it means to stage is the one
          // inside `applyCharge`, and this is where the turn reaches it.
          claude: () => {
            rmSync(state.dir, { recursive: true, force: true });
            return Promise.reject(boom);
          },
        }),
      (err: unknown) => err === boom,
    );
    return null;
  });

  // Counted before the write failed, and reported rather than passed over.
  assert.equal(state.tokensUsed, 1000);
  assert.ok(
    lines.some((l) => l.includes('Could not record what the failed "plan" turn spent')),
    lines.join('\n'),
  );
});

test('an accounting fault does not cost the run the ceiling it just crossed', async () => {
  // A lost record must not also be a lost brake. `recordEvent` persists
  // state.json, so it throws here - after the totals have been updated and
  // before `applyCharge` would have reached the ceilings. The charge is still
  // over `maxTokens`, so the escalation must come back to the caller, which is
  // what decides whether the rotation it belongs to may complete.
  const state = freshState();
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1000 } });
  const dead = attachSpend(new Error('prompt too long'), { costUsd: 0.05, tokens: 12_000 });
  rmSync(state.dir, { recursive: true, force: true });

  const { result, lines } = await captureLog(() =>
    Promise.resolve(chargeFailure(state, cfg, dead, { label: 'compact', provider: 'claude' })),
  );

  assert.ok(result instanceof Escalation, 'the ceiling still has to be raised');
  assert.equal(result.code, EXIT.BUDGET);
  assert.equal(state.tokensUsed, 12_000);
  assert.ok(
    lines.some((l) => l.includes('the ceilings were still enforced')),
    lines.join('\n'),
  );
});

// ---- The retry loop ---------------------------------------------------------

/** A reset far enough out that `plannedWait` would ask for a real wait. */
function resetIn(ms: number): Date {
  return new Date(Date.now() + ms);
}

test('a retry after a charged failure enforces the ceiling before the second attempt', async () => {
  const state = freshState();
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 100 } });
  const limit = attachSpend(new RateLimitError('usage limit reached', resetIn(5 * 60_000)), {
    costUsd: 0,
    tokens: 1000,
  });
  const calls = { n: 0 };

  await captureLog(async () => {
    await assert.rejects(
      () =>
        runTurn(state, cfg, request('planner', { label: 'plan' }), {
          ...forbidden(),
          claude: failingClaude(limit, calls),
        }),
      (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
    );
  });

  // Stopped rather than waiting and spending again.
  assert.equal(calls.n, 1);
  assert.equal(state.tokensUsed, 1000);
  assert.equal(state.events.some((e) => e.type === 'rate_limited'), false);
  assert.equal(state.rateLimitWaits, 0);
});

test('a run under its ceiling still waits and retries exactly as it did', async () => {
  // The ceiling check must not have become an unconditional stop. maxWaitMinutes
  // is deliberately sub-minute - `plannedWait`'s no-reset branch honours it, as
  // ratelimits-monitor.test.ts already notes - so the real wait here is 300ms.
  const state = freshState();
  const cfg = config({
    budget: { ...DEFAULTS.budget, maxTokens: 25_000_000, maxWaitMinutes: 0.005 },
  });
  const limit = attachSpend(new RateLimitError('usage limit reached', null), {
    costUsd: 0.01,
    tokens: 1000,
  });
  let calls = 0;
  const claude = (options: ClaudeTurnOptions): Promise<ClaudeTurnResult> => {
    calls += 1;
    if (calls === 1) return Promise.reject(limit);
    return Promise.resolve({
      text: 'claude said so',
      costUsd: 0.02,
      sessionId: options.sessionId,
      denials: [],
      numTurns: 1,
      usage: null,
      tokens: tokens(2000),
    });
  };

  const { result } = await captureLog(() =>
    runTurn(state, cfg, request('planner', { label: 'plan' }), { ...forbidden(), claude }),
  );

  assert.equal(result.text, 'claude said so');
  assert.equal(calls, 2);
  assert.equal(state.rateLimitWaits, 1);
  assert.equal(state.events.filter((e) => e.type === 'rate_limited').length, 1);
  // Both attempts paid: the failed one through turn_failed, the second as usual.
  assert.equal(state.tokensUsed, 3000);
  assert.equal(state.costUsd, 0.03);
});

test('a first attempt that only the stream saw is charged, and the retry adds its own', async () => {
  // The case that made the in-flight record need disposing rather than keeping
  // (#77). The first attempt reports usage on the stream and then fails with
  // nothing attached - a timeout, a killed child, a rejected payload - so the
  // provider figure is absent and vibe's own observation is all there is. The
  // retry runs under the SAME label, so if the failure left its record behind,
  // the retry's heartbeat would overwrite the amount and the retry's charge
  // would clear the key: the first attempt's spend would vanish with no error
  // anywhere. Charging it at the failure is what closes that.
  const state = freshState();
  const cfg = config({ budget: { ...DEFAULTS.budget, maxWaitMinutes: 0.005 } });
  let calls = 0;
  const claude = (options: ClaudeTurnOptions): Promise<ClaudeTurnResult> => {
    calls += 1;
    if (calls === 1) {
      // What the heartbeat had persisted by the time the attempt died.
      state.inFlight = [{ label: 'plan', provider: 'claude', tokens: 6_000 }];
      return Promise.reject(new RateLimitError('usage limit reached', null));
    }
    return Promise.resolve({
      text: 'claude said so',
      costUsd: 0.02,
      sessionId: options.sessionId,
      denials: [],
      numTurns: 1,
      usage: null,
      tokens: tokens(2_000),
    });
  };

  const { result } = await captureLog(() =>
    runTurn(state, cfg, request('planner', { label: 'plan' }), { ...forbidden(), claude }),
  );

  assert.equal(result.text, 'claude said so');
  assert.equal(calls, 2);
  // Each attempt once: 6,000 observed on the first, 2,000 reported by the second.
  assert.equal(state.tokensUsed, 8_000);
  assert.equal(state.costUsd, 0.02, 'the failed attempt reported no cost, and none was invented');
  assert.equal(state.codexTokens, undefined, 'a Claude turn, cost figure or not');
  const failed = state.events.find((e) => e.type === 'turn_failed');
  assert.equal(failed?.['tokensFrom'], 'stream');
  assert.equal(failed?.['tokens'], 6_000);
  // Nothing owing: the run ends with no record for anything to charge twice.
  assert.equal(state.inFlight, undefined);
});

test('a rate limit with nothing to charge is still retried, not stopped', async () => {
  // The pre-turn Codex limit check raises a RateLimitError before anything has
  // been spent. It must reach the existing policy branches untouched.
  const state = freshState();
  const cfg = config({ budget: { ...DEFAULTS.budget, waitOnRateLimit: false } });

  await captureLog(async () => {
    await assert.rejects(
      () =>
        runTurn(state, cfg, request('planner'), {
          ...forbidden(),
          claude: () => Promise.reject(new RateLimitError('usage limit reached', null)),
        }),
      (err: unknown) => err instanceof Escalation && err.code === EXIT.RATE_LIMITED,
    );
  });

  assert.equal(state.tokensUsed, 0);
});

// ---- The rotation's own handoff turn ----------------------------------------

/** A measured session over the threshold: the ordinary rotation path. */
function measuredRun(model = DEFAULTS.claude.model): RunState {
  const state = freshState();
  recordContextMeasurement(state, model, 0.6, 200_000);
  state.sessionStarted = true;
  return state;
}

test('a handoff turn that fails after spending is charged, and the failure still reaches the caller', async () => {
  const state = measuredRun();
  const dead = attachSpend(new Error('prompt too long'), { costUsd: 0.05, tokens: 12_000 });

  await captureLog(async () => {
    await assert.rejects(
      () => rotateSession(state, config(), () => Promise.reject(dead)),
      (err: unknown) => err === dead,
    );
  });

  assert.equal(state.tokensUsed, 12_000);
  assert.equal(state.costUsd, 0.05);
  // The measured path still does not rotate on a failed briefing.
  assert.equal(state.sessionRotations, 0);
});

test('a baseline rotation charges its failed handoff and raises the ceiling after rotating', async () => {
  const state = freshState();
  state.contextRatio = 0.4;
  state.sessionStarted = true;
  const cfg = config({
    claude: { ...DEFAULTS.claude, model: 'sonnet' },
    budget: { ...DEFAULTS.budget, maxTokens: 1000 },
  });
  const oldSession = state.sessionId;
  const dead = attachSpend(new Error('prompt too long'), { costUsd: 0.05, tokens: 12_000 });

  await captureLog(async () => {
    await assert.rejects(
      () => rotateSession(state, cfg, () => Promise.reject(dead)),
      (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
    );
  });

  // The rotation happened first: the ceiling stops what comes next, and the run
  // has to be resumable on the session it just moved to.
  assert.notEqual(state.sessionId, oldSession);
  assert.equal(state.sessionStarted, false);
  assert.equal(state.handoffStale, true);
  assert.equal(state.tokensUsed, 12_000);
  const rotations = state.events.filter((e) => e.type === 'session_rotated');
  assert.equal(rotations.length, 1);
  // Still 0: no briefing was produced, and the spend has its own event.
  assert.equal(rotations[0]?.['tokens'], 0);
  assert.equal(state.events.filter((e) => e.type === 'turn_failed').length, 1);
});

// ---- Precedence under concurrent compaction ---------------------------------

function handoffResult(costUsd: number, total: number): ClaudeTurnResult {
  return {
    text: 'briefing',
    costUsd,
    sessionId: 'ignored',
    denials: [],
    numTurns: 1,
    usage: null,
    tokens: tokens(total),
  };
}

test('a rejected work does not lose the rotation escalation, and does not lose to it either', async () => {
  const state = measuredRun();
  const cfg = config({
    context: { ...DEFAULTS.context, enabled: true },
    budget: { ...DEFAULTS.budget, maxTokens: 1000 },
  });
  const blewUp = new Error('turn blew up');

  const { lines } = await captureLog(async () => {
    await assert.rejects(
      () =>
        withConcurrentCompaction(state, cfg, () => Promise.reject(blewUp), () =>
          Promise.resolve(handoffResult(0.01, 12_000)),
        ),
      // `work` wins - the run is ending either way and its own error says more
      // about why than the ceiling does.
      (err: unknown) => err === blewUp,
    );
    return null;
  });

  // Outranked, not lost: the charge landed, and the rotation completed before
  // the wrapper returned rather than running on into a run already unwinding.
  assert.equal(state.tokensUsed, 12_000);
  assert.equal(state.sessionRotations, 1);
  assert.ok(
    lines.some((l) => l.includes('Compaction hit a budget ceiling')),
    lines.join('\n'),
  );
});

test('a rejected work alongside an ordinary compaction failure is unchanged', async () => {
  const state = measuredRun();
  const cfg = config({ context: { ...DEFAULTS.context, enabled: true } });
  const blewUp = new Error('turn blew up');

  const { lines } = await captureLog(async () => {
    await assert.rejects(
      () =>
        withConcurrentCompaction(state, cfg, () => Promise.reject(blewUp), () =>
          Promise.reject(new Error('claude timed out')),
        ),
      (err: unknown) => err === blewUp,
    );
    return null;
  });

  assert.ok(
    lines.some((l) => l.includes('Compaction failed, continuing on the existing session')),
    lines.join('\n'),
  );
  assert.equal(state.sessionRotations, 0);
});

test('a rotation whose own failure handling fails is not discarded by a successful work', async () => {
  // The second settled result is read, not assumed. `.catch` normally absorbs
  // everything the rotation raises - but it can throw on the way, and a
  // fulfilled `work` used to return over the top of that in silence.
  const state = measuredRun();
  const cfg = config({ context: { ...DEFAULTS.context, enabled: true } });

  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    const line = parts.map((p) => String(p)).join(' ');
    lines.push(line);
    // The console goes away exactly as the compaction failure is being reported,
    // so the absorbing catch rejects instead of resolving.
    if (line.includes('Compaction failed, continuing')) throw new Error('console gone');
  };
  let result: string;
  try {
    result = await withConcurrentCompaction(state, cfg, () => Promise.resolve('critique'), () =>
      Promise.reject(new Error('claude timed out')),
    );
  } finally {
    console.log = original;
  }

  // Compaction is still an optimisation, so the run continues with its work.
  assert.equal(result, 'critique');
  assert.ok(
    lines.some((l) => l.includes('Compaction failed and could not report why')),
    lines.join('\n'),
  );
});

test('an escalation that escapes the rotation catch still stops the run', async () => {
  // The same slot, carrying the one thing that is not an optimisation: a
  // compaction failure may be passed over, a ceiling may not.
  const state = measuredRun();
  const cfg = config({ context: { ...DEFAULTS.context, enabled: true } });
  const stop = new Escalation(EXIT.BUDGET, 'ceiling reached');

  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    if (parts.map((p) => String(p)).join(' ').includes('Compaction failed, continuing')) throw stop;
  };
  try {
    await assert.rejects(
      () =>
        withConcurrentCompaction(state, cfg, () => Promise.resolve('critique'), () =>
          Promise.reject(new Error('claude timed out')),
        ),
      (err: unknown) => err === stop,
    );
  } finally {
    console.log = original;
  }
});

// ---- The run in which nothing fails -----------------------------------------

test('a run in which nothing fails charges exactly what it charges today', async () => {
  const state = freshState();
  const cfg = config({ context: { ...DEFAULTS.context, enabled: true } });
  recordContextMeasurement(state, cfg.claude.model, 0.9, 200_000);
  state.sessionStarted = true;
  const turns: AgentTurns = {
    claude: (options) =>
      Promise.resolve({
        text: 'claude said so',
        costUsd: 0.02,
        sessionId: options.sessionId,
        denials: [],
        numTurns: 1,
        usage: null,
        tokens: tokens(1000),
      }),
    codex: () =>
      Promise.resolve({
        structured: { findings: [] },
        raw: '{"findings":[]}',
        sessionId: 'thread-1',
        tokens: tokens(500),
      }),
  };

  await captureLog(() =>
    // A Codex turn with a rotation in flight beside it: the shape the critique
    // and review call sites produce.
    withConcurrentCompaction(
      state,
      cfg,
      () => runTurn(state, cfg, request('critic', { label: 'critique-0' }), turns),
      turns.claude,
    ),
  );
  await captureLog(() => runTurn(state, cfg, request('planner', { label: 'plan' }), turns));

  // 500 Codex + 1000 rotation handoff + 1000 planner.
  assert.equal(state.tokensUsed, 2500);
  assert.equal(state.codexTokens, 500);
  assert.equal(state.costUsd, 0.04);
  // One record per operation and no more. The order of the first two is a
  // property of these fakes, not of the seam - turn-seam.test.ts is where the
  // interleaving is pinned - so it is the tally that is asserted here.
  assert.deepEqual(state.events.map((e) => e.type).sort(), [
    'claude_turn',
    'codex_turn',
    'session_rotated',
  ]);
  assert.equal(state.events.some((e) => e.type === 'turn_failed'), false);
});
