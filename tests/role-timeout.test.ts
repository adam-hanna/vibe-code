import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { applyOverrides, DEFAULTS, loadConfig } from '@src/config.js';
import { runTurn } from '@src/orchestrator.js';
import type { AgentTurns, Role, RoleProviders, TurnRequest } from '@src/orchestrator.js';
import {
  DEFAULT_ROLE_PROVIDERS,
  ROLE_NAMES,
  rolesFor,
  roleSetting,
  tableFor,
  turnTimeoutMs,
} from '@src/roles.js';
import { createRun } from '@src/run.js';
import type {
  ClaudeTurnResult,
  Config,
  ConfigOverrides,
  RunState,
  TokenUsage,
} from '@src/types.js';

/**
 * How long a turn gets, per role.
 *
 * The timeout was provider-level, so two roles on one agent could not differ
 * (#84): a reviewer that needs ninety minutes dragged the critic and the
 * answerer with it, and there was no way to say so. `role-model.test.ts` and
 * `role-effort.test.ts` are this file's siblings and their structure is
 * deliberately copied, because the property is the same one - what reaches the
 * dispatch, not what the resolver returns.
 *
 * The timeout differs from the other two in what its fallback has to preserve.
 * A model or an effort falls back to one provider key; a timeout falls back to
 * one of *two*, chosen by the role's access - so section 1 enumerates every
 * role on both providers rather than sampling, and that case was written and
 * passing before the resolver learned the new key.
 *
 * Nothing is spawned. Turns are injected through the seam `runTurn` already
 * takes, and the config cases go through the real `loadConfig` and
 * `applyOverrides` against temp directories.
 *
 * Nothing cleans up its temp directory, for the reason `loop-harness.ts` gives:
 * `rmSync` over a directory a child process has just touched is a Windows flake
 * source in a suite that has to pass three times running.
 */

// ---- fixtures --------------------------------------------------------------

function seamConfig(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
    ...over,
  };
}

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-timeout-')), 'role timeout', false);
}

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

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
          structured: { findings: [] },
          raw: '{"findings":[]}',
          sessionId: 'thread-1',
          tokens: tokens(500),
        });
      },
    },
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

/** The figure a turn in this role was actually handed, through the real dispatch. */
async function dispatchedTimeout(
  role: Role,
  cfg: Config,
  over: Partial<TurnRequest> = {},
): Promise<number | undefined> {
  const rec = recorder();
  await captureLog(() => runTurn(freshState(), cfg, request(role, over), rec.turns));
  const calls: { timeoutMs: number }[] =
    rolesFor(cfg)[role].provider === 'claude' ? rec.claudeCalls : rec.codexCalls;
  return calls[0]?.timeoutMs;
}

// ---- 1. The compatibility claim, enumerated --------------------------------

/** What each role's turn was given before the selection knew about this key. */
const TODAY: Readonly<Record<Role, number>> = {
  planner: 30 * 60 * 1000,
  implementer: 90 * 60 * 1000,
  critic: 45 * 60 * 1000,
  answerer: 45 * 60 * 1000,
  reviewer: 45 * 60 * 1000,
};

/** Every role seated on one provider, as the object form with no overrides. */
function allOn(provider: 'claude' | 'codex'): RoleProviders {
  return Object.fromEntries(
    ROLE_NAMES.map((role) => [role, { provider }]),
  ) as unknown as RoleProviders;
}

test('a table naming no timeout resolves every role to the figure it gets today', () => {
  for (const role of ROLE_NAMES) {
    assert.equal(turnTimeoutMs(role, DEFAULTS), TODAY[role], `${role} keeps its timeout`);
    // And the object form saying only "provider" is the string form, which is
    // what makes the key optional rather than defaulted.
    const asObjects = Object.fromEntries(
      ROLE_NAMES.map((r) => [r, { provider: DEFAULT_ROLE_PROVIDERS[r] }]),
    ) as unknown as RoleProviders;
    assert.equal(turnTimeoutMs(role, DEFAULTS, tableFor(asObjects)), TODAY[role]);
  }
});

test('the access-based pair selection is intact for every role on both providers', () => {
  // Not a sample: the fallback has TWO provider keys per provider and the choice
  // between them is the part a per-role override could quietly have replaced.
  const onClaude = tableFor(allOn('claude'));
  const onCodex = tableFor(allOn('codex'));

  for (const role of ROLE_NAMES) {
    const writes = role === 'implementer';
    assert.equal(
      turnTimeoutMs(role, DEFAULTS, onClaude),
      writes ? DEFAULTS.claude.implementTimeoutMs : DEFAULTS.claude.planTimeoutMs,
      `${role} on claude`,
    );
    assert.equal(
      turnTimeoutMs(role, DEFAULTS, onCodex),
      writes ? DEFAULTS.codex.implementTimeoutMs : DEFAULTS.codex.timeoutMs,
      `${role} on codex`,
    );
  }
});

