import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, parseArgs } from '@src/cli.js';
import { createRun, loadRun, RUNS_DIR } from '@src/run.js';
import { EXIT, prepareGit } from '@src/orchestrator.js';
import { branchNameRefusal, runBranch } from '@src/git.js';
import { workDirOf } from '@src/worktree.js';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { initGit } from './helpers/loop-harness.js';
import { gitConfig, ON_BRANCH, refusal, sh, shaOf, twoCommits, untilFirstTurn } from './helpers/base-repo.js';
import type { RunState } from '@src/types.js';

/**
 * `vibe run --branch <name>` (#356).
 *
 * The owner's decision: the pilot proposes the branch name on its `start_run`
 * card as `--branch`, and vibe enforces no convention - it checks the name is
 * one git accepts, and refuses a name that is already a branch, because
 * adopting an existing branch was only ever safe for a name derived from a
 * unique run id. Real git throughout, for `worktree.test.ts`'s reason: whether a
 * ref exists is a thing git either did or did not do.
 */

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-branch-flag-'));
  initGit(dir, { commit: true });
  return dir;
}

async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; said: Narration[] }> {
  const said: Narration[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  log.setSink((n) => said.push(n));
  try {
    return { result: await work(), said };
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
}

function runsIn(dir: string): string[] {
  const root = path.join(dir, RUNS_DIR);
  return existsSync(root) ? readdirSync(root).filter((e) => !e.startsWith('.')) : [];
}

function currentBranch(dir: string): string {
  return sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
}

// ---- parsing -----------------------------------------------------------------

test('--branch takes a value, and leaves the config alone', () => {
  assert.equal(parseArgs(['t', '--branch', 'feat/x']).flags.branch, 'feat/x');
  assert.throws(() => parseArgs(['t', '--branch']), /--branch requires a value/);
  // Absent means absent, so a default run is untouched.
  assert.equal(parseArgs(['t']).flags.branch, undefined);
});

// ---- the name ---------------------------------------------------------------

test('git judges the name, and a refusal names it', async () => {
  const dir = repo();
  for (const good of ['feat/356-branch-flag', 'fix-x', 'a/b/c']) {
    assert.equal(await branchNameRefusal(dir, good), null, good);
  }
  for (const bad of ['', ' ', 'two words', 'a..b', 'ends.lock', 'x~1', 'a:b', '-rf', 'HEAD', 'trailing/', '@{-1}']) {
    const said = await branchNameRefusal(dir, bad);
    assert.ok(said !== null, `"${bad}" should be refused`);
    assert.match(said, /not a branch name git accepts/);
  }
});

test('a bad name is refused before anything is created', async () => {
  const dir = repo();
  const { result, said } = await quietly(() => main(['run', 'task', '-C', dir, '--branch', 'a..b']));
  assert.equal(result, EXIT.ERROR);
  assert.deepEqual(runsIn(dir), [], 'no run directory');
  const failed = said.find((n) => n.id === 'run_failed');
  assert.ok(failed !== undefined, 'the window is told the ending');
  assert.match(String(failed.data?.['reason']), /--branch "a\.\.b"/);
});

test('--branch with --no-branch is refused, by both names', async () => {
  const dir = repo();
  const { result, said } = await quietly(() =>
    main(['plan', 'task', '-C', dir, '--branch', 'feat/x', '--no-branch']),
  );
  assert.equal(result, EXIT.ERROR);
  assert.deepEqual(runsIn(dir), []);
  const reason = String(said.find((n) => n.id === 'run_failed')?.data?.['reason']);
  assert.match(reason, /--branch and --no-branch/);
});

test('--branch outside a git repository is refused rather than ignored', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-branch-norepo-'));
  const { result, said } = await quietly(() => main(['plan', 'task', '-C', dir, '--branch', 'feat/x']));
  assert.equal(result, EXIT.ERROR);
  assert.match(String(said.find((n) => n.id === 'run_failed')?.data?.['reason']), /not a git repository/);
});

test('resume and fork refuse --branch rather than ignore it', async () => {
  const dir = repo();
  for (const argv of [
    ['resume', 'some-run', '-C', dir, '--branch', 'feat/x'],
    ['fork', 'some-run', '--at', '1', '-C', dir, '--branch', 'feat/x'],
  ]) {
    const { result } = await quietly(() => main(argv));
    assert.equal(result, EXIT.ERROR, argv.join(' '));
  }
});

// ---- the collision ----------------------------------------------------------

test('a fresh run naming a branch that exists is refused, and nothing is created', async () => {
  const dir = repo();
  sh(dir, 'branch', 'feat/taken');
  const before = shaOf(dir, 'feat/taken');
  const { result, said } = await quietly(() => main(['run', 'task', '-C', dir, '--branch', 'feat/taken']));
  assert.equal(result, EXIT.PREFLIGHT);
  assert.deepEqual(runsIn(dir), [], 'no run directory');
  assert.equal(shaOf(dir, 'feat/taken'), before, 'the branch is untouched');
  assert.notEqual(currentBranch(dir), 'feat/taken', 'and not checked out');
  const failed = said.find((n) => n.id === 'run_failed');
  assert.equal(failed?.data?.['code'], EXIT.PREFLIGHT);
  assert.match(String(failed?.data?.['reason']), /"feat\/taken" already exists/);
});

test('a branch checked out in another worktree is refused the same way', async () => {
  const dir = repo();
  const elsewhere = path.join(mkdtempSync(path.join(tmpdir(), 'vibe-branch-wt-')), 'wt');
  sh(dir, 'worktree', 'add', '-q', '-b', 'feat/elsewhere', elsewhere);
  const { result } = await quietly(() => main(['run', 'task', '-C', dir, '--branch', 'feat/elsewhere']));
  assert.equal(result, EXIT.PREFLIGHT);
  assert.deepEqual(runsIn(dir), []);
});

test('the preflight gate refuses the collision too, before the worktree ref is made', async () => {
  // The second guard: a name that became a branch between `cmdRun`'s check and
  // the gate, or a run that reached the gate some other way.
  const { dir } = twoCommits();
  sh(dir, 'branch', 'feat/raced');
  const before = shaOf(dir, 'feat/raced');
  const state = createRun(dir, 'raced', true, { worktree: true, requestedBranch: 'feat/raced' });
  const cfg = gitConfig({ worktree: true, worktreeCommand: ON_BRANCH });
  const { code } = await untilFirstTurn(state, cfg);
  assert.equal(code, EXIT.PREFLIGHT);
  assert.equal(state.branch, null, 'prepareGit never ran');
  assert.match(refusal(state), /"feat\/raced" already exists/);
  assert.equal(shaOf(dir, 'feat/raced'), before);
  assert.equal(existsSync(workDirOf(state)), false, 'no worktree was made');
});

// ---- one name, everywhere ---------------------------------------------------

test('the named branch is what the run takes and what run_branch says', async () => {
  const dir = repo();
  let taken: RunState | null = null;
  const { result, said } = await quietly(() =>
    main(['plan', 'task', '-C', dir, '--branch', 'feat/356-named', '--skip-probe'], async (s, c, r) => {
      taken = s;
      await prepareGit(s, c, workDirOf(s), r);
    }),
  );
  assert.equal(result, EXIT.OK);
  assert.ok(taken !== null);
  const state: RunState = taken;
  assert.equal(state.branch, 'feat/356-named');
  assert.equal(currentBranch(dir), 'feat/356-named');
  const said356 = said.find((n) => n.id === 'run_branch');
  assert.equal(said356?.data?.['branch'], 'feat/356-named');
  // In the first state write, and read back by the validator.
  const stored = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(stored['requestedBranch'], 'feat/356-named');
  assert.equal(loadRun(dir, state.id).requestedBranch, 'feat/356-named');
});

test('a worktree setup script is told the named branch as VIBE_BRANCH', async () => {
  const dir = repo();
  const state = createRun(dir, 'told the name', true, { worktree: true, requestedBranch: 'feat/told' });
  const cfg = gitConfig({ worktree: true, worktreeCommand: ON_BRANCH });
  assert.equal(runBranch(cfg, state), 'feat/told');
  const { code } = await untilFirstTurn(state, cfg);
  assert.equal(code, EXIT.OK);
  // The script ran `git worktree add "$VIBE_WORKTREE" "$VIBE_BRANCH"`, so the
  // worktree being on the name is the variable having carried it.
  assert.equal(currentBranch(workDirOf(state)), 'feat/told');
  assert.equal(state.branch, 'feat/told');
});

test('a resume keeps adopting the branch it took, which now exists', async () => {
  const dir = repo();
  const state = createRun(dir, 'resumed', true, { requestedBranch: 'feat/resumed' });
  const cfg = gitConfig({});
  assert.equal((await untilFirstTurn(state, cfg)).code, EXIT.OK);
  assert.equal(state.branch, 'feat/resumed');
  // A resume is not a fresh run: the branch existing is the expected case, and
  // the collision guard must not mistake the run's own branch for somebody's.
  const { code, lines } = await untilFirstTurn(state, cfg, true);
  assert.equal(code, EXIT.OK, lines.join('\n'));
  assert.equal(refusal(state), '');
  assert.equal(currentBranch(dir), 'feat/resumed');
});

test('without the flag nothing changes: the branch is branchPrefix + id', async () => {
  const dir = repo();
  const state = createRun(dir, 'default', true);
  assert.equal('requestedBranch' in state, false, 'the field is absent, not undefined');
  const { code } = await untilFirstTurn(state, gitConfig({}));
  assert.equal(code, EXIT.OK);
  assert.equal(state.branch, `${DEFAULTS.git.branchPrefix}${state.id}`);
});

test('a stored requestedBranch that is not a name is refused on load', async () => {
  const dir = repo();
  const state = createRun(dir, 'tampered', true, { requestedBranch: 'feat/ok' });
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['requestedBranch'] = 7;
  writeFileSync(file, JSON.stringify(raw), 'utf8');
  assert.throws(() => loadRun(dir, state.id), /requestedBranch/);
});
