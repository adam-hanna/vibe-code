import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RateLimitError } from '@src/claude.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import { DEFAULTS } from '@src/config.js';
import { withConcurrentCompaction } from '@src/context.js';
import { commitFork, planFork } from '@src/fork.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { orchestrate, runTurn } from '@src/orchestrator.js';
import type { TurnRequest } from '@src/orchestrator.js';
import {
  DEFAULT_ROLE_PROVIDERS,
  ROLES,
  roleRefusals,
  rotatesConcurrentlyWith,
  rotatingSlot,
  slotForRole,
  tableFor,
} from '@src/roles.js';
import type { RoleTable } from '@src/roles.js';
import { listCheckpoints, loadRun, recordContextMeasurement, saveState } from '@src/run.js';
import { forkedSlotFields, slotContinuity, slotHasDeadTurn } from '@src/slots.js';
import {
  agents,
  committing,
  config,
  freshRun,
  p1,
  planFixture,
  report,
  reviewingRun,
  tokens,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { ClaudeTurnResult, Config, ContextUsage, RunState } from '@src/types.js';

/**
 * A Claude-seated reviewer gets its own conversation, never the author's (#490).
 *
 * Every Claude role used to talk through `main`, so a reviewer seated on Claude
 * judged the code from inside the session that planned and wrote it. It now has
 * `review-claude`: carried across rounds, so it keeps its own earlier findings
 * (#435), and never the planner's or the implementer's session. The default
 * table seats the reviewer on Codex and is pinned whole in
 * `claude-reviewer-pin.test.ts`.
 */

const WITH_MEMORY = 'you have your previous findings in context';
const WITHOUT_MEMORY = 'you do not have those findings';

const CLAUDE_REVIEWER = { ...DEFAULTS.roles, reviewer: { provider: 'claude' as const } };
const CLAUDE_TABLE: RoleTable = tableFor({ ...DEFAULT_ROLE_PROVIDERS, reviewer: 'claude' });

/** A Claude reviewer, no extra finders: the first finder alone, so every review turn is its. */
function claudeReviewer(loop: Parameters<typeof config>[0] = {}, over: Partial<Config> = {}): Config {
  return config(
    { p1Tolerance: 0, ...loop },
    { roles: CLAUDE_REVIEWER, review: { ...DEFAULTS.review, finders: [] }, ...over },
  );
}

const usage = (ratio: number): ContextUsage => ({ promptTokens: ratio * 200_000, contextWindow: 200_000, ratio });

interface Driven {
  calls: string[];
  seen: Narration[];
  claude: [string, ClaudeTurnOptions][];
}

/**
 * Drive the loop with a Claude reviewer that raises one blocker in round 1 and
 * none after, recording every Claude turn's options in order.
 */
async function drive(state: RunState, cfg: Config, resume = false, over: Handlers = {}): Promise<Driven> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  const claude: [string, ClaudeTurnOptions][] = [];
  const handlers: Handlers = {
    claude: (label, options) => {
      claude.push([label, options]);
      if (label === 'plan' || label.startsWith('revise-')) return planFixture();
      if (label === 'review-0') return report([p1('claude-review-blocker')]);
      if (label.startsWith('review-')) return report([]);
      return work(state, `${label}.txt`);
    },
    codex: () => report([]),
    ...over,
  };
  const originalLog = console.log;
  const originalError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, resume, agents(handlers, calls));
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return { calls, seen, claude };
}

const turnsLabelled = (driven: Driven, re: RegExp): ClaudeTurnOptions[] =>
  driven.claude.filter(([label]) => re.test(label)).map(([, options]) => options);

function fullRun(prefix: string): RunState {
  return freshRun({ prefix, planOnly: false, git: true, commit: true });
}

// ---- the slot --------------------------------------------------------------

