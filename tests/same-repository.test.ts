import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '@src/cli.js';
import { EXIT } from '@src/orchestrator.js';
import { acquireLock, lockPath } from '@src/lock.js';
import type { LivenessVerdict, PidProbe, RunLock } from '@src/lock.js';
import { allocateRun, RUNS_DIR } from '@src/run.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { entryConflict, sameRepositoryRefusal, storedWorktree } from '@src/worktree.js';
import { tryLink } from './helpers/links.js';

/**
 * Two runs working in one checkout (#246).
 *
 * The app now runs one host process per run, so two runs can be going at once,
 * and the core refuses the one combination that would have them edit the same
 * files: either run working in the repository itself. Every verdict here is a
 * premise stated through `PidProbe` rather than a real process, because the
 * claim is about what each verdict MEANS, and a real pid is what made #164's
 * cases flaky. The two cases that drive `main` use this process's own pid, which
 * is the one pid guaranteed to be alive.
 */

const running: PidProbe = () => 'running';
const interrupted: PidProbe = () => 'interrupted';

function repo(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'vibe-same-repo-'));
}

/** A run directory with a lock and a state.json saying whether it has a worktree. */
function sibling(
  targetDir: string,
  id: string,
  opts: { lock?: Partial<RunLock> | 'garbage' | null; worktree?: boolean | null } = {},
): string {
  const dir = path.join(targetDir, RUNS_DIR, id);
  mkdirSync(dir, { recursive: true });
  const lock = opts.lock === undefined ? {} : opts.lock;
  if (lock === 'garbage') writeFileSync(lockPath(dir), '{ not json', 'utf8');
  else if (lock !== null) {
    const full: RunLock = {
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      id,
      token: `${id}-token`,
      ...lock,
    };
    writeFileSync(lockPath(dir), JSON.stringify(full), 'utf8');
  }
  const worktree = opts.worktree === undefined ? false : opts.worktree;
  if (worktree !== null) {
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id, worktree }), 'utf8');
  }
  return dir;
}

// ---- verdicts ---------------------------------------------------------------

test('a running sibling refuses, naming it and git.worktree', () => {
  const dir = repo();
  sibling(dir, 'live-run');
  const why = sameRepositoryRefusal(dir, { self: null, worktree: false, probe: running });
  assert.ok(why !== null);
  assert.match(why, /live-run/);
  assert.match(why, /git\.worktree/);
  assert.match(why, new RegExp(`pid ${process.pid}`));
});

test('an interrupted sibling does not count', () => {
  const dir = repo();
  sibling(dir, 'dead-run');
  assert.equal(sameRepositoryRefusal(dir, { self: null, worktree: false, probe: interrupted }), null);
});

test('a sibling with no lock does not count', () => {
  const dir = repo();
  sibling(dir, 'idle-run', { lock: null });
  assert.equal(sameRepositoryRefusal(dir, { self: null, worktree: false, probe: running }), null);
});

test('an unreadable lock is unknown, refuses, and names the lock file', () => {
  const dir = repo();
  const run = sibling(dir, 'torn-run', { lock: 'garbage' });
  const why = sameRepositoryRefusal(dir, { self: null, worktree: false, probe: interrupted });
  assert.ok(why !== null);
  assert.ok(why.includes(lockPath(run)), why);
});

test("a lock written on another machine is unknown and refuses", () => {
  const dir = repo();
  const run = sibling(dir, 'remote-run', { lock: { host: `${os.hostname()}-elsewhere` } });
  const why = sameRepositoryRefusal(dir, { self: null, worktree: false, probe: interrupted });
  assert.ok(why !== null);
  assert.ok(why.includes(lockPath(run)), why);
});

test('the run being resumed never counts against itself', () => {
  const dir = repo();
  sibling(dir, 'me');
  assert.equal(sameRepositoryRefusal(dir, { self: 'me', worktree: false, probe: running }), null);
});

