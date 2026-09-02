import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stashesFor } from '@src/git.js';
import { orchestrate } from '@src/orchestrator.js';
import { saveState } from '@src/run.js';
import { agents, config, freshRun, initGit } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * Work a killed run left in a git stash (#96).
 *
 * The #87 run stashed to check whether an intermittent test failure predated its
 * change - a legitimate manoeuvre, and the implementation report cites the
 * baseline it produced - and was stopped two minutes later, before the matching
 * pop. 11.3M tokens of implementation sat in `stash@{0}` while `git status`
 * read clean, `git log develop..HEAD` was empty, and `state.json` was in perfect
 * order. Every guard reported healthy.
 *
 * Real git, no seam, for the reason `diff-chunking.test.ts` gives: every claim
 * here is a claim about what git actually writes into a stash entry's reflog
 * subject, and a fake would assert my belief about git rather than git.
 */

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-stash-'));
  initGit(dir, { commit: true });
  return dir;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** Change a tracked file and stash it, exactly as an implementer checking a baseline would. */
function stashWork(dir: string, body: string, message?: string): void {
  writeFileSync(path.join(dir, 'README.md'), body, 'utf8');
  if (message === undefined) git(dir, 'stash', 'push');
  else git(dir, 'stash', 'push', '-m', message);
}

function stashCount(dir: string): number {
  return git(dir, 'stash', 'list').split(/\r?\n/).filter(Boolean).length;
}

// ---- what the branch match is made on ---------------------------------------

const RUN_BRANCH = 'vibe/20260827-141835-implement';

test('a stash made on this branch is found, with its ref and what is in it', async () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', RUN_BRANCH);
  stashWork(dir, '# base\nand a change the killed turn made\n');

  const found = await stashesFor(dir, RUN_BRANCH);

  assert.equal(found.length, 1);
  assert.equal(found[0]?.ref, 'stash@{0}', 'the ref git stash pop takes');
  // The subject is asserted as git actually writes it rather than as #96 assumed
  // it: `git stash` records the branch through its LAST PATH COMPONENT on the
  // git in this repo (2.31.1), so a match on the full name alone finds nothing.
  // Later versions record the full name, which is what #96's transcript shows -
  // hence the alternation, which is not defensive padding but the two shapes
  // this has been observed to take.
  assert.match(
    String(found[0]?.subject),
    /^WIP on (?:vibe\/)?20260827-141835-implement:/,
    `what git wrote: ${String(found[0]?.subject)}`,
  );
  // The evidence that makes the notice worth acting on: a file count and a line
  // count are what say a turn's output is in there.
  //
  // This is also the case that catches the ref-vs-object-id trap. `stash@{0}`
  // cannot be passed to cygwin's git.exe from a native parent - it glob-expands
  // the raw command line, the braces vanish, and git answers "stash@0 is not a
  // valid reference" - so the summary is read by object id. Under
  // Git-for-Windows the ref form works, which is precisely how this would have
  // shipped green on one machine and broken on the next.
  assert.match(String(found[0]?.commit), /^[0-9a-f]{40}$/);
  assert.match(String(found[0]?.stat), /README\.md/);
  assert.match(String(found[0]?.stat), /1 file changed/);
});

test("a stash naming somebody else's branch is left alone", async () => {
  const dir = repo();
  // Made on `main`, which is where a human working in this repo would be.
  stashWork(dir, '# base\nsomeone else was in the middle of something\n');
  git(dir, 'branch', RUN_BRANCH);

  assert.deepEqual(await stashesFor(dir, RUN_BRANCH), []);
  // Exact, not a prefix and not a suffix: `mai` is what a `startsWith` would
  // wrongly claim, and `ain` what an `endsWith` would.
  assert.deepEqual(await stashesFor(dir, 'mai'), []);
  assert.deepEqual(await stashesFor(dir, 'ain'), []);
  assert.equal((await stashesFor(dir, 'main')).length, 1, 'the entry is genuinely there');
});

test('a branch whose leaf git recorded is matched, and a different leaf is not', async () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'vibe/one');
  stashWork(dir, '# base\nwork this run left behind\n');

  assert.equal((await stashesFor(dir, 'vibe/one')).length, 1);
  // A different run, whose branch shares the prefix and not the leaf. The leaf
  // is the run id - a second-resolution stamp plus a slug - so this is the
  // collision that actually has to be ruled out.
  assert.deepEqual(await stashesFor(dir, 'vibe/two'), []);
  // And the prefix on its own names nothing.
  assert.deepEqual(await stashesFor(dir, 'vibe'), []);
});

test('a stash pushed with a message is matched too', async () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'vibe/run');
  // `git stash push -m` writes `On <branch>: <message>` rather than `WIP on
  // <branch>: <sha> <subject>`. Both name the branch and both are git's, so both
  // are read - a run that only knew the WIP form would miss the entries made by
  // an implementer who labelled what it was doing.
  stashWork(dir, '# base\nchanged\n', 'baseline check for the flaky test');

  const found = await stashesFor(dir, 'vibe/run');
  assert.equal(found.length, 1);
  assert.match(
    String(found[0]?.subject),
    /^On (?:vibe\/)?run: baseline check for the flaky test$/,
    `what git wrote: ${String(found[0]?.subject)}`,
  );
});

