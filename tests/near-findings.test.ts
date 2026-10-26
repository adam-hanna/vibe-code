import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NEAR_LINES, nearPairs } from '@src/finder-merge.js';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import { fixPrompt } from '@src/prompts.js';
import { DEFAULTS } from '@src/config.js';
import { agents, config, p1, report, reviewingRun, work } from './helpers/loop-harness.js';
import type { Evidence, Finding, FoundBy, RunState } from '@src/types.js';

/**
 * Findings that may be one defect, flagged to the fixer and never merged (#462).
 *
 * Two seats describing one bug usually cite lines a step apart, which the merge's
 * exact `path:line` rule keeps as two findings. Merging by a line window was
 * measured and refused (see `NEAR_LINES`); this asks the fixer instead.
 */

const at = (p: string, line?: number): Evidence => ({ kind: 'code', path: p, ...(line === undefined ? {} : { line }) });
const by = (seat: string, id: string): FoundBy => ({ seat, provider: 'codex', model: 'default', id });

function finding(id: string, evidence: Evidence[], seats: string[] | null): Finding {
  return {
    id,
    severity: 'P1',
    title: `Title of ${id}`,
    detail: `Detail of ${id}.`,
    suggested_fix: `Fix ${id}.`,
    evidence,
    ...(seats === null ? {} : { foundBy: seats.map((s) => by(s, id)) }),
  };
}

const R = 'roles.reviewer';
const F = 'review.finders[0]';

test('two seats citing one file within NEAR_LINES lines are flagged, with the closest gap', () => {
  const pairs = nearPairs([
    finding('a', [at('src/x.ts', 10), at('src/y.ts', 40)], [R]),
    finding('b', [at('./src/x.ts', 12), at('src/x.ts', 11)], [F]),
  ]);
  assert.deepEqual(pairs, [{ first: 'a', second: 'b', path: 'src/x.ts', gap: 1 }]);
});

test('a gap of NEAR_LINES is flagged, and one more is not', () => {
  const flagged = nearPairs([finding('a', [at('x.ts', 10)], [R]), finding('b', [at('x.ts', 10 + NEAR_LINES)], [F])]);
  assert.equal(flagged.length, 1);
  const kept = nearPairs([finding('a', [at('x.ts', 10)], [R]), finding('b', [at('x.ts', 11 + NEAR_LINES)], [F])]);
  assert.deepEqual(kept, []);
});

test('findings sharing a seat are never paired, and neither are findings in different files', () => {
  assert.deepEqual(nearPairs([finding('a', [at('x.ts', 1)], [R]), finding('b', [at('x.ts', 2)], [R])]), []);
  // A merged finding raised by both seats shares one with each side.
  assert.deepEqual(nearPairs([finding('a', [at('x.ts', 1)], [R, F]), finding('b', [at('x.ts', 2)], [F])]), []);
  assert.deepEqual(nearPairs([finding('a', [at('x.ts', 1)], [R]), finding('b', [at('y.ts', 1)], [F])]), []);
});

test('without foundBy, with an unreadable foundBy, or without a line, nothing is flagged', () => {
  assert.deepEqual(nearPairs([finding('a', [at('x.ts', 1)], null), finding('b', [at('x.ts', 2)], null)]), []);
  const garbled = { ...finding('b', [at('x.ts', 2)], null), foundBy: [{ provider: 'codex' }] as unknown as FoundBy[] };
  assert.deepEqual(nearPairs([finding('a', [at('x.ts', 1)], [R]), garbled]), []);
  assert.deepEqual(nearPairs([finding('a', [at('x.ts')], [R]), finding('b', [at('x.ts', 2)], [F])]), []);
});

test('pairs come in report order, each once', () => {
  const pairs = nearPairs([
    finding('a', [at('x.ts', 1)], [R]),
    finding('b', [at('x.ts', 2)], [F]),
    finding('c', [at('x.ts', 3)], ['review.finders[1]']),
  ]);
  assert.deepEqual(
    pairs.map((p) => `${p.first}/${p.second}`),
    ['a/b', 'a/c', 'b/c'],
  );
});

test('the fix prompt names each pair, and is unchanged when there is none', () => {
  const near = [finding('a', [at('x.ts', 5)], [R]), finding('b', [at('x.ts', 6)], [F])];
  const prompt = fixPrompt(near, 1, undefined, null, true);
  assert.match(prompt, /## Findings that may be one defect/);
  assert.match(prompt, /- `a` and `b`: both cite `x\.ts`, 1 line apart/);
  assert.match(prompt, /fix it once and give both ids the same disposition/);

  // Far apart: the same findings, and the same prompt as with no provenance at all.
  const far = [finding('a', [at('x.ts', 5)], [R]), finding('b', [at('x.ts', 50)], [F])];
  const bare = far.map(({ foundBy: _foundBy, ...rest }) => rest);
  assert.equal(fixPrompt(far, 1, undefined, null, true), fixPrompt(bare, 1, undefined, null, true));
  assert.doesNotMatch(fixPrompt(far, 1, undefined, null, true), /may be one defect/);
});

async function drive(state: RunState, finders: unknown[], codex: (label: string) => object): Promise<Map<string, string>> {
  const prompts = new Map<string, string>();
  const calls: string[] = [];
  const cfg = config({ p1Tolerance: 0 }, { review: { ...DEFAULTS.review, finders } as typeof DEFAULTS.review });
  const quiet = (): void => {};
  const original = { log: console.log, error: console.error };
  log.setSink(() => {});
  console.log = quiet;
  console.error = quiet;
  try {
    await orchestrate(
      state,
      cfg,
      true,
      agents(
        {
          claude: (label, options) => {
            prompts.set(label, options.prompt);
            return work(state, `${label}.txt`);
          },
          codex: (label, options) => {
            prompts.set(label, options.prompt);
            return codex(label);
          },
        },
        calls,
      ),
    );
  } finally {
    log.setSink(null);
    console.log = original.log;
    console.error = original.error;
  }
  return prompts;
}

const lines = 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n';
const cites = (id: string, line: number): Finding => ({ ...p1(id), evidence: [at('implemented.ts', line)] });

test('through the loop: a reviewer and a finder a line apart reach the fixer as two findings, flagged', async () => {
  const state = reviewingRun({ prefix: 'vibe-near-flag-' });
  work(state, 'implemented.ts', lines);
  const prompts = await drive(state, ['codex'], (label) => {
    if (label === 'review-0') return report([cites('reviewer-says', 2)]);
    if (label === 'review-0-f1') return report([cites('finder-says', 3)]);
    return report([]);
  });
  const findings = (JSON.parse(readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8')) as { findings: Finding[] })
    .findings;
  assert.deepEqual(
    findings.map((f) => f.id),
    ['reviewer-says', 'finder-says'],
    'kept apart: the flag never merges',
  );
  const fix = prompts.get('fix-1') ?? '';
  assert.match(fix, /- `reviewer-says` and `finder-says`: both cite `implemented\.ts`, 1 line apart/);
});

test('through the loop: without finders the fix prompt has no flag', async () => {
  const state = reviewingRun({ prefix: 'vibe-near-none-' });
  work(state, 'implemented.ts', lines);
  const prompts = await drive(state, [], (label) =>
    label === 'review-0' ? report([cites('one', 2), cites('two', 3)]) : report([]),
  );
  const fix = prompts.get('fix-1') ?? '';
  assert.match(fix, /`one`/);
  assert.doesNotMatch(fix, /may be one defect/);
});
