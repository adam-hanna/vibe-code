import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildOverrides, parseArgs } from '@src/cli.js';
import { applyOverrides, DEFAULTS } from '@src/config.js';
import {
  markOccupancyWarned,
  occupancyWarning,
  storedOccupancy,
  turnOccupancy,
} from '@src/context.js';
import { Escalation, runTurn } from '@src/orchestrator.js';
import type { AgentTurns, Role, TurnRequest } from '@src/orchestrator.js';
import { DEFAULT_ROLE_PROVIDERS, roleWarnings } from '@src/roles.js';
import { createRun, loadRun, saveState } from '@src/run.js';
import { recordSlotOccupancy, slotOccupancy } from '@src/slots.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { ClaudeTurnResult, Config, RunState, TokenUsage } from '@src/types.js';

/**
 * Measuring the judge slot's Codex thread.
 *
 * The numerator is `turn.completed`'s `input_tokens`, which on a resumed thread
 * is the whole conversation going in. The denominator is a setting, because the
 * protocol never reports it to a `codex exec` process - so the cases below are
 * mostly about what is NOT said when it is unset, and about a measurement never
 * being attributed to a conversation it does not describe.
 *
 * Nothing is spawned: `runTurn` takes its providers as an argument, and
 * `codex.readRateLimits` is off so the rate-limit probe returns before it would
 * connect to an app-server.
 */

function tokens(input: number, total = input): TokenUsage {
  return { input, output: total - input, cacheRead: 0, cacheCreation: 0, total };
}

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-occupancy-')), 'occupancy', false);
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

/** The same config with a window the run can name. */
function windowed(window: number, over: Partial<Config['codex']> = {}): Config {
  return config({
    codex: { ...DEFAULTS.codex, readRateLimits: false, contextWindow: window, ...over },
  });
}

interface Turn {
  tokens: TokenUsage;
  sessionId: string | null;
}

interface Recorder {
  turns: AgentTurns;
  codexCalls: CodexTurnOptions[];
}

/**
 * A Codex fake that answers a scripted list of turns, in order.
 *
 * A list rather than one fixed reply because every interesting case here is
 * about two turns: a thread that grew, a thread that was replaced, or a second
 * turn that reported no usage at all.
 */
function recorder(script: readonly Turn[]): Recorder {
  const codexCalls: CodexTurnOptions[] = [];
  let next = 0;
  return {
    codexCalls,
    turns: {
      claude: (options: ClaudeTurnOptions): Promise<ClaudeTurnResult> =>
        Promise.resolve({
          text: 'claude said so',
          costUsd: 0.02,
          sessionId: options.sessionId,
          denials: [],
          numTurns: 1,
          usage: null,
          tokens: tokens(1000),
        }),
      codex: (options) => {
        codexCalls.push(options);
        const turn = script[Math.min(next, script.length - 1)];
        next += 1;
        return Promise.resolve({
          structured: { findings: [] },
          raw: '{"findings":[]}',
          sessionId: turn?.sessionId ?? null,
          tokens: turn?.tokens ?? tokens(0, 0),
        });
      },
    },
  };
}

