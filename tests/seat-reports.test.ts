import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { DEFAULTS } from '@src/config.js';
import { agents, config, freshRun, p1, planFixture, report, reviewingRun, work } from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, Evidence, Finding, RunState } from '@src/types.js';

/**
 * Each seat's own report, and the near pairs the fixer was told about, written
 * beside the round for the window (#530). Groundwork: nothing reads them to
 * decide, and a round without finders writes neither.
 */

interface SeatFile {
  round: number;
  k: number;
  seat: string;
  provider: string;
  model: string;
  findings: Finding[];
}

async function drive(
  state: RunState,
  cfg: Config,
  codex: (label: string) => unknown,
  claude: NonNullable<Handlers['claude']>,
  resume: boolean,
): Promise<{ calls: string[]; seen: Narration[] }> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  log.setSink((n) => void seen.push(n));
  const original = { log: console.log, error: console.error };
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, resume, agents({ claude, codex: (label) => codex(label) }, calls));
  } finally {
    log.setSink(null);
    console.log = original.log;
    console.error = original.error;
  }
  return { calls, seen };
}

function read<T>(state: RunState, name: string): T {
  return JSON.parse(readFileSync(path.join(state.dir, name), 'utf8')) as T;
}

const at = (line: number): Evidence => ({ kind: 'code', path: 'implemented.ts', line });
const cites = (id: string, line: number, title?: string): Finding => ({
  ...p1(id),
  ...(title === undefined ? {} : { title }),
  evidence: [at(line)],
});
const lines = 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n';

function reviewCfg(finders: string[]): Config {
  return config({ p1Tolerance: 0 }, { review: { ...DEFAULTS.review, finders } as typeof DEFAULTS.review });
}

test('a review with finders writes each seat its own report, in its own words and ids', async () => {
  const state = reviewingRun({ prefix: 'vibe-seat-reports-' });
  work(state, 'implemented.ts', lines);
  await drive(
    state,
    reviewCfg(['codex', 'codex']),
    (label) => {
      if (label === 'review-0') return report([cites('reviewer-id', 1, 'The flag is a constant')]);
      if (label === 'review-0-f1') return report([cites('finder-id', 1, 'Mutable state leaks')]);
      return report([]);
    },
    (label) => work(state, `${label}.txt`),
    true,
  );
  // The merge kept one finding, the reviewer's words; the finder's survive only in its own file.
  const merged = read<{ findings: Finding[] }>(state, 'code-review-0.json').findings;
  assert.deepEqual(merged.map((f) => f.title), ['The flag is a constant']);

  const zero = read<SeatFile>(state, 'code-review-0.seat-0.json');
  assert.deepEqual([zero.round, zero.k, zero.seat, zero.provider], [0, 0, 'roles.reviewer', 'codex']);
  assert.deepEqual(zero.findings.map((f) => [f.id, f.title]), [['reviewer-id', 'The flag is a constant']]);

  const one = read<SeatFile>(state, 'code-review-0.seat-1.json');
  assert.deepEqual([one.k, one.seat, one.model], [1, 'review.finders[0]', 'default']);
  assert.deepEqual(one.findings.map((f) => [f.id, f.title]), [['finder-id', 'Mutable state leaks']]);
  assert.equal(one.findings[0]?.foundBy, undefined, 'the seat as it said it, before the merge credited anyone');

  const two = read<SeatFile>(state, 'code-review-0.seat-2.json');
  assert.deepEqual(two.findings, [], 'a seat that reported nothing still reported');
});

test('a finder that failed has no file, and a stale one from an earlier attempt is removed', async () => {
  const state = reviewingRun({ prefix: 'vibe-seat-reports-failed-' });
  writeFileSync(path.join(state.dir, 'code-review-0.seat-1.json'), '{"stale":true}', 'utf8');
  await drive(
    state,
    reviewCfg(['codex']),
    (label) => {
      if (label === 'review-0-f1') throw new Error('the finder fell over');
      return report([]);
    },
    (label) => work(state, `${label}.txt`),
    true,
  );
  assert.ok(existsSync(path.join(state.dir, 'code-review-0.seat-0.json')));
  assert.ok(!existsSync(path.join(state.dir, 'code-review-0.seat-1.json')));
});

test('without finders no seat file and no near-pairs file is written, and no narration names one', async () => {
  const state = reviewingRun({ prefix: 'vibe-seat-reports-none-' });
  work(state, 'implemented.ts', lines);
  const { calls, seen } = await drive(
    state,
    reviewCfg([]),
    (label) => (label === 'review-0' ? report([cites('one', 2), cites('two', 3)]) : report([])),
    (label) => work(state, `${label}.txt`),
    true,
  );
  const names = readdirSync(state.dir);
  assert.deepEqual(names.filter((n) => /\.seat-\d+\.json$|^fix-near-pairs-/.test(n)), []);
  assert.ok(calls.includes('fix-1'), 'the fix round ran');
  assert.ok(!seen.some((n) => /seat-\d|near-pairs/.test(n.message)));
});

test('the near pairs the fix prompt names are recorded for the fix round that was told', async () => {
  const state = reviewingRun({ prefix: 'vibe-seat-reports-near-' });
  work(state, 'implemented.ts', lines);
  await drive(
    state,
    reviewCfg(['codex']),
    (label) => {
      if (label === 'review-0') return report([cites('reviewer-says', 2)]);
      if (label === 'review-0-f1') return report([cites('finder-says', 3)]);
      return report([]);
    },
    (label) => work(state, `${label}.txt`),
    true,
  );
  const near = read<{ round: number; answers: number; label: string; pairs: unknown[] }>(state, 'fix-near-pairs-1.json');
  assert.deepEqual(near, {
    round: 1,
    answers: 0,
    label: 'fix-1',
    pairs: [{ first: 'reviewer-says', second: 'finder-says', path: 'implemented.ts', gap: 1 }],
  });
});

test('a critique with finders writes each seat its own report beside plan-critique-<n>.json', async () => {
  const state = freshRun({ prefix: 'vibe-seat-reports-critique-', task: 'seat reports' });
  writeFileSync(path.join(state.targetDir, 'widget.ts'), 'export const widget = 1;\n', 'utf8');
  const here: Evidence = { kind: 'code', path: 'widget.ts', line: 1 };
  await drive(
    state,
    config({ p1Tolerance: 0 }, { critique: { ...DEFAULTS.critique, finders: ['codex'] } }),
    (label) => {
      if (label === 'critique-0') return report([{ ...p1('critic-sees'), evidence: [here] }]);
      if (label === 'critique-0-f1') return report([{ ...p1('finder-sees'), title: 'Said otherwise', evidence: [here] }]);
      return report([]);
    },
    () => planFixture(),
    false,
  );
  const zero = read<SeatFile>(state, 'plan-critique-0.seat-0.json');
  assert.deepEqual([zero.seat, zero.findings.map((f) => f.id)], ['roles.critic', ['critic-sees']]);
  const one = read<SeatFile>(state, 'plan-critique-0.seat-1.json');
  assert.deepEqual([one.seat, one.findings.map((f) => f.title)], ['critique.finders[0]', ['Said otherwise']]);
});
