import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chargePreflight, execute, runPreflight } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { Escalation, EXIT } from '@src/orchestrator.js';
import { preflight } from '@src/preflight.js';
import type { AgentPreflight, PreflightProbes, ProbeUsage } from '@src/preflight.js';
import { createRun } from '@src/run.js';
import type {
  AgentProvider,
  ContractViolation,
  Phase,
  ViolationReason,
} from '@src/runtime.js';
import type { Config, RunState, Sandbox } from '@src/types.js';

/**
 * What preflight's probes cost the run.
 *
 * Both probes spawn a real agent and used to throw the usage away, so a run
 * already over its ceiling paid for preflight and then paid for planning before
 * anything noticed. These pin the charge, the side it lands on, and the point in
 * the run it stops - which has to be before the first planning turn, or the
 * ceiling has already been blown past by the time it fires.
 *
 * Nothing is spawned: `preflight` takes injected probes and `execute` takes an
 * injected gate and loop.
 */

const PHASES: readonly Phase[] = ['plan', 'implement', 'review'];

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    ...over,
  };
}

function sandboxed(sandbox: Sandbox): Config {
  return { ...config(), codex: { ...config().codex, sandbox } };
}

function runFor(task: string): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-preflight-')), task, false);
}

function violation(
  provider: AgentProvider,
  tool: string,
  reason: ViolationReason,
): ContractViolation {
  return {
    provider,
    tool,
    reason,
    detail: `"${tool}" did not run in the ${provider} shell.`,
    required: null,
    found: null,
    hostExecutable: null,
  };
}

function result(over: Partial<AgentPreflight> = {}): AgentPreflight {
  return { runtime: null, violations: [], prepared: null, probeError: null, ...over };
}

/** A probe result that reported what its turns spent. */
function spent(costUsd: number | null, tokens: number, turns = 1): AgentPreflight {
  return result({ usage: { costUsd, tokens, turns } });
}

function probes(claude: AgentPreflight, codex: AgentPreflight): PreflightProbes {
  return { claude: () => Promise.resolve(claude), codex: () => Promise.resolve(codex) };
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

function charges(state: RunState): Record<string, unknown>[] {
  return state.events.filter((e) => e.type === 'preflight_probe');
}

// ---- What each side is charged ---------------------------------------------

test('a probe that reported a cost is charged to the Claude side', async () => {
  const state = runFor('claude probe is charged');

  await captureLog(() =>
    runPreflight(state, config(), probes(spent(0.01, 12_000), result())),
  );

  assert.equal(state.tokensUsed, 12_000);
  assert.equal(state.costUsd, 0.01);
  // Not part of the uncosted Codex share.
  assert.equal(state.codexTokens, undefined);
});

test('a probe that reported no cost is counted in tokens only, as a Codex turn is', async () => {
  const state = runFor('codex probe is counted');

  await captureLog(() => runPreflight(state, config(), probes(result(), spent(null, 9_000))));

  assert.equal(state.tokensUsed, 9_000);
  assert.equal(state.codexTokens, 9_000);
  assert.equal(state.costUsd, 0);
});

test('each probe that spent leaves one event saying what it spent', async () => {
  const state = runFor('one event per probe');

  await captureLog(() =>
    runPreflight(state, config(), probes(spent(0.02, 1_000, 2), spent(null, 3_000))),
  );

  const events = charges(state);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.['provider'], 'claude');
  assert.equal(events[0]?.['tokens'], 1_000);
  assert.equal(events[0]?.['costUsd'], 0.02);
  assert.equal(events[0]?.['turns'], 2);
  assert.equal(events[1]?.['provider'], 'codex');
  assert.equal(events[1]?.['costUsd'], null);
  // The verdict is still recorded once, beside the charges rather than instead.
  assert.equal(state.events.filter((e) => e.type === 'preflight-ok').length, 1);
});

test('a probe that reported nothing is charged nothing and throws nothing', async () => {
  // A skipped, failed or timed-out probe has no figure. Inventing one would put
  // a number in the run's totals that nobody could trace to a source - so even a
  // ceiling of 1 has nothing to stop.
  const state = runFor('no usage, no charge');
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1 } });

  await captureLog(() =>
    runPreflight(state, cfg, probes(result(), result({ usage: null }))),
  );

  assert.equal(state.tokensUsed, 0);
  assert.equal(state.costUsd, 0);
  assert.deepEqual(charges(state), []);
});

// ---- The ceilings ----------------------------------------------------------

test('a preflight that crosses budget.maxTokens stops the run', async () => {
  const state = runFor('preflight trips the token ceiling');
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1_000 } });

  await assert.rejects(
    () => captureLog(() => runPreflight(state, cfg, probes(spent(0.01, 12_000), result()))),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
  );

  assert.equal(state.tokensUsed, 12_000);
});

test('a preflight that crosses budget.maxCostUsd stops the run too', async () => {
  const state = runFor('preflight trips the cost ceiling');
  const cfg = config({ budget: { ...DEFAULTS.budget, maxCostUsd: 0.5 } });

  await assert.rejects(
    () => captureLog(() => runPreflight(state, cfg, probes(spent(2, 100), result()))),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
  );

  assert.equal(state.costUsd, 2);
});

test('a ceiling crossed by the first probe does not lose the second probe s spend', async () => {
  // Both probes have already run by the time anything is charged. Enforcing on
  // the first would leave the second's tokens out of the totals and its event
  // out of the log - an undercount produced by the brake itself.
  const state = runFor('the ceiling does not strand the other charge');
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1_000 } });

  await assert.rejects(
    () =>
      captureLog(() =>
        runPreflight(state, cfg, probes(spent(0.01, 12_000), spent(null, 3_000))),
      ),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.BUDGET,
  );

  assert.equal(state.tokensUsed, 15_000);
  assert.equal(state.codexTokens, 3_000);
  assert.equal(charges(state).length, 2);
});