function request(role: Role, over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    role,
    prompt: 'do the thing',
    cwd: process.cwd(),
    label: 'critique-0',
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

const lastCodexEvent = (state: RunState): Record<string, unknown> =>
  [...state.events].reverse().find((e) => e.type === 'codex_turn') ?? {};

const has = (lines: readonly string[], re: RegExp): boolean => lines.some((l) => re.test(l));

// ---- 1. The numerator ------------------------------------------------------

test('occupancy is the last completed turn s input_tokens, on a resumed thread', async () => {
  const state = freshState();
  // The figures are the ones measured against a real Codex thread and recorded
  // in codex.ts: a resumed turn's input is the whole conversation going in, not
  // the increment, and `cached_input_tokens` sits inside it rather than beside.
  const rec = recorder([
    { tokens: tokens(13_690, 13_749), sessionId: 'thread-1' },
    { tokens: tokens(29_163, 29_222), sessionId: 'thread-1' },
  ]);

  await captureLog(async () => {
    await runTurn(state, config(), request('critic'), rec.turns);
    await runTurn(state, config(), request('critic', { label: 'review-1' }), rec.turns);
  });

  assert.equal(state.judgeContextTokens, 29_163, 'the last turn s prompt, not the first');
  assert.notEqual(state.judgeContextTokens, 13_690 + 29_163, 'not a sum');
  assert.notEqual(state.judgeContextTokens, 29_222, 'not the turn total');
  assert.equal(state.judgeContextThread, 'thread-1');
  assert.equal(rec.codexCalls[1]?.sessionId, 'thread-1', 'the second turn resumed the thread');
});

// ---- 2-4. What a window does and does not buy ------------------------------

test('with no window the numerator is recorded, no ratio is produced, and the output is unchanged', async () => {
  const state = freshState();
  const { lines } = await captureLog(() =>
    runTurn(state, config(), request('critic'), recorder([
      { tokens: tokens(500, 500), sessionId: 'thread-1' },
    ]).turns),
  );

  assert.equal(state.judgeContextTokens, 500);
  const event = lastCodexEvent(state);
  assert.equal(event['contextTokens'], 500);
  assert.equal('contextRatio' in event, false, 'no denominator, no ratio');

  const occupancy = turnOccupancy(500, config(), 'judge');
  assert.equal(occupancy?.ratio, null);
  assert.equal(occupancy?.over, false);

  // Byte-identical to the line this run logged before the feature existed.
  assert.ok(
    has(lines, /critique-0: 500 tok, cost not reported \(run 500 tok \/ ~\$0\.00 Claude-side\)/),
    lines.join('\n'),
  );
  assert.equal(has(lines, /%/), false, lines.join('\n'));
  assert.equal(has(lines, /ctx /), false, lines.join('\n'));
});

test('with a window the ratio is occupancy over window', async () => {
  const state = freshState();
  const { lines } = await captureLog(() =>
    runTurn(state, windowed(200_000), request('critic'), recorder([
      { tokens: tokens(50_000, 50_100), sessionId: 'thread-1' },
    ]).turns),
  );

  assert.equal(turnOccupancy(50_000, windowed(200_000), 'judge')?.ratio, 0.25);
  const event = lastCodexEvent(state);
  assert.equal(event['contextTokens'], 50_000);
  assert.equal(event['contextRatio'], 0.25);
  assert.ok(has(lines, /ctx 25%/), lines.join('\n'));
});

test('the threshold is crossed exactly where context.compactAboveRatio names', () => {
  const cfg = windowed(200_000);
  assert.equal(cfg.context.compactAboveRatio, 0.5);

  assert.equal(turnOccupancy(99_999, cfg, 'judge')?.over, false);
  assert.equal(turnOccupancy(100_000, cfg, 'judge')?.over, true, 'at the ratio, not past it');

  // Unknown is never over, whatever the threshold and however large the figure.
  const noWindow = config({ context: { ...DEFAULTS.context, compactAboveRatio: 0.99 } });
  assert.equal(turnOccupancy(199_999, noWindow, 'judge')?.over, false);
  assert.equal(turnOccupancy(199_999, noWindow, 'judge')?.ratio, null);
});

// ---- 5, 12, 13. The warning ------------------------------------------------

test('the warning says nothing can compact the thread, once per run, and is not persisted', async () => {
  const state = freshState();
  const rec = recorder([
    { tokens: tokens(150_000, 150_100), sessionId: 'thread-1' },
    { tokens: tokens(160_000, 160_100), sessionId: 'thread-1' },
  ]);

  const { lines } = await captureLog(async () => {
    await runTurn(state, windowed(200_000), request('critic'), rec.turns);
    await runTurn(state, windowed(200_000), request('critic', { label: 'review-1' }), rec.turns);
  });

  assert.equal(
    lines.filter((l) => /nothing can compact/i.test(l)).length,
    1,
    'said once, not once per turn',
  );
  // Nothing about having said it reaches state.json: a stale flag is the whole
  // class of defect this avoids, and a resumed run repeating one line is right.
  assert.equal('judgeContextWarned' in state, false);
  assert.equal(JSON.stringify(state).includes('Warned'), false);

  // A different run, in the same process, is warned on its own account.
  const other = freshState();
  const second = await captureLog(() =>
    runTurn(other, windowed(200_000), request('critic'), recorder([
      { tokens: tokens(150_000, 150_100), sessionId: 'thread-2' },
    ]).turns),
  );
  assert.ok(has(second.lines, /nothing can compact/i));
});

test('no window, no warning', async () => {
  const state = freshState();
  const { lines } = await captureLog(() =>
    runTurn(state, config(), request('critic'), recorder([
      { tokens: tokens(9_000_000, 9_000_100), sessionId: 'thread-1' },
    ]).turns),
  );
  assert.equal(has(lines, /nothing can compact/i), false, lines.join('\n'));
});

test('the warning names no remedy the run has already applied', async () => {
  const persisted = await captureLog(() =>
    runTurn(freshState(), windowed(200_000), request('critic'), recorder([
      { tokens: tokens(150_000, 150_100), sessionId: 'thread-1' },
    ]).turns),
  );
  assert.ok(has(persisted.lines, /--no-codex-session/), persisted.lines.join('\n'));
  assert.ok(has(persisted.lines, /nothing can compact/i));

  const oneShot = await captureLog(() =>
    runTurn(freshState(), windowed(200_000, { persistSession: false }), request('critic'), recorder([
      { tokens: tokens(150_000, 150_100), sessionId: 'thread-1' },
    ]).turns),
  );
  assert.equal(
    has(oneShot.lines, /--no-codex-session/),
    false,
    'that turn already starts empty; suggesting it again is a non-remedy',
  );
  assert.ok(has(oneShot.lines, /nothing can compact/i), oneShot.lines.join('\n'));
  assert.ok(has(oneShot.lines, /single prompt/), oneShot.lines.join('\n'));
});

test('a warning that never printed does not silence the next one', async () => {
  const state = freshState();
  // The ceiling throws out of applyCharge AFTER the warnings loop has run, so
  // the line is emitted and the marker - set by the caller afterwards - is not.
  const cfg = config({
    codex: { ...DEFAULTS.codex, readRateLimits: false, contextWindow: 200_000 },
    budget: { ...DEFAULTS.budget, maxTokens: 1 },
  });
  const rec = recorder([
    { tokens: tokens(150_000, 150_100), sessionId: 'thread-1' },
    { tokens: tokens(160_000, 160_100), sessionId: 'thread-1' },
  ]);

  const { lines } = await captureLog(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        () => runTurn(state, cfg, request('critic'), rec.turns),
        (err: unknown) => err instanceof Escalation,
      );
    }
  });

  assert.equal(
    lines.filter((l) => /nothing can compact/i.test(l)).length,
    2,
    'the second turn warns again, because the first marker was never set',
  );
});

