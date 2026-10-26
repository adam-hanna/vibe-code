import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { DEFAULTS, loadConfig, storedConfig } from '@src/config.js';
import { agents, config, freshRun, p1, planFixture, report, reviewingRun, work } from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, CritiqueConfig, Evidence, Finding, ReviewConfig, RunState } from '@src/types.js';

/**
 * One review round and one critique round, each with two finders and three
 * verifiers at `maxParallel: 1`, pinned whole (#452).
 *
 * Written before the review's and the critique's finder and vote runners were
 * made one, and recorded against the code they replaced, so that the refactor
 * is shown to move no byte: every narration (level, id, sentence and data, in
 * order), every recorded event but its time, every label dispatched, every
 * prompt sent, and the artifacts the rounds wrote.
 *
 * The expected record is `tests/fixtures/seat-runners-pin/<case>.json`. Nothing
 * rewrites it but `VIBE_RECORD_PIN=1`, which is how it was made, on 9c8478f. To
 * see it pass on the old runners, copy this file and that directory into a
 * checkout of 9c8478f and run it there.
 *
 * Normalized, and nothing else: the run's directory, target directory and id
 * (they differ per run), a git object name (a commit's date is in it), and a
 * field named `at` (wall-clock).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', 'tests', 'fixtures', 'seat-runners-pin');

interface Pinned {
  narration: unknown[];
  events: unknown[];
  calls: string[];
  prompts: [string, string][];
  artifacts: Record<string, string>;
  /** The config as a run stores it in `state.config`, when the case pins one (#447). */
  stored?: unknown;
}

function normal(state: RunState, text: string): string {
  return text
    .split(state.dir)
    .join('<dir>')
    .split(state.targetDir)
    .join('<target>')
    .split(state.id)
    .join('<id>')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/\b[0-9a-f]{7}\b/g, '<short-sha>');
}

async function drive(state: RunState, cfg: Config, handlers: Handlers, resume: boolean, files: readonly string[]): Promise<Pinned> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  const prompts: [string, string][] = [];
  const wrapped: Handlers = {
    claude: (label, options) => {
      prompts.push([label, normal(state, options.prompt)]);
      return handlers.claude?.(label, options);
    },
    codex: (label, options) => {
      prompts.push([label, normal(state, options.prompt)]);
      return handlers.codex?.(label, options) ?? report([]);
    },
  };
  log.setSink((n) => void seen.push(n));
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, resume, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  const json = (value: unknown): unknown => JSON.parse(normal(state, JSON.stringify(value))) as unknown;
  const artifacts: Record<string, string> = {};
  for (const name of files) {
    const at = path.join(state.dir, name);
    artifacts[name] = existsSync(at) ? normal(state, readFileSync(at, 'utf8')) : '<absent>';
  }
  return {
    narration: seen.map((n) => json({ level: n.level, id: n.id ?? null, message: n.message, data: n.data ?? null })),
    events: state.events.map(({ at: _at, ...rest }) => json(rest)),
    calls,
    prompts,
    artifacts,
  };
}

function pinned(name: string, got: Pinned): void {
  const file = path.join(fixtures, `${name}.json`);
  if (process.env['VIBE_RECORD_PIN'] === '1') {
    writeFileSync(file, `${JSON.stringify(got, null, 2)}\n`, 'utf8');
    return;
  }
  const want = JSON.parse(readFileSync(file, 'utf8')) as Pinned;
  assert.deepEqual(got.calls, want.calls, 'the labels dispatched moved');
  assert.deepEqual(got.prompts, want.prompts, 'a prompt moved');
  assert.deepEqual(got.narration, want.narration, 'the narration moved');
  assert.deepEqual(got.events, want.events, 'the recorded events moved');
  assert.deepEqual(got.artifacts, want.artifacts, 'an artifact moved');
  assert.deepEqual(got.stored, want.stored, 'the stored config moved');
}