test('two stashes on the branch are both reported, newest first', async () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'vibe/run');
  stashWork(dir, '# base\nfirst\n', 'first');
  stashWork(dir, '# base\nsecond\n', 'second');

  const found = await stashesFor(dir, 'vibe/run');

  // Reporting only the newest would understate a run that stashed twice, and the
  // refs renumber on every push - so the order is git's own, which is also the
  // order the refs are numbered in.
  assert.deepEqual(
    found.map((e) => e.ref),
    ['stash@{0}', 'stash@{1}'],
  );
  assert.match(String(found[0]?.subject), /second$/);
  assert.match(String(found[1]?.subject), /first$/);
});

test('an empty stash, and a directory git cannot answer about, are both silence', async () => {
  const dir = repo();
  assert.deepEqual(await stashesFor(dir, 'main'), [], 'nothing stashed');

  // Fail closed for a notice means saying nothing: the caller is silent on an
  // empty list, so an unreadable one produces silence rather than a claim that
  // there is nothing there. It must not throw and take the run down either.
  const notARepo = mkdtempSync(path.join(tmpdir(), 'vibe-stash-bare-'));
  assert.deepEqual(await stashesFor(notARepo, 'main'), []);
});

test('a stash made on a detached HEAD matches no branch', async () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '--detach');
  stashWork(dir, '# base\ndetached work\n');

  // git writes `WIP on (no branch): ...`, which parses cleanly and equals no
  // branch a run can be on: `git check-ref-format` forbids the spaces, so
  // nothing this tool records in `state.branch` can ever be that string. No
  // special case for it, and this is why there needs to be none.
  assert.equal(stashCount(dir), 1);
  assert.deepEqual(await stashesFor(dir, 'main'), []);
});

// ---- through the loop, before anything is dispatched ------------------------

/** A run parked at `complete`, so `orchestrate` reaches `prepareGit` and dispatches nothing. */
function finishedRun(branch: string | null): RunState {
  const state = freshRun({ prefix: 'vibe-stash-run-', git: true, commit: true });
  state.branch = branch;
  state.phase = 'complete';
  state.status = 'done';
  saveState(state);
  return state;
}

test('a resumed run says what is in the stash, before any turn is dispatched', async () => {
  const state = finishedRun('vibe/stranded');
  git(state.targetDir, 'checkout', '-q', '-b', 'vibe/stranded');
  stashWork(state.targetDir, '# base\n11.3M tokens of implementation\n');

  const calls: string[] = [];
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    await orchestrate(state, config(), true, agents({}, calls));
  } finally {
    console.log = original;
  }

  assert.deepEqual(calls, [], 'nothing was dispatched');
  const said = lines.join('\n');
  assert.match(said, /git stash holds 1 entry made on this run's branch "vibe\/stranded"/);
  assert.match(said, /stash@\{0\}/);
  assert.match(said, /README\.md/, 'and what is in it');
  assert.match(said, /Nothing has been popped/);

  // A read and only a read. This is the whole reason the notice is safe: a pop
  // can conflict, and a stash a human made is not this tool's to take.
  assert.equal(stashCount(state.targetDir), 1, 'the stash is untouched');

  const event = state.events.find((e) => e.type === 'stash_noticed');
  assert.ok(event, `the run record carries it: ${state.events.map((e) => e.type).join(', ')}`);
  assert.deepEqual(event?.['refs'], ['stash@{0}']);
  assert.equal(event?.['branch'], 'vibe/stranded');
});

test("a run with no stash, and one whose stash is somebody else's, are both silent", async () => {
  for (const [label, make] of [
    ['no stash at all', (): void => {}],
    [
      "a stash on another branch",
      (dir: string): void => {
        stashWork(dir, '# base\nsomebody else\n');
      },
    ],
  ] as [string, (dir: string) => void][]) {
    const state = finishedRun('vibe/quiet');
    make(state.targetDir);
    git(state.targetDir, 'checkout', '-q', '-b', 'vibe/quiet');

    const lines: string[] = [];
    const original = console.log;
    console.log = (...parts: unknown[]): void => {
      lines.push(parts.map((p) => String(p)).join(' '));
    };
    try {
      await orchestrate(state, config(), true, agents({}, []));
    } finally {
      console.log = original;
    }

    assert.doesNotMatch(lines.join('\n'), /git stash holds/, label);
    assert.equal(
      state.events.some((e) => e.type === 'stash_noticed'),
      false,
      label,
    );
  }
});

test('a run that has no branch of its own has nothing to match, and asks nothing', async () => {
  // Which is what makes this inert on a fresh run without a second fact to
  // store: the branch is created inside `prepareGit`, a few lines after the
  // check, so a run in its first process has none - and a branch this process
  // did not create is exactly a resume or a fork.
  const state = finishedRun(null);
  stashWork(state.targetDir, '# base\nwork that belongs to nobody here\n');

  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    await orchestrate(state, config(), true, agents({}, []));
  } finally {
    console.log = original;
  }

  assert.doesNotMatch(lines.join('\n'), /git stash holds/);
  assert.equal(stashCount(state.targetDir), 1);
});