test('occupancyWarning marks nothing by itself', () => {
  const state = freshState();
  const cfg = windowed(200_000);
  const occupancy = turnOccupancy(150_000, cfg, 'judge');
  assert.ok(occupancy !== null);

  assert.ok(occupancyWarning(state, occupancy, cfg, 'judge') !== null);
  assert.ok(occupancyWarning(state, occupancy, cfg, 'judge') !== null, 'still due: nothing emitted');
  markOccupancyWarned(state);
  assert.equal(occupancyWarning(state, occupancy, cfg, 'judge'), null);
});

// ---- 6-8. Absent is not zero -----------------------------------------------

test('a stored state with no measurement reads as nothing to report', () => {
  const state = freshState();
  delete state.judgeContextTokens;
  assert.equal(slotOccupancy(state, 'judge'), null);

  saveState(state);
  const loaded = loadRun(state.targetDir, state.id);
  assert.equal(storedOccupancy(loaded, windowed(200_000), 'judge'), null);
});

test('a conversation that has taken no turn has no occupancy, and that is not zero', async () => {
  const state = freshState();
  assert.equal(slotOccupancy(state, 'judge'), null);
  assert.equal(storedOccupancy(state, windowed(200_000), 'judge'), null);
  assert.notEqual(slotOccupancy(state, 'judge'), 0);

  // A turn accepted on its output file that emitted no `turn.completed` usage
  // block measured nothing - and nothing is not zero.
  await captureLog(() =>
    runTurn(state, windowed(200_000), request('critic'), recorder([
      { tokens: tokens(0, 0), sessionId: 'thread-1' },
    ]).turns),
  );
  assert.equal('judgeContextTokens' in state, false);
  assert.equal(turnOccupancy(0, windowed(200_000), 'judge'), null);
  assert.equal('contextTokens' in lastCodexEvent(state), false);
});

