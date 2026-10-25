import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { clearCancel, requestCancel } from '@src/cancel.js';
import { execute, reportTestChanges } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import type { AgentTurns } from '@src/orchestrator.js';
import type { RawVerdict } from '@src/judge.js';
import { agents, config, deferred, deferredAgents, report, reviewingRun, until, work } from './helpers/loop-harness.js';
import type { Deferred, Handlers } from './helpers/loop-harness.js';
import type { Config, FinderSeat, JudgeFile, JudgeVerdict, ReviewConfig, RunState, TestChanges } from '@src/types.js';

/**
 * Every review finder's verdict on a change to the run's own judge, kept and
 * combined failing closed (#404), driven through the real loop.
 *
 * Each round here touches a test file and `vibe.config.json`, so every seat is
 * shown the "Changes to the judge" section and answers it. Agents are injected;
 * git, `state.json` and `code-review-<n>.json` are real.
 */

const TEST_FILE = 'tests/a.test.ts';
const CONFIG = 'vibe.config.json';

function withReview(review: Partial<ReviewConfig>): Config {
  return config({}, { review: { ...DEFAULTS.review, ...review } });
}

/** A reviewing run whose diff changes a test file and the config, beside a source file. */
function judged(prefix: string): RunState {
  const state = reviewingRun({ prefix });
  mkdirSync(path.join(state.targetDir, 'tests'), { recursive: true });
  work(state, TEST_FILE, 'test("a", () => {});\n');
  work(state, CONFIG, '{}\n');
  return state;
}

const yes = (reason: string): JudgeVerdict => ({ justified: true, reason });
const no = (reason: string): JudgeVerdict => ({ justified: false, reason });
const both = (v: (file: string) => JudgeVerdict | null): RawVerdict[] =>
  [TEST_FILE, CONFIG].flatMap((file) => {
    const said = v(file);
    return said === null ? [] : [{ file, ...said }];
  });

/** Each label's verdicts; anything unnamed says justified for both files. */
function verdicts(by: Record<string, RawVerdict[]>): Handlers {
  return {
    codex: (label) => ({ ...report([]), test_verdicts: by[label] ?? both(() => yes(`${label} agrees`)) }),
  };
}

async function quietly<T>(body: () => Promise<T>, seen: Narration[] = []): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await body();
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
}

async function drive(state: RunState, cfg: Config, handlers: Handlers): Promise<Narration[]> {
  const seen: Narration[] = [];
  await quietly(() => orchestrate(state, cfg, true, agents(handlers, [])), seen);
  return seen;
}

function judgedSays(seen: readonly Narration[]): Narration[] {
  return seen.filter((n) => n.id === 'test_changes_judged');
}

function artifactChanges(state: RunState): TestChanges | undefined {
  const raw = JSON.parse(readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8')) as {
    testChanges?: TestChanges;
  };
  return raw.testChanges;
}

function storedChanges(state: RunState): TestChanges | undefined {
  const raw = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as { testChanges?: TestChanges };
  return raw.testChanges;
}

function fileOf(state: RunState, name: string): JudgeFile | undefined {
  return state.testChanges?.files.find((f) => f.path === name);
}

/** The end-of-run warning, as `vibe run` prints it. */
function warning(state: RunState): string[] {
  const seen: Narration[] = [];
  log.setSink((n) => void seen.push(n));
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    reportTestChanges(state);
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return seen.filter((n) => n.level === 'warn').map((n) => n.message);
}

const TWO: (FinderSeat | 'codex')[] = ['codex', { provider: 'codex', model: 'gpt-fixture' }];

// ---- agreement --------------------------------------------------------------

test('the reviewer and two finders all say justified: justified, with three verdicts in config order', async () => {
  const state = judged('vibe-fjudge-agree-');
  const seen = await drive(state, withReview({ finders: TWO }), verdicts({}));

  const file = fileOf(state, TEST_FILE);
  assert.deepEqual(file?.verdict, yes('review-0 agrees'));
  assert.deepEqual(file?.verdicts, [
    { seat: 'roles.reviewer', provider: 'codex', model: 'default', verdict: yes('review-0 agrees') },
    { seat: 'review.finders[0]', provider: 'codex', model: 'default', verdict: yes('review-0-f1 agrees') },
    { seat: 'review.finders[1]', provider: 'codex', model: 'gpt-fixture', verdict: yes('review-0-f2 agrees') },
  ]);
  const said = judgedSays(seen);
  assert.equal(said.length, 1, 'test_changes_judged is said once, after the finders');
  assert.equal(said[0]?.level, 'info');
  assert.deepEqual(said[0]?.data, {
    round: 1,
    files: 2,
    justified: 2,
    notJustified: 0,
    unjudged: 0,
    seats: 3,
    disagreed: 0,
  });
  // After the merge of the finders, not before it.
  const at = seen.indexOf(said[0]!);
  assert.ok(seen.findIndex((n) => n.id === 'review_finders_merged') < at, 'said before the finders merged');
  assert.deepEqual(warning(state), []);
});