test('a reviewer on Claude is seated on its own conversation, and every other Claude role on main', () => {
  assert.equal(slotForRole('reviewer', CLAUDE_TABLE), 'review-claude');
  assert.equal(slotForRole('planner', CLAUDE_TABLE), 'main');
  assert.equal(slotForRole('implementer', CLAUDE_TABLE), 'main');
  assert.equal(rotatingSlot(CLAUDE_TABLE), 'main', 'what rotation compacts did not move');
  const allClaude = tableFor({ planner: 'claude', implementer: 'claude', critic: 'claude', answerer: 'claude', reviewer: 'claude' });
  assert.equal(slotForRole('reviewer', allClaude), 'review-claude');
  assert.equal(slotForRole('critic', allClaude), 'main', 'the plan side is a separate issue');
});

// ---- the loop --------------------------------------------------------------

test('a Claude reviewer reviews in its own session, round to round, and the authors stay on main', async () => {
  const state = fullRun('vibe-claude-reviewer-');
  const driven = await drive(state, claudeReviewer());
  assert.equal(state.status, 'done');
  assert.deepEqual(driven.calls, ['plan', 'critique-0', 'implement', 'review-0', 'fix-1', 'review-1']);

  const reviewerId = state.reviewClaudeSessionId;
  assert.ok(typeof reviewerId === 'string' && reviewerId !== '', 'the reviewer has an id of its own');
  assert.notEqual(reviewerId, state.sessionId);

  const [first, second, ...more] = turnsLabelled(driven, /^review-/);
  assert.ok(first !== undefined && second !== undefined && more.length === 0);
  assert.equal(first.sessionId, reviewerId);
  assert.equal(second.sessionId, reviewerId);
  assert.equal(first.resume, false, 'round 1 opens the conversation');
  assert.equal(second.resume, true, 'round 2 continues it');
  assert.equal(first.forkFrom, undefined);
  assert.ok(!first.prompt.includes(WITH_MEMORY) && !first.prompt.includes(WITHOUT_MEMORY), 'round 1 has no note');
  assert.ok(second.prompt.includes(WITH_MEMORY), 'round 2 is told it has its earlier findings');

  for (const options of turnsLabelled(driven, /^(plan|implement|fix-)/)) {
    assert.equal(options.sessionId, state.sessionId, `${options.progress?.label} left main`);
  }
  assert.equal(state.reviewClaudeSessionStarted, true);
  assert.equal(state.reviewClaudeSessionRegistered, true);
});

test("a Claude reviewer's session is never main's, before or after main is rotated", async () => {
  const state = fullRun('vibe-claude-reviewer-rotate-');
  // Context on, with the implement turn reporting a conversation over the
  // threshold, so `main` is rotated - beside the review, which is now allowed.
  const cfg = claudeReviewer({}, { context: { ...DEFAULTS.context, enabled: true } });
  const driven = await drive(state, cfg, false, {
    usage: (label) => (label === 'implement' ? usage(0.9) : null),
  });
  assert.equal(state.status, 'done');
  assert.ok(state.sessionRotations >= 1, 'main was rotated');

  const reviewIds = new Set(turnsLabelled(driven, /^review-/).map((o) => o.sessionId));
  const mainIds = new Set(
    driven.claude.filter(([label]) => !label.startsWith('review-')).map(([, o]) => o.sessionId),
  );
  mainIds.add(state.sessionId);
  assert.ok(mainIds.size >= 2, `main had one id across a rotation: ${[...mainIds].join(', ')}`);
  assert.equal(reviewIds.size, 1, 'one reviewer conversation across both rounds');
  for (const id of reviewIds) assert.ok(!mainIds.has(id), `the reviewer ran on main's ${id}`);
});

