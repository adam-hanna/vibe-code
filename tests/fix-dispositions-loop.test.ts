import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { rolesFor } from '@src/roles.js';
import { saveState } from '@src/run.js';
import { FIX_SCHEMA } from '@src/schemas.js';
import { scoreArchive } from '@src/scorecard.js';
import { reproductionAt } from '@src/validate.js';
import type { Config, Finding, FixDispositions, RunState } from '@src/types.js';
import {
  agents,
  codexRaw,
  config,
  p1,
  report,
  reproducerGate,
  reviewingRun,
  verifying,
  work,
} from './helpers/loop-harness.js';

/**
 * What the fixer did with each review finding, recorded as data (#393).
 *
 * The two review fix turns - `fix-<n>` and `final-fix-<n>` - are sent
 * `FIX_SCHEMA` and their dispositions land in `fix-dispositions-<n>.json` and a
 * `fix_dispositions` event. The distinction every case here guards is the one
 * the brief puts first: an id the fixer's *readable* answer left out is
 * `not-addressed`, and an answer that could not be read records nothing at all.
 */

const RUN = { prefix: 'vibe-dispositions-', task: 'fix dispositions', commit: true } as const;

function said(over: { report?: string; dispositions: { id: string; disposition: string; reason: string }[] }): object {
  return { report: over.report ?? '## Changed\nnone', dispositions: over.dispositions };
}

/** The review returns `first` once, then nothing: one fix round, then a clean review. */
function reviewOnce(first: readonly Finding[]): (label: string) => unknown {
  return (label) => (label === 'review-0' ? report(first) : report([]));
}

function dispositionsFile(state: RunState, n: number): FixDispositions {
  return JSON.parse(readFileSync(path.join(state.dir, `fix-dispositions-${n}.json`), 'utf8')) as FixDispositions;
}

function events(state: RunState, type: string): Record<string, unknown>[] {
  return state.events.filter((e) => e.type === type) as Record<string, unknown>[];
}

/** Run the loop with the narration captured, so a case can read what was said. */
async function run(state: RunState, cfg: Config, turns: Parameters<typeof orchestrate>[3]): Promise<Narration[]> {
  const seen: Narration[] = [];
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, true, turns);
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return seen;
}

test('a fix turn returning valid dispositions records them, and its report is the report field', async () => {
  const state = reviewingRun(RUN);
  const calls: string[] = [];
  const schemas = new Map<string, unknown>();
  const cfg = config({ p1Tolerance: 0, maxReviewRounds: 3 });
  await run(
    state,
    cfg,
    agents(
      {
        codex: reviewOnce([p1('finding-one'), p1('finding-two')]),
        claude: (label, options) => {
          schemas.set(label, options.jsonSchema);
          work(state, `${label}.txt`);
          return said({
            report: '## Changed\nfixed one, rebutted two',
            dispositions: [
              { id: 'finding-one', disposition: 'fixed', reason: 'changed the guard' },
              { id: 'finding-two', disposition: 'rebutted', reason: 'the path is unreachable' },
            ],
          });
        },
      },
      calls,
    ),
  );

  assert.deepEqual(calls, ['review-0', 'fix-1', 'review-1']);
  assert.equal(schemas.get('fix-1'), FIX_SCHEMA, 'the fix turn is sent the schema');
  assert.equal(readFileSync(path.join(state.dir, 'fix-report-1.md'), 'utf8'), '## Changed\nfixed one, rebutted two');

  const file = dispositionsFile(state, 1);
  const seat = [{ seat: 'roles.reviewer', provider: 'codex', model: rolesFor(cfg).reviewer.model ?? 'default' }];
  assert.deepEqual(file, {
    round: 1,
    label: 'fix-1',
    answers: 0,
    dispositions: [
      {
        id: 'finding-one',
        severity: 'P1',
        raisedBy: 'reviewer',
        disposition: 'fixed',
        reason: 'changed the guard',
        seats: seat,
        reproducer: null,
      },
      {
        id: 'finding-two',
        severity: 'P1',
        raisedBy: 'reviewer',
        disposition: 'rebutted',
        reason: 'the path is unreachable',
        seats: seat,
        reproducer: null,
      },
    ],
    dropped: [],
    duplicates: [],
  });
  const [event, ...more] = events(state, 'fix_dispositions');
  assert.equal(more.length, 0);
  const { at: _at, type: _type, ...data } = event ?? {};
  assert.deepEqual(data, file, 'the event carries exactly what the artifact does');
  assert.equal(events(state, 'fix_dispositions_unreadable').length, 0);
  // `code-review-0.json` is never rewritten with the outcome (#142).
  const review = readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8');
  assert.equal(review.includes('disposition'), false);
});

