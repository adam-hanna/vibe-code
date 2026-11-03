import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reportJudgeEditedAfterReview } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import * as git from '@src/git.js';
import { editedAfterReview, hadVerdict, judgeTracked } from '@src/judge.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import { loadRun, saveState } from '@src/run.js';
import type { Config, FileChange, Finding, JudgeFile, RunState, TestChanges } from '@src/types.js';
import {
  agents,
  BLOCKING,
  commits,
  committing,
  config,
  findingFixture,
  p1,
  report,
  reviewingRun,
  verifying,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * Changes to the run's own judge made after the last review are named (#485).
 *
 * The final fix is never reviewed again, and neither are the verify fixes
 * after it, so `runFinalFix` snapshots the judge files before its turn and the
 * end of that road compares the tree with it, by content. Agents are injected;
 * git, the gate and `state.json` are real.
 *
 * Every run here starts from a base commit holding `tests/x.test.ts`, then the
 * run's own work committed on top, so `<base>..HEAD` is never empty - which is
 * the case where reading the change list as a commit range would go wrong.
 *
 * A case that asserts the turn sequence sets `loop.confirmFinalFix: false`:
 * the confirmation after the final fix (#489) adds a turn these cases are not
 * about, and `final-fix-confirm.test.ts` pins it.
 */

const TEST = 'tests/x.test.ts';
const BASE_BODY = 'test("x", () => { expect(1).toBe(1); });\n';

const UNCHECKED =
  "Edits to the run's own tests or config after the last review could not be checked for this run.";

function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(state: RunState, name: string, body: string): void {
  const file = path.join(state.targetDir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
}

/**
 * A run parked at review: a base commit with `tests/x.test.ts`, then the run's
 * own work - a source file plus whatever `work` writes - committed after it.
 */
function judgeRun(prefix: string, work: (state: RunState) => void = () => undefined): RunState {
  const state = reviewingRun({ prefix, task: 'judge after review', change: false });
  const dir = state.targetDir;
  write(state, TEST, BASE_BODY);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  state.baseSha = sh(dir, 'rev-parse', 'HEAD');
  write(state, 'src/impl.ts', 'export const impl = 1;\n');
  work(state);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'the run so far');
  return state;
}

/** A reviewer that returns one P1 on its first review and fails if asked again. */
function oneP1(extra: object = {}): NonNullable<Handlers['codex']> {
  return (label) => {
    if (label === 'review-0') return { ...report([p1('the-one')]), ...extra };
    return assert.fail(`${label}: the final fix round was reviewed again`);
  };
}

interface Driven {
  seen: Narration[];
  calls: string[];
  /** What the end of `vibe run` says, from `reportJudgeEditedAfterReview`. */
  said: string[];
}

async function quietly<T>(seen: Narration[], body: () => Promise<T>): Promise<T> {
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await body();
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
}

function endOfRun(state: RunState): string[] {
  const seen: Narration[] = [];
  log.setSink((n) => void seen.push(n));
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    reportJudgeEditedAfterReview(state);
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return seen.filter((n) => n.level === 'warn').map((n) => n.message);
}

async function drive(state: RunState, cfg: Config, handlers: Handlers): Promise<Driven> {
  const seen: Narration[] = [];
  const calls: string[] = [];
  await quietly(seen, () => orchestrate(state, cfg, true, agents(handlers, calls)));
  return { seen, calls, said: endOfRun(state) };
}

const ids = (seen: readonly Narration[], id: string): Narration[] => seen.filter((n) => n.id === id);

function stored(state: RunState): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
}

const paths = (files: readonly FileChange[] | undefined): string[] => (files ?? []).map((f) => f.path);

// ---- what is listed ---------------------------------------------------------

test('the final fix edits a test the review saw unchanged: listed, narrated once, named at the end', async () => {
  const state = judgeRun('vibe-jar-unchanged-');
  let atFix: TestChanges | undefined;
  const d = await drive(state, config({ confirmFinalFix: false }, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') {
        atFix = structuredClone(state.testChanges);
        write(state, TEST, 'test("x", () => {});\n');
      }
      return 'done';
    },
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  const record = state.judgeEditedAfterReview;
  assert.equal(record?.sinceRound, 1);
  assert.deepEqual(
    record?.files.map((f) => [f.path, f.status]),
    [[TEST, 'modified']],
  );
  assert.equal(record?.restored, undefined);
  assert.deepEqual(stored(state)['judgeEditedAfterReview'], record);

  const said = ids(d.seen, 'judge_edited_after_review');
  assert.equal(said.length, 1);
  assert.equal(said[0]?.level, 'warn');
  assert.deepEqual(said[0]?.data, { sinceRound: 1, count: 1, files: [TEST], restored: [] });

  assert.equal(d.said.length, 1);
  assert.match(d.said[0] ?? '', /After review round 1, the final fix or the verify fixes after it/);
  assert.match(d.said[0] ?? '', /no seat judged the result/);
  assert.ok((d.said[0] ?? '').includes(`\`${TEST}\` (modified)`));

  // testChanges keeps meaning what the last review's diff did.
  assert.deepEqual(state.testChanges, atFix);
  assert.equal(ids(d.seen, 'judge_edited_after_review_unchecked').length, 0);
});

test('the final fix edits a test the review judged: listed, and that verdict was for its earlier content', async () => {
  const state = judgeRun('vibe-jar-judged-', (s) => write(s, TEST, 'test("x", () => { expect(2).toBe(2); });\n'));
  let atFix: TestChanges | undefined;
  const d = await drive(state, config({}, committing()), {
    codex: oneP1({ test_verdicts: [{ file: TEST, justified: true, reason: 'the behaviour moved' }] }),
    claude: (label) => {
      if (label === 'final-fix-1') {
        atFix = structuredClone(state.testChanges);
        write(state, TEST, 'test("x", () => {});\n');
      }
      return 'done';
    },
  });

  assert.deepEqual(paths(state.judgeEditedAfterReview?.files), [TEST]);
  assert.deepEqual(state.testChanges, atFix);
  assert.equal(state.testChanges?.files[0]?.verdict === 'unjudged', false);
  const line = d.said.join('\n');
  assert.ok(line.includes(`\`${TEST}\` was judged at review round 1, and that verdict was for its earlier content.`));
  assert.ok(!line.includes('but no seat judged it then either'));
});

test('a test listed at the review that no seat judged says so, and never that it was judged', async () => {
  const state = judgeRun('vibe-jar-unjudged-', (s) => write(s, TEST, 'test("x", () => { expect(2).toBe(2); });\n'));
  const d = await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') write(state, TEST, 'test("x", () => {});\n');
      return 'done';
    },
  });

  assert.equal(state.testChanges?.files[0]?.verdict, 'unjudged');
  assert.deepEqual(paths(state.judgeEditedAfterReview?.files), [TEST]);
  const line = d.said.join('\n');
  assert.ok(line.includes(`\`${TEST}\` was listed at review round 1 but no seat judged it then either.`));
  assert.ok(!line.includes('was judged at review round'));
});

