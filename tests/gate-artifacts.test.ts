import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preserveGateArtifacts } from '@src/artifacts.js';
import { createRun } from '@src/run.js';
import type { ArtifactEntryOutcome, GateArtifacts, RunState } from '@src/types.js';
import {
  DIR_SYMLINK_SKIP,
  FILE_LINK_SKIP,
  JUNCTION_SKIP,
  MKLINK_SKIP,
  linkDir,
  linkDirSymlink,
  linkFile,
  mklinkJunction,
} from './helpers/links.js';

/**
 * Preserving what a failing gate produced (#62).
 *
 * The rules being pinned here are not "does a copy happen". They are:
 *
 * 1. **Nothing is copied through a link**, in any of its four shapes, at any of
 *    the three places one can appear - the configured path itself, an ancestor
 *    of it, and anything inside the tree. The measurement that made this the
 *    design is that `cpSync` FOLLOWS junctions: `dereference` and
 *    `verbatimSymlinks` change nothing, and a file outside the repository landed
 *    inside the run directory. So the junction cases assert on CONTENT, not on
 *    the entry's absence - the first version of that probe conflated "the link
 *    survived" with "the bytes were copied in", and only the second told them
 *    apart.
 * 2. **Nothing is destroyed.** A retry replaces a round wholly rather than
 *    overlaying it, an interrupted swap is finished rather than abandoned, and
 *    anything this module did not create is refused rather than removed.
 * 3. **Nothing throws.** A gate artifact is evidence *about* a failure; failing
 *    to preserve it must not replace that failure with a different one.
 *
 * Real files and real links throughout: the whole subject is what the filesystem
 * does, so a fake would only assert against itself.
 */

// ---- fixtures --------------------------------------------------------------

interface Fixture {
  state: RunState;
  /** The "project" the gate ran in, and the source of every artifact path. */
  cwd: string;
  /** A directory OUTSIDE the project, holding the sentinel a link would reach. */
  outside: string;
}

const SENTINEL = 'SECRET-MUST-NOT-BE-COPIED';

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'vibe-artifacts-'));
  const cwd = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'SECRET.txt'), SENTINEL, 'utf8');
  const state = createRun(cwd, 'gate artifacts', false);
  return { state, cwd, outside };
}

/** A report directory the gate "produced": two files, one nested. */
function report(cwd: string, name = 'report'): string {
  const dir = path.join(cwd, name);
  mkdirSync(path.join(dir, 'nested'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), 'INDEX', 'utf8');
  writeFileSync(path.join(dir, 'nested', 'trace.json'), 'TRACE', 'utf8');
  return dir;
}

function preserve(
  f: Fixture,
  paths: readonly string[],
  options: { round?: number; maxBytes?: number | null } = {},
): GateArtifacts {
  return preserveGateArtifacts(
    f.state,
    f.cwd,
    'qa',
    options.round ?? 1,
    paths,
    options.maxBytes ?? null,
  );
}

/** The absolute round directory, for assertions about what is on disk. */
function roundDir(f: Fixture, round = 1): string {
  return path.join(f.state.dir, 'artifacts', 'qa', `round-${round}`);
}

function entry(result: GateArtifacts, at: string): ArtifactEntryOutcome {
  const found = result.entries.find((e) => e.path === at);
  assert.ok(found !== undefined, `no outcome recorded for ${at}`);
  return found;
}

/** Every file under a directory, as `relative path -> content`. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string): void => {
    if (!existsSync(at)) return;
    for (const child of readdirSync(at, { withFileTypes: true })) {
      const rel = prefix === '' ? child.name : `${prefix}/${child.name}`;
      const full = path.join(at, child.name);
      if (child.isDirectory()) walk(full, rel);
      else out[rel] = readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

/** Whether the outside sentinel's CONTENT reached anywhere under the run directory. */
function sentinelLeaked(f: Fixture): boolean {
  return Object.values(tree(f.state.dir)).some((body) => body.includes(SENTINEL));
}

// ---- what gets copied ------------------------------------------------------