test('the judge measurement never lands on the Claude side s fields', async () => {
  const state = freshState();
  await captureLog(() =>
    runTurn(state, windowed(200_000), request('critic'), recorder([
      { tokens: tokens(150_000, 150_100), sessionId: 'thread-1' },
    ]).turns),
  );
  assert.equal(state.contextRatio, 0);
  assert.equal(state.contextModel, undefined);
  assert.equal(state.contextWindow, undefined);
});

// ---- 9-10. A measurement describes one conversation ------------------------

test('a replaced thread has no measurement until it takes a turn of its own', async () => {
  const state = freshState();
  const rec = recorder([
    { tokens: tokens(150_000, 150_100), sessionId: 'thread-1' },
    { tokens: tokens(120_000, 120_100), sessionId: 'thread-2' },
  ]);

  await captureLog(() => runTurn(state, windowed(200_000), request('critic'), rec.turns));
  assert.equal(state.judgeContextTokens, 150_000);
  assert.equal(state.judgeContextThread, 'thread-1');

  // The provider names a different thread. The stored figure still describes
  // thread-1 truthfully; it just says nothing about the one in use now.
  state.codexSessionId = 'thread-2';
  assert.equal(slotOccupancy(state, 'judge'), null);
  assert.equal(storedOccupancy(state, windowed(200_000), 'judge'), null);

  await captureLog(() => runTurn(state, windowed(200_000), request('critic'), rec.turns));
  assert.equal(state.judgeContextTokens, 120_000);
  assert.equal(state.judgeContextThread, 'thread-2');
});

test('an unmeasured turn reports nothing, and the record stands', async () => {
  const state = freshState();
  const rec = recorder([
    { tokens: tokens(50_000, 50_100), sessionId: 'thread-1' },
    { tokens: tokens(0, 0), sessionId: 'thread-1' },
  ]);

  const first = await captureLog(() =>
    runTurn(state, windowed(200_000), request('critic'), rec.turns),
  );
  assert.ok(has(first.lines, /ctx 25%/));

  const second = await captureLog(() =>
    runTurn(state, windowed(200_000), request('critic', { label: 'review-1' }), rec.turns),
  );
  assert.equal(has(second.lines, /ctx /), false, second.lines.join('\n'));
  assert.equal(has(second.lines, /%/), false, second.lines.join('\n'));
  const event = lastCodexEvent(state);
  assert.equal('contextTokens' in event, false);
  assert.equal('contextRatio' in event, false);
  // Retained: the thread still holds it. It is simply not this turn's figure.
  assert.equal(state.judgeContextTokens, 50_000);
});

// ---- 11, 15. Persistence off, and back on ----------------------------------

test('with no codex session there is no cross-turn record, and the id is left alone', async () => {
  const state = freshState();
  // What a persisted run left behind.
  state.codexSessionId = 'thread-1';
  state.codexSessionStarted = true;
  state.judgeContextTokens = 150_000;
  state.judgeContextThread = 'thread-1';

  const cfg = windowed(200_000, { persistSession: false });
  const rec = recorder([{ tokens: tokens(120_000, 120_100), sessionId: 'thread-9' }]);
  const { lines } = await captureLog(() => runTurn(state, cfg, request('critic'), rec.turns));

  assert.equal(rec.codexCalls[0]?.sessionId, null, 'a one-shot turn resumes nothing');
  // This change reads the slot's id and never writes it.
  assert.equal(state.codexSessionId, 'thread-1');
  assert.equal(state.codexSessionStarted, true);
  // thread-9 is not the conversation the slot holds, so nothing is attributed.
  assert.equal(state.judgeContextTokens, 150_000);
  assert.equal(state.judgeContextThread, 'thread-1');
  // The turn still reports what it measured, and still warns: nothing stored can
  // suppress a warning, because nothing about warnings is stored.
  assert.ok(has(lines, /ctx 60%/), lines.join('\n'));
  assert.ok(has(lines, /nothing can compact/i), lines.join('\n'));
});

