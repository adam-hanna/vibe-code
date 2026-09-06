import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { changeSet } from '@src/git.js';
import {
  formatWork,
  measureWork,
  planCoverage,
  planNamedFiles,
  withWorkProgress,
  workData,
} from '@src/work.js';
import type { WorkProgress } from '@src/work.js';
import type { Meta } from '@src/log.js';
import { DEFAULTS } from '@src/config.js';
import { orchestrate } from '@src/orchestrator.js';
import { agents, config, freshRun, planFixture, report, work } from './helpers/loop-harness.js';
import type { Plan, RunEvent, RunState } from '@src/types.js';

/**
 * How far through an implement turn is, answered only from measurements (#136).
 *
 * The wireframes draw `claude · step 9/14` with a 61% bar. That readout does
 * not exist, cannot be derived, and is not invented here - so what these cases
 * pin is mostly the *shape of the honesty*: what is counted, what is reported
 * as uncounted, and what is left out entirely rather than being given a zero.
 */

// ---- the plan's own names --------------------------------------------------

test('a backticked path in the plan is a name; a command is not', () => {
  const named = planNamedFiles(
    [
      'Touch `src/orchestrator.ts` and `src/work.ts`.',
      'Run `npm run typecheck` and then `npm test`.',
      'Bump to `1.4.0`, which the `Config` type does not care about.',
      'See `README.md` and <https://example.invalid/x>, and pass `--gate implemented=stop`.',
      'A bare `tsc` is not a file either.',
    ].join('\n'),
  );

  assert.deepEqual(named.sort(), ['README.md', 'src/orchestrator.ts', 'src/work.ts']);
});

test('the same file named twice is one file', () => {
  // The denominator is "files the plan names", and a plan that mentions
  // `src/git.ts` in three sections has not named three files.
  assert.deepEqual(planNamedFiles('`src/git.ts` and `./src/git.ts` and `src\\git.ts`'), [
    'src/git.ts',
  ]);
});

test('a plan that names no files gets no proxy, rather than nought of nought', () => {
  // Absence, not zero. `0 of 0 files` would be a proxy over an empty set drawn
  // as a measurement of progress, which is the failure this whole issue is
  // about avoiding in a more obvious place.
  assert.equal(planCoverage([], ['src/git.ts']), null);
  assert.equal(planNamedFiles('A plan with no paths in it at all.').length, 0);
});

test('a plan path and git\'s path count as one file when either contains the other', () => {
  // A plan is entitled to write `app/src/pilot/tools.ts` where the run is
  // rooted at `app/` and git says `src/pilot/tools.ts`. Plain equality scores
  // that as untouched while the file is being edited.
  assert.deepEqual(planCoverage(['app/src/pilot/tools.ts'], ['src/pilot/tools.ts']), {
    named: 1,
    touched: 1,
  });
  assert.deepEqual(planCoverage(['src/git.ts'], ['packages/core/src/git.ts']), {
    named: 1,
    touched: 1,
  });
  // And a different file is still a different file.
  assert.deepEqual(planCoverage(['src/git.ts'], ['src/legit.ts']), { named: 1, touched: 0 });
});

test('every named file is counted once however many times it was changed', () => {
  assert.deepEqual(planCoverage(['a.ts', 'b.ts', 'c.ts'], ['a.ts', 'a.ts', 'b.ts']), {
    named: 3,
    touched: 2,
  });
});

// ---- what git can be asked -------------------------------------------------

interface Repo {
  dir: string;
  base: string;
  write: (rel: string, body: string | Buffer) => void;
  commitAll: () => string;
}

function repo(): Repo {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-work-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'vibe@example.invalid');
  git('config', 'user.name', 'vibe tests');
  git('config', 'commit.gpgsign', 'false');
  const write = (rel: string, body: string | Buffer): void => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  const commitAll = (): string => {
    git('add', '-A');
    git('commit', '-q', '-m', 'commit');
    return git('rev-parse', 'HEAD');
  };
  write('src/kept.ts', 'one\ntwo\nthree\n');
  const base = commitAll();
  return { dir, base, write, commitAll };
}