test('a blocked preflight still charges what its probes spent', async () => {
  // The run is ending on the environment fault either way - that is the
  // actionable report - but the tokens were still spent, so they are still
  // counted and the ceiling does not get to replace the diagnosis.
  const state = runFor('blocked preflight charges');
  const cfg = config({ budget: { ...DEFAULTS.budget, maxTokens: 1_000 } });
  const blocked = result({
    violations: [violation('claude', 'node', 'missing')],
    usage: { costUsd: 0.01, tokens: 12_000, turns: 1 },
  });

  const { result: code } = await captureLog(() =>
    runPreflight(state, cfg, probes(blocked, result())),
  );

  assert.equal(code, EXIT.PREFLIGHT);
  assert.equal(state.tokensUsed, 12_000);
  assert.equal(charges(state).length, 1);
  assert.equal(state.events.filter((e) => e.type === 'preflight-failed').length, 1);
});

// ---- Where the charge is allowed to happen ---------------------------------

test('preflight itself reports usage and charges nothing - vibe doctor has no run', async () => {
  // `vibe doctor` calls preflight with no RunState at all, which is why the
  // charging lives in the run path and not inside preflight.
  const state = runFor('doctor charges nothing');
  const usage: ProbeUsage = { costUsd: 0.01, tokens: 12_000, turns: 1 };

  const report = await preflight(
    '/target',
    config(),
    PHASES,
    '/work',
    probes(result({ usage }), spent(null, 3_000)),
  );

  assert.deepEqual(report.claude.usage, usage);
  assert.equal(report.codex.usage?.tokens, 3_000);
  assert.equal(state.tokensUsed, 0);
  assert.deepEqual(charges(state), []);
});

test('the charge is applied by the run path, not by preflight', () => {
  // The seam itself: chargePreflight takes a report and a run, and is the only
  // thing that turns one into the other.
  const state = runFor('the seam');
  chargePreflight(state, config(), {
    claude: spent(0.01, 5_000),
    codex: spent(null, 2_000),
    ok: true,
    blockingReasons: [],
    warnings: [],
  });

  assert.equal(state.tokensUsed, 7_000);
  assert.equal(state.codexTokens, 2_000);
  assert.equal(state.costUsd, 0.01);
});

// ---- Where the escalation lands --------------------------------------------

test('a preflight ceiling escalation is reported, not thrown out of the run', async () => {
  // The gate runs inside execute's try: it can now raise the same Escalation a
  // turn can, and it has to reach the one handler that reports one.
  const state = runFor('escalation from the gate');
  let looped = false;

  const { result: code } = await captureLog(() =>
    execute(
      state,
      config(),
      false,
      false,
      () => Promise.reject(new Escalation(EXIT.BUDGET, 'Token ceiling exceeded')),
      () => {
        looped = true;
        return Promise.resolve();
      },
    ),
  );

  assert.equal(code, EXIT.BUDGET);
  assert.equal(state.status, 'stalled');
  assert.equal(state.events.filter((e) => e.type === 'escalation').length, 1);
  assert.equal(existsSync(path.join(state.dir, 'NEEDS-INPUT.md')), true);
  // Before the first real turn is the whole point.
  assert.equal(looped, false);
});

test('an ordinary preflight refusal still returns its own exit code', async () => {
  const state = runFor('gate returns a code');
  let looped = false;

  const { result: code } = await captureLog(() =>
    execute(state, config(), false, false, () => Promise.resolve(EXIT.PREFLIGHT), () => {
      looped = true;
      return Promise.resolve();
    }),
  );

  assert.equal(code, EXIT.PREFLIGHT);
  assert.equal(state.events.filter((e) => e.type === 'escalation').length, 0);
  assert.equal(looped, false);
});

test('--skip-probe charges nothing, because nothing ran', async () => {
  const state = runFor('skip-probe');
  let gated = false;

  const { result: code } = await captureLog(() =>
    execute(
      state,
      config(),
      false,
      true,
      () => {
        gated = true;
        return Promise.resolve(null);
      },
      () => Promise.resolve(),
    ),
  );

  assert.equal(code, EXIT.OK);
  assert.equal(gated, false);
  assert.equal(state.tokensUsed, 0);
  assert.deepEqual(charges(state), []);
});

// ---- What preflight blocks on is unchanged ---------------------------------

test('a write-capable agent still blocks on a tool probe failure, usage or no usage', async () => {
  const codex = result({
    violations: [violation('codex', 'node', 'missing')],
    usage: { costUsd: null, tokens: 3_000, turns: 1 },
  });

  const report = await preflight(
    '/target',
    sandboxed('workspace-write'),
    PHASES,
    '/work',
    probes(spent(0.01, 12_000), codex),
  );

  assert.equal(report.ok, false);
  assert.equal(report.blockingReasons.length, 1);
  assert.match(report.blockingReasons[0] ?? '', /node/);
  assert.deepEqual(report.warnings, []);
});

test('a read-only agent still only warns, usage or no usage', async () => {
  const codex = result({
    probeError: 'no output',
    violations: [violation('codex', 'node', 'missing')],
    usage: { costUsd: null, tokens: 3_000, turns: 1 },
  });

  const report = await preflight(
    '/target',
    sandboxed('read-only'),
    PHASES,
    '/work',
    probes(spent(0.01, 12_000), codex),
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.blockingReasons, []);
  assert.equal(report.warnings.length, 2);
});
