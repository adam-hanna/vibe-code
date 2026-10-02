import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRun, loadRun } from '@src/run.js';
import {
  createWorktree,
  ensureWorktreesIgnored,
  workDirOf,
  worktreePath,
  WORKTREES_DIR,
} from '@src/worktree.js';
import { config, initGit } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';
import { execFileSync } from 'node:child_process';
import { execute, REAL_GATE } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { runBranch } from '@src/git.js';
import { EXIT, prepareGit } from '@src/orchestrator.js';

/**
 * A checkout of its own for the run to work in (#223).
 *
 * The question this file is really about is **which directory means what**, and
 * the two answers must not be able to swap places: `state.targetDir` is the run's
 * home — archive, lock, past-run index — and `workDirOf` is where the work
 * happens. Everything below is either that distinction or the refusal that keeps
 * a half-made worktree from reaching the loop.
 *
 * `git` is real here rather than stubbed, for the reason `loop-harness.ts` gives
 * about the verification gate: a worktree is a thing git either made or did not,
 * and a fake that answered "yes" would pin our belief about git rather than git.
 */

function repo(commit = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-wt-'));
  initGit(dir, { commit });
  return dir;
}

const TIMEOUT = 60_000;

test('a run with no worktree works in the repository, exactly as it always did', () => {
  const dir = repo();
  const state = createRun(dir, 'no worktree', true);
  // The field is ABSENT rather than false. Every run that predates it is this
  // shape, and `workDirOf` collapsing for them is what makes the whole feature
  // inert when it is off.
  assert.equal(state.worktree, undefined);
  assert.equal(workDirOf(state), dir);
});

test('a run with a worktree works in a path derived from its id, never a stored one', () => {
  const dir = repo();
  const state = createRun(dir, 'with worktree', true, { worktree: true });
  assert.equal(state.worktree, true);
  assert.equal(workDirOf(state), path.join(dir, WORKTREES_DIR, state.id));
  // Derived, which is the point: `loadRun` re-derives `dir` and `targetDir`
  // because a repository legitimately moves, and a stored absolute path is the
  // thing that breaks when it does. So the path must not be in the record.
  const raw = readFileSync(path.join(state.dir, 'state.json'), 'utf8');
  assert.ok(!raw.includes(WORKTREES_DIR), 'the worktree path must not be stored');
  assert.match(raw, /"worktree": true/);
});

test('the decision survives a resume, because a run must not come back in the wrong tree', () => {
  const dir = repo();
  const state = createRun(dir, 'survives', true, { worktree: true });
  const back = loadRun(dir, state.id);
  assert.equal(back.worktree, true);
  assert.equal(workDirOf(back), workDirOf(state));
});

test('an unreadable worktree flag degrades to the repository and says it did', () => {
  // Fail closed, in the direction that is safe. "No worktree" means the run works
  // where its archive, lock and refs already are — which is what every run did
  // before this field — and the repair is REPORTED rather than silent. Reading
  // absent as true would be the dangerous direction: a resume pointed at a
  // directory that may never have been made.
  const dir = repo();
  const state = createRun(dir, 'bad flag', true, { worktree: true });
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['worktree'] = 'yes please';
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

  const back = loadRun(dir, state.id);
  assert.equal(back.worktree, undefined);
  assert.equal(workDirOf(back), dir);
});

test('creating one makes a real working tree, detached so prepareGit still owns the branch', async () => {
  const dir = repo();
  const state = createRun(dir, 'make it', true, { worktree: true });
  const made = await createWorktree({
    targetDir: dir,
    id: state.id,
    command: null,
    timeoutMs: TIMEOUT,
    branch: null,
  });
  assert.equal(made.ok, true);
  if (!made.ok) return;
  assert.equal(made.dir, workDirOf(state));
  assert.equal(made.created, true);
  assert.equal(made.how, 'git');
  // A worktree's `.git` is a FILE pointing into the parent, not a directory, so
  // "is this a checkout" has to be asked of git rather than of the filesystem.
  assert.ok(existsSync(path.join(made.dir, '.git')));
  // **Detached, which is the whole decomposition.** `prepareGit` settles every
  // branch question in this product at seven call sites and narrates
  // `run_branch`; a `worktree add -b` here would be a second answer to it, and
  // the two would disagree the first time somebody set `git.branchPrefix`.
  const head = readFileSync(path.join(dir, '.git', 'worktrees', state.id, 'HEAD'), 'utf8');
  assert.doesNotMatch(head, /^ref:/, 'the worktree must start detached');
});

