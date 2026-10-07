import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachVerdicts,
  DEFAULT_TEST_PATHS,
  isJudge,
  judgeChanges,
  matchesGlob,
  recordedPatterns,
  testChangeCounts,
} from '@src/judge.js';
import type { FileChange } from '@src/types.js';

/**
 * Which changed files are part of the run's own judge, and how a reviewer's
 * verdicts are paired with them (#112). Pure: no git, no loop - those are in
 * `judge-diff.test.ts` and `judge-review.test.ts`.
 */

function change(path: string, over: Partial<FileChange> = {}): FileChange {
  return { path, oldPath: null, status: 'modified', added: 1, removed: 1, ...over };
}

test('the glob matcher supports *, ** and ? and nothing crosses a slash it should not', () => {
  assert.ok(matchesGlob('tests/a.ts', '**/tests/**'));
  assert.ok(matchesGlob('a/tests/b/c.ts', '**/tests/**'));
  assert.ok(!matchesGlob('contests/a.ts', '**/tests/**'));
  assert.ok(matchesGlob('src/x.test.ts', '**/*.test.*'));
  assert.ok(matchesGlob('x.test.ts', '**/*.test.*'));
  // `*` is one segment: `src/*.ts` does not reach into a subdirectory.
  assert.ok(matchesGlob('src/a.ts', 'src/*.ts'));
  assert.ok(!matchesGlob('src/sub/a.ts', 'src/*.ts'));
  assert.ok(matchesGlob('src/sub/a.ts', 'src/**'));
  // `?` is exactly one character, and never a slash.
  assert.ok(matchesGlob('a1.ts', 'a?.ts'));
  assert.ok(!matchesGlob('a12.ts', 'a?.ts'));
  assert.ok(!matchesGlob('a/.ts', 'a?.ts'));
  // Regex metacharacters in a pattern are literal.
  assert.ok(matchesGlob('a+b.ts', 'a+b.ts'));
  assert.ok(!matchesGlob('aab.ts', 'a+b.ts'));
});

test('the default list catches the conventional test spellings and leaves source alone', () => {
  for (const file of [
    'src/fork.test.ts',
    'web/app.spec.js',
    'test/helper.js',
    'pkg/tests/x.rs',
    'ui/__tests__/x.tsx',
    'py/test_thing.py',
    'py/thing_test.py',
    'go/thing_test.go',
  ]) {
    assert.ok(isJudge(file, DEFAULT_TEST_PATHS), file);
  }
  for (const file of ['src/fork.ts', 'README.md', 'src/testing.ts', 'latest/x.ts']) {
    assert.ok(!isJudge(file, DEFAULT_TEST_PATHS), file);
  }
});

test('vibe.config.json is always judged at the root, and only at the root', () => {
  for (const patterns of [DEFAULT_TEST_PATHS, [], ['spec/**']]) {
    assert.ok(isJudge('vibe.config.json', patterns), JSON.stringify(patterns));
  }
  assert.ok(!isJudge('sub/vibe.config.json', []));
});

test('the record names vibe.config.json among the patterns in force, once', () => {
  assert.deepEqual(recordedPatterns([]), ['vibe.config.json']);
  assert.deepEqual(recordedPatterns(['a/**', 'vibe.config.json']), ['a/**', 'vibe.config.json']);
});

test('a rename counts when either side matches', () => {
  const out = change('src/x.ts', { status: 'renamed', oldPath: 'tests/x.test.ts' });
  const back = change('tests/x.test.ts', { status: 'renamed', oldPath: 'src/x.ts' });
  const neither = change('src/y.ts', { status: 'renamed', oldPath: 'src/z.ts' });
  assert.deepEqual(judgeChanges([out, back, neither], DEFAULT_TEST_PATHS), [out, back]);
});

test('an omitted file is unjudged, never justified', () => {
  const a = change('tests/a.test.ts');
  const b = change('tests/b.test.ts');
  const files = attachVerdicts([[a, b]], [[{ file: 'tests/a.test.ts', justified: true, reason: 'moved' }]]);
  assert.deepEqual(files[0]?.verdict, { justified: true, reason: 'moved' });
  assert.equal(files[1]?.verdict, 'unjudged');
  assert.deepEqual(testChangeCounts(files), { files: 2, justified: 1, notJustified: 0, unjudged: 1 });
});

test('a verdict naming an unlisted file attaches to nothing', () => {
  const a = change('tests/a.test.ts');
  const files = attachVerdicts([[a]], [[{ file: 'src/other.ts', justified: true, reason: 'x' }]]);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.verdict, 'unjudged');
});

test('the first verdict for a file wins and a later one does not overwrite it', () => {
  const a = change('tests/a.test.ts');
  const files = attachVerdicts(
    [[a]],
    [
      [
        { file: 'tests/a.test.ts', justified: false, reason: 'weakened' },
        { file: 'tests/a.test.ts', justified: true, reason: 'fine actually' },
      ],
    ],
  );
  assert.deepEqual(files[0]?.verdict, { justified: false, reason: 'weakened' });
});

test('a verdict counts only from a part that listed the file', () => {
  const a = change('tests/a.test.ts');
  const files = attachVerdicts(
    [[a], []],
    [[], [{ file: 'tests/a.test.ts', justified: true, reason: 'from the wrong part' }]],
  );
  assert.equal(files[0]?.verdict, 'unjudged');
});

test('a rename may be named by its old path, and listed in two parts is one entry', () => {
  const r = change('src/x.ts', { status: 'renamed', oldPath: 'tests/x.test.ts' });
  const files = attachVerdicts(
    [[r], [r]],
    [[], [{ file: ' tests/x.test.ts ', justified: false, reason: 'test hidden' }]],
  );
  assert.equal(files.length, 1);
  assert.deepEqual(files[0]?.verdict, { justified: false, reason: 'test hidden' });
});
