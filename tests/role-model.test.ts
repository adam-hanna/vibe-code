import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { applyOverrides, DEFAULTS, loadConfig } from '@src/config.js';
import { shouldRotate } from '@src/context.js';
import { orchestrate, runTurn } from '@src/orchestrator.js';
import type { AgentTurns, Role, RoleProviders, TurnRequest } from '@src/orchestrator.js';
import { progressOptions, rememberContextWindow } from '@src/progress.js';
import {
  DEFAULT_ROLE_PROVIDERS,
  effortFor,
  modelFor,
  modelSource,
  ROLE_NAMES,
  roleWarnings,
  rolesFor,
  tableFor,
} from '@src/roles.js';
import { createRun, loadRun, recordContextMeasurement, saveState } from '@src/run.js';
import { validateStoredState } from '@src/stored.js';
import { attachSpend, spendOf } from '@src/charge.js';
import type { Config, ContextUsage, RunState, TokenUsage } from '@src/types.js';
import {
  agents,
  committing,
  config as loopConfig,
  freshRun,
  p1,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * The model a turn actually runs, per role.
 *
 * Model was provider-level, so two roles on one agent could not differ (#60):
 * a `gpt-5.6-pro` reviewer dragged the critic and the answerer with it, and a
 * cheaper implementer was not expressible at all. `role-effort.test.ts` is the
 * sibling of this file and its structure is deliberately copied, because the
 * property under test is the same one: what reaches the dispatch, not what the
 * resolver returns.
 *
 * Model differs from effort in one way that most of this file is about. An
 * effort is only ever handed to a spawn; a model is *also* what a context
 * measurement is attributed to and what a rotation decision is made against, so
 * a per-role model has to reach three places for one role and none of them for
 * any other. The rotation cases below are the ones that would catch a run that
 * started compacting at every turn boundary, or stopped compacting at all.
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
  model: string;
  effort: string;
}

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

function recording(handlers: Handlers): { turns: AgentTurns; seen: Dispatched[] } {
  const seen: Dispatched[] = [];
  const inner = agents(
    {
      claude: (label, options) => {
        seen.push({ label, provider: 'claude', model: options.model, effort: options.effort });
        return handlers.claude?.(label, options) ?? 'claude said so';
      },
      codex: (label, options) => {
        seen.push({ label, provider: 'codex', model: options.model, effort: options.effort });
        return handlers.codex?.(label, options) ?? report([]);
      },
      ...(handlers.usage === undefined ? {} : { usage: handlers.usage }),
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
async function fullPass(
  over: Partial<Config> = {},
  handlers?: (state: RunState) => Handlers,
): Promise<{ seen: Dispatched[]; state: RunState }> {
  const state = freshRun({
    prefix: 'vibe-model-',
    task: 'per-role model',
    planOnly: false,
    git: true,
    commit: true,
  });
  const rec = recording((handlers ?? passing)(state));
  await orchestrate(
    state,
    loopConfig({}, { ...committing(), ...verifying(state), ...over }),
    false,
    rec.turns,
  );
  assert.equal(state.status, 'done', 'the run under test has to have finished');
  return { seen: rec.seen, state };
}

// ---- 1. The compatibility claim, asserted directly --------------------------

test('a table naming no per-role model resolves every role to its provider s model', () => {
  const cfg = DEFAULTS;
  for (const role of ROLE_NAMES) {
    const provider = DEFAULT_ROLE_PROVIDERS[role];
    assert.equal(
      modelFor(role, cfg),
      cfg[provider].model,
      `${role} runs ${provider}.model when it names nothing`,
    );
    // And the object form saying only "provider" is the string form, which is
    // what makes the key optional rather than defaulted.
    const asObjects = Object.fromEntries(
      ROLE_NAMES.map((r) => [r, { provider: DEFAULT_ROLE_PROVIDERS[r] }]),
    ) as unknown as RoleProviders;
    assert.equal(modelFor(role, cfg, tableFor(asObjects)), cfg[provider].model);
  }
});

test('a full pass under the default table dispatches each provider s model, unchanged', async () => {
  const { seen } = await fullPass();

  assert.deepEqual(
    seen.map((d) => d.label),
    ['plan', 'critique-0', 'implement', 'review-0'],
    'the phase order is the one this run has always had',
  );
  // The concrete strings, not just "the provider's": a change to DEFAULTS
  // cannot make this vacuously true.
  assert.deepEqual(
    seen.map((d) => d.model),
    [DEFAULTS.claude.model, DEFAULTS.codex.model, DEFAULTS.claude.model, DEFAULTS.codex.model],
  );
});

test('the object form naming only a provider dispatches the identical models', async () => {
  const asObjects = Object.fromEntries(
    ROLE_NAMES.map((role) => [role, { provider: DEFAULT_ROLE_PROVIDERS[role] }]),
  ) as unknown as RoleProviders;

  const strings = await fullPass();
  const objects = await fullPass({ roles: asObjects });

  assert.deepEqual(
    objects.seen.map((d) => `${d.label}:${d.model}`),
    strings.seen.map((d) => `${d.label}:${d.model}`),
    'string form and object-with-no-model are the same run',
  );
});

test('the progress window and the rotation decision default to what they read before', () => {
  const cfg: Config = { ...DEFAULTS, progress: { ...DEFAULTS.progress, enabled: true } };
  const state = createRun(mkdtempSync(path.join(tmpdir(), 'vibe-model-win-')), 'window', false);
  rememberContextWindow(cfg.claude.model, 200_000);

  // progressOptions' default argument IS cfg.claude.model, so a caller passing
  // nothing gets the identical window - which is what keeps every existing call
  // site rendering what it renders today.
  assert.equal(
    progressOptions(state, cfg, 'plan')?.contextWindow,
    progressOptions(state, cfg, 'plan', cfg.claude.model)?.contextWindow,
  );
  assert.equal(progressOptions(state, cfg, 'plan')?.contextWindow, 200_000);

  const rotating: Config = { ...cfg, context: { ...cfg.context, enabled: true } };
  const measured = { ...state, sessionStarted: true } as RunState;
  recordContextMeasurement(measured, cfg.claude.model, 0.9, 200_000);
  assert.equal(shouldRotate(measured, rotating), true);
  assert.equal(
    shouldRotate(measured, rotating),
    shouldRotate(measured, rotating, rolesFor(rotating), cfg.claude.model),
  );

  const foreign = { ...state, sessionStarted: true } as RunState;
  recordContextMeasurement(foreign, 'some-other-model', 0.1, 1_000_000);
  assert.equal(shouldRotate(foreign, rotating), true, 'unattributable, so one baseline rotation');
  assert.equal(
    shouldRotate(foreign, rotating),
    shouldRotate(foreign, rotating, rolesFor(rotating), cfg.claude.model),
  );
});

// ---- 2. A per-role model reaches that role and no other ---------------------

test('a Codex role naming a model moves that turn and leaves the other Codex turn alone', async () => {
  const { seen } = await fullPass({
    roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', model: 'gpt-fixture' } },
  });

  const by = (label: string): Dispatched | undefined => seen.find((d) => d.label === label);
  assert.equal(by('review-0')?.model, 'gpt-fixture');
  assert.equal(by('critique-0')?.model, DEFAULTS.codex.model, 'the critic did not move');
  assert.equal(by('plan')?.model, DEFAULTS.claude.model);
  assert.equal(by('implement')?.model, DEFAULTS.claude.model);
  // Effort is a separate key and must not have been dragged along.
  assert.equal(by('review-0')?.effort, DEFAULTS.codex.effort);
});

test('a Claude role naming a model moves that turn and leaves the other Claude turn alone', async () => {
  const { seen } = await fullPass({
    roles: {
      ...DEFAULT_ROLE_PROVIDERS,
      implementer: { provider: 'claude', model: 'sonnet-fixture' },
    },
  });

  const by = (label: string): Dispatched | undefined => seen.find((d) => d.label === label);
  assert.equal(by('implement')?.model, 'sonnet-fixture');
  assert.equal(by('plan')?.model, DEFAULTS.claude.model, 'the planner did not move');
  assert.equal(by('critique-0')?.model, DEFAULTS.codex.model);
  assert.equal(by('implement')?.effort, DEFAULTS.claude.effort);
});

test('the measurement is attributed to the role s own model, not the provider s', async () => {
  const usage: ContextUsage = { promptTokens: 20_000, contextWindow: 200_000, ratio: 0.1 };
  const { state } = await fullPass(
    { roles: { ...DEFAULT_ROLE_PROVIDERS, implementer: { provider: 'claude', model: 'sonnet-fixture' } } },
    (s) => ({ ...passing(s), usage: () => usage }),
  );

  // The last Claude turn of the run is the implementer's, so the stored
  // measurement is tagged with the model that produced it - which is the whole
  // reason the rotation below settles rather than storming.
  assert.equal(state.contextModel, 'sonnet-fixture');
});

// ---- 3. Two models on the main conversation ---------------------------------

/** A measured turn, at a ratio far below any threshold these cases set. */
const SMALL: ContextUsage = { promptTokens: 20_000, contextWindow: 200_000, ratio: 0.1 };

/** Context on, with a threshold no measured turn here can reach. */
function rotatable(): Partial<Config> {
  return {
    context: {
      ...DEFAULTS.context,
      enabled: true,
      compactAboveRatio: 0.9,
      // The concurrent path has its own wrapper and its own tests; these cases
      // are about the turn boundary, where a model switch is actually seen.
      compactDuringCodex: false,
    },
  };
}

function compactions(seen: readonly Dispatched[]): Dispatched[] {
  return seen.filter((d) => d.label === 'compact');
}

test('two models on the main conversation rotate once at the switch, then settle', async () => {
  const { seen, state } = await fullPass(
    {
      ...rotatable(),
      roles: {
        ...DEFAULT_ROLE_PROVIDERS,
        planner: { provider: 'claude', model: 'model-a' },
        implementer: { provider: 'claude', model: 'model-b' },
      },
    },
    (s) => ({ ...passing(s), usage: () => SMALL }),
  );

  assert.deepEqual(
    compactions(seen).length,
    1,
    `exactly one rotation, at the switch: ${seen.map((d) => d.label).join(', ')}`,
  );
  assert.equal(state.sessionRotations, 1);
  // Where it sits: after the planner's turns, immediately before the first
  // implementer turn - the boundary at which the model changes.
  const labels = seen.map((d) => d.label);
  assert.equal(labels[labels.indexOf('compact') + 1], 'implement');
  // And the fresh conversation is tagged with the model about to grow it.
  assert.equal(state.contextModel, 'model-b');
});

test('a fix round after the switch does not rotate again', async () => {
  // The settling claim, and the case that catches a run rotating at every turn
  // boundary: `implement` runs twice, both under model-b, and the second must
  // find a measurement it can read.
  let reviews = 0;
  const { seen, state } = await fullPass(
    {
      ...rotatable(),
      roles: {
        ...DEFAULT_ROLE_PROVIDERS,
        planner: { provider: 'claude', model: 'model-a' },
        implementer: { provider: 'claude', model: 'model-b' },
      },
    },
    (s) => ({
      claude: (label) =>
        label === 'plan' || label.startsWith('revise-') ? planFixture() : work(s, `${label}.txt`),
      codex: (label) => {
        if (!label.startsWith('review-')) return report([]);
        reviews += 1;
        return reviews === 1 ? report([p1('needs-a-fix')]) : report([]);
      },
      usage: () => SMALL,
    }),
  );

  const labels = seen.map((d) => d.label);
  // Two implementer turns under model-b: the implementation and the fix round
  // the P1 above bought. The second is the one a per-turn rotation would show.
  assert.ok(
    labels.filter((l) => l === 'implement' || l.includes('fix-')).length >= 2,
    labels.join(', '),
  );
  assert.equal(compactions(seen).length, 1, labels.join(', '));
  assert.equal(state.sessionRotations, 1);
});

test('two roles naming the same model, and the default table, never rotate', async () => {
  for (const roles of [
    {
      ...DEFAULT_ROLE_PROVIDERS,
      planner: { provider: 'claude' as const, model: 'model-a' },
      implementer: { provider: 'claude' as const, model: 'model-a' },
    },
    DEFAULT_ROLE_PROVIDERS,
  ]) {
    const { seen, state } = await fullPass({ ...rotatable(), roles }, (s) => ({
      ...passing(s),
      usage: () => SMALL,
    }));
    assert.equal(compactions(seen).length, 0, seen.map((d) => d.label).join(', '));
    assert.equal(state.sessionRotations, 0);
  }
});

// ---- 4. Config errors -------------------------------------------------------

const repoWith = (config: object): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-model-cfg-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(config), 'utf8');
  return dir;
};

/**
 * Both readers of a role value have to reject it: the file on the way in, and
 * `applyOverrides` on the resume path, which is the one that reads the
 * `state.config` `validateStoredState` deliberately passes through unchecked.
 */
function bothPathsReject(role: Role, value: unknown, ...expected: RegExp[]): void {
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

test('a model that is not a non-empty string is a config error naming the path', () => {
  for (const bad of [123, null, '', '   ', {}, []]) {
    bothPathsReject('reviewer', { provider: 'codex', model: bad }, /roles\.reviewer\.model/);
  }
  // And it says what a model has to be, rather than only that this is not one.
  bothPathsReject('reviewer', { provider: 'codex', model: '' }, /non-empty/);
});

test('a legal model is accepted on trust, with no allowlist to be on', () => {
  const cfg = loadConfig(
    repoWith({
      roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', model: 'not-a-real-model' } },
    }),
  );

  assert.equal(modelFor('reviewer', cfg), 'not-a-real-model');
  assert.equal(modelFor('critic', cfg), DEFAULTS.codex.model);
});

// ---- 5. Absent, not undefined ----------------------------------------------

test('a role that named no model carries no model key at all', () => {
  const table = tableFor(DEFAULT_ROLE_PROVIDERS);
  for (const role of ROLE_NAMES) {
    assert.equal('model' in table[role], false, `${role} claims no override`);
  }

  const one = tableFor({
    ...DEFAULT_ROLE_PROVIDERS,
    critic: { provider: 'codex', model: 'gpt-fixture' },
  });
  const round = JSON.parse(JSON.stringify(one)) as Record<Role, { model?: string }>;
  assert.deepEqual(
    ROLE_NAMES.filter((role) => 'model' in round[role]),
    ['critic'],
    'exactly the role that named one, across the JSON state.json goes through',
  );
});

// ---- 6. What a 1.1.0 run loads ---------------------------------------------

test('a 1.1.0 config and a 1.1.0 state.json load unchanged', () => {
  // The string form is what every config predating #46 contains, and the object
  // form without a model is what one written by #46 contains. Neither may move.
  const dir = repoWith({ roles: { ...DEFAULT_ROLE_PROVIDERS } });
  const cfg = loadConfig(dir);
  for (const role of ROLE_NAMES) {
    assert.equal(modelFor(role, cfg), cfg[DEFAULT_ROLE_PROVIDERS[role]].model);
    assert.equal(effortFor(role, cfg), cfg[DEFAULT_ROLE_PROVIDERS[role]].effort);
  }

  const state = createRun(mkdtempSync(path.join(tmpdir(), 'vibe-model-state-')), 'legacy', false);
  state.config = { ...structuredClone(DEFAULTS), roles: { ...DEFAULT_ROLE_PROVIDERS } };
  saveState(state);
  // Through the real resume path: `loadRun` reads and validates what was
  // written, and `applyOverrides` is what checks the `state.config` that
  // validation deliberately passes through.
  const reloaded = loadRun(state.targetDir, state.id);
  const applied = applyOverrides(reloaded.config as Config, {});
  assert.equal(modelFor('reviewer', applied), DEFAULTS.codex.model);
  assert.equal(
    validateStoredState(JSON.parse(JSON.stringify(reloaded)), state.id, state.dir).state.id,
    state.id,
  );

  // And a state.config carrying the new key round-trips through the same path.
  const withModel = applyOverrides(
    {
      ...structuredClone(DEFAULTS),
      roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', model: 'gpt-fixture' } },
    } as unknown as Config,
    {},
  );
  assert.equal(modelFor('reviewer', withModel), 'gpt-fixture');
});

// ---- 7. The Decision 4 warning ---------------------------------------------

const codexModels = (over: Partial<Config>): string[] =>
  roleWarnings({ ...DEFAULTS, ...over } as Config).filter((w) => /codex\.contextWindow \(/.test(w));

test('two Codex models under one codex.contextWindow are warned about', () => {
  const warned = codexModels({
    codex: { ...DEFAULTS.codex, contextWindow: 272_000 },
    roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', model: 'gpt-fixture' } },
  });

  assert.equal(warned.length, 1, warned.join('\n'));
  assert.match(warned[0] ?? '', /gpt-fixture/);
  assert.match(warned[0] ?? '', /roles\.reviewer/);
  assert.match(warned[0] ?? '', new RegExp(DEFAULTS.codex.model));
});

test('the two-models warning fires on its condition and on nothing else', () => {
  // No window: nothing is measured against anything, which W2/W3 already say.
  assert.deepEqual(
    codexModels({
      codex: { ...DEFAULTS.codex, contextWindow: null },
      roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', model: 'gpt-fixture' } },
    }),
    [],
  );
  // One model, however it is written: no misdescription to report.
  assert.deepEqual(
    codexModels({
      codex: { ...DEFAULTS.codex, contextWindow: 272_000 },
      roles: {
        ...DEFAULT_ROLE_PROVIDERS,
        critic: { provider: 'codex', model: DEFAULTS.codex.model },
      },
    }),
    [],
  );
  // The differing role never takes a turn, so no second conversation exists.
  assert.deepEqual(
    codexModels({
      codex: { ...DEFAULTS.codex, contextWindow: 272_000 },
      questions: { ...DEFAULTS.questions, askCodex: false },
      roles: { ...DEFAULT_ROLE_PROVIDERS, answerer: { provider: 'codex', model: 'gpt-fixture' } },
    }),
    [],
  );
  // A per-role model on the Claude side says nothing about the Codex window.
  assert.deepEqual(
    codexModels({
      codex: { ...DEFAULTS.codex, contextWindow: 272_000 },
      roles: { ...DEFAULT_ROLE_PROVIDERS, implementer: { provider: 'claude', model: 'sonnet-fixture' } },
    }),
    [],
  );
  // And the default table, with a window set, is silent.
  assert.deepEqual(codexModels({ codex: { ...DEFAULTS.codex, contextWindow: 272_000 } }), []);
});

// ---- 8. What a failed turn says about where its model came from -------------

function request(role: Role, over: Partial<TurnRequest> = {}): TurnRequest {
  return { role, prompt: 'do the thing', cwd: process.cwd(), label: 'fixture-0', timeoutMs: 1_000, ...over };
}

function seamConfig(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
    ...over,
  };
}

/** Agents that reject with the given error, whichever provider is asked. */
function rejecting(err: Error): AgentTurns {
  return {
    claude: () => Promise.reject(err),
    codex: () => Promise.reject(err),
  };
}

function seamState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-model-fail-')), 'failure', false);
}

test('a turn that fails under a per-role model names the setting that chose it', async () => {
  const cfg = seamConfig({
    roles: { ...DEFAULT_ROLE_PROVIDERS, implementer: { provider: 'claude', model: 'bogus-model' } },
  });
  const err = new Error('model not found');
  attachSpend(err, { tokens: 400, costUsd: 0.01 });
  assert.notEqual(spendOf(err), null, 'the spend is on the error before dispatch');
  const state = seamState();

  const thrown = await runTurn(state, cfg, request('implementer'), rejecting(err)).then(
    () => null,
    (e: unknown) => e,
  );

  // The same object: `charge.ts` keys a failed turn's spend on identity, and
  // cli.ts's handler tests `instanceof`.
  assert.equal(thrown, err);
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /roles\.implementer\.model/);
  assert.match(thrown.message, /bogus-model/);
  assert.doesNotMatch(thrown.message, /claude\.model/, 'not the key the user did not write');
  // The stack too, because that is what cli.ts prints - and exactly once. V8
  // builds `stack` lazily from the message as it stands at first access, so a
  // note written to the message *before* the stack is read comes back already
  // present and gets a second copy appended. That is not hypothetical: it is
  // what this did until the read was moved ahead of the write.
  const first = String(thrown.stack).split('\n')[0] ?? '';
  assert.match(first, /model not found/);
  assert.equal(
    first.match(/roles\.implementer\.model/g)?.length,
    1,
    `the note appears once on the stack's first line: ${first}`,
  );
  assert.equal(thrown.message.match(/roles\.implementer\.model/g)?.length, 1, thrown.message);
  // What the spend does is asserted where it lands, not on the error. It rode
  // the failure into `withRateLimitRetry`, which charged it through
  // `chargeFailure` - and `takeSpend` *deletes* as it reads, so a second frame
  // that knows how to pay cannot charge it twice. `spendOf` is therefore null
  // by the time this sees the error, and asserting otherwise would be asserting
  // a double-charge. The record of it is the event and the totals.
  assert.equal(spendOf(thrown), null, 'consumed by the charge, not still owed');
  const failed = state.events.filter((e) => e.type === 'turn_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.['tokens'], 400);
  assert.equal(state.tokensUsed, 400);
});

test('a lazily formatted stack gets the note once, not twice', async () => {
  // The real V8 behaviour, modelled: `stack` is formatted on first access from
  // the message *as it stands then*, so an error whose stack nothing has
  // touched comes back already carrying a note written to the message first.
  // A throwaway script against dist/ printed the note twice on that line; under
  // `node --test` the runner has already materialised the stack, so a plain
  // `new Error` cannot reproduce it and this fixture is what pins the fix.
  const err = new Error('model not found');
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

  const cfg = seamConfig({
    roles: { ...DEFAULT_ROLE_PROVIDERS, implementer: { provider: 'claude', model: 'bogus-model' } },
  });
  const thrown = await runTurn(seamState(), cfg, request('implementer'), rejecting(err)).then(
    () => null,
    (e: unknown) => e,
  );

  const first = String((thrown as Error).stack).split('\n')[0] ?? '';
  assert.equal(first.match(/bogus-model/g)?.length, 1, first);
});

test('the same failure on a Codex role names the Codex role s setting', async () => {
  const cfg = seamConfig({
    roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', model: 'bogus-codex' } },
  });
  const err = new Error('unknown model');

  const thrown = await runTurn(seamState(), cfg, request('reviewer'), rejecting(err)).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /roles\.reviewer\.model/);
  assert.doesNotMatch(thrown.message, /codex\.model/);
});

test('a run that names no per-role model has its failure text unchanged', async () => {
  const err = new Error('model not found');

  const thrown = await runTurn(seamState(), seamConfig(), request('implementer'), rejecting(err)).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, 'model not found', 'byte-identical to what it says today');
  assert.doesNotMatch(String(thrown.stack), /this turn ran/);
});

