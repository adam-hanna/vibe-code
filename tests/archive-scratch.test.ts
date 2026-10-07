import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findGateScratch, sweepGateArtifacts } from '@src/artifacts.js';
import { main } from '@src/cli.js';
import { lockPath } from '@src/lock.js';
import { createRun, saveState } from '@src/run.js';
import type { RunState } from '@src/types.js';
import { JUNCTION_SKIP, linkDir } from './helpers/links.js';

/**
 * What a run that will never resume again is still holding (#130).
 *
 * #111's sweep runs at the top of every pass of `orchestrate`, so a run that
 * resumes tidies itself. It wrote its own limit into its own comment: a run that
 * never resumes never executes anything, so nothing was ever going to look.
 *
 * **The measurement came first, and it decided the shape.** Across 349 run
 * records in 28 archives on this machine, 20 runs recorded a gate failure - the
 * trigger - and not one had configured any gate `artifacts` paths, so every one
 * of those preservations had nothing to copy. The 0 MB on disk is therefore a
 * fact about configuration and not about accumulation, and no retention rule can
 * be derived from it. So what ships is option 3 of the three the issue offered:
 * `vibe list` says what is there and how much of it, and deletes nothing.
 *
 * The cases below are in two halves. The first is that the reading and the sweep
 * are one definition rather than two - which is the thing that would rot, since
 * they are read and written months apart. The second is that nothing the reader
 * does can destroy work: a superseded round that may be the only copy is never
 * listed as removable, a link is never followed, and a run something else may be
 * writing is described differently rather than hidden.
 */

interface Fixture {
  state: RunState;
  /** `<run>/artifacts/<gate>`, created. */
  gateDir: string;
}

function fixture(gate = 'qa'): Fixture {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'vibe-scratch-'));
  const state = createRun(cwd, 'archive scratch', false);
  const gateDir = path.join(state.dir, 'artifacts', gate);
  mkdirSync(gateDir, { recursive: true });
  return { state, gateDir };
}

/** A directory holding one file of known size. */
function dir(at: string, marker = 'CONTENT'): string {
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, 'index.html'), marker, 'utf8');
  return at;
}

const at = (e: { at: string }): string => e.at;

// ---- one definition, not two ------------------------------------------------

test('a run holding nothing reports nothing, and zero bytes is a real zero', () => {
  const f = fixture();

  const found = findGateScratch(f.state.dir);

  assert.deepEqual(found.entries, []);
  assert.deepEqual(found.unresolved, []);
  // Zero rather than null: the walk finished and counted nothing, which is a
  // measurement. Null is reserved for a count that could not be taken.
  assert.equal(found.bytes, 0);
  assert.equal(found.files, 0);
});

test('a run with no artifacts directory at all is not an error', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'vibe-scratch-none-'));
  const state = createRun(cwd, 'no artifacts', false);

  const found = findGateScratch(state.dir);

  assert.deepEqual(found.entries, []);
  assert.deepEqual(found.unresolved, []);
});

test('the reader names exactly what the sweep removes', () => {
  // The claim that stops the two drifting. `walkScratch` is the one walk; this
  // is what would fail on the commit that gave either of them its own copy.
  const f = fixture();
  dir(path.join(f.gateDir, 'round-1'), 'THE EVIDENCE');
  dir(path.join(f.gateDir, '.staging-round-1-7'));
  dir(path.join(f.gateDir, '.staging-round-2-9'));
  writeFileSync(path.join(f.gateDir, '.staging-round-1-7.partial-0'), 'HALF A COPY', 'utf8');
  dir(path.join(f.gateDir, 'round-1.superseded-4'), 'STALE');

  const found = findGateScratch(f.state.dir);
  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(found.entries.map(at).sort(), sweep.removed.slice().sort());
  assert.deepEqual(found.unresolved, sweep.kept);
  // And the round itself is not scratch, on either reading.
  assert.ok(existsSync(path.join(f.gateDir, 'round-1')));
});

test('the reader names what the sweep keeps, with the same reason', () => {
  const f = fixture();
  // No `round-2` beside it, so this may be the only copy of that evidence and
  // nothing may remove it - the rule `recoverInterrupted` applies.
  dir(path.join(f.gateDir, 'round-2.superseded-4'), 'THE ONLY COPY');

  const found = findGateScratch(f.state.dir);
  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(found.entries, [], 'never listed as removable');
  assert.deepEqual(found.unresolved, sweep.kept);
  assert.equal(found.unresolved.length, 1);
  assert.match(found.unresolved[0]?.why ?? '', /may be the only copy/);
  assert.ok(existsSync(path.join(f.gateDir, 'round-2.superseded-4')), 'and it is still there');
});

// ---- what it measures -------------------------------------------------------

