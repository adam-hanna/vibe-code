import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearCancel, cancelRequested, requestCancel } from '@src/cancel.js';
import { execute } from '@src/cli.js';
import { DEFAULTS, loadConfig } from '@src/config.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { fmtTokens } from '@src/charge.js';
import { EXIT, orchestrate } from '@src/orchestrator.js';
import {
  agents,
  config,
  deferred,
  deferredAgents,
  p1,
  report,
  reviewingRun,
  until,
  work,
} from './helpers/loop-harness.js';
import type { Deferred, Handlers } from './helpers/loop-harness.js';
import type { AgentTurns } from '@src/orchestrator.js';
import type { Config, Evidence, Finding, ReviewConfig, RunState } from '@src/types.js';

/**
 * Review finders and verifiers running at once, through the real loop (#403).
 *
 * `review.maxParallel` lets the finders, and then every ballot of the round,
 * run side by side. These cases hold turns open with `deferredAgents` so that
 * they genuinely overlap, then decide the order they finish in - which is what
 * the artifacts must not depend on, and what a ceiling, a stop and a silent seat
 * must each handle with siblings still live.
 */

const HERE = (line: number): Evidence => ({ kind: 'code', path: 'claims.ts', line });

function blocker(id: string, title: string, line: number): Finding {
  return { ...p1(id), title, evidence: [HERE(line)] };
}

function withReview(review: Partial<ReviewConfig>, over: Partial<Config> = {}): Config {
  return config({ p1Tolerance: 0 }, { review: { ...DEFAULTS.review, ...review }, ...over });
}

/** A run reviewing a tree with a five-line file every finding below can cite. */
function run(prefix: string): RunState {
  const state = reviewingRun({ prefix });
  work(state, 'claims.ts', ['a', 'b', 'c', 'd', 'e'].map((c) => `export const ${c} = 1;`).join('\n') + '\n');
  return state;
}

const REAL = { vote: 'real', reason: 'It is there.', evidence: [] };
const NOT_REAL = {
  vote: 'not-real',
  reason: 'It is handled on line 1.',
  evidence: [{ ...HERE(1), excerpt: null, ref: null }],
};
const CANNOT_TELL = { vote: 'cannot-tell', reason: 'Could not settle it.', evidence: [] };

/**
 * The same answers whatever the order: a reviewer and two finders whose
 * findings merge by citation, by title and by a clashing id, and a split vote
 * that differs per finding and per verifier.
 */
function panel(): Handlers {
  const answer = (label: string): unknown => {
    if (label.startsWith('vote-')) {
      const [, n, k] = /^vote-\d+-(\d+)-v(\d+)$/.exec(label) ?? [];
      // Confirmed, unconfirmed (moved to P2, so FOLLOW-UPS.md is written),
      // undecided, and confirmed again - by finding, then by verifier.
      const table = [
        [REAL, REAL, NOT_REAL],
        [NOT_REAL, NOT_REAL, REAL],
        [REAL, CANNOT_TELL, NOT_REAL],
      ];
      return table[Number(n) - 1]?.[Number(k) - 1] ?? REAL;
    }
    if (label === 'review-0') {
      return report([blocker('alpha', 'Alpha breaks the parser', 1), blocker('beta', 'Beta leaks a handle', 2)]);
    }
    if (label === 'review-0-f1') {
      return report([
        blocker('alpha-again', 'The parser is broken by alpha', 1),
        blocker('gamma', 'Gamma races the writer', 3),
      ]);
    }
    if (label === 'review-0-f2') {
      return report([blocker('beta-two', 'Beta leaks a handle', 4), blocker('alpha', 'Delta drops a row', 5)]);
    }
    return report([]);
  };
  return {
    codex: (label) => answer(label),
    claude: (label) => (label.startsWith('vote-') || label.startsWith('review-') ? answer(label) : 'done'),
  };
}

const SEAT = /^(review-\d+-f\d+|vote-)/;

/** The run's own paths and id, so two runs' records can be compared byte for byte. */
function normal(state: RunState, text: string): string {
  return text.split(state.dir).join('<dir>').split(state.targetDir).join('<target>').split(state.id).join('<id>');
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
    // A few quiet polls: every turn that could start has started.
    const newest = ctl.held[ctl.held.length - 1];
    if (quiet >= 3 && newest !== undefined) {
      ctl.release(newest);
      seenHeld = ctl.held.length;
      quiet = 0;
    }
  }
}