test('modelSource names the provider key only where the role named nothing', () => {
  const table = tableFor({
    ...DEFAULT_ROLE_PROVIDERS,
    reviewer: { provider: 'codex', model: 'gpt-fixture' },
  });

  assert.equal(modelSource('reviewer', table), 'roles.reviewer.model');
  assert.equal(modelSource('critic', table), 'codex.model');
  assert.equal(modelSource('implementer', table), 'claude.model');
});

// ---- 9. The turn options a case above did not read --------------------------

test('a per-role model is what the dispatch is actually given, both providers', async () => {
  const claudeCalls: ClaudeTurnOptions[] = [];
  const codexCalls: CodexTurnOptions[] = [];
  const turns: AgentTurns = {
    claude: (options) => {
      claudeCalls.push(options);
      return Promise.resolve({
        text: 'ok',
        costUsd: 0.01,
        sessionId: options.sessionId,
        denials: [],
        numTurns: 1,
        usage: null,
        tokens: tokens(10),
      });
    },
    codex: (options) => {
      codexCalls.push(options);
      return Promise.resolve({
        structured: { verdict: 'APPROVE', summary: 's', findings: [] },
        raw: '{}',
        sessionId: 'thread-1',
        tokens: tokens(10),
      });
    },
  };
  const cfg = seamConfig({
    roles: {
      ...DEFAULT_ROLE_PROVIDERS,
      implementer: { provider: 'claude', model: 'sonnet-fixture' },
      reviewer: { provider: 'codex', model: 'gpt-fixture' },
    },
  });
  const state = seamState();

  await runTurn(state, cfg, request('planner'), turns);
  await runTurn(state, cfg, request('implementer'), turns);
  await runTurn(state, cfg, request('critic'), turns);
  await runTurn(state, cfg, request('reviewer'), turns);

  assert.deepEqual(
    claudeCalls.map((c) => c.model),
    [DEFAULTS.claude.model, 'sonnet-fixture'],
  );
  assert.deepEqual(
    codexCalls.map((c) => c.model),
    [DEFAULTS.codex.model, 'gpt-fixture'],
  );
});