test('an id left out is not-addressed; an invented id is dropped and a repeated one keeps the first, both named', async () => {
  const state = reviewingRun(RUN);
  const calls: string[] = [];
  const seen = await run(
    state,
    config({ p1Tolerance: 0, maxReviewRounds: 3 }),
    agents(
      {
        codex: reviewOnce([p1('finding-one'), p1('finding-two')]),
        claude: (label) => {
          work(state, `${label}.txt`);
          return said({
            dispositions: [
              { id: 'finding-one', disposition: 'deferred', reason: 'separate work' },
              { id: 'made-up', disposition: 'fixed', reason: 'invented' },
              { id: 'finding-one', disposition: 'fixed', reason: 'second answer' },
            ],
          });
        },
      },
      calls,
    ),
  );

  const file = dispositionsFile(state, 1);
  assert.deepEqual(
    file.dispositions.map((d) => [d.id, d.disposition, d.reason]),
    [
      ['finding-one', 'deferred', 'separate work'],
      ['finding-two', 'not-addressed', ''],
    ],
  );
  assert.deepEqual(file.dropped, ['made-up']);
  assert.deepEqual(file.duplicates, ['finding-one']);
  const line = seen.find((n) => n.id === 'fix_dispositions');
  assert.equal(line?.level, 'warn');
  assert.match(line?.message ?? '', /ignored ids not in the prompt: made-up/);
  assert.match(line?.message ?? '', /duplicate ids, first kept: finding-one/);
  assert.match(line?.message ?? '', /0 fixed, 0 rebutted by the fixer, 1 deferred, 1 not addressed, of 2/);
});

/** What an unreadable round must look like on either provider. */
function assertUnreadable(state: RunState, calls: readonly string[], raw: string): void {
  // The round finished and the loop went on to review it.
  assert.deepEqual(calls, ['review-0', 'fix-1', 'review-1']);
  assert.equal(calls.filter((c) => c === 'fix-1').length, 1, 'no retry');
  assert.equal(readFileSync(path.join(state.dir, 'fix-report-1.md'), 'utf8'), raw);
  assert.equal(existsSync(path.join(state.dir, 'fix-dispositions-1.json')), false);
  assert.equal(events(state, 'fix_dispositions').length, 0, 'nothing recorded, not even not-addressed');
  const warned = events(state, 'fix_dispositions_unreadable');
  assert.equal(warned.length, 1);
  assert.equal(warned[0]?.['label'], 'fix-1');
  assert.equal(warned[0]?.['round'], 1);
  assert.equal(warned[0]?.['answers'], 0);
  assert.equal(state.lastReport, 'fix-report-1.md');
  assert.equal(state.status, 'done');
}

test('an unparseable Claude fix output keeps its text as the report and records nothing', async () => {
  const state = reviewingRun(RUN);
  const calls: string[] = [];
  await run(
    state,
    config({ p1Tolerance: 0, maxReviewRounds: 3 }),
    agents(
      {
        codex: reviewOnce([p1('finding-one'), p1('finding-two')]),
        claude: (label) => {
          work(state, `${label}.txt`);
          return 'I fixed finding-one and rebutted finding-two.';
        },
      },
      calls,
    ),
  );
  assertUnreadable(state, calls, 'I fixed finding-one and rebutted finding-two.');
});