async function driveHeld(state: RunState, cfg: Config, handlers: Handlers, ctl: Deferred): Promise<string[]> {
  const calls: string[] = [];
  const over = quietly(() => orchestrate(state, cfg, true, deferredAgents(handlers, calls, ctl)));
  await Promise.all([over, lifo(ctl, over)]);
  return calls;
}

function file(state: RunState, name: string): string {
  return normal(state, readFileSync(path.join(state.dir, name), 'utf8'));
}

// ---- results do not depend on the order turns finish in ------------------

test('two finders and three verifiers at maxParallel 4, finishing in reverse, write what maxParallel 1 writes', async () => {
  const review = { finders: ['codex', 'codex'], verifiers: ['codex', 'claude', 'codex'] } as Partial<ReviewConfig>;

  const one = run('vibe-parallel-one-');
  const oneCtl = deferred({ hold: (l) => SEAT.test(l) });
  await driveHeld(one, withReview({ ...review, maxParallel: 1 }), panel(), oneCtl);

  const four = run('vibe-parallel-four-');
  const fourCtl = deferred({ hold: (l) => SEAT.test(l) });
  const calls = await driveHeld(four, withReview({ ...review, maxParallel: 4 }), panel(), fourCtl);

  assert.equal(oneCtl.maxLive, 1, 'maxParallel 1 overlapped turns');
  assert.equal(fourCtl.maxLive, 4, 'maxParallel 4 never had four seat turns live');
  assert.ok(calls.includes('vote-0-1-v1'), `no vote in ${calls.join(', ')}`);

  const artifact = file(four, 'code-review-0.json');
  assert.equal(artifact, file(one, 'code-review-0.json'));
  // And it is a round with something in it to have got wrong.
  const findings = (JSON.parse(artifact) as { findings: Finding[] }).findings;
  assert.ok(findings.some((f) => (f.foundBy?.length ?? 0) > 1), 'nothing was merged across finders');
  assert.ok(findings.some((f) => f.id === 'alpha-f2'), 'the clashing id was not renamed');
  assert.ok(findings.some((f) => f.votes !== undefined), 'nothing was voted on');
  assert.equal(file(four, 'FOLLOW-UPS.md'), file(one, 'FOLLOW-UPS.md'));
  assert.equal(four.status, 'done');
});

test('at most maxParallel seat turns are live at once, and the bound is reached', async () => {
  const four = run('vibe-parallel-bound-');
  const findings = [1, 2, 3, 4].map((n) => blocker(`claim-${n}`, `Claim ${n} is wrong in its own way`, n));
  const handlers: Handlers = {
    codex: (label) => (label.startsWith('vote-') ? REAL : label === 'review-0' ? report(findings) : report([])),
    claude: () => 'done',
  };
  const ctl = deferred({ delayMs: 5 });
  const calls: string[] = [];
  await quietly(() =>
    orchestrate(four, withReview({ verifiers: ['codex', 'codex', 'codex'], maxParallel: 4 }), true, deferredAgents(handlers, calls, ctl)),
  );
  assert.equal(calls.filter((l) => l.startsWith('vote-0-')).length, 12);
  assert.equal(ctl.maxLive, 4);

  const one = run('vibe-parallel-bound-one-');
  const oneCtl = deferred({ delayMs: 1 });
  await quietly(() =>
    orchestrate(one, withReview({ verifiers: ['codex', 'codex', 'codex'], maxParallel: 1 }), true, deferredAgents(handlers, [], oneCtl)),
  );
  assert.equal(oneCtl.maxLive, 1);
});

// ---- a ceiling, a stop and a silence, with siblings live ------------------

/** Two blocking findings and three verifiers: six ballots, three live at once. */
function sixBallots(): Handlers {
  const found = [blocker('first', 'The first claim', 1), blocker('second', 'The second claim', 2)];
  return {
    codex: (label) => (label.startsWith('vote-') ? REAL : label === 'review-0' ? report(found) : report([])),
    claude: (label) => (label.startsWith('vote-') ? REAL : 'done'),
  };
}

const THREE_LIVE = ['vote-0-1-v1', 'vote-0-1-v2', 'vote-0-1-v3'];