test('creating one twice is reusing it, because a resume comes through here too', async () => {
  const dir = repo();
  const state = createRun(dir, 'twice', true, { worktree: true });
  const args = { targetDir: dir, id: state.id, command: null, timeoutMs: TIMEOUT, branch: null };
  const first = await createWorktree(args);
  assert.equal(first.ok, true);
  const again = await createWorktree(args);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  // `git worktree add` fails on a path that exists, so without this a resume
  // would refuse every run that had one.
  assert.equal(again.created, false);
});

test('a repository with no commits is refused with the reason rather than a git error', async () => {
  // The usual cause on a brand-new project: `worktree add … HEAD` has no HEAD to
  // start from. Nothing has been spent at this point, which is what makes a
  // refusal the right answer.
  const dir = repo(false);
  const state = createRun(dir, 'no commits', true, { worktree: true });
  const made = await createWorktree({
    targetDir: dir,
    id: state.id,
    command: null,
    timeoutMs: TIMEOUT,
    branch: null,
  });
  assert.equal(made.ok, false);
  if (made.ok) return;
  assert.match(made.reason, /no commits/);
  // And it names the way out, because "turn it off" is a real answer here.
  assert.match(made.reason, /git\.worktree/);
});

test('the custom command replaces git worktree add, and is told where to put it', async () => {
  const dir = repo();
  const state = createRun(dir, 'custom', true, { worktree: true });
  // Deliberately a sequence, because being one is the whole reason this setting
  // goes through a shell: a worktree nobody installed into cannot run the gate.
  const marker = 'SETUP-RAN';
  const command =
    process.platform === 'win32'
      ? `git worktree add --detach "%VIBE_WORKTREE%" HEAD && echo ${marker}> "%VIBE_WORKTREE%\\setup.txt"`
      : `git worktree add --detach "$VIBE_WORKTREE" HEAD && echo ${marker} > "$VIBE_WORKTREE/setup.txt"`;

  const made = await createWorktree({ targetDir: dir, id: state.id, command, timeoutMs: TIMEOUT, branch: null });
  assert.equal(made.ok, true);
  if (!made.ok) return;
  assert.equal(made.how, 'command');
  assert.equal(made.dir, workDirOf(state));
  // It honoured VIBE_WORKTREE. vibe owns that path precisely so a resume can
  // re-derive it rather than storing one.
  assert.match(readFileSync(path.join(made.dir, 'setup.txt'), 'utf8'), new RegExp(marker));
});

test('a command that fails is refused with its own output and what it is given', async () => {
  const dir = repo();
  const state = createRun(dir, 'fails', true, { worktree: true });
  const made = await createWorktree({
    targetDir: dir,
    id: state.id,
    command: 'echo deliberate-failure && exit 3',
    timeoutMs: TIMEOUT,
    branch: null,
  });
  assert.equal(made.ok, false);
  if (made.ok) return;
  assert.match(made.reason, /git\.worktree\.command failed/);
  assert.match(made.reason, /deliberate-failure/);
  // The three variables, named in the refusal: a command that failed because it
  // did not know what it was handed can only be fixed by being told.
  assert.match(made.reason, /VIBE_WORKTREE/);
  assert.match(made.reason, /VIBE_RUN_ID/);
});

test('a command that exits 0 and leaves nothing is refused, not believed', async () => {
  // **The check that matters.** A script reporting success and producing no
  // checkout would otherwise hand the loop a directory that is not a working
  // tree, and every git operation afterwards would fail one at a time with
  // nothing naming the cause.
  const dir = repo();
  const state = createRun(dir, 'lies', true, { worktree: true });
  const made = await createWorktree({
    targetDir: dir,
    id: state.id,
    command: process.platform === 'win32' ? 'exit /b 0' : 'true',
    timeoutMs: TIMEOUT,
    branch: null,
  });
  assert.equal(made.ok, false);
  if (made.ok) return;
  assert.match(made.reason, /not a git working tree/);
  assert.match(made.reason, /Nothing has been spent/);
});

test('.worktrees is self-ignoring wherever it sits, and an existing file is left alone', () => {
  const dir = repo();
  ensureWorktreesIgnored(dir);
  const file = path.join(dir, WORKTREES_DIR, '.gitignore');
  // The same mechanism and the same reason as `ensureVibeIgnored`: this repo's
  // own .gitignore lists `.worktrees/`, but a directory vibe creates in somebody
  // else's checkout cannot rely on that, and a tree full of untracked worktrees
  // is a `git status` nobody can read.
  assert.equal(readFileSync(file, 'utf8'), '*\n');

  writeFileSync(file, '# mine\n', 'utf8');
  ensureWorktreesIgnored(dir);
  assert.equal(readFileSync(file, 'utf8'), '# mine\n', 'never overwrite what somebody wrote');
});