test('a modified tracked file is counted in lines and in files', async () => {
  const r = repo();
  r.write('src/kept.ts', 'one\ntwo\nthree\nfour\n');

  const changed = await changeSet(r.dir, r.base);
  assert.ok(changed);
  assert.deepEqual(changed.paths, ['src/kept.ts']);
  assert.equal(changed.insertions, 1);
  assert.equal(changed.deletions, 0);
  assert.equal(changed.added, 0);
  assert.equal(changed.uncounted, 0);
});

test('a new file git has never seen is counted, lines and all', async () => {
  const r = repo();
  r.write('src/fresh.ts', 'a\nb\nc\n');

  // The half `git diff` cannot see. An implement turn's output is mostly new
  // files, and a `+N` that silently omitted them would understate the work by
  // most of it.
  const changed = await changeSet(r.dir, r.base);
  assert.ok(changed);
  assert.deepEqual(changed.paths, ['src/fresh.ts']);
  assert.equal(changed.added, 1);
  assert.equal(changed.insertions, 3);
  assert.equal(changed.uncounted, 0);
});

test('a last line with no newline is still a line', async () => {
  const r = repo();
  r.write('src/fresh.ts', 'a\nb');

  const changed = await changeSet(r.dir, r.base);
  assert.equal(changed?.insertions, 2);
});

test('a new binary file is uncounted, never counted as zero lines', async () => {
  const r = repo();
  r.write('assets/icon.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x03]));

  const changed = await changeSet(r.dir, r.base);
  assert.ok(changed);
  // In the file count, because it changed; out of the line count, because a
  // `+6` about bytes wearing a label about lines is a fabricated number.
  assert.deepEqual(changed.paths, ['assets/icon.bin']);
  assert.equal(changed.uncounted, 1);
  assert.equal(changed.insertions, 0);
});

test('a run with no base and no commits reports files but not lines', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-work-bare-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(path.join(dir, 'new.ts'), 'x\n');

  const changed = await changeSet(dir, null);
  assert.ok(changed);
  // `git diff HEAD` has no HEAD to diff against, so the tracked half was never
  // measured - and the new file's lines are not added onto a null, which would
  // turn "could not be run" into a partial figure that looks like the whole one.
  assert.deepEqual(changed.paths, ['new.ts']);
  assert.equal(changed.insertions, null);
  assert.equal(changed.deletions, null);
});

test('a directory that is not a repository produces no reading at all', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-work-norepo-'));
  writeFileSync(path.join(dir, 'x.ts'), 'x\n');

  // Not an empty reading. An empty path set beside a plan naming fourteen files
  // renders as "0 of the 14 files the plan names", which is a measurement of a
  // tree nobody managed to look at.
  assert.equal(await changeSet(dir, null), null);
});

test('a deleted file is a change, and its lines come off', async () => {
  const r = repo();
  rmSync(path.join(r.dir, 'src/kept.ts'));

  const changed = await changeSet(r.dir, r.base);
  assert.ok(changed);
  assert.deepEqual(changed.paths, ['src/kept.ts']);
  assert.equal(changed.deletions, 3);
  assert.equal(changed.insertions, 0);
});

// ---- the sentence ----------------------------------------------------------

function progress(over: Partial<WorkProgress['changed']> = {}, planned: WorkProgress['planned'] = null): WorkProgress {
  return {
    changed: { paths: [], added: 0, insertions: 0, deletions: 0, uncounted: 0, ...over },
    planned,
  };
}

test('the proxy is worded as files, never as a step or a percentage', () => {
  const line = formatWork(
    progress({ paths: ['a.ts', 'b.ts'], insertions: 412, deletions: 38 }, ),
  );
  assert.ok(line);
  assert.match(line, /2 files changed/);
  assert.match(line, /\+412 -38/);

  const withPlan = formatWork(progress({ paths: ['a.ts'] }, { named: 14, touched: 9 }));
  assert.ok(withPlan);
  // THE assertion of this issue. `9/14` beside a bar reads as a position in the
  // plan's list of steps, and this measurement is not one - it is a count of
  // files. The words are the labelling.
  assert.match(withPlan, /9 of the 14 files the plan names/);
  assert.doesNotMatch(withPlan, /step/i);
  assert.doesNotMatch(withPlan, /%/);
});

