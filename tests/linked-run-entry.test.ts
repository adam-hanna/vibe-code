import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '@src/cli.js';
import { loadConfig } from '@src/config.js';
import { commitFork, ForkError, listForkPoints, planFork } from '@src/fork.js';
import { lockPath } from '@src/lock.js';
import { EXIT } from '@src/orchestrator.js';
import { priorRunsSection } from '@src/prompts.js';
import { createRun, entryVerdict, listRuns, loadRun } from '@src/run.js';
import type { ForkPlan } from '@src/fork.js';
import type { RunSummary } from '@src/types.js';
import { FILE_LINK_SKIP, JUNCTION_SKIP, linkDir, linkFile } from './helpers/links.js';

/**
 * A run entry under `.vibe/runs` that is a link out of the run root (#53).
 *
 * `assertUsableRunId` closes `../` traversal LEXICALLY, which is all a CLI
 * argument can reach. A single-component entry that is a symlink or a Windows
 * junction passes every one of those checks and still points anywhere on disk,
 * and every reader followed it: `loadRun` read its state.json, `listRuns` read
 * and stat-ed through it, `planFork` probed it, `commitFork` read its lock, and
 * `vibe resume` WROTE a lock file into it before `loadRun` was ever reached.
 *
 * Three properties are pinned here, and they are different properties:
 *
 * 1. **Refusal, by name, before the read.** Not "it eventually errors" - the
 *    `outside-eisdir` fixture below makes reading-then-refusing produce a
 *    textually different error, so the ordering is observable rather than
 *    assumed.
 * 2. **Nothing is written into the target.** The `run.lock` DIRECTORY sentinel
 *    is what makes that checkable for `vibe resume`: `acquireLock` writes the
 *    lock file and its handle deletes it again on release, so a file sentinel
 *    would be overwritten and then removed and the final state would prove
 *    nothing. A directory cannot be overwritten by `writeFileSync`.
 * 3. **The row survives.** #78 established that silently dropping an entry is
 *    how a run disappears; a linked entry is REFUSED, not absent. It lists,
 *    without anything under it being read.
 *
 * And one thing that must NOT happen: an ordinary corrupt entry - a regular
 * file in `.vibe/runs`, say - must not be called a symlink. `plain` from
 * `linkageOf` means "not a link", not "a directory", so those keep the
 * `unreadable` status they have always had (#77) and get no link warning.
 */

const RUNS = path.join('.vibe', 'runs');
const OUTSIDE_TASK = 'OUTSIDE-TASK-MUST-NOT-BE-READ';
const LINK_MESSAGE = /symlink or a junction/;
/** `cmdResume`'s lock refusal, which is what a guard-less implementation prints instead. */
const LOCK_MESSAGE = /cannot be resumed/;

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-linked-'));
  mkdirSync(path.join(dir, RUNS), { recursive: true });
  return dir;
}

/** A directory outside the archive, with a state.json a reader would find valid. */
function outside(root: string, name = 'outside'): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ id: 'outsider', status: 'done', task: OUTSIDE_TASK, costUsd: 4.25 }),
    'utf8',
  );
  writeFileSync(path.join(dir, 'canary.txt'), 'untouched\n', 'utf8');
  return dir;
}

/**
 * The same, except `state.json` is a DIRECTORY.
 *
 * This is the read-ordering probe. Any implementation that reads before it
 * classifies throws EISDIR (surfacing as "not valid JSON" or the errno itself);
 * one that classifies first produces the link refusal. The two outcomes are
 * textually disjoint, so an assertion cannot be satisfied by both orderings.
 */
function outsideUnreadable(root: string): string {
  const dir = path.join(root, 'outside-eisdir');
  mkdirSync(path.join(dir, 'state.json'), { recursive: true });
  writeFileSync(path.join(dir, 'canary.txt'), 'untouched\n', 'utf8');
  return dir;
}

/** An ordinary run directory with whatever state.json text the case wants. */
function plant(targetDir: string, id: string, text: string): void {
  const dir = path.join(targetDir, RUNS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), text, 'utf8');
}

const healthy = (id: string, task: string): string =>
  JSON.stringify({ id, status: 'done', task, costUsd: 1.5 });

