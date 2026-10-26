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

// ---- every seat's verdict (#404) -------------------------------------------

/** The record a round with finders wrote: the combined verdict, then each seat's. */
const seated: TestChanges = {
  round: 1,
  patterns: ['**/tests/**', 'vibe.config.json'],
  files: [
    {
      path: 'tests/a.test.ts',
      oldPath: null,
      status: 'modified',
      added: 1,
      removed: 3,
      verdict: { justified: false, reason: 'rewrites an assertion' },
      verdicts: [
        { seat: 'roles.reviewer', provider: 'codex', model: 'default', verdict: { justified: true, reason: 'fine' } },
        {
          seat: 'review.finders[0]',
          provider: 'claude',
          model: 'opus',
          verdict: { justified: false, reason: 'rewrites an assertion' },
        },
        { seat: 'review.finders[1]', provider: 'codex', model: 'default', verdict: 'unjudged' },
      ],
    },
  ],
};

test('a record with every seat’s verdict survives the round trip intact, key order included', () => {
  const { state, repairs } = read({ ...widest(), testChanges: seated });
  assert.deepEqual(repairs, []);
  assert.deepEqual(state.testChanges, seated);
  assert.equal(JSON.stringify(state.testChanges), JSON.stringify(seated));
});

test('a malformed seat verdict is dropped and said, and the combined verdict stands as stored', () => {
  const [file] = seated.files;
  assert.ok(file?.verdicts !== undefined);
  const [good, , last] = file.verdicts;
  for (const bad of [
    'nonsense',
    { ...good, provider: 'gemini' },
    { ...good, model: '' },
    { ...good, seat: 3 },
    { ...good, verdict: 'justified' },
    { ...good, verdict: { justified: 'yes', reason: 'x' } },
  ]) {
    const { state, repairs } = read({
      ...widest(),
      testChanges: { ...seated, files: [{ ...file, verdicts: [good, bad, last] }] },
    });
    const [kept] = state.testChanges?.files ?? [];
    // Never recomputed from what survived: the dissent that was dropped still decides.
    assert.deepEqual(kept?.verdict, file.verdict, JSON.stringify(bad));
    assert.deepEqual(kept?.verdicts, [good, last], JSON.stringify(bad));
    assert.deepEqual(repairs.map((r) => [r.field, r.droppedPaths]), [
      ['testChanges', ['testChanges.files[0].verdicts[1]']],
    ]);
  }
});

test('a verdicts value that is not a list drops the key, keeps the verdict, and is said', () => {
  const [file] = seated.files;
  assert.ok(file !== undefined);
  for (const bad of [null, 'all', { seat: 'roles.reviewer' }]) {
    const { state, repairs } = read({ ...widest(), testChanges: { ...seated, files: [{ ...file, verdicts: bad }] } });
    const [kept] = state.testChanges?.files ?? [];
    assert.ok(kept !== undefined, JSON.stringify(bad));
    assert.equal('verdicts' in kept, false, JSON.stringify(bad));
    assert.deepEqual(kept.verdict, file.verdict);
    assert.deepEqual(repairs.map((r) => [r.field, r.droppedPaths]), [['testChanges', ['testChanges.files[0].verdicts']]]);
  }
});
