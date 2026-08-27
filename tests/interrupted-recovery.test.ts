import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { EXIT } from '@src/orchestrator.js';
import { createRun, saveState } from '@src/run.js';
import type { Config, InFlightTurn, RunState } from '@src/types.js';
import type { LivenessVerdict, LockHandle } from '@src/lock.js';

/**
 * What this process does about spend the last one never paid for.
 *
 * An in-flight entry that outlived its process is spend no `catch` ever settled:
 * every in-process outcome disposes of its own entry in the write that records
 * it, so anything still there means the process died before reaching that turn's
 * accounting (#77). #60's killed implement turn spent 17,390,262 tokens that
 * were charged to nobody, and that is the number this exists to stop losing.
 *
 * The loop and the preflight gate are injected, so nothing here spawns an agent;
 * the state, the events and the writes are all real.
 */

function freshRun(inFlight?: InFlightTurn[]): { targetDir: string; state: RunState } {
  const targetDir = mkdtempSync(path.join(os.tmpdir(), 'vibe-recovery-'));
  const state = createRun(targetDir, 'interrupted recovery', false);
  state.status = 'implementing';
  state.phase = 'implementing';
  if (inFlight !== undefined) state.inFlight = inFlight;
  saveState(state);
  return { targetDir, state };
}

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    ...over,
  };
}

/** A handle as `acquireLock` would have produced it for a given verdict. */
function handleFor(liveness: LivenessVerdict['liveness'], forced: boolean): LockHandle {
  return {
    verdict: { liveness, lock: null, quietMs: null },
    forced,
    release: () => {},
  };
}

async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    return { result: await work(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const noPreflight = (): Promise<null> => Promise.resolve(null);
const noLoop = (): Promise<void> => Promise.resolve();

function persisted(state: RunState): Partial<RunState> {
  return JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Partial<RunState>;
}

function events(state: RunState, type: string): Record<string, unknown>[] {
  return state.events.filter((e) => e.type === type);
}

// ---- the ordinary walk ------------------------------------------------------

test('an unforced resume recovers a Claude entry and a Codex entry in one pass', async () => {
  // The case that proves the walk iterates a snapshot: the first entry is
  // removed from `state.inFlight` while the walk is still going, and a walk over
  // the live array would step straight past the second.
  const { state } = freshRun([
    { label: 'implement', provider: 'claude', tokens: 17_390_262 },
    { label: 'review-0', provider: 'codex' },
  ]);

  const { result, lines } = await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('interrupted', false)),
  );

  assert.equal(result, EXIT.OK);
  assert.equal(state.tokensUsed, 17_390_262, 'the Claude turn was charged');
  assert.equal(state.codexTokens, undefined, 'and the Codex turn added nothing to any total');
  assert.equal(events(state, 'recovered_spend').length, 1);
  assert.equal(events(state, 'interrupted_turn').length, 1);
  assert.equal(state.inFlight, undefined, 'both entries are gone');
  assert.equal(persisted(state).inFlight, undefined);

  const said = lines.join('\n');
  assert.match(said, /Recovered: 17\.4M tok from "implement"/);
  assert.match(said, /"review-0" Codex turn was interrupted/);
});

test('a recovered Claude turn lands in the Claude share and says its cost is missing', async () => {
  const { state } = freshRun([{ label: 'implement', provider: 'claude', tokens: 12_000 }]);

  const { lines } = await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('interrupted', false)),
  );

  assert.equal(state.tokensUsed, 12_000);
  // Not the Codex share: `summary()` renders `tokensUsed - codexTokens` as
  // Claude's, and filing this under Codex would misreport both agents at once.
  assert.equal(state.codexTokens, undefined);
  assert.equal(state.costUsd, 0, 'and no cost was invented for it');
  assert.match(lines.join('\n'), /cost is not in the dollar figure/);
});

test('a run resumed twice charges the recovered turn once', async () => {
  const { state } = freshRun([{ label: 'implement', provider: 'claude', tokens: 5_000 }]);

  await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('interrupted', false)),
  );
  const after = state.tokensUsed;
  const { lines } = await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('not-running', false)),
  );

  assert.equal(state.tokensUsed, after, 'nothing left to charge');
  assert.ok(!lines.join('\n').includes('Recovered:'), 'and nothing left to say');
});

