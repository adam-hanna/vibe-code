import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeTurnOptions } from '@src/claude.js';
import { execute } from '@src/cli.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { applyOverrides, DEFAULTS, loadConfig } from '@src/config.js';
import { EXIT, orchestrate, runTurn } from '@src/orchestrator.js';
import type { AgentTurns, Role, RoleProviders, TurnRequest } from '@src/orchestrator.js';
import {
  DEFAULT_ROLE_PROVIDERS,
  effortFor,
  ROLE_NAMES,
  ROLES,
  rolesFor,
  tableFor,
} from '@src/roles.js';
import { createRun, loadRun } from '@src/run.js';
import { validateStoredState } from '@src/stored.js';
import type { ClaudeTurnResult, Config, RunState, TokenUsage } from '@src/types.js';
import {
  agents,
  committing,
  config as loopConfig,
  freshRun,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * The effort a turn actually runs at, per role.
 *
 * Effort was provider-level, so two roles on one agent could not differ - a
 * `max` reviewer dragged the critic and the answerer up with it (#46). What is
 * under test is the dispatched value, not the resolver's return: the resolver is
 * one line, and the defect it fixes lives in what reaches `claude --effort` and
 * `model_reasoning_effort=`. So every case that claims something about a turn
 * reads the options that turn was dispatched with.
 *
 * Nothing is spawned. Turns are injected through the seam `orchestrate` and
 * `runTurn` already take, and the config cases go through the real `loadConfig`
 * and `applyOverrides` against temp directories.
 *
 * Nothing cleans up its temp directory, for the reason `loop-harness.ts` gives:
 * `rmSync` over a directory a child process has just touched is a Windows flake
 * source in a suite that has to pass three times running.
 */

// ---- recording the dispatch ------------------------------------------------

/** What a turn was asked for, reduced to the fields this file is about. */
interface Dispatched {
  label: string;
  provider: 'claude' | 'codex';
  effort: string;
  model: string;
  sandbox: string | null;
}

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

/**
 * The harness agents, plus a record of what each turn was dispatched with.
 *
 * `agents()` already hands the options to the case's handlers; this wraps them so
 * the recording happens whatever the handler returns. Claude's label comes from
 * `options.progress?.label` - which is why `loopConfig` leaves progress enabled -
 * and Codex's is its `schemaName`, exactly as the harness reads them.
 */
function recording(handlers: Handlers): { turns: AgentTurns; seen: Dispatched[] } {
  const seen: Dispatched[] = [];
  const inner = agents(
    {
      claude: (label, options) => {
        seen.push({
          label,
          provider: 'claude',
          effort: options.effort,
          model: options.model,
          sandbox: null,
        });
        return handlers.claude?.(label, options) ?? 'claude said so';
      },
      codex: (label, options) => {
        seen.push({
          label,
          provider: 'codex',
          effort: options.effort,
          model: options.model,
          sandbox: options.sandbox,
        });
        return handlers.codex?.(label, options) ?? report([]);
      },
      ...(handlers.codexSessionId === undefined
        ? {}
        : { codexSessionId: handlers.codexSessionId }),
    },
    [],
  );
  return { turns: inner, seen };
}

/** The agents a clean full pass needs, as `full-loop.test.ts` builds them. */
function passing(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

/** One whole run - plan, critique, implement, verify, review - and what it dispatched. */
async function fullPass(over: Partial<Config> = {}): Promise<Dispatched[]> {
  const state = freshRun({ prefix: 'vibe-effort-', task: 'per-role effort', planOnly: false, git: true, commit: true });
  const rec = recording(passing(state));
  await orchestrate(
    state,
    loopConfig({}, { ...committing(), ...verifying(state), ...over }),
    false,
    rec.turns,
  );
  assert.equal(state.status, 'done', 'the run under test has to have finished');
  return rec.seen;
}

// ---- 1. A string role value dispatches exactly as it does today -------------

test('under the default table every turn runs at its provider effort', async () => {
  const seen = await fullPass();

  assert.deepEqual(
    seen.map((d) => d.label),
    ['plan', 'critique-0', 'implement', 'review-0'],
    'the phase order is the one this run has always had',
  );
  for (const turn of seen) {
    const expected =
      turn.provider === 'claude' ? DEFAULTS.claude.effort : DEFAULTS.codex.effort;
    assert.equal(turn.effort, expected, `${turn.label} runs at its provider's effort`);
    // The model is not per-role in this change, and must not have moved.
    assert.equal(
      turn.model,
      turn.provider === 'claude' ? DEFAULTS.claude.model : DEFAULTS.codex.model,
    );
  }
  // Stated as the concrete figures too, so a change to DEFAULTS cannot make the
  // loop above vacuously true.
  assert.deepEqual(
    seen.map((d) => d.effort),
    ['medium', 'xhigh', 'medium', 'xhigh'],
  );
});

// ---- 2. The object form with no effort is the string form -------------------

test('a role object naming only its provider dispatches identically to the string', async () => {
  const asObjects = Object.fromEntries(
    ROLE_NAMES.map((role) => [role, { provider: DEFAULT_ROLE_PROVIDERS[role] }]),
  ) as unknown as RoleProviders;

  const strings = await fullPass();
  const objects = await fullPass({ roles: asObjects });

  assert.deepEqual(objects, strings, 'the object form changed something about the dispatch');
});

// ---- 3. An effort overrides for that role and no other ---------------------

interface Recorder {
  turns: AgentTurns;
  claudeCalls: ClaudeTurnOptions[];
  codexCalls: CodexTurnOptions[];
}

function recorder(): Recorder {
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
          costUsd: 0.01,
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
          structured: report([]),
          raw: '{}',
          sessionId: 'thread-1',
          tokens: tokens(500),
        });
      },
    },
  };
}

