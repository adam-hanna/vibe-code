import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyOverrides, DEFAULTS, loadConfig } from '@src/config.js';
import { shouldRotate, withConcurrentCompaction } from '@src/context.js';
import {
  DEFAULT_ROLE_PROVIDERS,
  enabledRolesFor,
  providerAccess,
  READ_ONLY_TOOLS,
  readStructured,
  ROLES,
  rolesFor,
  roleWarnings,
  runTurn,
} from '@src/orchestrator.js';
import type { AgentTurns, Role, RoleProviders, TurnRequest } from '@src/orchestrator.js';
import { adjudicate, preflight } from '@src/preflight.js';
import type { AgentPreflight, PreflightProbes } from '@src/preflight.js';
import { codexTurn } from '@src/codex.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { createRun, recordContextMeasurement } from '@src/run.js';
import type {
  AgentProvider,
  ContractViolation,
  EnvMechanism,
  Phase,
  PreparedEnvironment,
} from '@src/runtime.js';
import { ANSWERS_SCHEMA, FINDINGS_SCHEMA, PLAN_SCHEMA } from '@src/schemas.js';
import { parseAnswers, parseFindings } from '@src/validate.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { RunFn, RunResult } from '@src/proc.js';
import type { ClaudeTurnResult, Config, Plan, RunState, Sandbox, TokenUsage } from '@src/types.js';

/**
 * The role table as a config surface.
 *
 * Every case here is about a table a *user* can now reach, which is what the
 * compile-time seam in role-shaped-sites.test.ts could not cover. Nothing is
 * spawned: turns are injected fakes, probes are injected, and the one case that
 * drives the real `codexTurn` injects its `exec`.
 */

process.env['VIBE_CODEX_BIN'] = process.execPath;

/** Planner and implementer on Codex; critic, answerer and reviewer on Claude. */
const SWAP: RoleProviders = {
  planner: 'codex',
  implementer: 'codex',
  critic: 'claude',
  answerer: 'claude',
  reviewer: 'claude',
};

const ALL_CLAUDE: RoleProviders = {
  planner: 'claude',
  implementer: 'claude',
  critic: 'claude',
  answerer: 'claude',
  reviewer: 'claude',
};

const ALL_CODEX: RoleProviders = {
  planner: 'codex',
  implementer: 'codex',
  critic: 'codex',
  answerer: 'codex',
  reviewer: 'codex',
};

/** Codex holds nothing but the answerer - the role `questions.askCodex` gates. */
const CODEX_ANSWERS_ONLY: RoleProviders = { ...ALL_CLAUDE, answerer: 'codex' };

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
    ...over,
  };
}

/** A table on a config, with `persistSession` off - which a Codex writer needs. */
function withRoles(roles: RoleProviders, over: Partial<Config> = {}): Config {
  return config({
    roles,
    codex: { ...DEFAULTS.codex, readRateLimits: false, persistSession: false },
    ...over,
  });
}

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-role-config-')), 'role config', false);
}

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

const FINDINGS_REPORT = {
  verdict: 'REVISE',
  summary: 'one thing',
  findings: [
    {
      id: 'a-thing',
      severity: 'P1',
      title: 'a thing',
      detail: 'detail',
      suggested_fix: 'fix it',
      defer: false,
    },
  ],
};

const ANSWERS_REPORT = {
  answers: [
    {
      question: 'which way?',
      answer: 'that way',
      confidence: 'high',
      defer_to_human: false,
      rationale: 'because',
    },
  ],
};

interface Recorder {
  turns: AgentTurns;
  claudeCalls: ClaudeTurnOptions[];
  codexCalls: CodexTurnOptions[];
}