test('a Claude turn interrupted before it said anything is named as Claude, not Codex', async () => {
  // A `'start'` observation writes an entry with a zero: the turn opened and
  // then the process died. There is nothing to charge, but the wording must
  // still describe the turn that actually ran.
  const { state } = freshRun([{ label: 'plan', provider: 'claude', tokens: 0 }]);

  const { lines } = await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('interrupted', false)),
  );

  const said = lines.join('\n');
  assert.match(said, /"plan" Claude turn was interrupted before any usage was observed/);
  assert.ok(!said.includes('Codex reports no usage'), 'the Codex explanation would be false here');
  assert.equal(state.tokensUsed, 0);
});

test("the interrupted event and its clear land in one write", async () => {
  const { state } = freshRun([{ label: 'review-0', provider: 'codex' }]);

  await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('interrupted', false)),
  );

  // Read from disk: no interruption of the process may observe a state where
  // the event is recorded and the entry is still owing, or the reverse - one
  // repeats the event forever, the other loses it.
  const file = persisted(state);
  assert.equal(file.inFlight, undefined);
  assert.equal(file.events?.filter((e) => e.type === 'interrupted_turn').length, 1);
});

// ---- nothing to do ----------------------------------------------------------

test('a run with no in-flight record recovers nothing and says nothing', async () => {
  const { state } = freshRun();
  const before = state.events.length;

  const { lines } = await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('not-running', false)),
  );

  assert.equal(state.tokensUsed, 0);
  assert.equal(state.events.length, before);
  assert.ok(!lines.join('\n').includes('Recovered:'));
  assert.ok(!lines.join('\n').includes('incomplete'));
});

test('a fresh run with no handle at all is untouched', async () => {
  // What every existing test that drives `execute` directly looks like.
  const { state } = freshRun();

  const { result } = await captureLog(() =>
    execute(state, config(), false, true, noPreflight, noLoop),
  );

  assert.equal(result, EXIT.OK);
  assert.equal(state.tokensUsed, 0);
  assert.equal(state.inFlight, undefined);
});

// ---- the ceiling ------------------------------------------------------------

test('a recovery that crosses the token ceiling stops the resume and still reports', async () => {
  const { state } = freshRun([
    { label: 'implement', provider: 'claude', tokens: 50_000 },
    { label: 'plan', provider: 'claude', tokens: 10_000 },
  ]);
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1_000 } });
  let looped = false;

  const { result, lines } = await captureLog(() =>
    execute(
      state,
      cfg,
      true,
      true,
      noPreflight,
      () => {
        looped = true;
        return Promise.resolve();
      },
      handleFor('interrupted', false),
    ),
  );

  // Correct, and the point: the run really has spent that much, so it must not
  // buy anything more before a human raises the ceiling.
  assert.equal(result, EXIT.BUDGET);
  assert.equal(looped, false, 'the loop was never entered');
  // The report was filled before the charge that raised the ceiling, so the
  // partial truth survives the escalation.
  assert.match(lines.join('\n'), /Recovered: 50k tok from "implement"/);
});

// ---- every exit reports, exactly once --------------------------------------

test('the caveat survives a preflight refusal, and the summary comes with it', async () => {
  const { state } = freshRun([{ label: 'implement', provider: 'claude', tokens: 9_000 }]);

  const { result, lines } = await captureLog(() =>
    execute(
      state,
      config(),
      true,
      false,
      () => Promise.resolve(EXIT.PREFLIGHT),
      noLoop,
      handleFor('interrupted', false),
    ),
  );

  assert.equal(result, EXIT.PREFLIGHT);
  const said = lines.join('\n');
  assert.match(said, /Recovered: 9k tok/);
  assert.match(said, /Work:/, 'the totals are stated where the run exits');
});

test('the caveat is printed exactly once on every exit', async () => {
  const count = (lines: string[]): number =>
    lines.filter((l) => l.includes('Recovered: 9k tok')).length;

  for (const [name, run] of [
    [
      'clean',
      (state: RunState) =>
        execute(state, config(), true, true, noPreflight, noLoop, handleFor('interrupted', false)),
    ],
    [
      'error',
      (state: RunState) =>
        execute(
          state,
          config(),
          true,
          true,
          noPreflight,
          () => Promise.reject(new Error('the loop exploded')),
          handleFor('interrupted', false),
        ),
    ],
    [
      'preflight',
      (state: RunState) =>
        execute(
          state,
          config(),
          true,
          false,
          () => Promise.resolve(EXIT.PREFLIGHT),
          noLoop,
          handleFor('interrupted', false),
        ),
    ],
  ] as const) {
    const { state } = freshRun([{ label: 'implement', provider: 'claude', tokens: 9_000 }]);
    const { lines } = await captureLog(() => run(state));
    assert.equal(count(lines), 1, `the ${name} exit reported it once`);
  }
});

