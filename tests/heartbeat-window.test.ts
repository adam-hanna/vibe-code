import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '@src/config.js';
import { orchestrate } from '@src/orchestrator.js';
import type { AgentTurns } from '@src/orchestrator.js';
import {
  emptySnapshot,
  formatHeartbeat,
  parseCodexLine,
  progressOptions,
  rememberContextWindow,
} from '@src/progress.js';
import type { ProgressOptions } from '@src/progress.js';
import { DEFAULT_ROLE_PROVIDERS } from '@src/roles.js';
import type { Config, RunState } from '@src/types.js';
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
 * Whose context window a turn's heartbeat is offered (#86).
 *
 * `codexDispatch` used to ask `progressOptions` for a window without naming a
 * model, and the parameter defaulted to `cfg.claude.model` - so every Codex turn
 * was handed *Claude's* window as its denominator.
 *
 * **Nothing wrong was ever printed, and that is why this file asserts on inputs
 * rather than on rendered lines.** Census of the 15 archived runs, 2026-08-27:
 * 2,480 heartbeat lines, of which 1,270 are Codex turns (`critique-`, `review-`,
 * `answers-`) and **not one** carries a `ctx%` segment. `formatHeartbeat` gates
 * that segment on `promptTokens > 0`; `parseCodexLine` never sets `promptTokens`
 * because Codex reports usage only at `turn.completed`, the end of the turn.
 * The wrong denominator was delivered on every Codex turn and would have
 * rendered the moment a numerator existed - `ctx 210%` on a real critique turn.
 * A rendered line therefore cannot tell the fix from the bug; the options object
 * the heartbeat is handed can, and does (`trap-disarmed` below).
 *
 * The second half of the fix is the *provider*. Both window sources - the
 * in-process map behind `rememberContextWindow` and the persisted
 * `contextModel`/`contextWindow` pair - hold Claude measurements keyed by a bare
 * model name, and config permits `claude.model` and a Codex role's model to be
 * the same string (`roles.<role>.model` is checked only for being a non-empty
 * name; see `RoleSetting.model` in src/roles.ts). Naming the model alone would
 * still hand that config a Claude window on a Codex turn.
 *
 * Nothing is spawned: turns are injected through the seam `orchestrate` takes.
 * Nothing cleans up its temp directory, for the reason `loop-harness.ts` gives.
 */

// ---- recording what each turn's heartbeat was offered ----------------------

interface Offered {
  label: string;
  provider: 'claude' | 'codex';
  progress: ProgressOptions | undefined;
}

/** As `role-model.test.ts` records models; this records the progress options. */
function recording(handlers: Handlers): { turns: AgentTurns; seen: Offered[] } {
  const seen: Offered[] = [];
  const inner = agents(
    {
      claude: (label, options) => {
        seen.push({ label, provider: 'claude', progress: options.progress });
        return handlers.claude?.(label, options) ?? 'claude said so';
      },
      codex: (label, options) => {
        seen.push({ label, provider: 'codex', progress: options.progress });
        return handlers.codex?.(label, options) ?? report([]);
      },
    },
    [],
  );
  return { turns: inner, seen };
}