test('a fresh one-shot run records nothing at all and still reports its turn', async () => {
  const state = freshState();
  const cfg = windowed(200_000, { persistSession: false });
  const { lines } = await captureLog(() =>
    runTurn(state, cfg, request('critic'), recorder([
      { tokens: tokens(120_000, 120_100), sessionId: 'thread-9' },
    ]).turns),
  );

  assert.equal('judgeContextTokens' in state, false, 'a one-shot thread has no identity to key to');
  assert.equal('judgeContextThread' in state, false);
  assert.ok(has(lines, /ctx 60%/), lines.join('\n'));
});

test('switching persistence back on does not resurrect a foreign measurement', async () => {
  const state = freshState();
  state.codexSessionId = 'thread-1';
  state.codexSessionStarted = true;
  state.judgeContextTokens = 150_000;
  state.judgeContextThread = 'thread-1';

  // Back on the thread the record always described: it updates, it is not merged.
  await captureLog(() =>
    runTurn(state, windowed(200_000), request('critic'), recorder([
      { tokens: tokens(160_000, 160_100), sessionId: 'thread-1' },
    ]).turns),
  );
  assert.equal(state.judgeContextTokens, 160_000);
  assert.equal(state.judgeContextThread, 'thread-1');
});

// ---- 16-17. Fail closed ----------------------------------------------------

test('an unusable id means the accessors report nothing and record nothing', () => {
  for (const raw of ['', 42 as unknown as string, null]) {
    const state = freshState();
    state.codexSessionId = raw;
    state.judgeContextTokens = 90_000;
    state.judgeContextThread = 'thread-1';

    assert.equal(slotOccupancy(state, 'judge'), null, `id ${JSON.stringify(raw)} names nothing`);
    recordSlotOccupancy(state, 'judge', 120_000, 'thread-9');
    assert.equal(state.judgeContextTokens, 90_000, 'no id now, so nothing to attribute');
    assert.equal(state.judgeContextThread, 'thread-1');
  }
});

test('a measurement is never attributed to a thread the turn did not run on', () => {
  const state = freshState();
  state.codexSessionId = 'thread-1';

  recordSlotOccupancy(state, 'judge', 120_000, 'thread-9');
  assert.equal('judgeContextTokens' in state, false, 'the slot is not on thread-9');

  recordSlotOccupancy(state, 'judge', 120_000, null);
  assert.equal('judgeContextTokens' in state, false, 'the turn named no thread');

  recordSlotOccupancy(state, 'judge', 0, 'thread-1');
  assert.equal('judgeContextTokens' in state, false, 'zero is not a measurement');

  recordSlotOccupancy(state, 'judge', 120_000, 'thread-1');
  assert.equal(state.judgeContextTokens, 120_000);
  assert.equal(state.judgeContextThread, 'thread-1');
});

test('a persisted turn that returns no thread id records nothing', async () => {
  const state = freshState();
  state.codexSessionId = 'thread-1';
  state.codexSessionStarted = true;

  const { lines } = await captureLog(() =>
    runTurn(state, windowed(200_000), request('critic'), recorder([
      { tokens: tokens(120_000, 120_100), sessionId: null },
    ]).turns),
  );

  assert.equal('judgeContextTokens' in state, false);
  assert.equal(state.codexSessionId, 'thread-1', 'the id is untouched either way');
  assert.ok(has(lines, /ctx 60%/), 'the turn still reports what it measured');
});