test('a run that recovered does not present its total as complete', async () => {
  const { state } = freshRun([{ label: 'implement', provider: 'claude', tokens: 9_000 }]);

  const { lines } = await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('interrupted', false)),
  );

  const work = lines.find((l) => l.includes('Work:'));
  assert.ok(work?.includes('incomplete'), `the Work line should be marked: ${String(work)}`);
});

// ---- forced -----------------------------------------------------------------

test('a forced resume charges nothing, reports what it found, and keeps none of it', async () => {
  const { state } = freshRun([
    { label: 'implement', provider: 'claude', tokens: 8_000 },
    { label: 'review-0', provider: 'codex' },
  ]);

  const { result, lines } = await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('running', true)),
  );

  assert.equal(result, EXIT.OK);
  // Nothing charged: the other process may still be alive and will charge these
  // itself when it finishes, and a double count is undetectable afterwards.
  assert.equal(state.tokensUsed, 0);
  assert.equal(state.costUsd, 0);
  assert.equal(state.codexTokens, undefined);
  // And nothing kept: the record is keyed by label plus provider, so the very
  // next turn under one of these labels would overwrite it anyway.
  assert.equal(state.inFlight, undefined);
  assert.equal(persisted(state).inFlight, undefined);

  const said = lines.join('\n');
  assert.match(said, /Not charged: 8k tokens were observed by the interrupted process/);
  assert.match(said, /cannot tell whether another process still owns/);
  assert.match(said, /"review-0" turn was interrupted and what it spent was never observed/);
});

test('the forced release and its clear land in one write, with what it cleared', async () => {
  const { state } = freshRun([{ label: 'implement', provider: 'claude', tokens: 8_000 }]);

  await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('unknown', true)),
  );

  const file = persisted(state);
  assert.equal(file.inFlight, undefined);
  const released = file.events?.filter((e) => e.type === 'forced_release') ?? [];
  assert.equal(released.length, 1);
  assert.equal(released[0]?.['verdict'], 'unknown');
  assert.deepEqual(released[0]?.['turns'], [
    { label: 'implement', provider: 'claude', tokens: 8_000 },
  ]);
});

test('after a forced resume runs the same label again, a later resume finds nothing', async () => {
  const { state } = freshRun([{ label: 'implement', provider: 'claude', tokens: 8_000 }]);

  // Forced: reported, cleared, charged nothing.
  await captureLog(() =>
    execute(
      state,
      config(),
      true,
      true,
      noPreflight,
      // The loop then runs a turn under the SAME label and provider, which is
      // exactly what would have overwritten a preserved entry. Nothing is
      // preserved, so there is nothing to overwrite.
      (s: RunState) => {
        s.inFlight = [{ label: 'implement', provider: 'claude', tokens: 40 }];
        saveState(s);
        // ...and that turn's own charge disposes of its own record, as every
        // in-process outcome does.
        delete s.inFlight;
        saveState(s);
        return Promise.resolve();
      },
      handleFor('running', true),
    ),
  );

  const { lines } = await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('not-running', false)),
  );

  // Nothing recovered and nothing said, because there is nothing left - which is
  // the honest answer, and the one the earlier design could not give.
  assert.equal(state.tokensUsed, 0);
  const said = lines.join('\n');
  assert.ok(!said.includes('Recovered:'));
  assert.ok(!said.includes('Not charged:'));
  assert.ok(!said.includes('Unattributed:'));
});

test('a forced resume with nothing in flight says nothing at all', async () => {
  const { state } = freshRun();

  const { lines } = await captureLog(() =>
    execute(state, config(), true, true, noPreflight, noLoop, handleFor('running', true)),
  );

  assert.equal(events(state, 'forced_release').length, 0);
  assert.ok(!lines.join('\n').includes('Not charged:'));
});