function turnConfig(roles: RoleProviders): Config {
  return {
    ...DEFAULTS,
    roles,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
  };
}

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-effort-turn-')), 'per-role effort', false);
}

function request(role: Role): TurnRequest {
  return { role, prompt: 'do the thing', cwd: process.cwd(), label: `${role}-0` };
}

/** What one turn in this role was dispatched with, under this table. */
async function effortOf(role: Role, roles: RoleProviders): Promise<string> {
  const cfg = turnConfig(roles);
  const rec = recorder();
  const state = freshState();
  state.plan = planFixture();
  await runTurn(state, cfg, request(role), rec.turns);
  const options = rolesFor(cfg)[role].provider === 'claude' ? rec.claudeCalls[0] : rec.codexCalls[0];
  assert.ok(options !== undefined, `${role} dispatched no turn`);
  return options.effort;
}

test('a Codex role naming its own effort leaves every other Codex role alone', async () => {
  const roles: RoleProviders = {
    ...DEFAULT_ROLE_PROVIDERS,
    reviewer: { provider: 'codex', effort: 'max' },
  };

  assert.equal(await effortOf('reviewer', roles), 'max');
  assert.equal(await effortOf('critic', roles), DEFAULTS.codex.effort);
  assert.equal(await effortOf('answerer', roles), DEFAULTS.codex.effort);
  assert.equal(await effortOf('planner', roles), DEFAULTS.claude.effort);
});

test('a Claude role naming its own effort leaves the other Claude role alone', async () => {
  const roles: RoleProviders = {
    ...DEFAULT_ROLE_PROVIDERS,
    planner: { provider: 'claude', effort: 'high' },
  };

  assert.equal(await effortOf('planner', roles), 'high');
  assert.equal(await effortOf('implementer', roles), DEFAULTS.claude.effort);
  assert.equal(await effortOf('critic', roles), DEFAULTS.codex.effort);
});

// ---- 4-7. Every malformed form is a config error that says what is wrong ----

/** A repo directory holding this `vibe.config.json`, written from raw text. */
function repoWithText(json: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-effort-cfg-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), json, 'utf8');
  return dir;
}

/** A repo directory holding this `vibe.config.json`. */
function repoWith(contents: unknown): string {
  return repoWithText(JSON.stringify(contents));
}