function passing(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

/** One whole run - plan, critique, implement, verify, review - and what it offered. */
async function fullPass(over: Partial<Config> = {}, prefix = 'vibe-hb-win-'): Promise<Offered[]> {
  const state = freshRun({
    prefix,
    task: 'heartbeat window',
    planOnly: false,
    git: true,
    commit: true,
  });
  const rec = recording(passing(state));
  await orchestrate(state, loopConfig({}, { ...committing(), ...verifying(state), ...over }), false, rec.turns);
  assert.equal(state.status, 'done', 'the run under test has to have finished');
  return rec.seen;
}

function codexTurns(seen: Offered[]): Offered[] {
  const turns = seen.filter((t) => t.provider === 'codex');
  assert.ok(turns.length > 0, 'the pass has to have dispatched a Codex turn');
  return turns;
}

function claudeTurns(seen: Offered[]): Offered[] {
  const turns = seen.filter((t) => t.provider === 'claude');
  assert.ok(turns.length > 0, 'the pass has to have dispatched a Claude turn');
  return turns;
}

/**
 * Key presence, not `=== undefined`: `progressOptions` omits the key entirely
 * under `exactOptionalPropertyTypes`, and a regression that set an explicit
 * `undefined` would still be a caller having resolved a window it should not
 * have asked for.
 */
function assertNoWindow(turn: Offered): void {
  assert.ok(turn.progress !== undefined, `${turn.label} had no progress options at all`);
  assert.equal(
    'contextWindow' in turn.progress,
    false,
    `${turn.label} was offered a context window: ${JSON.stringify(turn.progress.contextWindow)}`,
  );
}

// ---- 1. the defect itself --------------------------------------------------

test('a Codex turn is offered no context window, and the Claude turns still are', async () => {
  // A window measured in this process under the Claude model, which is the
  // condition that used to arm the trap: with none, the Codex path resolved
  // undefined for the wrong reason.
  rememberContextWindow(DEFAULTS.claude.model, 200_000);

  const seen = await fullPass();

  for (const turn of codexTurns(seen)) assertNoWindow(turn);
  for (const turn of claudeTurns(seen)) {
    assert.equal(turn.progress?.contextWindow, 200_000, `${turn.label} lost its own window`);
  }
});

test('codex.contextWindow is not the heartbeat s denominator either', async () => {
  // The setting exists for the turn-completion detail line, which has a real
  // numerator (`turn.completed`'s input_tokens). The heartbeat has none, so a
  // window here would be the top half of a fraction that cannot be computed.
  // Two Codex roles on two different models at the same time: neither gets one.
  const seen = await fullPass(
    {
      codex: { ...DEFAULTS.codex, contextWindow: 400_000 },
      roles: { ...DEFAULT_ROLE_PROVIDERS, reviewer: { provider: 'codex', model: 'gpt-fixture' } },
    },
    'vibe-hb-win-set-',
  );

  for (const turn of codexTurns(seen)) assertNoWindow(turn);
});

test('a Codex role sharing Claude s model name is still offered no window', async () => {
  // The configuration is legal: `roles.<role>.model` is validated only as a
  // non-empty string, and `claude.model` is an independent key - one proxy
  // fronting both CLIs under one name is the obvious way to arrive here. Both
  // window sources are keyed by a bare model name, so naming the model alone
  // would hand this run's Claude measurement to its Codex turns. The provider is
  // what makes the answer attributable.
  rememberContextWindow('shared-name', 200_000);

  const seen = await fullPass(
    {
      claude: { ...DEFAULTS.claude, model: 'shared-name' },
      roles: {
        ...DEFAULT_ROLE_PROVIDERS,
        // The two Codex-seated roles a clean pass dispatches. `judge` is a slot
        // name, not a role, and config refuses it.
        critic: { provider: 'codex', model: 'shared-name' },
        reviewer: { provider: 'codex', model: 'shared-name' },
      },
    },
    'vibe-hb-win-shared-',
  );

  for (const turn of codexTurns(seen)) assertNoWindow(turn);
  for (const turn of claudeTurns(seen)) {
    assert.equal(turn.progress?.contextWindow, 200_000, `${turn.label} lost its own window`);
  }
});

// ---- 2. the trap, armed and fired ------------------------------------------

test('a Codex heartbeat renders no ctx% even when a numerator exists', async () => {
  // The one case here that fails on develop. Codex supplies no `promptTokens`
  // today, so the rendered line is identical either way (below); this asks what
  // the line WOULD say the day it does, which is the whole of the defect.
  rememberContextWindow(DEFAULTS.claude.model, 200_000);
  const withNumerator = {
    ...emptySnapshot(),
    activities: 4,
    lastActivity: 'agent_message',
    tokens: 429_000,
    promptTokens: 420_000,
  };

  for (const prefix of ['vibe-hb-win-trap-', 'vibe-hb-win-trap-shared-']) {
    const shared = prefix.endsWith('shared-');
    if (shared) rememberContextWindow('shared-trap', 200_000);
    const seen = await fullPass(
      shared
        ? {
            claude: { ...DEFAULTS.claude, model: 'shared-trap' },
            roles: {
              ...DEFAULT_ROLE_PROVIDERS,
              critic: { provider: 'codex', model: 'shared-trap' },
              reviewer: { provider: 'codex', model: 'shared-trap' },
            },
          }
        : {},
      prefix,
    );
    const critique = seen.find((t) => t.provider === 'codex' && t.label.startsWith('critique-'));
    assert.ok(critique !== undefined, 'the pass has to have dispatched a critique turn');

    const line = formatHeartbeat({
      label: critique.label,
      elapsedMs: 90_000,
      unit: 'event',
      snapshot: withNumerator,
      contextWindow: critique.progress?.contextWindow,
    });

    // 420,000 over Claude's 200,000 is `ctx 210%` - the number this run would
    // have printed on develop, and the reason the fix lands before a numerator
    // does.
    assert.doesNotMatch(line, /ctx/, `${prefix} rendered a percentage: ${line}`);
  }
});

// ---- 3. this change alters no output ---------------------------------------

test('the rendered lines are byte-identical to what they have always been', () => {
  const codexLine = formatHeartbeat({
    label: 'critique-0',
    elapsedMs: 90_000,
    unit: 'event',
    // As Codex actually reports: items, a total at turn.completed, no prompt.
    snapshot: {
      ...emptySnapshot(),
      activities: 4,
      lastActivity: 'agent_message',
      tokens: 429_000,
    },
  });
  assert.equal(codexLine, 'critique-0: 1m30s · 4 events · agent_message · 429k tok');

  const claudeLine = formatHeartbeat({
    label: 'implement',
    elapsedMs: 252_000,
    unit: 'tool use',
    contextWindow: 200_000,
    snapshot: {
      ...emptySnapshot(),
      activities: 23,
      lastActivity: 'Read src/orchestrator.ts',
      tokens: 340_000,
      promptTokens: 44_000,
    },
  });
  assert.equal(
    claudeLine,
    'implement: 4m12s · 23 tool uses · Read src/orchestrator.ts · 340k tok · ctx 22%',
  );
});

test('a whole Codex turn supplies a token total and no heartbeat numerator', () => {
  // The numerator half of the trap. `progress.test.ts` pins this for a single
  // turn.completed event; this pins it for the sequence a real `codex exec
  // --json` run emits, which is what makes the two cases above true rather than
  // accidental. The day this assertion has to change is the day the denominator
  // fixed here starts mattering - which is why it was fixed first.
  const snapshot = emptySnapshot();
  const lines = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { type: 'reasoning' } },
    { type: 'item.completed', item: { type: 'reasoning' } },
    { type: 'item.started', item: { type: 'command_execution' } },
    { type: 'item.completed', item: { type: 'command_execution' } },
    { type: 'item.completed', item: { type: 'agent_message' } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 420_000,
        cached_input_tokens: 380_000,
        output_tokens: 9_000,
        reasoning_output_tokens: 6_000,
      },
    },
  ];

  for (const line of lines) parseCodexLine(snapshot, JSON.stringify(line));

  assert.equal(snapshot.activities, 5);
  assert.equal(snapshot.lastActivity, 'agent_message');
  assert.equal(snapshot.tokens, 429_000);
  assert.equal(snapshot.promptTokens, 0, 'Codex reports no per-request prompt size');
});

