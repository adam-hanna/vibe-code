import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRun, loadRun } from '@src/run.js';
import { runBranch } from '@src/git.js';
import { EXIT, orchestrate } from '@src/orchestrator.js';
import { runPreflight } from '@src/cli.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { workDirOf } from '@src/worktree.js';
import { agents, planFixture, report } from './helpers/loop-harness.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  escalation,
  gitConfig,
  ON_BRANCH,
  sh,
  shaOf,
  staleClone,
  twoCommits,
  untilFirstTurn,
} from './helpers/base-repo.js';
import type { Config, RunState } from '@src/types.js';

/**
 * A run starts from the base it was told, and a worktree is never moved
 * silently (#249).
 *
 * The #169 run started from a root checkout's stale tip instead of
 * `origin/develop`: its worktree script detached at the commit it wanted, and
 * `prepareGit` checked the run branch - made at HEAD - out over it without a
 * word. Every case here is about which commit a fresh run's branch is at, and
 * that nothing moves it there in silence.
 */

const detachAtFirst =
  process.platform === 'win32'
    ? 'git worktree add --detach "%VIBE_WORKTREE%" HEAD~1'
    : 'git worktree add --detach "$VIBE_WORKTREE" HEAD~1';

// ---- refuse, never move ------------------------------------------------------

test('a worktree script that detaches at another commit is refused, naming both', async () => {
  // `baseRef` unset: this is the one behaviour change when it is, and the case
  // the issue is about - a script choosing a commit, and vibe overriding it.
  const { dir, first, second } = twoCommits();
  const state = createRun(dir, 'detached elsewhere', true, { worktree: true });
  const { code } = await untilFirstTurn(state, gitConfig({ worktree: true, worktreeCommand: detachAtFirst }));

  assert.equal(code, EXIT.ERROR);
  const said = escalation(state);
  assert.match(said, new RegExp(first), 'the worktree commit is named');
  assert.match(said, new RegExp(second), 'the branch commit is named');
  assert.match(said, /VIBE_BRANCH/);
  assert.match(said, /git\.baseRef/);
  // Nothing was moved, and nothing durable claims a branch.
  assert.equal(shaOf(workDirOf(state), 'HEAD'), first);
  assert.equal(state.branch, null);
  assert.equal(state.start, undefined);
});

test('the same run with a script that checks the branch out proceeds', async () => {
  const { dir, second } = twoCommits();
  const state = createRun(dir, 'on the branch', true, { worktree: true });
  const cfg = gitConfig({ worktree: true, worktreeCommand: ON_BRANCH });
  const { code } = await untilFirstTurn(state, cfg);

  assert.equal(code, EXIT.OK);
  assert.equal(state.branch, runBranch(cfg, state));
  assert.equal(sh(workDirOf(state), 'rev-parse', '--abbrev-ref', 'HEAD'), state.branch);
  assert.deepEqual(state.start, { sha: second, ref: null });
});

// ---- the base is used --------------------------------------------------------

for (const variant of [
  { name: 'the default worktree', git: { worktree: true, worktreeCommand: null } },
  { name: 'a custom script', git: { worktree: true, worktreeCommand: ON_BRANCH } },
  { name: 'no worktree', git: { worktree: false } },
] as const) {
  test(`a local git.baseRef that differs from HEAD is where the branch starts: ${variant.name}`, async () => {
    const { dir, first, second } = twoCommits();
    assert.notEqual(first, second);
    const state = createRun(dir, `base ${variant.name}`, true, { worktree: variant.git.worktree });
    const cfg = gitConfig({ ...variant.git, baseRef: 'base' });
    const { code } = await untilFirstTurn(state, cfg);

    assert.equal(code, EXIT.OK);
    const branch = runBranch(cfg, state);
    assert.equal(state.branch, branch);
    assert.equal(shaOf(dir, `refs/heads/${String(branch)}`), first);
    assert.equal(shaOf(workDirOf(state), 'HEAD'), first);
    assert.equal(sh(workDirOf(state), 'rev-parse', '--abbrev-ref', 'HEAD'), branch);
    assert.deepEqual(state.start, { sha: first, ref: 'base' });
  });
}

/** Plan, approve, and write into the tree the run works in. */
function implementing(state: RunState, cfg: Config): Promise<RunState> {
  return orchestrate(
    state,
    cfg,
    false,
    agents(
      {
        claude: (label) => {
          if (label === 'plan' || label.startsWith('revise-')) return planFixture();
          writeFileSync(path.join(workDirOf(state), `${label}.txt`), `${label}\n`, 'utf8');
          return 'done';
        },
        codex: () => report([]),
      },
      [],
    ),
  );
}

for (const worktree of [true, false]) {
  test(`baseSha is the base once implement starts (${worktree ? 'worktree' : 'no worktree'})`, async () => {
    const { dir, first } = twoCommits();
    const state = createRun(dir, 'base to implement', false, { worktree });
    const cfg = gitConfig({ worktree, baseRef: 'base' });
    const realLog = console.log;
    const realError = console.error;
    console.log = () => undefined;
    console.error = () => undefined;
    try {
      assert.equal(await runPreflight(state, cfg, undefined, { skipProbe: true }), null);
      // Whatever the review makes of the change, `baseSha` is set before the
      // implement turn and is what this case is about.
      await implementing(state, cfg).catch(() => undefined);
    } finally {
      console.log = realLog;
      console.error = realError;
    }
    assert.equal(state.baseSha, first);
    assert.deepEqual(state.start, { sha: first, ref: 'base' });
  });
}

