import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cancelRequested, clearCancel, requestCancel } from '@src/cancel.js';
import { execute } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { EXIT, orchestrate } from '@src/orchestrator.js';
import type { AgentTurns } from '@src/orchestrator.js';
import { config, deferred, deferredAgents, freshRun, p1, planFixture, report, until } from './helpers/loop-harness.js';
import type { Deferred, Handlers } from './helpers/loop-harness.js';
import type { Config, CritiqueConfig, Evidence, Finding, RunState } from '@src/types.js';

/**
 * Plan critique finders and verifiers running at once, through the real plan
 * loop (#452).
 *
 * The critique's seats go through the review's runners since #452, so
 * `critique.maxParallel` gives them #403's concurrency under a bound of their
 * own. These cases hold turns open with `deferredAgents` so that they genuinely
 * overlap, finish them out of config order, and then check what the artifact
 * must not depend on - and what a ceiling and a stop must each do with siblings
 * live, including beside a rotation of the planner's conversation, which runs
 * next to the critique inside `withConcurrentCompaction` and is no seat.
 */

const LINE = (line: number): Evidence => ({ kind: 'code', path: 'widget.ts', line });

function blocker(id: string, title: string, line: number): Finding {
  return { ...p1(id), title, evidence: [LINE(line)] };
}

function withCritique(critique: Partial<CritiqueConfig>, over: Partial<Config> = {}): Config {
  return config({ p1Tolerance: 0 }, { critique: { ...DEFAULTS.critique, ...critique }, ...over });
}

/** A plan-only run over a five-line file every finding below can cite. */
function run(prefix: string): RunState {
  const state = freshRun({ prefix, task: 'critique in parallel' });
  writeFileSync(
    path.join(state.targetDir, 'widget.ts'),
    [1, 2, 3, 4, 5].map((n) => `export const w${n} = ${n};`).join('\n') + '\n',
    'utf8',
  );
  return state;
}

const REAL = { vote: 'real', reason: 'It is there.', evidence: [] };
const NOT_REAL = {
  vote: 'not-real',
  reason: 'The plan handles it in step 2.',
  evidence: [{ ...LINE(1), excerpt: null, ref: null }],
};
const CANNOT_TELL = { vote: 'cannot-tell', reason: 'Could not settle it.', evidence: [] };

/**
 * The same answers whatever the order: a critic and two finders whose findings
 * merge by citation, by title and by a clashing id, and a split vote that
 * differs per finding and per verifier. Round 2 finds nothing, so the plan is
 * approved.
 */
function panel(): Handlers {
  const answer = (label: string): unknown => {
    const vote = /^critique-0-vote-(\d+)-v(\d+)$/.exec(label);
    if (vote !== null) {
      const table = [
        [REAL, REAL, NOT_REAL],
        [NOT_REAL, NOT_REAL, REAL],
        [REAL, CANNOT_TELL, NOT_REAL],
      ];
      return table[Number(vote[1]) - 1]?.[Number(vote[2]) - 1] ?? REAL;
    }
    if (label === 'critique-0') {
      return report([blocker('alpha', 'The plan skips the migration', 1), blocker('beta', 'No rollback is named', 2)]);
    }
    if (label === 'critique-0-f1') {
      return report([blocker('alpha-again', 'The migration is skipped', 1), blocker('gamma', 'The plan never tests it', 3)]);
    }
    if (label === 'critique-0-f2') {
      return report([blocker('beta-two', 'No rollback is named', 4), blocker('alpha', 'The plan drops a row', 5)]);
    }
    return report([]);
  };
  return {
    codex: (label) => answer(label),
    claude: (label) => (label.startsWith('critique-') ? answer(label) : planFixture()),
  };
}

const SEAT = /^critique-\d+-(f\d+|vote-)/;

function normal(state: RunState, text: string): string {
  return text.split(state.dir).join('<dir>').split(state.targetDir).join('<target>').split(state.id).join('<id>');
}