test('a role that named no timeout carries no timeoutMs key at all', () => {
  const table = tableFor(DEFAULT_ROLE_PROVIDERS);
  for (const role of ROLE_NAMES) {
    assert.equal('timeoutMs' in table[role], false, `${role} claims no override`);
  }
  // The absence is the fact `turnTimeoutMs` and the failure note both read, so
  // a pre-resolved figure here would make both of them lie.
  const one = tableFor({ ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', timeoutMs: 1 } });
  assert.equal('timeoutMs' in one.reviewer, true);
  assert.equal('timeoutMs' in one.critic, false);
});

// ---- 2. A per-role timeout reaches that role and no other -------------------

test('a Codex role naming a timeout moves that turn and leaves the other Codex turn alone', async () => {
  // The case #84 opens with: two Codex roles, one long turn.
  const cfg = seamConfig({
    roles: {
      ...DEFAULT_ROLE_PROVIDERS,
      reviewer: { provider: 'codex', timeoutMs: 90 * 60 * 1000 },
    },
  });

  assert.equal(await dispatchedTimeout('reviewer', cfg), 90 * 60 * 1000);
  assert.equal(await dispatchedTimeout('critic', cfg), DEFAULTS.codex.timeoutMs);
  assert.equal(await dispatchedTimeout('answerer', cfg), DEFAULTS.codex.timeoutMs);
  assert.equal(await dispatchedTimeout('planner', cfg), DEFAULTS.claude.planTimeoutMs);
  assert.equal(await dispatchedTimeout('implementer', cfg), DEFAULTS.claude.implementTimeoutMs);
});

test('a Claude role naming a timeout moves that turn and leaves the other Claude turn alone', async () => {
  const cfg = seamConfig({
    roles: {
      ...DEFAULT_ROLE_PROVIDERS,
      implementer: { provider: 'claude', timeoutMs: 5 * 60 * 1000 },
    },
  });

  assert.equal(await dispatchedTimeout('implementer', cfg), 5 * 60 * 1000);
  assert.equal(await dispatchedTimeout('planner', cfg), DEFAULTS.claude.planTimeoutMs);
  assert.equal(await dispatchedTimeout('reviewer', cfg), DEFAULTS.codex.timeoutMs);
});

test('the other two per-role keys are not dragged along by a timeout', async () => {
  const cfg = seamConfig({
    roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', timeoutMs: 1_000 } },
  });
  const rec = recorder();
  await captureLog(() => runTurn(freshState(), cfg, request('reviewer'), rec.turns));

  assert.equal(rec.codexCalls[0]?.timeoutMs, 1_000);
  assert.equal(rec.codexCalls[0]?.model, DEFAULTS.codex.model);
  assert.equal(rec.codexCalls[0]?.effort, DEFAULTS.codex.effort);
});

// ---- 3. Precedence: request, then role, then provider -----------------------

test('an explicitly requested timeout still outranks the role s own', async () => {
  const cfg = seamConfig({
    roles: {
      ...DEFAULT_ROLE_PROVIDERS,
      implementer: { provider: 'claude', timeoutMs: 5 * 60 * 1000 },
    },
  });

  assert.equal(await dispatchedTimeout('implementer', cfg, { timeoutMs: 1_234 }), 1_234);
  // And with no role override the request still wins, as it always has.
  assert.equal(await dispatchedTimeout('implementer', seamConfig(), { timeoutMs: 1_234 }), 1_234);
});

// ---- 4. What config accepts, and what it refuses ---------------------------

/** A repo directory holding this `vibe.config.json`. */
function repoWith(contents: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-timeout-cfg-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(contents), 'utf8');
  return dir;
}

/**
 * The same bad value through both entry points.
 *
 * `loadConfig` is the file path and `applyOverrides` is the resume path - the
 * one that validates a stored `state.config` - and a message only one of them
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

test('a timeout that is not a positive number is a config error naming the key', () => {
  for (const bad of [0, -1, '30m', null, [], {}, true]) {
    bothPathsReject('reviewer', { provider: 'codex', timeoutMs: bad }, /roles\.reviewer\.timeoutMs/);
  }
  // "30m" is refused rather than coerced, which is why the check tests `typeof`
  // before `Number.isFinite` - the latter does not coerce, but a check written
  // as `!(v > 0)` would have let a numeric string through.
  bothPathsReject('reviewer', { provider: 'codex', timeoutMs: '30m' }, /"30m"/);
});

test('NaN and Infinity are refused, and NaN is shown as NaN', () => {
  // Not through a config FILE: JSON has no NaN, and `JSON.stringify` would turn
  // it into `null` - a different bad value than the one under test. It still
  // reaches `loadConfig`, though, through the overrides argument every command
  // passes its flags in on, so both entry points are covered here as they are
  // in `bothPathsReject`. `roleSetting` is what all of them call.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const roles = { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', timeoutMs: bad } };
    assert.throws(
      () => applyOverrides({ ...structuredClone(DEFAULTS), roles } as unknown as Config, {}),
      /roles\.reviewer\.timeoutMs/,
      `applyOverrides: ${String(bad)}`,
    );
    assert.throws(
      () => loadConfig(repoWith({}), { roles } as unknown as ConfigOverrides),
      /roles\.reviewer\.timeoutMs/,
      `loadConfig via overrides: ${String(bad)}`,
    );
  }

  // All three, not just NaN: `JSON.stringify` renders every non-finite number as
  // `null`, because JSON has no way to write any of them. Reporting "is null"
  // sends the user looking for a null they did not write.
  for (const [bad, text] of [
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [Number.NEGATIVE_INFINITY, '-Infinity'],
  ] as const) {
    assert.throws(
      () => roleSetting('reviewer', { provider: 'codex', timeoutMs: bad }),
      new RegExp(`roles\\.reviewer\\.timeoutMs is ${text}`),
      `${text}, not "is null", which is what JSON.stringify would have said`,
    );
  }
});

test('a fractional positive is accepted, as the provider key it overrides is', async () => {
  const dir = repoWith({
    roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', timeoutMs: 1_234.5 } },
  });
  const loaded = loadConfig(dir);
  assert.equal(turnTimeoutMs('reviewer', loaded), 1_234.5);

  const cfg = seamConfig({
    roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', timeoutMs: 1_234.5 } },
  });
  assert.equal(await dispatchedTimeout('reviewer', cfg), 1_234.5);
});

test('a timeout beside a model and an effort is accepted, and all three reach the turn', async () => {
  const cfg = seamConfig({
    roles: {
      ...DEFAULT_ROLE_PROVIDERS,
      reviewer: { provider: 'codex', model: 'gpt-fixture', effort: 'low', timeoutMs: 7_000 },
    },
  });
  const rec = recorder();
  await captureLog(() => runTurn(freshState(), cfg, request('reviewer'), rec.turns));

  assert.equal(rec.codexCalls[0]?.timeoutMs, 7_000);
  assert.equal(rec.codexCalls[0]?.model, 'gpt-fixture');
  assert.equal(rec.codexCalls[0]?.effort, 'low');
});

// ---- 5. The two messages that do not update themselves ---------------------

test('an unknown key inside a role object lists all four keys', () => {
  bothPathsReject(
    'reviewer',
    { provider: 'codex', sandbox: 'danger-full-access' },
    /unknown key "sandbox"/,
    /provider, model, effort and timeoutMs/,
  );
});

test('the expected-value wording mentions the timeout, on every path that prints it', () => {
  // `expectedRoleValue`, reached by a value that is neither a provider nor an
  // object.
  bothPathsReject('reviewer', 'gemini', /optionally a model, an effort and a timeout/);

  // `tableFor`'s own, for a `roles` that is not an object at all - the shape a
  // stored `state.config` can carry, since `validateStoredState` passes that
  // field through unchecked.
  assert.throws(
    () => tableFor(null as unknown as RoleProviders),
    /optionally a model, an effort and a timeout/,
  );

  // And `validateRoles`', which is a separate copy of the same sentence.
  assert.throws(
    () => loadConfig(repoWith({ roles: 'codex' })),
    /optionally a model, an effort and a timeout/,
  );
});

test('a stored state carrying a bad timeout is reported by key, not crashed on', () => {
  // `state.config` is the one field `validateStoredState` deliberately passes
  // through unchecked, so `rolesFor` can be handed a value nothing validated.
  const stored = {
    ...DEFAULTS,
    roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', timeoutMs: -1 } },
  } as unknown as Config;
  assert.throws(() => rolesFor(stored), /roles\.reviewer\.timeoutMs/);
});

// ---- 6. What a failed turn says about where its timeout came from -----------

/** Agents that reject with the given error, whichever provider is asked. */
function rejecting(err: Error): AgentTurns {
  return {
    claude: () => Promise.reject(err),
    codex: () => Promise.reject(err),
  };
}

function failedTurn(cfg: Config, role: Role, err: Error, over: Partial<TurnRequest> = {}): Promise<unknown> {
  return runTurn(freshState(), cfg, request(role, over), rejecting(err)).then(
    () => null,
    (e: unknown) => e,
  );
}

test('a turn that fails under a per-role timeout names the setting that chose it', async () => {
  const cfg = seamConfig({
    roles: {
      ...DEFAULT_ROLE_PROVIDERS,
      reviewer: { provider: 'codex', timeoutMs: 90 * 60 * 1000 },
    },
  });
  const err = new Error('codex timed out after 5400000ms');

  const thrown = await failedTurn(cfg, 'reviewer', err);

  // The same object: `charge.ts` keys a failed turn's spend on identity, and
  // cli.ts's handler tests `instanceof`.
  assert.equal(thrown, err);
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /roles\.reviewer\.timeoutMs = 5400000/);
  // A bare number, no unit: the key names the unit, and proc.ts's own "ms" is
  // already in the same message.
  assert.doesNotMatch(thrown.message, /timeoutMs = 5400000ms/);
  assert.doesNotMatch(thrown.message, /codex\.timeoutMs/, 'not the key the user did not write');
  // Once, and on the stack's first line too - which is what cli.ts prints.
  assert.equal(thrown.message.match(/roles\.reviewer\.timeoutMs/g)?.length, 1, thrown.message);
  const first = String(thrown.stack).split('\n')[0] ?? '';
  assert.equal(first.match(/roles\.reviewer\.timeoutMs/g)?.length, 1, first);
});