test('the path convention is one function, so nothing else may spell it', () => {
  // Two spellings of a path is how a resume comes to look in a directory the
  // creation never made. `workDirOf` is built on this and so is `createWorktree`.
  assert.equal(worktreePath('/r', 'run-1'), path.join('/r', WORKTREES_DIR, 'run-1'));
  const state = { targetDir: '/r', id: 'run-1', worktree: true } as RunState;
  assert.equal(workDirOf(state), worktreePath('/r', 'run-1'));
});

// ---- The branch a setup script is told (#223) --------------------------------
//
// Asked for as *"in the worktree command, we need to be able to have a
// placeholder for the directory path and branch name"*. The core computes the
// branch with `runBranch`, creates it as a ref before the script runs, passes it
// as VIBE_BRANCH, and `prepareGit` adopts it - so the script is told one answer
// and never invents a second.

const onBranch =
  process.platform === 'win32'
    ? 'git worktree add "%VIBE_WORKTREE%" "%VIBE_BRANCH%"'
    : 'git worktree add "$VIBE_WORKTREE" "$VIBE_BRANCH"';

function branchOf(dir: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

test('a setup command is told the branch, which already exists, and can check it out', async () => {
  const dir = repo();
  const state = createRun(dir, 'told the branch', false, { worktree: true });
  const cfg = config({}, { git: { ...DEFAULTS.git, worktree: true, worktreeCommand: onBranch } });
  const code = await execute(state, cfg, false, true, REAL_GATE, () => Promise.resolve());
  assert.notEqual(code, EXIT.PREFLIGHT, 'the setup command must not have been refused');
  // The same expression `prepareGit` uses, so the two cannot disagree.
  const branch = runBranch(cfg, state);
  assert.equal(branch, `${DEFAULTS.git.branchPrefix}${state.id}`);
  assert.equal(branchOf(workDirOf(state)), branch);
});

test('prepareGit adopts a branch that already exists rather than creating it again', async () => {
  const dir = repo();
  const state = createRun(dir, 'adopted', false, { worktree: true });
  const cfg = config({}, { git: { ...DEFAULTS.git, worktree: true, worktreeCommand: onBranch } });
  await execute(state, cfg, false, true, REAL_GATE, () => Promise.resolve());
  // `checkout -b` on a branch that exists fails, which is what this would do
  // without the adoption - and on the worktree that the script already put there.
  await prepareGit(state, cfg, workDirOf(state), false);
  assert.equal(state.branch, runBranch(cfg, state));
  assert.equal(branchOf(workDirOf(state)), state.branch);
});

test('the default detached worktree is put on the pre-made branch by prepareGit', async () => {
  const dir = repo();
  const state = createRun(dir, 'detached then adopted', false, { worktree: true });
  const cfg = config({}, { git: { ...DEFAULTS.git, worktree: true, worktreeCommand: null } });
  await execute(state, cfg, false, true, REAL_GATE, () => Promise.resolve());
  await prepareGit(state, cfg, workDirOf(state), false);
  assert.equal(branchOf(workDirOf(state)), `${DEFAULTS.git.branchPrefix}${state.id}`);
});

test('with branch isolation off a script is told no branch at all', async () => {
  const dir = repo();
  const state = createRun(dir, 'no branch', false, { worktree: true });
  // An unset variable, not an empty one: an empty string is a name a script
  // could hand to git.
  const command =
    process.platform === 'win32'
      ? 'git worktree add --detach "%VIBE_WORKTREE%" HEAD && (if defined VIBE_BRANCH (echo set) else (echo unset)) > "%VIBE_WORKTREE%\\branch.txt"'
      : 'git worktree add --detach "$VIBE_WORKTREE" HEAD && echo "${VIBE_BRANCH-unset}" > "$VIBE_WORKTREE/branch.txt"';
  const cfg = config({}, {
    git: { ...DEFAULTS.git, worktree: true, useBranch: false, worktreeCommand: command },
  });
  await execute(state, cfg, false, true, REAL_GATE, () => Promise.resolve());
  assert.match(readFileSync(path.join(workDirOf(state), 'branch.txt'), 'utf8'), /unset/);
});