test('an unparseable Codex fix output keeps its text as the report and records nothing', async () => {
  const state = reviewingRun(RUN);
  const calls: string[] = [];
  const schemas = new Map<string, unknown>();
  const cfg = config(
    { p1Tolerance: 0, maxReviewRounds: 3 },
    { roles: { ...DEFAULTS.roles, implementer: 'codex' } },
  );
  await run(
    state,
    cfg,
    agents(
      {
        codex: (label, options) => {
          schemas.set(label, options.schema);
          if (label === 'fix-1') {
            work(state, 'codex-fix.txt');
            return codexRaw('Codex fixed both, in prose.');
          }
          return label === 'review-0' ? report([p1('finding-one'), p1('finding-two')]) : report([]);
        },
      },
      calls,
    ),
  );
  assert.equal(schemas.get('fix-1'), FIX_SCHEMA, 'the Codex fixer is sent the schema too');
  assertUnreadable(state, calls, 'Codex fixed both, in prose.');
});

test('output that parses but fails validation is unreadable, never partly read', async () => {
  const state = reviewingRun(RUN);
  const calls: string[] = [];
  const out = said({
    dispositions: [
      { id: 'finding-one', disposition: 'fixed', reason: 'ok' },
      { id: 'finding-two', disposition: 'maybe', reason: 'not a disposition' },
    ],
  });
  await run(
    state,
    config({ p1Tolerance: 0, maxReviewRounds: 3 }),
    agents(
      {
        codex: reviewOnce([p1('finding-one'), p1('finding-two')]),
        claude: (label) => {
          work(state, `${label}.txt`);
          return out;
        },
      },
      calls,
    ),
  );
  assertUnreadable(state, calls, JSON.stringify(out));
});

test('a final fix records its dispositions, and the carried P1s final-fix reproducer verdict reads beside them', async () => {
  const state = reviewingRun(RUN);
  const calls: string[] = [];
  const schemas = new Map<string, unknown>();
  await run(
    state,
    config(
      { p1Tolerance: 1, maxReviewRounds: 3 },
      {
        verify: {
          ...DEFAULTS.verify,
          enabled: true,
          command: reproducerGate(state, { fixedBy: 'fixed.txt' }),
          runs: 1,
          timeoutMs: 30_000,
        },
      },
    ),
    agents(
      {
        codex: (label) =>
          label === 'review-0'
            ? report([{ ...p1('the-claim'), reproducer: { path: 'repro/witness.txt', contents: 'FAIL - carried\n' } }])
            : report([]),
        claude: (label, options) => {
          schemas.set(label, options.jsonSchema);
          if (label.startsWith('final-fix-')) writeFileSync(path.join(state.targetDir, 'fixed.txt'), 'done\n', 'utf8');
          return said({ dispositions: [{ id: 'the-claim', disposition: 'fixed', reason: 'repaired' }] });
        },
      },
      calls,
    ),
  );

  assert.deepEqual(calls, ['review-0', 'final-fix-1']);
  assert.equal(schemas.get('final-fix-1'), FIX_SCHEMA);
  const file = dispositionsFile(state, 1);
  assert.equal(file.label, 'final-fix-1');
  assert.equal(file.answers, 0);
  assert.deepEqual(
    file.dispositions.map((d) => [d.id, d.disposition, d.reproducer]),
    [['the-claim', 'fixed', 'reproduced']],
  );
  // Later evidence, beside the disposition and never folded into it.
  const carried = state.outstanding?.[0];
  assert.equal(carried?.id, 'the-claim');
  assert.equal(reproductionAt(carried ?? p1('missing'), 'final-fix')?.verdict, 'did-not-reproduce');

  const card = scoreArchive(state.targetDir).findings.outcomes;
  assert.deepEqual(card.finalFixReproducer, { 'did-not-reproduce': 1 });
  assert.equal(card.notReviewedAgain, 1);
  assert.deepEqual(card.raisedAgain, { matched: 0, measured: 0, unmeasured: 0 });
});