test("a Claude review turn neither rotates main nor overwrites main's measurement", async () => {
  const state = fullRun('vibe-claude-reviewer-guard-');
  // Only the turn-boundary decision is left: nothing overlaps a review.
  const cfg = claudeReviewer(
    {},
    {
      context: { ...DEFAULTS.context, enabled: true, compactDuringCodex: false },
      roles: { ...DEFAULTS.roles, reviewer: { provider: 'claude', model: 'reviewer-model' } },
    },
  );
  let afterImplement: { ratio: number; model: string | undefined } | null = null;
  const driven = await drive(state, cfg, false, {
    claude: (label) => {
      if (label === 'plan') return planFixture();
      if (label === 'review-0') {
        afterImplement = { ratio: state.contextRatio, model: state.contextModel };
        return report([]);
      }
      return work(state, `${label}.txt`);
    },
    // Under `compactAboveRatio` for the implementer, over it for the reviewer -
    // and the reviewer names a model `main` was never measured under, which is
    // what `shouldRotate` reads as "unmeasured, so rotate".
    usage: (label) => (label === 'implement' ? usage(0.3) : label === 'review-0' ? usage(0.9) : null),
  });
  assert.equal(state.status, 'done');
  assert.ok(driven.calls.includes('review-0'));
  assert.ok(!driven.seen.some((n) => n.id === 'session_compacting'), 'main was rotated for a review');
  assert.equal(state.sessionRotations, 0);
  assert.ok(afterImplement !== null);
  assert.deepEqual({ ratio: state.contextRatio, model: state.contextModel }, afterImplement);
  assert.equal(state.contextRatio, 0.3);
});

// ---- the invariant ---------------------------------------------------------

test('a table that seats the reviewer in a writer conversation is refused, naming both', () => {
  const onMain: RoleTable = {
    ...ROLES,
    reviewer: { ...ROLES.reviewer, provider: 'claude', slot: 'main' },
  };
  const refused = roleRefusals(config(), onMain);
  assert.equal(refused.length, 2, refused.join('\n'));
  for (const writer of ['planner', 'implementer']) {
    const line = refused.find((r) => r.includes(`roles.${writer}`));
    assert.ok(line !== undefined, `no refusal names roles.${writer}: ${refused.join('\n')}`);
    assert.match(line, /roles\.reviewer/);
    assert.match(line, /"main"/);
  }

  // And no table `tableFor` builds can trip it.
  assert.deepEqual(roleRefusals(config({}, { roles: CLAUDE_REVIEWER })), []);
  const allClaude = { planner: 'claude', implementer: 'claude', critic: 'claude', answerer: 'claude', reviewer: 'claude' } as const;
  assert.deepEqual(roleRefusals(config({}, { roles: allClaude })), []);
  assert.deepEqual(roleRefusals(config()), []);
});

// ---- compaction beside a Claude review --------------------------------------