test('one seat judged it and another did not: the earlier verdict is still named as for earlier content', async () => {
  const state = judgeRun('vibe-jar-seats-', (s) => write(s, TEST, 'test("x", () => { expect(2).toBe(2); });\n'));
  const cfg = config({ confirmFinalFix: false }, { ...committing(), review: { ...DEFAULTS.review, finders: ['codex'] } });
  const d = await drive(state, cfg, {
    codex: (label) => {
      if (label === 'review-0') {
        return { ...report([p1('the-one')]), test_verdicts: [{ file: TEST, justified: true, reason: 'fine' }] };
      }
      if (label === 'review-0-f1') return { ...report([]), test_verdicts: [] };
      return assert.fail(`${label}: the final fix round was reviewed again`);
    },
    claude: (label) => {
      if (label === 'final-fix-1') write(state, TEST, 'test("x", () => {});\n');
      return 'done';
    },
  });

  assert.deepEqual(d.calls, ['review-0', 'review-0-f1', 'final-fix-1']);
  const file = state.testChanges?.files.find((f) => f.path === TEST);
  // The combined record fails closed; the reviewer's own verdict is still there.
  assert.equal(file?.verdict, 'unjudged');
  assert.deepEqual(
    file?.verdicts?.map((v) => (v.verdict === 'unjudged' ? 'unjudged' : v.verdict.justified)),
    [true, 'unjudged'],
  );
  const line = d.said.join('\n');
  assert.ok(line.includes(`\`${TEST}\` was judged at review round 1, and that verdict was for its earlier content.`));
  assert.ok(!line.includes('but no seat judged it then either'));
  // The final content was judged by nobody, and the opening still says so.
  assert.match(line, /no seat judged the result/);
});