// ---- 4. the resolution itself, both sources --------------------------------

function unitState(over: Partial<RunState> = {}): RunState {
  return { dir: '/nowhere', events: [], ...over } as unknown as RunState;
}

function unitConfig(model: string): Config {
  return {
    ...DEFAULTS,
    claude: { ...DEFAULTS.claude, model },
    progress: { ...DEFAULTS.progress, enabled: true },
  };
}

test('the provider, not just the model, is what unlocks a measured window', () => {
  rememberContextWindow('unit-shared', 200_000);
  const state = unitState();
  const cfg = unitConfig('unit-shared');

  assert.equal(
    progressOptions(state, cfg, 'plan', 'unit-shared', 'claude')?.contextWindow,
    200_000,
    'the conversation that measured it still gets it',
  );
  const codex = progressOptions(state, cfg, 'critique-0', 'unit-shared', 'codex');
  assert.ok(codex !== undefined);
  assert.equal('contextWindow' in codex, false, 'the same name on Codex gets nothing');
});

test('the persisted window is provider-qualified too, not only the in-process one', () => {
  // The resumed-run source: nothing measured in this process, a window on the
  // run tagged with the model that measured it. Same collision, same answer.
  const state = unitState({ contextModel: 'unit-persisted', contextWindow: 300_000 });
  const cfg = unitConfig('unit-persisted');

  assert.equal(
    progressOptions(state, cfg, 'plan', 'unit-persisted', 'claude')?.contextWindow,
    300_000,
  );
  const codex = progressOptions(state, cfg, 'review-0', 'unit-persisted', 'codex');
  assert.ok(codex !== undefined);
  assert.equal('contextWindow' in codex, false);
});