function file(state: RunState, name: string): string {
  return normal(state, readFileSync(path.join(state.dir, name), 'utf8'));
}

async function quietly<T>(body: () => Promise<T>, seen: Narration[] = []): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await body();
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
}

/**
 * Release held seat turns newest first until the run is over: the reverse of
 * the order they were started in, so every group finishes out of config order.
 */
async function lifo(ctl: Deferred, over: Promise<unknown>): Promise<void> {
  let finished = false;
  void over.finally(() => {
    finished = true;
  });
  let quiet = 0;
  let seenHeld = 0;
  while (!finished) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (ctl.held.length !== seenHeld) {
      seenHeld = ctl.held.length;
      quiet = 0;
      continue;
    }
    quiet += 1;
    const newest = ctl.held[ctl.held.length - 1];
    if (quiet >= 3 && newest !== undefined) {
      ctl.release(newest);
      seenHeld = ctl.held.length;
      quiet = 0;
    }
  }
}

async function driveHeld(
  state: RunState,
  cfg: Config,
  handlers: Handlers,
  ctl: Deferred,
  seen: Narration[] = [],
): Promise<string[]> {
  const calls: string[] = [];
  const over = quietly(() => orchestrate(state, cfg, false, deferredAgents(handlers, calls, ctl)), seen);
  await Promise.all([over, lifo(ctl, over)]);
  return calls;
}

/** `execute`, so the run ends the way `vibe plan` ends it, with the loop on held turns. */
function executing(state: RunState, cfg: Config, turns: AgentTurns): Promise<number> {
  clearCancel();
  return quietly(() =>
    execute(state, cfg, false, true, () => Promise.resolve(null), (s, c, r) => orchestrate(s, c, r, turns)),
  );
}

const event = (state: RunState, type: string): unknown[] =>
  state.events.filter((e) => e.type === type).map(({ at: _at, ...rest }) => rest);

// ---- results do not depend on the order turns finish in ------------------

test('two critique finders and three verifiers at maxParallel 4, finishing in reverse, write what 1 writes', async () => {
  const seats: Partial<CritiqueConfig> = { finders: ['codex', 'claude'], verifiers: ['codex', 'claude', 'codex'] };

  const one = run('vibe-cparallel-one-');
  const oneCtl = deferred({ hold: (l) => SEAT.test(l) });
  const oneCalls = await driveHeld(one, withCritique({ ...seats, maxParallel: 1 }), panel(), oneCtl);

  const four = run('vibe-cparallel-four-');
  const fourCtl = deferred({ hold: (l) => SEAT.test(l) });
  const fourCalls = await driveHeld(four, withCritique({ ...seats, maxParallel: 4 }), panel(), fourCtl);

  assert.equal(oneCtl.maxLive, 1, 'critique.maxParallel 1 overlapped turns');
  assert.equal(fourCtl.maxLive, 4, 'critique.maxParallel 4 never had four seat turns live');
  assert.ok(fourCalls.includes('critique-0-vote-1-v1'), `no vote in ${fourCalls.join(', ')}`);
  assert.deepEqual([...fourCalls].sort(), [...oneCalls].sort());

  const artifact = file(four, 'plan-critique-0.json');
  assert.equal(artifact, file(one, 'plan-critique-0.json'));
  const findings = (JSON.parse(artifact) as { findings: Finding[] }).findings;
  assert.ok(findings.some((f) => (f.foundBy?.length ?? 0) > 1), 'nothing was merged across finders');
  assert.ok(findings.some((f) => f.id === 'alpha-f2'), 'the clashing id was not renamed');
  assert.ok(findings.some((f) => f.votes !== undefined), 'nothing was voted on');
  assert.deepEqual(event(four, 'critique_finders_merged'), event(one, 'critique_finders_merged'));
  assert.deepEqual(event(four, 'critique_votes_tallied'), event(one, 'critique_votes_tallied'));
  assert.equal(four.status, 'planned');
  assert.equal(one.status, 'planned');
});