test('the final fix adds a test file: listed as added', async () => {
  const state = judgeRun('vibe-jar-added-');
  await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') write(state, 'tests/new.test.ts', 'test("new", () => {});\n');
      return 'done';
    },
  });

  assert.deepEqual(
    state.judgeEditedAfterReview?.files.map((f) => [f.path, f.status]),
    [['tests/new.test.ts', 'added']],
  );
});

test('the final fix deletes a test file the run had added: back to the base, so restored, not a file', async () => {
  const state = judgeRun('vibe-jar-deleted-', (s) => write(s, 'tests/added.test.ts', 'test("added", () => {});\n'));
  const d = await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') rmSync(path.join(state.targetDir, 'tests/added.test.ts'));
      return 'done';
    },
  });

  assert.deepEqual(state.judgeEditedAfterReview?.files, []);
  assert.deepEqual(state.judgeEditedAfterReview?.restored, ['tests/added.test.ts']);
  const line = d.said.join('\n');
  assert.ok(line.includes('`tests/added.test.ts` returned to its base content after review round 1.'));
});

test('the final fix reverts a test the run had modified back to base content: restored, named, not in files', async () => {
  const state = judgeRun('vibe-jar-reverted-', (s) => write(s, TEST, 'test("x", () => { expect(2).toBe(2); });\n'));
  const d = await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') write(state, TEST, BASE_BODY);
      return 'done';
    },
  });

  assert.deepEqual(paths(state.judgeEditedAfterReview?.files), []);
  assert.deepEqual(state.judgeEditedAfterReview?.restored, [TEST]);
  assert.deepEqual(stored(state)['judgeEditedAfterReview'], state.judgeEditedAfterReview);
  const line = d.said.join('\n');
  assert.ok(line.includes(`\`${TEST}\` returned to its base content after review round 1.`));
  assert.ok(!line.includes(`\`${TEST}\` (`), 'not listed as a file with a status');
});

