import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitError } from '@src/claude.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { orchestrate, runTurn } from '@src/orchestrator.js';
import { ROLES, seatTable } from '@src/roles.js';
import { ensureSlotId, slotForkParent } from '@src/slots.js';
import {
  agents,
  config,
  freshRun,
  planFixture,
  report,
  tokens,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, ContextUsage, RunState } from '@src/types.js';

/**
 * A finder's turn runs on a slot that holds no conversation of the run, and
 * must leave the run's conversations exactly as it found them (#388 Part B,
 * decision 2a).
 *
 * The concrete defect is the rotation one: `shouldRotate` asks about `main`
 * with the *incoming* turn's model, and a model `main` was never measured
 * under reads as "unmeasured, so rotate" whenever `contextRatio > 0`. So a
 * Claude finder naming a different model than the implementer's would compact
 * the implementer's session in the middle of a review. The harness switches
 * context off by default, which would make a no-rotation assertion pass with or
 * without the guard - so these cases switch it back on, with `compactDuringCodex`
 * off so the only rotation decision left is the one inside `claudeDispatch`, and
 * a control case proves the same config does rotate a turn that sits on `main`.
 */

const usage = (ratio: number): ContextUsage => ({ promptTokens: ratio * 200_000, contextWindow: 200_000, ratio });

/** Context on, and nothing overlapping a Codex turn: one rotation decision left. */
function rotating(over: Partial<Config> = {}): Config {
  return config(
    { p1Tolerance: 0 },
    { context: { ...DEFAULTS.context, enabled: true, compactDuringCodex: false }, ...over },
  );
}

interface Driven {
  calls: string[];
  seen: Narration[];
  claude: Map<string, ClaudeTurnOptions>;
  codex: Map<string, CodexTurnOptions>;
}

const SLOT_KEYS = [
  'sessionId',
  'sessionStarted',
  'sessionRegistered',
  'contextModel',
  'contextRatio',
  'codexSessionId',
  'codexSessionStarted',
  'reviewSessionId',
  'reviewSessionStarted',
  'reviewContextTokens',
  'reviewContextThread',
  'judgeContextTokens',
  'judgeContextThread',
  'forkPending',
] as const;

function slotFields(state: RunState): Record<string, unknown> {
  const raw = state as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of SLOT_KEYS) if (key in raw) out[key] = structuredClone(raw[key]);
  return out;
}

/** Every key on the state, so "no new slot field" is an assertion about all of them. */
function keysOf(state: RunState): string[] {
  return Object.keys(state).sort();
}

async function drive(state: RunState, cfg: Config, over: Handlers = {}): Promise<Driven> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  const claude = new Map<string, ClaudeTurnOptions>();
  const codex = new Map<string, CodexTurnOptions>();
  const driven: Driven = { calls, seen, claude, codex };
  const handlers: Handlers = {
    claude: (label, options) => {
      claude.set(label, options);
      if (label === 'plan' || label.startsWith('revise-')) return planFixture();
      if (label.startsWith('review-')) return report([]);
      return work(state, `${label}.txt`);
    },
    codex: (label, options) => {
      codex.set(label, options);
      return report([]);
    },
    ...over,
  };
  const originalLog = console.log;
  const originalError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, false, agents(handlers, calls));
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return driven;
}

function run(prefix: string): RunState {
  return freshRun({ prefix, planOnly: false, git: true, commit: true });
}

test("a Claude finder on another model after an implement turn leaves main's session alone", async () => {
  const state = run('vibe-fresh-claude-');
  let mainAfterImplement: string | undefined;
  const cfg = rotating({ review: { ...DEFAULTS.review, finders: [{ provider: 'claude', model: 'finder-model' }] } });
  const driven = await drive(state, cfg, {
    usage: (label, options) => {
      if (label === 'implement') {
        mainAfterImplement = options.sessionId;
        // Non-zero, and under `compactAboveRatio`: the implementer's own model
        // would never rotate on this.
        return usage(0.3);
      }
      return label === 'review-0-f1' ? usage(0.9) : null;
    },
  });
  assert.equal(state.status, 'done');
  assert.ok(driven.calls.includes('review-0-f1'), `no finder turn in ${driven.calls.join(', ')}`);

  // No rotation was attempted, by either name it would go under.
  assert.equal(driven.seen.some((n) => n.id === 'session_compacting'), false, 'no rotation was narrated');
  assert.equal(driven.calls.includes('compact'), false);
  assert.equal(state.sessionRotations, 0);

  // `main`'s record is what implement left.
  assert.equal(state.contextModel, DEFAULTS.claude.model);
  assert.equal(state.contextRatio, 0.3);
  assert.equal(state.sessionId, mainAfterImplement);

  // The finder ran on a conversation of its own, never resumed, read-only, with no MCP.
  const finder = driven.claude.get('review-0-f1');
  assert.ok(finder !== undefined);
  assert.notEqual(finder.sessionId, mainAfterImplement);
  assert.equal(finder.resume, false);
  assert.equal(finder.forkFrom, undefined, 'no fork is noted');
  assert.equal(finder.permissionMode, 'plan');
  assert.deepEqual(finder.mcpServers, {});
  assert.equal(finder.model, 'finder-model');

  // Its charge reports its own measurement, not main's.
  const charged = state.events.find((e) => e.type === 'claude_turn' && e['label'] === 'review-0-f1');
  assert.equal(charged?.['contextRatio'], 0.9);

  // The reviewer is not generative, so no handoff prefix: the Claude finder's
  // prompt is the memoryless review prompt the Codex reviewer was handed.
  assert.equal(finder.prompt, driven.codex.get('review-0')?.prompt);
});