/** Names plus contents plus mtimes: "unchanged" as an observation, not a claim. */
function snapshot(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const full = path.join(dir, name);
      const st = statSync(full);
      const body = st.isDirectory() ? '<dir>' : readFileSync(full, 'utf8');
      return `${name} ${st.mtimeMs} ${body}`;
    })
    .join('\n');
}

/** Both streams: `log.fail` writes to stderr, and the refusals under test are fails. */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    return { result: await work(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// ---- loadRun ----------------------------------------------------------------

test('loadRun refuses a linked entry by name, and quotes nothing from behind it', (t) => {
  const dir = tempDir();
  const target = outside(dir);
  if (!linkDir(target, path.join(dir, RUNS, 'sym-run'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  const before = snapshot(target);

  assert.throws(
    () => loadRun(dir, 'sym-run'),
    (err: unknown) => {
      const said = (err as Error).message;
      assert.match(said, LINK_MESSAGE);
      assert.match(said, /sym-run/, 'names the entry the user asked for');
      assert.equal(said.includes(OUTSIDE_TASK), false, 'and nothing from behind the link');
      return true;
    },
  );

  assert.equal(snapshot(target), before, 'the target is byte-identical, mtimes included');
  assert.equal(existsSync(lockPath(target)), false);
  assert.equal(existsSync(path.join(target, '.gitignore')), false);
});

test('loadRun refuses BEFORE the read, not after it', (t) => {
  // If the guard sat after the `readFileSync`, this fixture would surface EISDIR
  // or "not valid JSON" instead - which is the whole point of it.
  const dir = tempDir();
  const target = outsideUnreadable(dir);
  if (!linkDir(target, path.join(dir, RUNS, 'sym-run'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  assert.throws(
    () => loadRun(dir, 'sym-run'),
    (err: unknown) => {
      const said = (err as Error).message;
      assert.match(said, LINK_MESSAGE);
      assert.doesNotMatch(said, /EISDIR|not valid JSON/, 'the read never happened');
      return true;
    },
  );
});

// ---- the fork paths ---------------------------------------------------------

test('planFork and listForkPoints refuse a linked entry with the shared sentence', async (t) => {
  const dir = tempDir();
  const target = outside(dir);
  const unreadable = outsideUnreadable(dir);
  if (
    !linkDir(target, path.join(dir, RUNS, 'sym-run')) ||
    !linkDir(unreadable, path.join(dir, RUNS, 'eisdir-run'))
  ) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  const before = snapshot(target);

  for (const id of ['sym-run', 'eisdir-run']) {
    // The MESSAGE, not merely the type: `ForkError` alone would be satisfied by
    // the ordinary "has no checkpoint 1" refusal, which proves nothing.
    await assert.rejects(
      planFork(dir, id, 1, {}),
      (err: unknown) => err instanceof ForkError && LINK_MESSAGE.test(err.message),
    );
    assert.throws(
      () => listForkPoints(dir, id),
      (err: unknown) => err instanceof ForkError && LINK_MESSAGE.test(err.message),
    );
  }

  assert.equal(snapshot(target), before);
  assert.equal(existsSync(lockPath(target)), false, 'no lock was written through the link');
});

test('commitFork refuses a supplied plan whose source is a link, or does not name its own directory', async (t) => {
  const dir = tempDir();
  const target = outside(dir);
  if (!linkDir(target, path.join(dir, RUNS, 'sym-run'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  const before = snapshot(target);

  // `ForkPlan` and `commitFork` are both exported, and nothing about the plan
  // object proves it came from `planFork`. Everything below the source is a real
  // value of the right shape; none of it is reached, because the source is
  // classified first.
  const carrier = createRun(dir, 'a plan has to carry a state', true);
  // After the carrier exists, so the comparison below is about what THIS call
  // creates - which must be nothing.
  const dirsBefore = readdirSync(path.join(dir, RUNS)).sort();
  const base: ForkPlan = {
    source: { id: 'sym-run', dir: path.join(dir, RUNS, 'sym-run') },
    checkpointState: carrier,
    meta: {
      n: 1,
      at: new Date(0).toISOString(),
      boundary: 'plan-approved',
      phase: 'planning',
      planRound: 1,
      reviewRound: 0,
      verifyRound: 0,
      commit: null,
      commitNote: 'not-a-repo',
    },
    cfg: loadConfig(dir, {}),
    commit: null,
    tokenShare: null,
    losses: [],
  };

  await assert.rejects(
    commitFork(dir, base),
    (err: unknown) => err instanceof ForkError && LINK_MESSAGE.test(err.message),
  );

  // The same plan, lying about where its source lives: a path that arrived in a
  // parameter is not a path this module resolved.
  await assert.rejects(
    commitFork(dir, { ...base, source: { id: 'sym-run', dir: target } }),
    (err: unknown) => err instanceof ForkError && /is not\s+its directory/.test(err.message),
  );

  assert.equal(snapshot(target), before, 'the source lock was never read or written');
  assert.deepEqual(
    readdirSync(path.join(dir, RUNS)).sort(),
    dirsBefore,
    'and no child run directory was created',
  );
});

// ---- vibe resume ------------------------------------------------------------

test('vibe resume refuses a linked entry before it can take a lock', async (t) => {
  const dir = tempDir();
  const target = outside(dir, 'outside-sentinel');
  // The sentinel. `acquireLock` writes the lock unconditionally and deletes it
  // again on release, so only something it CANNOT overwrite survives to be
  // evidence. It also makes the lock unreadable, so a guard-less run refuses on
  // liveness instead - either way the message is the lock refusal, not this one.
  mkdirSync(lockPath(target));
  if (!linkDir(target, path.join(dir, RUNS, 'sym-run'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  const before = snapshot(target);

  const { result, lines } = await captureLog(() => main(['resume', 'sym-run', '-C', dir]));

  const said = lines.join('\n');
  assert.equal(result, EXIT.ERROR);
  assert.match(said, LINK_MESSAGE);
  assert.doesNotMatch(said, LOCK_MESSAGE, 'it never reached `acquireLock`');
  assert.equal(lstatSync(lockPath(target)).isDirectory(), true, 'the sentinel is intact');
  assert.equal(snapshot(target), before);
});

// ---- the listing ------------------------------------------------------------

test('listRuns lists a linked entry without following it', (t) => {
  const dir = tempDir();
  const target = outside(dir);
  if (!linkDir(target, path.join(dir, RUNS, 'sym-run'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  const runs = listRuns(dir);
  const row = runs.find((r) => r.id === 'sym-run');

  assert.ok(row !== undefined, 'the row is kept, not dropped (#78)');
  assert.equal(row.status, 'linked');
  assert.equal(row.linked, true);
  assert.equal(row.task, '');
  assert.equal(row.costUsd, null);
  assert.equal(row.liveness, undefined, 'no lock was read, so no verdict is claimed');
  assert.equal(
    JSON.stringify(runs).includes(OUTSIDE_TASK),
    false,
    'nothing from behind the link reached the listing',
  );
  assert.equal(existsSync(lockPath(target)), false);
});

test('a broken link, and one whose target holds no run, keep their rows', (t) => {
  const dir = tempDir();
  const empty = path.join(dir, 'empty-outside');
  mkdirSync(empty, { recursive: true });
  if (
    !linkDir(path.join(dir, 'no-such-directory'), path.join(dir, RUNS, 'broken-run')) ||
    !linkDir(empty, path.join(dir, RUNS, 'empty-target'))
  ) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  plant(dir, 'plain-run', healthy('plain-run', 'an ordinary run'));

  // The failure this replaced: the presence probe stat-ed THROUGH the link, got
  // `absent` for both of these, and dropped them before any guard could speak.
  const runs = listRuns(dir);

  assert.deepEqual(
    runs.map((r) => `${r.id}:${r.status}`).sort(),
    ['broken-run:linked', 'empty-target:linked', 'plain-run:done'],
  );
  for (const id of ['broken-run', 'empty-target']) {
    assert.equal(runs.find((r) => r.id === id)?.linked, true);
  }
});

test('every classification maps to exactly one outcome, including the ones lstat cannot answer', () => {
  // The decision, tested directly. `lstat` throwing is what produces `unknown`,
  // and no portable fixture can arrange that - a test that needed EACCES on one
  // platform and something else on another would be a test that silently does
  // not run. The wiring around this decision is covered by the real-link cases
  // above and below; this covers the three-way decision itself.
  assert.equal(entryVerdict({ dir: 'link', state: null }), 'linked');
  assert.equal(entryVerdict({ dir: 'directory', state: 'link' }), 'linked');

  // Fails closed. Not called a link - that was not measured - but not followed
  // either, and the row it produces carries the do-not-open warning.
  assert.equal(entryVerdict({ dir: 'unknown', state: null }), 'unverified');
  assert.equal(entryVerdict({ dir: 'directory', state: 'unknown' }), 'unverified');

  // A confirmed non-link reads exactly as it always has - a regular file in
  // `.vibe/runs` included, which is the case that must NOT be called a link.
  assert.equal(entryVerdict({ dir: 'directory', state: 'plain' }), 'readable');
  assert.equal(entryVerdict({ dir: 'directory', state: 'missing' }), 'readable');
  assert.equal(entryVerdict({ dir: 'not-a-directory', state: null }), 'readable');
  assert.equal(entryVerdict({ dir: 'missing', state: null }), 'readable');
});

test('an unclassifiable row is warned off too, and is not called a link', () => {
  // The row `listRuns` produces for an entry whose `lstat` threw. It says
  // `unverified` rather than `unreadable`, so the planner can pick out the row
  // the warning is about, and it does not say `linked`, which was not measured.
  const rows: RunSummary[] = [
    { id: 'cannot-tell', status: 'unverified', task: '', costUsd: null, unverified: true },
    { id: 'r2', status: 'done', task: 'an ordinary run', costUsd: 0 },
  ];
  const section = priorRunsSection(rows);

  assert.ok(section.includes('- `cannot-tell` - unverified'), 'the row is visible');
  assert.ok(section.includes('could not be classified at all'), 'and is warned off');
  assert.ok(section.includes('Do not open it either'));
  assert.equal(
    section.includes('is a symlink or junction pointing outside'),
    false,
    'without claiming a link nobody measured',
  );
});

test('an ordinary unreadable row gets no warning at all', () => {
  // The line between the two: a state.json that WAS opened and could not be
  // used is a corrupt run, not an entry vibe declined to look inside, and the
  // planner has every reason to open its directory.
  const rows: RunSummary[] = [{ id: 'corrupt', status: 'unreadable', task: '', costUsd: null }];
  const section = priorRunsSection(rows);

  assert.ok(section.includes('- `corrupt` - unreadable'));
  assert.equal(section.includes('Do not open'), false);
});

test('a plain entry that is not a directory is never called a link', () => {
  // No link is created here, so this case cannot skip - which is the point.
  //
  // A regular file in `.vibe/runs` is `not-a-directory` to `entryKind`: a
  // definitive classification, not a failure to classify, so it is neither
  // `linked` nor `unverified` and stays on the `unreadable` path it has always
  // been on (#77). That distinction is why `entryKind` asks about directoryness
  // at all.
  //
  // WHICH of the two survivable outcomes it gets is a platform fact and is
  // deliberately not pinned: probing `<file>/state.json` reports ENOENT on
  // Windows (so the entry is `absent` and is dropped, exactly as it was before
  // this change) and ENOTDIR on POSIX (so it is kept and listed as
  // `unreadable`, also exactly as before). What must hold on both is that it is
  // never `linked` and never carries the do-not-open warning.
  const dir = tempDir();
  writeFileSync(path.join(dir, RUNS, 'a-file'), 'not a run at all\n', 'utf8');
  plant(dir, 'plain-run', healthy('plain-run', 'an ordinary run'));

  const runs = listRuns(dir);
  const row = runs.find((r) => r.id === 'a-file');

  if (row !== undefined) {
    assert.equal(row.status, 'unreadable');
    assert.equal(row.linked, undefined, 'no link is claimed, because none was measured');
  }
  assert.equal(
    runs.some((r) => r.linked === true || r.unverified === true),
    false,
    'nothing here is a link or unclassifiable, and nothing says so',
  );
  assert.equal(priorRunsSection(runs).includes('Do not open'), false);
  assert.equal(runs.find((r) => r.id === 'plain-run')?.status, 'done');
});

test('a linked state.json inside a real run directory is refused too', (t) => {
  const dir = tempDir();
  const target = outside(dir);
  mkdirSync(path.join(dir, RUNS, 'half-run'), { recursive: true });
  if (!linkFile(path.join(target, 'state.json'), path.join(dir, RUNS, 'half-run', 'state.json'))) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  assert.throws(
    () => loadRun(dir, 'half-run'),
    (err: unknown) => {
      const said = (err as Error).message;
      assert.match(said, LINK_MESSAGE);
      assert.match(said, /its state\.json/, 'says which of the two it is');
      assert.equal(said.includes(OUTSIDE_TASK), false);
      return true;
    },
  );

  const row = listRuns(dir).find((r) => r.id === 'half-run');
  assert.equal(row?.status, 'linked');
  assert.equal(row?.linked, true);
  assert.equal(JSON.stringify(listRuns(dir)).includes(OUTSIDE_TASK), false);
});

// ---- the planner's index ----------------------------------------------------

test('the prompt keeps the linked row and tells the planner not to open it', (t) => {
  const dir = tempDir();
  const target = outside(dir);
  if (!linkDir(target, path.join(dir, RUNS, 'sym-run'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  plant(dir, 'plain-run', healthy('plain-run', 'an ordinary run'));

  const section = priorRunsSection(listRuns(dir));

  assert.ok(section.includes('- `sym-run` - linked'), 'the row is visible');
  assert.ok(section.includes('Do not open it'), 'and carries its own instruction');
  assert.equal(section.includes(OUTSIDE_TASK), false);
});

test('the warning follows provenance, not the status string that happens to say "linked"', () => {
  // A stored status is copied through verbatim by `summariseStored`, on purpose.
  // A run that says `"status": "linked"` in its own state.json is a display
  // coincidence, and telling the planner its directory points outside the
  // archive would be a fabrication.
  const stored: RunSummary[] = [{ id: 'r1', status: 'linked', task: 'an ordinary run', costUsd: 0 }];
  const section = priorRunsSection(stored);

  assert.ok(section.includes('- `r1` - linked'), 'the row still renders as stored');
  assert.equal(section.includes('Do not open it'), false, 'but nothing is claimed about links');
});

test('a linked row that cannot be rendered takes its warning with it', () => {
  // `priorRunRow` drops a row whose id sanitises to empty - it names nothing the
  // planner could open. A warning about a row nobody can see is noise.
  const dropped: RunSummary[] = [
    { id: ' ', status: 'linked', task: '', costUsd: null, linked: true },
    { id: 'r2', status: 'done', task: 'an ordinary run', costUsd: 0 },
  ];
  const section = priorRunsSection(dropped);

  assert.ok(section.includes('- `r2` - done'));
  assert.equal(section.includes('Do not open it'), false);
});

// ---- what must keep working -------------------------------------------------

test('a runs root that is ITSELF a link still lists and loads its runs', (t) => {
  // The one legitimate reason to link anything here - "keep my runs on another
  // disk". Entries inside a linked root are ordinary directories, which is why
  // the check is at the entry rather than at the root.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-linked-'));
  const elsewhere = path.join(dir, 'archive-elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(path.join(dir, '.vibe'), { recursive: true });
  if (!linkDir(elsewhere, path.join(dir, RUNS))) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  const first = createRun(dir, 'the first run', true);
  const second = createRun(dir, 'the second run', true);

  const listed = listRuns(dir);
  assert.deepEqual(
    listed.map((r) => r.id).sort(),
    [first.id, second.id].sort(),
  );
  for (const row of listed) assert.equal(row.linked, undefined);
  assert.equal(loadRun(dir, first.id).task, 'the first run');
});

test('an ordinary run beside a linked one is untouched in every path', (t) => {
  const dir = tempDir();
  const target = outside(dir);
  if (!linkDir(target, path.join(dir, RUNS, 'sym-run'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  const real = createRun(dir, 'an ordinary run', true);
  const before = readFileSync(path.join(real.dir, 'state.json'), 'utf8');

  const row = listRuns(dir).find((r) => r.id === real.id);
  assert.equal(row?.status, 'planning');
  assert.equal(row?.task, 'an ordinary run');
  assert.equal(row?.linked, undefined);
  assert.equal(row?.liveness, 'not-running', 'its lock is still read, unlike the linked row');
  assert.equal(loadRun(dir, real.id).task, 'an ordinary run');
  assert.equal(readFileSync(path.join(real.dir, 'state.json'), 'utf8'), before);
});
