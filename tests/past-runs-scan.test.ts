import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listRuns, selectRunIds } from '@src/run.js';
import type { StatePresence } from '@src/run.js';

/**
 * What the archive scan costs, and the seam that lets it be counted (#85).
 *
 * `past-runs-index.test.ts` pins what the index *shows* - ordering, exclusion,
 * limits, unreadable rows, rendering - and none of that moves here. This file
 * pins the other half: how many entries are examined to produce those rows.
 * Before #85 it was every entry in `.vibe/runs/`, always; now it is bounded by
 * the rows returned.
 *
 * **Why the probe is a parameter.** `statSync` is a static ESM binding inside
 * `src/run.ts` and cannot be intercepted from a test without `mock.module`,
 * which is experimental and only exists from node 22.3 while `engines` here is
 * `>=20` - and nothing in tests/ mocks a module. So `selectRunIds` takes the
 * presence probe as an argument, `listRuns` passes the real `statePresence`,
 * and these cases pass a counting stub. Exporting an internal for its test is
 * what `assessConvergence` and friends already do in this file's subject.
 */

/** A probe that records every id it is asked about. */
function counting(classify: (id: string) => StatePresence): {
  probe: (id: string) => StatePresence;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    probe: (id) => {
      seen.push(id);
      return classify(id);
    },
  };
}

/** `n` ids that sort in creation order: `run-0000`, `run-0001`, ... */
function ids(n: number, prefix = 'run'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`);
}

test('a limited call examines the rows it returns, not the archive', () => {
  const entries = ids(2000);
  const { probe, seen } = counting(() => 'present');

  const selected = selectRunIds(entries, { limit: 10 }, probe);

  // The whole of #85: 2000 entries, 10 rows, 10 stats.
  assert.equal(seen.length, 10);
  assert.deepEqual(selected, entries.slice(-10).reverse());
});

test('the pathological archive costs less than the sweep it replaced, not more', () => {
  // 1000 allocated-but-uninitialised directories sorting *newer* than 100 real
  // runs - the shape the reordering could in principle have made worse. It does
  // not: the walk still has to pass the 1000, but it stops after ten survivors
  // instead of stat-ing the 100 behind them too.
  const real = ids(100, 'a-real');
  const empty = ids(1000, 'z-empty');
  const { probe, seen } = counting((id) => (id.startsWith('z-empty') ? 'absent' : 'present'));

  const selected = selectRunIds([...real, ...empty], { limit: 10 }, probe);

  assert.deepEqual(selected, real.slice(-10).reverse());
  assert.equal(seen.length, 1010);
  // The durable claim beside the exact number: never worse than the 1100 the
  // pre-#85 filter chain would have done.
  assert.ok(seen.length <= 1100, `${seen.length} examinations exceeds the old chain's 1100`);
});

test('an unlimited call still examines everything, because there is nothing to stop at', () => {
  // `vibe list` passes no limit and shows every run by design. #85 does not
  // change that and it is not a regression.
  const entries = ids(200);
  const { probe, seen } = counting((id) => (id.endsWith('7') ? 'absent' : 'present'));

  const selected = selectRunIds(entries, {}, probe);

  assert.equal(seen.length, entries.length);
  assert.deepEqual(
    selected,
    entries.filter((d) => !d.endsWith('7')).reverse(),
  );
});

test('the excluded run is skipped without a stat and without costing a slot', () => {
  // Named so it sorts newest: it would take a slot if the exclusion happened
  // after the limit, and it would cost a stat if it happened after the probe.
  const entries = [...ids(12), 'zzz-current'];
  const { probe, seen } = counting(() => 'present');

  const selected = selectRunIds(entries, { exclude: 'zzz-current', limit: 10 }, probe);

  assert.equal(selected.length, 10);
  assert.equal(selected.includes('zzz-current'), false);
  assert.equal(seen.includes('zzz-current'), false);
  assert.equal(seen.length, 10);
});

