import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sweepGateArtifacts } from '@src/artifacts.js';
import { createRun } from '@src/run.js';
import type { RunState } from '@src/types.js';
import { JUNCTION_SKIP, linkDir } from './helpers/links.js';

/**
 * The scratch a killed preservation leaves behind (#111).
 *
 * `recoverInterrupted` and `clearStaging` run only inside
 * `preserveGateArtifacts`, and only for the gate and round it was called for. A
 * run killed mid-preserve that resumes and never fails that gate again keeps its
 * staging tree for ever - and that tree is a copy of what the gate produced, of
 * which the motivating example is a Playwright report, with no ceiling on it by
 * default. The stamp is `state.events.length`, so two kills leave two.
 *
 * Real files and real links: the whole subject is what is on disk.
 */

interface Fixture {
  state: RunState;
  /** `<run>/artifacts/<gate>`, created. */
  gateDir: string;
}

function fixture(gate = 'qa'): Fixture {
  const cwd = mkdtempSync(path.join(tmpdir(), 'vibe-sweep-'));
  const state = createRun(cwd, 'artifact sweep', false);
  const gateDir = path.join(state.dir, 'artifacts', gate);
  mkdirSync(gateDir, { recursive: true });
  return { state, gateDir };
}

/** A directory with a file in it, so a removal is a removal of something. */
function dir(at: string, marker = 'CONTENT'): string {
  mkdirSync(at, { recursive: true });
  writeFileSync(path.join(at, 'index.html'), marker, 'utf8');
  return at;
}

const names = (f: Fixture): string[] => readdirSync(f.gateDir).sort();

// ---- what the sweep removes -------------------------------------------------

test('a staging tree a killed preserve left behind is gone, and the round beside it is not', () => {
  const f = fixture();
  dir(path.join(f.gateDir, 'round-1'), 'THE EVIDENCE');
  dir(path.join(f.gateDir, '.staging-round-1-7'));
  dir(path.join(f.gateDir, '.staging-round-2-9'));

  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(names(f), ['round-1']);
  assert.deepEqual(sweep.kept, []);
  assert.deepEqual(sweep.removed.sort(), [
    'artifacts/qa/.staging-round-1-7',
    'artifacts/qa/.staging-round-2-9',
  ]);
  // Named rather than counted: these are potentially the largest objects in
  // `.vibe/`, and "swept 2 entries" is not something a user can check.
  assert.ok(sweep.removed.every((r) => r.startsWith('artifacts/qa/')));
});

test('a stranded .partial FILE is swept too, not kept for ever', () => {
  // `copyOne` does `cpSync(source, partial)`, so a configured entry that is a
  // single file leaves scratch that is a FILE. `clearStaging` removed only
  // directories, so this shape was never collected by anything.
  const f = fixture();
  writeFileSync(path.join(f.gateDir, '.staging-round-1-7.partial-0'), 'HALF A COPY', 'utf8');

  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(names(f), []);
  assert.deepEqual(sweep.removed, ['artifacts/qa/.staging-round-1-7.partial-0']);
});

test('every gate is swept, not only the one that failed last', () => {
  // The defect exactly: the existing sweeps run for one gate and one round.
  const f = fixture('qa');
  const other = path.join(f.state.dir, 'artifacts', 'typecheck');
  mkdirSync(other, { recursive: true });
  dir(path.join(f.gateDir, '.staging-round-1-3'));
  dir(path.join(other, '.staging-round-5-11'));

  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(sweep.removed.sort(), [
    'artifacts/qa/.staging-round-1-3',
    'artifacts/typecheck/.staging-round-5-11',
  ]);
  assert.deepEqual(readdirSync(other), []);
});

// ---- what it must not remove ------------------------------------------------