test('a rotation of main may run alongside a Claude review', async () => {
  assert.equal(rotatesConcurrentlyWith('reviewer', CLAUDE_TABLE), true);

  const state = freshRun({ prefix: 'vibe-claude-reviewer-overlap-' });
  recordContextMeasurement(state, DEFAULTS.claude.model, 0.9, 200_000);
  state.sessionStarted = true;
  const outgoing = state.sessionId;
  const rotated: ClaudeTurnOptions[] = [];
  const cfg = config({}, { context: DEFAULTS.context, roles: CLAUDE_REVIEWER });
  const originalLog = console.log;
  console.log = () => undefined;
  let result: string;
  try {
    result = await withConcurrentCompaction(
      state,
      cfg,
      () => Promise.resolve('review'),
      (options): Promise<ClaudeTurnResult> => {
        rotated.push(options);
        return Promise.resolve({
          text: 'briefing',
          costUsd: 0.01,
          sessionId: options.sessionId,
          denials: [],
          numTurns: 1,
          usage: null,
          tokens: tokens(12_000),
        });
      },
      'reviewer',
      CLAUDE_TABLE,
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(result, 'review');
  assert.equal(state.sessionRotations, 1);
  assert.equal(rotated[0]?.sessionId, outgoing, "the briefing came from main's own session");
  assert.notEqual(state.sessionId, outgoing);
});

// ---- a run in flight -------------------------------------------------------

test('a run started before this change resumes its Claude reviewer on a fresh conversation, told so', async () => {
  // Round 1 was reviewed on `main`, as every Claude reviewer was: `main` has
  // run, and no field of the reviewer's own conversation exists.
  const state = reviewingRun({ prefix: 'vibe-claude-reviewer-upgrade-' });
  state.reviewRound = 1;
  state.sessionStarted = true;
  state.sessionRegistered = true;
  const main = state.sessionId;
  saveState(state);
  assert.equal(JSON.stringify(state).includes('reviewClaude'), false);

  const driven = await drive(state, claudeReviewer(), true);
  const [review] = turnsLabelled(driven, /^review-1$/);
  assert.ok(review !== undefined, driven.calls.join(', '));
  assert.equal(review.sessionId, state.reviewClaudeSessionId);
  assert.notEqual(review.sessionId, main);
  assert.equal(review.resume, false, 'nothing is carried over from main');
  assert.equal(review.forkFrom, undefined);
  assert.ok(review.prompt.includes(WITHOUT_MEMORY), 'and it is told it lacks its earlier findings');
  assert.ok(!review.prompt.includes(WITH_MEMORY));
  assert.equal(state.sessionId, main, "main's id is untouched");
});

// ---- #74 on the new slot ---------------------------------------------------

function reviewRequest(state: RunState): TurnRequest {
  return { role: 'reviewer', prompt: 'review it', cwd: state.targetDir, label: 'review-0', timeoutMs: 1_000 };
}

function claudeOnly(outcome: (call: number, options: ClaudeTurnOptions) => ClaudeTurnResult | Error) {
  const calls: ClaudeTurnOptions[] = [];
  return {
    calls,
    turns: {
      claude: (options: ClaudeTurnOptions): Promise<ClaudeTurnResult> => {
        calls.push(options);
        const produced = outcome(calls.length, options);
        return produced instanceof Error ? Promise.reject(produced) : Promise.resolve(produced);
      },
      codex: () => Promise.reject(new Error('no Codex turn here')),
    },
  };
}

const answered = (options: ClaudeTurnOptions): ClaudeTurnResult => ({
  text: JSON.stringify(report([])),
  costUsd: 0.01,
  sessionId: options.sessionId,
  denials: [],
  numTurns: 1,
  usage: null,
  tokens: tokens(1000),
});

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await work();
  } finally {
    console.log = originalLog;
  }
}

test("a review turn that died mid-turn is resumed under its own spent id, with memory", async () => {
  const state = reviewingRun({ prefix: 'vibe-claude-reviewer-dead-' });
  state.reviewRound = 1;
  state.reviewClaudeSessionId = 'reviewer-spent';
  state.reviewClaudeSessionRegistered = true;
  saveState(state);
  assert.equal(slotHasDeadTurn(state, 'review-claude'), true);

  const driven = await drive(state, claudeReviewer(), true);
  const [review] = turnsLabelled(driven, /^review-1$/);
  assert.ok(review !== undefined, driven.calls.join(', '));
  assert.equal(review.sessionId, 'reviewer-spent');
  assert.equal(review.resume, true);
  assert.ok(review.prompt.includes(WITH_MEMORY), 'a resumed dead turn holds its own work');
  assert.equal(state.reviewClaudeSessionStarted, true);
});

test('an observed failure gives the spent reviewer id up; a rate limit keeps it', async () => {
  const dead = reviewingRun({ prefix: 'vibe-claude-reviewer-fail-' });
  dead.reviewClaudeSessionId = 'reviewer-spent';
  dead.reviewClaudeSessionRegistered = true;
  const failing = claudeOnly(() => new Error('the process died here'));
  await quietly(() => assert.rejects(() => runTurn(dead, claudeReviewer(), reviewRequest(dead), failing.turns, CLAUDE_TABLE)));
  assert.equal(failing.calls[0]?.sessionId, 'reviewer-spent');
  assert.notEqual(dead.reviewClaudeSessionId, 'reviewer-spent', 'the failure gave it up');
  assert.equal(dead.reviewClaudeSessionRegistered, undefined, 'and the fresh one is unspent');
  assert.equal(dead.reviewClaudeSessionStarted, false);
  assert.equal(dead.sessionRotations, 0, 'a discard is not a rotation');

  const limited = reviewingRun({ prefix: 'vibe-claude-reviewer-limit-' });
  limited.reviewClaudeSessionId = 'reviewer-spent';
  limited.reviewClaudeSessionRegistered = true;
  // 0.005 minutes is 300ms: the wait is real, and short enough to sit in a test.
  const cfg = claudeReviewer({}, { budget: { ...DEFAULTS.budget, maxWaitMinutes: 0.005 } });
  const retried = claudeOnly((call, options) =>
    call === 1 ? new RateLimitError('usage limit reached', null) : answered(options),
  );
  await quietly(() => runTurn(limited, cfg, reviewRequest(limited), retried.turns, CLAUDE_TABLE));
  assert.equal(retried.calls.length, 2);
  assert.equal(retried.calls[1]?.sessionId, 'reviewer-spent', 'the limit gave up nothing');
  assert.equal(retried.calls[1]?.resume, true);
  assert.equal(limited.reviewClaudeSessionId, 'reviewer-spent');
});

