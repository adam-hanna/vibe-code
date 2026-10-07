import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { diffChunks } from '@src/git.js';
import * as log from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import * as P from '@src/prompts.js';
import { ROLES } from '@src/roles.js';
import { agents, config, report, reviewingRun } from './helpers/loop-harness.js';
import type { Narration } from '@src/log.js';
import type { RawVerdict } from '@src/judge.js';
import type { Config, RunState, TestChanges } from '@src/types.js';

/**
 * A review round whose diff touches the run's own judge - test files, or
 * `vibe.config.json` - records what changed, lists those files in the
 * reviewer's prompt, and records the reviewer's verdict on each (#112).
 *
 * Driven through the real loop and real git, from a run parked at review: the
 * point is that the list judged is the list the reviewer was handed, which a
 * stub of `diffChunks` could not show.
 */

type Tree = Record<string, string | Buffer | null>;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** Write (or, with null, delete) files under the run's target directory. */
function apply(state: RunState, tree: Tree): void {
  for (const [rel, body] of Object.entries(tree)) {
    const file = path.join(state.targetDir, rel);
    if (body === null) {
      rmSync(file, { force: true });
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
}

function commit(state: RunState, message: string): string {
  git(state.targetDir, 'add', '-A');
  git(state.targetDir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(state.targetDir, 'rev-parse', 'HEAD');
}

/**
 * A run parked at review over a committed baseline, whose implement round then
 * made `round` - committed, as a real run with `commitEachRound` leaves it.
 */
function parked(task: string, baseline: Tree, round: (state: RunState) => void): RunState {
  const state = reviewingRun({ prefix: 'vibe-judge-', task, change: false, commit: true });
  apply(state, baseline);
  state.baseSha = commit(state, 'baseline');
  round(state);
  commit(state, 'the round');
  return state;
}

const lines = (n: number, tag: string): string =>
  Array.from({ length: n }, (_u, i) => `${tag} ${i}\n`).join('');

interface Outcome {
  prompts: Map<string, string>;
  seen: Narration[];
}

/** One review round, with each reviewer turn answering the verdicts it is given. */
async function review(
  state: RunState,
  verdicts: (label: string) => RawVerdict[] = () => [],
  cfg: Config = config(),
): Promise<Outcome> {
  const prompts = new Map<string, string>();
  const seen: Narration[] = [];
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(
      state,
      cfg,
      true,
      agents(
        {
          codex: (label, options) => {
            prompts.set(label, options.prompt);
            return { ...report([]), test_verdicts: verdicts(label) };
          },
        },
        [],
      ),
    );
  } finally {
    console.log = realLog;
    console.error = realError;
    log.setSink(null);
  }
  return { prompts, seen };
}

function artifactChanges(state: RunState, round = 0): TestChanges | undefined {
  const raw = JSON.parse(
    readFileSync(path.join(state.dir, `code-review-${round}.json`), 'utf8'),
  ) as { testChanges?: TestChanges };
  return raw.testChanges;
}

/** The judge block of a prompt, or null when it has none. */
function judgeBlock(prompt: string | undefined): string | null {
  if (prompt === undefined) return null;
  const at = prompt.indexOf('## Changes to the judge');
  if (at === -1) return null;
  return prompt.slice(at, prompt.indexOf('## Files changed', at));
}

function judgedSays(seen: readonly Narration[]): Narration[] {
  return seen.filter((n) => n.id === 'test_changes_judged');
}

// ---- 1. a deleted test ------------------------------------------------------

test('a round that deletes a test file records it, and the reviewer is shown it', async () => {
  const state = parked('delete', { 'tests/x.test.ts': lines(12, 'case') }, (s) =>
    apply(s, { 'tests/x.test.ts': null, 'src/x.ts': 'export const x = 1;\n' }),
  );
  const { prompts } = await review(state);

  const record = state.testChanges;
  assert.ok(record !== undefined);
  assert.equal(record.round, 1);
  assert.deepEqual(record.files, [
    {
      path: 'tests/x.test.ts',
      oldPath: null,
      status: 'deleted',
      added: 0,
      removed: 12,
      verdict: 'unjudged',
    },
  ]);
  assert.deepEqual(artifactChanges(state), record);

  const block = judgeBlock(prompts.get('review-0'));
  assert.ok(block !== null, 'the review prompt has no judge block');
  assert.match(block, /`tests\/x\.test\.ts` - deleted, \+0 \/ -12 lines/);
  // Only the judge file is listed; the source file is not a change to the judge.
  assert.doesNotMatch(block, /src\/x\.ts/);
});

// ---- 2. lines removed inside a test -----------------------------------------

test('removing lines inside a test file records it as modified, with its counts', async () => {
  const state = parked('modify', { 'tests/y.test.ts': lines(10, 'case') }, (s) =>
    apply(s, { 'tests/y.test.ts': lines(6, 'case') }),
  );
  await review(state);

  assert.deepEqual(state.testChanges?.files.map((f) => [f.path, f.status, f.added, f.removed]), [
    ['tests/y.test.ts', 'modified', 0, 4],
  ]);
});

// ---- 3. only added tests ----------------------------------------------------

test('a round that only adds tests records them and nothing calls them suspicious', async () => {
  const state = parked('add', {}, (s) =>
    apply(s, {
      'src/z.ts': 'export const z = 1;\n',
      'tests/z.test.ts': lines(5, 'case'),
      'tests/w.test.ts': lines(3, 'other'),
    }),
  );
  const { seen } = await review(state, () => [
    { file: 'tests/z.test.ts', justified: true, reason: 'new coverage for z' },
    { file: 'tests/w.test.ts', justified: true, reason: 'new coverage for w' },
  ]);

  const files = state.testChanges?.files ?? [];
  assert.deepEqual(files.map((f) => f.status), ['added', 'added']);
  const said = judgedSays(seen);
  assert.equal(said.length, 1);
  assert.equal(said[0]?.level, 'info');
  assert.deepEqual(said[0]?.data, { round: 1, files: 2, justified: 2, notJustified: 0, unjudged: 0 });
  // Nothing about these files is said at warn, by any id.
  assert.equal(
    seen.some((n) => n.level === 'warn' && /z\.test\.ts|w\.test\.ts/.test(n.message)),
    false,
  );
});

// ---- 4. vibe.config.json ----------------------------------------------------

test('an edit to vibe.config.json is recorded whatever verify.testPaths says', async () => {
  for (const testPaths of [[], ['spec/**']]) {
    const state = parked(`config-${testPaths.length}`, { 'vibe.config.json': '{}\n' }, (s) =>
      apply(s, { 'vibe.config.json': '{ "verify": { "command": "true" } }\n' }),
    );
    await review(state, () => [], config({}, { verify: { ...DEFAULTS.verify, enabled: false, testPaths } }));

    const record = state.testChanges;
    assert.ok(record !== undefined, JSON.stringify(testPaths));
    assert.deepEqual(record.files.map((f) => [f.path, f.status]), [['vibe.config.json', 'modified']]);
    assert.deepEqual(record.patterns, [...testPaths, 'vibe.config.json']);
  }
});

// ---- 5. renames, both ways --------------------------------------------------

test('a rename out of the test paths is recorded, and so is a rename into them', async () => {
  const body = lines(20, 'kept');
  const out = parked('rename-out', { 'tests/x.test.ts': body }, (s) => {
    mkdirSync(path.join(s.targetDir, 'src'), { recursive: true });
    renameSync(path.join(s.targetDir, 'tests/x.test.ts'), path.join(s.targetDir, 'src/x.ts'));
  });
  const outRun = await review(out);
  assert.deepEqual(out.testChanges?.files.map((f) => [f.path, f.oldPath, f.status]), [
    ['src/x.ts', 'tests/x.test.ts', 'renamed'],
  ]);
  assert.match(judgeBlock(outRun.prompts.get('review-0')) ?? '', /`src\/x\.ts` - renamed from `tests\/x\.test\.ts`/);

  const back = parked('rename-in', { 'src/x.ts': body }, (s) => {
    mkdirSync(path.join(s.targetDir, 'tests'), { recursive: true });
    renameSync(path.join(s.targetDir, 'src/x.ts'), path.join(s.targetDir, 'tests/x.test.ts'));
  });
  await review(back);
  assert.deepEqual(back.testChanges?.files.map((f) => [f.path, f.oldPath, f.status]), [
    ['tests/x.test.ts', 'src/x.ts', 'renamed'],
  ]);
});

// ---- 6. no judge file, no trace ---------------------------------------------

test('a round that touches no judge file records nothing and the prompt is unchanged', async () => {
  const state = parked('untouched', { 'src/a.ts': 'export const a = 0;\n' }, (s) =>
    apply(s, { 'src/a.ts': 'export const a = 1;\n' }),
  );
  const { prompts, seen } = await review(state);

  // Cleared the way `reviewCoverage` is - assigned undefined - so the durable
  // form is what can be absent, and it is: `state.json` has no such key.
  assert.equal(state.testChanges, undefined);
  const stored = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as object;
  assert.equal('testChanges' in stored, false);
  assert.equal(artifactChanges(state), undefined);
  const raw = readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8');
  assert.doesNotMatch(raw, /testChanges/);
  assert.equal(judgedSays(seen).length, 0);

  // Byte-identical to the prompt built with no judge argument at all, which is
  // what every review round produced before this existed.
  const { chunks, files } = await diffChunks(state.targetDir, state.baseSha);
  const plan = state.plan;
  assert.ok(plan !== null && plan !== undefined);
  const args = [
    chunks[0]?.diff ?? '',
    files,
    plan.plan_md,
    plan.out_of_scope,
    1,
    false,
    state.environment,
    ROLES,
    state.acceptanceCriteria,
    undefined,
    null,
    undefined,
  ] as const;
  const expected =
    P.taskContext(state.task, state.extraContext) +
    P.userDecisions(state.humanAnswers) +
    P.reviewPrompt(...args);
  assert.equal(prompts.get('review-0'), expected);
  assert.equal(P.reviewPrompt(...args, undefined), P.reviewPrompt(...args));
  assert.equal(P.reviewPrompt(...args, []), P.reviewPrompt(...args));
});

// ---- 7. an omitted verdict --------------------------------------------------

test('a listed file the reviewer leaves out is unjudged, and an unlisted verdict attaches to nothing', async () => {
  const state = parked(
    'omitted',
    { 'tests/a.test.ts': lines(4, 'a'), 'tests/b.test.ts': lines(4, 'b') },
    (s) => apply(s, { 'tests/a.test.ts': lines(2, 'a'), 'tests/b.test.ts': lines(2, 'b') }),
  );
  const { seen } = await review(state, () => [
    { file: 'tests/a.test.ts', justified: true, reason: 'behaviour moved per the plan' },
    { file: 'src/other.ts', justified: true, reason: 'not a listed file' },
  ]);

  const files = state.testChanges?.files ?? [];
  assert.deepEqual(
    files.map((f) => [f.path, f.verdict]),
    [
      ['tests/a.test.ts', { justified: true, reason: 'behaviour moved per the plan' }],
      ['tests/b.test.ts', 'unjudged'],
    ],
  );
  assert.equal(JSON.stringify(state.testChanges).includes('src/other.ts'), false);

  const said = judgedSays(seen);
  assert.equal(said[0]?.level, 'warn');
  assert.deepEqual(said[0]?.data, { round: 1, files: 2, justified: 1, notJustified: 0, unjudged: 1 });
});

// ---- 8. a binary judge file -------------------------------------------------

test('a binary judge file records null counts, never zero', async () => {
  const state = parked('binary', {}, (s) =>
    apply(s, { 'tests/fixture.test.bin': Buffer.from([0, 1, 0, 2, 0, 255]) }),
  );
  const { prompts } = await review(state);

  const [file] = state.testChanges?.files ?? [];
  assert.equal(file?.added, null);
  assert.equal(file?.removed, null);
  assert.match(judgeBlock(prompts.get('review-0')) ?? '', /binary - lines not counted/);
});

// ---- 10. the issue's own case -----------------------------------------------

test('a silent approval of a deleted test is distinguishable, from the record alone, from a justified one', async () => {
  const deleting = (task: string): RunState =>
    parked(task, { 'tests/fork.test.ts': lines(30, 'assert') }, (s) =>
      apply(s, { 'tests/fork.test.ts': null, 'src/fork.ts': 'export const fork = 2;\n' }),
    );

  const silent = deleting('silent');
  await review(silent, () => []);
  const judged = deleting('judged');
  await review(judged, () => [
    { file: 'tests/fork.test.ts', justified: true, reason: 'fork() was removed by the plan' },
  ]);

  // Both reviewers approved; only the record tells them apart.
  assert.equal(silent.testChanges?.files[0]?.verdict, 'unjudged');
  assert.deepEqual(judged.testChanges?.files[0]?.verdict, {
    justified: true,
    reason: 'fork() was removed by the plan',
  });
  assert.equal(artifactChanges(silent)?.files[0]?.verdict, 'unjudged');
});

// ---- 12. a chunked round ----------------------------------------------------

test('a chunked review lists a judge file only in the part that shows it', async () => {
  const bulk = (n: number, tag: string): string => `${tag}${'x'.repeat(79)}\n`.repeat(Math.ceil(n / 80));
  const state = parked('chunked', {}, (s) =>
    apply(s, {
      'a-one.txt': bulk(200_000, 'a'),
      'b-two.txt': bulk(200_000, 'b'),
      'c-three.txt': bulk(200_000, 'c'),
      'tests/x.test.ts': lines(3, 'case'),
    }),
  );
  const { prompts } = await review(state, (label) =>
    label === 'review-0-part1'
      ? // A part that was not shown the file has no standing to judge it.
        [{ file: 'tests/x.test.ts', justified: false, reason: 'from a part that never saw it' }]
      : label === 'review-0-part3'
        ? [{ file: 'tests/x.test.ts', justified: true, reason: 'new test' }]
        : [],
  );

  assert.deepEqual([...prompts.keys()], ['review-0-part1', 'review-0-part2', 'review-0-part3']);
  assert.equal(judgeBlock(prompts.get('review-0-part1')), null);
  assert.equal(judgeBlock(prompts.get('review-0-part2')), null);
  assert.match(judgeBlock(prompts.get('review-0-part3')) ?? '', /`tests\/x\.test\.ts` - added/);
  assert.deepEqual(state.testChanges?.files.map((f) => [f.path, f.verdict]), [
    ['tests/x.test.ts', { justified: true, reason: 'new test' }],
  ]);
});

test('in a chunked round, a file the showing part did not judge stays unjudged', async () => {
  const bulk = (n: number, tag: string): string => `${tag}${'x'.repeat(79)}\n`.repeat(Math.ceil(n / 80));
  const state = parked('chunked-unjudged', {}, (s) =>
    apply(s, {
      'a-one.txt': bulk(200_000, 'a'),
      'b-two.txt': bulk(200_000, 'b'),
      'c-three.txt': bulk(200_000, 'c'),
      'tests/x.test.ts': lines(3, 'case'),
    }),
  );
  await review(state, (label) =>
    label === 'review-0-part1' ? [{ file: 'tests/x.test.ts', justified: true, reason: 'wrong part' }] : [],
  );
  assert.equal(state.testChanges?.files[0]?.verdict, 'unjudged');
});