test('a remote-tracking git.baseRef is fetched first, so the stale local copy is not used', async () => {
  const { clone, stale, fresh } = staleClone();
  assert.equal(shaOf(clone, 'origin/main'), stale, 'the clone starts out stale');
  const state = createRun(clone, 'remote base', true);
  const { code } = await untilFirstTurn(state, gitConfig({ baseRef: 'origin/main' }));

  assert.equal(code, EXIT.OK);
  assert.equal(shaOf(clone, `refs/heads/${String(state.branch)}`), fresh);
  assert.equal(shaOf(clone, 'HEAD'), fresh);
  assert.deepEqual(state.start, { sha: fresh, ref: 'origin/main' });
});

// ---- a resume moves nothing --------------------------------------------------

test('a resume never fetches, resolves or moves the branch', async () => {
  const { clone, fresh } = staleClone();
  const created = createRun(clone, 'resumed', true);
  const cfg = gitConfig({ baseRef: 'origin/main' });
  assert.equal((await untilFirstTurn(created, cfg)).code, EXIT.OK);

  // The remote now resolves nowhere and could not be fetched: a resume that
  // tried either would refuse.
  sh(clone, 'remote', 'set-url', 'origin', path.join(clone, 'no-such-remote'));
  sh(clone, 'update-ref', 'refs/remotes/origin/main', shaOf(clone, 'HEAD~1'));

  const state = loadRun(clone, created.id);
  const { code } = await untilFirstTurn(state, cfg, true);
  assert.equal(code, EXIT.OK);
  assert.equal(shaOf(clone, `refs/heads/${String(state.branch)}`), fresh);
  assert.deepEqual(state.start, { sha: fresh, ref: 'origin/main' });
  assert.equal(state.events.filter((e) => e.type === 'state_repaired').length, 0);
});

// ---- the start is said -------------------------------------------------------

async function narrated(state: RunState, cfg: Config, resume = false): Promise<Narration[]> {
  const seen: Narration[] = [];
  log.setSink((n) => void seen.push(n));
  try {
    await untilFirstTurn(state, cfg, resume);
  } finally {
    log.setSink(null);
  }
  return seen.filter((n) => n.id === 'run_branch');
}

test('with git.baseRef unset a fresh run says it started from HEAD, and records it', async () => {
  const { dir, second } = twoCommits();
  const state = createRun(dir, 'from head', true);
  const said = await narrated(state, gitConfig({}));

  assert.equal(said.length, 1);
  assert.match(said[0]?.message ?? '', new RegExp(`from HEAD \\(${second.slice(0, 7)}\\)`));
  assert.deepEqual(said[0]?.data, {
    branch: state.branch,
    why: null,
    startSha: second,
    startRef: null,
  });
  assert.deepEqual(state.start, { sha: second, ref: null });
});

test('a fresh run says the base it was told; a resume says no base at all', async () => {
  const { dir, first } = twoCommits();
  const created = createRun(dir, 'said', true);
  const cfg = gitConfig({ baseRef: 'base' });
  const fresh = await narrated(created, cfg);
  assert.match(fresh[0]?.message ?? '', new RegExp(`from base \\(${first.slice(0, 7)}\\)`));
  assert.equal(fresh[0]?.data?.['startSha'], first);
  assert.equal(fresh[0]?.data?.['startRef'], 'base');

  const resumed = await narrated(loadRun(dir, created.id), cfg, true);
  assert.equal(resumed.length, 1);
  assert.equal('startSha' in (resumed[0]?.data ?? {}), false);
  assert.equal('startRef' in (resumed[0]?.data ?? {}), false);
});

// ---- nothing durable before prepareGit ---------------------------------------

test('a run refused after its worktree ref exists records no branch and no start', async () => {
  const { dir } = twoCommits();
  const state = createRun(dir, 'script fails', true, { worktree: true });
  const failing = process.platform === 'win32' ? 'exit /b 1' : 'exit 1';
  const { code } = await untilFirstTurn(
    state,
    gitConfig({ worktree: true, worktreeCommand: failing, baseRef: 'base' }),
  );

  assert.equal(code, EXIT.PREFLIGHT);
  const back = loadRun(dir, state.id);
  assert.equal(back.branch, null);
  assert.equal(back.start, undefined);
});

test('preflight with no worktree creates no branch and moves nothing', async () => {
  // The branch of a run with no worktree is made by `prepareGit` alone, so a
  // run stopped between the gate and the loop leaves the repository as it was.
  const { dir, second } = twoCommits();
  const state = createRun(dir, 'gate only', true);
  const cfg = gitConfig({ baseRef: 'base' });
  const realLog = console.log;
  console.log = () => undefined;
  try {
    assert.equal(await runPreflight(state, cfg, undefined, { skipProbe: true }), null);
  } finally {
    console.log = realLog;
  }
  const branch = String(runBranch(cfg, state));
  assert.equal(sh(dir, 'branch', '--list', branch), '');
  assert.equal(shaOf(dir, 'HEAD'), second);
  assert.equal(loadRun(dir, state.id).start, undefined);
});