test('the worktree matrix: only both-in-worktrees is allowed', () => {
  for (const [live, next, allowed] of [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ] as const) {
    const dir = repo();
    sibling(dir, 'live', { worktree: live });
    const why = sameRepositoryRefusal(dir, { self: null, worktree: next, probe: running });
    assert.equal(why === null, allowed, `live=${String(live)} new=${String(next)}`);
  }
});

test('a live run whose record cannot be read counts as working in the repository', () => {
  for (const write of [null, 'garbage'] as const) {
    const dir = repo();
    const run = sibling(dir, 'live', { worktree: null });
    if (write === 'garbage') writeFileSync(path.join(run, 'state.json'), '{', 'utf8');
    assert.equal(storedWorktree(run), false);
    assert.notEqual(sameRepositoryRefusal(dir, { self: null, worktree: true, probe: running }), null);
  }
});

test('every conflicting run is named in one sentence', () => {
  const dir = repo();
  sibling(dir, 'first');
  sibling(dir, 'second');
  const why = sameRepositoryRefusal(dir, { self: null, worktree: false, probe: running });
  assert.ok(why !== null);
  assert.match(why, /first/);
  assert.match(why, /second/);
});

test('a live run in a different repository is no business of this one', () => {
  const other = repo();
  sibling(other, 'elsewhere');
  assert.equal(sameRepositoryRefusal(repo(), { self: null, worktree: false, probe: running }), null);
});

test('a linked entry is skipped and nothing is read through it', (t) => {
  const dir = repo();
  const outside = repo();
  const target = sibling(outside, 'target');
  mkdirSync(path.join(dir, RUNS_DIR), { recursive: true });
  if (!tryLink(target, path.join(dir, RUNS_DIR, 'linked'), 'junction')) {
    t.skip('this platform refuses to create directory links');
    return;
  }
  let probed = false;
  const why = sameRepositoryRefusal(dir, {
    self: null,
    worktree: false,
    probe: () => {
      probed = true;
      return 'running';
    },
  });
  assert.equal(why, null);
  assert.equal(probed, false, 'the lock behind the link was never read');
});

test('no runs directory at all is no refusal', () => {
  assert.equal(sameRepositoryRefusal(repo(), { self: null, worktree: false, probe: running }), null);
});

test('a runs directory that cannot be read refuses, naming it', () => {
  const dir = repo();
  mkdirSync(path.join(dir, '.vibe'), { recursive: true });
  // A file where the directory should be: readdir throws ENOTDIR, which is
  // "could not read", not "absent".
  writeFileSync(path.join(dir, RUNS_DIR), 'not a directory', 'utf8');
  const why = sameRepositoryRefusal(dir, { self: null, worktree: true, probe: running });
  assert.ok(why !== null);
  assert.ok(why.includes(path.join(dir, RUNS_DIR)), why);
  assert.match(why, /ENOTDIR/);
});

test('an entry lstat could not classify counts, with no worktree, and nothing is probed', () => {
  const never = (): LivenessVerdict => assert.fail('an unclassified entry must not be read');
  for (const linkage of [
    { dir: 'unknown', state: null },
    { dir: 'directory', state: 'unknown' },
  ] as const) {
    const found = entryConflict('odd', '/nowhere/odd', linkage, never, () => true);
    assert.ok(found !== null);
    assert.equal(found.worktree, false);
    assert.match(found.clause, /could not classify/);
  }
  // A measured link is the one entry shape passed over.
  assert.equal(entryConflict('l', '/x', { dir: 'link', state: null }, never, () => false), null);
  assert.equal(entryConflict('s', '/x', { dir: 'directory', state: 'link' }, never, () => false), null);
});

