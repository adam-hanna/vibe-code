import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import {
  agents,
  config,
  p1,
  report,
  reviewingRun,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, Evidence, Finding, ReviewConfig, RunState } from '@src/types.js';
import { DEFAULTS } from '@src/config.js';

/**
 * Additional review finders, driven through the real loop (#388 Part B).
 *
 * Each finder is the reviewer's job on a swapped seat: it reviews every part
 * after `roles.reviewer` has, under its own label, and the round's findings are
 * merged across finders by claim. Every agent here is injected; git and the
 * artifacts are real, which is what lets a case read `code-review-0.json` and
 * the fix prompt rather than a value the harness made up.
 */

interface Driven {
  calls: string[];
  seen: Narration[];
  /** Every prompt a turn was handed, by label. */
  prompts: Map<string, string>;
  /** Every session id a Claude turn was spawned under, by label. */
  sessions: Map<string, string | undefined>;
  out: string[];
}

function withReview(review: Partial<ReviewConfig>, over: Partial<Config> = {}): Config {
  return config({ p1Tolerance: 0 }, { review: { ...DEFAULTS.review, ...review }, ...over });
}

async function drive(state: RunState, cfg: Config, handlers: Handlers): Promise<Driven> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  const prompts = new Map<string, string>();
  const sessions = new Map<string, string | undefined>();
  const out: string[] = [];
  const wrapped: Handlers = {
    ...handlers,
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      sessions.set(label, options.sessionId);
      return handlers.claude?.(label, options) ?? work(state, `${label}.txt`);
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      return handlers.codex?.(label, options) ?? report([]);
    },
  };
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    out.push(parts.map((p) => String(p)).join(' '));
  };
  log.setSink((n) => void seen.push(n));
  console.log = collect;
  console.error = collect;
  try {
    await orchestrate(state, cfg, true, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return { calls, seen, prompts, sessions, out };
}

function artifact(state: RunState, n = 0): { verdict: string; summary: string; findings: Finding[] } {
  return JSON.parse(readFileSync(path.join(state.dir, `code-review-${n}.json`), 'utf8')) as {
    verdict: string;
    summary: string;
    findings: Finding[];
  };
}

/** A tree whose diff needs several reviewer turns at the real 400k limit. */
function bigTree(state: RunState): void {
  const line = `${'x'.repeat(79)}\n`;
  for (const name of ['one.txt', 'two.txt', 'three.txt']) {
    work(state, name, line.repeat(Math.ceil(200_000 / line.length)));
  }
}

/** A finding citing a real line of the fixture's own file, so grounding keeps it blocking. */
function citing(id: string, title: string): Finding {
  const at: Evidence = { kind: 'code', path: 'implemented.ts', line: 1 };
  return { ...p1(id), title, evidence: [at] };
}

test('two finders run after the reviewer on a single-part diff, in order', async () => {
  const state = reviewingRun({ prefix: 'vibe-finders-order-' });
  const { calls } = await drive(state, withReview({ finders: ['codex', 'codex'] }), {});
  const at = calls.indexOf('review-0');
  assert.ok(at >= 0, `no review-0 in ${calls.join(', ')}`);
  assert.deepEqual(calls.slice(at, at + 3), ['review-0', 'review-0-f1', 'review-0-f2']);
  assert.equal(state.status, 'done');
});

test('on a chunked diff every finder reviews every part, finder by finder', async () => {
  const state = reviewingRun({ prefix: 'vibe-finders-chunked-', change: false });
  bigTree(state);
  const { calls } = await drive(state, withReview({ finders: ['codex', 'codex'] }), {});
  const review = calls.filter((l) => l.startsWith('review-0'));
  const parts = review.filter((l) => /^review-0-part\d+$/.test(l)).length;
  assert.ok(parts > 1, `the diff was not chunked: ${review.join(', ')}`);
  const expected = [
    ...Array.from({ length: parts }, (_, i) => `review-0-part${i + 1}`),
    ...Array.from({ length: parts }, (_, i) => `review-0-f1-part${i + 1}`),
    ...Array.from({ length: parts }, (_, i) => `review-0-f2-part${i + 1}`),
  ];
  assert.deepEqual(review, expected);
});

test('a defect only finder 2 raised blocks the round and reaches the fix prompt', async () => {
  const state = reviewingRun({ prefix: 'vibe-finders-only-f2-' });
  const { calls, prompts } = await drive(state, withReview({ finders: ['codex', 'codex'] }), {
    codex: (label) => (label === 'review-0-f2' ? report([p1('only-finder-two')]) : report([])),
  });
  assert.ok(calls.includes('fix-1'), `no fix round in ${calls.join(', ')}`);
  assert.match(prompts.get('fix-1') ?? '', /only-finder-two/);
});

test('a defect two finders cite at the same line is one fix item, with both in foundBy', async () => {
  const state = reviewingRun({ prefix: 'vibe-finders-dup-' });
  const { prompts } = await drive(state, withReview({ finders: ['codex'] }), {
    codex: (label) => {
      if (label === 'review-0') return report([citing('dup-a', 'The flag is exported as a constant')]);
      if (label === 'review-0-f1') return report([citing('dup-b', 'Mutable state leaks between callers')]);
      return report([]);
    },
  });
  const fix = prompts.get('fix-1') ?? '';
  assert.match(fix, /dup-a/);
  assert.doesNotMatch(fix, /dup-b/);
  const found = artifact(state).findings;
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]?.foundBy, [
    { seat: 'roles.reviewer', provider: 'codex', model: 'default', id: 'dup-a' },
    { seat: 'review.finders[0]', provider: 'codex', model: 'default', id: 'dup-b' },
  ]);
});