test('a slot that adopts a newly returned id records against that id', async () => {
  // The slot lifecycle repairs an unusable stored id by adopting what the
  // provider returned - `markSlotStarted` runs first, and this change does not
  // alter it. The measurement then belongs to the adopted thread, which is the
  // conversation the turn actually ran on. The unreadable older record is
  // replaced rather than merged with.
  const state = freshState();
  state.codexSessionId = '';
  state.judgeContextTokens = 90_000;
  state.judgeContextThread = 'thread-1';

  await captureLog(() =>
    runTurn(state, windowed(200_000), request('critic'), recorder([
      { tokens: tokens(120_000, 120_100), sessionId: 'thread-9' },
    ]).turns),
  );

  assert.equal(state.codexSessionId, 'thread-9', 'adopted by markSlotStarted, as it always was');
  assert.equal(state.judgeContextTokens, 120_000);
  assert.equal(state.judgeContextThread, 'thread-9');
});

// ---- 14. The role warnings stop contradicting the feature ------------------

const UNMEASURED_W3 = /nothing measures its context/i;
const UNMEASURED_W2 = /nothing measures that thread/i;
const CANNOT_COMPACT = /nothing can compact/i;

test('a generative role on a persisted Codex thread is called unmeasured only when it is', () => {
  const roles = { ...DEFAULT_ROLE_PROVIDERS, planner: 'codex' as const };

  const unset = roleWarnings(config({ roles }));
  assert.ok(has(unset, UNMEASURED_W3), unset.join('\n'));

  const measured = roleWarnings({ ...windowed(200_000), roles });
  assert.equal(has(measured, UNMEASURED_W3), false, measured.join('\n'));
  assert.ok(has(measured, CANNOT_COMPACT), measured.join('\n'));
});

test('the rotation warning stops claiming the thread is unmeasured once it is', () => {
  const roles = {
    planner: 'codex' as const,
    implementer: 'codex' as const,
    critic: 'claude' as const,
    answerer: 'claude' as const,
    reviewer: 'claude' as const,
  };
  // persistSession must be off for a writing Codex role: roleRefusals says so.
  const base = { ...DEFAULTS.codex, readRateLimits: false, persistSession: false };

  const unset = roleWarnings(config({ roles, codex: base }));
  assert.ok(has(unset, UNMEASURED_W2), unset.join('\n'));
  assert.ok(has(unset, CANNOT_COMPACT));

  const measured = roleWarnings(config({ roles, codex: { ...base, contextWindow: 200_000 } }));
  assert.equal(has(measured, UNMEASURED_W2), false, measured.join('\n'));
  assert.ok(has(measured, CANNOT_COMPACT), measured.join('\n'));
  assert.ok(has(measured, /rotation and context compaction are off/i));
});

test('the default table still warns about nothing, window or no window', () => {
  assert.deepEqual(roleWarnings(config()), []);
  assert.deepEqual(roleWarnings(windowed(200_000)), []);
});

// ---- 18. The setting -------------------------------------------------------

test('codex.contextWindow defaults to unknown and accepts only a real token count', () => {
  assert.equal(DEFAULTS.codex.contextWindow, null);
  assert.equal(applyOverrides(DEFAULTS, {}).codex.contextWindow, null);
  assert.equal(
    applyOverrides(DEFAULTS, { codex: { contextWindow: 200_000 } }).codex.contextWindow,
    200_000,
  );
  assert.equal(
    applyOverrides(DEFAULTS, { codex: { contextWindow: null } }).codex.contextWindow,
    null,
  );

  for (const bad of [0, -1, 1.5, '200000' as unknown as number, Number.NaN]) {
    assert.throws(
      () => applyOverrides(DEFAULTS, { codex: { contextWindow: bad } }),
      /codex\.contextWindow/,
      `${JSON.stringify(bad)} is not a window`,
    );
  }
});

test('--codex-context-window reaches the config the same way the file key does', () => {
  const { flags } = parseArgs(['--codex-context-window', '200000']);
  assert.equal(flags.codexContextWindow, 200_000);
  assert.equal(buildOverrides(flags).codex?.contextWindow, 200_000);
  assert.equal(buildOverrides(parseArgs([]).flags).codex?.contextWindow, undefined);

  assert.throws(
    () => applyOverrides(DEFAULTS, buildOverrides(parseArgs(['--codex-context-window', '0']).flags)),
    /codex\.contextWindow/,
  );
});