test('an unreadable run keeps its row and its slot: only absent drops one', () => {
  // The #77/#78 tri-state. `unknown` is "this exists and may not be read",
  // which is a row in the listing - dropping it is how an inaccessible run
  // disappears entirely.
  const entries = ['run-a', 'run-b', 'run-c'];
  const { probe } = counting((id) => (id === 'run-b' ? 'unknown' : 'present'));

  assert.deepEqual(selectRunIds(entries, {}, probe), ['run-c', 'run-b', 'run-a']);
  // And it counts toward the limit exactly as a present one does.
  const second = counting((id) => (id === 'run-b' ? 'unknown' : 'present'));
  assert.deepEqual(selectRunIds(entries, { limit: 2 }, second.probe), ['run-c', 'run-b']);
  assert.equal(second.seen.length, 2);
});

test('degenerate limits list nothing and examine nothing, and a fractional one truncates', () => {
  const entries = ids(6);

  for (const limit of [0, -3]) {
    const { probe, seen } = counting(() => 'present');
    assert.deepEqual(selectRunIds(entries, { limit }, probe), [], `limit ${limit}`);
    // Not merely empty - a limit that lists nothing must cost nothing.
    assert.equal(seen.length, 0, `limit ${limit} examined ${seen.length} entries`);
  }

  // `slice(0, 2.5)` returned two, so this does too.
  const { probe, seen } = counting(() => 'present');
  assert.deepEqual(selectRunIds(entries, { limit: 2.5 }, probe), ['run-0005', 'run-0004']);
  assert.equal(seen.length, 2);

  // `slice(0, NaN)` returned nothing, so this does too.
  const nan = counting(() => 'present');
  assert.deepEqual(selectRunIds(entries, { limit: Number.NaN }, nan.probe), []);
  assert.equal(nan.seen.length, 0);
});

test('the rows are what the pre-#85 filter chain returned, for every limit and exclusion', () => {
  // The identity the reorder rests on, enumerated rather than argued. Fixed
  // classification and fixed combinations: no randomness, so a failure here is
  // reproducible. The probe is pure for this case - the claim under test is
  // about rows, and a counting stub would put its side effects in the way.
  const entries = ids(200);
  const presence = new Map<string, StatePresence>(
    entries.map((id, i) => [id, i % 7 === 3 ? 'absent' : i % 7 === 5 ? 'unknown' : 'present']),
  );
  const probe = (id: string): StatePresence => presence.get(id) ?? 'absent';

  // An exclusion that sorts newest, and one that does not exist at all.
  const excludes = [undefined, 'run-0199', 'not-a-run'];
  const limits = [undefined, 0, -3, 1, 5, 10, 199, 500];

  for (const exclude of excludes) {
    for (const limit of limits) {
      const opts = { exclude, limit };

      const reference = entries
        .filter((d) => probe(d) !== 'absent')
        .filter((d) => d !== opts.exclude)
        .sort()
        .reverse();
      const expected = limit === undefined ? reference : reference.slice(0, Math.max(0, limit));

      assert.deepEqual(
        selectRunIds(entries, opts, probe),
        expected,
        `exclude ${String(exclude)}, limit ${String(limit)}`,
      );
    }
  }
});

// ---- the wiring, against a real archive ------------------------------------

const RUNS = path.join('.vibe', 'runs');

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-past-runs-scan-'));
}

function plant(targetDir: string, id: string, text: string): void {
  const dir = path.join(targetDir, RUNS, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), text, 'utf8');
}

test('listRuns over a real archive of empty and real directories lists the newest real runs', () => {
  // The stub cases cannot see the wiring in `listRuns` itself: that the probe it
  // passes joins the right path, and that the ids it selects are the ones read.
  const targetDir = tempDir();
  for (const id of ids(30, 'a-run')) {
    plant(targetDir, id, JSON.stringify({ id, status: 'done', task: `task ${id}`, costUsd: 0 }));
  }
  // Sorting newest, and never a run: `allocateRun` mkdirs before `createRun`
  // saves state, and a process killed in between leaves exactly this.
  for (const id of ids(20, 'z-empty')) mkdirSync(path.join(targetDir, RUNS, id), { recursive: true });

  const runs = listRuns(targetDir, { limit: 5 });

  assert.deepEqual(
    runs.map((r) => r.id),
    ['a-run-0029', 'a-run-0028', 'a-run-0027', 'a-run-0026', 'a-run-0025'],
  );
  for (const run of runs) {
    assert.equal(run.status, 'done');
    assert.equal(run.task, `task ${run.id}`);
    // Outside the parse and still filled in, exactly as before (#77).
    assert.equal(run.liveness, 'not-running');
  }
});