/** `execute`, so the run ends the way `vibe run` ends it, with the loop on held turns. */
function executing(state: RunState, cfg: Config, turns: AgentTurns, seen: Narration[] = []): Promise<number> {
  clearCancel();
  return quietly(
    () => execute(state, cfg, true, true, () => Promise.resolve(null), (s, c, r) => orchestrate(s, c, r, turns)),
    seen,
  );
}

test('a ceiling crossed by one ballot stops its live siblings, charges them, and ends the run once', async () => {
  const state = run('vibe-parallel-ceiling-');
  const cfg = withReview({ verifiers: ['codex', 'codex', 'codex'], maxParallel: 3 });
  const ctl = deferred({ hold: (l) => l.startsWith('vote-'), spentOnKill: 700 });
  const calls: string[] = [];
  const ended = executing(state, cfg, deferredAgents(sixBallots(), calls, ctl));

  await until(() => THREE_LIVE.every((l) => ctl.held.includes(l)), 'three votes live');
  // The ballot about to land takes the run over: everything spent so far is
  // allowed, and its own 500 tokens are not.
  cfg.budget.maxTokens = state.tokensUsed + 1;
  ctl.release('vote-0-1-v2');
  const code = await ended;

  assert.equal(code, EXIT.BUDGET);
  assert.equal(cancelRequested(), null, 'a ceiling set the run’s stop latch');
  assert.deepEqual(ctl.killed.sort(), ['vote-0-1-v1', 'vote-0-1-v3']);
  assert.deepEqual(calls.filter((l) => l.startsWith('vote-')), THREE_LIVE, 'a fourth ballot was dispatched');

  const failed = state.events.filter((e) => e.type === 'turn_failed');
  assert.deepEqual(failed.map((e) => [e['label'], e['tokens']]).sort(), [
    ['vote-0-1-v1', 700],
    ['vote-0-1-v3', 700],
  ]);
  assert.equal(state.events.filter((e) => e.type === 'review_votes_tallied').length, 0);
  assert.equal(existsSync(path.join(state.dir, 'code-review-0.json')), false);

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
  assert.ok(message.includes(`the run now stands at ${fmtTokens(state.tokensUsed)} tokens`), message);
});

test('at maxParallel 1 the same ceiling ends the run with the sentence it always had', async () => {
  const state = run('vibe-parallel-ceiling-one-');
  const cfg = withReview({ verifiers: ['codex', 'codex', 'codex'], maxParallel: 1 });
  const ctl = deferred({ hold: (l) => l.startsWith('vote-') });
  const ended = executing(state, cfg, deferredAgents(sixBallots(), [], ctl));
  await until(() => ctl.held.includes('vote-0-1-v1'), 'the first vote');
  cfg.budget.maxTokens = state.tokensUsed + 1;
  ctl.release('vote-0-1-v1');
  assert.equal(await ended, EXIT.BUDGET);
  const [escalation] = state.events.filter((e) => e.type === 'escalation');
  assert.match(String(escalation?.['message']), /^Token ceiling exceeded: \S+ > \S+\. Raise budget\.maxTokens to continue\.$/);
});

test('a stop with three verifiers live kills all three, starts no fourth, and records no vote', async () => {
  const state = run('vibe-parallel-stop-');
  const ctl = deferred({ hold: (l) => l.startsWith('vote-') });
  const calls: string[] = [];
  const ended = executing(
    state,
    withReview({ verifiers: ['codex', 'codex', 'codex'], maxParallel: 3 }),
    deferredAgents(sixBallots(), calls, ctl),
  );
  await until(() => THREE_LIVE.every((l) => ctl.held.includes(l)), 'three votes live');
  requestCancel('stopped from the test');
  const code = await ended;

  assert.equal(code, EXIT.NEEDS_HUMAN);
  assert.equal(state.status, 'needs-input');
  assert.deepEqual(ctl.killed.sort(), THREE_LIVE);
  assert.deepEqual(calls.filter((l) => l.startsWith('vote-')), THREE_LIVE);
  const [escalation] = state.events.filter((e) => e.type === 'escalation');
  assert.match(String(escalation?.['message']), /^The run was stopped: stopped from the test/);
  assert.equal(state.events.filter((e) => e.type === 'review_votes_tallied').length, 0);
  assert.equal(existsSync(path.join(state.dir, 'code-review-0.json')), false);
  clearCancel();
});