test('a verify-fix turn is sent no schema, and its prompt asks for no dispositions', async () => {
  const state = reviewingRun(RUN);
  const calls: string[] = [];
  const seen = new Map<string, { schema: unknown; prompt: string }>();
  await run(
    state,
    config({ maxVerifyRounds: 3 }, verifying(state, { failures: 1 })),
    agents(
      {
        claude: (label, options) => {
          seen.set(label, { schema: options.jsonSchema, prompt: options.prompt });
          return work(state, `${label}.txt`);
        },
        codex: () => report([]),
      },
      calls,
    ),
  );
  assert.deepEqual(calls, ['verify-fix-1', 'review-0']);
  assert.equal(seen.get('verify-fix-1')?.schema, undefined);
  assert.equal(seen.get('verify-fix-1')?.prompt.includes('## Dispositions'), false);
  assert.equal(readFileSync(path.join(state.dir, 'verify-fix-1.md'), 'utf8').length > 0, true);
  assert.equal(events(state, 'fix_dispositions_unreadable').length, 0);
  assert.equal(events(state, 'fix_dispositions').length, 0);
});

/** A run stopped after `review-0`, carrying its findings into the fix round. */
function carrying(findings: readonly Finding[], stamp: RunState['reviewSeat']): RunState {
  const state = reviewingRun(RUN);
  state.pendingFindings = { phase: 'review', findings: [...findings] };
  if (stamp !== undefined) state.reviewSeat = stamp;
  saveState(state);
  return state;
}

/** Reviewed by model-a; the resume moved `roles.reviewer` to model-b. */
const RESUMED_ON_B = { roles: { ...DEFAULTS.roles, reviewer: { provider: 'codex' as const, model: 'model-b' } } };

function answerBoth(state: RunState): (label: string) => unknown {
  return (label) => {
    work(state, `${label}.txt`);
    return said({
      dispositions: [
        { id: 'human-mine', disposition: 'fixed', reason: 'done' },
        { id: 'reviewer-said', disposition: 'rebutted', reason: 'wrong' },
      ],
    });
  };
}

test('a resume that moved roles.reviewer credits the seat that reviewed, and a human finding is recorded but not scored', async () => {
  const state = carrying(
    [
      { ...p1('human-mine'), raisedBy: 'human' },
      { ...p1('reviewer-said'), raisedBy: 'reviewer' },
    ],
    { round: 0, provider: 'codex', model: 'model-a' },
  );
  const calls: string[] = [];
  await run(state, config({ p1Tolerance: 0, maxReviewRounds: 3 }, RESUMED_ON_B), agents({ claude: answerBoth(state) }, calls));

  assert.deepEqual(calls, ['fix-1', 'review-1']);
  const file = dispositionsFile(state, 1);
  const human = file.dispositions.find((d) => d.id === 'human-mine');
  const reviewer = file.dispositions.find((d) => d.id === 'reviewer-said');
  assert.equal(human?.raisedBy, 'human');
  assert.equal(human?.seats, null, 'a person is credited to no seat');
  assert.deepEqual(reviewer?.seats, [{ seat: 'roles.reviewer', provider: 'codex', model: 'model-a' }]);

  const card = scoreArchive(state.targetDir).findings.outcomes;
  assert.deepEqual(card.total, { of: 1, fixed: 0, rebutted: 1, deferred: 0, notAddressed: 0 });
  assert.deepEqual(Object.keys(card.bySeat), ['codex/model-a'], 'never the seat that holds it now');
  assert.deepEqual(card.excluded, { human: 1 });
  assert.equal(card.unattributed, 0);
});