/**
 * The same bad value through both entry points.
 *
 * `loadConfig` is the file path and `applyOverrides` is the resume path - the one
 * that validates a stored `state.config` - and a message that only one of them
 * produces would leave a resume running on a table nothing checked.
 */
function bothPathsReject(role: Role, value: unknown, ...expected: readonly RegExp[]): void {
  const roles = { ...DEFAULT_ROLE_PROVIDERS, [role]: value };
  for (const pattern of expected) {
    assert.throws(() => loadConfig(repoWith({ roles })), pattern, `loadConfig: ${String(pattern)}`);
    assert.throws(
      () => applyOverrides({ ...structuredClone(DEFAULTS), roles } as unknown as Config, {}),
      pattern,
      `applyOverrides: ${String(pattern)}`,
    );
  }
}

test('an effort a role names that is not an effort is a config error naming the role', () => {
  bothPathsReject(
    'reviewer',
    { provider: 'codex', effort: 'turbo' },
    /roles\.reviewer\.effort/,
    /low, medium, high, xhigh, max/,
  );
  // A non-string is the same mistake, not a crash.
  bothPathsReject('reviewer', { provider: 'codex', effort: 3 }, /roles\.reviewer\.effort/);
});

test('a model inside a role object is refused rather than silently ignored', () => {
  bothPathsReject(
    'reviewer',
    { provider: 'codex', model: 'gpt-5.6-luna' },
    /roles\.reviewer\.model/,
    /not supported/,
    /codex\.model/,
  );
  // Named even when it is the only key, rather than reported as a missing
  // provider: the user is reaching for a per-role model, and that is the answer.
  bothPathsReject('reviewer', { model: 'gpt-5.6-luna' }, /roles\.reviewer\.model/);
});

test('an unknown key inside a role object is a config error naming the key', () => {
  bothPathsReject(
    'reviewer',
    { provider: 'codex', sandbox: 'danger-full-access' },
    /roles\.reviewer/,
    /unknown key "sandbox"/,
  );
});

test('a model beside another unknown key still gets the model message, either order', () => {
  // One scan over `Object.keys` would answer whichever key JSON put first, so a
  // user reaching for a per-role model could be told about `sandbox` instead.
  for (const value of [
    { provider: 'codex', model: 'o3', sandbox: 'x' },
    { provider: 'codex', sandbox: 'x', model: 'o3' },
  ]) {
    bothPathsReject('reviewer', value, /roles\.reviewer\.model/, /not supported/);
  }
});

test('a role object with no provider is a config error saying provider is required', () => {
  bothPathsReject('reviewer', { effort: 'max' }, /roles\.reviewer/, /provider is required/);
});

test('a role value that is neither a provider nor an object still names the role', () => {
  for (const bad of [null, 5, [], 'gemini']) {
    bothPathsReject('reviewer', bad, /roles\.reviewer/);
  }
});

// ---- A reserved key is not a way past validation ---------------------------

/**
 * `__proto__` in a config file, and why these cases exist.
 *
 * `JSON.parse` gives `__proto__` as an own enumerable key, but `out[key] = value`
 * does not: it invokes the prototype setter, creating nothing enumerable. Every
 * validator here iterates own keys, so a merge that assigned would leave the
 * unknown-role-name check with nothing to see - the config silently ignored, the
 * defaults run, and the user told nothing. Written as raw JSON text on purpose: a
 * `{__proto__: ...}` object literal in this file would set the prototype rather
 * than reproduce what a config file contains.
 */
test('a reserved role key is rejected by name rather than swallowed by the merge', () => {
  const json = '{"roles":{"__proto__":{"reviewer":{"provider":"codex","effort":"max"}}}}';

  assert.throws(() => loadConfig(repoWithText(json)), /roles\."__proto__"/);
  assert.throws(
    () => applyOverrides(JSON.parse(json) as Config, {}),
    /roles\."__proto__"/,
    'the resume path has to refuse it too',
  );

  // And the ordinary bad-name message still fires for an ordinary bad name.
  assert.throws(() => loadConfig(repoWith({ roles: { plannr: 'codex' } })), /roles\."plannr"/);
});

