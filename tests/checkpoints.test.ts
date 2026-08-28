import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import {
  allocateRun,
  claimRunDir,
  listCheckpoints,
  loadRun,
  saveState,
  writeCheckpoint,
} from '@src/run.js';
import { assertUsableRunId, isReportBasename, StoredStateError } from '@src/stored.js';
import {
  agents,
  BLOCKING,
  committing,
  config,
  freshRun,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * The state history a run leaves behind (#78).
 *
 * A run's `state.json` is one mutable file, so nothing recorded what it looked
 * like at any earlier point. These cases pin what the snapshots beside it now
 * say - that there is one per boundary in loop order, that each is a whole state
 * `loadRun` accepts unchanged, that a commit is recorded as a full object id or
 * as an honest absence, and that no failure in any of it can change what the run
 * exits with.
 *
 * The allocator and the report-name allowlist are here too. Both are incidental
 * fixes that shipped with the checkpoints, both are independent of forking, and
 * both are defects in their own right: two runs started in the same second on
 * the same task used to share a directory, and a stored `lastReport` of
 * `state.json` used to render the whole state file into the reviewer's prompt.
 */

const RUN = { prefix: 'vibe-ckpt-', task: 'checkpoints' } as const;

function fullRun(task = 'checkpoints'): RunState {
  return freshRun({ ...RUN, task, planOnly: false, git: true, commit: true });
}

/** A plan, an approving judge, and turns that actually change the tree. */
function cleanPass(state: RunState, over: Handlers = {}): Handlers {
  let round = 0;
  return {
    claude: (label) => {
      // Both planning turns return a plan: `revise-N` is parsed by `parsePlan`
      // exactly as `plan` is, so a string there fails the schema, not the case.
      if (label === 'plan' || label.startsWith('revise')) return planFixture();
      round += 1;
      work(state, `work-${round}.txt`);
      return `did ${label}`;
    },
    ...over,
  };
}

function checkpointFiles(state: RunState): string[] {
  return readdirSync(state.dir)
    .filter((f) => /^checkpoint-\d+\.json$/.test(f))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1]) - Number(/(\d+)/.exec(b)?.[1]));
}

function boundaries(state: RunState): string[] {
  return listCheckpoints(state.dir).map((c) => c.meta?.boundary ?? '(unreadable)');
}

// ---- one per boundary -------------------------------------------------------

test('one per boundary, in order, numbered from 1', async () => {
  const state = fullRun();
  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(cleanPass(state), []),
  );

  const entries = listCheckpoints(state.dir);
  assert.ok(entries.length > 0, 'a completed run leaves checkpoints');
  assert.deepEqual(
    entries.map((c) => c.n),
    entries.map((_c, i) => i + 1),
    'monotonic from 1, with no gaps',
  );
  // The order is the loop's: the plan is approved, the implementation lands,
  // the run completes. A clean pass has no fix rounds, so those are the three.
  assert.deepEqual(boundaries(state), ['plan-approved', 'implemented', 'complete']);
});

test('a plan-only run checkpoints its planning rounds and its completion', async () => {
  const state = freshRun({ ...RUN, task: 'plan only' });
  let critiques = 0;
  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: () => planFixture(),
        // One blocking round, then approval: that is one plan revision, so one
        // `plan-round` checkpoint.
        codex: () => (critiques++ === 0 ? report(BLOCKING) : report([])),
      },
      [],
    ),
  );

  assert.deepEqual(boundaries(state), ['plan-round', 'complete']);
});

test('a verification failure and a review round each leave their own checkpoint', async () => {
  const state = fullRun('rounds');
  let reviews = 0;
  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state, { failures: 1 }) }),
    false,
    agents(
      cleanPass(state, {
        codex: (label) => {
          if (!label.startsWith('review')) return report([]);
          return reviews++ === 0 ? report(BLOCKING) : report([]);
        },
      }),
      [],
    ),
  );

  const seen = boundaries(state);
  assert.ok(seen.includes('verify-round'), `a verify-fix round is a boundary: ${seen.join(', ')}`);
  assert.ok(seen.includes('review-round'), `a review-fix round is a boundary: ${seen.join(', ')}`);
});

// ---- each is a whole state --------------------------------------------------