test('a passing review with one P2 to address and no P1 lists a final-fix test edit the same way', async () => {
  const state = judgeRun('vibe-jar-p2-');
  const p2: Finding = findingFixture({ id: 'p2-a', severity: 'P2', title: 'Finding p2-a' });
  const d = await drive(state, config({}, committing()), {
    codex: (label) => {
      if (label === 'review-0') return report([p2]);
      return assert.fail(`${label}: the final fix round was reviewed again`);
    },
    claude: (label) => {
      if (label === 'final-fix-1') write(state, TEST, 'test("x", () => {});\n');
      return 'done';
    },
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  assert.deepEqual(state.finalFixNonBlocking, ['p2-a']);
  assert.deepEqual(state.outstanding, []);
  assert.equal(state.judgeEditedAfterReview?.sinceRound, 1);
  assert.deepEqual(
    state.judgeEditedAfterReview?.files.map((f) => [f.path, f.status]),
    [[TEST, 'modified']],
  );
  assert.equal(ids(d.seen, 'judge_edited_after_review').length, 1);
});

test('a final fix that touches only source files records no list, says nothing new, and prints nothing', async () => {
  const state = judgeRun('vibe-jar-source-');
  const d = await drive(state, config({ confirmFinalFix: false }, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') write(state, 'src/impl.ts', 'export const impl = 2;\n');
      return 'done';
    },
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  assert.ok(state.judgeAtLastReview !== undefined, 'the snapshot was taken');
  assert.equal(state.judgeAtLastReview.round, 1);
  assert.equal(state.judgeEditedAfterReview, undefined);
  assert.equal('judgeEditedAfterReview' in stored(state), false);
  assert.equal(ids(d.seen, 'judge_edited_after_review').length, 0);
  assert.equal(ids(d.seen, 'judge_edited_after_review_unchecked').length, 0);
  assert.deepEqual(d.said, []);
});

test('a verify fix after the final fix that edits vibe.config.json is listed', async () => {
  const state = judgeRun('vibe-jar-verifyfix-');
  // Run 1 is before the review, run 2 after the final fix, run 3 after the verify fix.
  const cfg = config({ confirmFinalFix: false }, { ...committing(), ...verifying(state, { failRuns: [2] }) });
  const d = await drive(state, cfg, {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'verify-fix-1') write(state, 'vibe.config.json', '{"verify":{"enabled":false}}\n');
      return 'done';
    },
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1', 'verify-fix-1']);
  assert.deepEqual(
    state.judgeEditedAfterReview?.files.map((f) => [f.path, f.status]),
    [['vibe.config.json', 'added']],
  );
});

test('with git.commitEachRound off the same edit is still listed: the comparison is by content', async () => {
  const state = judgeRun('vibe-jar-nocommit-');
  const before = commits(state).length;
  await drive(state, config(), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') write(state, TEST, 'test("x", () => {});\n');
      return 'done';
    },
  });

  assert.equal(commits(state).length, before, 'nothing was committed');
  assert.deepEqual(
    state.judgeEditedAfterReview?.files.map((f) => [f.path, f.status]),
    [[TEST, 'modified']],
  );
});

test('a final-fix commit refused after earlier commits landed still lists everything the final fix wrote', async () => {
  const state = judgeRun('vibe-jar-hook-');
  await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') {
        const hook = path.join(state.targetDir, '.git', 'hooks', 'pre-commit');
        mkdirSync(path.dirname(hook), { recursive: true });
        writeFileSync(hook, '#!/bin/sh\nexit 1\n', 'utf8');
        chmodSync(hook, 0o755);
        write(state, 'tests/new.test.ts', 'test("new", () => {});\n');
        write(state, TEST, 'test("x", () => {});\n');
      }
      return 'done';
    },
  });

  assert.equal(commits(state)[0], 'the run so far', 'the final round commit did not land');
  assert.deepEqual(paths(state.judgeEditedAfterReview?.files).sort(), ['tests/new.test.ts', TEST].sort());
});

test('a final fix deleting a test the run had copied before the review is listed, not folded into a rename', async () => {
  // Rename detection at the end would pair the deleted original with the
  // identical copy and hide the deletion.
  const state = judgeRun('vibe-jar-copy-', (s) => write(s, 'tests/copied.test.ts', BASE_BODY));
  await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') rmSync(path.join(state.targetDir, TEST));
      return 'done';
    },
  });

  assert.deepEqual(
    state.judgeEditedAfterReview?.files.map((f) => [f.path, f.status]),
    [[TEST, 'deleted']],
  );
});

test('a rename finished before the review, and left alone after it, records nothing', async () => {
  const state = judgeRun('vibe-jar-moved-', (s) => {
    rmSync(path.join(s.targetDir, TEST));
    write(s, 'tests/moved.test.ts', BASE_BODY);
  });
  const d = await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') write(state, 'src/impl.ts', 'export const impl = 2;\n');
      return 'done';
    },
  });

  assert.ok(state.judgeAtLastReview !== undefined);
  assert.equal(state.judgeEditedAfterReview, undefined);
  assert.deepEqual(d.said, []);
});