const REAL = { vote: 'real', reason: 'It is there.', evidence: [] };
const CANNOT_TELL = { vote: 'cannot-tell', reason: 'Could not settle it.', evidence: [] };

/** Votes by finding, then by verifier: confirmed, unconfirmed, undecided. */
function ballot(n: number, k: number, notReal: unknown): unknown {
  const table = [
    [REAL, REAL, notReal],
    [notReal, notReal, REAL],
    [REAL, CANNOT_TELL, notReal],
  ];
  return table[n - 1]?.[k - 1] ?? REAL;
}

// ---- the review -------------------------------------------------------------

const CLAIMS: Evidence = { kind: 'code', path: 'claims.ts', line: 1 };
const claims = (line: number): Evidence => ({ ...CLAIMS, line });

function reviewBlocker(id: string, title: string, line: number): Finding {
  return { ...p1(id), title, evidence: [claims(line)] };
}

test('a review round with two finders and three verifiers at maxParallel 1 is pinned whole', async () => {
  const state = reviewingRun({ prefix: 'vibe-pin-review-' });
  work(state, 'claims.ts', ['a', 'b', 'c', 'd', 'e'].map((c) => `export const ${c} = 1;`).join('\n') + '\n');
  const notReal = { vote: 'not-real', reason: 'It is handled on line 1.', evidence: [{ ...claims(1), excerpt: null, ref: null }] };
  const answer = (label: string): unknown => {
    const vote = /^vote-\d+-(\d+)-v(\d+)$/.exec(label);
    if (vote !== null) {
      // The third verifier on the second finding falls over: a ballot not cast.
      if (vote[1] === '2' && vote[2] === '3') throw new Error('verifier fell over\nsecond line');
      return ballot(Number(vote[1]), Number(vote[2]), notReal);
    }
    if (label === 'review-0') {
      return report([reviewBlocker('alpha', 'Alpha breaks the parser', 1), reviewBlocker('beta', 'Beta leaks a handle', 2)]);
    }
    if (label === 'review-0-f1') {
      return report([
        reviewBlocker('alpha-again', 'The parser is broken by alpha', 1),
        reviewBlocker('gamma', 'Gamma races the writer', 3),
      ]);
    }
    if (label === 'review-0-f2') {
      return report([reviewBlocker('beta-two', 'Beta leaks a handle', 4), reviewBlocker('alpha', 'Delta drops a row', 5)]);
    }
    return report([]);
  };
  const handlers: Handlers = {
    codex: (label) => answer(label),
    claude: (label) => (label.startsWith('vote-') || label.startsWith('review-') ? answer(label) : 'done'),
  };
  const review: ReviewConfig = {
    ...DEFAULTS.review,
    finders: ['codex', 'claude'],
    verifiers: ['codex', 'claude', 'codex'],
    maxParallel: 1,
  };
  const cfg = config({ p1Tolerance: 0 }, { review });
  const got = await drive(state, cfg, handlers, true, ['code-review-0.json', 'code-review-1.json', 'FOLLOW-UPS.md']);
  assert.ok(got.calls.includes('review-0-f2') && got.calls.includes('vote-0-3-v3'), got.calls.join(', '));
  pinned('review', got);
});

// ---- the critique -----------------------------------------------------------

const WIDGET: Evidence = { kind: 'code', path: 'widget.ts', line: 1 };

function critiqueBlocker(id: string, title: string, line: number): Finding {
  return { ...p1(id), title, evidence: [{ ...WIDGET, line }] };
}