test('a directory and a single file are both copied, and counted', () => {
  const f = fixture();
  report(f.cwd);
  writeFileSync(path.join(f.cwd, 'summary.json'), '{"ok":false}', 'utf8');

  const result = preserve(f, ['report', 'summary.json']);

  assert.deepEqual(tree(roundDir(f)), {
    'report/index.html': 'INDEX',
    'report/nested/trace.json': 'TRACE',
    'summary.json': '{"ok":false}',
  });

  const dir = entry(result, 'report');
  assert.equal(dir.status, 'copied');
  assert.equal(dir.files, 2);
  assert.equal(dir.bytes, 'INDEX'.length + 'TRACE'.length);

  // A single FILE is a copy, not a failure: a measurement walk that assumed a
  // directory root would throw ENOTDIR here and report `failed`.
  const file = entry(result, 'summary.json');
  assert.equal(file.status, 'copied');
  assert.equal(file.files, 1);
  assert.equal(file.bytes, '{"ok":false}'.length);

  assert.equal(result.bytes, (dir.bytes ?? 0) + (file.bytes ?? 0));
});

test('the recorded dir is relative to the run, with POSIX separators', () => {
  const f = fixture();
  report(f.cwd);

  const result = preserve(f, ['report'], { round: 1 });

  // Not `artifactDir`'s absolute host-native return: a stored absolute path is
  // wrong the moment the repository moves, which is why `loadRun` re-derives
  // `dir` and `targetDir` rather than trusting the stored ones.
  assert.equal(result.dir, 'artifacts/qa/round-1');
  assert.ok(!result.dir.includes('\\'));
  assert.ok(!/^[A-Za-z]:/.test(result.dir));
});

// ---- links -----------------------------------------------------------------

test('every link shape inside the tree is refused, named, and its target left behind', (t) => {
  const f = fixture();
  const dir = report(f.cwd);
  const made: string[] = [];

  // Four DISTINCT shapes, each asked for by the call that makes that shape -
  // not one helper called four times. The whole design rests on one predicate
  // covering all four, and a test that created the same object twice would be
  // asserting that claim rather than checking it.
  const shapes: [string, (target: string, at: string) => boolean, string][] = [
    ['file-symlink.txt', (t2, at) => linkFile(path.join(t2, 'SECRET.txt'), at), FILE_LINK_SKIP],
    ['dir-symlink', linkDirSymlink, DIR_SYMLINK_SKIP],
    ['node-junction', linkDir, JUNCTION_SKIP],
    ['mklink-j', mklinkJunction, MKLINK_SKIP],
  ];
  for (const [name, make, skip] of shapes) {
    if (make(f.outside, path.join(dir, name))) made.push(name);
    else t.diagnostic(`${name}: ${skip}`);
  }

  if (made.length === 0) {
    t.skip('no link shape could be created on this platform');
    return;
  }

  const result = preserve(f, ['report']);
  const outcome = entry(result, 'report');

  assert.equal(outcome.status, 'copied');
  // Named, not silently omitted: a record that quietly drops half a report
  // looks complete while being partial.
  assert.deepEqual([...(outcome.skippedLinks ?? [])].sort(), [...made].sort());

  // The real files beside them are still there...
  assert.equal(tree(roundDir(f))['report/index.html'], 'INDEX');
  // ...and nothing behind any link is. Asserted on CONTENT: a junction that was
  // followed leaves no link entry to be absent, only the bytes it copied in.
  assert.equal(sentinelLeaked(f), false);
  for (const name of made) assert.equal(existsSync(path.join(roundDir(f), 'report', name)), false);
});

test('a junction in the tree does not put its target INTO the destination', (t) => {
  // Both junction spellings: the Node one and the one a user types. They were
  // measured to be the same reparse point, and this is where that is checked
  // rather than assumed.
  let ran = 0;
  for (const [name, make, skip] of [
    ['node-junction', linkDir, JUNCTION_SKIP],
    ['mklink-j', mklinkJunction, MKLINK_SKIP],
  ] as const) {
    const f = fixture();
    const dir = report(f.cwd);
    if (!make(f.outside, path.join(dir, name))) {
      t.diagnostic(`${name}: ${skip}`);
      continue;
    }
    ran += 1;

    preserve(f, ['report']);

    // The regression the measurement found: cpSync FOLLOWS a junction and writes
    // the target's bytes in. `SECRET.txt` from outside the project landed inside
    // the archive, and neither `dereference` nor `verbatimSymlinks` prevented it.
    // Asserted on content, because a followed junction leaves no entry to be
    // absent - only the bytes it copied.
    assert.equal(existsSync(path.join(roundDir(f), 'report', name, 'SECRET.txt')), false, name);
    assert.equal(sentinelLeaked(f), false, name);
  }
  if (ran === 0) t.skip(JUNCTION_SKIP);
});