test('a judge path that is a symlink cannot be vouched for, so the run says it could not check', async () => {
  // `hash-object` follows the link, so retargeting it to identical bytes would
  // hash the same while git records a different link.
  const state = judgeRun('vibe-jar-link-', (s) => {
    write(s, 'src/one.ts', 'same\n');
    write(s, 'src/two.ts', 'same\n');
    symlinkSync('../src/one.ts', path.join(s.targetDir, 'tests/link.test.ts'));
  });
  const d = await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') {
        rmSync(path.join(state.targetDir, 'tests/link.test.ts'));
        symlinkSync('../src/two.ts', path.join(state.targetDir, 'tests/link.test.ts'));
      }
      return 'done';
    },
  });

  assert.equal(state.judgeEditedAfterReview, undefined);
  assert.equal(state.judgeAtLastReview, undefined);
  assert.equal(ids(d.seen, 'judge_edited_after_review_unchecked').length, 1);
  assert.deepEqual(d.said, [UNCHECKED]);
});

/** A run whose work moved `tests/x.test.ts` out of the test patterns before the review. */
function movedOut(prefix: string): RunState {
  return judgeRun(prefix, (s) => {
    rmSync(path.join(s.targetDir, TEST));
    write(s, 'src/moved.ts', BASE_BODY);
  });
}

test('a test renamed out of the patterns before the review is still tracked through its old path', async () => {
  const state = movedOut('vibe-jar-out-');
  const d = await drive(state, config({}, committing()), {
    codex: oneP1({ test_verdicts: [{ file: 'src/moved.ts', justified: true, reason: 'moved' }] }),
    claude: (label) => {
      // A small edit: git still pairs the rename at the end.
      if (label === 'final-fix-1') write(state, 'src/moved.ts', BASE_BODY + '// one more line\n');
      return 'done';
    },
  });

  // The review judged it through the rename, so the snapshot holds it.
  assert.ok(state.testChanges?.files.some((f) => f.path === 'src/moved.ts' && f.oldPath === TEST));
  assert.ok(state.judgeAtLastReview?.files.some((f) => f.path === 'src/moved.ts'));
  assert.deepEqual(paths(state.judgeEditedAfterReview?.files), ['src/moved.ts']);
  assert.ok(
    d.said.join('\n').includes('`src/moved.ts` was judged at review round 1, and that verdict was for its earlier content.'),
  );
});

test('the same file rewritten until git no longer pairs the rename is still compared', async () => {
  const state = movedOut('vibe-jar-out-far-');
  await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') write(state, 'src/moved.ts', 'export const nothing = "alike";\n');
      return 'done';
    },
  });

  assert.deepEqual(paths(state.judgeEditedAfterReview?.files), ['src/moved.ts']);
});

test('a test renamed out of the patterns before the review and left alone records nothing', async () => {
  const state = movedOut('vibe-jar-out-still-');
  const d = await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') write(state, 'src/impl.ts', 'export const impl = 2;\n');
      return 'done';
    },
  });

  assert.equal(state.judgeEditedAfterReview, undefined);
  assert.deepEqual(d.said, []);
});