test('a silent verifier among three live ones stops the run, kills the other two, and records no vote', async () => {
  const state = run('vibe-parallel-quiet-');
  const cfg = withReview({ verifiers: ['claude', 'claude', 'claude'], maxParallel: 3 });
  const ctl = deferred({ hold: (l) => l.startsWith('vote-') });
  const ended = executing(state, cfg, deferredAgents(sixBallots(), [], ctl));
  await until(() => THREE_LIVE.every((l) => ctl.held.includes(l)), 'three votes live');

  // The heartbeat's own seam: v2 reports it has been silent for the ceiling.
  ctl.options.get('vote-0-1-v2')?.progress?.onQuiet?.(cfg.progress.maxQuietMs);
  const code = await ended;

  assert.equal(code, EXIT.NEEDS_HUMAN);
  assert.equal(state.status, 'needs-input');
  assert.deepEqual(ctl.killed.sort(), THREE_LIVE);
  const [escalation] = state.events.filter((e) => e.type === 'escalation');
  assert.match(String(escalation?.['message']), /vote-0-1-v2 turn produced no output/);
  assert.match(String(escalation?.['message']), /progress\.maxQuietMs/);
  assert.equal(state.events.filter((e) => e.type === 'review_votes_tallied').length, 0);
  clearCancel();
});

// ---- one failure stays local ---------------------------------------------

test('one finder failing beside two that report records its failure and merges the other two', async () => {
  const state = run('vibe-parallel-finder-fails-');
  const handlers: Handlers = {
    codex: (label) => {
      if (label === 'review-0-f2') throw new Error('finder two fell over');
      if (label === 'review-0') return report([blocker('alpha', 'Alpha breaks the parser', 1)]);
      if (label === 'review-0-f1') return report([blocker('gamma', 'Gamma races the writer', 3)]);
      if (label === 'review-0-f3') return report([blocker('delta', 'Delta drops a row', 5)]);
      return report([]);
    },
    claude: () => 'done',
  };
  const ctl = deferred({ hold: (l) => SEAT.test(l) });
  await driveHeld(state, withReview({ finders: ['codex', 'codex', 'codex'], maxParallel: 3 }), handlers, ctl);

  const failed = state.events.filter((e) => e.type === 'review_finder_failed');
  assert.deepEqual(failed.map((e) => e['finder']), [2]);
  const [merged] = state.events.filter((e) => e.type === 'review_finders_merged');
  assert.equal(merged?.['finders'], 4);
  assert.equal(merged?.['reported'], 3, '2 of the 3 extra finders, and the reviewer');
  const ids = (JSON.parse(file(state, 'code-review-0.json')) as { findings: Finding[] }).findings.map((f) => f.id);
  assert.deepEqual(ids, ['alpha', 'gamma', 'delta']);
});

// ---- maxParallel 1 is today --------------------------------------------------

async function plain(cfg: Config, prefix: string): Promise<{ state: RunState; calls: string[]; seen: Narration[]; prompts: string[] }> {
  const state = run(prefix);
  const calls: string[] = [];
  const seen: Narration[] = [];
  const prompts: string[] = [];
  const base = panel();
  const handlers: Handlers = {
    codex: (label, options) => {
      prompts.push(`${label}\n${normal(state, options.prompt)}`);
      return base.codex?.(label, options);
    },
    claude: (label, options) => {
      prompts.push(`${label}\n${normal(state, options.prompt)}`);
      return base.claude?.(label, options);
    },
  };
  await quietly(() => orchestrate(state, cfg, true, agents(handlers, calls)), seen);
  return { state, calls, seen, prompts };
}

/** What two runs must agree on: every event but its time, as data. */
function record(state: RunState): unknown[] {
  return state.events.map(({ at: _at, ...rest }) => JSON.parse(normal(state, JSON.stringify(rest))) as unknown);
}

/** The `review` section a project file with no `maxParallel` loads to - the key truly absent. */
function loadedWithoutKey(seats: Partial<ReviewConfig>): ReviewConfig {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-parallel-nokey-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ review: seats }));
  const review = loadConfig(dir).review;
  assert.equal(Object.prototype.hasOwnProperty.call(seats, 'maxParallel'), false);
  return review;
}