test('at most critique.maxParallel seat turns are live at once, and the bound is reached', async () => {
  const findings = [1, 2, 3, 4].map((n) => blocker(`claim-${n}`, `Claim ${n} is wrong in its own way`, n));
  const handlers: Handlers = {
    codex: (label) =>
      label.startsWith('critique-0-vote-') ? REAL : label === 'critique-0' ? report(findings) : report([]),
    claude: () => planFixture(),
  };
  const three = ['codex', 'codex', 'codex'] as CritiqueConfig['verifiers'];
  const four = run('vibe-cparallel-bound-');
  const ctl = deferred({ delayMs: 5 });
  const calls: string[] = [];
  await quietly(() =>
    orchestrate(four, withCritique({ verifiers: three, maxParallel: 4 }), false, deferredAgents(handlers, calls, ctl)),
  );
  assert.equal(calls.filter((l) => l.startsWith('critique-0-vote-')).length, 12);
  assert.equal(ctl.maxLive, 4);

  const one = run('vibe-cparallel-bound-one-');
  const oneCtl = deferred({ delayMs: 1 });
  await quietly(() =>
    orchestrate(one, withCritique({ verifiers: three, maxParallel: 1 }), false, deferredAgents(handlers, [], oneCtl)),
  );
  assert.equal(oneCtl.maxLive, 1);
});

test('above 1, a critique seat turn says its label when it starts and says when it finished', async () => {
  const seen: Narration[] = [];
  const four = run('vibe-cparallel-frames-');
  await driveHeld(
    four,
    withCritique({ finders: ['codex'], verifiers: ['codex', 'codex'], maxParallel: 2 }),
    panel(),
    deferred({ hold: (l) => SEAT.test(l) }),
    seen,
  );
  const starts = seen.filter((n) => n.id === 'turn_started' && (n.data?.['finder'] ?? n.data?.['verifier']) !== undefined);
  assert.ok(starts.length > 0);
  const finished = seen.filter((n) => n.id === 'turn_finished');
  for (const start of starts) {
    const label = start.data?.['label'];
    assert.equal(typeof label, 'string', `a seat started with no label: ${JSON.stringify(start.data)}`);
    const end = finished.find((n) => n.data?.['label'] === label);
    assert.deepEqual(end?.data, {
      label,
      role: 'critic',
      kind: start.data?.['kind'],
      round: start.data?.['round'],
    });
    assert.ok(seen.indexOf(end) > seen.indexOf(start), `${String(label)} finished before it started`);
  }
  // The critic itself is not a seat, and is unchanged.
  const critic = seen.find((n) => n.id === 'turn_started' && n.data?.['kind'] === 'critique' && n.data['finder'] === undefined);
  assert.deepEqual(critic?.data, { role: 'critic', kind: 'critique', round: 0 });

  const quiet: Narration[] = [];
  await driveHeld(
    run('vibe-cparallel-frames-one-'),
    withCritique({ finders: ['codex'], verifiers: ['codex', 'codex'], maxParallel: 1 }),
    panel(),
    deferred({ hold: (l) => SEAT.test(l) }),
    quiet,
  );
  const oneStarts = quiet.filter((n) => n.id === 'turn_started' && (n.data?.['finder'] ?? n.data?.['verifier']) !== undefined);
  assert.ok(oneStarts.length > 0);
  for (const n of oneStarts) assert.equal('label' in (n.data ?? {}), false);
  assert.equal(quiet.filter((n) => n.id === 'turn_finished').length, 0);
});

