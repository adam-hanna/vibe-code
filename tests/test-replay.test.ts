import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import type { Config, GatesConfig, RunState, TestReplay, TestReplayFile, VerifyConfig } from '@src/types.js';
import {
  agents,
  assertLog,
  assertRuns,
  assertionGate,
  BLOCKING,
  commitTree,
  config,
  freshRun,
  p1,
  planFixture,
  report,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * Each edited test, replayed at its earliest committed version against the
 * run's code (#486).
 *
 * The gate decides by content: it passes only while every `expect: <token>`
 * line under `tests/` names a line of `src/code.txt`. So an earlier version of a
 * test that expects something the code no longer has fails, and one whose
 * expectations the code still meets passes - which is the whole question a
 * replay asks. Agents are injected; git, the gate and `state.json` are real.
 */

const GATE = 'core';

function startRun(prefix: string): RunState {
  return freshRun({ prefix: `vibe-replay-${prefix}-`, task: 'replay', planOnly: false, git: true, commit: true });
}

function put(state: RunState, files: Record<string, string | null>): void {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(state.targetDir, name);
    if (body === null) {
      rmSync(file, { force: true });
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body, 'utf8');
  }
}

/** The base commit: what the run starts from. */
function seed(state: RunState, files: Record<string, string>): void {
  put(state, files);
  commitTree(state, 'base');
}

function matrix(): GatesConfig {
  return {
    'plan-round': 'auto',
    'question-round': 'auto',
    'plan-approved': 'auto',
    implemented: 'auto',
    'verify-round': 'auto',
    'review-round': 'auto',
  };
}

function cfgFor(
  state: RunState,
  options: {
    verify?: Partial<VerifyConfig>;
    commits?: boolean;
    gate?: Parameters<typeof assertionGate>[2];
    timeoutMs?: number;
  } = {},
): Config {
  const command = assertionGate(state, GATE, options.gate);
  return config(
    { maxVerifyRounds: 2 },
    {
      gates: matrix(),
      git: { ...DEFAULTS.git, commitEachRound: options.commits ?? true },
      verify: {
        ...DEFAULTS.verify,
        enabled: true,
        runs: 1,
        timeoutMs: 30_000,
        baseline: false,
        command: null,
        gates: [{ name: GATE, command, runs: 1, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }],
        ...options.verify,
      },
    },
  );
}

type Turn = (state: RunState) => void;

/** Claude's turns do what `turns` says by label; Codex reviews with `review`. */
function handlers(
  state: RunState,
  turns: Record<string, Turn>,
  review: (label: string) => unknown = () => report([]),
): Handlers {
  return {
    claude: (label) => {
      if (label === 'plan' || label.startsWith('revise')) return planFixture();
      turns[label]?.(state);
      return label.startsWith('fix-') || label.startsWith('final-fix')
        ? { report: `did ${label}`, dispositions: [] }
        : `did ${label}`;
    },
    codex: (label) => (label.startsWith('review') ? review(label) : report([])),
  };
}

interface Driven {
  seen: Narration[];
  calls: string[];
  err: unknown;
}