test('a rename git pairs differently at the end does not make an unchanged file read as edited', async () => {
  // The base holds the test and an identical source file. Before the review the
  // run moves the test to src/a.ts and adds a near copy at src/b.ts; the final
  // fix only deletes src/unused.ts, and git then pairs unused->a and x->b.
  const state = reviewingRun({ prefix: 'vibe-jar-repair-', task: 'judge after review', change: false });
  const dir = state.targetDir;
  write(state, TEST, BASE_BODY);
  write(state, 'src/unused.ts', BASE_BODY);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  state.baseSha = sh(dir, 'rev-parse', 'HEAD');
  rmSync(path.join(dir, TEST));
  write(state, 'src/a.ts', BASE_BODY);
  write(state, 'src/b.ts', BASE_BODY + '// near copy\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'the run so far');

  const d = await drive(state, config({}, committing()), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') rmSync(path.join(state.targetDir, 'src/unused.ts'));
      return 'done';
    },
  });

  assert.ok(state.judgeAtLastReview !== undefined);
  assert.equal(state.judgeEditedAfterReview, undefined, JSON.stringify(state.judgeEditedAfterReview));
  assert.equal(ids(d.seen, 'judge_edited_after_review').length, 0);
  assert.deepEqual(d.said, []);
});

// ---- resuming, and failing closed -------------------------------------------

test('a final fix that dies inside its turn resumes on the snapshot its first attempt took', async () => {
  const state = judgeRun('vibe-jar-resume-');
  const cfg = config({ confirmFinalFix: false }, committing());
  const seen: Narration[] = [];
  const first: string[] = [];
  await assert.rejects(
    quietly(seen, () =>
      orchestrate(
        state,
        cfg,
        true,
        agents(
          {
            codex: oneP1(),
            claude: (label) => {
              if (label === 'final-fix-1') {
                write(state, TEST, 'test("x", () => {});\n');
                throw new Error('the fixer died mid-turn');
              }
              return 'done';
            },
          },
          first,
        ),
      ),
    ),
  );
  assert.deepEqual(first, ['review-0', 'final-fix-1']);
  const persisted = loadRun(state.targetDir, state.id).judgeAtLastReview;
  assert.ok(persisted !== undefined, 'persisted before the turn');
  assert.deepEqual(persisted.files, [], 'the review saw the test unchanged');

  const resumed = loadRun(state.targetDir, state.id);
  const d = await drive(resumed, cfg, {
    codex: () => assert.fail('the final fix round is never reviewed again'),
    claude: () => 'done',
  });
  assert.deepEqual(d.calls, ['final-fix-1']);
  // A snapshot taken again would have absorbed the dead turn's edit.
  assert.deepEqual(resumed.judgeAtLastReview, persisted);
  assert.deepEqual(paths(resumed.judgeEditedAfterReview?.files), [TEST]);
});

/** A run already past its final fix, as a resume after the turn finds it. */
function pastFinalFix(prefix: string, seed: (state: RunState) => void = () => undefined): RunState {
  const state = judgeRun(prefix);
  state.reviewRound = 1;
  state.finalFixDone = true;
  state.outstanding = [p1('the-one')];
  state.pendingFindings = null;
  seed(state);
  return state;
}

test('a final fix with no snapshot says its edits could not be checked, and lists nothing', async () => {
  const state = pastFinalFix('vibe-jar-nosnap-');
  write(state, TEST, 'test("x", () => {});\n');
  const d = await drive(state, config({ confirmFinalFix: false }), {
    codex: () => assert.fail('no review'),
    claude: () => assert.fail('no turn'),
  });

  assert.deepEqual(d.calls, []);
  assert.equal(state.judgeEditedAfterReview, undefined);
  assert.equal('judgeEditedAfterReview' in stored(state), false);
  const said = ids(d.seen, 'judge_edited_after_review_unchecked');
  assert.equal(said.length, 1);
  assert.equal(said[0]?.message, UNCHECKED);
  assert.deepEqual(d.said, [UNCHECKED]);
  assert.ok(![...d.seen.map((n) => n.message), ...d.said].some((m) => /\bnone\b/i.test(m)));
});