test('raising review.maxParallel alone leaves the critique one seat turn at a time', async () => {
  const state = run('vibe-cparallel-review-only-');
  const seen: Narration[] = [];
  const ctl = deferred({ delayMs: 2 });
  const cfg = withCritique(
    { finders: ['codex', 'codex'], verifiers: ['codex', 'codex', 'codex'] },
    { review: { ...DEFAULTS.review, maxParallel: 4 } },
  );
  assert.equal(cfg.critique.maxParallel, 1);
  await quietly(() => orchestrate(state, cfg, false, deferredAgents(panel(), [], ctl)), seen);
  assert.equal(ctl.maxLive, 1);
  const seatStarts = seen.filter((n) => n.id === 'turn_started' && (n.data?.['finder'] ?? n.data?.['verifier']) !== undefined);
  assert.ok(seatStarts.length > 0);
  for (const n of seatStarts) assert.equal('label' in (n.data ?? {}), false);
  assert.equal(seen.filter((n) => n.id === 'turn_finished').length, 0);
});

// ---- a ceiling and a stop, with siblings live ----------------------------

/** Two blocking plan findings and three verifiers: six ballots, three live at once. */
function sixBallots(): Handlers {
  const found = [blocker('first', 'The first claim', 1), blocker('second', 'The second claim', 2)];
  return {
    codex: (label) => (label.startsWith('critique-0-vote-') ? REAL : label === 'critique-0' ? report(found) : report([])),
    // The rotation's briefing, and the planner's plan.
    claude: (label) => (label === 'compact' ? 'Handoff: the plan is in plan-0.json.' : planFixture()),
  };
}

const THREE_LIVE = ['critique-0-vote-1-v1', 'critique-0-vote-1-v2', 'critique-0-vote-1-v3'];
const THREE = ['codex', 'codex', 'codex'] as CritiqueConfig['verifiers'];

test('a ceiling in the critique group while a rotation is live stops the siblings, not the rotation, and ends once', async (t) => {
  t.after(() => clearCancel());
  const state = run('vibe-cparallel-rotation-');
  // A planner turn that reports a conversation over `compactAboveRatio`, so the
  // critique runs beside a rotation of it (`withConcurrentCompaction`).
  const handlers: Handlers = {
    ...sixBallots(),
    usage: (label) => (label === 'plan' ? { promptTokens: 180_000, contextWindow: 200_000, ratio: 0.9 } : null),
  };
  const cfg = withCritique(
    { verifiers: THREE, maxParallel: 3 },
    { context: { ...DEFAULTS.context, enabled: true, compactDuringCodex: true } },
  );
  const ctl = deferred({ hold: (l) => l.startsWith('critique-0-vote-') || l === 'compact', spentOnKill: 700 });
  const calls: string[] = [];
  const ended = executing(state, cfg, deferredAgents(handlers, calls, ctl));
  t.after(async () => {
    // Whatever happened above, nothing is left held.
    for (const label of [...ctl.held]) ctl.release(label);
    await ended.catch(() => undefined);
  });

  await until(() => ctl.held.includes('compact'), 'the rotation live');
  await until(() => THREE_LIVE.every((l) => ctl.held.includes(l)), 'three votes live beside it');
  // The ballot about to land takes the run over: everything spent so far is
  // allowed, and its own 500 tokens are not.
  cfg.budget.maxTokens = state.tokensUsed + 1;
  ctl.release('critique-0-vote-1-v2');
  await until(() => ctl.killed.length === 2, 'the group stopped');

  assert.deepEqual([...ctl.killed].sort(), ['critique-0-vote-1-v1', 'critique-0-vote-1-v3']);
  assert.ok(ctl.held.includes('compact'), 'the rotation was stopped with the group');
  // The wrapper waits for the rotation, so the run cannot end while it is held.
  // Polled to a deadline for the group having charged both stopped siblings,
  // which is just before it rethrows, and failing at once if the run ends first:
  // "ended early" and "never got that far" are different findings.
  let over = false;
  void ended.then(() => {
    over = true;
  });
  await until(() => {
    assert.equal(over, false, 'the run ended with the rotation still live');
    return state.events.filter((e) => e.type === 'turn_failed').length === 2;
  }, 'the group to charge its two stopped siblings');
  assert.equal(over, false, 'the run ended with the rotation still live');

  ctl.release('compact');
  const code = await ended;
  // The decisive order, free of timing: the rotation can only record its
  // `session_rotated` once released, and the run's one escalation comes after
  // it - so the run's ending waited for the rotation to settle.
  const rotated = state.events.findIndex((e) => e.type === 'session_rotated');
  const escalated = state.events.findIndex((e) => e.type === 'escalation');
  assert.ok(rotated >= 0, 'the rotation recorded nothing');
  assert.ok(rotated < escalated, 'the run escalated before the rotation settled');

  assert.equal(code, EXIT.BUDGET);
  assert.equal(cancelRequested(), null, 'a ceiling set the run’s stop latch');
  assert.equal(ctl.killed.includes('compact'), false);
  assert.equal(state.sessionRotations, 1, 'the rotation did not settle');
  assert.deepEqual(calls.filter((l) => l.startsWith('critique-0-vote-')), THREE_LIVE, 'a fourth ballot was dispatched');

  const failed = state.events.filter((e) => e.type === 'turn_failed');
  assert.deepEqual(failed.map((e) => [e['label'], e['tokens']]).sort(), [
    ['critique-0-vote-1-v1', 700],
    ['critique-0-vote-1-v3', 700],
  ]);
  const escalations = state.events.filter((e) => e.type === 'escalation');
  assert.equal(escalations.length, 1);
  const at = state.events.indexOf(escalations[0]!);
  for (const e of failed) assert.ok(state.events.indexOf(e) < at, 'a sibling was recorded after the escalation');
  const message = String(escalations[0]?.['message']);
  assert.match(message, /^Token ceiling exceeded: /);
  assert.ok(
    message.includes("3 seat turns were live in this round's group when it was crossed: this one and 2 beside it"),
    message,
  );
  assert.equal(state.events.filter((e) => e.type === 'critique_votes_tallied').length, 0);
  assert.equal(existsSync(path.join(state.dir, 'plan-critique-0.json')), false);
});