test('a plain file under .vibe/runs is asked of its lock, and an unreadable lock refuses', () => {
  // Not skipped: the lock read through a file fails with ENOTDIR, which
  // `livenessOf` calls `unknown`, and `unknown` counts. Only an absent root and
  // a measured link are passed over.
  const dir = repo();
  mkdirSync(path.join(dir, RUNS_DIR), { recursive: true });
  writeFileSync(path.join(dir, RUNS_DIR, 'stray'), 'not a run', 'utf8');
  const why = sameRepositoryRefusal(dir, { self: null, worktree: true, probe: running });
  assert.ok(why !== null);
  assert.match(why, /stray \(its lock at /);
  assert.ok(why.includes(path.join(dir, RUNS_DIR, 'stray', 'run.lock')), why);
});

// ---- through main -----------------------------------------------------------

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

test('a start beside a live run in this checkout is refused, and allocates nothing', async () => {
  const dir = repo();
  sibling(dir, 'live-run');
  const before = readdirSync(path.join(dir, RUNS_DIR)).sort();
  const { result, said } = await quietly(() => main(['run', 'a second run', '-C', dir]));
  assert.equal(result, EXIT.PREFLIGHT);
  assert.deepEqual(readdirSync(path.join(dir, RUNS_DIR)).sort(), before);
  const failed = said.find((n) => n.id === 'run_failed');
  assert.ok(failed !== undefined, 'the window is told the ending');
  assert.equal(failed.data?.['code'], 6);
  assert.match(String(failed.data?.['reason']), /live-run.*git\.worktree/s);
});

test('a resume beside a live run is refused before its lock is taken', async () => {
  const dir = repo();
  sibling(dir, 'live-run');
  const stopped = sibling(dir, 'stopped-run', { lock: null });
  for (const force of [false, true]) {
    const argv = ['resume', 'stopped-run', '-C', dir, ...(force ? ['--force'] : [])];
    const { result, said } = await quietly(() => main(argv));
    assert.equal(result, EXIT.PREFLIGHT, `force=${String(force)}`);
    assert.equal(existsSync(lockPath(stopped)), false, 'no lock was written');
    assert.ok(said.some((n) => n.id === 'run_failed' && n.data?.['code'] === 6));
  }
});

// ---- the race between the check and the claim --------------------------------

test('two starts that both passed the first check are caught by the second', () => {
  // The interleaving the first check alone cannot see: both looked, found
  // nothing, and both claimed. Each claim writes its lock before its second
  // look, so the second look of each sees the other - whichever order they ran
  // in, at least one refuses, and with both locks down both do.
  const dir = repo();
  const a = allocateRun(dir, 'first');
  const b = allocateRun(dir, 'second');
  const lockA = acquireLock(a.dir, a.id, false);
  const lockB = acquireLock(b.dir, b.id, false);
  assert.ok(lockA.handle !== null && lockB.handle !== null);
  try {
    const seenByA = sameRepositoryRefusal(dir, { self: a.id, worktree: false, probe: running });
    const seenByB = sameRepositoryRefusal(dir, { self: b.id, worktree: false, probe: running });
    assert.ok(seenByA !== null && seenByA.includes(b.id), String(seenByA));
    assert.ok(seenByB !== null && seenByB.includes(a.id), String(seenByB));
  } finally {
    lockA.handle.release();
    lockB.handle.release();
  }
});

test('the start and the resume each look again after taking their own lock', () => {
  // Read as source, because the property is an ordering inside two commands
  // and no fixture can land a sibling's lock between two of their lines.
  const cli = readFileSync(path.join(process.cwd(), 'src', 'cli.ts'), 'utf8');
  for (const [name, self] of [['cmdRun', 'allocated.id'], ['cmdResume', 'id']] as const) {
    const body = cli.slice(cli.indexOf(`async function ${name}(`));
    const end = body.indexOf('\n}\n');
    const fn = body.slice(0, end);
    const lock = fn.indexOf('acquireLock(');
    const again = fn.indexOf(`sameRepositoryRefusal(targetDir, { self: ${self}`, lock);
    assert.ok(lock > -1 && again > lock, `${name} looks again after its lock`);
    const undo = fn.slice(again, fn.indexOf('return EXIT.PREFLIGHT;', again));
    assert.match(undo, /handle\.release\(\);/);
    if (name === 'cmdRun') assert.match(undo, /rmSync\(allocated\.dir/);
  }
});