test('a segment nobody measured is left out, not printed as zero', () => {
  const line = formatWork(progress({ paths: ['a.ts'], insertions: null, deletions: null }));
  assert.ok(line);
  assert.equal(line, '1 file changed');
  assert.doesNotMatch(line, /\+0/);
});

test('files whose lines were not counted are named, because they are why the total is short', () => {
  const line = formatWork(progress({ paths: ['a.png'], insertions: 0, deletions: 0, uncounted: 1 }));
  assert.match(String(line), /1 file whose lines were not counted/);
});

test('a reading with nothing changed is no line, and is still a record', () => {
  // `implement: +0 -0` is noise wearing the shape of a reading, so there is no
  // line. The zeroes are real measurements though, and they still go out on the
  // record - a cockpit drawing "0 files changed" is telling the truth, and the
  // run's end-of-turn event turns this null into the sentence that means
  // something: the turn changed nothing.
  assert.equal(formatWork(progress()), null);
  assert.equal(workData(progress())['files'], 0);
  assert.equal(workData(progress())['insertions'], 0);
});

test('the record omits what the sentence omits', () => {
  const data = workData(progress({ paths: ['a.ts'], insertions: null, deletions: null }));
  assert.equal(data['files'], 1);
  // Counted zeroes are facts and are sent; unmeasured fields are absent, so a
  // cockpit can tell "nothing changed yet" from "nobody could say".
  assert.equal(data['added'], 0);
  assert.equal('insertions' in data, false);
  assert.equal('deletions' in data, false);
  assert.equal('planNamed' in data, false);

  const withPlan = workData(progress({ paths: ['a.ts'] }, { named: 14, touched: 9 }));
  assert.equal(withPlan['planNamed'], 14);
  assert.equal(withPlan['planTouched'], 9);
});

// ---- the sampler -----------------------------------------------------------

function planFor(md: string): Plan {
  return { plan_md: md, assumptions: [], open_questions: [] };
}

test('a long turn is sampled underneath it, and the samples carry a record', async () => {
  const r = repo();
  const lines: { line: string; meta?: Meta }[] = [];

  await withWorkProgress(
    {
      cwd: r.dir,
      baseSha: r.base,
      plan: planFor('Change `src/kept.ts` and add `src/fresh.ts`.'),
      label: 'implement',
      intervalMs: 15,
      emit: (line, meta) => void lines.push({ line, ...(meta === undefined ? {} : { meta }) }),
    },
    async () => {
      r.write('src/fresh.ts', 'a\nb\n');
      // Waits for the property rather than for a duration. A sample is three
      // `git` child processes, and under the full suite they routinely take
      // longer than any fixed sleep worth writing - at which point the sampler's
      // own rule drops them, because a reading that lands after the turn ended
      // describes a tree the turn has stopped changing. Sleeping longer would
      // make this pass by being slow; waiting on the line makes it pass by being
      // right, and the deadline is a bound on failure rather than a fixture.
      const deadline = Date.now() + 20_000;
      while (lines.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return 'done';
    },
  );

  assert.ok(lines.length > 0, 'the turn was sampled at least once');
  const last = lines[lines.length - 1];
  assert.match(String(last?.line), /^implement: /);
  assert.equal(last?.meta?.id, 'work_progress');
  // One call builds both, exactly as the heartbeat does, so the sentence and
  // the record cannot drift.
  assert.equal(last?.meta?.data?.['files'], 1);
  assert.equal(last?.meta?.data?.['planNamed'], 2);
  assert.equal(last?.meta?.data?.['planTouched'], 1);
});

test('the reading handed over at the end describes the tree the turn left', async () => {
  const r = repo();
  const readings: WorkProgress[] = [];

  await withWorkProgress(
    {
      cwd: r.dir,
      baseSha: r.base,
      plan: null,
      label: 'implement',
      // Far longer than the turn, so no sample fires: the final reading is
      // taken outside the sampler and does not depend on one having.
      intervalMs: 600_000,
      emit: () => undefined,
      onReading: (work) => void readings.push(work),
    },
    () => {
      r.write('src/late.ts', 'x\n');
      return Promise.resolve('done');
    },
  );

  assert.equal(readings.length, 1);
  assert.deepEqual(readings[0]?.changed.paths, ['src/late.ts']);
});

test('a turn that failed still says what it left behind', async () => {
  const r = repo();
  const readings: WorkProgress[] = [];

  // The work is not undone by the failure, and a resume is about to be handed
  // this tree. What a killed or failed write turn left is exactly the fact the
  // recovery work in v1.3 exists to preserve.
  await assert.rejects(() =>
    withWorkProgress(
      {
        cwd: r.dir,
        baseSha: r.base,
        plan: null,
        label: 'implement',
        intervalMs: 600_000,
        emit: () => undefined,
        onReading: (work) => void readings.push(work),
      },
      () => {
        r.write('src/half-done.ts', 'x\n');
        return Promise.reject(new Error('the turn blew up'));
      },
    ),
  );

  assert.deepEqual(readings[0]?.changed.paths, ['src/half-done.ts']);
});

test('a sampler that cannot read the tree costs the turn nothing', async () => {
  const gone = path.join(tmpdir(), 'vibe-work-absent-directory');
  const result = await withWorkProgress(
    {
      cwd: gone,
      baseSha: null,
      plan: null,
      label: 'implement',
      intervalMs: 15,
      emit: () => {
        throw new Error('a broken sink must not take down a run either');
      },
      onReading: () => {
        throw new Error('nor must a broken recorder');
      },
    },
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return 'the turn still finished';
    },
  );

  assert.equal(result, 'the turn still finished');
});