test("a first review turn's id and its registration are saved before it is spawned", async () => {
  const state = reviewingRun({ prefix: 'vibe-claude-reviewer-register-' });
  saveState(state);
  let onDisk: Record<string, unknown> | null = null;
  const rec = claudeOnly((_n, options) => {
    onDisk = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
    return answered(options);
  });
  await quietly(() => runTurn(state, claudeReviewer(), reviewRequest(state), rec.turns, CLAUDE_TABLE));
  const spawned = rec.calls[0];
  assert.ok(spawned !== undefined && onDisk !== null);
  const saved: Record<string, unknown> = onDisk;
  assert.equal(spawned.resume, false);
  assert.equal(saved['reviewClaudeSessionId'], spawned.sessionId, 'the id spawned under is the id saved');
  assert.equal(saved['reviewClaudeSessionRegistered'], true, 'and its handover was recorded first');
  assert.notEqual(spawned.sessionId, state.sessionId);
});

test('a registration whose id was dropped on load claims no memory, and the turn starts fresh', async () => {
  const state = reviewingRun({ prefix: 'vibe-claude-reviewer-mixed-' });
  state.reviewRound = 1;
  saveState(state);
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['reviewClaudeSessionId'] = 7;
  raw['reviewClaudeSessionRegistered'] = true;
  raw['reviewClaudeSessionStarted'] = false;
  writeFileSync(file, JSON.stringify(raw), 'utf8');

  const loaded = loadRun(state.targetDir, state.id);
  assert.equal(loaded.reviewClaudeSessionId, undefined);
  assert.ok(repairs(loaded).includes('reviewClaudeSessionId'));
  const cfg = claudeReviewer();
  assert.equal(slotHasDeadTurn(loaded, 'review-claude'), false, 'nothing is left to resume');
  assert.equal(slotContinuity(loaded, cfg, 'review-claude'), false);

  const driven = await drive(loaded, cfg, true);
  const [review] = turnsLabelled(driven, /^review-1$/);
  assert.ok(review !== undefined, driven.calls.join(', '));
  assert.ok(review.prompt.includes(WITHOUT_MEMORY), 'the prompt says what dispatch then does');
  assert.equal(review.resume, false);
  assert.equal(review.forkFrom, undefined);
  assert.ok(typeof review.sessionId === 'string' && review.sessionId !== '');
  assert.equal(loaded.reviewClaudeSessionId, review.sessionId);
  assert.equal(loaded.reviewClaudeSessionRegistered, true);
});

// ---- stored state ----------------------------------------------------------

function repairs(state: RunState): string[] {
  return state.events.filter((e) => e.type === 'state_repaired').map((e) => String(e['field']));
}

test("malformed fields of the reviewer's conversation are dropped and named; absent ones load clean", () => {
  const state = freshRun({ prefix: 'vibe-claude-reviewer-stored-' });
  saveState(state);
  const clean = loadRun(state.targetDir, state.id);
  assert.deepEqual(repairs(clean), []);
  assert.equal('reviewClaudeSessionId' in clean, false);

  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['reviewClaudeSessionId'] = 7;
  raw['reviewClaudeSessionStarted'] = 'yes';
  raw['reviewClaudeSessionRegistered'] = 1;
  writeFileSync(file, JSON.stringify(raw), 'utf8');
  const damaged = loadRun(state.targetDir, state.id);
  assert.equal(damaged.reviewClaudeSessionId, undefined);
  assert.equal(damaged.reviewClaudeSessionStarted, undefined);
  assert.equal(damaged.reviewClaudeSessionRegistered, undefined);
  assert.deepEqual(repairs(damaged).sort(), [
    'reviewClaudeSessionId',
    'reviewClaudeSessionRegistered',
    'reviewClaudeSessionStarted',
  ]);
});