// ---- one dissent ------------------------------------------------------------

test('finder 2 alone says not justified: not justified, one disagreement, and the warning names it', async () => {
  const state = judged('vibe-fjudge-dissent-');
  const seen = await drive(
    state,
    withReview({ finders: TWO }),
    verdicts({ 'review-0-f2': both((f) => (f === TEST_FILE ? no('rewrites an assertion') : yes('fine'))) }),
  );

  assert.deepEqual(fileOf(state, TEST_FILE)?.verdict, no('rewrites an assertion'));
  assert.deepEqual(fileOf(state, CONFIG)?.verdict, yes('review-0 agrees'));
  const [said] = judgedSays(seen);
  assert.equal(said?.level, 'warn');
  assert.equal(said?.data?.['disagreed'], 1);
  assert.equal(said?.data?.['notJustified'], 1);

  const [line = '', ...rest] = warning(state);
  assert.deepEqual(rest, []);
  assert.ok(
    line.includes(
      `not justified: \`${TEST_FILE}\` (not justified by review.finders[1] codex/gpt-fixture; ` +
        'justified by roles.reviewer codex/default, review.finders[0] codex/default)',
    ),
    line,
  );
  assert.ok(line.includes('The seats disagreed on 1 file(s).'), line);
});

// ---- an omission ------------------------------------------------------------

test('a finder that leaves out a file it was shown makes it unjudged, though the others said justified', async () => {
  const state = judged('vibe-fjudge-omit-');
  await drive(
    state,
    withReview({ finders: TWO }),
    verdicts({ 'review-0-f1': both((f) => (f === TEST_FILE ? null : yes('fine'))) }),
  );

  const file = fileOf(state, TEST_FILE);
  assert.equal(file?.verdict, 'unjudged');
  assert.deepEqual(
    file?.verdicts?.map((v) => (v.verdict === 'unjudged' ? 'unjudged' : v.verdict.justified)),
    [true, 'unjudged', true],
  );
  assert.deepEqual(fileOf(state, CONFIG)?.verdict, yes('review-0 agrees'));
});

// ---- a failed finder --------------------------------------------------------

test('a finder that fails contributes nothing, and the rest decide', async () => {
  const state = judged('vibe-fjudge-fail-');
  const seen = await drive(state, withReview({ finders: TWO }), {
    codex: (label) => {
      // Had it reported, this would have made the file not justified.
      if (label === 'review-0-f2') throw new Error('finder fell over');
      return { ...report([]), test_verdicts: both(() => yes(`${label} agrees`)) };
    },
  });

  assert.ok(state.events.some((e) => e.type === 'review_finder_failed'));
  const file = fileOf(state, TEST_FILE);
  assert.deepEqual(file?.verdict, yes('review-0 agrees'));
  assert.deepEqual(file?.verdicts?.map((v) => v.seat), ['roles.reviewer', 'review.finders[0]']);
  assert.equal(judgedSays(seen)[0]?.data?.['seats'], 2);
});

test('every finder failing leaves one verdict, the reviewer’s, and says one seat', async () => {
  const state = judged('vibe-fjudge-allfail-');
  const seen = await drive(state, withReview({ finders: TWO }), {
    codex: (label) => {
      if (/-f\d/.test(label)) throw new Error('finder fell over');
      return { ...report([]), test_verdicts: both((f) => (f === TEST_FILE ? no('reviewer objects') : yes('fine'))) };
    },
  });

  const file = fileOf(state, TEST_FILE);
  assert.deepEqual(file?.verdict, no('reviewer objects'));
  assert.deepEqual(file?.verdicts, [
    { seat: 'roles.reviewer', provider: 'codex', model: 'default', verdict: no('reviewer objects') },
  ]);
  const [said] = judgedSays(seen);
  assert.equal(said?.data?.['seats'], 1);
  assert.equal(said?.data?.['disagreed'], 0);
});

// ---- a chunked diff ---------------------------------------------------------