test('a reserved tool name survives the toolchain merge instead of vanishing', () => {
  // `toolchain` is the one open-ended section, so the same assignment hid an
  // entry there too. It is a legal tool name to write, so what this pins is that
  // it is *seen*: either honoured or refused, never dropped in silence.
  const cfg = loadConfig(
    repoWithText('{"toolchain":{"__proto__":{"probe":"echo hi","phases":["plan"]}}}'),
  );
  assert.equal(Object.keys(cfg.toolchain).includes('__proto__'), true);

  assert.throws(
    () => loadConfig(repoWithText('{"toolchain":{"__proto__":{"probe":"","phases":["plan"]}}}')),
    /toolchain\.__proto__\.probe/,
  );
});

test('an unknown state field named __proto__ is carried through, not dropped', () => {
  // The same assignment, in the passthrough that exists so a state written by a
  // newer vibe is not corrupted by an older one reading it.
  const state = createRun(mkdtempSync(path.join(tmpdir(), 'vibe-effort-proto-')), 'proto', true);
  const file = path.join(state.dir, 'state.json');
  const raw = readFileSync(file, 'utf8').replace(/^\{/, '{"__proto__":{"kept":true},');
  const { state: validated, repairs } = validateStoredState(JSON.parse(raw), state.id, state.dir);

  assert.deepEqual(repairs, [], 'an unknown field is not damage');
  const carried = validated as unknown as Record<string, unknown>;
  assert.equal(Object.keys(carried).includes('__proto__'), true, 'the field survived the read');
  assert.deepEqual(Object.getOwnPropertyDescriptor(carried, '__proto__')?.value, { kept: true });
});

// ---- 8. Nothing written before this change moves ----------------------------

test('a config of nothing but strings loads to a table that names no effort', () => {
  const cfg = loadConfig(
    repoWith({
      roles: {
        planner: 'claude',
        implementer: 'claude',
        critic: 'codex',
        answerer: 'codex',
        reviewer: 'codex',
      },
    }),
  );

  const table = rolesFor(cfg);
  for (const role of ROLE_NAMES) {
    assert.equal(table[role].provider, DEFAULT_ROLE_PROVIDERS[role], `${role} kept its provider`);
    assert.equal('effort' in table[role], false, `${role} named no effort and must not carry one`);
    assert.equal(effortFor(role, cfg), cfg[table[role].provider].effort);
  }
});

const RUNS = path.join('.vibe', 'runs');

/** A real state file, loaded from a copy so the fixture itself is never touched. */
function loadFixture(name: string): { state: RunState; stored: Record<string, unknown> } {
  const file = fileURLToPath(new URL(`../../tests/fixtures/state/${name}.json`, import.meta.url));
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const id = String(stored['id']);
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-effort-legacy-'));
  const dir = path.join(targetDir, RUNS, id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, path.join(dir, 'state.json'));
  return { state: loadRun(targetDir, id), stored };
}

function storedConfig(stored: Record<string, unknown>): Record<string, unknown> {
  const cfg = stored['config'];
  assert.ok(cfg !== null && typeof cfg === 'object', 'the fixture carries a config');
  return cfg as Record<string, unknown>;
}

/** The two real states written before `roles` existed at all. */
for (const name of ['oldest-planning', 'stalled-planning'] as const) {
  test(`${name} has no roles key, loads with no repair, and falls back to the default table`, () => {
    const { state, stored } = loadFixture(name);
    const cfg = storedConfig(stored);

    // The premise, asserted rather than assumed: if a fixture is ever replaced
    // this case must fail loudly instead of passing vacuously.
    assert.equal('roles' in cfg, false, `${name} is supposed to predate the roles key`);
    assert.deepEqual(
      state.events.filter((e) => e.type === 'state_repaired'),
      [],
      'a real state file needs no repair',
    );

    const resumed = applyOverrides(state.config as Config, {});
    assert.deepEqual(rolesFor(resumed), tableFor(DEFAULT_ROLE_PROVIDERS));
    for (const role of ROLE_NAMES) assert.equal('effort' in rolesFor(resumed)[role], false);
  });
}

/** The two real states that already carry the all-strings default table. */
for (const name of ['done-pendingfindings-null', 'done-widest'] as const) {
  test(`${name} carries the string table, loads with no repair, and still resolves to it`, () => {
    const { state, stored } = loadFixture(name);
    const cfg = storedConfig(stored);

    assert.equal('roles' in cfg, true, `${name} is supposed to carry a roles table`);
    const roles = cfg['roles'] as Record<string, unknown>;
    for (const role of ROLE_NAMES) {
      assert.equal(typeof roles[role], 'string', `${name}.config.roles.${role} is a string`);
    }
    assert.deepEqual(
      state.events.filter((e) => e.type === 'state_repaired'),
      [],
      'a real state file needs no repair',
    );

    const resumed = applyOverrides(state.config as Config, {});
    assert.deepEqual(rolesFor(resumed), tableFor(DEFAULT_ROLE_PROVIDERS));
    for (const role of ROLE_NAMES) assert.equal('effort' in rolesFor(resumed)[role], false);
  });
}

// ---- 9. The resolver -------------------------------------------------------

test('effortFor returns the provider figure for a role that named none', () => {
  const cfg = turnConfig(DEFAULT_ROLE_PROVIDERS);
  for (const role of ROLE_NAMES) {
    assert.equal(effortFor(role, cfg, ROLES), cfg[ROLES[role].provider].effort);
  }
});

test('effortFor returns the role figure for a role that named one', () => {
  const cfg = turnConfig(DEFAULT_ROLE_PROVIDERS);
  const table = tableFor({
    ...DEFAULT_ROLE_PROVIDERS,
    reviewer: { provider: 'codex', effort: 'low' },
  });

  assert.equal(effortFor('reviewer', cfg, table), 'low');
  assert.equal(effortFor('critic', cfg, table), cfg.codex.effort);
  assert.equal(effortFor('implementer', cfg, table), cfg.claude.effort);
});

// ---- 10. The table is not a way round the check -----------------------------

test('tableFor refuses an effort it does not recognise, as it refuses a provider', () => {
  assert.throws(
    () =>
      tableFor({ ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', effort: 'turbo' } } as never),
    /roles\.reviewer\.effort/,
  );
  assert.throws(
    () => tableFor({ ...DEFAULT_ROLE_PROVIDERS, reviewer: { effort: 'max' } } as never),
    /provider is required/,
  );
  assert.throws(
    () => tableFor({ ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', model: 'x' } } as never),
    /roles\.reviewer\.model/,
  );
});

// ---- 11. What the run tells the user ---------------------------------------

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
 * The summary line, through the only path that prints it.
 *
 * `reportRoles` is called from `execute` and nowhere else - `vibe doctor` prints
 * its own summary and never asks about the table - so the gate and the loop are
 * injected, which is what `execute` takes them for.
 */
async function rolesLine(cfg: Config): Promise<string | undefined> {
  const state = createRun(
    mkdtempSync(path.join(tmpdir(), 'vibe-effort-summary-')),
    'per-role effort summary',
    true,
  );
  const { result, lines } = await captureLog(() =>
    execute(state, cfg, false, true, () => Promise.resolve(null), () => Promise.resolve()),
  );
  assert.equal(result, EXIT.OK);
  return lines.find((line) => line.includes('Roles:'));
}

test('the run summary names a role effort, and only where a role named one', async () => {
  // Silent under the default table, exactly as before this change.
  assert.equal(await rolesLine(turnConfig(DEFAULT_ROLE_PROVIDERS)), undefined);

  const line = await rolesLine(
    turnConfig({ ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', effort: 'max' } }),
  );

  assert.ok(line !== undefined, 'a table that names an effort is worth a line');
  assert.match(line, /reviewer=codex\/max/);
  // The provider default is not an override and must not be printed as one.
  assert.match(line, /critic=codex(?!\/)/);
  assert.doesNotMatch(line, /critic=codex\/xhigh/);
  assert.doesNotMatch(line, /planner=claude\/medium/);
  // The regression this case exists for.
  assert.doesNotMatch(line, /\[object Object\]/);
});