test('measureWork returns nothing where there is nothing to measure', async () => {
  const gone = path.join(tmpdir(), 'vibe-work-absent-directory-2');
  assert.equal(await measureWork(gone, null, planFor('`src/x.ts`')), null);
});

// ---- through the loop ------------------------------------------------------

/** The `work_measured` rows the run recorded, in order. */
function measured(state: RunState): RunEvent[] {
  return state.events.filter((event) => event.type === 'work_measured');
}

test('the implement turn records what it left in the tree', async () => {
  const state = freshRun({ planOnly: false, git: true, commit: true });
  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: (label) =>
          label === 'plan' || label.startsWith('revise-')
            ? planFixture({ plan_md: 'Add `work.txt`, and leave `never-touched.ts` alone.' })
            : work(state, 'work.txt'),
        codex: () => report([]),
      },
      [],
    ),
  );

  const rows = measured(state);
  assert.equal(rows.length, 1, 'one per write turn, and this run had one');
  assert.equal(rows[0]?.['label'], 'implement');
  assert.equal(rows[0]?.['files'], 1);
  // The proxy, over the plan of record's own text: two files named, one of them
  // touched. It is a statement about files and it says so.
  assert.equal(rows[0]?.['planNamed'], 2);
  assert.equal(rows[0]?.['planTouched'], 1);
});

test('a write turn that changed nothing says so, in those words', async () => {
  const state = freshRun({ planOnly: false, git: true, commit: true });
  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        // Never calls `work()`, so the tree is untouched by the turn the run
        // just paid for. This is the reading most worth having and the one a
        // "report only what there is to report" rule would have dropped.
        claude: (label) =>
          label === 'plan' || label.startsWith('revise-') ? planFixture() : 'I did nothing.',
        codex: () => report([]),
      },
      [],
    ),
  );

  const rows = measured(state);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.['files'], 0);
  assert.equal(rows[0]?.['insertions'], 0);
});

test('a run with progress off spawns no git for this and records nothing', async () => {
  const state = freshRun({ planOnly: false, git: true, commit: true });
  // Keyed on the call's ordinal rather than on its label, because with progress
  // off there IS no label: the harness reads it from `options.progress`, which
  // is the same absence this case is about. The Claude turns of a clean run are
  // the planner then the implementer, in that order.
  let claudeCalls = 0;
  await orchestrate(
    state,
    config({}, { progress: { ...DEFAULTS.progress, enabled: false } }),
    false,
    agents(
      {
        claude: () => {
          claudeCalls += 1;
          return claudeCalls === 1 ? planFixture() : work(state, 'work.txt');
        },
        codex: () => report([]),
      },
      [],
    ),
  );

  // `writeTurn` calls `runTurn` straight through when progress is off, so a run
  // with the heartbeat disabled behaves exactly as it did before this existed.
  assert.deepEqual(measured(state), []);
});