test('the size is the bytes on disk, counted rather than estimated', () => {
  const f = fixture();
  const staging = path.join(f.gateDir, '.staging-round-1-7');
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, 'a.txt'), 'AAAA', 'utf8');
  writeFileSync(path.join(staging, 'b.txt'), 'BB', 'utf8');
  writeFileSync(path.join(f.gateDir, '.staging-round-1-7.partial-0'), 'CCC', 'utf8');

  const found = findGateScratch(f.state.dir);

  assert.equal(found.files, 3);
  // Read back off the filesystem rather than restated, so the case cannot agree
  // with the code by both being wrong about a trailing newline.
  const onDisk =
    statSync(path.join(staging, 'a.txt')).size +
    statSync(path.join(staging, 'b.txt')).size +
    statSync(path.join(f.gateDir, '.staging-round-1-7.partial-0')).size;
  assert.equal(found.bytes, onDisk);
});

test('reading removes nothing at all', () => {
  // The property that makes this safe to run over runs this process does not
  // own, and it is asserted rather than left to the absence of an `rm` call.
  const f = fixture();
  dir(path.join(f.gateDir, '.staging-round-1-7'));
  dir(path.join(f.gateDir, 'round-1'), 'THE EVIDENCE');
  const before = readdirSync(f.gateDir).sort();

  findGateScratch(f.state.dir);
  findGateScratch(f.state.dir);

  assert.deepEqual(readdirSync(f.gateDir).sort(), before);
});

test('a scratch-named link is reported and never followed', (t) => {
  const f = fixture();
  const outside = mkdtempSync(path.join(os.tmpdir(), 'vibe-scratch-outside-'));
  writeFileSync(path.join(outside, 'SECRET.txt'), 'BYTES FROM OUTSIDE', 'utf8');
  if (!linkDir(outside, path.join(f.gateDir, '.staging-round-1-7'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  const found = findGateScratch(f.state.dir);

  assert.deepEqual(found.entries, [], 'nothing to remove, so nothing named as removable');
  assert.equal(found.unresolved.length, 1);
  assert.match(found.unresolved[0]?.why ?? '', /is a link, or could not be classified/);
  // The bytes on the far side are not counted into the total either - counting
  // them would be walking through the link, one step short of following it.
  assert.equal(found.bytes, 0);
  assert.ok(existsSync(path.join(outside, 'SECRET.txt')), 'and the target is untouched');
});

test('a gate directory that is not a directory is named, not skipped', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'vibe-scratch-odd-'));
  const state = createRun(cwd, 'odd gate', false);
  mkdirSync(path.join(state.dir, 'artifacts'), { recursive: true });
  writeFileSync(path.join(state.dir, 'artifacts', 'qa'), 'not a directory', 'utf8');

  const found = findGateScratch(state.dir);

  assert.deepEqual(found.unresolved.map(at), ['artifacts/qa']);
});

// ---- what `vibe list` says --------------------------------------------------

function captured(work: () => void): string {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    work();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join('\n');
}

test('vibe list says what is there, how much of it, and that nothing will take it', async () => {
  const f = fixture();
  saveState(f.state);
  const staging = path.join(f.gateDir, '.staging-round-1-7');
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, 'report.html'), 'x'.repeat(4096), 'utf8');

  const said = captured(() => {
    void main(['list', '-C', f.state.targetDir]);
  });

  assert.match(said, /leftover gate scratch/);
  assert.match(said, /artifacts\/qa\/\.staging-round-1-7/, 'named, so it can be acted on');
  assert.match(said, /KB|MB|B/, 'and sized');
  assert.match(said, /nothing will remove these unless the run is resumed/);
});

test('vibe list says nothing extra about an archive that is holding nothing', async () => {
  const f = fixture();
  saveState(f.state);

  const said = captured(() => {
    void main(['list', '-C', f.state.targetDir]);
  });

  // A healthy archive prints exactly what it printed before this issue.
  assert.equal(said.includes('leftover gate scratch'), false);
  assert.match(said, new RegExp(f.state.id));
});

test('scratch under a run something may still be writing is described, not called leftover', async () => {
  const f = fixture();
  saveState(f.state);
  dir(path.join(f.gateDir, '.staging-round-1-7'));
  // A live lock: this process, which `livenessOf` will report as `running`.
  writeFileSync(
    lockPath(f.state.dir),
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      id: f.state.id,
      token: 'held',
    }),
    'utf8',
  );

  const said = captured(() => {
    void main(['list', '-C', f.state.targetDir]);
  });

  // #77's probe refuses to guess, and so does this: a run that is claimed may be
  // mid-preservation, and telling a user to delete that would destroy the copy
  // being made.
  assert.match(said, /something may still be writing them/);
  assert.equal(said.includes('nothing will remove these'), false);
});