test('each is a whole state loadRun accepts, with no repair and no normalisation', async () => {
  const state = fullRun('loadable');
  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(cleanPass(state), []),
  );

  // Loaded through `loadRun` itself rather than through the validator alone, so
  // the id assertion, the cross-field pass and the repair recording all run -
  // which is what a fork will do to this file.
  for (const { n, file } of listCheckpoints(state.dir)) {
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as RunState;
    const probe = mkdtempSync(path.join(tmpdir(), 'vibe-ckpt-load-'));
    const dir = path.join(probe, '.vibe', 'runs', state.id);
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(dir)},{recursive:true})`]);
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(snapshot), 'utf8');

    const loaded = loadRun(probe, state.id);
    assert.equal(
      loaded.events.some((e) => e.type === 'state_repaired'),
      false,
      `checkpoint ${n} needed a repair`,
    );
    assert.equal(
      loaded.events.some((e) => e.type === 'state_normalised'),
      false,
      `checkpoint ${n} needed a normalisation`,
    );
    assert.equal(loaded.checkpoint?.n, n, `checkpoint ${n} carries its own metadata`);
  }
});

test('the implemented snapshot starts a clean review', async () => {
  // A run whose PLANNING phase recorded a P1 round. Taken above the resets, the
  // snapshot would carry that planning history into a state whose phase is
  // already `reviewing`, and a fork of it would feed planning rounds to the
  // review convergence assessment.
  const state = fullRun('clean review');
  let critiques = 0;
  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(
      cleanPass(state, {
        codex: (label) => {
          if (label.startsWith('review')) return report([]);
          return critiques++ === 0 ? report(BLOCKING) : report([]);
        },
      }),
      [],
    ),
  );

  const implemented = listCheckpoints(state.dir).find((c) => c.meta?.boundary === 'implemented');
  assert.ok(implemented !== undefined, 'the run reached the implemented boundary');
  const snapshot = JSON.parse(readFileSync(implemented.file, 'utf8')) as RunState;
  assert.deepEqual(snapshot.p1Rounds, []);
  assert.deepEqual(snapshot.verifyRounds, []);
  assert.equal(snapshot.status, 'reviewing');
  assert.equal(snapshot.phase, 'reviewing');
  // The planning history really was there to be leaked.
  assert.ok(state.planRound > 0, 'the planning phase recorded a revision');
});

// ---- the commit -------------------------------------------------------------

test('a committing round records the full sha, and it resolves', async () => {
  const state = fullRun('commits');
  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(cleanPass(state), []),
  );

  const implemented = listCheckpoints(state.dir).find((c) => c.meta?.boundary === 'implemented');
  const meta = implemented?.meta;
  assert.ok(meta !== undefined && meta !== null);
  assert.equal(meta.commitNote, 'committed');
  assert.match(meta.commit ?? '', /^[0-9a-f]{40}$/, 'a full object id, never an abbreviation');
  // It names an object that is actually in this repository, and a commit.
  // `cat-file -t` rather than `-e <sha>^{commit}`: `^` is cmd.exe's escape
  // character, so the revision syntax does not survive the spawn on Windows.
  const type = execFileSync('git', ['cat-file', '-t', meta.commit ?? ''], {
    cwd: state.targetDir,
    encoding: 'utf8',
  }).trim();
  assert.equal(type, 'commit');
});

test('commits disabled is recorded as such, not as a failure', async () => {
  const state = fullRun('no commits');
  await orchestrate(state, config({}, verifying(state)), false, agents(cleanPass(state), []));

  const implemented = listCheckpoints(state.dir).find((c) => c.meta?.boundary === 'implemented');
  assert.equal(implemented?.meta?.commit, null);
  assert.equal(implemented?.meta?.commitNote, 'commits-disabled');
});

test('a round that changed nothing records nothing-to-commit', async () => {
  const state = fullRun('empty round');
  // No `work()` at all, and no verification: every turn writes nothing, and
  // `verifying()` would itself put a script in the tree for the round to commit.
  await orchestrate(
    state,
    config({}, committing()),
    false,
    agents({ claude: (label) => (label === 'plan' ? planFixture() : `did ${label}`) }, []),
  );

  const implemented = listCheckpoints(state.dir).find((c) => c.meta?.boundary === 'implemented');
  assert.equal(implemented?.meta?.commit, null);
  assert.equal(implemented?.meta?.commitNote, 'nothing-to-commit');
});

test('a boundary that never commits says so rather than implying a failure', async () => {
  const state = freshRun({ ...RUN, task: 'plan boundary' });
  await orchestrate(state, config(), false, agents({ claude: () => planFixture() }, []));

  for (const { meta } of listCheckpoints(state.dir)) {
    assert.equal(meta?.commit, null);
    assert.equal(meta?.commitNote, 'no-commit-in-round');
  }
});

// ---- numbering and failure --------------------------------------------------

test('numbering survives a resume, and two writers each keep their snapshot', () => {
  const state = freshRun({ ...RUN, task: 'numbering' });

  const first = writeCheckpoint(state, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  assert.equal(first?.n, 1);

  // A second process on the same directory: a separate in-memory state, exactly
  // as a resume or a `--force` second writer has.
  const second = loadRun(state.targetDir, state.id);
  const b = writeCheckpoint(second, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  const c = writeCheckpoint(state, 'plan-approved', { sha: null, note: 'no-commit-in-round' });
  assert.notEqual(b?.n, c?.n, 'the exclusive reservation gives each writer its own number');

  const entries = listCheckpoints(state.dir);
  assert.equal(entries.length, 3);
  for (const entry of entries) {
    assert.notEqual(entry.meta, null, `checkpoint ${entry.n} is parseable`);
  }
});

test('a checkpoint failure is non-fatal and leaves nothing behind', () => {
  const state = freshRun({ ...RUN, task: 'failure' });
  // A directory that does not exist: the reservation cannot even list it, which
  // is the fail-closed path.
  const broken: RunState = { ...state, dir: path.join(state.dir, 'not-here') };

  const meta = writeCheckpoint(broken, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  assert.equal(meta, null, 'it reports the failure rather than throwing');
  assert.equal(existsSync(broken.dir), false, 'and creates nothing');
});

test('a checkpoint whose event write also fails still cannot escape', () => {
  const state = freshRun({ ...RUN, task: 'double failure' });
  const gone = path.join(state.dir, 'nowhere', 'deeper');
  // Both writes are aimed at a directory that is not there: the checkpoint's,
  // and the `checkpoint_failed` event's, which goes through `saveState` and
  // would otherwise rethrow.
  const broken: RunState = { ...state, dir: gone };
  assert.doesNotThrow(() => writeCheckpoint(broken, 'complete', { sha: null, note: 'no-commit-in-round' }));
});

test('a run whose checkpoints cannot be written still finishes normally', async () => {
  const state = fullRun('unwritable');
  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(cleanPass(state), []),
  );
  // The control: the same run with a working directory finishes the same way.
  assert.equal(state.phase, 'complete');
  assert.equal(state.status, 'done');
});

test('a snapshot that cannot be serialised leaves no zero-byte file behind', () => {
  const state = freshRun({ ...RUN, task: 'unserialisable' });
  const before = checkpointFiles(state).length;
  // A cycle: `JSON.stringify` throws after the name has been reserved, which is
  // the window the unlink covers.
  const cyclic: RunState & { self?: unknown } = { ...state };
  cyclic.self = cyclic;

  const meta = writeCheckpoint(cyclic, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  assert.equal(meta, null);
  assert.deepEqual(
    checkpointFiles(state).length,
    before,
    'the reserved path was unlinked, so no empty checkpoint remains',
  );
  assert.equal(
    readdirSync(state.dir).some((f) => f.includes('checkpoint') && f.endsWith('.tmp')),
    false,
    'and no temp file either',
  );
  // The failure is recorded on the state handed in - which is the cyclic copy,
  // so its own event write fails too, and that is swallowed rather than escaping.
  assert.ok(cyclic.events.some((e) => e.type === 'checkpoint_failed'));
});

test('listCheckpoints never throws over a damaged or zero-byte snapshot', () => {
  const state = freshRun({ ...RUN, task: 'damaged' });
  writeCheckpoint(state, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  writeFileSync(path.join(state.dir, 'checkpoint-2.json'), '', 'utf8');
  writeFileSync(path.join(state.dir, 'checkpoint-3.json'), '{ not json', 'utf8');
  writeFileSync(path.join(state.dir, 'checkpoint-4.json'), JSON.stringify({ checkpoint: 7 }), 'utf8');

  const entries = listCheckpoints(state.dir);
  assert.deepEqual(entries.map((c) => c.n), [1, 2, 3, 4]);
  assert.notEqual(entries[0]?.meta, null);
  assert.equal(entries[1]?.meta, null);
  assert.equal(entries[2]?.meta, null);
  assert.equal(entries[3]?.meta, null);
  assert.deepEqual(listCheckpoints(path.join(state.dir, 'not-a-directory')), []);
});

// ---- the allocator ----------------------------------------------------------

test('claimRunDir refuses a directory that already exists', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-alloc-'));
  const first = claimRunDir(dir, 'run-a');
  assert.notEqual(first, null);
  assert.equal(claimRunDir(dir, 'run-a'), null, 'it cannot adopt what somebody else claimed');
});

/**
 * Both allocator cases below need several ids minted inside one clock second,
 * and neither used to check that they got one.
 *
 * `mintRunId` stamps to second resolution, so a fill that straddles a boundary
 * produces two families of ids rather than n variants of one - and the collision
 * being tested does not exist at all. That is not theory: the nine claims plus
 * the tenth call take ~28ms, and one run in roughly twenty hit the boundary
 * during #85. The tenth allocation minted a fresh id, found it free and returned
 * - which is the allocator behaving correctly - and the case reported it as a
 * missing exception. Reproduced deliberately by spinning across a second between
 * the fill and the tenth call: `20260828-093940-crowded` filled, and the tenth
 * came back `20260828-093941-crowded`.
 *
 * So the precondition is established rather than assumed, and an attempt that
 * straddles is retried rather than judged. Retrying is not a weakened claim: an
 * attempt whose ids are two families never posed the question. Both cases still
 * fail, loudly, if the allocator reuses a taken id - and now they also fail if
 * the question could not be posed at all, rather than passing vacuously.
 *
 * AGENTS.md bans wall-clock fixtures because a hardcoded epoch passes until it
 * doesn't. A fixture that needs several calls to land inside one second is the
 * same hazard wearing a different hat.
 */
const SECOND_ATTEMPTS = 5;

/** Whether `id` is `base` or one of its `-n` variants, i.e. the same stamp. */
function sameFamily(id: string, base: string): boolean {
  return id === base || id.startsWith(`${base}-`);
}

test('two allocations in the same second on the same task do not share a directory', () => {
  for (let attempt = 1; attempt <= SECOND_ATTEMPTS; attempt++) {
    const dir = mkdtempSync(path.join(tmpdir(), 'vibe-alloc-same-'));
    const first = allocateRun(dir, 'same task');
    writeFileSync(path.join(first.dir, 'state.json'), '{"marker":"first"}', 'utf8');

    const second = allocateRun(dir, 'same task');
    assert.notEqual(second.id, first.id, 'the second is suffixed rather than adopting the first');
    assert.equal(
      readFileSync(path.join(first.dir, 'state.json'), 'utf8'),
      '{"marker":"first"}',
      "the first run's state was never touched",
    );

    // "In the same second" is the case, not scenery. On a new stamp the suffix
    // was never exercised and `notEqual` above passes for the wrong reason, so
    // that attempt proves nothing; on the same stamp, name the mechanism.
    if (sameFamily(second.id, first.id)) {
      assert.equal(second.id, `${first.id}-2`, 'suffixed, rather than given a new stamp');
      return;
    }
  }
  assert.fail(`the clock ticked in all ${SECOND_ATTEMPTS} attempts; suffixing was never exercised`);
});

test('a tenth collision refuses rather than reusing a directory', () => {
  for (let attempt = 1; attempt <= SECOND_ATTEMPTS; attempt++) {
    const dir = mkdtempSync(path.join(tmpdir(), 'vibe-alloc-full-'));
    const taken: string[] = [];
    for (let i = 0; i < 9; i++) taken.push(allocateRun(dir, 'crowded').id);
    assert.equal(new Set(taken).size, 9, 'nine distinct directories');

    const base = taken[0] ?? '';
    // Two families: nothing here is full, so the tenth call would be answering
    // a different question. Start over rather than ask it.
    if (!taken.every((id) => sameFamily(id, base))) continue;

    let tenth: { id: string } | undefined;
    try {
      tenth = allocateRun(dir, 'crowded');
    } catch (err) {
      // The claim, unchanged: on a full id the tenth allocation refuses.
      assert.match((err as Error).message, /Nothing was written/);
      return;
    }
    // It did not throw. Allowed only if it was never asked - a tick between the
    // fill and this call hands it a fresh stamp whose variants are all free.
    // Reusing one of the nine is the defect this case exists for.
    assert.equal(
      sameFamily(tenth.id, base),
      false,
      'the tenth allocation reused an id whose nine variants were taken',
    );
  }
  assert.fail(`the clock ticked in all ${SECOND_ATTEMPTS} attempts; the refusal was never exercised`);
});

// ---- reserved names ---------------------------------------------------------

test('isReportBasename accepts exactly the names recordReport writes', () => {
  for (const n of [1, 2, 17]) {
    assert.ok(isReportBasename(`fix-report-${n}.md`));
    assert.ok(isReportBasename(`verify-fix-${n}.md`));
  }
  assert.ok(isReportBasename('implementation-report.md'));
});

test('every recordReport call site writes a name isReportBasename accepts', () => {
  // The drift guard, read off the source rather than restated here: a fifth
  // write site, or a rename of an existing one, must not be able to produce a
  // pointer the reader then drops - which would silently cost the reviewer the
  // report while everything still looked healthy.
  // Walked up rather than hardcoded: these run from `dist/tests`, so `../src`
  // is the emitted JavaScript and the TypeScript this reads is two levels up.
  let at = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(at, 'src', 'orchestrator.ts')) && path.dirname(at) !== at) {
    at = path.dirname(at);
  }
  const source = readFileSync(path.join(at, 'src', 'orchestrator.ts'), 'utf8');
  const sites = [...source.matchAll(/recordReport\(\s*state,\s*(`[^`]+`|'[^']+')/g)].map(
    (m) => m[1] ?? '',
  );
  assert.equal(sites.length, 4, `expected four write sites, found ${sites.length}`);

  for (const expression of sites) {
    // The round is always a counter that has just been incremented, so 1 is the
    // smallest value any of these can hold.
    const name = expression.slice(1, -1).replace(/\$\{[^}]+\}/g, '1');
    assert.ok(isReportBasename(name), `${expression} produces ${name}, which is not a report name`);
  }
});