test('a run that names no per-role setting has its failure text unchanged', async () => {
  const err = new Error('codex timed out after 2700000ms');

  const thrown = await failedTurn(seamConfig(), 'reviewer', err);

  assert.ok(thrown instanceof Error);
  assert.equal(
    thrown.message,
    'codex timed out after 2700000ms',
    'byte-identical to what it says today',
  );
  assert.doesNotMatch(String(thrown.stack), /this turn ran/);
});

test('a role naming a model but no timeout still gets exactly the one note', async () => {
  const cfg = seamConfig({
    roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', model: 'bogus-codex' } },
  });
  const err = new Error('unknown model');

  const thrown = await failedTurn(cfg, 'reviewer', err);

  assert.ok(thrown instanceof Error);
  assert.equal(
    thrown.message,
    'unknown model [this turn ran roles.reviewer.model = "bogus-codex"]',
    'the #60 note, unchanged',
  );
});

test('a role naming both gets both notes, once each, message and stack', async () => {
  const cfg = seamConfig({
    roles: {
      ...DEFAULT_ROLE_PROVIDERS,
      reviewer: { provider: 'codex', model: 'bogus-codex', timeoutMs: 1_000 },
    },
  });
  // The real V8 behaviour, modelled as `role-model.test.ts` models it: `stack`
  // is formatted on first access from the message *as it stands then*, so an
  // error whose stack nothing has touched comes back already carrying anything
  // written to the message first. Under `node --test` the runner has already
  // materialised a plain Error's stack, so only this fixture can reproduce it.
  const err = new Error('boom');
  let assigned: string | undefined;
  Object.defineProperty(err, 'stack', {
    configurable: true,
    get(): string {
      return assigned ?? `Error: ${err.message}\n    at fixture`;
    },
    set(value: string) {
      assigned = value;
    },
  });

  const thrown = await failedTurn(cfg, 'reviewer', err);

  assert.ok(thrown instanceof Error);
  assert.equal(
    thrown.message,
    'boom [this turn ran roles.reviewer.model = "bogus-codex"] ' +
      '[this turn ran roles.reviewer.timeoutMs = 1000]',
  );
  const first = String(thrown.stack).split('\n')[0] ?? '';
  assert.equal(first.match(/roles\.reviewer\.model/g)?.length, 1, first);
  assert.equal(first.match(/roles\.reviewer\.timeoutMs/g)?.length, 1, first);
});

test('an explicitly requested timeout produces no note about the role s', async () => {
  // The turn did not run under `roles.reviewer.timeoutMs`, so saying it did
  // would send the user to edit a line that had no effect - the failure the
  // note exists to prevent, committed by the note.
  const cfg = seamConfig({
    roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', timeoutMs: 90 * 60 * 1000 } },
  });
  const err = new Error('codex timed out after 1234ms');

  const thrown = await failedTurn(cfg, 'reviewer', err, { timeoutMs: 1_234 });

  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, 'codex timed out after 1234ms');
});