/** Every file the judge section of a prompt lists. */
function listedIn(prompt: string): string[] {
  const at = prompt.indexOf('## Changes to the judge');
  if (at === -1) return [];
  const end = prompt.indexOf('\n## ', at + 1);
  const block = prompt.slice(at, end === -1 ? undefined : end);
  return [...block.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1] ?? '');
}

test('on a chunked diff each seat’s verdicts attach only from the part that listed the file', async () => {
  const state = reviewingRun({ prefix: 'vibe-fjudge-chunked-', change: false });
  const line = `${'x'.repeat(79)}\n`;
  const big = line.repeat(Math.ceil(250_000 / line.length));
  const A = 'tests/big-a.test.ts';
  const B = 'tests/big-b.test.ts';
  mkdirSync(path.join(state.targetDir, 'tests'), { recursive: true });
  work(state, A, big);
  work(state, B, big);
  const listedBy = new Map<string, string[]>();
  const seen = await drive(state, withReview({ finders: ['codex', 'codex'] }), {
    codex: (label, options) => {
      const listed = listedIn(options.prompt);
      listedBy.set(label, listed);
      const said: RawVerdict[] = [];
      for (const file of [A, B]) {
        const shown = listed.includes(file);
        // Finder 1 also judges the file its part did not show: that verdict
        // must attach to nothing.
        if (!shown && /-f1-/.test(label)) said.push({ file, justified: false, reason: 'not shown here' });
        if (!shown) continue;
        if (/-f2-/.test(label) && file === B) said.push({ file, justified: false, reason: 'f2 objects to B' });
        else said.push({ file, justified: true, reason: `${label} on ${file}` });
      }
      return { ...report([]), test_verdicts: said };
    },
  });

  const parts = [...listedBy.keys()].filter((l) => /^review-0-part\d+$/.test(l));
  assert.ok(parts.length > 1, `the diff was not chunked: ${[...listedBy.keys()].join(', ')}`);
  const partOf = (file: string): string => {
    const label = parts.find((l) => listedBy.get(l)?.includes(file));
    assert.ok(label !== undefined, `${file} was listed in no part`);
    return label.replace('review-0-', '');
  };
  assert.notEqual(partOf(A), partOf(B), 'both judge files fell in one part');
  const a = fileOf(state, A);
  const b = fileOf(state, B);
  assert.deepEqual(
    a?.verdicts?.map((v) => v.verdict),
    [yes(`review-0-${partOf(A)} on ${A}`), yes(`review-0-f1-${partOf(A)} on ${A}`), yes(`review-0-f2-${partOf(A)} on ${A}`)],
  );
  assert.deepEqual(a?.verdict, yes(`review-0-${partOf(A)} on ${A}`));
  assert.deepEqual(
    b?.verdicts?.map((v) => v.verdict),
    [yes(`review-0-${partOf(B)} on ${B}`), yes(`review-0-f1-${partOf(B)} on ${B}`), no('f2 objects to B')],
  );
  assert.deepEqual(b?.verdict, no('f2 objects to B'));
  assert.equal(judgedSays(seen)[0]?.data?.['disagreed'], 1);
});

// ---- the order the finders finish in ---------------------------------------

/** Release held turns newest first until the run is over, so finders finish in reverse. */
async function lifo(ctl: Deferred, over: Promise<unknown>): Promise<void> {
  let finished = false;
  void over.finally(() => {
    finished = true;
  });
  let quiet = 0;
  let seenHeld = 0;
  while (!finished) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (ctl.held.length !== seenHeld) {
      seenHeld = ctl.held.length;
      quiet = 0;
      continue;
    }
    quiet += 1;
    const newest = ctl.held[ctl.held.length - 1];
    if (quiet >= 3 && newest !== undefined) {
      ctl.release(newest);
      seenHeld = ctl.held.length;
      quiet = 0;
    }
  }
}

