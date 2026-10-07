import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import { loadRun } from '@src/run.js';
import { validateStoredState } from '@src/stored.js';
import { agents, config, report, reviewingRun } from './helpers/loop-harness.js';
import type { TestChanges } from '@src/types.js';

/**
 * `testChanges` across a stop and a resume (#112).
 *
 * `reviewCoverage`'s rules one field along: absence is preserved, a well-formed
 * record round-trips with no repairs, and a damaged one is dropped whole rather
 * than repaired - a repaired verdict would be a verdict nobody gave.
 */

function widest(): Record<string, unknown> {
  const file = fileURLToPath(
    new URL('../../tests/fixtures/state/done-widest.json', import.meta.url),
  );
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

const record: TestChanges = {
  round: 2,
  patterns: ['**/tests/**', 'vibe.config.json'],
  files: [
    { path: 'tests/a.test.ts', oldPath: null, status: 'deleted', added: 0, removed: 12, verdict: 'unjudged' },
    {
      path: 'src/b.ts',
      oldPath: 'tests/b.test.ts',
      status: 'renamed',
      added: 1,
      removed: 1,
      verdict: { justified: false, reason: 'moves a test out of the gate' },
    },
    {
      path: 'tests/c.bin',
      oldPath: null,
      status: 'added',
      added: null,
      removed: null,
      verdict: { justified: true, reason: 'fixture' },
    },
  ],
};

test('a state written before the field existed loads with no repairs and no record', () => {
  const { state, repairs } = read(widest());
  assert.deepEqual(repairs, []);
  assert.equal(state.testChanges, undefined);
});

test('a well-formed record survives the round trip intact', () => {
  const { state, repairs } = read({ ...widest(), testChanges: record });
  assert.deepEqual(repairs, []);
  assert.deepEqual(state.testChanges, record);
});

test('a damaged record is dropped whole and said out loud', () => {
  const first = record.files[0];
  assert.ok(first !== undefined);
  for (const broken of [
    { ...record, round: 0 },
    { ...record, patterns: 'tests/**' },
    { ...record, files: null },
    { ...record, files: [{ ...first, status: 'copied' }] },
    { ...record, files: [{ ...first, added: -1 }] },
    { ...record, files: [{ ...first, removed: 0.5 }] },
    { ...record, files: [{ ...first, verdict: 'justified' }] },
    { ...record, files: [{ ...first, verdict: { justified: 'yes', reason: '' } }] },
    'nonsense',
  ]) {
    const { state, repairs } = read({ ...widest(), testChanges: broken });
    assert.equal(state.testChanges, undefined, JSON.stringify(broken));
    assert.deepEqual(repairs.map((r) => r.field), ['testChanges'], JSON.stringify(broken));
  }
});

test('a record a real review round wrote comes back from disk unchanged, with no repairs', async () => {
  const state = reviewingRun({ prefix: 'vibe-judge-state-', task: 'resume', change: false, commit: true });
  const dir = state.targetDir;
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  mkdirSync(path.join(dir, 'tests'), { recursive: true });
  writeFileSync(path.join(dir, 'tests/x.test.ts'), 'a\nb\nc\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  state.baseSha = git('rev-parse', 'HEAD');
  rmSync(path.join(dir, 'tests/x.test.ts'));
  writeFileSync(path.join(dir, 'src.ts'), 'export {};\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'round');

  const realLog = console.log;
  const realError = console.error;
  log.setSink(() => undefined);
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(
      state,
      config(),
      true,
      agents(
        {
          codex: () => ({
            ...report([]),
            test_verdicts: [{ file: 'tests/x.test.ts', justified: true, reason: 'retired' }],
          }),
        },
        [],
      ),
    );
  } finally {
    console.log = realLog;
    console.error = realError;
    log.setSink(null);
  }

  assert.ok(state.testChanges !== undefined);
  const resumed = loadRun(dir, state.id);
  assert.deepEqual(resumed.testChanges, state.testChanges);
  assert.equal(resumed.events.some((e) => e.type === 'state_repaired'), false);
});