test('with no review-time stamp for the round answered, a reviewer finding credits no seat', async () => {
  const state = carrying([{ ...p1('reviewer-said'), raisedBy: 'reviewer' }], undefined);
  const calls: string[] = [];
  await run(
    state,
    config({ p1Tolerance: 0, maxReviewRounds: 3 }, RESUMED_ON_B),
    agents(
      {
        claude: (label) => {
          work(state, `${label}.txt`);
          return said({ dispositions: [{ id: 'reviewer-said', disposition: 'fixed', reason: 'done' }] });
        },
      },
      calls,
    ),
  );
  assert.equal(dispositionsFile(state, 1).dispositions[0]?.seats, null);
  const card = scoreArchive(state.targetDir).findings.outcomes;
  assert.equal(card.unattributed, 1);
  assert.deepEqual(card.bySeat, {});
  assert.equal(card.total.of, 1);
});

// ---- a fix turn that dies, and the resume that follows ---------------------

test('a fix turn that dies resumes as the same round, answering the same review, credited to the seat that reviewed', async () => {
  const state = reviewingRun(RUN);
  const cfg = config({ p1Tolerance: 0, maxReviewRounds: 3 });
  const first: string[] = [];
  await assert.rejects(
    run(
      state,
      cfg,
      agents(
        {
          codex: reviewOnce([p1('finding-one')]),
          claude: () => {
            throw new Error('the fixer died mid-turn');
          },
        },
        first,
      ),
    ),
  );
  assert.deepEqual(first, ['review-0', 'fix-1']);
  assert.deepEqual(state.fixInFlight, { round: 1, final: false });

  const second: string[] = [];
  await run(
    state,
    cfg,
    agents(
      {
        codex: () => report([]),
        claude: (label) => {
          work(state, `${label}.txt`);
          return said({ dispositions: [{ id: 'finding-one', disposition: 'fixed', reason: 'done' }] });
        },
      },
      second,
    ),
  );
  // Never `fix-2` answering a review it did not answer.
  assert.deepEqual(second, ['fix-1', 'review-1']);
  const file = dispositionsFile(state, 1);
  assert.equal(file.label, 'fix-1');
  assert.equal(file.answers, 0);
  assert.notEqual(file.dispositions[0]?.seats, null, 'the review-time stamp still matches the round answered');
  assert.equal(existsSync(path.join(state.dir, 'fix-dispositions-2.json')), false);
  assert.equal(state.fixInFlight, undefined);
});

test('a final fix that dies resumes as the final fix, and still re-runs the carried reproducer', async () => {
  const state = reviewingRun(RUN);
  const cfg = config(
    { p1Tolerance: 1, maxReviewRounds: 3 },
    {
      verify: {
        ...DEFAULTS.verify,
        enabled: true,
        command: reproducerGate(state, { fixedBy: 'fixed.txt' }),
        runs: 1,
        timeoutMs: 30_000,
      },
    },
  );
  const first: string[] = [];
  await assert.rejects(
    run(
      state,
      cfg,
      agents(
        {
          codex: (label) =>
            label === 'review-0'
              ? report([{ ...p1('the-claim'), reproducer: { path: 'repro/witness.txt', contents: 'FAIL - carried\n' } }])
              : report([]),
          claude: () => {
            throw new Error('the fixer died mid-turn');
          },
        },
        first,
      ),
    ),
  );
  assert.deepEqual(first, ['review-0', 'final-fix-1']);

  const second: string[] = [];
  await run(
    state,
    cfg,
    agents(
      {
        codex: () => assert.fail('the final fix round is never reviewed again'),
        claude: (label) => {
          writeFileSync(path.join(state.targetDir, 'fixed.txt'), 'done\n', 'utf8');
          return said({ dispositions: [{ id: 'the-claim', disposition: 'fixed', reason: `in ${label}` }] });
        },
      },
      second,
    ),
  );
  assert.deepEqual(second, ['final-fix-1']);
  const file = dispositionsFile(state, 1);
  assert.equal(file.label, 'final-fix-1');
  assert.equal(file.answers, 0);
  const carried = state.outstanding?.[0];
  assert.equal(reproductionAt(carried ?? p1('missing'), 'final-fix')?.verdict, 'did-not-reproduce');
  assert.equal(existsSync(path.join(state.dir, 'OUTSTANDING.md')), true);
  assert.equal(state.fixInFlight, undefined);
});