test('at maxParallel 3 with the finders finishing in reverse, testChanges is byte-identical to maxParallel 1', async () => {
  const finders: (FinderSeat | 'codex')[] = ['codex', { provider: 'codex', model: 'm2' }, 'codex'];
  const answers = verdicts({
    'review-0-f1': both((f) => (f === CONFIG ? null : yes('f1 fine'))),
    'review-0-f2': both((f) => (f === TEST_FILE ? no('f2 objects') : yes('f2 fine'))),
    'review-0-f3': both(() => no('f3 objects')),
  });
  const runAt = async (maxParallel: number): Promise<{ record: string; ctl: Deferred }> => {
    const state = judged(`vibe-fjudge-order-${maxParallel}-`);
    const ctl = deferred({ hold: (l) => /^review-0-f\d/.test(l) });
    const over = quietly(() =>
      orchestrate(state, withReview({ finders, maxParallel }), true, deferredAgents(answers, [], ctl)),
    );
    await Promise.all([over, lifo(ctl, over)]);
    assert.deepEqual(storedChanges(state), state.testChanges);
    return { record: JSON.stringify(state.testChanges), ctl };
  };
  const one = await runAt(1);
  const three = await runAt(3);
  assert.equal(one.ctl.maxLive, 1);
  assert.equal(three.ctl.maxLive, 3, 'the finders never overlapped');
  assert.equal(three.record, one.record);
  const parsed = JSON.parse(one.record) as TestChanges;
  assert.deepEqual(parsed.files.map((f) => f.verdicts?.length), [4, 4]);
});

// ---- a stop during the finders ---------------------------------------------

test('a stop during the finders leaves the reviewer’s own verdicts, with no verdicts key', async () => {
  const state = judged('vibe-fjudge-stop-');
  const ctl = deferred({ hold: (l) => /^review-0-f\d/.test(l) });
  const turns: AgentTurns = deferredAgents(
    verdicts({ 'review-0': both((f) => (f === TEST_FILE ? no('reviewer objects') : yes('reviewer fine'))) }),
    [],
    ctl,
  );
  clearCancel();
  const cfg = withReview({ finders: TWO, maxParallel: 2 });
  const ended = quietly(() =>
    execute(state, cfg, true, true, () => Promise.resolve(null), (s, c, r) => orchestrate(s, c, r, turns)),
  );
  await until(() => ctl.held.includes('review-0-f1') && ctl.held.includes('review-0-f2'), 'both finders live');
  requestCancel('stopped from the test');
  await ended;
  clearCancel();

  const stored = storedChanges(state);
  assert.ok(stored !== undefined, 'the reviewer’s record was not kept');
  assert.deepEqual(
    stored.files.map((f) => [f.path, f.verdict]),
    [
      [TEST_FILE, no('reviewer objects')],
      [CONFIG, yes('reviewer fine')],
    ],
  );
  assert.doesNotMatch(readFileSync(path.join(state.dir, 'state.json'), 'utf8'), /"verdicts"/);
});

// ---- the artifact -----------------------------------------------------------

test('code-review-0.json carries the combined record state.json does, inside a findings report', async () => {
  const state = judged('vibe-fjudge-artifact-');
  await drive(
    state,
    withReview({ finders: TWO }),
    verdicts({ 'review-0-f1': both((f) => (f === CONFIG ? no('f1 objects') : yes('fine'))) }),
  );

  const fromArtifact = artifactChanges(state);
  assert.deepEqual(fromArtifact, state.testChanges);
  assert.deepEqual(fromArtifact, storedChanges(state));
  const config = fromArtifact?.files.find((f) => f.path === CONFIG);
  assert.deepEqual(config?.verdict, no('f1 objects'));
  assert.equal(config?.verdicts?.length, 3);
  // A findings report, not the runner's wrapper.
  const raw = JSON.parse(readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(typeof raw['verdict'], 'string');
  assert.ok(Array.isArray(raw['findings']));
  assert.equal('slots' in raw, false);
});

// ---- with no finders, nothing moves ----------------------------------------

test('with no finders, test_changes_judged has no seat counts and no record holds verdicts', async () => {
  const state = judged('vibe-fjudge-plain-');
  const seen = await drive(state, withReview({}), verdicts({}));
  const [said] = judgedSays(seen);
  assert.deepEqual(said?.data, { round: 1, files: 2, justified: 2, notJustified: 0, unjudged: 0 });
  assert.doesNotMatch(readFileSync(path.join(state.dir, 'state.json'), 'utf8'), /"verdicts"/);
  assert.doesNotMatch(readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8'), /"verdicts"/);
});

test('with no finders, the end-of-run warning is the line it always was', async () => {
  const state = judged('vibe-fjudge-plain-warn-');
  await drive(state, withReview({}), verdicts({ 'review-0': both((f) => (f === TEST_FILE ? no('objects') : null)) }));
  assert.deepEqual(warning(state), [
    `Review round 1 changed the run's own tests or config - not justified: \`${TEST_FILE}\`; ` +
      `unjudged: \`${CONFIG}\`. The reasons are in state.json under testChanges and in the round's ` +
      'code-review artifact.',
  ]);
});