test('isReportBasename rejects every name vibe would be wrong to follow', () => {
  for (const name of [
    'state.json',
    'STATE.JSON',
    'state.json.',
    'state.json.1234.tmp',
    'run.lock',
    'checkpoint-3.json',
    'PLAN.md',
    'FOLLOW-UPS.md',
    'NEEDS-INPUT.md',
    'IMPLEMENTATION-REPORT.MD',
    'fix-report-.md',
    // Non-canonical round numbers. Both writers interpolate a round that has
    // just been incremented, so neither a zero nor a leading zero is a name any
    // version of this tool has written.
    'fix-report-0.md',
    'fix-report-01.md',
    'verify-fix-0.md',
    'verify-fix-007.md',
    'fix-report-1.md ',
    '../fix-report-1.md',
    '.',
    '..',
    '',
  ]) {
    assert.equal(isReportBasename(name), false, `${JSON.stringify(name)} must be rejected`);
  }
  assert.equal(isReportBasename(7), false);
  assert.equal(isReportBasename(null), false);
});

test('a stored lastReport naming a reserved file is dropped on load', () => {
  const state = freshRun({ ...RUN, task: 'reserved pointer' });
  state.lastReport = 'state.json';
  saveState(state);

  const loaded = loadRun(state.targetDir, state.id);
  assert.equal(loaded.lastReport, undefined, 'never joined onto a path');
  assert.ok(loaded.events.some((e) => e.type === 'state_repaired' && e['field'] === 'lastReport'));
});

