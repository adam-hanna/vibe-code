import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitIn, gitRetryable, initGit } from './helpers/loop-harness.js';
import type { GitRunner } from './helpers/loop-harness.js';

/**
 * What the harness does when its own `git` fails.
 *
 * Two unrelated cases went red in one run of the suite for the same reason:
 * `git config` exited 1 in a freshly created temp directory, twice, in different
 * files (#182). Nothing said why, because the runner passed `stdio: 'ignore'` -
 * so the failure was `Command failed: git config user.email ...` with
 * `stderr: null`, and every candidate cause was equally consistent with it.
 *
 * Two separate claims live here, and the first matters whatever is decided about
 * the second: a failure has to carry git's own words, and a retry is allowed only
 * where running the command twice cannot leave a different repository than
 * running it once.
 *
 * Not a flake class this repo already has a rule for. It is neither a wall-clock
 * fixture nor a recycled pid (#164) - it is a real subprocess failing for an
 * environmental reason, which the harness treated as impossible.
 */

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-harness-git-'));
}

/** A runner that records what it was asked, and fails the calls a case names. */
function scripted(fails: (args: readonly string[], seen: number) => boolean): {
  run: GitRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const run: GitRunner = (args) => {
    const line = args.join(' ');
    const seen = calls.filter((c) => c === line).length;
    calls.push(line);
    if (fails(args, seen)) throw new Error(`git ${line} failed in <scripted>: fatal: pretend`);
  };
  return { run, calls };
}

// ---- which commands may be run again ---------------------------------------

test('only the git commands that leave the same repo twice may be retried', () => {
  // Stated as a property rather than as the two sub-commands observed to fail:
  // each of these is the same repository whether it ran once or twice.
  assert.equal(gitRetryable(['init', '-q', '-b', 'main']), true);
  assert.equal(gitRetryable(['config', 'user.email', 'vibe@example.invalid']), true);
  assert.equal(gitRetryable(['add', '-A']), true);

  // The one that must not be. A commit that landed and then failed on the way
  // out answers `nothing to commit` the second time, so a retry would turn an
  // environmental blip into a failure that means something else.
  assert.equal(gitRetryable(['commit', '-q', '-m', 'base']), false);
  assert.equal(gitRetryable([]), false);
});

// ---- what a retry costs and what it says ------------------------------------

test('a retryable failure is run once more and the fixture completes', () => {
  // Fails the first `git config user.email` and nothing else - the shape of the
  // failure that was actually seen.
  const { run, calls } = scripted((args, seen) => args[1] === 'user.email' && seen === 0);

  initGit(scratch(), { run });

  assert.deepEqual(calls, [
    'init -q -b main',
    'config user.email vibe@example.invalid',
    'config user.email vibe@example.invalid',
    'config user.name vibe tests',
    'config commit.gpgsign false',
  ]);
});

test('a commit that fails is not run again', () => {
  const { run, calls } = scripted((args) => args[0] === 'commit');

  assert.throws(
    () => initGit(scratch(), { commit: true, run }),
    /git commit -q -m base failed/,
    'the failure has to name the sub-command that failed',
  );

  assert.equal(calls.filter((c) => c.startsWith('commit')).length, 1);
});

test('a second failure of the same command reports both attempts', () => {
  const { run, calls } = scripted((args) => args[0] === 'config');

  assert.throws(
    () => initGit(scratch(), { run }),
    // Twice is a fact about the machine rather than a moment of bad luck, and
    // the message has to say which of the two this was.
    /failed twice.*First:.*Second:/s,
  );

  assert.equal(calls.filter((c) => c.startsWith('config user.email')).length, 2);
});

// ---- what a real git failure carries ----------------------------------------

test('a real git failure carries what git said, not just the command line', () => {
  const dir = scratch();
  initGit(dir);
  const run = gitIn(dir);

  const err = (() => {
    try {
      run(['checkout', 'definitely-not-a-branch']);
      return null;
    } catch (e: unknown) {
      return e;
    }
  })();

  assert.ok(err instanceof Error, 'a failed git has to throw');
  // git prefixes its diagnostics with `error: `, and none of that text is in the
  // command line above - so its presence is what proves stderr was read rather
  // than discarded. The old runner produced the command line and nothing else.
  assert.match(err.message, /error: /);
  assert.doesNotMatch(err.message, /git said nothing/);
});

test('the identity lands in the repository, where the loop\'s own git will read it', () => {
  // The premise of the fix that was NOT taken. Passing `-c user.email=...` on
  // the harness's invocations would remove three processes and fix the wrong
  // git: `src/git.ts` spawns its own child with its own argv, so a value that
  // is not in `.git/config` does not exist as far as `commitAll` is concerned.
  const dir = scratch();
  initGit(dir, { commit: true });

  const read = (key: string): string =>
    execFileSync('git', ['config', '--local', key], { cwd: dir, encoding: 'utf8' }).trim();

  assert.equal(read('user.email'), 'vibe@example.invalid');
  assert.equal(read('user.name'), 'vibe tests');
  assert.equal(read('commit.gpgsign'), 'false');

  const subject = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(subject, 'base');
});
