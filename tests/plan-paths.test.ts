import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import type { PlanPathsRecord } from '@src/plan-paths.js';
import type { Config, RunState } from '@src/types.js';
import { agents, config, freshRun, p1, planFixture, report } from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import { sh, shaOf } from './helpers/base-repo.js';

/**
 * Which paths a plan names that the start commit does not hold (#491), through
 * the real loop: `plan-paths-<n>.json` beside every `plan-<n>.json`, resolved at
 * `state.start.sha` and never at the working tree, nothing at all without a
 * start or when git cannot be read, and not one byte of any prompt changed.
 *
 * Agents are injected; git is real, because "the commit held this path and the
 * working tree held another" is something only git can answer.
 */

const FIRST = '# the plan\n\nEdit `src/present.ts` and add `src/missing.ts`, run `npm test`.';
const SECOND = '# revised\n\nEdit `src/present.ts`, `README.md` and `src/` only, and `src/uncommitted.ts`.';

interface Driven {
  calls: string[];
  prompts: Map<string, string>;
}

async function drive(state: RunState, cfg: Config, handlers: Handlers): Promise<Driven> {
  const calls: string[] = [];
  const prompts = new Map<string, string>();
  const wrapped: Handlers = {
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      return handlers.claude?.(label, options) ?? planFixture();
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      return handlers.codex?.(label, options) ?? report([]);
    },
  };
  const realLog = console.log;
  const realError = console.error;
  log.setSink(() => undefined);
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, false, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return { calls, prompts };
}

/** A plan-only run in a repository whose base commit holds `src/present.ts` (or not). */
function repoRun(prefix: string, committed = true): RunState {
  const state = freshRun({ prefix, git: true, commit: true, task: 'plan paths' });
  mkdirSync(path.join(state.targetDir, 'src'), { recursive: true });
  writeFileSync(path.join(state.targetDir, 'src', committed ? 'present.ts' : 'other.ts'), 'export {};\n', 'utf8');
  sh(state.targetDir, 'add', '-A');
  sh(state.targetDir, 'commit', '-q', '-m', 'base');
  // In the working tree only: resolved at the start commit, it must be absent.
  writeFileSync(path.join(state.targetDir, 'src', 'uncommitted.ts'), 'export {};\n', 'utf8');
  return state;
}

const twoRounds: Handlers = {
  claude: (label) => planFixture({ plan_md: label === 'revise-1' ? SECOND : FIRST }),
  codex: (label) => report(label === 'critique-0' ? [p1('one')] : []),
};

const cfg = (): Config => config({ p1Tolerance: 0 }, { critique: { ...DEFAULTS.critique } });

function record(state: RunState, n: number): PlanPathsRecord {
  return JSON.parse(readFileSync(path.join(state.dir, `plan-paths-${n}.json`), 'utf8')) as PlanPathsRecord;
}

test('each plan round records which of its paths the start commit holds, and a revision gets its own file', async () => {
  const state = repoRun('vibe-plan-paths-');
  const { calls } = await drive(state, cfg(), twoRounds);
  assert.deepEqual(calls, ['plan', 'critique-0', 'revise-1', 'critique-1']);
  const start = state.start?.sha;
  assert.ok(start !== undefined, 'the run recorded a start commit');
  assert.equal(start, shaOf(state.targetDir, 'HEAD'));

  assert.deepEqual(record(state, 0), {
    round: 0,
    commit: start,
    paths: [
      { path: 'src/present.ts', present: true, type: 'blob' },
      { path: 'src/missing.ts', present: false },
    ],
    notChecked: [],
  });
  assert.deepEqual(record(state, 1), {
    round: 1,
    commit: start,
    paths: [
      { path: 'src/present.ts', present: true, type: 'blob' },
      { path: 'README.md', present: true, type: 'blob' },
      { path: 'src/', present: true, type: 'tree' },
      // On disk, never committed: the start commit is what is asked, not the tree.
      { path: 'src/uncommitted.ts', present: false },
    ],
    notChecked: [],
  });
  assert.equal(existsSync(path.join(state.dir, 'plan-paths-2.json')), false);
});

test('a path outside the commit is listed as not checked, never as absent', async () => {
  const state = repoRun('vibe-plan-paths-outside-');
  await drive(state, cfg(), { claude: () => planFixture({ plan_md: 'See `../elsewhere/x.ts` and `src/present.ts`.' }) });
  const r = record(state, 0);
  assert.deepEqual(r.paths, [{ path: 'src/present.ts', present: true, type: 'blob' }]);
  assert.deepEqual(r.notChecked.map((x) => x.path), ['../elsewhere/x.ts']);
});

test('a run with no start commit records nothing', async () => {
  const state = repoRun('vibe-plan-paths-nostart-');
  const noBranch = config({ p1Tolerance: 0 }, { git: { ...DEFAULTS.git, commitEachRound: false, useBranch: false } });
  const { calls } = await drive(state, noBranch, twoRounds);
  assert.deepEqual(calls, ['plan', 'critique-0', 'revise-1', 'critique-1']);
  assert.equal(state.start, undefined);
  assert.equal(existsSync(path.join(state.dir, 'plan-0.json')), true);
  assert.equal(existsSync(path.join(state.dir, 'plan-paths-0.json')), false);
  assert.equal(existsSync(path.join(state.dir, 'plan-paths-1.json')), false);
});

test('a start commit git cannot read records nothing, rather than every path absent, and the run goes on', async () => {
  const state = repoRun('vibe-plan-paths-unreadable-');
  // Never back-filled by `prepareGit` with the branch off, so this is the
  // commit the record would be asked of: one the repository does not hold.
  state.start = { sha: 'f'.repeat(40), ref: null };
  const noBranch = config({ p1Tolerance: 0 }, { git: { ...DEFAULTS.git, commitEachRound: false, useBranch: false } });
  const { calls } = await drive(state, noBranch, twoRounds);
  assert.deepEqual(calls, ['plan', 'critique-0', 'revise-1', 'critique-1']);
  assert.equal(state.status, 'planned');
  assert.equal(existsSync(path.join(state.dir, 'plan-paths-0.json')), false);
  assert.equal(existsSync(path.join(state.dir, 'plan-paths-1.json')), false);
});

test('every prompt is byte-identical whether the plan\'s paths are present or absent', async () => {
  const present = repoRun('vibe-plan-paths-same-a-');
  const absent = repoRun('vibe-plan-paths-same-b-', false);
  const a = await drive(present, cfg(), twoRounds);
  const b = await drive(absent, cfg(), twoRounds);
  assert.notDeepEqual(record(present, 0).paths, record(absent, 0).paths, 'the records differ');
  assert.deepEqual(a.calls, b.calls);
  // The only differences two runs may have are where they ran and what they are called.
  const neutral = (s: RunState, text: string): string =>
    text.split(s.targetDir).join('<dir>').split(s.id).join('<id>');
  for (const label of a.calls) {
    assert.equal(
      neutral(present, a.prompts.get(label) ?? ''),
      neutral(absent, b.prompts.get(label) ?? ''),
      `${label}'s prompt moved with the record`,
    );
    assert.equal((a.prompts.get(label) ?? '').includes('plan-paths'), false);
  }
});