// ---- forks -----------------------------------------------------------------

test("a fork resets the Claude reviewer's conversation and carries its own history, never main's", async () => {
  const parent = fullRun('vibe-claude-reviewer-fork-');
  const cfg = claudeReviewer({}, committing());
  await drive(parent, cfg);
  assert.equal(parent.status, 'done');
  const reviewer = parent.reviewClaudeSessionId;
  assert.ok(reviewer !== undefined);

  // The census, the debt and the clear list, from the parent's own state.
  const fields = forkedSlotFields(parent, cfg);
  const listed = fields.conversations.find((c) => c.slot === 'review-claude');
  assert.deepEqual(listed, { slot: 'review-claude', parentId: reviewer });
  assert.deepEqual(fields.fields.forkPending?.['review-claude'], { parentId: reviewer, attempts: 0 });
  for (const key of ['reviewClaudeSessionId', 'reviewClaudeSessionStarted', 'reviewClaudeSessionRegistered'] as const) {
    assert.ok(fields.clear.includes(key), `${key} is not cleared on the child`);
  }

  // A real child, from the review round's checkpoint: the reviewer had run.
  const point = listCheckpoints(parent.dir).find((c) => c.meta?.boundary === 'review-round');
  assert.ok(point !== undefined, 'the parent recorded a review round');
  const plan = await planFork(parent.targetDir, parent.id, point.n, { git: { useBranch: false } });
  const { state: child } = await commitFork(parent.targetDir, plan);
  const stored = readFileSync(path.join(child.dir, 'state.json'), 'utf8');
  assert.doesNotMatch(stored, /"reviewClaudeSession(Id|Started|Registered)"/, 'the child inherits none of them');
  assert.equal(child.forkPending?.['review-claude']?.parentId, reviewer);

  const loaded = loadRun(child.targetDir, child.id);
  const driven = await drive(loaded, cfg, true);
  const [first] = turnsLabelled(driven, /^review-/);
  assert.ok(first !== undefined, driven.calls.join(', '));
  assert.equal(first.forkFrom, reviewer, "the reviewer's own conversation is what is forked");
  assert.notEqual(first.sessionId, reviewer, 'into a new id');
  assert.notEqual(first.sessionId, parent.sessionId);
  assert.equal(first.resume, false, 'a fork is not a resume');
  assert.ok(first.prompt.includes(WITH_MEMORY), 'and it is told it carries its findings');
  assert.equal(loaded.reviewClaudeSessionId, first.sessionId);
});

test('a parent that never opened the reviewer conversation lists it nowhere', async () => {
  const parent = fullRun('vibe-claude-reviewer-fork-none-');
  const cfg = config({}, committing());
  await drive(parent, cfg, false, { claude: (label) => (label === 'plan' ? planFixture() : work(parent, `${label}.txt`)) });
  const fields = forkedSlotFields(parent, cfg);
  assert.equal(fields.conversations.some((c) => c.slot === 'review-claude'), false);
  assert.equal(fields.fields.forkPending?.['review-claude'], undefined);

  const point = listCheckpoints(parent.dir).find((c) => c.meta?.boundary === 'implemented');
  assert.ok(point !== undefined);
  const plan = await planFork(parent.targetDir, parent.id, point.n, { git: { useBranch: false } });
  const { state: child } = await commitFork(parent.targetDir, plan);
  assert.ok(
    !(child.forkedFrom?.notInherited ?? []).some((loss) => loss.includes('review-claude')),
    (child.forkedFrom?.notInherited ?? []).join('\n'),
  );
});