async function drive(state: RunState, cfg: Config, h: Handlers, resume = false): Promise<Driven> {
  const seen: Narration[] = [];
  const calls: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  let err: unknown = null;
  try {
    await orchestrate(state, cfg, resume, agents(h, calls));
  } catch (e) {
    err = e;
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return { seen, calls, err };
}

const said = (seen: readonly Narration[], id: string): Narration[] => seen.filter((n) => n.id === id);

function fileOf(record: TestReplay | undefined, p: string): TestReplayFile {
  const f = record?.files.find((x) => x.path === p);
  assert.ok(f !== undefined, `${p} is in the record: ${JSON.stringify(record)}`);
  return f;
}

function sh(state: RunState, ...args: string[]): string {
  return execFileSync('git', args, { cwd: state.targetDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const bytes = (state: RunState, name: string): Buffer => readFileSync(path.join(state.targetDir, name));
const decoded = (run: { files: Record<string, string> }, name: string): string | undefined => {
  const b = run.files[name];
  return b === undefined ? undefined : Buffer.from(b, 'base64').toString('utf8');
};

function storedKeys(state: RunState): string[] {
  return Object.keys(JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as object);
}

// ---- what a replay says ----------------------------------------------------

test('a pre-existing test weakened by the implement turn: its base version fails a gate that just passed', async () => {
  const state = startRun('weakened');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  const cfg = cfgFor(state);
  const d = await drive(
    state,
    cfg,
    handlers(state, {
      implement: (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' }),
    }),
  );
  assert.equal(d.err, null, String(d.err));

  const a = fileOf(state.testReplay, 'tests/a.test.txt');
  assert.equal(a.verdict, 'earlier-fails');
  assert.equal(a.gate, GATE);
  assert.deepEqual(a.gates, [GATE]);
  assert.equal(a.earliest?.commit, state.baseSha, 'a pre-existing test replays its base version');
  assert.equal(state.testReplay?.round, 0);
  assert.equal(state.testReplay?.at, 'review');
  assert.ok(existsSync(path.join(state.dir, 'test-replay-0.json')));
  // The review's own record keeps its shape: nothing of the replay is in it.
  assert.equal(JSON.stringify(state.testChanges ?? {}).includes('earlier-fails'), false);

  // Verification once, the replay once; the head copy is back afterwards.
  assert.equal(assertRuns(state, GATE), 2);
  const replayRun = assertLog(state, GATE)[1];
  assert.equal(decoded(replayRun ?? { files: {} }, 'tests/a.test.txt'), 'expect: add\n', 'the base version ran');
  assert.equal(bytes(state, 'tests/a.test.txt').toString('utf8'), 'expect: mul\n');
  assert.equal(state.testReplayInFlight, undefined);
  assert.equal(storedKeys(state).includes('testReplayInFlight'), false);

  const line = said(d.seen, 'test_replay');
  assert.equal(line.length, 1);
  assert.equal(line[0]?.level, 'warn');
  assert.match(line[0]?.message ?? '', /earliest committed version fails the `core` gate against the current code/);
  assert.doesNotMatch(line[0]?.message ?? '', /tamper/i);
  assert.deepEqual(
    state.events.filter((e) => e.type.startsWith('test_replay')),
    [],
    'narration, never an event',
  );
});

test('backups are named by the hash of their bytes, never by the test path', async () => {
  const state = startRun('names');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  await drive(
    state,
    cfgFor(state),
    handlers(state, { implement: (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' }) }),
  );
  const during = assertLog(state, GATE)[1]?.backups ?? [];
  assert.ok(during.length > 0, 'a backup existed while the replay ran');
  for (const name of during) {
    assert.match(name, /^test-replay-0\/[0-9a-f]{64}\.head$/);
    assert.doesNotMatch(name, /a\.test/);
  }
  const kept = readdirSync(path.join(state.dir, 'test-replay-0'));
  assert.equal(kept.length, 1, 'kept after the restore');
  assert.equal(
    readFileSync(path.join(state.dir, 'test-replay-0', kept[0] ?? '')).toString('utf8'),
    'expect: mul\n',
    'the head copy',
  );
});

test('a test the run added and a fix round loosened replays its implement-commit version', async () => {
  const state = startRun('added');
  seed(state, { 'src/code.txt': 'add\n' });
  let reviews = 0;
  const d = await drive(
    state,
    cfgFor(state),
    handlers(
      state,
      {
        implement: (s) => put(s, { 'src/code.txt': 'add\nsub\n', 'tests/b.test.txt': 'expect: add\nexpect: sub\n' }),
        'fix-1': (s) => put(s, { 'src/code.txt': 'add\n', 'tests/b.test.txt': 'expect: add\n' }),
      },
      () => (reviews++ === 0 ? report(BLOCKING) : report([])),
    ),
  );
  assert.equal(d.err, null, String(d.err));
  const implementSha = sh(state, 'rev-list', '--reverse', `${state.baseSha ?? ''}..HEAD`).split('\n')[0];

  const b = fileOf(state.testReplay, 'tests/b.test.txt');
  assert.equal(state.testReplay?.round, 1);
  assert.equal(b.earliest?.commit, implementSha, 'the first commit after the base that holds it');
  assert.equal(b.verdict, 'earlier-fails');
  assert.equal(b.gate, GATE);
});

test('a legitimate edit that keeps the earlier assertions is preserved, in one gate run', async () => {
  const state = startRun('preserved');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  const d = await drive(
    state,
    cfgFor(state),
    handlers(state, {
      implement: (s) => put(s, { 'src/code.txt': 'add\nmul\n', 'tests/a.test.txt': 'expect: add\nexpect: mul\n' }),
    }),
  );
  assert.equal(d.err, null, String(d.err));
  const a = fileOf(state.testReplay, 'tests/a.test.txt');
  assert.equal(a.verdict, 'preserved');
  assert.deepEqual(a.gates, [GATE]);
  assert.equal(a.gate, undefined);
  assert.equal(assertRuns(state, GATE), 2, 'verification once, the batch once');
  assert.equal(said(d.seen, 'test_replay')[0]?.level, 'info');
});

test('a batch with one weakened file and one good one is split, and says which is which', async () => {
  const state = startRun('split');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'tests/b.test.txt': 'expect: sub\n', 'src/code.txt': 'add\nsub\n' });
  await drive(
    state,
    cfgFor(state),
    handlers(state, {
      implement: (s) =>
        put(s, {
          'src/code.txt': 'mul\nsub\n',
          'tests/a.test.txt': 'expect: mul\n',
          'tests/b.test.txt': 'expect: sub\nexpect: mul\n',
        }),
    }),
  );
  assert.equal(fileOf(state.testReplay, 'tests/a.test.txt').verdict, 'earlier-fails');
  assert.equal(fileOf(state.testReplay, 'tests/b.test.txt').verdict, 'preserved');
  assert.equal(assertRuns(state, GATE), 4, 'verification, the batch, then one run per file');
});

test('a batch that times out is split too, and each file that passes alone is preserved', async () => {
  const state = startRun('timeout');
  seed(state, {
    'tests/a.test.txt': 'expect: old-a\n',
    'tests/b.test.txt': 'expect: old-b\n',
    'src/code.txt': 'old-a\nold-b\n',
  });
  const cfg = cfgFor(state, { gate: { sleepWhenAll: ['old-a', 'old-b'], sleepMs: 30_000 }, timeoutMs: 6_000 });
  await drive(
    state,
    cfg,
    handlers(state, {
      implement: (s) =>
        put(s, {
          'src/code.txt': 'old-a\nold-b\nnew-a\nnew-b\n',
          'tests/a.test.txt': 'expect: new-a\n',
          'tests/b.test.txt': 'expect: new-b\n',
        }),
    }),
  );
  assert.equal(fileOf(state.testReplay, 'tests/a.test.txt').verdict, 'preserved');
  assert.equal(fileOf(state.testReplay, 'tests/b.test.txt').verdict, 'preserved');
  assert.equal(assertRuns(state, GATE), 4, 'verification, the timed-out batch, then one run per file');
});

test('a test the final fix weakened is replayed at the end of that road', async () => {
  const state = startRun('final');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  const d = await drive(
    state,
    cfgFor(state),
    handlers(
      state,
      {
        implement: (s) => put(s, { 'src/impl.txt': 'impl\n' }),
        'final-fix-1': (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' }),
      },
      () => report([p1('the-one')]),
    ),
  );
  assert.equal(d.err, null, String(d.err));
  assert.equal(state.testReplay, undefined, 'the implement turn touched no test');
  const record = state.testReplayAfterReview;
  assert.equal(record?.at, 'final-fix');
  assert.equal(record?.round, 1);
  const a = fileOf(record, 'tests/a.test.txt');
  assert.equal(a.verdict, 'earlier-fails');
  assert.equal(a.gate, GATE);
  assert.ok(existsSync(path.join(state.dir, 'test-replay-1.json')));
});

test('with commits off a pre-existing test still replays, and a run-added one has no committed version', async () => {
  const state = startRun('nocommit');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  await drive(
    state,
    cfgFor(state, { commits: false }),
    handlers(state, {
      implement: (s) =>
        put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n', 'tests/n.test.txt': 'expect: mul\n' }),
    }),
  );
  assert.equal(fileOf(state.testReplay, 'tests/a.test.txt').verdict, 'earlier-fails');
  assert.equal(fileOf(state.testReplay, 'tests/n.test.txt').verdict, 'no-committed-version');
});

test('two files with one blob id and different bytes keep two backups, and each gets its own bytes back', async () => {
  const state = startRun('bytes');
  seed(state, {
    '.gitattributes': '*.txt text\n',
    'tests/a.test.txt': 'expect: add\n',
    'tests/b.test.txt': 'expect: add\n',
    'src/code.txt': 'add\nx\n',
  });
  await drive(
    state,
    cfgFor(state),
    handlers(state, {
      implement: (s) => put(s, { 'tests/a.test.txt': 'expect: add\r\nexpect: x\r\n', 'tests/b.test.txt': 'expect: add\nexpect: x\n' }),
    }),
  );
  const a = fileOf(state.testReplay, 'tests/a.test.txt');
  const b = fileOf(state.testReplay, 'tests/b.test.txt');
  assert.equal(a.head, b.head, 'the fixture: git gives both one filtered id');
  assert.equal(a.verdict, 'preserved');
  assert.equal(b.verdict, 'preserved');
  assert.equal(readdirSync(path.join(state.dir, 'test-replay-0')).length, 2, 'one backup per distinct byte sequence');
  assert.equal(bytes(state, 'tests/a.test.txt').toString('utf8'), 'expect: add\r\nexpect: x\r\n');
  assert.equal(bytes(state, 'tests/b.test.txt').toString('utf8'), 'expect: add\nexpect: x\n');
});

test('a smudge filter that changes the committed version makes the replay unproven, never preserved', async () => {
  const state = startRun('smudge');
  sh(state, 'config', 'filter.strip.smudge', "grep -v 'expect: add'");
  sh(state, 'config', 'filter.strip.clean', 'cat');
  seed(state, {
    '.gitattributes': 'tests/*.txt filter=strip\n',
    'tests/a.test.txt': 'expect: add\nexpect: keep\n',
    'src/code.txt': 'add\nkeep\n',
  });
  await drive(
    state,
    cfgFor(state),
    handlers(state, { implement: (s) => put(s, { 'src/code.txt': 'keep\n', 'tests/a.test.txt': 'expect: keep\n' }) }),
  );
  const a = fileOf(state.testReplay, 'tests/a.test.txt');
  assert.equal(a.verdict, 'unproven');
  assert.match(a.reason ?? '', /do not hash back to the committed version/);
  assert.equal(assertRuns(state, GATE), 1, 'no replay gate ran over bytes that were never committed');
  assert.equal(bytes(state, 'tests/a.test.txt').toString('utf8'), 'expect: keep\n');
});

// ---- the cache ---------------------------------------------------------------

test('the same edit on the same tree is replayed once: a resume reuses the verdict', async () => {
  const state = startRun('cache');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  const cfg = cfgFor(state);
  let fail = true;
  const h = handlers(
    state,
    { implement: (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' }) },
    () => {
      if (fail) throw new Error('the reviewer is not reachable');
      return report([]);
    },
  );
  const first = await drive(state, cfg, h);
  assert.ok(first.err !== null, 'the first process stopped at the review');
  assert.equal(fileOf(state.testReplay, 'tests/a.test.txt').cached, undefined);
  assert.equal(assertRuns(state, GATE), 2);

  fail = false;
  const second = await drive(state, cfg, h, true);
  assert.equal(second.err, null, String(second.err));
  const a = fileOf(state.testReplay, 'tests/a.test.txt');
  assert.equal(a.cached, true);
  assert.equal(a.verdict, 'earlier-fails');
  assert.equal(assertRuns(state, GATE), 3, 'verification ran again; the replay did not');
});

test('a verdict is never reused once the code changed: preserved, then earlier-fails after a regression', async () => {
  const state = startRun('stale');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  let reviews = 0;
  let atImplement: TestReplayFile | undefined;
  await drive(
    state,
    cfgFor(state),
    handlers(
      state,
      {
        implement: (s) => put(s, { 'src/code.txt': 'add\nmul\n', 'tests/a.test.txt': 'expect: mul\n' }),
        // The code regresses and the test does not change.
        'fix-1': (s) => put(s, { 'src/code.txt': 'mul\n', 'src/fix.txt': 'fix\n' }),
      },
      () => {
        if (reviews === 0) atImplement = fileOf(state.testReplay, 'tests/a.test.txt');
        return reviews++ === 0 ? report(BLOCKING) : report([]);
      },
    ),
  );
  assert.equal(atImplement?.verdict, 'preserved');
  const later = fileOf(state.testReplay, 'tests/a.test.txt');
  assert.equal(later.verdict, 'earlier-fails');
  assert.equal(later.cached, undefined, 'measured again, not reused');
  assert.equal(assertRuns(state, GATE), 4, 'verification and a replay in each round');
});

test('an assume-unchanged source edit is invisible to a tree id, so no cache is read or written', async () => {
  const state = startRun('hidden');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  sh(state, 'update-index', '--assume-unchanged', 'src/code.txt');
  const cfg = cfgFor(state);
  let fail = true;
  const h = handlers(
    state,
    { implement: (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n', 'src/impl.txt': 'i\n' }) },
    () => {
      if (fail) throw new Error('the reviewer is not reachable');
      return report([]);
    },
  );
  await drive(state, cfg, h);
  assert.equal(state.testReplay?.tree, null);
  assert.equal(state.testReplayCache, undefined);
  fail = false;
  await drive(state, cfg, h, true);
  const a = fileOf(state.testReplay, 'tests/a.test.txt');
  assert.equal(a.cached, undefined);
  assert.equal(assertRuns(state, GATE), 4, 'the replay ran again on the resume');
});

test("the replay never writes the real index: staged changes are byte-identical while it runs", async () => {
  const state = startRun('index');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  await drive(
    state,
    cfgFor(state, { commits: false }),
    handlers(state, {
      implement: (s) => {
        put(s, {
          'src/code.txt': 'mul\n',
          'tests/a.test.txt': 'expect: mul\n',
          'tests/n.test.txt': 'expect: mul\n',
          'src/other.txt': 'staged\n',
        });
        sh(s, 'add', 'src/other.txt');
      },
    }),
  );
  const [verified, replayed] = assertLog(state, GATE);
  assert.ok(verified?.index !== null && verified?.index !== undefined);
  assert.ok(replayed !== undefined, 'the replay ran');
  assert.equal(replayed.index, verified.index, 'the index the gate saw before the replay is the one it saw during it');
});

// ---- what is not replayed ------------------------------------------------------

test('renamed, deleted and config-only changes record their reasons and replay nothing', async () => {
  const state = startRun('reasons');
  const body = 'expect: add\n' + 'line\n'.repeat(20);
  seed(state, {
    'tests/r.test.txt': body,
    'tests/d.test.txt': 'expect: add\n',
    'vibe.config.json': '{}\n',
    'src/code.txt': 'add\n',
  });
  const d = await drive(
    state,
    cfgFor(state),
    handlers(state, {
      implement: (s) =>
        put(s, {
          'tests/r.test.txt': null,
          'tests/moved.test.txt': body,
          'tests/d.test.txt': null,
          'vibe.config.json': '{ "x": 1 }\n',
        }),
    }),
  );
  assert.equal(d.err, null, String(d.err));
  assert.equal(fileOf(state.testReplay, 'tests/r.test.txt').verdict, 'renamed');
  assert.equal(fileOf(state.testReplay, 'tests/moved.test.txt').verdict, 'renamed');
  assert.equal(fileOf(state.testReplay, 'tests/d.test.txt').verdict, 'deleted');
  assert.equal(fileOf(state.testReplay, 'vibe.config.json').verdict, 'not-a-test');
  assert.equal(assertRuns(state, GATE), 1, 'nothing was replayed');
  const line = said(d.seen, 'test_replay');
  assert.equal(line.length, 1, 'each reason is said, never dropped');
  assert.match(line[0]?.message ?? '', /No edited test needed replaying/);
});

test('the two control files are never swapped, even when a test pattern matches them', async () => {
  const state = startRun('control');
  seed(state, {
    'tests/a.test.txt': 'expect: add\n',
    'vibe.config.json': '{}\n',
    'REVIEW.md': '# standards\n',
    'src/code.txt': 'add\n',
  });
  await drive(
    state,
    cfgFor(state, { verify: { testPaths: ['**/*'] } }),
    handlers(state, {
      implement: (s) =>
        put(s, {
          'tests/a.test.txt': 'expect: add\nexpect: mul\n',
          'src/code.txt': 'add\nmul\n',
          'vibe.config.json': '{ "x": 1 }\n',
          'REVIEW.md': '# standards, edited\n',
        }),
    }),
  );
  assert.equal(fileOf(state.testReplay, 'vibe.config.json').verdict, 'not-a-test');
  assert.equal(fileOf(state.testReplay, 'REVIEW.md').verdict, 'not-a-test');
  assert.equal(fileOf(state.testReplay, 'tests/a.test.txt').verdict, 'preserved');
  const runs = assertLog(state, GATE);
  assert.ok(runs.length >= 2, 'a replay ran');
  for (const run of runs) {
    assert.equal(decoded(run, 'vibe.config.json'), '{ "x": 1 }\n');
    assert.equal(decoded(run, 'REVIEW.md'), '# standards, edited\n');
  }
});

function assertNoReplay(state: RunState, d: Driven): void {
  for (const key of ['testReplay', 'testReplayAfterReview', 'testReplayCache', 'testReplayInFlight']) {
    assert.equal(storedKeys(state).includes(key), false, `no ${key} in state.json`);
  }
  assert.deepEqual(
    readdirSync(state.dir).filter((f) => f.startsWith('test-replay')),
    [],
    'no replay artifact',
  );
  assert.deepEqual(
    d.seen.filter((n) => (n.id ?? '').startsWith('test_replay')),
    [],
    'nothing said',
  );
}

test('verify.replay: false replays nothing and records nothing', async () => {
  const state = startRun('off');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  const d = await drive(
    state,
    cfgFor(state, { verify: { replay: false } }),
    handlers(state, { implement: (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' }) }),
  );
  assert.equal(d.err, null, String(d.err));
  assertNoReplay(state, d);
  assert.equal(assertRuns(state, GATE), 1, 'verification only');
});

test('a gate with replay: false is not a replaying gate, and with none left nothing happens', async () => {
  const state = startRun('gateoff');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  const command = assertionGate(state, GATE);
  const d = await drive(
    state,
    cfgFor(state, { verify: { gates: [{ name: GATE, command, runs: 1, replay: false }] } }),
    handlers(state, { implement: (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' }) }),
  );
  assert.equal(d.err, null, String(d.err));
  assertNoReplay(state, d);
});

test('verify.enabled: false replays nothing and records nothing', async () => {
  const state = startRun('disabled');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  const d = await drive(
    state,
    cfgFor(state, { verify: { enabled: false } }),
    handlers(state, { implement: (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' }) }),
  );
  assert.equal(d.err, null, String(d.err));
  assertNoReplay(state, d);
  assert.equal(assertRuns(state, GATE), 0);
});

// ---- what goes wrong is unproven, not an error ----------------------------------

test('a file where the backup directory should be makes the replay unproven, not the run an error', async () => {
  const state = startRun('nodir');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  writeFileSync(path.join(state.dir, 'test-replay-0'), 'not a directory\n', 'utf8');
  const d = await drive(
    state,
    cfgFor(state),
    handlers(state, { implement: (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' }) }),
  );
  assert.equal(d.err, null, String(d.err));
  const a = fileOf(state.testReplay, 'tests/a.test.txt');
  assert.equal(a.verdict, 'unproven');
  assert.match(a.reason ?? '', /could not be backed up/);
  assert.equal(assertRuns(state, GATE), 1, 'nothing was swapped, so nothing was replayed');
  assert.equal(bytes(state, 'tests/a.test.txt').toString('utf8'), 'expect: mul\n');
  assert.equal(state.testReplayInFlight, undefined);
});

test('a test that can be read and not written makes the replay unproven, and the run carries on', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const state = startRun('readonly');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  const d = await drive(
    state,
    cfgFor(state),
    handlers(state, {
      implement: (s) => {
        put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' });
        chmodSync(path.join(s.targetDir, 'tests/a.test.txt'), 0o444);
      },
    }),
  );
  chmodSync(path.join(state.targetDir, 'tests/a.test.txt'), 0o644);
  assert.equal(d.err, null, String(d.err));
  const a = fileOf(state.testReplay, 'tests/a.test.txt');
  assert.equal(a.verdict, 'unproven');
  assert.match(a.reason ?? '', /could not be written/);
  assert.equal(bytes(state, 'tests/a.test.txt').toString('utf8'), 'expect: mul\n');
  assert.equal(state.testReplayInFlight, undefined, 'the restore found it untouched and cleared the marker');
});

test('a replayed gate whose process outlived every kill stops the run, keeps the marker, and the resume restores again', {
  skip: process.platform === 'win32',
}, async (t) => {
  // With the earlier version in place the gate starts a worker that leaves its
  // group (`setsid`) and drops the token, keeps the gate's output open, and
  // then overruns the timeout. Nothing can confirm that worker stopped, so the
  // replay must not go on to another pass or to the review beside it - and
  // since the worker holds the earlier bytes and may write them back after the
  // restore, the marker has to survive for the resume to restore again.
  const state = startRun('escaped');
  seed(state, { 'tests/a.test.txt': 'expect: add\n', 'src/code.txt': 'add\n' });
  const pidFile = path.join(state.targetDir, 'worker.pid');
  t.after(() => {
    if (!existsSync(pidFile)) return;
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch {
      // Gone.
    }
  });
  mkdirSync(path.join(state.targetDir, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(state.targetDir, '.git', 'info', 'exclude'), 'escape-gate.mjs\nworker.mjs\nworker.pid\nworker.go\nworker.done\n', 'utf8');
  writeFileSync(
    path.join(state.targetDir, 'worker.mjs'),
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n" +
      "const held = readFileSync('tests/a.test.txt');\n" +
      "writeFileSync('worker.pid', String(process.pid));\n" +
      "const t = setInterval(() => { if (existsSync('worker.go')) { clearInterval(t); writeFileSync('tests/a.test.txt', held); writeFileSync('worker.done', ''); } }, 20);\n" +
      'setInterval(() => {}, 1000);\n',
    'utf8',
  );
  writeFileSync(
    path.join(state.targetDir, 'escape-gate.mjs'),
    "import { spawn } from 'node:child_process';\nimport { readFileSync } from 'node:fs';\n" +
      "if (!readFileSync('tests/a.test.txt', 'utf8').includes('expect: add')) process.exit(0);\n" +
      "spawn(process.execPath, ['worker.mjs'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { PATH: process.env.PATH } });\n" +
      'setInterval(() => {}, 1000);\n',
    'utf8',
  );
  const cfg = cfgFor(state, {
    verify: { gates: [{ name: GATE, command: 'node escape-gate.mjs', runs: 1, timeoutMs: 1_500 }] },
  });
  const d = await drive(
    state,
    cfg,
    handlers(state, { implement: (s) => put(s, { 'src/code.txt': 'mul\n', 'tests/a.test.txt': 'expect: mul\n' }) }),
  );
  assert.ok(d.err instanceof Error && d.err.name === 'ReplayGateEscapedError', String(d.err));
  assert.match((d.err as Error).message, /tests\/a\.test\.txt/);
  assert.match((d.err as Error).message, /may still be running/);
  assert.equal(bytes(state, 'tests/a.test.txt').toString('utf8'), 'expect: mul\n', 'the head copy is back for now');
  assert.notEqual(state.testReplayInFlight, undefined, 'the marker is kept: the worker may still write');
  const stored = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  assert.notEqual(stored['testReplayInFlight'], undefined, 'and it is on disk, for the next process');
  assert.equal(state.testReplay, undefined, 'no verdict is recorded for a replay that did not finish');
  assert.ok(!d.calls.some((c) => c.startsWith('review')), `no review turn ran beside the worker: ${d.calls.join(', ')}`);

  // The delayed write: the worker puts the earlier version back after the run
  // stopped. Then it is stopped, as the message asks, and the run resumed.
  writeFileSync(path.join(state.targetDir, 'worker.go'), '', 'utf8');
  const deadline = Date.now() + 10_000;
  while (!existsSync(path.join(state.targetDir, 'worker.done')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(bytes(state, 'tests/a.test.txt').toString('utf8'), 'expect: add\n', 'the worker wrote the earlier version back');
  process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');

  const resumed = await drive(state, { ...cfg, verify: { ...cfg.verify, replay: false } }, handlers(state, {}), true);
  assert.equal(resumed.err, null, String(resumed.err));
  assert.equal(said(resumed.seen, 'test_replay_restored').length, 1, 'the resume restored from the kept marker');
  assert.equal(bytes(state, 'tests/a.test.txt').toString('utf8'), 'expect: mul\n', 'the head copy is back for good');
  assert.equal(state.testReplayInFlight, undefined);
});