test('the control: the same config does rotate a Claude reviewer that sits on main', async () => {
  // Proves the case above exercises the path: with no guard there, this is
  // exactly what the finder would have done.
  const state = run('vibe-fresh-control-');
  const cfg = rotating({ roles: { ...DEFAULTS.roles, reviewer: { provider: 'claude', model: 'finder-model' } } });
  const driven = await drive(state, cfg, {
    usage: (label) => (label === 'implement' ? usage(0.3) : null),
  });
  assert.ok(driven.seen.some((n) => n.id === 'session_compacting'), 'main was rotated before review-0');
  assert.ok(state.sessionRotations >= 1);
});

test("a Codex finder leaves the review thread's id and occupancy alone, and reads only", async () => {
  const state = run('vibe-fresh-codex-');
  const before = keysOf(state);
  const cfg = rotating({ review: { ...DEFAULTS.review, finders: ['codex'] } });
  const driven = await drive(state, cfg, {
    codexSessionId: (label) => (label === 'review-0-f1' ? 'thread-finder' : label.startsWith('review') ? 'thread-review' : 'thread-judge'),
  });
  assert.equal(state.status, 'done');
  const finder = driven.codex.get('review-0-f1');
  assert.ok(finder !== undefined);
  assert.equal(finder.sessionId ?? null, null, 'never resumed');
  assert.equal(finder.forkFrom, undefined, 'never forked');
  assert.equal(finder.sandbox, 'read-only');
  for (const [label, options] of driven.codex) {
    assert.notEqual(options.sandbox, 'workspace-write', `${label} was spawned able to write`);
  }

  // What the review thread held when the reviewer's turn returned is what it
  // holds after the finder's: the finder's thread id was never adopted.
  assert.equal(state.reviewSessionId, 'thread-review');
  assert.equal(state.reviewContextThread ?? 'thread-review', 'thread-review');
  // No slot field appeared that a default run does not have.
  const added = keysOf(state).filter((k) => !before.includes(k) && /session|context|thread|fork/i.test(k));
  const plain = run('vibe-fresh-codex-plain-');
  const plainBefore = keysOf(plain);
  await drive(plain, rotating());
  const plainAdded = keysOf(plain).filter((k) => !plainBefore.includes(k) && /session|context|thread|fork/i.test(k));
  assert.deepEqual(added, plainAdded);
});

test('fresh-claude mints a new id every time and leaves the state as it was', () => {
  const state = freshRun({ prefix: 'vibe-fresh-unit-' });
  const snapshot = structuredClone(state);
  const a = ensureSlotId(state, 'fresh-claude');
  const b = ensureSlotId(state, 'fresh-claude');
  assert.notEqual(a, b);
  assert.deepEqual(state, snapshot);
});

test('a fresh slot never owes a fork, even with one recorded against it', () => {
  const state = freshRun({ prefix: 'vibe-fresh-fork-' });
  const pending = { parentId: 'parent', attempts: 0 };
  (state as unknown as Record<string, unknown>)['forkPending'] = {
    'fresh-claude': pending,
    'fresh-codex': pending,
  };
  assert.equal(slotForkParent(state, DEFAULTS, 'fresh-claude'), null);
  assert.equal(slotForkParent(state, DEFAULTS, 'fresh-codex'), null);
});

test('a rate-limited finder turn retries on a new id, fresh both times', async () => {
  const state = freshRun({ prefix: 'vibe-fresh-ratelimit-', planOnly: false });
  const seen: ClaudeTurnOptions[] = [];
  // 0.005 minutes is 300ms - the wait is real, and short enough to sit in a test.
  const cfg: Config = { ...config(), budget: { ...DEFAULTS.budget, maxWaitMinutes: 0.005 } };
  const before = slotFields(state);
  const turns = {
    claude: (options: ClaudeTurnOptions) => {
      seen.push(options);
      if (seen.length === 1) return Promise.reject(new RateLimitError('usage limit reached', null));
      return Promise.resolve({
        text: JSON.stringify(report([])),
        costUsd: 0.01,
        sessionId: options.sessionId,
        denials: [],
        numTurns: 1,
        usage: null,
        tokens: tokens(100),
      });
    },
    codex: () => Promise.reject(new Error('no codex here')),
  };
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await runTurn(
      state,
      cfg,
      { role: 'reviewer', prompt: 'review it', cwd: state.targetDir, label: 'review-0-f1' },
      turns,
      seatTable(ROLES, { provider: 'claude' }),
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(seen.length, 2, 'the limit was waited out and retried');
  assert.notEqual(seen[0]?.sessionId, seen[1]?.sessionId);
  assert.equal(seen[0]?.resume, false);
  assert.equal(seen[1]?.resume, false);
  const after = slotFields(state);
  // `main` is untouched by either attempt.
  assert.equal(after['sessionId'], before['sessionId']);
  assert.equal(after['sessionRegistered'], before['sessionRegistered']);
  assert.equal(after['sessionStarted'], before['sessionStarted']);
});