test('maxParallel 1 runs every seat one after another, as a file without the key does', async () => {
  const seats = { finders: ['codex'], verifiers: ['codex', 'claude', 'codex'] } as Partial<ReviewConfig>;
  const absent = await plain(config({ p1Tolerance: 0 }, { review: loadedWithoutKey(seats) }), 'vibe-parallel-absent-');
  const one = await plain(withReview({ ...seats, maxParallel: 1 }), 'vibe-parallel-explicit-one-');
  // What a sequential round dispatches, written out rather than compared with
  // itself: the reviewer, then the finder, then for each finding voted on every
  // verifier in turn - finding 1 to v1, v2, v3, then finding 2.
  const seatCalls = one.calls.filter((l) => /^(review-0|vote-0-)/.test(l));
  const voted = [...new Set(seatCalls.flatMap((l) => /^vote-0-(\d+)-v\d+$/.exec(l)?.[1] ?? []))];
  assert.ok(voted.length > 0, 'nothing was voted on, so the order proves nothing');
  assert.deepEqual(seatCalls, [
    'review-0',
    'review-0-f1',
    ...voted.flatMap((n) => [1, 2, 3].map((k) => `vote-0-${n}-v${String(k)}`)),
  ]);
  assert.deepEqual(voted, [...voted].sort((a, b) => Number(a) - Number(b)));
  assert.deepEqual(one.calls, absent.calls);
  assert.deepEqual(one.prompts, absent.prompts);
  assert.deepEqual(record(one.state), record(absent.state));
  assert.equal(file(one.state, 'code-review-0.json'), file(absent.state, 'code-review-0.json'));
  // Nothing new is narrated at 1: no label on a seat's start, no finish line.
  const seatStarts = one.seen.filter((n) => n.id === 'turn_started' && (n.data?.['finder'] ?? n.data?.['verifier']) !== undefined);
  assert.ok(seatStarts.length > 0);
  for (const n of seatStarts) assert.equal('label' in (n.data ?? {}), false);
  assert.equal(one.seen.filter((n) => n.id === 'turn_finished').length, 0);
});

test('with no seats, maxParallel changes nothing at all', async () => {
  const absent = await plain(config({ p1Tolerance: 0 }), 'vibe-parallel-noseats-');
  const eight = await plain(withReview({ maxParallel: 8 }), 'vibe-parallel-noseats-eight-');
  assert.deepEqual(eight.calls, absent.calls);
  assert.deepEqual(eight.prompts, absent.prompts);
  assert.deepEqual(record(eight.state), record(absent.state));
  assert.equal(file(eight.state, 'code-review-0.json'), file(absent.state, 'code-review-0.json'));
});

test('above 1, a seat turn says its label when it starts and says when it finished', async () => {
  const state = run('vibe-parallel-frames-');
  const seen: Narration[] = [];
  await quietly(
    () =>
      orchestrate(
        state,
        withReview({ finders: ['codex'], verifiers: ['codex', 'codex'], maxParallel: 2 }),
        true,
        agents(panel(), []),
      ),
    seen,
  );
  const started = seen.filter((n) => n.id === 'turn_started' && n.data?.['kind'] === 'vote');
  assert.equal(started[0]?.data?.['label'], 'vote-0-1-v1');
  const finished = seen.filter((n) => n.id === 'turn_finished').map((n) => n.data?.['label']);
  assert.ok(finished.includes('review-0-f1'));
  assert.ok(finished.includes('vote-0-1-v1'));
  // The reviewer itself is not a seat, and is unchanged.
  const reviewer = seen.find((n) => n.id === 'turn_started' && n.data?.['kind'] === 'review');
  assert.deepEqual(reviewer?.data, { role: 'reviewer', kind: 'review', round: 0 });
});

test('a bound that is not a whole number from 1 is refused, never read as no seats at all', async () => {
  const { runSeatGroup } = await import('@src/seat-group.js');
  const state = run('vibe-parallel-badbound-');
  let ran = 0;
  for (const bad of [Number.NaN, 0, 1.5, undefined as unknown as number]) {
    await assert.rejects(
      runSeatGroup(state, bad, [() => Promise.resolve(void (ran += 1))]),
      /review\.maxParallel is .*; it must be a whole number of turns from 1/,
    );
  }
  assert.equal(ran, 0);
});