test('a stored snapshot with a damaged entry is not used, so the run says it could not check', async () => {
  // Dropping only the bad entry could lose a test that went back to its base
  // content, which the end listing does not name either; the whole snapshot goes.
  const state = pastFinalFix('vibe-jar-damaged-');
  saveState(state);
  writeFileSync(
    path.join(state.dir, 'state.json'),
    JSON.stringify({
      ...stored(state),
      judgeAtLastReview: { round: 1, files: [{ path: TEST, blob: 'not-a-hash' }] },
    }),
    'utf8',
  );
  const resumed = loadRun(state.targetDir, state.id);
  assert.equal(resumed.judgeAtLastReview, undefined);
  assert.ok(resumed.events.some((e) => e.type === 'state_repaired'));

  const d = await drive(resumed, config(), {
    codex: () => assert.fail('no review'),
    claude: () => assert.fail('no turn'),
  });
  assert.equal(resumed.judgeEditedAfterReview, undefined);
  assert.equal(ids(d.seen, 'judge_edited_after_review_unchecked').length, 1);
  assert.deepEqual(d.said, [UNCHECKED]);
});

/** A gate that leaves an index lock behind, so the next `add -N` is refused. */
function locking(state: RunState, fromRun: number): Partial<Config> {
  writeFileSync(
    path.join(state.targetDir, 'vibe-lock.mjs'),
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\n" +
      "appendFileSync('vibe-lock-runs.txt', 'ran\\n');\n" +
      "const runs = readFileSync('vibe-lock-runs.txt', 'utf8').split('\\n').filter(Boolean).length;\n" +
      `if (runs >= ${fromRun}) writeFileSync('.git/index.lock', '');\n`,
    'utf8',
  );
  return { verify: { ...DEFAULTS.verify, enabled: true, command: 'node vibe-lock.mjs', runs: 1, timeoutMs: 30_000 } };
}

test('a comparison that fails clears a result an earlier process saved, and the snapshot with it', async () => {
  const state = pastFinalFix('vibe-jar-stale-', (s) => {
    s.judgeAtLastReview = { round: 1, files: [] };
    s.judgeEditedAfterReview = {
      sinceRound: 1,
      files: [{ path: TEST, oldPath: null, status: 'modified', added: 1, removed: 1 }],
    };
  });
  const d = await drive(state, config({}, locking(state, 1)), {
    codex: () => assert.fail('no review'),
    claude: () => assert.fail('no turn'),
  });

  assert.equal(state.judgeEditedAfterReview, undefined);
  assert.equal(state.judgeAtLastReview, undefined);
  const raw = stored(state);
  assert.equal('judgeEditedAfterReview' in raw, false);
  assert.equal('judgeAtLastReview' in raw, false);
  assert.equal(ids(d.seen, 'judge_edited_after_review_unchecked').length, 1);
  assert.deepEqual(d.said, [UNCHECKED]);
});