test('a superseded backup whose round is missing stays, because it may be the only copy', () => {
  // The ambiguity `recoverInterrupted` already refuses to resolve. With no
  // `round-1` installed beside it, this backup is the evidence.
  const f = fixture();
  dir(path.join(f.gateDir, 'round-1.superseded-4'), 'THE ONLY COPY');

  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(names(f), ['round-1.superseded-4']);
  assert.deepEqual(sweep.removed, []);
  assert.equal(sweep.kept.length, 1);
  assert.match(String(sweep.kept[0]?.why), /may be the only copy/);
});

test('a superseded backup goes once the round it backs up is installed', () => {
  const f = fixture();
  dir(path.join(f.gateDir, 'round-1'), 'THE EVIDENCE');
  dir(path.join(f.gateDir, 'round-1.superseded-4'), 'STALE');

  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(names(f), ['round-1']);
  assert.deepEqual(sweep.removed, ['artifacts/qa/round-1.superseded-4']);
});

test('round-10 is not treated as a backup of round-1', () => {
  const f = fixture();
  dir(path.join(f.gateDir, 'round-1'));
  dir(path.join(f.gateDir, 'round-10'));

  sweepGateArtifacts(f.state);

  assert.deepEqual(names(f), ['round-1', 'round-10']);
});

test('anything the run wrote that is not scratch is left alone', () => {
  const f = fixture();
  dir(path.join(f.gateDir, 'round-1'));
  dir(path.join(f.gateDir, 'round-2'));
  writeFileSync(path.join(f.gateDir, 'notes.txt'), 'a human put this here', 'utf8');

  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(names(f), ['notes.txt', 'round-1', 'round-2']);
  assert.deepEqual(sweep.removed, []);
  assert.deepEqual(sweep.kept, []);
});

test('a staging entry that is a link is refused and named, never followed or removed', (t) => {
  // #53's rule, in the one place a sweep could break it: this runs inside
  // `.vibe/runs`, whose entries cannot be assumed to be what they look like.
  const f = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), 'vibe-sweep-outside-'));
  writeFileSync(path.join(outside, 'SECRET.txt'), 'MUST-SURVIVE', 'utf8');
  if (!linkDir(outside, path.join(f.gateDir, '.staging-round-1-7'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(names(f), ['.staging-round-1-7'], 'the link itself is left in place');
  assert.equal(
    existsSync(path.join(outside, 'SECRET.txt')),
    true,
    'and nothing was deleted through it',
  );
  assert.deepEqual(sweep.removed, []);
  assert.equal(sweep.kept.length, 1);
  assert.match(String(sweep.kept[0]?.why), /is a link, or could not be classified/);
});

test('a gate directory that is a link is refused whole', () => {
  const f = fixture();
  const artifacts = path.join(f.state.dir, 'artifacts');
  writeFileSync(path.join(artifacts, 'not-a-gate'), 'x', 'utf8');

  const sweep = sweepGateArtifacts(f.state);

  assert.deepEqual(sweep.removed, []);
  assert.deepEqual(sweep.kept, [
    { at: 'artifacts/not-a-gate', why: 'is not a plain directory' },
  ]);
});

// ---- and it never gets in the way -------------------------------------------

test('a run with no artifacts at all sweeps nothing and says nothing', () => {
  // Every ordinary run. The record has to stay byte-identical to what it was
  // before this existed.
  const cwd = mkdtempSync(path.join(tmpdir(), 'vibe-sweep-none-'));
  const state = createRun(cwd, 'nothing to sweep', false);

  assert.deepEqual(sweepGateArtifacts(state), { removed: [], kept: [] });
  assert.equal(existsSync(path.join(state.dir, 'artifacts')), false, 'and none is created');
});

test('an artifacts entry that is not a directory stops the sweep without throwing', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'vibe-sweep-file-'));
  const state = createRun(cwd, 'artifacts is a file', false);
  writeFileSync(path.join(state.dir, 'artifacts'), 'not a directory', 'utf8');

  const sweep = sweepGateArtifacts(state);

  assert.deepEqual(sweep.removed, []);
  assert.equal(sweep.kept.length, 1);
  assert.match(String(sweep.kept[0]?.why), /is not a plain directory/);
});