function recorder(over: { claudeText?: string; codexStructured?: unknown } = {}): Recorder {
  const claudeCalls: ClaudeTurnOptions[] = [];
  const codexCalls: CodexTurnOptions[] = [];
  return {
    claudeCalls,
    codexCalls,
    turns: {
      claude: (options): Promise<ClaudeTurnResult> => {
        claudeCalls.push(options);
        return Promise.resolve({
          text: over.claudeText ?? 'claude said so',
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
          structured: over.codexStructured ?? { findings: [] },
          raw: JSON.stringify(over.codexStructured ?? { findings: [] }),
          sessionId: 'thread-1',
          tokens: tokens(500),
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

/** A repo directory holding this `vibe.config.json`, for the loadConfig cases. */
function repoWith(contents: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-role-cfg-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(contents), 'utf8');
  return dir;
}

// ---- 1. Dispatch under a configured table ----------------------------------

test('every role dispatches to the provider the config names, and to no other', async () => {
  const cfg = withRoles(SWAP);

  for (const role of ['planner', 'implementer'] as const) {
    const rec = recorder();
    await captureLog(() =>
      runTurn(freshState(), cfg, request(role), { ...forbidden(), codex: rec.turns.codex }),
    );
    assert.equal(rec.codexCalls.length, 1, `${role} should reach codex`);
  }

  for (const role of ['critic', 'answerer', 'reviewer'] as const) {
    const rec = recorder({ claudeText: JSON.stringify(FINDINGS_REPORT) });
    await captureLog(() =>
      runTurn(freshState(), cfg, request(role), { ...forbidden(), claude: rec.turns.claude }),
    );
    assert.equal(rec.claudeCalls.length, 1, `${role} should reach claude`);
  }
});

// ---- 2-3. Structured output, read by the caller ----------------------------

test('a Claude reviewer returns structured findings its existing caller can read', async () => {
  const cfg = withRoles(SWAP);
  const rec = recorder({ claudeText: JSON.stringify(FINDINGS_REPORT) });

  const outcome = await captureLog(() =>
    runTurn(freshState(), cfg, request('reviewer'), rec.turns),
  );

  // The seam does not parse - the caller does, exactly as `runPlan` always has.
  assert.equal(outcome.structured, null);
  const report = parseFindings(readStructured(outcome));
  assert.equal(report.verdict, 'REVISE');
  assert.equal(report.findings[0]?.id, 'a-thing');

  // And it was asked for the schema and the read-only tools the role carries.
  assert.equal(rec.claudeCalls[0]?.jsonSchema, FINDINGS_SCHEMA);
  assert.deepEqual(rec.claudeCalls[0]?.tools, READ_ONLY_TOOLS);
  assert.equal(rec.claudeCalls[0]?.permissionMode, 'plan');
});

test('a Claude answerer returns answers its existing caller can read', async () => {
  const cfg = withRoles(SWAP);
  const rec = recorder({ claudeText: JSON.stringify(ANSWERS_REPORT) });

  const outcome = await captureLog(() =>
    runTurn(freshState(), cfg, request('answerer'), rec.turns),
  );

  assert.equal(parseAnswers(readStructured(outcome)).answers[0]?.answer, 'that way');
  assert.equal(rec.claudeCalls[0]?.jsonSchema, ANSWERS_SCHEMA);
});

test('a Codex judging turn is read back without being parsed twice', async () => {
  const rec = recorder({ codexStructured: FINDINGS_REPORT });

  const outcome = await captureLog(() => runTurn(freshState(), config(), request('critic'), rec.turns));

  // Codex parsed its own output file; `readStructured` hands back that object.
  assert.equal(readStructured(outcome), outcome.structured);
  assert.equal(parseFindings(readStructured(outcome)).verdict, 'REVISE');
});

test('a Claude turn whose text is not JSON is still a successful turn', async () => {
  const rec = recorder({ claudeText: 'not json at all' });

  const outcome = await captureLog(() => runTurn(freshState(), config(), request('planner'), rec.turns));

  assert.equal(outcome.text, 'not json at all');
  // The throw belongs to the caller that wanted structure, not to the seam -
  // which is what keeps every prose-returning test double a valid turn.
  assert.throws(() => readStructured(outcome), /could not parse it/);
});

// ---- 4. Schemas ride on the role for both providers ------------------------

test('a Codex planner is given PLAN_SCHEMA and a Codex implementer none', async () => {
  const cfg = withRoles(SWAP);

  const planner = recorder();
  await captureLog(() => runTurn(freshState(), cfg, request('planner'), planner.turns));
  assert.equal(planner.codexCalls[0]?.schema, PLAN_SCHEMA);

  const implementer = recorder();
  await captureLog(() => runTurn(freshState(), cfg, request('implementer'), implementer.turns));
  assert.equal(implementer.codexCalls[0]?.schema, undefined);
});

// ---- 5. The plan of record for a memoryless generative role ----------------

const PLAN: Plan = {
  plan_md: 'the plan of record',
  assumptions: [],
  open_questions: [],
  out_of_scope: [],
};

test('a memoryless generative role is handed the plan of record; a judging one is not', async () => {
  const cfg = withRoles(SWAP);

  const implementer = recorder();
  const writing = freshState();
  writing.plan = PLAN;
  await captureLog(() => runTurn(writing, cfg, request('implementer'), implementer.turns));
  assert.match(implementer.codexCalls[0]?.prompt ?? '', /the plan of record/);
  assert.match(implementer.codexCalls[0]?.prompt ?? '', /do the thing$/);

  // The critic restates the plan in its own prompt and takes an explicit
  // hasMemory, so today's first Codex critique turn must be untouched.
  const critic = recorder();
  const judging = freshState();
  judging.plan = PLAN;
  await captureLog(() => runTurn(judging, config(), request('critic'), critic.turns));
  assert.equal(critic.codexCalls[0]?.prompt, 'do the thing');
});

// ---- 6. The refusal --------------------------------------------------------

test('a writing Codex role with persistSession on is refused, naming the flag', () => {
  const stored = { ...structuredClone(DEFAULTS), roles: SWAP } as Config;

  assert.throws(() => applyOverrides(stored, {}), /--no-codex-session/);
  assert.throws(() => applyOverrides(stored, {}), /roles\.implementer/);
  assert.throws(
    () => loadConfig(repoWith({ roles: SWAP })),
    /--no-codex-session/,
  );

  // Turning it off is what makes the same table legal.
  assert.doesNotThrow(() => loadConfig(repoWith({ roles: SWAP, codex: { persistSession: false } })));
});

// ---- 7. Validation ---------------------------------------------------------

test('a malformed roles value is rejected rather than swallowed', () => {
  for (const bad of [null, [], 'codex', 5]) {
    assert.throws(
      () => loadConfig(repoWith({ roles: bad })),
      /roles must be an object/,
      `loadConfig should reject ${JSON.stringify(bad)}`,
    );
    assert.throws(
      () => applyOverrides({ ...structuredClone(DEFAULTS), roles: bad } as unknown as Config, {}),
      /roles must be an object/,
      `applyOverrides should reject ${JSON.stringify(bad)}`,
    );
  }
});

test('an invalid role value is named as a roles error, not as a toolchain one', () => {
  for (const bad of [null, 'gemini']) {
    for (const role of ['planner', 'implementer'] as const) {
      const attempt = (): unknown => loadConfig(repoWith({ roles: { [role]: bad } }));
      assert.throws(attempt, new RegExp(`roles\\.${role}`));
      // The regression guard for the ordering: role-derived toolchain scoping
      // must not run first and report this as an `agents` problem.
      assert.throws(attempt, (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        assert.doesNotMatch(message, /toolchain|agents/);
        return true;
      });
    }
  }
});

test('an unknown role key is rejected by name', () => {
  assert.throws(() => loadConfig(repoWith({ roles: { plannr: 'codex' } })), /roles\."plannr"/);
});

test('a partial roles object fills the rest from the default table', () => {
  const cfg = loadConfig(repoWith({ roles: { implementer: 'codex' }, codex: { persistSession: false } }));

  assert.equal(cfg.roles.implementer, 'codex');
  assert.equal(cfg.roles.planner, DEFAULT_ROLE_PROVIDERS.planner);
  assert.equal(cfg.roles.reviewer, DEFAULT_ROLE_PROVIDERS.reviewer);
});

// ---- 8. Rotation under a non-rotatable implementer -------------------------

test('an implementer on Codex disables rotation rather than throwing', async () => {
  const cfg = withRoles(SWAP, { context: { ...DEFAULTS.context, enabled: true } });
  const state = freshState();
  recordContextMeasurement(state, DEFAULTS.claude.model, 0.9, 200_000);
  state.sessionStarted = true;

  assert.equal(shouldRotate(state, cfg), false);
  assert.equal(shouldRotate(state, config({ context: { ...DEFAULTS.context, enabled: true } })), true);

  let rotations = 0;
  const result = await captureLog(() =>
    withConcurrentCompaction(state, cfg, () => Promise.resolve('review'), () => {
      rotations += 1;
      return Promise.reject(new Error('the rotation turn must not be reached'));
    }, 'reviewer'),
  );

  assert.equal(result, 'review');
  assert.equal(rotations, 0);
  assert.equal(state.sessionRotations, 0);
  assert.ok(roleWarnings(cfg).some((w) => /rotation/i.test(w)));
});

// ---- 9 & 18. The role-scoped toolchain -------------------------------------

test('toolchain node and npm are demanded of whoever implements', () => {
  const swapped = loadConfig(repoWith({ roles: SWAP, codex: { persistSession: false } }));

  assert.deepEqual(swapped.toolchain['node']?.agents, ['codex']);
  assert.deepEqual(swapped.toolchain['npm']?.agents, ['codex']);
});

test('an explicitly pinned agents list beats the role-derived one', () => {
  const cfg = loadConfig(
    repoWith({
      roles: SWAP,
      codex: { persistSession: false },
      toolchain: { node: { probe: 'node --version', phases: ['implement'], agents: ['claude'] } },
    }),
  );

  assert.deepEqual(cfg.toolchain['node']?.agents, ['claude']);
  // npm was not pinned, so it still follows the table.
  assert.deepEqual(cfg.toolchain['npm']?.agents, ['codex']);
});

test('role-scoped resolution never writes into DEFAULTS, and is order-independent', () => {
  const swapped = loadConfig(repoWith({ roles: SWAP, codex: { persistSession: false } }));

  assert.deepEqual(DEFAULTS.toolchain['node']?.agents, ['claude']);
  assert.deepEqual(DEFAULTS.toolchain['npm']?.agents, ['claude']);

  const plain = loadConfig(mkdtempSync(path.join(tmpdir(), 'vibe-role-empty-')));
  assert.deepEqual(plain.toolchain['node']?.agents, ['claude']);
  // The earlier config is unchanged by the later one: neither shares an object.
  assert.deepEqual(swapped.toolchain['node']?.agents, ['codex']);
  assert.deepEqual(DEFAULTS.toolchain['node']?.agents, ['claude']);

  const once = applyOverrides(structuredClone(DEFAULTS) as Config, {});
  const twice = applyOverrides(structuredClone(DEFAULTS) as Config, {});
  assert.deepEqual(once.toolchain['node']?.agents, twice.toolchain['node']?.agents);
  assert.deepEqual(once.toolchain['node']?.agents, ['claude']);
});

// ---- 10-11. Access, and a stored config with no table ----------------------

test('providerAccess follows the table it is given', () => {
  const swapped = withRoles(SWAP);
  assert.equal(providerAccess('codex', swapped), 'write');
  assert.equal(providerAccess('claude', swapped), 'read-only');

  assert.equal(providerAccess('claude', config()), 'write');
  assert.equal(providerAccess('codex', config()), 'read-only');
});

test('a stored config with no roles key resolves to the default table', () => {
  const stored = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  delete stored['roles'];

  const merged = applyOverrides(stored as unknown as Config, {});

  assert.deepEqual(merged.roles, DEFAULT_ROLE_PROVIDERS);
  assert.deepEqual(rolesFor(merged), ROLES);
});

test('a stored null roles value is reported rather than read as absent', () => {
  // `??` would treat this as "no key" and silently run the default table, which
  // is a different agent than the stored config names.
  const stored = { ...structuredClone(DEFAULTS), roles: null } as unknown as Config;

  assert.throws(() => rolesFor(stored), /roles must be an object/);
  assert.throws(() => applyOverrides(stored, {}), /roles must be an object/);
});

// ---- 12. The schema-less Codex adapter branch ------------------------------

function fakeExec(write: (args: readonly string[]) => void): {
  exec: RunFn;
  argv: string[][];
} {
  const argv: string[][] = [];
  return {
    argv,
    exec: (_bin, args): Promise<RunResult> => {
      argv.push([...args]);
      write(args);
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  };
}

function outFileFor(args: readonly string[]): string {
  const index = args.indexOf('-o');
  return args[index + 1] as string;
}

test('a Codex turn with no schema writes no schema file and parses nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-codex-noschema-'));
  const { exec, argv } = fakeExec((args) => {
    writeFileSync(outFileFor(args), 'I changed three files and ran the suite.', 'utf8');
  });

  const result = await captureLog(() =>
    codexTurn(
      {
        prompt: 'implement it',
        schemaName: 'implement',
        artifactDir: dir,
        model: 'fixture-model',
        effort: 'low',
        sandbox: 'workspace-write',
        cwd: process.cwd(),
        timeoutMs: 1_000,
      },
      exec,
    ),
  );

  assert.ok(!(argv[0] ?? []).includes('--output-schema'));
  assert.equal(existsSync(path.join(dir, 'implement.schema.json')), false);
  assert.equal(result.structured, null);
  assert.equal(result.raw, 'I changed three files and ran the suite.');
});

test('a Codex turn with a schema still writes it, sends it, and parses the output', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-codex-schema-'));
  const { exec, argv } = fakeExec((args) => {
    writeFileSync(outFileFor(args), JSON.stringify({ ok: true }), 'utf8');
  });

  const result = await captureLog(() =>
    codexTurn(
      {
        prompt: 'review it',
        schema: { type: 'object' },
        schemaName: 'review-0',
        artifactDir: dir,
        model: 'fixture-model',
        effort: 'low',
        sandbox: 'read-only',
        cwd: process.cwd(),
        timeoutMs: 1_000,
      },
      exec,
    ),
  );

  assert.ok((argv[0] ?? []).includes('--output-schema'));
  assert.equal(existsSync(path.join(dir, 'review-0.schema.json')), true);
  assert.deepEqual(result.structured, { ok: true });
});

// ---- 13. The warnings ------------------------------------------------------

const has = (warnings: readonly string[], re: RegExp): boolean => warnings.some((w) => re.test(w));

const INDEPENDENCE = /not independent|remembers writing/i;
const ROTATION = /rotation and context compaction are off/i;
const UNMEASURED = /nothing measures its context/i;
const COST = /budget\.maxCostUsd/i;

test('the default table warns about nothing', () => {
  assert.deepEqual(roleWarnings(config()), []);
  assert.deepEqual(roleWarnings(config({ questions: { ...DEFAULTS.questions, askCodex: false } })), []);
});

test('a judge on the implementer s provider warns about independence, and says only what is true', () => {
  // Claude holds both, and the main slot always persists: the judge really does
  // remember writing the code.
  const sharedClaude = roleWarnings(config({ roles: ALL_CLAUDE }));
  assert.ok(has(sharedClaude, /remembers writing the code/));
  assert.ok(!has(sharedClaude, ROTATION));
  assert.ok(!has(sharedClaude, UNMEASURED));
  assert.ok(!has(sharedClaude, COST));

  // Codex holds both with persistSession off: the same lost independence, but
  // no shared conversation - so the warning must not claim one.
  const sharedCodex = roleWarnings(withRoles(ALL_CODEX));
  assert.ok(has(sharedCodex, /same provider and model/));
  assert.ok(!has(sharedCodex, /remember/i));
  assert.ok(has(sharedCodex, ROTATION));
  assert.ok(has(sharedCodex, COST));
  assert.ok(!has(sharedCodex, UNMEASURED));
});

test('the swap warns about independence, rotation and the cost ceiling but not measurement', () => {
  const warnings = roleWarnings(withRoles(SWAP));

  assert.ok(has(warnings, INDEPENDENCE) === false, 'the swap splits the judges from the implementer');
  assert.ok(has(warnings, ROTATION));
  assert.ok(has(warnings, COST));
  assert.ok(!has(warnings, UNMEASURED), 'persistSession is off, so no thread grows');
});

test('a generative role on a persisted Codex thread warns about measurement and cost only', () => {
  const cfg = config({ roles: { ...DEFAULT_ROLE_PROVIDERS, planner: 'codex' } });
  const warnings = roleWarnings(cfg);

  assert.ok(has(warnings, UNMEASURED));
  assert.ok(has(warnings, COST));
  assert.ok(!has(warnings, INDEPENDENCE));
  assert.ok(!has(warnings, ROTATION), 'the implementer is still on Claude, which rotates');
});

test('no warning claims the plan-share brake stops working', () => {
  for (const cfg of [config({ roles: ALL_CLAUDE }), withRoles(SWAP), withRoles(ALL_CODEX)]) {
    for (const warning of roleWarnings(cfg)) {
      assert.doesNotMatch(warning, /planShare|plan share/i);
    }
  }
});

// ---- 14-17. Preflight for a provider that takes no turn --------------------

const PHASES: readonly Phase[] = ['plan', 'implement', 'review'];

function violation(provider: AgentProvider, tool: string): ContractViolation {
  return {
    provider,
    tool,
    reason: 'missing',
    detail: `"${tool}" did not run in the ${provider} shell.`,
    required: null,
    found: null,
    hostExecutable: null,
  };
}

function prepared(mechanisms: readonly EnvMechanism[]): PreparedEnvironment {
  return { spawnEnv: {}, extraArgs: [], artifacts: [], promptHint: null, mechanisms };
}

function result(over: Partial<AgentPreflight> = {}): AgentPreflight {
  return { runtime: null, violations: [], prepared: null, probeError: null, ...over };
}

function probes(claude: AgentPreflight, codex: AgentPreflight): PreflightProbes {
  return { claude: () => Promise.resolve(claude), codex: () => Promise.resolve(codex) };
}

test('a provider with no role cannot block preflight, whatever its sandbox says', async () => {
  for (const sandbox of ['workspace-write', 'danger-full-access'] as const) {
    const cfg = config({ roles: ALL_CLAUDE, codex: { ...DEFAULTS.codex, sandbox } });
    const codex = result({
      probeError: 'no output',
      violations: [violation('codex', 'node')],
    });

    const report = await preflight('/target', cfg, PHASES, '/work', probes(result(), codex));

    assert.equal(report.ok, true, `under ${sandbox satisfies Sandbox}`);
    assert.deepEqual(report.blockingReasons, []);
    assert.equal(report.warnings.length, 2);
    assert.equal(providerAccess('codex', cfg), 'read-only');
  }
});

test('a sandbox-policy finding warns for an unused Codex and still blocks for a used one', async () => {
  const codex = result({ prepared: prepared(['sandbox-policy', 'spawn-env']) });

  const unused = await preflight(
    '/target',
    config({ roles: ALL_CLAUDE, codex: { ...DEFAULTS.codex, sandbox: 'workspace-write' } }),
    PHASES,
    '/work',
    probes(result(), codex),
  );
  assert.equal(unused.ok, true);
  assert.ok(!unused.blockingReasons.some((reason) => reason.includes('danger-full-access')));

  // The identical verdict under the default table still blocks, so the gate is
  // pinned in both directions.
  const used = adjudicate(
    [{ provider: 'codex', access: 'read-only', result: codex }],
    config({ codex: { ...DEFAULTS.codex, sandbox: 'workspace-write' } }),
  );
  assert.ok(used.blockingReasons.some((reason) => reason.includes('danger-full-access')));
});

test('a role-less Claude is read-only too - the rule is about taking no turn', async () => {
  const cfg = withRoles(ALL_CODEX);
  const claude = result({ violations: [violation('claude', 'node')] });

  const report = await preflight('/target', cfg, PHASES, '/work', probes(claude, result()));

  assert.equal(providerAccess('claude', cfg), 'read-only');
  assert.equal(report.ok, true);
  assert.equal(report.warnings.length, 1);
});

test('a role held but switched off is the same as a role not held', async () => {
  const codex = result({ probeError: 'no output', violations: [violation('codex', 'node')] });
  const sandboxed = (askCodex: boolean, roles: RoleProviders): Config =>
    config({
      roles,
      codex: { ...DEFAULTS.codex, sandbox: 'workspace-write' },
      questions: { ...DEFAULTS.questions, askCodex },
    });

  // (a) Codex answers and nothing else, and the answerer is switched off.
  const off = sandboxed(false, CODEX_ANSWERS_ONLY);
  assert.deepEqual(enabledRolesFor('codex', off), []);
  assert.equal(providerAccess('codex', off), 'read-only');
  const offReport = await preflight('/target', off, PHASES, '/work', probes(result(), codex));
  assert.equal(offReport.ok, true);
  assert.deepEqual(offReport.blockingReasons, []);

  // (b) The same table with the answerer on: Codex runs, so its failures block.
  const on = sandboxed(true, CODEX_ANSWERS_ONLY);
  assert.deepEqual(enabledRolesFor('codex', on), ['answerer']);
  assert.equal(providerAccess('codex', on), 'write');
  const onReport = await preflight('/target', on, PHASES, '/work', probes(result(), codex));
  assert.equal(onReport.ok, false);

  // (c) The default table with the flag off: critic and reviewer remain, so
  // nothing about enforcement moves.
  const defaults = sandboxed(false, DEFAULT_ROLE_PROVIDERS);
  assert.deepEqual(enabledRolesFor('codex', defaults), ['critic', 'reviewer']);
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    const cfg = config({
      codex: { ...DEFAULTS.codex, sandbox },
      questions: { ...DEFAULTS.questions, askCodex: false },
    });
    assert.equal(
      providerAccess('codex', cfg),
      sandbox === 'read-only' ? 'read-only' : 'write',
      `under ${sandbox satisfies Sandbox}`,
    );
  }
  const defaultReport = await preflight('/target', defaults, PHASES, '/work', probes(result(), codex));
  assert.equal(defaultReport.ok, false, 'a Codex that still critiques and reviews is still enforced');
});