test('foundBy is in the round artifact with finders, and absent without them', async () => {
  const seated = reviewingRun({ prefix: 'vibe-finders-foundby-' });
  await drive(seated, withReview({ finders: [{ provider: 'codex', model: 'gpt-fixture' }] }), {
    codex: (label) => (label === 'review-0' ? report([{ ...p1('mine'), severity: 'P2' }]) : report([])),
  });
  const [only] = artifact(seated).findings;
  assert.deepEqual(only?.foundBy, [{ seat: 'roles.reviewer', provider: 'codex', model: 'default', id: 'mine' }]);

  const plain = reviewingRun({ prefix: 'vibe-finders-plain-' });
  await drive(plain, withReview({}), {
    codex: (label) => (label === 'review-0' ? report([{ ...p1('mine'), severity: 'P2' }]) : report([])),
  });
  assert.doesNotMatch(readFileSync(path.join(plain.dir, 'code-review-0.json'), 'utf8'), /foundBy/);
  assert.equal(plain.events.some((e) => e.type === 'review_finders_merged'), false);
});

test('a failed additional finder is recorded, and the round finishes on the rest', async () => {
  const state = reviewingRun({ prefix: 'vibe-finders-fail-' });
  const { out, seen } = await drive(state, withReview({ finders: ['codex'] }), {
    codex: (label) => {
      if (label === 'review-0-f1') throw new Error('finder fell over\nsecond line');
      return report([]);
    },
  });
  assert.equal(state.status, 'done');
  const failed = state.events.find((e) => e.type === 'review_finder_failed');
  assert.ok(failed !== undefined, 'review_finder_failed is recorded');
  assert.equal(failed['label'], 'review-0-f1');
  assert.equal(failed['seat'], 'review.finders[0]');
  assert.equal(failed['error'], 'finder fell over');
  assert.ok(out.some((l) => l.includes('1 of 2 reported')), 'the narration says 1 of 2');
  const merged = seen.find((n) => n.id === 'review_finders_merged');
  assert.equal(merged?.data?.['reported'], 1);
  assert.equal(merged?.data?.['finders'], 2);
});

test("a Claude finder runs on a fresh session, and main's id is untouched", async () => {
  const state = reviewingRun({ prefix: 'vibe-finders-claude-' });
  const main = state.sessionId;
  const { sessions } = await drive(state, withReview({ finders: ['claude'] }), {
    claude: (label) => (label === 'review-0-f1' ? report([]) : undefined),
  });
  const used = sessions.get('review-0-f1');
  assert.equal(typeof used, 'string');
  assert.notEqual(used, main);
  assert.equal(state.sessionId, main);
});

test("focus reaches its own finder's prompt only", async () => {
  const state = reviewingRun({ prefix: 'vibe-finders-focus-' });
  const { prompts } = await drive(
    state,
    withReview({ finders: ['codex', { provider: 'codex', focus: 'security' }] }),
    {},
  );
  const first = prompts.get('review-0') ?? '';
  const f1 = prompts.get('review-0-f1') ?? '';
  const f2 = prompts.get('review-0-f2') ?? '';
  // Round 0's first review is memoryless too, so all three share a prompt.
  assert.equal(f1, first);
  assert.doesNotMatch(f1, /Focus for this review/);
  assert.equal(f2, `${f1}\n\n## Focus for this review\n\nsecurity`);
});

test("a finder's turn_started names it; the first finder's frame is unchanged", async () => {
  const state = reviewingRun({ prefix: 'vibe-finders-frames-' });
  const { seen } = await drive(state, withReview({ finders: ['codex'] }), {});
  const frames = seen.filter((n) => n.id === 'turn_started' && n.data?.['kind'] === 'review');
  assert.deepEqual(
    frames.map((n) => n.data),
    [
      { role: 'reviewer', kind: 'review', round: 0 },
      { role: 'reviewer', kind: 'review', round: 0, finder: 1, seat: 'review.finders[0]' },
    ],
  );
});