test('assertUsableRunId rejects a trailing dot or space', () => {
  const root = path.join('anywhere', '.vibe', 'runs');
  assert.doesNotThrow(() => assertUsableRunId('20260101-000000-fine', root));
  for (const id of ['20260101-000000-fine.', '20260101-000000-fine ']) {
    assert.throws(() => assertUsableRunId(id, root), StoredStateError);
  }
});


test('a checkpoint filename no writer produces is not a fork point', () => {
  // A scanner that accepted more than the writer emits put the listing and the
  // selection out of step: `checkpoint-01.json` listed as fork point 1, while
  // `--at 1` rebuilds `checkpoint-1.json` and finds nothing - and with both
  // present the same number appeared twice.
  const state = freshRun({ ...RUN, task: 'noncanonical' });
  writeCheckpoint(state, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  const canonical = readFileSync(path.join(state.dir, 'checkpoint-1.json'), 'utf8');
  for (const name of ['checkpoint-01.json', 'checkpoint-001.json', 'checkpoint-0.json']) {
    writeFileSync(path.join(state.dir, name), canonical, 'utf8');
  }

  const entries = listCheckpoints(state.dir);
  assert.deepEqual(entries.map((c) => c.n), [1], 'only the canonical name is a checkpoint');
  assert.equal(entries[0]?.file.endsWith('checkpoint-1.json'), true);
});

test('numbering is unaffected by a noncanonical file sitting beside it', () => {
  const state = freshRun({ ...RUN, task: 'noncanonical numbering' });
  writeCheckpoint(state, 'plan-round', { sha: null, note: 'no-commit-in-round' });
  writeFileSync(path.join(state.dir, 'checkpoint-09.json'), '{}', 'utf8');

  // The reservation is an exclusive create, so it cannot land on a name that is
  // taken whatever the scan counted.
  const next = writeCheckpoint(state, 'complete', { sha: null, note: 'no-commit-in-round' });
  assert.equal(next?.n, 2);
  assert.deepEqual(listCheckpoints(state.dir).map((c) => c.n), [1, 2]);
});