test('an add -N refused after the final fix gives no list at all, never an empty or partial one', async () => {
  const state = judgeRun('vibe-jar-lock-');
  // Run 1 is before the review; run 2, after the final fix, leaves the lock.
  const d = await drive(state, config({ confirmFinalFix: false }, locking(state, 2)), {
    codex: oneP1(),
    claude: (label) => {
      if (label === 'final-fix-1') write(state, 'tests/new.test.ts', 'test("new", () => {});\n');
      return 'done';
    },
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  assert.equal(state.judgeEditedAfterReview, undefined);
  assert.equal(state.judgeAtLastReview, undefined);
  assert.equal(ids(d.seen, 'judge_edited_after_review').length, 0);
  assert.equal(ids(d.seen, 'judge_edited_after_review_unchecked').length, 1);
  assert.deepEqual(d.said, [UNCHECKED]);
});

// ---- runs that never take the final fix -------------------------------------

test('a clean review, and a blocking review then a clean one, record and say nothing new', async () => {
  for (const [prefix, codex] of [
    ['vibe-jar-clean-', (): unknown => report([])],
    ['vibe-jar-blocking-', (label: string): unknown => (label === 'review-0' ? report(BLOCKING) : report([]))],
  ] as const) {
    const state = judgeRun(prefix);
    const d = await drive(state, config({}, committing()), {
      codex,
      claude: (label) => {
        if (label.startsWith('fix-')) write(state, TEST, 'test("x", () => {});\n');
        return 'done';
      },
    });
    const raw = stored(state);
    assert.equal('judgeAtLastReview' in raw, false, prefix);
    assert.equal('judgeEditedAfterReview' in raw, false, prefix);
    assert.equal(ids(d.seen, 'judge_edited_after_review').length, 0, prefix);
    assert.equal(ids(d.seen, 'judge_edited_after_review_unchecked').length, 0, prefix);
    assert.deepEqual(d.said, [], prefix);
  }
});

// ---- the parts on their own -------------------------------------------------

const change = (p: string, over: Partial<FileChange> = {}): FileChange => ({
  path: p,
  oldPath: null,
  status: 'modified',
  added: 1,
  removed: 1,
  ...over,
});

test('editedAfterReview: a rename of a snapshot path is not a restore, and deleted twice is unchanged', () => {
  const renamed = change('src/moved.ts', { oldPath: TEST, status: 'renamed' });
  const out = editedAfterReview([{ path: TEST, blob: 'a'.repeat(40) }], [renamed], new Map([['src/moved.ts', 'b'.repeat(40)]]), [renamed]);
  assert.deepEqual(out.restored, []);
  assert.deepEqual(out.files, [renamed]);

  const gone = change(TEST, { status: 'deleted' });
  const same = editedAfterReview([{ path: TEST, blob: null }], [gone], new Map([[TEST, null]]), [gone]);
  assert.deepEqual(same, { files: [], restored: [] });
});

test('hadVerdict asks whether any seat gave one, not what the combination says', () => {
  const base: JudgeFile = { ...change(TEST), verdict: 'unjudged' };
  const yes = { justified: true, reason: 'fine' };
  assert.equal(hadVerdict(base), false);
  assert.equal(hadVerdict({ ...base, verdict: yes }), true);
  assert.equal(
    hadVerdict({
      ...base,
      verdicts: [
        { seat: 'roles.reviewer', provider: 'codex', model: 'default', verdict: yes },
        { seat: 'review.finders[0]', provider: 'codex', model: 'default', verdict: 'unjudged' },
      ],
    }),
    true,
  );
  assert.equal(
    hadVerdict({
      ...base,
      verdicts: [{ seat: 'roles.reviewer', provider: 'codex', model: 'default', verdict: 'unjudged' }],
    }),
    false,
  );
});

test('treeChanges refuses a tree whose index is locked, and hashObjects of nothing asks git nothing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-jar-tree-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'vibe@example.invalid');
  sh(dir, 'config', 'user.name', 'vibe tests');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n', 'utf8');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  const base = sh(dir, 'rev-parse', 'HEAD');
  writeFileSync(path.join(dir, 'new.test.ts'), 'x\n', 'utf8');

  assert.deepEqual(
    (await git.treeChanges(dir, base)).changes.map((c) => [c.path, c.status]),
    [['new.test.ts', 'added']],
  );
  writeFileSync(path.join(dir, 'other.test.ts'), 'y\n', 'utf8');
  writeFileSync(path.join(dir, '.git', 'index.lock'), '', 'utf8');
  await assert.rejects(git.treeChanges(dir, base));

  // A directory that is not a repository: had it spawned, git would have failed.
  assert.deepEqual(await git.hashObjects(path.join(dir, 'missing'), []), []);
});

test('judgeTracked: a match, a rename from a match, and a kept path are in; anything else is out', () => {
  const all = [change('tests/a.test.ts'), change('src/moved.ts', { status: 'added' }), change('src/kept.ts'), change('src/other.ts')];
  const out = judgeTracked(all, new Map([['src/moved.ts', TEST]]), ['**/tests/**'], new Set(['src/kept.ts']));
  assert.deepEqual(paths(out), ['tests/a.test.ts', 'src/moved.ts', 'src/kept.ts']);
});