test('a critique round with two finders and three verifiers at maxParallel 1 is pinned whole', async () => {
  const state = freshRun({ prefix: 'vibe-pin-critique-', task: 'pin the critique' });
  writeFileSync(path.join(state.targetDir, 'widget.ts'), [1, 2, 3, 4, 5].map((n) => `export const w${n} = ${n};`).join('\n') + '\n', 'utf8');
  const notReal = { vote: 'not-real', reason: 'The plan handles it in step 2.', evidence: [{ ...WIDGET, excerpt: null, ref: null }] };
  const answer = (label: string): unknown => {
    const vote = /^critique-\d+-vote-(\d+)-v(\d+)$/.exec(label);
    if (vote !== null) {
      if (vote[1] === '2' && vote[2] === '3') throw new Error('verifier fell over\nsecond line');
      return ballot(Number(vote[1]), Number(vote[2]), notReal);
    }
    if (label === 'critique-0') {
      return report([critiqueBlocker('one', 'The plan skips the migration', 1), critiqueBlocker('two', 'No rollback is named', 2)]);
    }
    if (label === 'critique-0-f1') {
      return report([critiqueBlocker('one-again', 'The migration is skipped', 1), critiqueBlocker('three', 'The plan never tests it', 3)]);
    }
    if (label === 'critique-0-f2') return report([critiqueBlocker('two', 'No rollback is named', 4)]);
    // Round 2: the second finder falls over, and nothing else is found.
    if (label === 'critique-1-f2') throw new Error('finder fell over\nsecond line');
    return report([]);
  };
  const handlers: Handlers = {
    codex: (label) => answer(label),
    claude: (label) => (label.startsWith('critique-') ? answer(label) : planFixture()),
  };
  const critique: CritiqueConfig = {
    ...DEFAULTS.critique,
    finders: ['codex', 'claude'],
    verifiers: ['codex', 'claude', 'codex'],
  };
  const cfg = config({ p1Tolerance: 0 }, { critique });
  const got = await drive(state, cfg, handlers, false, [
    'plan-critique-0.json',
    'plan-critique-1.json',
    'plan-0.json',
    'plan-1.json',
    'FOLLOW-UPS.md',
  ]);
  assert.ok(got.calls.includes('critique-0-vote-3-v3') && got.calls.includes('critique-1-f2'), got.calls.join(', '));
  pinned('critique', got);
});

// ---- an explicit empty finder list (#447) -----------------------------------

/**
 * A run whose file says `"review": { "finders": [] }` is byte-identical to one
 * from before the default finder existed (#447): the whole loop - plan,
 * critique, implement, review - and the config `createRun` stores.
 *
 * Recorded on 32f49e3, before the default was resolved, so the record is of
 * the code that had no default to opt out of. There the stored config was the
 * loaded one as it stood; it is `storedConfig` of it now, which is what
 * `startRun` hands `createRun`, and the record was not re-made. The config is built by
 * `loadConfig` from a file, not from `DEFAULTS`, because the file naming the
 * key is the whole case; the file also neuters what `config()` neuters.
 */
test('a full loop whose file sets review.finders to [] is pinned whole, stored config included', async () => {
  const state = freshRun({ prefix: 'vibe-pin-empty-finders-', task: 'pin the opt-out', planOnly: false, git: true, commit: true });
  const project = mkdtempSync(path.join(tmpdir(), 'vibe-pin-empty-finders-config-'));
  writeFileSync(
    path.join(project, 'vibe.config.json'),
    JSON.stringify({
      codex: { readRateLimits: false },
      context: { enabled: false },
      progress: { enabled: true, intervalMs: 60_000 },
      verify: { enabled: false },
      git: { commitEachRound: false },
      budget: { planShare: 0 },
      review: { finders: [] },
    }),
    'utf8',
  );
  const loaded = loadConfig(project);
  const stored = JSON.parse(JSON.stringify(storedConfig(loaded)).split(project).join('<project>')) as unknown;
  const handlers: Handlers = {
    claude: (label) => (label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`)),
    codex: () => report([]),
  };
  const got = await drive(state, loaded, handlers, false, ['PLAN.md', 'code-review-0.json', 'FOLLOW-UPS.md']);
  assert.deepEqual(got.calls, ['plan', 'critique-0', 'implement', 'review-0']);
  pinned('explicit-empty-finders', { ...got, stored });
});