test('a stop with three critique verifiers live kills all three, starts no fourth, and records no vote', async (t) => {
  t.after(() => clearCancel());
  const state = run('vibe-cparallel-stop-');
  const ctl = deferred({ hold: (l) => l.startsWith('critique-0-vote-') });
  const calls: string[] = [];
  const ended = executing(state, withCritique({ verifiers: THREE, maxParallel: 3 }), deferredAgents(sixBallots(), calls, ctl));
  t.after(async () => {
    for (const label of [...ctl.held]) ctl.release(label);
    await ended.catch(() => undefined);
  });
  await until(() => THREE_LIVE.every((l) => ctl.held.includes(l)), 'three votes live');
  requestCancel('stopped from the test');
  const code = await ended;

  assert.equal(code, EXIT.NEEDS_HUMAN);
  assert.equal(state.status, 'needs-input');
  assert.deepEqual([...ctl.killed].sort(), THREE_LIVE);
  assert.deepEqual(calls.filter((l) => l.startsWith('critique-0-vote-')), THREE_LIVE);
  const [escalation] = state.events.filter((e) => e.type === 'escalation');
  assert.match(String(escalation?.['message']), /^The run was stopped: stopped from the test/);
  assert.equal(state.events.filter((e) => e.type === 'critique_votes_tallied').length, 0);
  assert.equal(existsSync(path.join(state.dir, 'plan-critique-0.json')), false);
});

test('a critique bound that is not a whole number from 1 is refused by name', async () => {
  const { runSeatGroup } = await import('@src/seat-group.js');
  const state = run('vibe-cparallel-badbound-');
  let ran = 0;
  await assert.rejects(
    runSeatGroup(state, 0, [() => Promise.resolve(void (ran += 1))], 'critique.maxParallel'),
    /^Error: critique\.maxParallel is 0; it must be a whole number of turns from 1$/,
  );
  assert.equal(ran, 0);
});