test('a configured path that is itself a link is refused, and copies nothing', (t) => {
  const f = fixture();
  if (!linkDir(f.outside, path.join(f.cwd, 'linked-report'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  const result = preserve(f, ['linked-report']);

  assert.equal(entry(result, 'linked-report').status, 'refused');
  assert.match(entry(result, 'linked-report').reason ?? '', /link/);
  assert.equal(sentinelLeaked(f), false);
  assert.deepEqual(tree(roundDir(f)), {});
});

test('a LINKED ANCESTOR is refused, even though the final component is an ordinary file', (t) => {
  // The case a lexical containment check cannot see: `reports` is a link, so
  // `reports/SECRET.txt` lstats as an ordinary file and cpSync would copy
  // straight through it. Asked of a directory symlink AND a junction, which are
  // different objects on Windows.
  let ran = 0;
  for (const [shape, make, skip] of [
    ['symlink', linkDirSymlink, DIR_SYMLINK_SKIP],
    ['junction', linkDir, JUNCTION_SKIP],
  ] as const) {
    const f = fixture();
    if (!make(f.outside, path.join(f.cwd, 'reports'))) {
      t.diagnostic(`${shape}: ${skip}`);
      continue;
    }
    ran += 1;

    const result = preserve(f, ['reports/SECRET.txt']);

    assert.equal(entry(result, 'reports/SECRET.txt').status, 'refused', shape);
    assert.match(entry(result, 'reports/SECRET.txt').reason ?? '', /link/);
    assert.equal(sentinelLeaked(f), false, shape);
  }
  if (ran === 0) t.skip(`${DIR_SYMLINK_SKIP}; ${JUNCTION_SKIP}`);
});

// ---- the destination -------------------------------------------------------

test('a link anywhere in the destination refuses the write rather than following it', (t) => {
  let ran = 0;
  for (const planted of ['artifacts', path.join('artifacts', 'qa'), path.join('artifacts', 'qa', 'round-1')]) {
    const f = fixture();
    report(f.cwd);
    const at = path.join(f.state.dir, planted);
    mkdirSync(path.dirname(at), { recursive: true });
    if (!linkDir(f.outside, at)) continue;
    ran += 1;

    const result = preserve(f, ['report']);

    // Every entry accounted for, nothing thrown, and nothing written through
    // the link into the directory it points at.
    assert.equal(result.entries.length, 1, planted);
    assert.equal(entry(result, 'report').status, 'failed', planted);
    assert.match(entry(result, 'report').reason ?? '', /link|classif/);
    assert.equal(existsSync(path.join(f.outside, 'report')), false, planted);
    assert.equal(existsSync(path.join(f.outside, 'qa')), false, planted);
  }
  if (ran === 0) t.skip(JUNCTION_SKIP);
});

test('an unexpected FILE at round-N refuses the install and is not deleted', () => {
  const f = fixture();
  report(f.cwd);
  const at = roundDir(f);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, 'NOT-OURS', 'utf8');

  const result = preserve(f, ['report']);

  // This module deletes nothing it did not create. An unexpected file there is
  // a fact for a human, not something to clear out of the way.
  assert.equal(readFileSync(at, 'utf8'), 'NOT-OURS');
  assert.equal(entry(result, 'report').status, 'failed');
  assert.match(entry(result, 'report').reason ?? '', /not a directory/);
  assert.equal(result.bytes, 0);
});

// ---- the lexical rules, applied a second time at copy time -----------------

test('copy time refuses exactly what config validation refuses', () => {
  const f = fixture();
  report(f.cwd);
  writeFileSync(path.join(f.cwd, 'inside.txt'), 'INSIDE', 'utf8');

  const absoluteInside = path.join(f.cwd, 'inside.txt');
  const result = preserve(f, [absoluteInside, 'report/../report/index.html', 'report']);

  // Both resolve INSIDE the project, and both are still refused: the rule is
  // `refuseArtifactPath`, the same function config validation calls, rather than
  // a containment check that "mirrors" it and quietly disagrees.
  assert.equal(entry(result, absoluteInside).status, 'refused');
  assert.match(entry(result, absoluteInside).reason ?? '', /absolute/);
  assert.equal(entry(result, 'report/../report/index.html').status, 'refused');
  assert.match(entry(result, 'report/../report/index.html').reason ?? '', /\.\./);
  // And a good entry beside them still copies.
  assert.equal(entry(result, 'report').status, 'copied');
});

test('a segment Windows would canonicalize away is refused before it is walked', () => {
  const f = fixture();
  report(f.cwd);

  // `.. ` is `..` on Windows, so this walks out of the project there while
  // reading as an ordinary relative path everywhere. Refused at copy time by
  // the same `refuseArtifactPath` config validation calls, so the two cannot
  // disagree about it.
  const result = preserve(f, ['report/.. /.. /SECRET.txt', 'report. /x', 'report']);

  assert.equal(entry(result, 'report/.. /.. /SECRET.txt').status, 'refused');
  assert.equal(entry(result, 'report. /x').status, 'refused');
  assert.equal(sentinelLeaked(f), false);
  assert.equal(entry(result, 'report').status, 'copied');
});

test('the run directory cannot be copied into itself', (t) => {
  const f = fixture();
  const spellings = process.platform === 'win32' ? ['.vibe/runs', '.VIBE/runs'] : ['.vibe/runs'];
  if (process.platform !== 'win32') t.diagnostic('.VIBE is a distinct directory off win32');

  const result = preserve(f, spellings);

  for (const spelling of spellings) {
    assert.equal(entry(result, spelling).status, 'refused', spelling);
    assert.match(entry(result, spelling).reason ?? '', /\.vibe/);
  }
});

// ---- the ceiling -----------------------------------------------------------

test('maxBytes copies under it, copies nothing over it, and is off when null', () => {
  const f = fixture();
  report(f.cwd);
  const size = 'INDEX'.length + 'TRACE'.length;

  const under = preserve(f, ['report'], { maxBytes: size, round: 1 });
  assert.equal(entry(under, 'report').status, 'copied');
  assert.equal(Object.keys(tree(roundDir(f, 1))).length, 2);

  const over = preserve(f, ['report'], { maxBytes: size - 1, round: 2 });
  const outcome = entry(over, 'report');
  assert.equal(outcome.status, 'too-large');
  // The measured size AND the limit, so a human can decide which to change.
  assert.equal(outcome.bytes, size);
  assert.match(outcome.reason ?? '', new RegExp(`${size} bytes measured`));
  assert.match(outcome.reason ?? '', new RegExp(`${size - 1}`));
  // Nothing at all, never a prefix: a truncated report that looks whole is
  // worse than an absent one that says it is absent.
  assert.deepEqual(tree(roundDir(f, 2)), {});
  assert.equal(over.bytes, 0);

  const off = preserve(f, ['report'], { maxBytes: null, round: 3 });
  assert.equal(entry(off, 'report').status, 'copied');
  assert.equal(Object.keys(tree(roundDir(f, 3))).length, 2);
});

// ---- absence and failure ---------------------------------------------------

test('a missing path is missing, not an error, and the others still copy', () => {
  const f = fixture();
  report(f.cwd);

  const result = preserve(f, ['nowhere', 'report', 'nowhere/deeper.json']);

  assert.equal(entry(result, 'nowhere').status, 'missing');
  assert.equal(entry(result, 'nowhere/deeper.json').status, 'missing');
  assert.equal(entry(result, 'report').status, 'copied');
  assert.equal(tree(roundDir(f))['report/index.html'], 'INDEX');
});

test('an unreadable source fails with a reason and takes nothing else down', (t) => {
  if (process.platform === 'win32') {
    t.skip('chmod does not deny directory reads on win32, so the case cannot be arranged');
    return;
  }
  const f = fixture();
  report(f.cwd);
  const locked = path.join(f.cwd, 'locked');
  mkdirSync(locked);
  writeFileSync(path.join(locked, 'inner.txt'), 'INNER', 'utf8');
  chmodSync(locked, 0o000);

  try {
    const result = preserve(f, ['locked', 'report']);

    assert.equal(entry(result, 'locked').status, 'failed');
    assert.ok((entry(result, 'locked').reason ?? '') !== '');
    // The gate failure is still what the caller sees: this returned rather than
    // throwing, and the entry beside it is complete.
    assert.equal(entry(result, 'report').status, 'copied');
    assert.deepEqual(tree(roundDir(f)), {
      'report/index.html': 'INDEX',
      'report/nested/trace.json': 'TRACE',
    });
  } finally {
    chmodSync(locked, 0o700);
  }
});

test('a copy that fails part-way through leaves nothing under the round', (t) => {
  if (process.platform === 'win32') {
    t.skip('a directory that denies reads mid-walk cannot be arranged with chmod on win32');
    return;
  }
  const f = fixture();
  report(f.cwd);
  // Readable enough to measure, unreadable when cpSync recurses into the
  // subdirectory: the copy writes `top.txt` and then throws.
  const partial = path.join(f.cwd, 'partial');
  mkdirSync(path.join(partial, 'deep'), { recursive: true });
  writeFileSync(path.join(partial, 'top.txt'), 'TOP', 'utf8');
  writeFileSync(path.join(partial, 'deep', 'inner.txt'), 'INNER', 'utf8');

  const result = preserveGateArtifacts(f.state, f.cwd, 'qa', 1, ['partial', 'report'], null);
  // If the platform copied it happily, the case proved nothing - say so rather
  // than passing quietly.
  if (entry(result, 'partial').status === 'copied') {
    t.diagnostic('the copy succeeded; the mid-walk failure could not be arranged');
    return;
  }

  assert.equal(entry(result, 'partial').status, 'failed');
  // No file from the failed entry is anywhere under the round: the copy lands
  // in its own temporary child and is only renamed in once cpSync RETURNS.
  for (const rel of Object.keys(tree(roundDir(f)))) assert.ok(!rel.startsWith('partial'), rel);
  assert.equal(tree(roundDir(f))['report/index.html'], 'INDEX');
});

// ---- writing a round twice -------------------------------------------------

test('preserving twice for one round leaves exactly the second attempt', () => {
  const f = fixture();
  const dir = report(f.cwd);

  preserve(f, ['report']);
  assert.equal(tree(roundDir(f))['report/nested/trace.json'], 'TRACE');

  // The round number is `verifyRound + 1`, and the counter only moves after
  // runGate returns - so a kill between the copy and the state write resumes
  // onto the same round. An overlay would leave a hybrid of two attempts.
  rmSync(path.join(dir, 'nested'), { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), 'SECOND', 'utf8');
  preserve(f, ['report']);

  assert.deepEqual(tree(roundDir(f)), { 'report/index.html': 'SECOND' });
});

test('a retry that is too large leaves the round empty, not showing the first attempt', () => {
  const f = fixture();
  report(f.cwd);

  preserve(f, ['report']);
  assert.equal(Object.keys(tree(roundDir(f))).length, 2);

  const retry = preserve(f, ['report'], { maxBytes: 1 });

  assert.equal(entry(retry, 'report').status, 'too-large');
  // The stale files would otherwise read as this attempt's evidence.
  assert.deepEqual(tree(roundDir(f)), {});
});

test('an interrupted swap is finished on the next attempt, and no temp survives one', () => {
  const f = fixture();
  report(f.cwd);
  preserve(f, ['report']);

  const gateDir = path.join(f.state.dir, 'artifacts', 'qa');
  // Exactly the on-disk state a kill between the two renames leaves: the round
  // is gone and its only copy is sitting under the backup name. A real kill is
  // not portable in node:test; what the recovery reads IS this state.
  renameSync(roundDir(f), path.join(gateDir, 'round-1.superseded-99'));
  assert.equal(existsSync(roundDir(f)), false);

  writeFileSync(path.join(f.cwd, 'report', 'index.html'), 'SECOND', 'utf8');
  const result = preserve(f, ['report']);

  assert.equal(entry(result, 'report').status, 'copied');
  assert.equal(tree(roundDir(f))['report/index.html'], 'SECOND');
  // And the housekeeping leaves nothing behind: a stray staging or backup
  // directory in the record is evidence a reader would have to interpret.
  const leftovers = readdirSync(gateDir).filter((n) => n !== 'round-1');
  assert.deepEqual(leftovers, []);
});

test('a backup that cannot be deleted does not un-report an installed round', (t) => {
  if (process.platform === 'win32') {
    // Measured on this host: an open handle blocks the RENAME rather than the
    // removal (EPERM on rename, rm fine), and a read-only file deletes happily -
    // so the cleanup cannot be made to fail here without an ACL change.
    t.skip('a delete that fails while the rename succeeds cannot be arranged on win32');
    return;
  }
  const f = fixture();
  report(f.cwd);
  preserve(f, ['report']);

  // The first round's files are now inside what the retry will rename aside as
  // its backup. A mode-0 directory in there makes the backup's recursive
  // removal fail while the rename that created it still succeeds.
  const nested = path.join(roundDir(f), 'report', 'nested');
  chmodSync(nested, 0o000);

  try {
    writeFileSync(path.join(f.cwd, 'report', 'index.html'), 'SECOND', 'utf8');
    const result = preserve(f, ['report']);

    // Deleting the superseded backup is housekeeping AFTER the new snapshot is
    // in place. Reporting `failed` because it did not tidy up would make
    // state.json contradict a filesystem holding exactly what was asked for.
    assert.equal(entry(result, 'report').status, 'copied');
    assert.ok((result.bytes ?? 0) > 0);
    assert.equal(readFileSync(path.join(roundDir(f), 'report', 'index.html'), 'utf8'), 'SECOND');
  } finally {
    chmodSync(nested, 0o700);
  }
});

test('two backups are left alone rather than one being chosen', () => {
  const f = fixture();
  report(f.cwd);
  preserve(f, ['report']);

  const gateDir = path.join(f.state.dir, 'artifacts', 'qa');
  renameSync(roundDir(f), path.join(gateDir, 'round-1.superseded-1'));
  mkdirSync(path.join(gateDir, 'round-1.superseded-2'));
  writeFileSync(path.join(gateDir, 'round-1.superseded-2', 'other.txt'), 'OTHER', 'utf8');

  const result = preserve(f, ['report']);

  // Two backups mean two interrupted attempts and no fact about which is
  // current; picking one to RESTORE would fabricate that fact. Both stay, under
  // names that say what they are, and the new round is still installed.
  assert.equal(entry(result, 'report').status, 'copied');
  assert.equal(existsSync(path.join(gateDir, 'round-1.superseded-1', 'report', 'index.html')), true);
  assert.equal(existsSync(path.join(gateDir, 'round-1.superseded-2', 'other.txt')), true);
  // And they are NAMED in the record: a directory left beside the round that
  // nothing explains is a puzzle for whoever opens the run.
  assert.match(result.unresolved ?? '', /round-1\.superseded-1/);
  assert.match(result.unresolved ?? '', /round-1\.superseded-2/);

  // Deterministically cleared next time: the round is installed now, so every
  // backup beside it is stale whatever their number, and deleting is a
  // different question from restoring.
  const again = preserve(f, ['report']);
  assert.equal(again.unresolved, undefined);
  assert.deepEqual(readdirSync(gateDir), ['round-1']);
});

test('a clean preservation records no unresolved housekeeping', () => {
  const f = fixture();
  report(f.cwd);

  const result = preserve(f, ['report']);

  // Absent, not an empty string: absence is what lets a reader take "the gate
  // directory holds the rounds and nothing else" from the record alone.
  assert.equal(result.unresolved, undefined);
  assert.deepEqual(readdirSync(path.join(f.state.dir, 'artifacts', 'qa')), ['round-1']);
});
